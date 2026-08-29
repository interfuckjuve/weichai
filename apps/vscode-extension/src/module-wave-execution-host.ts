import { randomUUID } from 'node:crypto';
import type {
  ExecutionWave,
  MigrationRunManifest,
  ModuleMigrationPlan,
  PlanDecision,
  RepositoryStaticAnalysis,
  ValidationRecord,
} from '@forexplore/contracts';
import {
  arePlanApprovalsCurrent,
  areWaveApprovalsCurrent,
  canonicalJson,
  createMigrationRunManifest,
  recordModulePlanDecision,
} from '@forexplore/workflow-core';
import type {
  ModuleWaveCommitRequest,
  ModuleWaveCommitResult,
  ModuleWavePreparationRequest,
  PreparedModulePatch,
  PreparedModuleWave,
} from '@forexplore/adaptation-service/module-wave-execution';
import { nextWaveForReadOnlyReview } from './module-wave-review';
import type { ModuleWavePatchBundle } from './module-wave-patch-bundle';
import type { ModuleWaveValidator } from './module-wave-validation';

export interface ModuleWaveExecutionPort {
  prepare(request: ModuleWavePreparationRequest): Promise<PreparedModuleWave>;
  commit(request: ModuleWaveCommitRequest): Promise<ModuleWaveCommitResult>;
}

export interface StoredPreparedModuleWave {
  transactionId: string;
  waveId: string;
  preparedHash: string;
  validationIds: string[];
}

export interface PrepareLocalModuleWaveRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  manifest?: MigrationRunManifest;
  bundle: ModuleWavePatchBundle;
  validator: ModuleWaveValidator;
  coordinator: ModuleWaveExecutionPort;
  runId?: string;
  now?: string;
}

export interface PreparedLocalModuleWave {
  prepared: PreparedModuleWave;
  storedPrepared: StoredPreparedModuleWave;
}

export interface CommitLocalModuleWaveRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  manifest: MigrationRunManifest;
  prepared: PreparedModuleWave;
  coordinator: ModuleWaveExecutionPort;
  now?: string;
}

/**
 * Turns a local patch-only bundle into a coordinator-owned prepared wave. The
 * bundle cannot contribute validation records: host-owned scope checks and
 * local joint validation are the only evidence forwarded to the coordinator.
 */
export async function prepareLocalModuleWave(
  request: PrepareLocalModuleWaveRequest,
): Promise<PreparedLocalModuleWave> {
  assertHostWriteSetOwnership(request.plan, request.analysis);
  const wave = requireBundleWave(request.plan, request.bundle);
  const preparedModules = hostPreparedModules(request.plan, wave, request.bundle);
  const manifest = requireRunManifest(
    request.manifest,
    request.plan,
    request.runId ?? defaultRunId(),
    request.now,
  );
  const prepared = await request.coordinator.prepare({
    repositoryRoot: request.repositoryRoot,
    analysis: request.analysis,
    plan: request.plan,
    manifest,
    waveId: wave.id,
    preparedModules,
    validate: (worktreeRoot) => request.validator.validate({
      worktreeRoot,
      analysis: request.analysis,
      plan: request.plan,
      wave,
    }),
    ...(request.now === undefined ? {} : { now: request.now }),
  });
  return {
    prepared,
    storedPrepared: storedPreparedModuleWave(prepared),
  };
}

/** Bind an explicit human decision to the exact coordinator-created bundle. */
export function approvePreparedLocalModuleWave(
  plan: ModuleMigrationPlan,
  prepared: PreparedModuleWave,
  actor: string,
  decidedAt = new Date().toISOString(),
): ModuleMigrationPlan {
  const transaction = prepared.transaction;
  if (transaction.status !== 'prepared' || !transaction.preparedHash.trim()) {
    throw new Error('没有可审批的已准备波次补丁。');
  }
  const wave = plan.executionWaves.find((item) => item.id === transaction.waveId);
  if (!wave) throw new Error(`已准备事务引用未知波次：${transaction.waveId}`);
  const decision: PlanDecision = {
    id: `wave-approval:${randomUUID()}`,
    kind: 'wave-approval',
    status: 'approved',
    snapshotId: plan.snapshotId,
    planHash: plan.planHash,
    waveId: transaction.waveId,
    preparedHash: transaction.preparedHash,
    actor: requireActor(actor),
    decidedAt,
  };
  return recordModulePlanDecision(plan, decision, plan.snapshotId, decidedAt);
}

