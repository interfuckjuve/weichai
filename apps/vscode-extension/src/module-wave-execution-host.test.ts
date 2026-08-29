import { describe, expect, it, vi } from 'vitest';
import {
  moduleMigrationSchemaVersion,
  type MigrationRunManifest,
  type ModuleMigrationPlan,
  type RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  areWaveApprovalsCurrent,
  calculateModuleMigrationPlanHash,
  createMigrationRunManifest,
} from '@forexplore/workflow-core';
import type { ModuleWavePreparationRequest, PreparedModuleWave } from '@forexplore/adaptation-service/module-wave-execution';
import {
  approvePreparedLocalModuleWave,
  prepareLocalModuleWave,
  restoreCommittedLocalModuleWave,
  rollbackPreparedLocalModuleWave,
  type ModuleWaveExecutionPort,
} from './module-wave-execution-host';
import {
  moduleWavePatchBundleSchemaVersion,
  parseModuleWavePatchBundle,
} from './module-wave-patch-bundle';
import type { ModuleWaveValidator } from './module-wave-validation';

const now = '2026-08-27T00:00:00.000Z';
const digest = 'a'.repeat(64);
const commit = 'b'.repeat(40);

function analysis(): RepositoryStaticAnalysis {
  return {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: 'snapshot-1',
    contentHash: 'analysis-hash',
    analyzerVersion: 'test',
    createdAt: now,
    repository: { revision: commit },
    files: [{ path: 'src/Service.cs', sha256: digest, role: 'source', language: 'C#' }],
    symbols: [],
    dependencies: [],
    diagnostics: [],
  };
}

function plan(): ModuleMigrationPlan {
  const planWithoutHash = {
    schemaVersion: moduleMigrationSchemaVersion,
    id: 'module-plan:example',
    snapshotId: 'snapshot-1',
    analysisHash: 'analysis-hash',
    objective: 'Migrate service',
    modules: [{
      id: 'service',
      name: 'Service',
      kind: 'feature',
      description: 'Service',
      sourceFiles: ['src/Service.cs'],
      symbolIds: [],
      dependsOn: [],
      writeSet: ['src/Service.cs'],
      resourceLocks: [],
      evidenceIds: [],
    }],
    fileAssignments: [{ path: 'src/Service.cs', kind: 'module', moduleId: 'service' }],
    dependencies: [],
    risks: [],
    status: 'approved',
    executionGroups: [{
      id: 'group-service',
      kind: 'module',
      moduleIds: ['service'],
      dependsOnGroupIds: [],
      executionMode: 'serial',
      atomic: true,
      writeSet: ['src/Service.cs'],
      resourceLocks: [],
      reasons: [],
    }],
    executionWaves: [{
      id: 'wave-1',
      order: 1,
      groupIds: ['group-service'],
      moduleIds: ['service'],
      dependsOnWaveIds: [],
      maxParallelism: 1,
      requiresApproval: true,
      status: 'pending',
      parallelismBlockedBy: [],
    }],
    createdAt: now,
    updatedAt: now,
  } satisfies Omit<ModuleMigrationPlan, 'planHash' | 'decisions'>;
  const planHash = calculateModuleMigrationPlanHash(planWithoutHash);
  return {
    ...planWithoutHash,
    planHash,
    decisions: [{
      id: 'plan-approval',
      kind: 'plan-approval',
      status: 'approved',
      snapshotId: 'snapshot-1',
      planHash,
      actor: 'architect',
      decidedAt: now,
    }],
  };
}

function bundle(planValue = plan()) {
  return parseModuleWavePatchBundle({
    schemaVersion: moduleWavePatchBundleSchemaVersion,
    snapshotId: 'snapshot-1',
    planId: 'module-plan:example',
    planHash: planValue.planHash,
    waveId: 'wave-1',
    modules: [{
      moduleId: 'service',
      files: [{
        path: 'src/Service.cs',
        status: 'modified',
        expectedOriginalSha256: digest,
        additions: 1,
        deletions: 1,
        hunks: [{
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'old' },
            { type: 'add', content: 'new' },
          ],
        }],
      }],
    }],
  });
}

function coordinator(): { port: ModuleWaveExecutionPort; prepare: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn(async (request: ModuleWavePreparationRequest): Promise<PreparedModuleWave> => {
    const joint = await request.validate('C:/temporary/worktree');
    const transaction = {
      id: 'wave-transaction',
      runId: request.manifest.id,
      waveId: request.waveId,
      snapshotId: request.plan.snapshotId,
      planHash: request.plan.planHash,
      branchName: `codex/forexplore-migration/${request.manifest.id}`,
      preparedHash: `sha256:${'c'.repeat(64)}`,
      status: 'prepared' as const,
      baseCommit: commit,
      baselineFileHashes: { 'src/Service.cs': digest },
      preparedAt: now,
    };
    const preparedPlan = {
      ...request.plan,
      status: 'executing' as const,
      executionWaves: request.plan.executionWaves.map((wave) => (
        wave.id === request.waveId ? { ...wave, status: 'awaiting-approval' as const } : wave
      )),
    };
    const validation = [...request.preparedModules.flatMap((item) => item.validation), ...joint];
    const manifest: MigrationRunManifest = {
      ...request.manifest,
      status: 'approved',
      validation,
      transactions: [transaction],
    };
    return {
      branchName: transaction.branchName,
      files: request.preparedModules.flatMap((item) => item.files),
      preparedModules: request.preparedModules,
      transaction,
      validation,
      plan: preparedPlan,
      manifest,
    };
  });
  return {
    port: {
      prepare,
      commit: vi.fn(),
    },
    prepare,
  };
}

