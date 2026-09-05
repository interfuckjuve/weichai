import type { AdaptationResultV2, MigrationRunManifestV2, MigrationValidatorExecutionV2 } from '@forexplore/contracts';

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
  for (const record of result.validation) {
    const artifact = record.artifact;
    if (artifact === undefined) continue;
    const previous = merged[artifact.id];
    if (previous !== undefined && previous !== artifact.path) {
      throw new Error(`Validation artifact ${artifact.id} has conflicting paths.`);
    }
    merged[artifact.id] = artifact.path;
  }
  return merged;
}