export function commitPreparedLocalModuleWave(
  request: CommitLocalModuleWaveRequest,
): Promise<ModuleWaveCommitResult> {
  return request.coordinator.commit({
    repositoryRoot: request.repositoryRoot,
    analysis: request.analysis,
    plan: request.plan,
    manifest: request.manifest,
    prepared: request.prepared,
    ...(request.now === undefined ? {} : { now: request.now }),
  });
}

/** Persist only the metadata needed to invalidate the in-memory bundle after restart. */
export function storedPreparedModuleWave(prepared: PreparedModuleWave): StoredPreparedModuleWave {
  return {
    transactionId: prepared.transaction.id,
    waveId: prepared.transaction.waveId,
    preparedHash: prepared.transaction.preparedHash,
    validationIds: [...new Set(prepared.validation.map((record) => record.id))].sort(),
  };
}

/**
 * A prepared bundle cannot survive restart. Remove its transaction and its
 * bundle-specific evidence so a later preparation can produce fresh hashes,
 * validation, and human approval without clashing with stale records.
 */
export function rollbackPreparedLocalModuleWave(input: {
  plan: ModuleMigrationPlan;
  manifest: MigrationRunManifest;
  prepared: StoredPreparedModuleWave;
  updatedAt?: string;
}): { plan: ModuleMigrationPlan; manifest: MigrationRunManifest } {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const transaction = input.manifest.transactions.find((item) => item.id === input.prepared.transactionId);
  if (!transaction || transaction.waveId !== input.prepared.waveId || transaction.status === 'committed') {
    throw new Error('恢复状态未包含待回滚的已准备波次事务。');
  }
  const remainingTransactions = input.manifest.transactions.filter(
    (item) => item.id !== input.prepared.transactionId,
  );
  const committedWaves = new Set(
    remainingTransactions
      .filter((item) => item.status === 'committed')
      .map((item) => item.waveId),
  );
  const executionWaves = input.plan.executionWaves.map((wave) => {
    if (wave.id === input.prepared.waveId) return { ...wave, status: 'pending' as const };
    if (committedWaves.has(wave.id)) return { ...wave, status: 'committed' as const };
    return wave;
  });
  const plan = {
    ...input.plan,
    status: planStatusAfterRecovery(input.plan, executionWaves),
    executionWaves,
    updatedAt,
  };
  const validationIds = new Set(input.prepared.validationIds);
  return {
    plan,
    manifest: {
      ...input.manifest,
      status: manifestStatusForPlan(plan),
      updatedAt,
      decisions: copyDecisions(plan.decisions),
      validation: input.manifest.validation.filter((record) => !validationIds.has(record.id)),
      transactions: remainingTransactions,
    },
  };
}

