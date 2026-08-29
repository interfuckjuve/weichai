import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FilePatch,
  MigrationRunManifest,
  ModuleMigrationPlan,
  ModuleSummary,
  RepositoryStaticAnalysis,
  ValidationRecord,
  WaveTransaction,
} from "@forexplore/contracts";
import { verifyRepositoryStaticAnalysis } from "@forexplore/code-indexer";
import {
  arePlanApprovalsCurrent,
  areWaveApprovalsCurrent,
  analysisArtifactPath,
  canonicalJson,
  evaluateValidationGate,
  materializeModuleSummary,
  migrationRunArtifactPath,
  moduleSummaryPath,
  serializeModuleSummary,
  transitionModulePlanWaveStatus,
  validateModuleMigrationPlan,
} from "@forexplore/workflow-core";
import { GitWaveTransaction, type GitWaveTransactionResult } from "./git-wave-transaction";
import {
  ModuleWavePreparationRunner,
  type ModulePatchPreparer,
} from "./module-wave-preparation-runner";

export interface PreparedModulePatch {
  moduleId: string;
  files: FilePatch[];
  validation: ValidationRecord[];
}

export interface ModuleWavePreparationRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  manifest: MigrationRunManifest;
  waveId: string;
  preparedModules: PreparedModulePatch[];
  /** Runs once against every patch combined in a disposable staging worktree. */
  validate(worktreeRoot: string): Promise<ValidationRecord[]> | ValidationRecord[];
  /**
   * Kept only to reject stale callers that try to select another publication
   * ref. Module runs always publish to `codex/forexplore-migration/<runId>`.
   */
  branchName?: string;
  now?: string;
}

/**
 * Host-facing preparation path that executes the trusted scheduler before the
 * combined wave transaction. The supplied preparer remains responsible for
 * producing module patches; this coordinator owns graph ordering, isolated
 * worktrees, validation, bundle hashing, and publication preconditions.
 */
export interface ModuleWaveAutomatedPreparationRequest extends Omit<
  ModuleWavePreparationRequest,
  "preparedModules"
> {
  preparer: ModulePatchPreparer;
  /** May reduce, but never exceed, the plan's wave concurrency limit. */
  maxPreparationParallelism?: number;
}

/** A host-owned, hash-bound patch and validation bundle awaiting human review. */
export interface PreparedModuleWave {
  branchName: string;
  files: FilePatch[];
  preparedModules: PreparedModulePatch[];
  transaction: WaveTransaction;
  validation: ValidationRecord[];
  /** Plan lifecycle state with this wave awaiting bundle-specific approval. */
  plan: ModuleMigrationPlan;
  /** Durable run state for the prepared-but-not-yet-approved wave. */
  manifest: MigrationRunManifest;
}

export interface ModuleWaveCommitRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  manifest: MigrationRunManifest;
  prepared: PreparedModuleWave;
  commitMessage?: string;
  now?: string;
}

export interface ModuleWaveCommitResult {
  branchName: string;
  commit: string;
  plan: ModuleMigrationPlan;
  manifest: MigrationRunManifest;
  summary: ModuleSummary;
  transaction: WaveTransaction;
  git: GitWaveTransactionResult;
}

/**
 * A trusted host must call `prepare`, present the exact returned bundle, add a
 * wave approval that carries `preparedHash`, then call `commit`. There is no
 * one-call execution path because it would let a plan approval bypass review
 * of the actual generated patch and joint validation evidence.
 */
export class ModuleWaveExecutionCoordinator {
  readonly #git: GitWaveTransaction;

  constructor(git = new GitWaveTransaction()) {
    this.#git = git;
  }

