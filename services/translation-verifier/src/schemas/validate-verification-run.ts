import type { VerificationRun } from "./verification-types.js";
import { assertSchema, validateRunSchema } from "./compile-schema-validators.js";
import { normalizeRepositoryRelativePath } from "./validate-json-paths.js";

export function assertVerificationRun(value: unknown): VerificationRun {
  assertSchema(validateRunSchema, value, "Verification run");
  const references = [value.input, value.report, value.agentTimeline, value.hostEvents,
    ...value.stages.flatMap((stage) => stage.artifacts ?? [])];
  for (const reference of references) {
    if (reference.availability === "available") {
      normalizeRepositoryRelativePath(reference.path, "Verification run file path");
    }
  }
  return value;
}
