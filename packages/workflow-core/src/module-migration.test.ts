import { describe, expect, it, vi } from 'vitest';
import {
  moduleMigrationSchemaVersion,
  type DependencyEdge,
  type FunctionalModule,
  type ModuleMigrationProposal,
  type RepositoryStaticAnalysis,
  type WaveTransaction,
} from '@forexplore/contracts';
import {
  ModulePlanValidationError,
  ModuleMigrationWorkflow,
  arePlanApprovalsCurrent,
  areWaveApprovalsCurrent,
  buildModuleMigrationPlan,
  canTransitionExecutionWaveStatus,
  canTransitionWaveTransactionStatus,
  calculateModuleMigrationPlanHash,
  collectDeclaredModuleDependencies,
  moduleDependencyKey,
  moduleIdTupleKey,
  createMigrationRunManifest,
  invalidatePlanForSnapshot,
  materializeModuleSummary,
  recordModulePlanDecision,
  scheduleModuleMigration,
  sha256Hex,
  stableHash,
  transitionExecutionWaveStatus,
  transitionModulePlanWaveStatus,
  transitionWaveTransactionStatus,
  validateModuleMigrationPlan,
  validateModuleMigrationProposal,
} from './index';

const SNAPSHOT = 'snapshot-1';
const NOW = '2026-08-26T00:00:00.000Z';

function module(id: string, sourceFile: string, dependsOn: string[] = []): FunctionalModule {
  return {
    id,
    name: id,
    kind: 'feature',
    description: `${id} module`,
    sourceFiles: [sourceFile],
    symbolIds: [`symbol:${id}`],
    dependsOn,
    writeSet: [sourceFile],
    resourceLocks: [],
    evidenceIds: [`symbol:${id}`],
  };
}

function edge(
  id: string,
  source: string,
  target: string | undefined,
  overrides: Partial<DependencyEdge> = {},
): DependencyEdge {
  return {
    id,
    sourceSymbolId: `symbol:${source}`,
    targetSymbolId: target === undefined ? undefined : `symbol:${target}`,
    sourcePath: `src/${source}.java`,
    targetPath: target === undefined ? undefined : `src/${target}.java`,
    kind: 'invocation',
    internal: true,
    resolution: 'resolved',
    evidence: 'semantic',
    evidenceRanges: [{ path: `src/${source}.java`, startLine: 1 }],
    snapshotId: SNAPSHOT,
    ...overrides,
  };
}

function analysis(
  modules: readonly FunctionalModule[],
  dependencies: DependencyEdge[] = [],
): RepositoryStaticAnalysis {
  return {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: SNAPSHOT,
    contentHash: 'analysis-sha256',
    analyzerVersion: 'test',
    createdAt: NOW,
    repository: { revision: 'deadbeef' },
    files: modules.map((item) => ({
      path: item.sourceFiles[0]!,
      sha256: `${item.id}-sha256`,
      role: 'source',
      language: 'Java',
    })),
    symbols: modules.map((item) => ({
      id: `symbol:${item.id}`,
      name: item.id,
      qualifiedName: item.id,
      kind: 'class',
      language: 'Java',
      path: item.sourceFiles[0]!,
    })),
    dependencies,
    diagnostics: [],
  };
}

function proposal(
  modules: FunctionalModule[],
  dependencies: ModuleMigrationProposal['dependencies'] = undefined,
): ModuleMigrationProposal {
  return {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: SNAPSHOT,
    objective: 'Migrate modules',
    modules,
    fileAssignments: modules.map((item) => ({
      path: item.sourceFiles[0]!,
      kind: 'module' as const,
      moduleId: item.id,
    })),
    dependencies,
  };
}

