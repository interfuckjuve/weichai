import { describe, expect, it } from 'vitest';
import type { AdaptationResultV2 } from '@forexplore/contracts';
import { manifestValidatorExecutions, mergeValidationArtifactPaths } from './migration-validation-projection';

const result = (artifact?: AdaptationResultV2['validation'][number]['artifact']) => ({
  repairRounds: [],
  patchHash: 'sha256:' + 'a'.repeat(64),
  validation: [{
    id: 'check', label: 'Check', status: 'pass' as const, required: true,
    policyCheckId: 'policy', routeId: 'route', routeVersion: '1', phase: 'behavior' as const,
    verifierId: 'verifier', verifierVersion: '1', summary: 'ok',
    ...(artifact === undefined ? {} : { artifact }),
  }],
} as unknown as AdaptationResultV2);

describe('migration validation projection', () => {
  it('merges repair receipts and evidence with final artifacts without fabricating local copies', () => {
    const artifact = { id: 'final', kind: 'verification-result', path: 'attempt-final/result.json', contentHash: 'a'.repeat(64), mediaType: 'application/json' };
    const repaired = { ...result(artifact), repairRounds: [{ verifierArtifacts: [
      { id: 'failed-receipt', path: 'attempt-first/result.json', contentHash: 'b'.repeat(64) },
      { id: 'failed-report', path: 'attempt-first/report.json', contentHash: 'c'.repeat(64) },
    ] }] } as AdaptationResultV2;
    const paths = { adaptationResult: 'run/result.json' };
    expect(mergeValidationArtifactPaths(paths, repaired)).toEqual({
      adaptationResult: 'run/result.json', final: 'attempt-final/result.json',
      'failed-receipt': 'attempt-first/result.json', 'failed-report': 'attempt-first/report.json',
    });
    expect(paths).toEqual({ adaptationResult: 'run/result.json' });
    expect(() => mergeValidationArtifactPaths({ 'failed-report': 'fake-local-copy.json' }, repaired)).toThrow(/conflicting/);
  });

  it.each(['path', 'contentHash'] as const)('rejects conflicting final and repair artifact %s identities', (field) => {
    const artifact = { id: 'shared', kind: 'verification-result', path: 'attempt-final/result.json', contentHash: 'a'.repeat(64), mediaType: 'application/json' };
    const repaired = { ...result(artifact), repairRounds: [{ verifierArtifacts: [{ ...artifact, [field]: field === 'path' ? 'other.json' : 'b'.repeat(64) }] }] } as unknown as AdaptationResultV2;
    expect(() => mergeValidationArtifactPaths({}, repaired)).toThrow(/conflicting/);
  });

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
