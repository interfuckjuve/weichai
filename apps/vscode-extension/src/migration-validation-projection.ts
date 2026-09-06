import type { AdaptationResultV2, MigrationValidatorExecutionV2 } from '@forexplore/contracts';

export function manifestValidatorExecutions(result: AdaptationResultV2): MigrationValidatorExecutionV2[] {
  return result.validation.map((record) => {
    if (!record.verifierId || !record.verifierVersion || !record.policyCheckId) {
      throw new Error(`Validation record ${record.id} lacks durable verifier lineage.`);
    }
    return {
      providerId: record.verifierId,
      providerVersion: record.verifierVersion,
      policyCheckId: record.policyCheckId,
      validationRecordId: record.id,
      subjectHash: result.patchHash,
      status: record.status,
      artifactRefs: record.artifact === undefined ? [] : [{
        id: record.artifact.id,
        contentHash: record.artifact.contentHash,
      }],
    };
  });
}

export function mergeValidationArtifactPaths(
  artifactPaths: Record<string, string>,
  result: AdaptationResultV2,
): Record<string, string> {
  const merged = { ...artifactPaths };
  const artifacts = [
    ...result.validation.flatMap((record) => record.artifact === undefined ? [] : [record.artifact]),
    ...result.repairRounds.flatMap((round) => round.verifierArtifacts),
  ];
  const hashes = new Map<string, string>();
  for (const artifact of artifacts) {
    const previous = Object.hasOwn(merged, artifact.id) ? merged[artifact.id] : undefined;
    const previousHash = hashes.get(artifact.id);
    if ((previous !== undefined && previous !== artifact.path) || (previousHash !== undefined && previousHash !== artifact.contentHash)) {
      throw new Error(`Validation artifact ${artifact.id} has conflicting paths or content hashes.`);
    }
    Object.defineProperty(merged, artifact.id, { value: artifact.path, enumerable: true, writable: true, configurable: true });
    hashes.set(artifact.id, artifact.contentHash);
  }
  return merged;
}