  async prepare(request: ModuleWavePreparationRequest): Promise<PreparedModuleWave> {
    const now = request.now ?? new Date().toISOString();
    const wave = assertPreparationPreconditions(request);
    const moduleBundle = validatePreparedModules(request.plan, wave.id, request.preparedModules);
    const transactionId = stableTransactionId(request.manifest.id, wave.id);
    const branchName = defaultBranchName(request.manifest.id);
    if (request.branchName !== undefined && request.branchName !== branchName) {
      throw new Error(`Module migration runs may only publish to ${branchName}.`);
    }
    this.assertCommittedPrerequisites(
      request.repositoryRoot,
      branchName,
      request.manifest,
      wave,
    );
    this.assertManifestPublications(request.repositoryRoot, branchName, request.plan, request.manifest);
    const expectedBaseCommit = this.expectedBaseCommit(
      request.repositoryRoot,
      branchName,
      request.manifest,
      request.plan,
      request.analysis,
    );
    let jointValidation: ValidationRecord[] = [];

    const staging = await this.#git.prepare({
      repositoryRoot: request.repositoryRoot,
      branchName,
      transactionId,
      files: moduleBundle.files,
      expectedBaseCommit,
      validate: async (worktreeRoot) => {
        const records = await request.validate(worktreeRoot);
        assertValidationEvidence(records, `joint validation for ${wave.id}`);
        jointValidation = scopeValidationRecords(`wave:${wave.id}:joint`, records);
      },
    });
    const validation = mergeValidation([], [...moduleBundle.validation, ...jointValidation]);
    const transactionWithoutHash: Omit<WaveTransaction, "preparedHash"> = {
      id: transactionId,
      runId: request.manifest.id,
      waveId: wave.id,
      snapshotId: request.plan.snapshotId,
      planHash: request.plan.planHash,
      branchName,
      status: "prepared",
      baseCommit: staging.baseCommit,
      baselineFileHashes: baselineHashes(moduleBundle.files),
      checkpointId: `checkpoint-${transactionId}`,
      preparedAt: now,
    };
    const transaction: WaveTransaction = {
      ...transactionWithoutHash,
      preparedHash: calculatePreparedWaveHash(transactionWithoutHash, moduleBundle.files, validation),
    };
    const plan = planAfterPreparedWave(request.plan, request.manifest, wave.id, now);
    const manifest = manifestAfterPreparedWave(
      request.manifest,
      plan,
      transaction,
      validation,
      now,
    );
    return {
      branchName: staging.branchName,
      files: copyPatches(moduleBundle.files),
      preparedModules: copyPreparedModules(request.preparedModules),
      transaction,
      validation,
      plan,
      manifest,
    };
  }

  /**
   * Prepare every module through an isolated worktree according to the
   * approved schedule, then run the same combined validation and durable
   * prepared-bundle protocol as the explicit-patch API.
   */
  async prepareWithPreparer(
    request: ModuleWaveAutomatedPreparationRequest,
  ): Promise<PreparedModuleWave> {
    // The common precondition checks do not inspect patches, but the explicit
    // API type carries them because its caller already has a bundle.
    const wave = assertPreparationPreconditions({ ...request, preparedModules: [] });
    const branchName = defaultBranchName(request.manifest.id);
    if (request.branchName !== undefined && request.branchName !== branchName) {
      throw new Error(`Module migration runs may only publish to ${branchName}.`);
    }
    this.assertCommittedPrerequisites(
      request.repositoryRoot,
      branchName,
      request.manifest,
      wave,
    );
    this.assertManifestPublications(request.repositoryRoot, branchName, request.plan, request.manifest);
    const preparedModules = await new ModuleWavePreparationRunner(request.preparer).prepare({
      repositoryRoot: request.repositoryRoot,
      analysis: request.analysis,
      plan: request.plan,
      waveId: request.waveId,
      branchName,
      ...(request.maxPreparationParallelism === undefined
        ? {}
        : { maxParallelism: request.maxPreparationParallelism }),
    });
    return this.prepare({
      ...request,
      preparedModules,
    });
  }

  async commit(request: ModuleWaveCommitRequest): Promise<ModuleWaveCommitResult> {
    const now = request.now ?? new Date().toISOString();
    const { wave, analysis } = assertCommitPreconditions(request);
    const moduleBundle = validatePreparedModules(request.plan, wave.id, request.prepared.preparedModules);
    assertPreparedBundle(request.prepared, request.manifest, request.plan, moduleBundle);
    assertPreparedManifest(request.manifest, request.prepared.transaction);
    if (!areWaveApprovalsCurrent(request.plan, wave.id, request.prepared.transaction.preparedHash)) {
      throw new Error(`Execution wave ${wave.id} lacks a human approval for its prepared patch bundle.`);
    }
    this.assertCommittedPrerequisites(
      request.repositoryRoot,
      request.prepared.branchName,
      request.manifest,
      wave,
    );
    this.assertManifestPublications(
      request.repositoryRoot,
      request.prepared.branchName,
      request.plan,
      request.manifest,
    );
    const expectedBaseCommit = this.expectedBaseCommit(
      request.repositoryRoot,
      request.prepared.branchName,
      request.manifest,
      request.plan,
      request.analysis,
    );
    if (expectedBaseCommit !== undefined && request.prepared.transaction.baseCommit !== expectedBaseCommit) {
      throw new Error("Prepared wave baseline is not the indexed revision or the published prior wave.");
    }

    const runArtifact = migrationRunArtifactPath(request.manifest.id);
    const analysisArtifact = analysisArtifactPath(request.analysis.snapshotId);
    const baseManifest = cloneManifest(request.manifest);
    let committedPlan: ModuleMigrationPlan | undefined;
    let committedSummary: ModuleSummary | undefined;
    let committedManifest: MigrationRunManifest | undefined;
    let committedTransaction: WaveTransaction | undefined;

    const git = await this.#git.commit({
      repositoryRoot: request.repositoryRoot,
      branchName: request.prepared.branchName,
      transactionId: request.prepared.transaction.id,
      expectedBaseCommit: request.prepared.transaction.baseCommit,
      files: moduleBundle.files,
      commitMessage: request.commitMessage ?? `forexplore: apply ${wave.id}`,
      finalize: (worktreeRoot) => {
        committedPlan = planAfterCommittedWave(request.plan, baseManifest, wave.id, now);
        committedSummary = materializeModuleSummary(committedPlan, readExistingSummary(worktreeRoot));
        const analysisPatch = immutableAnalysisArtifactPatch(
          worktreeRoot,
          analysisArtifact,
          analysis,
        );
        const summaryPatch = artifactPatch(
          worktreeRoot,
          moduleSummaryPath,
          serializeModuleSummary(committedSummary),
        );
        const runHash = existingSha256(worktreeRoot, runArtifact);
        committedTransaction = {
          ...request.prepared.transaction,
          status: "committed",
          baselineFileHashes: {
            ...request.prepared.transaction.baselineFileHashes,
            ...(analysisPatch === undefined ? {} : {
              [analysisArtifact]: analysisPatch.status === "created"
                ? null
                : analysisPatch.expectedOriginalSha256,
            }),
            [moduleSummaryPath]: summaryPatch.status === "created"
              ? null
              : summaryPatch.expectedOriginalSha256,
            [runArtifact]: runHash ?? null,
          },
          completedAt: now,
        };
        committedManifest = manifestAfterCommittedWave(
          baseManifest,
          committedPlan,
          committedTransaction,
          mergeValidation(baseManifest.validation, request.prepared.validation),
          now,
        );
        return [
          ...(analysisPatch === undefined ? [] : [analysisPatch]),
          summaryPatch,
          artifactPatch(worktreeRoot, runArtifact, `${canonicalJson(committedManifest)}\n`),
        ];
      },
    });

    if (!committedPlan || !committedSummary || !committedManifest || !committedTransaction) {
      throw new Error("Wave transaction completed without materializing its managed artifacts.");
    }
    const transaction: WaveTransaction = { ...committedTransaction, commit: git.commit };
    const manifest: MigrationRunManifest = {
      ...committedManifest,
      transactions: committedManifest.transactions.map((item) =>
        item.id === transaction.id ? transaction : item,
      ),
    };
    return {
      branchName: request.prepared.branchName,
      commit: git.commit,
      plan: committedPlan,
      manifest,
      summary: committedSummary,
      transaction,
      git,
    };
  }

  private assertCommittedPrerequisites(
    repositoryRoot: string,
    branchName: string,
    manifest: MigrationRunManifest,
    wave: ModuleMigrationPlan["executionWaves"][number],
  ): void {
    for (const prerequisiteWaveId of wave.dependsOnWaveIds) {
      const transaction = manifest.transactions.find(
        (item) => item.waveId === prerequisiteWaveId && item.status === "committed",
      );
      if (!transaction) continue;
      const published = this.#git.findPublishedTransactionCommit(repositoryRoot, {
        transactionId: transaction.id,
        branchName,
        baseCommit: transaction.baseCommit,
        ...(transaction.commit === undefined ? {} : { commit: transaction.commit }),
      });
      if (!published) {
        throw new Error(`Committed prerequisite ${prerequisiteWaveId} is not published on ${branchName}.`);
      }
      if (transaction.commit !== undefined && transaction.commit !== published) {
        throw new Error(`Committed prerequisite ${prerequisiteWaveId} does not match the managed branch transaction.`);
      }
    }
  }

  /**
   * A caller-supplied run manifest is audit input, not proof of publication.
   * Verify every committed transaction against the managed branch before
   * deriving the next plan/summary state; otherwise an unrelated fabricated
   * transaction could make a future wave appear complete.
   */
  private assertManifestPublications(
    repositoryRoot: string,
    branchName: string,
    plan: ModuleMigrationPlan,
    manifest: MigrationRunManifest,
  ): void {
    for (const transaction of manifest.transactions.filter((item) => item.status === "committed")) {
      const published = this.#git.findPublishedTransactionCommit(repositoryRoot, {
        transactionId: transaction.id,
        branchName,
        baseCommit: transaction.baseCommit,
        ...(transaction.commit === undefined ? {} : { commit: transaction.commit }),
      });
      if (!published) {
        throw new Error(`Committed wave ${transaction.waveId} is not published on ${branchName}.`);
      }
      if (transaction.commit !== undefined && transaction.commit !== published) {
        throw new Error(`Committed wave ${transaction.waveId} does not match the managed branch transaction.`);
      }
      if (!plan.executionWaves.some((wave) => wave.id === transaction.waveId)) {
        throw new Error(`Committed transaction references unknown execution wave ${transaction.waveId}.`);
      }
    }
  }

  /**
   * Bind the first wave to the Git revision captured by static analysis. For
   * later waves the sole managed branch is the baseline, so resolve its latest
   * published transaction from the trailer rather than trusting a manifest
   * commit field that may be absent until the next artifact rewrite.
   */
  private expectedBaseCommit(
    repositoryRoot: string,
    branchName: string,
    manifest: MigrationRunManifest,
    plan: ModuleMigrationPlan,
    analysis: RepositoryStaticAnalysis,
  ): string | undefined {
    const committed = manifest.transactions
      .filter((transaction) => transaction.status === "committed")
      .map((transaction) => ({
        transaction,
        order: plan.executionWaves.find((wave) => wave.id === transaction.waveId)?.order ?? -1,
      }))
      .sort((left, right) => right.order - left.order || right.transaction.waveId.localeCompare(left.transaction.waveId));
    const latest = committed[0]?.transaction;
    if (latest) {
      const published = this.#git.findPublishedTransactionCommit(repositoryRoot, {
        transactionId: latest.id,
        branchName,
        baseCommit: latest.baseCommit,
        ...(latest.commit === undefined ? {} : { commit: latest.commit }),
      });
      if (!published) {
        throw new Error(`Latest committed wave ${latest.waveId} is not published on ${branchName}.`);
      }
      return published;
    }
    const revision = analysis.repository.revision?.trim();
    return revision && /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
  }
}

