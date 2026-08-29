import { describe, expect, it } from 'vitest';
import type { ExecutionWave } from '@forexplore/contracts';
import { nextWaveForReadOnlyReview } from './module-wave-review';

function wave(
  id: string,
  order: number,
  status: ExecutionWave['status'] = 'pending',
  dependsOnWaveIds: string[] = [],
): ExecutionWave {
  return {
    id,
    order,
    groupIds: [id],
    moduleIds: [id],
    dependsOnWaveIds,
    maxParallelism: 4,
    requiresApproval: true,
    status,
    parallelismBlockedBy: [],
  };
}

describe('nextWaveForReadOnlyReview', () => {
  it('selects the first dependency-ready wave in deterministic order', () => {
    const selected = nextWaveForReadOnlyReview({
      executionWaves: [
        wave('wave-2', 2, 'pending', ['wave-1']),
        wave('wave-1', 1),
      ],
    });

    expect(selected?.id).toBe('wave-1');
  });

  it('does not release a dependent wave based on an earlier approval state', () => {
    const selected = nextWaveForReadOnlyReview({
      executionWaves: [
        wave('wave-1', 1, 'approved'),
        wave('wave-2', 2, 'pending', ['wave-1']),
      ],
    });

    expect(selected).toBeUndefined();
  });

  it('releases a dependent wave only after its predecessor is committed', () => {
    const selected = nextWaveForReadOnlyReview({
      executionWaves: [
        wave('wave-2', 2, 'pending', ['wave-1']),
        wave('wave-1', 1, 'committed'),
      ],
    });

    expect(selected?.id).toBe('wave-2');
  });
});
