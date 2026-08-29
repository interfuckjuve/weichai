import type {
  ExecutionGroup,
  ExecutionWave,
  FunctionalModule,
  MigrationRunManifest,
  ModuleDependency,
  ModuleMigrationPlan,
  ModuleSummary,
  PlanDecision,
} from '@forexplore/contracts';
import { moduleMigrationSchemaVersion } from '@forexplore/contracts';
import {
  calculateModuleMigrationPlanHash,
  canonicalJson,
  sortedUnique,
} from './module-plan-utils';

export const moduleSummaryPath = '.forexplore/module-summary.json';

export function analysisArtifactPath(snapshotId: string): string {
  return `.forexplore/analysis/${artifactId(snapshotId)}.json`;
}

export function migrationRunArtifactPath(runId: string): string {
  return `.forexplore/runs/${artifactId(runId)}.json`;
}

/**
 * Materializes the repository-owned module view from a deterministic plan.
 * An approval is meaningful only for the exact snapshot and plan hash that it
 * names; a re-index or a scheduling change therefore cannot silently reuse
 * an older human decision.
 */
export function materializeModuleSummary(
  plan: ModuleMigrationPlan,
  previous?: ModuleSummary,
): ModuleSummary {
  const computedPlanHash = calculateModuleMigrationPlanHash(plan);
  if (plan.planHash !== computedPlanHash) {
    throw new Error('Module plan hash does not match its deterministic contents.');
  }

  const sameEvidence =
    previous?.generated.snapshotId === plan.snapshotId &&
    previous.generated.planHash === plan.planHash;
  const decisions = mergeDecisions(
    sameEvidence ? previous?.human.decisions ?? [] : [],
    plan.decisions,
  );
  // Risk acceptance is an authorization record, not free-form summary text.
  // Recompute it from the current decision log so a later rejected or stale
  // decision cannot leave an earlier acceptance displayed as current.
  const acceptedRisks = acceptedRiskIds(decisions, plan.snapshotId, plan.planHash);

  return {
    schemaVersion: moduleMigrationSchemaVersion,
    generated: {
      snapshotId: plan.snapshotId,
      analysisHash: plan.analysisHash,
      planId: plan.id,
      planHash: plan.planHash,
      status: plan.status,
      modules: [...plan.modules].sort(byId).map(copyModule),
      dependencies: canonicalDependencies(plan.dependencies ?? []),
      executionGroups: [...plan.executionGroups].sort(byId).map(copyExecutionGroup),
      executionWaves: [...plan.executionWaves]
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
        .map(copyExecutionWave),
      risks: sortedUnique(plan.risks ?? []),
    },
    human: {
      approvalsCurrent: arePlanApprovalsCurrent(
        {
          snapshotId: plan.snapshotId,
          planHash: plan.planHash,
          status: plan.status,
          decisions,
        },
        plan.snapshotId,
      ),
      decisions,
      // Notes are context, not authorization, so retaining them across a
      // re-index is safe while approvals and risk acceptance are re-evaluated.
      notes: sortedUnique(previous?.human.notes ?? []),
      acceptedRisks,
    },
  };
}

/** A plan-level approval is usable only for the exact snapshot and plan hash. */
export function serializeModuleSummary(summary: ModuleSummary): string {
  return `${canonicalJson(summary)}\n`;
}

export function createMigrationRunManifest(
  plan: ModuleMigrationPlan,
  runId: string,
  createdAt: string,
): MigrationRunManifest {
  if (!runId.trim()) throw new Error('Migration run id is required.');
  if (plan.planHash !== calculateModuleMigrationPlanHash(plan)) {
    throw new Error('Cannot create a run manifest for a plan with an invalid hash.');
  }
  return {
    schemaVersion: moduleMigrationSchemaVersion,
    id: runId,
    snapshotId: plan.snapshotId,
    analysisHash: plan.analysisHash,
    planId: plan.id,
    planHash: plan.planHash,
    status: plan.status === 'approved' && arePlanApprovalsCurrent(plan) ? 'approved' : 'planned',
    createdAt,
    updatedAt: createdAt,
    decisions: mergeDecisions([], plan.decisions),
    validation: [],
    transactions: [],
    artifactPaths: {
      analysis: analysisArtifactPath(plan.snapshotId),
      summary: moduleSummaryPath,
      manifest: migrationRunArtifactPath(runId),
    },
  };
}

/** Deterministic decision chronology. The lexicographically later ID breaks timestamp ties. */
export function comparePlanDecisionOrder(left: PlanDecision, right: PlanDecision): number {
  return left.decidedAt.localeCompare(right.decidedAt) || left.id.localeCompare(right.id);
}

/** Latest plan-review decision, including one bound to stale evidence. */
export function latestPlanApprovalDecision(
  decisions: readonly PlanDecision[],
): PlanDecision | undefined {
  return latestDecision(
    decisions,
    (decision) => decision.kind === 'plan-approval',
  );
}

/** Latest review decision for one wave, including a decision for another prepared bundle. */
export function latestWaveApprovalDecision(
  decisions: readonly PlanDecision[],
  waveId: string,
): PlanDecision | undefined {
  return latestDecision(
    decisions,
    (decision) => decision.kind === 'wave-approval' && decision.waveId === waveId,
  );
}