/** Rebuild local review state from a run manifest atomically published on the managed branch. */
export function restoreCommittedLocalModuleWave(input: {
  plan: ModuleMigrationPlan;
  expectedManifest: MigrationRunManifest;
  recoveredManifest: MigrationRunManifest;
  transactionId: string;
  commit: string;
  updatedAt?: string;
}): { plan: ModuleMigrationPlan; manifest: MigrationRunManifest } {
  assertRecoveredManifestBinding(input.expectedManifest, input.recoveredManifest, input.plan);
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) {
    throw new Error('恢复的 Git 提交标识无效。');
  }
  const expectedTransaction = input.expectedManifest.transactions.find(
    (item) => item.id === input.transactionId,
  );
  if (!expectedTransaction || expectedTransaction.status !== 'prepared') {
    throw new Error('本地恢复状态未包含待发布的已准备波次事务。');
  }
  const recoveredTransaction = input.recoveredManifest.transactions.find(
    (item) => item.id === input.transactionId,
  );
  if (
    !recoveredTransaction ||
    recoveredTransaction.status !== 'committed' ||
    !recoveredTransaction.completedAt?.trim()
  ) {
    throw new Error('已发布运行清单未包含已提交波次事务。');
  }
  assertRecoveredTransactionHistory(
    input.expectedManifest.transactions,
    input.recoveredManifest.transactions,
    input.transactionId,
    input.commit,
  );
  const decisions = mergeDecisionHistory(input.plan.decisions, input.recoveredManifest.decisions);
  if (!areWaveApprovalsCurrent(
    { ...input.plan, decisions },
    recoveredTransaction.waveId,
    expectedTransaction.preparedHash,
    input.plan.snapshotId,
  )) {
    throw new Error('已发布运行清单未保留该 preparedHash 对应的有效人工波次审批。');
  }
  const committedWaves = new Set(
    input.expectedManifest.transactions
      .filter((item) => item.status === 'committed')
      .map((item) => item.waveId),
  );
  committedWaves.add(recoveredTransaction.waveId);
  const executionWaves = input.plan.executionWaves.map((wave) => (
    committedWaves.has(wave.id) ? { ...wave, status: 'committed' as const } : wave
  ));
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const plan = {
    ...input.plan,
    decisions,
    executionWaves,
    status: planStatusAfterRecovery(input.plan, executionWaves),
    updatedAt,
  };
  return {
    plan,
    manifest: {
      ...input.recoveredManifest,
      updatedAt,
      decisions: copyDecisions(decisions),
      transactions: input.recoveredManifest.transactions.map((transaction) => (
        transaction.id === input.transactionId ? { ...transaction, commit: input.commit } : transaction
      )),
    },
  };
}

function requireBundleWave(plan: ModuleMigrationPlan, bundle: ModuleWavePatchBundle): ExecutionWave {
  if (
    bundle.snapshotId !== plan.snapshotId ||
    bundle.planId !== plan.id ||
    bundle.planHash !== plan.planHash
  ) {
    throw new Error('本地补丁包不属于当前已审批的模块计划和静态快照。');
  }
  if (!arePlanApprovalsCurrent(plan, plan.snapshotId)) {
    throw new Error('当前模块计划未获有效人工审批。');
  }
  const wave = nextWaveForReadOnlyReview(plan);
  if (!wave || wave.id !== bundle.waveId) {
    throw new Error('本地补丁包不属于当前依赖已满足的下一执行波次。');
  }
  return wave;
}

function hostPreparedModules(
  plan: ModuleMigrationPlan,
  wave: ExecutionWave,
  bundle: ModuleWavePatchBundle,
): PreparedModulePatch[] {
  const expectedIds = [...wave.moduleIds].sort();
  const byModuleId = new Map(bundle.modules.map((module) => [module.moduleId, module]));
  const suppliedIds = [...byModuleId.keys()].sort();
  if (
    suppliedIds.length !== expectedIds.length ||
    suppliedIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(`本地补丁包必须准确覆盖波次 ${wave.id} 的所有模块。`);
  }
  const planModules = new Map(plan.modules.map((module) => [module.id, module]));
  return expectedIds.map((moduleId) => {
    const bundleModule = byModuleId.get(moduleId);
    const module = planModules.get(moduleId);
    if (!bundleModule || !module) throw new Error(`本地补丁包包含未知模块：${moduleId}`);
    if (bundleModule.files.length === 0) throw new Error(`模块 ${moduleId} 没有补丁。`);
    const allowedPaths = new Set([
      ...module.sourceFiles,
      ...(module.testFiles ?? []),
      ...(module.generatedFiles ?? []),
      ...module.writeSet,
    ]);
    for (const file of bundleModule.files) {
      if (file.path.startsWith('.forexplore/') || !allowedPaths.has(file.path)) {
        throw new Error(`补丁 ${file.path} 超出模块 ${moduleId} 已批准的写入范围。`);
      }
    }
    return {
      moduleId,
      files: copyPatches(bundleModule.files),
      validation: [hostScopeValidation(bundle.contentHash, moduleId, bundleModule.files)],
    };
  });
}