function assertPreparationPreconditions(
  request: ModuleWavePreparationRequest,
): ModuleMigrationPlan["executionWaves"][number] {
  assertPlanAndManifest(request.plan, request.analysis, request.manifest);
  const wave = requireWave(request.plan, request.waveId);
  assertWaveReady(request.plan, request.manifest, wave);
  return wave;
}

function assertCommitPreconditions(
  request: ModuleWaveCommitRequest,
): {
  wave: ModuleMigrationPlan["executionWaves"][number];
  analysis: RepositoryStaticAnalysis;
} {
  const analysis = assertPlanAndManifest(request.plan, request.analysis, request.manifest);
  const wave = requireWave(request.plan, request.prepared.transaction.waveId);
  assertWaveReady(request.plan, request.manifest, wave, request.prepared.transaction);
  return { wave, analysis };
}

function assertPlanAndManifest(
  plan: ModuleMigrationPlan,
  analysis: RepositoryStaticAnalysis,
  manifest: MigrationRunManifest,
): RepositoryStaticAnalysis {
  let verifiedAnalysis: RepositoryStaticAnalysis;
  try {
    verifiedAnalysis = verifyRepositoryStaticAnalysis(analysis);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository static analysis is not a verified immutable snapshot: ${detail}`);
  }
  const validation = validateModuleMigrationPlan(plan, verifiedAnalysis);
  if (!validation.valid) {
    throw new Error(`Module migration plan is invalid: ${validation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.code)
      .join(", ")}`);
  }
  if (!arePlanApprovalsCurrent(plan, verifiedAnalysis.snapshotId)) {
    throw new Error("Module migration plan lacks a current human approval for this analysis snapshot.");
  }
  if (
    manifest.schemaVersion !== plan.schemaVersion ||
    manifest.snapshotId !== plan.snapshotId ||
    manifest.analysisHash !== plan.analysisHash ||
    manifest.planId !== plan.id ||
    manifest.planHash !== plan.planHash
  ) {
    throw new Error("Migration run manifest is not bound to this module plan and analysis snapshot.");
  }
  const expectedArtifacts = {
    analysis: analysisArtifactPath(plan.snapshotId),
    summary: moduleSummaryPath,
    manifest: migrationRunArtifactPath(manifest.id),
  };
  if (canonicalJson(manifest.artifactPaths) !== canonicalJson(expectedArtifacts)) {
    throw new Error("Migration run manifest does not use the managed artifact paths for this run.");
  }
  assertManifestTransactions(plan, manifest);
  return verifiedAnalysis;
}

function requireWave(
  plan: ModuleMigrationPlan,
  waveId: string,
): ModuleMigrationPlan["executionWaves"][number] {
  const wave = plan.executionWaves.find((item) => item.id === waveId);
  if (!wave) throw new Error(`Unknown execution wave: ${waveId}`);
  return wave;
}

function assertWaveReady(
  plan: ModuleMigrationPlan,
  manifest: MigrationRunManifest,
  wave: ModuleMigrationPlan["executionWaves"][number],
  preparedTransaction?: WaveTransaction,
): void {
  if (manifest.transactions.some(
    (transaction) => transaction.waveId === wave.id && transaction.status === "committed",
  )) {
    throw new Error(`Execution wave ${wave.id} is already committed.`);
  }
  // The managed branch is a single publication stream. An unfinished
  // transaction for any wave must be recovered before another wave can be
  // prepared or committed; allowing an unrelated wave through would race the
  // same ref and invalidate its baseline.
  const unfinished = manifest.transactions.filter(
    (transaction) => transaction.status === "prepared" || transaction.status === "committing",
  );
  if (unfinished.length > 0) {
    const isExactPrepared =
      unfinished.length === 1 &&
      preparedTransaction !== undefined &&
      unfinished[0]!.waveId === wave.id &&
      unfinished[0]!.status === "prepared" &&
      canonicalJson(unfinished[0]) === canonicalJson(preparedTransaction);
    if (!isExactPrepared) {
      throw new Error(`Execution wave ${wave.id} has an unfinished transaction that must be recovered first.`);
    }
  }
  for (const prerequisite of wave.dependsOnWaveIds) {
    const transactions = manifest.transactions.filter(
      (transaction) => transaction.waveId === prerequisite,
    );
    if (
      transactions.length !== 1 ||
      transactions[0]?.status !== "committed" ||
      (transactions[0].commit !== undefined && !isGitCommit(transactions[0].commit))
    ) {
      throw new Error(`Execution wave ${wave.id} is blocked by uncommitted prerequisite ${prerequisite}.`);
    }
  }
}

/** Reject a host-built manifest that tries to fabricate scheduling progress. */
function assertManifestTransactions(
  plan: ModuleMigrationPlan,
  manifest: MigrationRunManifest,
): void {
  const waves = new Map(plan.executionWaves.map((wave) => [wave.id, wave]));
  const seenWaves = new Set<string>();
  const expectedBranch = defaultBranchName(manifest.id);
  for (const transaction of manifest.transactions) {
    if (!waves.has(transaction.waveId)) {
      throw new Error(`Migration run manifest references unknown execution wave ${transaction.waveId}.`);
    }
    if (seenWaves.has(transaction.waveId)) {
      throw new Error(`Migration run manifest has multiple transactions for ${transaction.waveId}.`);
    }
    seenWaves.add(transaction.waveId);
    if (
      transaction.id !== stableTransactionId(manifest.id, transaction.waveId) ||
      transaction.runId !== manifest.id ||
      transaction.snapshotId !== plan.snapshotId ||
      transaction.planHash !== plan.planHash ||
      transaction.branchName !== expectedBranch ||
      !isGitCommit(transaction.baseCommit) ||
      !transaction.preparedHash.trim()
    ) {
      throw new Error(`Migration run manifest transaction ${transaction.id} is not bound to this run.`);
    }
    if (transaction.status === "committed" && !transaction.completedAt) {
      throw new Error(`Committed transaction ${transaction.id} lacks its completion evidence.`);
    }
    if (transaction.commit !== undefined && !isGitCommit(transaction.commit)) {
      throw new Error(`Transaction ${transaction.id} has an invalid Git commit identity.`);
    }
    if (transaction.status !== "committed" && transaction.commit !== undefined) {
      throw new Error(`Uncommitted transaction ${transaction.id} must not claim a published Git commit.`);
    }
  }
}

function isGitCommit(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/i.test(value);
}

function validatePreparedModules(
  plan: ModuleMigrationPlan,
  waveId: string,
  preparedModules: readonly PreparedModulePatch[],
): { files: FilePatch[]; validation: ValidationRecord[] } {
  const wave = requireWave(plan, waveId);
  const expectedModuleIds = [...wave.moduleIds].sort();
  const suppliedModuleIds = preparedModules.map((item) => item.moduleId).sort();
  if (
    suppliedModuleIds.length !== expectedModuleIds.length ||
    suppliedModuleIds.some((id, index) => id !== expectedModuleIds[index])
  ) {
    throw new Error(`Prepared patches must cover exactly the modules in ${waveId}.`);
  }
  const moduleById = new Map(plan.modules.map((module) => [module.id, module]));
  const paths = new Set<string>();
  const files: FilePatch[] = [];
  const validation: ValidationRecord[] = [];
  for (const prepared of preparedModules) {
    const module = moduleById.get(prepared.moduleId);
    if (!module) throw new Error(`Prepared patch references unknown module: ${prepared.moduleId}`);
    assertValidationEvidence(prepared.validation, `module ${module.id}`);
    if (prepared.files.length === 0) throw new Error(`Module ${module.id} has no prepared patch.`);
    const allowedPaths = new Set([
      ...module.sourceFiles,
      ...(module.testFiles ?? []),
      ...(module.generatedFiles ?? []),
      ...module.writeSet,
    ]);
    for (const patch of prepared.files) {
      assertRepositoryRelativePath(patch.path);
      if (patch.path.startsWith(".forexplore/")) {
        throw new Error("Module patches cannot write managed ForeXplore artifacts.");
      }
      if (!allowedPaths.has(patch.path)) {
        throw new Error(`Patch ${patch.path} is outside the approved write set for module ${module.id}.`);
      }
      if (paths.has(patch.path)) {
        throw new Error(`Multiple module patches write ${patch.path} in the same wave.`);
      }
      paths.add(patch.path);
      files.push(patch);
    }
    validation.push(...scopeValidationRecords(
      `wave:${waveId}:module:${module.id}`,
      prepared.validation,
    ));
  }
  return { files, validation };
}

function assertPreparedBundle(
  prepared: PreparedModuleWave,
  manifest: MigrationRunManifest,
  plan: ModuleMigrationPlan,
  moduleBundle: { files: FilePatch[]; validation: ValidationRecord[] },
): void {
  const transaction = prepared.transaction;
  if (
    transaction.status !== "prepared" ||
    transaction.runId !== manifest.id ||
    transaction.snapshotId !== plan.snapshotId ||
    transaction.planHash !== plan.planHash ||
    transaction.branchName !== prepared.branchName ||
    transaction.branchName !== defaultBranchName(manifest.id) ||
    !transaction.baseCommit ||
    !transaction.preparedHash
  ) {
    throw new Error("Prepared wave transaction is incomplete or bound to a different plan.");
  }
  if (canonicalJson(prepared.files) !== canonicalJson(moduleBundle.files)) {
    throw new Error("Prepared wave files do not match the module patch bundle.");
  }
  if (canonicalJson(transaction.baselineFileHashes) !== canonicalJson(baselineHashes(moduleBundle.files))) {
    throw new Error("Prepared wave baseline hashes do not match its patches.");
  }
  const expectedValidation = mergeValidation([], [...moduleBundle.validation, ...prepared.validation]);
  if (canonicalJson(expectedValidation) !== canonicalJson(prepared.validation)) {
    throw new Error("Prepared wave validation records are incomplete or conflicting.");
  }
  const { preparedHash: _preparedHash, ...withoutHash } = transaction;
  const expectedHash = calculatePreparedWaveHash(withoutHash, moduleBundle.files, prepared.validation);
  if (transaction.preparedHash !== expectedHash) {
    throw new Error("Prepared wave hash does not match its patch bundle and validation evidence.");
  }
}

function assertPreparedManifest(
  manifest: MigrationRunManifest,
  transaction: WaveTransaction,
): void {
  const matching = manifest.transactions.filter((item) => item.id === transaction.id);
  if (
    matching.length !== 1 ||
    matching[0]?.status !== "prepared" ||
    canonicalJson(matching[0]) !== canonicalJson(transaction)
  ) {
    throw new Error("Run manifest does not contain the exact prepared wave transaction.");
  }
}

function assertValidationEvidence(validation: readonly ValidationRecord[], context: string): void {
  const gate = evaluateValidationGate([...validation]);
  if (!gate.allowed) {
    throw new Error(`${context} is blocked by validation: ${gate.blockers.map((item) => item.id).join(", ")}`);
  }
}

function planAfterCommittedWave(
  plan: ModuleMigrationPlan,
  manifest: MigrationRunManifest,
  waveId: string,
  updatedAt: string,
): ModuleMigrationPlan {
  const committed = new Set(
    manifest.transactions
      .filter((transaction) => transaction.status === "committed")
      .map((transaction) => transaction.waveId),
  );
  const reconciled: ModuleMigrationPlan = {
    ...plan,
    executionWaves: plan.executionWaves.map((wave) => ({
      ...wave,
      status: wave.id !== waveId && committed.has(wave.id)
        ? "committed" as const
        : wave.status === "committed"
          ? "pending" as const
          : wave.status,
    })),
  };
  // The durable Git journal carries the in-flight transaction state. Keep
  // the reviewable plan on the same legal path before materializing its final
  // committed state in the publication transaction.
  const committing = transitionModulePlanWaveStatus(reconciled, waveId, "committing", updatedAt);
  const committedPlan = transitionModulePlanWaveStatus(committing, waveId, "committed", updatedAt);
  return {
    ...committedPlan,
    status: committedPlan.executionWaves.every((wave) => wave.status === "committed") ? "completed" : "executing",
    updatedAt,
  };
}

function planAfterPreparedWave(
  plan: ModuleMigrationPlan,
  manifest: MigrationRunManifest,
  waveId: string,
  updatedAt: string,
): ModuleMigrationPlan {
  const committed = new Set(
    manifest.transactions
      .filter((transaction) => transaction.status === "committed")
      .map((transaction) => transaction.waveId),
  );
  const reconciled: ModuleMigrationPlan = {
    ...plan,
    executionWaves: plan.executionWaves.map((wave) =>
      committed.has(wave.id)
        ? { ...wave, status: "committed" as const }
        : wave.status === "committed"
          ? { ...wave, status: "pending" as const }
          : wave,
    ),
  };
  const prepared = transitionModulePlanWaveStatus(reconciled, waveId, "prepared", updatedAt);
  const awaitingApproval = transitionModulePlanWaveStatus(
    prepared,
    waveId,
    "awaiting-approval",
    updatedAt,
  );
  return {
    ...awaitingApproval,
    status: "executing",
    updatedAt,
  };
}

function manifestAfterCommittedWave(
  manifest: MigrationRunManifest,
  plan: ModuleMigrationPlan,
  transaction: WaveTransaction,
  validation: ValidationRecord[],
  updatedAt: string,
): MigrationRunManifest {
  const transactions = [...manifest.transactions.filter((item) => item.waveId !== transaction.waveId), transaction]
    .sort((left, right) => left.waveId.localeCompare(right.waveId) || left.id.localeCompare(right.id));
  return {
    ...manifest,
    status: plan.status === "completed" ? "completed" : "executing",
    updatedAt,
    decisions: [...plan.decisions].sort(
      (left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.id.localeCompare(right.id),
    ),
    validation,
    transactions,
  };
}

function manifestAfterPreparedWave(
  manifest: MigrationRunManifest,
  plan: ModuleMigrationPlan,
  transaction: WaveTransaction,
  validation: ValidationRecord[],
  updatedAt: string,
): MigrationRunManifest {
  if (manifest.transactions.some((item) => item.waveId === transaction.waveId)) {
    throw new Error(`Run manifest already contains a transaction for ${transaction.waveId}.`);
  }
  return {
    ...manifest,
    // The patch is only staged in a disposable worktree. Keep the run at
    // approved until a human has approved the exact prepared bundle.
    status: "approved",
    updatedAt,
    decisions: [...plan.decisions].sort(
      (left, right) => left.decidedAt.localeCompare(right.decidedAt) || left.id.localeCompare(right.id),
    ),
    validation: mergeValidation(manifest.validation, validation),
    transactions: [...manifest.transactions, transaction].sort(
      (left, right) => left.waveId.localeCompare(right.waveId) || left.id.localeCompare(right.id),
    ),
  };
}

function mergeValidation(
  existing: readonly ValidationRecord[],
  incoming: readonly ValidationRecord[],
): ValidationRecord[] {
  const byId = new Map<string, ValidationRecord>();
  for (const item of [...existing, ...incoming]) {
    const previous = byId.get(item.id);
    if (previous && canonicalJson(previous) !== canonicalJson(item)) {
      throw new Error(`Validation record ${item.id} conflicts with existing run evidence.`);
    }
    byId.set(item.id, { ...item });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * A validation command can legitimately run once per module or per wave. Its
 * configured ID is only locally stable, so scope the durable record before it
 * enters a run manifest. This prevents one later wave from replacing or
 * removing evidence produced by an earlier committed wave.
 */
function scopeValidationRecords(
  scope: string,
  records: readonly ValidationRecord[],
): ValidationRecord[] {
  const ids = new Set<string>();
  return records.map((record) => {
    if (!record.id.trim()) throw new Error(`Validation record in ${scope} lacks an ID.`);
    if (ids.has(record.id)) {
      throw new Error(`Validation record ${record.id} is duplicated in ${scope}.`);
    }
    ids.add(record.id);
    return {
      ...record,
      id: `forexplore:${scope}:${record.id}`,
    };
  });
}

function baselineHashes(files: readonly FilePatch[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    if (Object.prototype.hasOwnProperty.call(result, file.path)) {
      throw new Error(`Duplicate baseline hash path: ${file.path}`);
    }
    result[file.path] = file.status === "created" ? null : file.expectedOriginalSha256;
  }
  return result;
}

function calculatePreparedWaveHash(
  transaction: Omit<WaveTransaction, "preparedHash">,
  files: readonly FilePatch[],
  validation: readonly ValidationRecord[],
): string {
  return `sha256:${sha256(canonicalJson({
    transaction: {
      id: transaction.id,
      runId: transaction.runId,
      waveId: transaction.waveId,
      snapshotId: transaction.snapshotId,
      planHash: transaction.planHash,
      branchName: transaction.branchName,
      baseCommit: transaction.baseCommit,
      baselineFileHashes: transaction.baselineFileHashes,
      checkpointId: transaction.checkpointId,
      preparedAt: transaction.preparedAt,
    },
    files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
    validation: [...validation].sort((left, right) => left.id.localeCompare(right.id)),
  }))}`;
}

function readExistingSummary(worktreeRoot: string): ModuleSummary | undefined {
  const filePath = resolveInside(worktreeRoot, moduleSummaryPath);
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as ModuleSummary;
  } catch {
    // Reject a malformed managed artifact rather than replacing it.
  }
  throw new Error("Existing .forexplore/module-summary.json is not valid JSON.");
}

/**
 * Analysis evidence is content-addressed and immutable. A later wave may
 * reference an already committed snapshot, but it can never replace it with
 * a different graph under the same snapshot ID.
 */
function immutableAnalysisArtifactPatch(
  worktreeRoot: string,
  artifactPath: string,
  analysis: RepositoryStaticAnalysis,
): FilePatch | undefined {
  let verifiedAnalysis: RepositoryStaticAnalysis;
  try {
    verifiedAnalysis = verifyRepositoryStaticAnalysis(analysis);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot commit an invalid static analysis artifact: ${detail}`);
  }
  const fullPath = resolveInside(worktreeRoot, artifactPath);
  const serialized = `${canonicalJson(verifiedAnalysis)}\n`;
  if (!existsSync(fullPath)) {
    return createdArtifactPatch(artifactPath, serialized);
  }
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    throw new Error(`Existing immutable analysis artifact is not valid JSON: ${artifactPath}`);
  }
  let verifiedExisting: RepositoryStaticAnalysis;
  try {
    verifiedExisting = verifyRepositoryStaticAnalysis(existing);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Existing immutable analysis artifact is invalid: ${artifactPath}: ${detail}`);
  }
  if (
    verifiedExisting.snapshotId !== verifiedAnalysis.snapshotId ||
    verifiedExisting.contentHash !== verifiedAnalysis.contentHash
  ) {
    throw new Error(`Immutable analysis artifact conflicts with the current snapshot: ${artifactPath}`);
  }
  return undefined;
}

function artifactPatch(worktreeRoot: string, artifactPath: string, nextContent: string): FilePatch {
  const fullPath = resolveInside(worktreeRoot, artifactPath);
  const nextLines = normalizedLines(nextContent);
  if (!existsSync(fullPath)) {
    return createdArtifactPatch(artifactPath, nextContent);
  }
  const before = readFileSync(fullPath);
  const beforeLines = normalizedLines(before.toString("utf8"));
  return {
    path: artifactPath,
    status: "modified",
    expectedOriginalSha256: sha256(before),
    additions: nextLines.length,
    deletions: beforeLines.length,
    hunks: [{
      header: `@@ -1,${beforeLines.length} +1,${nextLines.length} @@`,
      lines: [
        ...beforeLines.map((content) => ({ type: "remove" as const, content })),
        ...nextLines.map((content) => ({ type: "add" as const, content })),
      ],
    }],
  };
}

function createdArtifactPatch(artifactPath: string, content: string): FilePatch {
  const lines = normalizedLines(content);
  return {
    path: artifactPath,
    status: "created",
    expectedAbsent: true,
    additions: lines.length,
    deletions: 0,
    hunks: [{
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: lines.map((line) => ({ type: "add" as const, content: line })),
    }],
  };
}

function existingSha256(worktreeRoot: string, artifactPath: string): string | undefined {
  const filePath = resolveInside(worktreeRoot, artifactPath);
  return existsSync(filePath) ? sha256(readFileSync(filePath)) : undefined;
}

function normalizedLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function resolveInside(root: string, filePath: string): string {
  assertRepositoryRelativePath(filePath);
  const fullPath = resolve(root, filePath);
  const fromRoot = relative(root, fullPath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Artifact path escapes repository root: ${filePath}`);
  }
  return fullPath;
}

function assertRepositoryRelativePath(filePath: string): void {
  if (
    !filePath ||
    isAbsolute(filePath) ||
    filePath.includes("\\") ||
    filePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Path must be a normalized repository-relative path: ${filePath}`);
  }
}

function stableTransactionId(runId: string, waveId: string): string {
  return `wave-${sha256(`${runId}\u0000${waveId}`).slice(0, 24)}`;
}

function defaultBranchName(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(runId)) {
    throw new Error("Migration run id must be safe for a managed branch and artifact path.");
  }
  return `codex/forexplore-migration/${runId}`;
}

function copyPatches(files: readonly FilePatch[]): FilePatch[] {
  return JSON.parse(JSON.stringify(files)) as FilePatch[];
}

function copyPreparedModules(modules: readonly PreparedModulePatch[]): PreparedModulePatch[] {
  return modules.map((module) => ({
    moduleId: module.moduleId,
    files: copyPatches(module.files),
    validation: module.validation.map((record) => ({ ...record })),
  }));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneManifest(manifest: MigrationRunManifest): MigrationRunManifest {
  return JSON.parse(JSON.stringify(manifest)) as MigrationRunManifest;
}
