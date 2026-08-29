import type { ExecutionWave, ModuleMigrationPlan } from '@forexplore/contracts';

const reviewableStatuses = new Set<ExecutionWave['status']>([
  'pending',
  'prepared',
  'awaiting-approval',
]);

/**
 * Selects a wave that is useful to inspect in the planning host. Readiness
 * comes only from durable commits, never from an approval record: approval
 * must bind to a concrete prepared bundle in the execution coordinator.
 */
export function nextWaveForReadOnlyReview(
  plan: Pick<ModuleMigrationPlan, 'executionWaves'>,
): ExecutionWave | undefined {
  const committedWaveIds = new Set(
    plan.executionWaves
      .filter((wave) => wave.status === 'committed')
      .map((wave) => wave.id),
  );

  return [...plan.executionWaves]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .find((wave) =>
      reviewableStatuses.has(wave.status) &&
      wave.dependsOnWaveIds.every((dependencyId) => committedWaveIds.has(dependencyId)),
    );
}
