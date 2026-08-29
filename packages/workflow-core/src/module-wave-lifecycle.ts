import type {
  ExecutionWave,
  ExecutionWaveStatus,
  ModuleMigrationPlan,
  WaveTransaction,
  WaveTransactionStatus,
} from '@forexplore/contracts';
import { arePlanApprovalsCurrent } from './module-summary';

const executionWaveTransitions: Readonly<Record<ExecutionWaveStatus, readonly ExecutionWaveStatus[]>> = {
  pending: ['prepared', 'failed'],
  prepared: ['awaiting-approval', 'failed', 'rolled-back'],
  'awaiting-approval': ['approved', 'failed', 'rolled-back'],
  approved: ['awaiting-approval', 'committing', 'failed', 'rolled-back'],
  committing: ['committed', 'failed', 'rolled-back'],
  committed: [],
  failed: ['rolled-back'],
  'rolled-back': ['pending'],
};

const waveTransactionTransitions: Readonly<Record<WaveTransactionStatus, readonly WaveTransactionStatus[]>> = {
  prepared: ['committing', 'rolled-back'],
  committing: ['committed', 'rolled-back'],
  committed: [],
  'rolled-back': [],
};

const statusesRequiringCommittedPrerequisites = new Set<ExecutionWaveStatus>([
  'prepared',
  'awaiting-approval',
  'approved',
  'committing',
  'committed',
]);

/**
 * Reports whether a wave status can advance without violating the immutable
 * execution lifecycle. Repeating a status is permitted for idempotent
 * recovery, but terminal states never reopen.
 */
export function canTransitionExecutionWaveStatus(
  current: ExecutionWaveStatus,
  next: ExecutionWaveStatus,
): boolean {
  const allowed = executionWaveTransitions[current];
  return allowed !== undefined && (current === next || allowed.includes(next));
}

/**
 * Returns an immutable wave with a validated lifecycle status. This helper
 * deliberately owns no transaction or approval evidence; callers must verify
 * that separately before requesting an approval or commit transition.
 */
export function transitionExecutionWaveStatus(
  wave: ExecutionWave,
  nextStatus: ExecutionWaveStatus,
): ExecutionWave {
  if (!canTransitionExecutionWaveStatus(wave.status, nextStatus)) {
    throw new Error(`Execution wave ${wave.id} cannot transition from ${wave.status} to ${nextStatus}.`);
  }
  return { ...wave, status: nextStatus };
}

/**
 * Applies one verified wave transition to a plan without mutating it. A wave
 * may not enter preparation or any later active state until every scheduled
 * prerequisite wave is committed. Plan-level state remains host-owned because
 * a run manifest determines whether a failure or rollback covers the run.
 */
export function transitionModulePlanWaveStatus(
  plan: ModuleMigrationPlan,
  waveId: string,
  nextStatus: ExecutionWaveStatus,
  updatedAt = plan.updatedAt,
): ModuleMigrationPlan {
  if (plan.status === 'invalidated') {
    throw new Error('Cannot transition an execution wave for an invalidated module plan.');
  }
  if (plan.status === 'completed') {
    throw new Error('Cannot transition an execution wave for a completed module plan.');
  }

  const wave = plan.executionWaves.find((item) => item.id === waveId);
  if (!wave) throw new Error(`Unknown execution wave: ${waveId}`);

  if (statusesRequiringCommittedPrerequisites.has(nextStatus)) {
    if (!arePlanApprovalsCurrent(plan) || (plan.status !== 'approved' && plan.status !== 'executing')) {
      throw new Error('A current approved module plan is required before executing a wave transition.');
    }
    const wavesById = new Map(plan.executionWaves.map((item) => [item.id, item]));
    const incomplete = wave.dependsOnWaveIds.filter(
      (dependencyId) => wavesById.get(dependencyId)?.status !== 'committed',
    );
    if (incomplete.length > 0) {
      throw new Error(
        `Execution wave ${wave.id} cannot transition to ${nextStatus} before prerequisites commit: ${incomplete.join(', ')}.`,
      );
    }
  }

  const transitioned = transitionExecutionWaveStatus(wave, nextStatus);
  return {
    ...plan,
    executionWaves: plan.executionWaves.map((item) => item.id === waveId ? transitioned : item),
    updatedAt,
  };
}

/**
 * Reports whether a durable transaction can move through its publication
 * lifecycle. Like wave transitions, repeated statuses are allowed so restart
 * recovery can safely replay a confirmed observation.
 */
export function canTransitionWaveTransactionStatus(
  current: WaveTransactionStatus,
  next: WaveTransactionStatus,
): boolean {
  const allowed = waveTransactionTransitions[current];
  return allowed !== undefined && (current === next || allowed.includes(next));
}

/**
 * Returns an immutable transaction with a legal publication status. A
 * transaction that reached `committed` cannot be repurposed or rolled back by
 * a later wave; recovery must create a new transaction for a new attempt.
 * Terminal transitions require durable completion evidence.
 */
export function transitionWaveTransactionStatus(
  transaction: WaveTransaction,
  nextStatus: WaveTransactionStatus,
  completedAt = transaction.completedAt,
): WaveTransaction {
  if (!canTransitionWaveTransactionStatus(transaction.status, nextStatus)) {
    throw new Error(
      `Wave transaction ${transaction.id} cannot transition from ${transaction.status} to ${nextStatus}.`,
    );
  }
  if (nextStatus === 'committed' || nextStatus === 'rolled-back') {
    if (!completedAt?.trim()) {
      throw new Error(`Terminal wave transaction ${transaction.id} requires completion evidence.`);
    }
    if (nextStatus === 'rolled-back' && transaction.commit !== undefined) {
      throw new Error(`Published wave transaction ${transaction.id} cannot be marked rolled-back.`);
    }
    return { ...transaction, status: nextStatus, completedAt };
  }
  return { ...transaction, status: nextStatus };
}