/** True only when the latest plan-review decision approves the exact immutable plan. */
export function arePlanApprovalsCurrent(
  plan: Pick<ModuleMigrationPlan, 'snapshotId' | 'planHash' | 'decisions'> &
    Partial<Pick<ModuleMigrationPlan, 'status'>>,
  currentSnapshotId = plan.snapshotId,
): boolean {
  const decision = latestPlanApprovalDecision(plan.decisions);
  return plan.status !== 'invalidated' &&
    currentSnapshotId === plan.snapshotId &&
    decision?.status === 'approved' &&
    decision.snapshotId === plan.snapshotId &&
    decision.planHash === plan.planHash;
}

/**
 * True only when the latest decision for a wave approves the exact prepared
 * patch and validation bundle. A later rejection or a decision for stale
 * evidence deliberately supersedes an earlier approval.
 */
export function areWaveApprovalsCurrent(
  plan: Pick<ModuleMigrationPlan, 'snapshotId' | 'planHash' | 'decisions'> &
    Partial<Pick<ModuleMigrationPlan, 'status'>>,
  waveId: string,
  preparedHash: string,
  currentSnapshotId = plan.snapshotId,
): boolean {
  const decision = latestWaveApprovalDecision(plan.decisions, waveId);
  return plan.status !== 'invalidated' &&
    currentSnapshotId === plan.snapshotId &&
    preparedHash.trim().length > 0 &&
    decision?.status === 'approved' &&
    decision.snapshotId === plan.snapshotId &&
    decision.planHash === plan.planHash &&
    decision.preparedHash === preparedHash;
}

/**
 * Marks a stale plan without mutating its hash-bound contents or replaying a
 * previous approval against a new static-analysis snapshot.
 */
export function invalidatePlanForSnapshot(
  plan: ModuleMigrationPlan,
  currentSnapshotId: string,
  updatedAt = new Date().toISOString(),
): ModuleMigrationPlan {
  if (currentSnapshotId === plan.snapshotId) return plan;
  return { ...plan, status: 'invalidated', updatedAt };
}

function artifactId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)) {
    throw new Error('Artifact identifiers must contain only letters, digits, dots, underscores, and hyphens.');
  }
  return value;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function copyModule(module: FunctionalModule): FunctionalModule {
  return {
    ...module,
    sourceFiles: sortedUnique(module.sourceFiles),
    testFiles: module.testFiles === undefined ? undefined : sortedUnique(module.testFiles),
    generatedFiles: module.generatedFiles === undefined ? undefined : sortedUnique(module.generatedFiles),
    symbolIds: sortedUnique(module.symbolIds),
    dependsOn: sortedUnique(module.dependsOn),
    writeSet: sortedUnique(module.writeSet),
    resourceLocks: sortedUnique(module.resourceLocks),
    evidenceIds: sortedUnique(module.evidenceIds),
  };
}

function canonicalDependencies(dependencies: readonly ModuleDependency[]): ModuleDependency[] {
  return [...dependencies]
    .map((dependency) => ({ ...dependency, evidenceEdgeIds: sortedUnique(dependency.evidenceEdgeIds) }))
    .sort(
      (left, right) =>
        left.moduleId.localeCompare(right.moduleId) ||
        left.dependsOnModuleId.localeCompare(right.dependsOnModuleId) ||
        left.source.localeCompare(right.source),
    );
}

function copyExecutionGroup(group: ExecutionGroup): ExecutionGroup {
  return {
    ...group,
    moduleIds: sortedUnique(group.moduleIds),
    dependsOnGroupIds: sortedUnique(group.dependsOnGroupIds),
    writeSet: sortedUnique(group.writeSet),
    resourceLocks: sortedUnique(group.resourceLocks),
    reasons: sortedUnique(group.reasons),
  };
}

function copyExecutionWave(wave: ExecutionWave): ExecutionWave {
  return {
    ...wave,
    groupIds: sortedUnique(wave.groupIds),
    moduleIds: sortedUnique(wave.moduleIds),
    dependsOnWaveIds: sortedUnique(wave.dependsOnWaveIds),
    parallelismBlockedBy: sortedUnique(wave.parallelismBlockedBy),
  };
}

function mergeDecisions(
  previous: readonly PlanDecision[],
  incoming: readonly PlanDecision[],
): PlanDecision[] {
  const byId = new Map<string, PlanDecision>();
  for (const decision of [...previous, ...incoming]) {
    const existing = byId.get(decision.id);
    if (existing && canonicalJson(existing) !== canonicalJson(decision)) {
      throw new Error(`Conflicting human decision id: ${decision.id}`);
    }
    byId.set(decision.id, {
      ...decision,
      riskIds: decision.riskIds === undefined ? undefined : sortedUnique(decision.riskIds),
    });
  }
  return [...byId.values()].sort(comparePlanDecisionOrder);
}

function latestDecision(
  decisions: readonly PlanDecision[],
  matches: (decision: PlanDecision) => boolean,
): PlanDecision | undefined {
  let latest: PlanDecision | undefined;
  for (const decision of decisions) {
    if (matches(decision) && (latest === undefined || comparePlanDecisionOrder(latest, decision) < 0)) {
      latest = decision;
    }
  }
  return latest;
}

function acceptedRiskIds(
  decisions: readonly PlanDecision[],
  snapshotId: string,
  planHash: string,
): string[] {
  const accepted = new Set<string>();
  for (const decision of [...decisions].sort(comparePlanDecisionOrder)) {
    if (
      decision.kind !== 'risk-acceptance' ||
      decision.snapshotId !== snapshotId ||
      decision.planHash !== planHash
    ) {
      continue;
    }
    for (const riskId of sortedUnique(decision.riskIds ?? [])) {
      if (decision.status === 'accepted') accepted.add(riskId);
      if (decision.status === 'rejected') accepted.delete(riskId);
    }
  }
  return sortedUnique([...accepted]);
}
