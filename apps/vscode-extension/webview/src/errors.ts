import type { WorkflowEventV2 } from './v2-workflow';

/**
 * Maps a host-side error to the workflow failure event that clears the
 * pending operation, so the wizard can recover without stale spinners.
 */
export function errorEvent(
  pending: 'search' | 'resolve' | 'adapt' | 'apply' | null,
  message: string,
): WorkflowEventV2 | null {
  if (pending === 'search') return { type: 'SEARCH_FAILURE', message };
  if (pending === 'resolve') return { type: 'CANDIDATE_RESOLVE_FAILURE', message };
  if (pending === 'adapt') return { type: 'ADAPT_FAILURE', message };
  if (pending === 'apply') return { type: 'APPLY_FAILURE', message };
  return null;
}