describe('module wave execution host helpers', () => {
  it('uses local scope and joint validation rather than bundle-supplied claims', async () => {
    const executor = coordinator();
    const validator: ModuleWaveValidator = {
      validate: vi.fn(async () => [{
        id: 'joint-local-check',
        label: 'Joint local check',
        status: 'pass' as const,
        required: true,
        summary: 'validated in disposable worktree',
      }]),
    };

    const result = await prepareLocalModuleWave({
      repositoryRoot: 'C:/repository',
      analysis: analysis(),
      plan: plan(),
      bundle: bundle(),
      validator,
      coordinator: executor.port,
      runId: 'run-1',
      now,
    });

    const request = executor.prepare.mock.calls[0]?.[0] as ModuleWavePreparationRequest;
    expect(request.manifest).toEqual(createMigrationRunManifest(plan(), 'run-1', now));
    expect(request.preparedModules[0]?.validation).toEqual([expect.objectContaining({
      id: expect.stringContaining('vscode-module-bundle-scope:'),
      required: true,
      status: 'pass',
    })]);
    expect(result.prepared.validation.map((record) => record.id)).toEqual(expect.arrayContaining([
      'joint-local-check',
    ]));
    expect(result.storedPrepared.validationIds).toEqual(expect.arrayContaining([
      'joint-local-check',
    ]));
  });

  it('rejects a plan whose write set crosses the module ownership boundary', async () => {
    const basePlan = plan();
    const invalidPlan: ModuleMigrationPlan = {
      ...basePlan,
      modules: basePlan.modules.map((module) => ({
        ...module,
        writeSet: ['src/Other.cs'],
      })),
    };
    const expandedAnalysis = {
      ...analysis(),
      files: [
        ...analysis().files,
        { path: 'src/Other.cs', sha256: digest, role: 'source' as const, language: 'C#' as const },
      ],
    };

    await expect(prepareLocalModuleWave({
      repositoryRoot: 'C:/repository',
      analysis: expandedAnalysis,
      plan: invalidPlan,
      bundle: bundle(invalidPlan),
      validator: { validate: async () => [] },
      coordinator: coordinator().port,
      runId: 'run-1',
      now,
    })).rejects.toThrow('写入范围越过了显式文件所有权');
  });

  it('binds an explicit wave approval to the prepared hash and clears it on rollback recovery', async () => {
    const executor = coordinator();
    const prepared = await prepareLocalModuleWave({
      repositoryRoot: 'C:/repository',
      analysis: analysis(),
      plan: plan(),
      bundle: bundle(),
      validator: { validate: async () => [{
        id: 'joint-local-check', label: 'Joint', status: 'pass', required: true, summary: 'pass',
      }] },
      coordinator: executor.port,
      runId: 'run-1',
      now,
    });
    const approved = approvePreparedLocalModuleWave(prepared.prepared.plan, prepared.prepared, 'reviewer', now);
    expect(areWaveApprovalsCurrent(
      approved,
      'wave-1',
      prepared.prepared.transaction.preparedHash,
    )).toBe(true);

    const recovered = rollbackPreparedLocalModuleWave({
      plan: approved,
      manifest: prepared.prepared.manifest,
      prepared: prepared.storedPrepared,
      updatedAt: '2026-08-27T00:01:00.000Z',
    });
    expect(recovered.plan.executionWaves[0]?.status).toBe('pending');
    expect(recovered.manifest.transactions).toEqual([]);
    expect(recovered.manifest.validation.map((record) => record.id)).not.toContain('joint-local-check');
  });

  it('rolls back a later prepared wave without deleting committed prior-wave validation evidence', () => {
    const basePlan = plan();
    const planFields: Omit<ModuleMigrationPlan, 'planHash' | 'decisions'> = basePlan;
    const twoWavePlanWithoutHash = {
      ...planFields,
      status: 'executing' as const,
      executionWaves: [
        { ...basePlan.executionWaves[0]!, status: 'committed' as const },
        {
          ...basePlan.executionWaves[0]!,
          id: 'wave-2',
          order: 2,
          dependsOnWaveIds: ['wave-1'],
          status: 'awaiting-approval' as const,
        },
      ],
    } satisfies Omit<ModuleMigrationPlan, 'planHash' | 'decisions'>;
    const planHash = calculateModuleMigrationPlanHash(twoWavePlanWithoutHash);
    const twoWavePlan: ModuleMigrationPlan = {
      ...twoWavePlanWithoutHash,
      planHash,
      decisions: basePlan.decisions.map((decision) => ({ ...decision, planHash })),
    };
    const priorValidation = {
      id: 'vscode-wave-validation:wave-1:node-smoke',
      label: 'Node smoke check',
      status: 'pass' as const,
      required: true,
      summary: 'wave 1 passed',
    };
    const laterValidation = {
      ...priorValidation,
      id: 'vscode-wave-validation:wave-2:node-smoke',
      summary: 'wave 2 passed before restart',
    };
    const waveOneTransaction = {
      id: 'wave-1-transaction',
      runId: 'run-1',
      waveId: 'wave-1',
      snapshotId: twoWavePlan.snapshotId,
      planHash: twoWavePlan.planHash,
      branchName: 'codex/forexplore-migration/run-1',
      preparedHash: `sha256:${'c'.repeat(64)}`,
      status: 'committed' as const,
      baseCommit: commit,
      baselineFileHashes: { 'src/Service.cs': digest },
      preparedAt: now,
      completedAt: now,
    };
    const waveTwoTransaction = {
      ...waveOneTransaction,
      id: 'wave-2-transaction',
      waveId: 'wave-2',
      preparedHash: `sha256:${'d'.repeat(64)}`,
      status: 'prepared' as const,
      completedAt: undefined,
    };
    const manifest: MigrationRunManifest = {
      ...createMigrationRunManifest(twoWavePlan, 'run-1', now),
      status: 'executing',
      validation: [priorValidation, laterValidation],
      transactions: [waveOneTransaction, waveTwoTransaction],
    };

    const recovered = rollbackPreparedLocalModuleWave({
      plan: twoWavePlan,
      manifest,
      prepared: {
        transactionId: waveTwoTransaction.id,
        waveId: waveTwoTransaction.waveId,
        preparedHash: waveTwoTransaction.preparedHash,
        validationIds: [laterValidation.id],
      },
      updatedAt: '2026-08-27T00:01:00.000Z',
    });

    expect(recovered.plan.executionWaves.map((wave) => wave.status)).toEqual(['committed', 'pending']);
    expect(recovered.manifest.transactions).toEqual([waveOneTransaction]);
    expect(recovered.manifest.validation).toEqual([priorValidation]);
  });

  it('rebuilds local progress from an atomically published run manifest', async () => {
    const executor = coordinator();
    const prepared = await prepareLocalModuleWave({
      repositoryRoot: 'C:/repository',
      analysis: analysis(),
      plan: plan(),
      bundle: bundle(),
      validator: { validate: async () => [{
        id: 'joint-local-check', label: 'Joint', status: 'pass', required: true, summary: 'pass',
      }] },
      coordinator: executor.port,
      runId: 'run-1',
      now,
    });
    const approvedPlan = approvePreparedLocalModuleWave(
      prepared.prepared.plan,
      prepared.prepared,
      'reviewer',
      now,
    );
    const expectedManifest: MigrationRunManifest = {
      ...prepared.prepared.manifest,
      decisions: approvedPlan.decisions,
    };
    const committedManifest: MigrationRunManifest = {
      ...expectedManifest,
      status: 'completed',
      transactions: expectedManifest.transactions.map((transaction) => ({
        ...transaction,
        status: 'committed' as const,
        completedAt: now,
      })),
    };

    const restored = restoreCommittedLocalModuleWave({
      plan: approvedPlan,
      expectedManifest,
      recoveredManifest: committedManifest,
      transactionId: prepared.prepared.transaction.id,
      commit,
      updatedAt: '2026-08-27T00:02:00.000Z',
    });
    expect(restored.plan.executionWaves[0]?.status).toBe('committed');
    expect(restored.plan.status).toBe('completed');
    expect(restored.manifest.transactions[0]?.commit).toBe(commit);
  });

  it('refuses a published manifest whose committed transaction differs from the reviewed bundle', async () => {
    const executor = coordinator();
    const prepared = await prepareLocalModuleWave({
      repositoryRoot: 'C:/repository',
      analysis: analysis(),
      plan: plan(),
      bundle: bundle(),
      validator: { validate: async () => [{
        id: 'joint-local-check', label: 'Joint', status: 'pass', required: true, summary: 'pass',
      }] },
      coordinator: executor.port,
      runId: 'run-1',
      now,
    });
    const approvedPlan = approvePreparedLocalModuleWave(
      prepared.prepared.plan,
      prepared.prepared,
      'reviewer',
      now,
    );
    const expectedManifest: MigrationRunManifest = {
      ...prepared.prepared.manifest,
      decisions: approvedPlan.decisions,
    };
    const forgedManifest: MigrationRunManifest = {
      ...expectedManifest,
      transactions: expectedManifest.transactions.map((transaction) => ({
        ...transaction,
        status: 'committed' as const,
        preparedHash: `sha256:${'d'.repeat(64)}`,
        completedAt: now,
      })),
    };

    expect(() => restoreCommittedLocalModuleWave({
      plan: approvedPlan,
      expectedManifest,
      recoveredManifest: forgedManifest,
      transactionId: prepared.prepared.transaction.id,
      commit,
      updatedAt: '2026-08-27T00:02:00.000Z',
    })).toThrow('未绑定到本地已准备波次');
  });
});