/** Recheck execution permissions at the trusted host boundary before scope-pass evidence is created. */
function assertHostWriteSetOwnership(
  plan: ModuleMigrationPlan,
  analysis: RepositoryStaticAnalysis,
): void {
  const filesByPath = new Map(analysis.files.map((file) => [file.path, file]));
  const assignmentsByPath = new Map(plan.fileAssignments.map((assignment) => [assignment.path, assignment]));
  for (const module of plan.modules) {
    const directOwnership = new Set([
      ...module.sourceFiles,
      ...(module.testFiles ?? []),
      ...(module.generatedFiles ?? []),
    ]);
    for (const path of module.writeSet) {
      const file = filesByPath.get(path);
      const assignment = assignmentsByPath.get(path);
      if (!file) {
        throw new Error(`模块 ${module.id} 的写入范围包含快照外路径：${path}`);
      }
      if (directOwnership.has(path)) continue;
      const explicitlyOwnedSharedConfiguration =
        module.kind === 'shared-contract' &&
        file.role === 'configuration' &&
        assignment?.kind === 'excluded' &&
        assignment.moduleId === module.id &&
        Boolean(assignment.reason?.trim()) &&
        module.resourceLocks.length > 0;
      if (!explicitlyOwnedSharedConfiguration) {
        throw new Error(`模块 ${module.id} 的写入范围越过了显式文件所有权：${path}`);
      }
    }
  }
}

function hostScopeValidation(
  bundleHash: string,
  moduleId: string,
  files: readonly { path: string }[],
): ValidationRecord {
  return {
    id: `vscode-module-bundle-scope:${bundleHash}:${moduleId}`,
    label: `模块 ${moduleId} 补丁范围`,
    status: 'pass',
    required: true,
    command: 'VS Code trusted local patch-bundle parser + approved write set',
    summary: `已检查 ${files.length} 个补丁文件均属于模块 ${moduleId} 的已批准写入范围。`,
  };
}

function requireRunManifest(
  manifest: MigrationRunManifest | undefined,
  plan: ModuleMigrationPlan,
  runId: string,
  now: string | undefined,
): MigrationRunManifest {
  if (manifest === undefined) return createMigrationRunManifest(plan, runId, now ?? new Date().toISOString());
  if (
    manifest.snapshotId !== plan.snapshotId ||
    manifest.analysisHash !== plan.analysisHash ||
    manifest.planId !== plan.id ||
    manifest.planHash !== plan.planHash
  ) {
    throw new Error('已保存的迁移运行不属于当前模块计划。');
  }
  return manifest;
}

function defaultRunId(): string {
  return `run-${randomUUID()}`;
}

function requireActor(value: string): string {
  const actor = value.trim();
  if (!actor) throw new Error('波次审批人不能为空。');
  return actor;
}

function planStatusAfterRecovery(
  plan: ModuleMigrationPlan,
  waves: ModuleMigrationPlan['executionWaves'],
): ModuleMigrationPlan['status'] {
  if (plan.status === 'invalidated') return 'invalidated';
  if (waves.every((wave) => wave.status === 'committed')) return 'completed';
  if (waves.some((wave) => wave.status === 'committed')) return 'executing';
  return arePlanApprovalsCurrent(plan, plan.snapshotId)
    ? 'approved'
    : 'validated';
}

function manifestStatusForPlan(plan: ModuleMigrationPlan): MigrationRunManifest['status'] {
  if (plan.status === 'completed') return 'completed';
  if (plan.status === 'executing') return 'executing';
  return arePlanApprovalsCurrent(plan, plan.snapshotId) ? 'approved' : 'planned';
}

