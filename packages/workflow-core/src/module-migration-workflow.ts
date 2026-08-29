import type {
  ModuleMigrationPlan,
  ModuleMigrationProposal,
  PlanDecision,
  RepositoryArchitectureRequest,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { moduleMigrationSchemaVersion } from '@forexplore/contracts';
import type { RepositoryArchitecturePort } from './ports/repository-architecture.port';
import {
  calculateModuleMigrationPlanHash,
  canonicalJson,
  sortedUnique,
} from './module-plan-utils';
import {
  ModulePlanValidationError,
  scheduleModuleMigration,
  type ModuleScheduleOptions,
} from './module-scheduler';
import {
  validateModuleMigrationPlan,
  validateModuleMigrationProposal,
  type ModulePlanValidationResult,
} from './module-plan-validator';
import {
  arePlanApprovalsCurrent,
  comparePlanDecisionOrder,
  invalidatePlanForSnapshot,
  latestWaveApprovalDecision,
} from './module-summary';
import { transitionModulePlanWaveStatus } from './module-wave-lifecycle';

export interface BuildModuleMigrationPlanOptions extends ModuleScheduleOptions {
  id?: string;
  now?: string;
}

/**
 * Host-owned verification boundary for static-analysis snapshots.
 *
 * workflow-core deliberately does not depend on a concrete analyser package
 * (or its hashing implementation). A service/extension must inject the
 * verifier that understands how snapshots were persisted before a model is
 * allowed to see one. The verifier may return a frozen/normalized copy, but
 * it must preserve the snapshot identity supplied by the caller.
 */
export type RepositoryStaticAnalysisVerifier = (
  analysis: RepositoryStaticAnalysis,
) => RepositoryStaticAnalysis;

export interface ModuleMigrationWorkflowOptions {
  /** Verify immutable evidence before passing it to the architecture port. */
  analysisVerifier?: RepositoryStaticAnalysisVerifier;
  /**
   * Explicit escape hatch for synthetic/unit callers that do not have a
   * persisted snapshot. Production hosts should inject `analysisVerifier`
   * instead; leaving both options unset is rejected.
   */
  allowUnverifiedAnalysis?: boolean;
}

export interface CreateModuleMigrationPlanRequest extends BuildModuleMigrationPlanOptions {
  analysis: RepositoryStaticAnalysis;
  objective: string;
  immutableConstraints?: string[];
}

function normalizeModules(
  proposal: ModuleMigrationProposal,
  dependencies: ModuleMigrationPlan['dependencies'],
): ModuleMigrationPlan['modules'] {
  return proposal.modules
    .map((module) => ({
      ...module,
      sourceFiles: sortedUnique(module.sourceFiles),
      testFiles: sortedUnique(module.testFiles ?? []),
      generatedFiles: sortedUnique(module.generatedFiles ?? []),
      symbolIds: sortedUnique(module.symbolIds),
      dependsOn: sortedUnique([
        ...module.dependsOn,
        ...(dependencies ?? [])
          .filter((dependency) => dependency.moduleId === module.id)
          .map((dependency) => dependency.dependsOnModuleId),
      ]),
      writeSet: sortedUnique(module.writeSet),
      resourceLocks: sortedUnique(module.resourceLocks),
      evidenceIds: sortedUnique(module.evidenceIds),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Creates a reviewable plan only after deterministic validation has accepted
 * the architect proposal.  Model output cannot supply an execution schedule.
 */
export function buildModuleMigrationPlan(
  analysis: RepositoryStaticAnalysis,
  proposal: ModuleMigrationProposal,
  options: BuildModuleMigrationPlanOptions = {},
): ModuleMigrationPlan {
  const validation = validateModuleMigrationProposal(proposal, analysis);
  if (!validation.valid) throw new ModulePlanValidationError(validation);
  const schedule = scheduleModuleMigration(proposal, analysis, options);
  const now = options.now ?? new Date().toISOString();
  const dependencies = schedule.dependencies;
  const planInput: Omit<ModuleMigrationPlan, 'id' | 'planHash'> = {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: analysis.snapshotId,
    analysisHash: analysis.contentHash,
    objective: proposal.objective,
    modules: normalizeModules(proposal, dependencies),
    fileAssignments: [...proposal.fileAssignments].sort(
      (left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
    ),
    dependencies,
    risks: sortedUnique(proposal.risks ?? []),
    status: 'validated',
    executionGroups: schedule.executionGroups,
    executionWaves: schedule.executionWaves,
    decisions: [],
    createdAt: now,
    updatedAt: now,
  };
  // A default ID must identify the complete deterministic plan, not merely
  // the snapshot and objective. The plan hash intentionally excludes its ID,
  // so it is a stable collision-resistant identity for this purpose.
  const planHash = calculateModuleMigrationPlanHash(planInput);
  const plan: ModuleMigrationPlan = {
    ...planInput,
    id: options.id ?? `module-plan:${planHash}`,
    planHash,
  };
  const finalValidation = validateModuleMigrationPlan(plan, analysis);
  if (!finalValidation.valid) throw new ModulePlanValidationError(finalValidation);
  return plan;
}

function assertDecisionStatus(decision: PlanDecision): void {
  switch (decision.kind) {
    case 'plan-approval':
    case 'wave-approval':
      if (decision.status !== 'approved' && decision.status !== 'rejected') {
        throw new Error(`${decision.kind} decisions must be approved or rejected.`);
      }
      return;
    case 'risk-acceptance':
      if (decision.status !== 'accepted' && decision.status !== 'rejected') {
        throw new Error('risk-acceptance decisions must be accepted or rejected.');
      }
      return;
    case 'note':
      if (decision.status !== 'recorded') {
        throw new Error('note decisions must use recorded status.');
      }
      return;
    default:
      throw new Error('Unsupported plan decision kind.');
  }
}

/** Add a review decision while rejecting stale approvals rather than reusing them. */
export function recordModulePlanDecision(
  plan: ModuleMigrationPlan,
  decision: PlanDecision,
  currentSnapshotId = plan.snapshotId,
  updatedAt = new Date().toISOString(),
): ModuleMigrationPlan {
  if (plan.planHash !== calculateModuleMigrationPlanHash(plan)) {
    throw new Error('Cannot record a human decision for a plan with an invalid hash.');
  }
  assertDecisionStatus(decision);
  if (currentSnapshotId !== plan.snapshotId || decision.snapshotId !== plan.snapshotId || decision.planHash !== plan.planHash) {
    // A decision for another snapshot or plan is not evidence for this plan.
    // Mark this plan unusable even when the snapshot happens to match but the
    // plan hash does not; `invalidatePlanForSnapshot` alone cannot detect the
    // latter case.
    return {
      ...invalidatePlanForSnapshot(plan, currentSnapshotId, updatedAt),
      status: 'invalidated',
      updatedAt,
    };
  }
  if (decision.kind === 'wave-approval' && !arePlanApprovalsCurrent(plan, currentSnapshotId)) {
    throw new Error('A current plan approval is required before reviewing an execution wave.');
  }
  const reviewedWave = decision.kind === 'wave-approval'
    ? plan.executionWaves.find((wave) => wave.id === decision.waveId)
    : undefined;
  if (decision.kind === 'wave-approval') {
    if (reviewedWave === undefined) {
      throw new Error(`Unknown execution wave: ${decision.waveId ?? '(missing)'}`);
    }
    if (!decision.preparedHash?.trim()) {
      throw new Error('Wave approval must bind to a prepared patch and validation bundle hash.');
    }
    if (reviewedWave.status === 'approved') {
      const previous = latestWaveApprovalDecision(plan.decisions, reviewedWave.id);
      if (previous?.status !== 'approved' || previous.preparedHash !== decision.preparedHash) {
        throw new Error(
          `Execution wave ${reviewedWave.id} is approved for a different prepared bundle; prepare the replacement bundle before reviewing it.`,
        );
      }
    }
  }
  const existing = plan.decisions.find((item) => item.id === decision.id);
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(decision)) {
    throw new Error(`Conflicting human decision id: ${decision.id}`);
  }
  const decisions = [...plan.decisions.filter((item) => item.id !== decision.id), decision]
    .sort(comparePlanDecisionOrder);
  let withDecision: ModuleMigrationPlan = { ...plan, decisions, updatedAt };
  if (decision.kind === 'wave-approval') {
    withDecision = transitionModulePlanWaveStatus(
      withDecision,
      reviewedWave!.id,
      decision.status === 'approved' ? 'approved' : 'awaiting-approval',
      updatedAt,
    );
  }
  const planApproved = arePlanApprovalsCurrent(withDecision, currentSnapshotId);
  return {
    ...withDecision,
    status:
      planApproved && withDecision.status === 'validated'
        ? 'approved'
        : !planApproved && withDecision.status === 'approved'
          ? 'validated'
          : withDecision.status,
  };
}

export class ModuleMigrationWorkflow {
  readonly #architecture: RepositoryArchitecturePort;
  readonly #analysisVerifier?: RepositoryStaticAnalysisVerifier;
  readonly #allowUnverifiedAnalysis: boolean;

  constructor(
    architecture: RepositoryArchitecturePort,
    options: ModuleMigrationWorkflowOptions = {},
  ) {
    this.#architecture = architecture;
    this.#analysisVerifier = options.analysisVerifier;
    this.#allowUnverifiedAnalysis = options.allowUnverifiedAnalysis ?? false;
    if (this.#analysisVerifier !== undefined && this.#allowUnverifiedAnalysis) {
      throw new Error('Choose analysisVerifier or allowUnverifiedAnalysis, not both.');
    }
  }

  async createPlan(
    request: CreateModuleMigrationPlanRequest,
    signal?: AbortSignal,
  ): Promise<ModuleMigrationPlan> {
    const analysis = this.#verifyAnalysis(request.analysis);
    const architectureRequest: RepositoryArchitectureRequest = {
      schemaVersion: moduleMigrationSchemaVersion,
      analysis,
      objective: request.objective,
      immutableConstraints: request.immutableConstraints,
    };
    const proposal = await this.#architecture.proposeModulePlan(architectureRequest, signal);
    return buildModuleMigrationPlan(analysis, proposal, request);
  }

  validate(
    plan: ModuleMigrationPlan,
    analysis: RepositoryStaticAnalysis,
  ): ModulePlanValidationResult {
    return validateModuleMigrationPlan(plan, this.#verifyAnalysis(analysis));
  }

  #verifyAnalysis(analysis: RepositoryStaticAnalysis): RepositoryStaticAnalysis {
    if (this.#analysisVerifier === undefined) {
      if (this.#allowUnverifiedAnalysis) return analysis;
      throw new Error(
        'A repository static-analysis verifier is required before module planning. ' +
        'Inject analysisVerifier for a persisted snapshot or explicitly opt in to allowUnverifiedAnalysis for synthetic tests.',
      );
    }
    const verified = this.#analysisVerifier(analysis);
    if (verified === undefined || verified === null) {
      throw new Error('The repository static-analysis verifier returned no snapshot.');
    }
    if (verified.snapshotId !== analysis.snapshotId) {
      throw new Error('The repository static-analysis verifier returned a different snapshot identity.');
    }
    if (verified.contentHash !== analysis.contentHash) {
      throw new Error('The repository static-analysis verifier returned a different content hash.');
    }
    return verified;
  }
}
