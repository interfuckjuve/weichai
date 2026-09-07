import type { VerificationInput } from "./verification-types.js";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { assertSchema, validateInputSchema } from "./compile-schema-validators.js";
import { assertJsonCompatible, normalizeRepositoryRelativePath, sha256Hex } from "./validate-json-paths.js";

export function assertVerificationInput(
  input: VerificationInput,
): VerificationInput {
  assertJsonCompatible(input, "Verification input");
  assertSchema(validateInputSchema, input, "Verification input");
  validateVerificationStagedArtifacts(
    input.request.sourceBundle.files,
    "Verification sourceBundle.files",
  );
  // The schema requires path/content on staged sourceFiles even though upstream context facts make them optional.
  input.request.targetContext.sourceFiles.forEach((artifact, index) => {
    validateStagedArtifact(
      artifact.path!,
      artifact.content!,
      artifact.contentHash,
      `Verification targetContext.sourceFiles[${index}]`,
    );
  });
  input.translation.files.forEach((patch, index) => {
    normalizeRepositoryRelativePath(
      patch.path,
      `Verification translation.files[${index}] path`,
    );
  });
  if (
    input.translation.patchHash !==
    calculatePatchHashV2(input.translation.files)
  ) {
    throw new Error(
      "Verification translation patch hash does not match its files.",
    );
  }
  return input;
}

function validateVerificationStagedArtifacts(
  items: readonly { path: string; content: string; contentHash: string }[],
  label: string,
): void {
  items.forEach((artifact, index) => {
    validateStagedArtifact(
      artifact.path,
      artifact.content,
      artifact.contentHash,
      `${label}[${index}]`,
    );
  });
}

function validateStagedArtifact(
  path: string,
  content: string,
  contentHash: string,
  label: string,
): void {
  normalizeRepositoryRelativePath(path, `${label} path`);
  if (contentHash !== sha256Hex(content)) {
    throw new Error(`${label} contentHash does not match sha256(content).`);
  }
}
