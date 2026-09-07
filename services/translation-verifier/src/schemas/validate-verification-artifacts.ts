import type { VerificationResult } from "./verification-types.js";

export function assertArtifactsMatch(
  resultArtifacts: VerificationResult["artifacts"],
  writtenArtifacts: VerificationResult["artifacts"],
): void {
  if (resultArtifacts.length !== writtenArtifacts.length) {
    throw new Error(
      "Verification result artifacts must match artifacts written through the workspace.",
    );
  }
  const writtenById = new Map<
    string,
    VerificationResult["artifacts"][number]
  >();
  for (const artifact of writtenArtifacts) {
    if (writtenById.has(artifact.id))
      throw new Error("Verification workspace artifact IDs must be unique.");
    writtenById.set(artifact.id, artifact);
  }
  for (const artifact of resultArtifacts) {
    const written = writtenById.get(artifact.id);
    if (
      written === undefined ||
      written.kind !== artifact.kind ||
      written.path !== artifact.path ||
      written.contentHash !== artifact.contentHash ||
      written.mediaType !== artifact.mediaType
    ) {
      throw new Error(
        "Verification result artifacts must match artifacts written through the workspace.",
      );
    }
  }
}