function assertRecoveredManifestBinding(
  expected: MigrationRunManifest,
  recovered: MigrationRunManifest,
  plan: ModuleMigrationPlan,
): void {
  if (
    recovered.id !== expected.id ||
    recovered.snapshotId !== plan.snapshotId ||
    recovered.analysisHash !== plan.analysisHash ||
    recovered.planId !== plan.id ||
    recovered.planHash !== plan.planHash
  ) {
    throw new Error('已发布运行清单不属于当前模块计划。');
  }
  if (canonicalJson(recovered.artifactPaths) !== canonicalJson(expected.artifactPaths)) {
    throw new Error('已发布运行清单未使用当前运行的受管制品路径。');
  }
  assertSameDecisionHistory(expected.decisions, recovered.decisions);
  if (canonicalJson(recovered.validation) !== canonicalJson(expected.validation)) {
    throw new Error('已发布运行清单修改了本地已验证的波次证据。');
  }
}

function assertRecoveredTransactionHistory(
  expected: readonly MigrationRunManifest['transactions'][number][],
  recovered: readonly MigrationRunManifest['transactions'][number][],
  recoveredTransactionId: string,
  publishedCommit: string,
): void {
  if (expected.length !== recovered.length) {
    throw new Error('已发布运行清单包含与本地恢复状态不一致的事务历史。');
  }
  const expectedById = new Map(expected.map((transaction) => [transaction.id, transaction]));
  for (const transaction of recovered) {
    const local = expectedById.get(transaction.id);
    if (!local) {
      throw new Error('已发布运行清单包含本地恢复状态未知的事务。');
    }
    assertSameTransactionBinding(local, transaction);
    if (transaction.id === recoveredTransactionId) {
      if (
        local.status !== 'prepared' ||
        transaction.status !== 'committed' ||
        (transaction.commit !== undefined && transaction.commit !== publishedCommit)
      ) {
        throw new Error('已发布运行清单中的恢复事务不匹配已审阅的 preparedHash 和发布提交。');
      }
      continue;
    }
    if (canonicalJson(transaction) !== canonicalJson(local)) {
      throw new Error('已发布运行清单修改了已提交前序波次的事务证据。');
    }
  }
}

function assertSameTransactionBinding(
  expected: MigrationRunManifest['transactions'][number],
  recovered: MigrationRunManifest['transactions'][number],
): void {
  if (
    expected.id !== recovered.id ||
    expected.runId !== recovered.runId ||
    expected.waveId !== recovered.waveId ||
    expected.snapshotId !== recovered.snapshotId ||
    expected.planHash !== recovered.planHash ||
    expected.branchName !== recovered.branchName ||
    expected.baseCommit !== recovered.baseCommit ||
    expected.preparedHash !== recovered.preparedHash ||
    expected.preparedAt !== recovered.preparedAt ||
    canonicalJson(expected.baselineFileHashes) !== canonicalJson(recovered.baselineFileHashes)
  ) {
    throw new Error('已发布运行清单中的事务未绑定到本地已准备波次。');
  }
}

function assertSameDecisionHistory(
  expected: readonly PlanDecision[],
  recovered: readonly PlanDecision[],
): void {
  if (expected.length !== recovered.length) {
    throw new Error('已发布运行清单包含与本地审批历史不一致的决策。');
  }
  const expectedById = new Map(expected.map((decision) => [decision.id, decision]));
  for (const decision of recovered) {
    const local = expectedById.get(decision.id);
    if (!local || canonicalJson(local) !== canonicalJson(decision)) {
      throw new Error('已发布运行清单包含冲突的人类决策。');
    }
  }
}

function mergeDecisionHistory(
  local: readonly PlanDecision[],
  recovered: readonly PlanDecision[],
): PlanDecision[] {
  const decisions = new Map<string, PlanDecision>();
  for (const decision of [...local, ...recovered]) {
    const existing = decisions.get(decision.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(decision)) {
      throw new Error(`已发布运行清单包含冲突的人类决策：${decision.id}`);
    }
    decisions.set(decision.id, { ...decision });
  }
  return [...decisions.values()].sort(
    (left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.id.localeCompare(right.id),
  );
}

function copyDecisions(decisions: readonly PlanDecision[]): PlanDecision[] {
  return decisions.map((decision) => ({ ...decision }));
}

function copyPatches(files: readonly PreparedModulePatch['files'][number][]): PreparedModulePatch['files'] {
  return JSON.parse(JSON.stringify(files)) as PreparedModulePatch['files'];
}
