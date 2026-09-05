import { describe, expect, it } from 'vitest';
import type { AdaptationResultV2 } from '@forexplore/contracts';
import { manifestValidatorExecutions, mergeValidationArtifactPaths } from './migration-validation-projection';

const result = (artifact?: AdaptationResultV2['validation'][number]['artifact']) => ({
  patchHash: 'sha256:' + 'a'.repeat(64),
  validation: [{
    id: 'check', label: 'Check', status: 'pass' as const, required: true,
    policyCheckId: 'policy', routeId: 'route', routeVersion: '1', phase: 'behavior' as const,
    verifierId: 'verifier', verifierVersion: '1', summary: 'ok',
    ...(artifact === undefined ? {} : { artifact }),
  }],
} as AdaptationResultV2);

describe('migration validation projection', () => {
  it('projects receipt artifacts and paths', () => {
    const artifact = { id: 'receipt', kind: 'validation', path: '.forexplore/receipt.json', contentHash: 'a'.repeat(64), mediaType: 'application/json' };
    expect(manifestValidatorExecutions(result(artifact))[0]?.artifactRefs).toEqual([{ id: 'receipt', contentHash: artifact.contentHash }]);
    expect(mergeValidationArtifactPaths({}, result(artifact))).toEqual({ receipt: artifact.path });
  });
  it('keeps legacy records empty and rejects collisions', () => {
    expect(manifestValidatorExecutions(result())[0]?.artifactRefs).toEqual([]);
    expect(() => mergeValidationArtifactPaths({ receipt: 'other.json' }, result({ id: 'receipt', kind: 'validation', path: 'receipt.json', contentHash: 'a'.repeat(64), mediaType: 'application/json' }))).toThrow(/conflicting/);
  });
});
