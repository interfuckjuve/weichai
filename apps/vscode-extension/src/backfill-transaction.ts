export type InterruptedFileObservation = 'before' | 'after' | 'unknown';

/** Pure decision used by crash recovery before any recovery edit is built. */
export function interruptedRecoveryDecision(
  observations: readonly InterruptedFileObservation[],
): 'mark-rolled-back' | 'restore' {
  if (observations.length === 0 || observations.includes('unknown')) {
    throw new Error('Interrupted backfill has an unknown file state and requires manual recovery.');
  }
  return observations.every((state) => state === 'before') ? 'mark-rolled-back' : 'restore';
}