describe('module migration planning', () => {
  it('uses a browser-safe SHA-256 hash over canonical plan inputs', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('\u{1f600}')).toBe(
      'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9',
    );
    expect(stableHash({ second: 2, first: 1 })).toBe(
      'sha256:14d74bcde1082123d818f0c5bd142db6d482a7cda25d9ee43163ee3f79e8e7db',
    );
    expect(stableHash({ first: 1, second: 2 })).toBe(
      stableHash({ second: 2, first: 1 }),
    );
  });

  it('rejects unsafe module IDs and keeps internal graph keys injective', () => {
    expect(moduleIdTupleKey(['a|b', 'c'])).not.toBe(moduleIdTupleKey(['a', 'b|c']));
    expect(moduleDependencyKey({ moduleId: 'a\u0000b', dependsOnModuleId: 'c' })).not.toBe(
      moduleDependencyKey({ moduleId: 'a', dependsOnModuleId: 'b\u0000c' }),
    );
    expect(collectDeclaredModuleDependencies({
      modules: [],
      dependencies: [
        { moduleId: 'a\u0000b', dependsOnModuleId: 'c', source: 'architect', evidenceEdgeIds: [] },
        { moduleId: 'a', dependsOnModuleId: 'b\u0000c', source: 'architect', evidenceEdgeIds: [] },
      ],
    })).toHaveLength(2);

    const pipe = module('a|b', 'src/a-pipe-b.java');
    const control = module('a\u0000b', 'src/a-nul-b.java');
    const source = analysis([pipe, control]);
    const candidate = proposal([pipe, control]);
    const result = validateModuleMigrationProposal(candidate, source);

    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.code === 'module-id-invalid')).toHaveLength(2);
    expect(() => scheduleModuleMigration(candidate, source)).toThrow(ModulePlanValidationError);
  });

  it('rejects an architect proposal that weakens a hard internal dependency', () => {
    const source = module('a', 'src/a.java');
    const prerequisite = module('b', 'src/b.java');
    const result = validateModuleMigrationProposal(
      proposal([source, prerequisite]),
      analysis([source, prerequisite], [edge('edge-a-b', 'a', 'b')]),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('hard-dependency-missing');
  });

  it('does not allow a model-supplied symbol list to override file ownership', () => {
    const source = module('a', 'src/a.java', ['b']);
    const prerequisite = module('b', 'src/b.java');
    source.symbolIds = ['symbol:a', 'symbol:b'];
    prerequisite.symbolIds = [];
    const result = validateModuleMigrationProposal(
      proposal([source, prerequisite]),
      analysis([source, prerequisite], [edge('edge-a-b', 'a', 'b')]),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('module-symbol-ownership-mismatch');
  });

  it('maps explicit test and project-file associations to their owning modules', () => {
    const dependent = module('a', 'src/a.java', ['b']);
    const prerequisite = module('b', 'src/b.java');
    dependent.testFiles = ['tests/a-test.java'];
    const source = analysis([dependent, prerequisite], [
      edge('edge-project-a-b', 'a', 'b', {
        kind: 'project-reference',
        sourceSymbolId: undefined,
        targetSymbolId: undefined,
        sourcePath: 'projects/a.csproj',
        targetPath: 'projects/b.csproj',
      }),
      edge('edge-test-a-b', 'a', 'b', {
        kind: 'test-reference',
        sourceSymbolId: undefined,
        sourcePath: 'tests/a-test.java',
      }),
    ]);
    source.files.push(
      { path: 'projects/a.csproj', sha256: 'project-a', role: 'configuration' },
      { path: 'projects/b.csproj', sha256: 'project-b', role: 'configuration' },
      { path: 'tests/a-test.java', sha256: 'test-a', role: 'test', language: 'Java' },
    );

    const candidate = proposal([dependent, prerequisite]);
    candidate.fileAssignments.push(
      { path: 'projects/a.csproj', kind: 'excluded', moduleId: 'a', reason: 'a project file' },
      { path: 'projects/b.csproj', kind: 'excluded', moduleId: 'b', reason: 'b project file' },
      { path: 'tests/a-test.java', kind: 'test', moduleId: 'a' },
    );

    const result = validateModuleMigrationProposal(candidate, source);
    expect(result.valid).toBe(true);
    expect(scheduleModuleMigration(candidate, source).executionWaves.map((wave) => wave.moduleIds)).toEqual([
      ['b'],
      ['a'],
    ]);
  });

  it('rejects a module write set that crosses another module ownership boundary', () => {
    const left = module('left', 'src/left.java');
    const right = module('right', 'src/right.java');
    left.writeSet = ['src/right.java'];

    const result = validateModuleMigrationProposal(
      proposal([left, right]),
      analysis([left, right]),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('module-write-set-ownership-mismatch');
  });

  it('permits an explicitly assigned shared-contract configuration write', () => {
    const shared = module('contracts', 'src/contracts.java');
    shared.kind = 'shared-contract';
    shared.writeSet = ['src/contracts.java', 'projects/contracts.csproj'];
    shared.resourceLocks = ['project:contracts'];
    const source = analysis([shared]);
    source.files.push({
      path: 'projects/contracts.csproj',
      sha256: 'contracts-project',
      role: 'configuration',
    });
    const candidate = proposal([shared]);
    candidate.fileAssignments.push({
      path: 'projects/contracts.csproj',
      kind: 'excluded',
      moduleId: 'contracts',
      reason: 'Shared contract project configuration',
    });

    expect(validateModuleMigrationProposal(candidate, source).valid).toBe(true);
  });

  it('executes a prerequisite before its dependent and allows an independent module in the same wave', () => {
    const dependent = module('a', 'src/a.java', ['b']);
    const prerequisite = module('b', 'src/b.java');
    const independent = module('c', 'src/c.java');
    const source = analysis(
      [dependent, prerequisite, independent],
      [edge('edge-a-b', 'a', 'b')],
    );

    const schedule = scheduleModuleMigration(proposal([independent, dependent, prerequisite]), source);
    expect(schedule.executionWaves[0]?.moduleIds).toEqual(['b', 'c']);
    expect(schedule.executionWaves[1]?.moduleIds).toEqual(['a']);
    expect(schedule.executionWaves[1]?.dependsOnWaveIds).toEqual(['wave:001']);
  });

  it('collapses a dependency SCC into one atomic serial group', () => {
    const a = module('a', 'src/a.java', ['b']);
    const b = module('b', 'src/b.java', ['a']);
    const source = analysis([a, b], [edge('edge-a-b', 'a', 'b'), edge('edge-b-a', 'b', 'a')]);

    const schedule = scheduleModuleMigration(proposal([a, b]), source);
    expect(schedule.executionGroups).toHaveLength(1);
    expect(schedule.executionGroups[0]).toMatchObject({
      kind: 'scc',
      moduleIds: ['a', 'b'],
      executionMode: 'serial',
      atomic: true,
    });
  });

  it('serializes uncertain internal edges and resource locks', () => {
    const a = module('a', 'src/a.java');
    const b = module('b', 'src/b.java');
    a.resourceLocks = ['project:target'];
    b.resourceLocks = ['project:target'];
    const uncertain = edge('edge-a-b', 'a', 'b', {
      resolution: 'ambiguous',
      evidence: 'ambiguous',
    });

    const schedule = scheduleModuleMigration(proposal([a, b]), analysis([a, b], [uncertain]));
    expect(schedule.executionWaves).toHaveLength(2);
    expect(schedule.executionWaves.every((wave) => wave.moduleIds.length === 1)).toBe(true);
    expect(schedule.executionWaves[0]?.parallelismBlockedBy).toEqual(
      expect.arrayContaining([
        'resource-lock-overlap:project:target',
        'uncertain-internal-dependency:edge-a-b',
      ]),
    );
    expect(schedule.executionWaves[1]?.dependsOnWaveIds).toEqual(['wave:001']);
  });

  it('serializes every executable group when an uncertain internal edge has no module endpoints', () => {
    const a = module('a', 'src/a.java');
    const b = module('b', 'src/b.java');
    const c = module('c', 'src/c.java');
    const noMappedEndpoints = [
      edge('edge-ambiguous-unmapped', 'outside-ambiguous', undefined, {
        sourceSymbolId: undefined,
        sourcePath: 'src/outside-ambiguous.java',
        targetPath: 'src/missing-ambiguous.java',
        resolution: 'ambiguous',
        evidence: 'ambiguous',
      }),
      edge('edge-unresolved-unmapped', 'outside-unresolved', undefined, {
        sourceSymbolId: undefined,
        sourcePath: 'src/outside-unresolved.java',
        targetPath: 'src/missing-unresolved.java',
        resolution: 'unresolved',
        evidence: 'unresolved',
      }),
    ];

    const schedule = scheduleModuleMigration(
      proposal([a, b, c]),
      analysis([a, b, c], noMappedEndpoints),
    );

    expect(schedule.executionWaves.map((wave) => wave.moduleIds)).toEqual([['a'], ['b'], ['c']]);
    expect(schedule.executionWaves[0]?.parallelismBlockedBy).toEqual(
      expect.arrayContaining([
        'uncertain-internal-dependency:edge-ambiguous-unmapped',
        'uncertain-internal-dependency:edge-unresolved-unmapped',
      ]),
    );
    expect(schedule.executionWaves[1]?.parallelismBlockedBy).toEqual(
      expect.arrayContaining([
        'uncertain-internal-dependency:edge-ambiguous-unmapped',
        'uncertain-internal-dependency:edge-unresolved-unmapped',
      ]),
    );
  });

  it('uses a canonical SHA-256 plan hash and makes the latest plan review authoritative', () => {
    const dependent = module('a', 'src/a.java', ['b']);
    const prerequisite = module('b', 'src/b.java');
    const source = analysis([dependent, prerequisite], [edge('edge-a-b', 'a', 'b')]);
    const first = buildModuleMigrationPlan(source, proposal([dependent, prerequisite]), { now: NOW });
    const second = buildModuleMigrationPlan(source, proposal([prerequisite, dependent]), { now: `${NOW}1` });
    expect(first.planHash).toBe(second.planHash);
    expect(first.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const approved = recordModulePlanDecision(first, {
      id: 'plan-approval',
      kind: 'plan-approval',
      status: 'approved',
      snapshotId: SNAPSHOT,
      planHash: first.planHash,
      actor: 'reviewer',
      decidedAt: NOW,
    }, SNAPSHOT, NOW);
    expect(arePlanApprovalsCurrent(approved)).toBe(true);
    expect(materializeModuleSummary(approved).human.approvalsCurrent).toBe(true);

    const rejected = recordModulePlanDecision(approved, {
      id: 'plan-rejection',
      kind: 'plan-approval',
      status: 'rejected',
      snapshotId: SNAPSHOT,
      planHash: first.planHash,
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:01.000Z',
    }, SNAPSHOT, NOW);
    expect(rejected.status).toBe('validated');
    expect(arePlanApprovalsCurrent(rejected)).toBe(false);
    expect(materializeModuleSummary(rejected).human.approvalsCurrent).toBe(false);
    expect(createMigrationRunManifest(rejected, 'run-rejected', NOW).status).toBe('planned');

    const stale = invalidatePlanForSnapshot(approved, 'snapshot-2', NOW);
    expect(stale.status).toBe('invalidated');
    expect(arePlanApprovalsCurrent(stale, 'snapshot-2')).toBe(false);

    const staleDecision = {
      id: 'stale-plan-decision',
      kind: 'plan-approval' as const,
      status: 'approved' as const,
      snapshotId: 'snapshot-old',
      planHash: 'sha256:old-plan',
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:02.000Z',
    };
    const withLaterStaleDecision = {
      ...approved,
      decisions: [...approved.decisions, staleDecision],
    };
    expect(arePlanApprovalsCurrent(withLaterStaleDecision)).toBe(false);
    expect(materializeModuleSummary(withLaterStaleDecision).human.approvalsCurrent).toBe(false);

    const wrongPlanDecision = recordModulePlanDecision(approved, {
      ...staleDecision,
      id: 'rejected-for-other-plan',
      status: 'rejected' as const,
    }, SNAPSHOT, NOW);
    expect(wrongPlanDecision.status).toBe('invalidated');
    expect(arePlanApprovalsCurrent(wrongPlanDecision)).toBe(false);
    expect(createMigrationRunManifest(wrongPlanDecision, 'run-invalidated', NOW).status).toBe('planned');

    const scheduleTampered = {
      ...first,
      executionWaves: [],
    };
    expect(validateModuleMigrationProposal(scheduleTampered, source).valid).toBe(true);
    expect(validateModuleMigrationPlan(scheduleTampered, source).issues.map((issue) => issue.code))
      .toContain('plan-hash-mismatch');

    const scheduleRehashed = {
      ...scheduleTampered,
      planHash: calculateModuleMigrationPlanHash(scheduleTampered),
    };
    expect(validateModuleMigrationPlan(scheduleRehashed, source).issues.map((issue) => issue.code))
      .toContain('execution-schedule-mismatch');
  });

  it('rejects a rehashed schedule that omits module coverage from groups and waves', () => {
    const a = module('a', 'src/a.java');
    const b = module('b', 'src/b.java');
    const source = analysis([a, b]);
    const plan = buildModuleMigrationPlan(source, proposal([a, b]), { now: NOW });
    const firstGroup = plan.executionGroups[0];
    const firstWave = plan.executionWaves[0];
    if (!firstGroup || !firstWave) throw new Error('Expected a populated execution schedule.');

    const missingCoverage = {
      ...plan,
      executionGroups: [firstGroup],
      executionWaves: [{
        ...firstWave,
        groupIds: [firstGroup.id],
        moduleIds: [...firstGroup.moduleIds],
      }],
    };
    const rehashed = {
      ...missingCoverage,
      planHash: calculateModuleMigrationPlanHash(missingCoverage),
    };
    const codes = validateModuleMigrationPlan(rehashed, source).issues.map((issue) => issue.code);

    expect(codes).toContain('execution-group-module-coverage');
    expect(codes).toContain('execution-wave-module-coverage');
  });

  it('derives distinct default IDs for distinct valid plans sharing a snapshot and objective', () => {
    const service = module('service', 'src/service.java');
    const source = analysis([service]);
    const firstProposal = proposal([service]);
    const secondProposal: ModuleMigrationProposal = {
      ...firstProposal,
      modules: firstProposal.modules.map((item) => ({
        ...item,
        description: 'A materially different module boundary rationale.',
      })),
    };

    const first = buildModuleMigrationPlan(source, firstProposal, { now: NOW });
    const second = buildModuleMigrationPlan(source, secondProposal, { now: NOW });

    expect(first.snapshotId).toBe(second.snapshotId);
    expect(first.objective).toBe(second.objective);
    expect(first.planHash).not.toBe(second.planHash);
    expect(first.id).toBe(`module-plan:${first.planHash}`);
    expect(second.id).toBe(`module-plan:${second.planHash}`);
    expect(first.id).not.toBe(second.id);
  });

  it('uses the latest risk decision for each accepted risk', () => {
    const service = module('service', 'src/service.java');
    const source = analysis([service]);
    const plan = buildModuleMigrationPlan(source, proposal([service]), { now: NOW });
    const accepted = recordModulePlanDecision(plan, {
      id: 'risk-accepted',
      kind: 'risk-acceptance',
      status: 'accepted',
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      actor: 'reviewer',
      decidedAt: NOW,
      riskIds: ['risk:external-api'],
    }, SNAPSHOT, NOW);
    const rejected = recordModulePlanDecision(accepted, {
      id: 'risk-rejected',
      kind: 'risk-acceptance',
      status: 'rejected',
      snapshotId: accepted.snapshotId,
      planHash: accepted.planHash,
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:01.000Z',
      riskIds: ['risk:external-api'],
    }, SNAPSHOT, NOW);

    expect(materializeModuleSummary(accepted).human.acceptedRisks).toEqual(['risk:external-api']);
    expect(materializeModuleSummary(rejected).human.acceptedRisks).toEqual([]);
  });

  it('enforces wave and durable transaction lifecycle transitions', () => {
    const dependent = module('dependent', 'src/dependent.java', ['prerequisite']);
    const prerequisite = module('prerequisite', 'src/prerequisite.java');
    const source = analysis([dependent, prerequisite], [edge('dependent-prerequisite', 'dependent', 'prerequisite')]);
    const plan = buildModuleMigrationPlan(source, proposal([dependent, prerequisite]), { now: NOW });
    const approvedPlan = recordModulePlanDecision(plan, {
      id: 'ordered-plan-approval',
      kind: 'plan-approval',
      status: 'approved',
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      actor: 'reviewer',
      decidedAt: NOW,
    }, SNAPSHOT, NOW);
    const [firstWave, secondWave] = approvedPlan.executionWaves;
    if (!firstWave || !secondWave) throw new Error('Expected an ordered two-wave plan.');

    expect(canTransitionExecutionWaveStatus('pending', 'approved')).toBe(false);
    expect(() => transitionModulePlanWaveStatus(approvedPlan, secondWave.id, 'prepared', NOW))
      .toThrow(`before prerequisites commit: ${firstWave.id}`);

    const preparing = transitionModulePlanWaveStatus(approvedPlan, firstWave.id, 'prepared', NOW);
    const awaitingApproval = transitionModulePlanWaveStatus(preparing, firstWave.id, 'awaiting-approval', NOW);
    const approved = transitionModulePlanWaveStatus(awaitingApproval, firstWave.id, 'approved', NOW);
    const committing = transitionModulePlanWaveStatus(approved, firstWave.id, 'committing', NOW);
    const committed = transitionModulePlanWaveStatus(committing, firstWave.id, 'committed', NOW);
    expect(committed.executionWaves[0]?.status).toBe('committed');
    expect(() => transitionModulePlanWaveStatus(committed, firstWave.id, 'rolled-back', NOW))
      .toThrow('cannot transition from committed to rolled-back');
    expect(transitionModulePlanWaveStatus(committed, secondWave.id, 'prepared', NOW).executionWaves[1]?.status)
      .toBe('prepared');

    const transaction: WaveTransaction = {
      id: 'transaction:wave:001',
      runId: 'run-1',
      waveId: firstWave.id,
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      branchName: 'codex/forexplore-migration/run-1',
      preparedHash: 'sha256:prepared',
      status: 'prepared',
      baseCommit: '0123456789012345678901234567890123456789',
      baselineFileHashes: {},
      preparedAt: NOW,
    };
    expect(canTransitionWaveTransactionStatus('prepared', 'committed')).toBe(false);
    expect(() => transitionWaveTransactionStatus(transaction, 'committed'))
      .toThrow('cannot transition from prepared to committed');
    const committingTransaction = transitionWaveTransactionStatus(transaction, 'committing');
    expect(() => transitionWaveTransactionStatus(committingTransaction, 'committed'))
      .toThrow('requires completion evidence');
    const committedTransaction = transitionWaveTransactionStatus(committingTransaction, 'committed', NOW);
    expect(committedTransaction.status).toBe('committed');
    expect(() => transitionWaveTransactionStatus(committedTransaction, 'rolled-back'))
      .toThrow('cannot transition from committed to rolled-back');
  });

  it('requires plan approval and a prepared review state before wave approval', () => {
    const service = module('service', 'src/service.java');
    const source = analysis([service]);
    const plan = buildModuleMigrationPlan(source, proposal([service]), { now: NOW });
    const waveId = plan.executionWaves[0]!.id;
    const waveDecision = {
      id: 'premature-wave-approval',
      kind: 'wave-approval' as const,
      status: 'approved' as const,
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      waveId,
      preparedHash: 'prepared-a',
      actor: 'reviewer',
      decidedAt: NOW,
    };

    expect(() => recordModulePlanDecision(plan, waveDecision, SNAPSHOT, NOW))
      .toThrow('current plan approval is required');

    const approvedPlan = recordModulePlanDecision(plan, {
      id: 'plan-approval',
      kind: 'plan-approval',
      status: 'approved',
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      actor: 'reviewer',
      decidedAt: NOW,
    }, SNAPSHOT, NOW);
    expect(() => recordModulePlanDecision(approvedPlan, waveDecision, SNAPSHOT, NOW))
      .toThrow('cannot transition from pending to approved');
  });

  it('makes the latest wave review authoritative for its prepared bundle', () => {
    const service = module('service', 'src/service.java');
    const source = analysis([service]);
    const plan = buildModuleMigrationPlan(source, proposal([service]), { now: NOW });
    const planApproved = recordModulePlanDecision(plan, {
      id: 'plan-approval',
      kind: 'plan-approval',
      status: 'approved',
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      actor: 'reviewer',
      decidedAt: NOW,
    }, SNAPSHOT, NOW);
    const waveId = planApproved.executionWaves[0]!.id;
    const preparedForReview = transitionModulePlanWaveStatus(
      transitionModulePlanWaveStatus(planApproved, waveId, 'prepared', NOW),
      waveId,
      'awaiting-approval',
      NOW,
    );
    const approvedBundle = recordModulePlanDecision(preparedForReview, {
      id: 'wave-approval-a',
      kind: 'wave-approval',
      status: 'approved',
      snapshotId: planApproved.snapshotId,
      planHash: planApproved.planHash,
      waveId,
      preparedHash: 'prepared-a',
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:01.000Z',
    }, SNAPSHOT, NOW);
    expect(areWaveApprovalsCurrent(approvedBundle, waveId, 'prepared-a')).toBe(true);
    expect(approvedBundle.executionWaves[0]?.status).toBe('approved');

    const rejectedBundle = recordModulePlanDecision(approvedBundle, {
      id: 'wave-rejection-a',
      kind: 'wave-approval',
      status: 'rejected',
      snapshotId: approvedBundle.snapshotId,
      planHash: approvedBundle.planHash,
      waveId,
      preparedHash: 'prepared-a',
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:02.000Z',
    }, SNAPSHOT, NOW);
    expect(areWaveApprovalsCurrent(rejectedBundle, waveId, 'prepared-a')).toBe(false);
    expect(rejectedBundle.executionWaves[0]?.status).toBe('awaiting-approval');

    const replacementBundle = recordModulePlanDecision(rejectedBundle, {
      id: 'wave-approval-b',
      kind: 'wave-approval',
      status: 'approved',
      snapshotId: rejectedBundle.snapshotId,
      planHash: rejectedBundle.planHash,
      waveId,
      preparedHash: 'prepared-b',
      actor: 'reviewer',
      decidedAt: '2026-08-26T00:00:03.000Z',
    }, SNAPSHOT, NOW);
    expect(areWaveApprovalsCurrent(replacementBundle, waveId, 'prepared-a')).toBe(false);
    expect(areWaveApprovalsCurrent(replacementBundle, waveId, 'prepared-b')).toBe(true);

    const withLaterStaleDecision = {
      ...replacementBundle,
      decisions: [...replacementBundle.decisions, {
        id: 'wave-stale',
        kind: 'wave-approval' as const,
        status: 'approved' as const,
        snapshotId: 'snapshot-old',
        planHash: 'sha256:old-plan',
        waveId,
        preparedHash: 'prepared-b',
        actor: 'reviewer',
        decidedAt: '2026-08-26T00:00:04.000Z',
      }],
    };
    expect(areWaveApprovalsCurrent(withLaterStaleDecision, waveId, 'prepared-b')).toBe(false);
  });

  it('uses the read-only architecture port and does not accept a browser-created schedule', async () => {
    const a = module('a', 'src/a.java');
    const source = analysis([a]);
    const proposeModulePlan = async (request: { analysis: RepositoryStaticAnalysis }) => {
      expect(request.analysis).toBe(source);
      return proposal([a]);
    };
    const workflow = new ModuleMigrationWorkflow({ proposeModulePlan }, {
      // This fixture intentionally uses synthetic, non-content-addressed
      // evidence; production hosts inject the code-indexer verifier instead.
      allowUnverifiedAnalysis: true,
    });

    const plan = await workflow.createPlan({ analysis: source, objective: 'Migrate a', now: NOW });
    expect(plan.executionWaves).toHaveLength(1);
    expect(plan.executionWaves[0]?.requiresApproval).toBe(true);
  });

  it('requires an explicit static-analysis verifier for direct planning callers', async () => {
    const a = module('a', 'src/a.java');
    const source = analysis([a]);
    const proposeModulePlan = vi.fn(async () => proposal([a]));
    const workflow = new ModuleMigrationWorkflow({ proposeModulePlan });

    await expect(workflow.createPlan({
      analysis: source,
      objective: 'Migrate a',
      now: NOW,
    })).rejects.toThrow('static-analysis verifier is required');
    expect(proposeModulePlan).not.toHaveBeenCalled();
  });

  it('passes only verifier-approved evidence to the architecture port', async () => {
    const a = module('a', 'src/a.java');
    const source = analysis([a]);
    const verified = { ...source, repository: { ...source.repository, remote: 'trusted://origin' } };
    const verifyAnalysis = vi.fn(() => verified);
    const proposeModulePlan = vi.fn(async (request: { analysis: RepositoryStaticAnalysis }) => {
      expect(request.analysis).toBe(verified);
      return proposal([a]);
    });
    const workflow = new ModuleMigrationWorkflow(
      { proposeModulePlan },
      { analysisVerifier: verifyAnalysis },
    );

    const plan = await workflow.createPlan({
      analysis: source,
      objective: 'Migrate a',
      now: NOW,
    });

    expect(verifyAnalysis).toHaveBeenCalledWith(source);
    expect(plan.snapshotId).toBe(source.snapshotId);
  });

  it('rejects a verifier result whose immutable identity changes', async () => {
    const a = module('a', 'src/a.java');
    const source = analysis([a]);
    const proposeModulePlan = vi.fn(async () => proposal([a]));
    const workflow = new ModuleMigrationWorkflow(
      { proposeModulePlan },
      {
        analysisVerifier: () => ({
          ...source,
          snapshotId: 'different-snapshot',
        }),
      },
    );

    await expect(workflow.createPlan({
      analysis: source,
      objective: 'Migrate a',
      now: NOW,
    })).rejects.toThrow('different snapshot identity');
    expect(proposeModulePlan).not.toHaveBeenCalled();
  });
});
