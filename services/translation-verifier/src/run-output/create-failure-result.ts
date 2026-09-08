import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyDescriptor,
} from "../schemas/verification-types.js";
import { createVerificationResult } from "../schemas/materialize-verification-result.js";
import { failureAssessment } from "../schemas/verification-assessment.js";
import { VerificationArtifactPersistenceError } from "./verification-artifact-store.js";

export function createFailureResult(
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  error: unknown,
  artifacts: VerificationResult["artifacts"],
  now: () => string,
  artifactFailure = false,
): VerificationResult {
  const message = errorMessage(error);
  const timeout = isNamedError(error, "TimeoutError");
  const persistence =
    artifactFailure || error instanceof VerificationArtifactPersistenceError;

  const cancelled = isNamedError(error, "AbortError");
  return createVerificationResult(
    input,
    descriptor,
    {
      ...failureAssessment(
        input,
        persistence
          ? "artifact_persistence_failed"
          : cancelled
            ? "cancelled"
            : timeout
              ? "agent_timeout"
              : "internal_error",
        message,
      ),
      summary: `Verification framework could not complete: ${message}`,
      issues: [
        {
          id: persistence
            ? "artifact-persistence-failed"
            : timeout
              ? "strategy-timeout"
              : "framework-error",
          kind: persistence
            ? "artifact-persistence-failed"
            : timeout
              ? "strategy-timeout"
              : "framework-error",
          message,
          evidenceArtifactIds: [],
        },
      ],
      artifacts,
      strategyReport: {
        frameworkError: message,
        errorName: errorName(error),
      },
    },
    now,
  );
}

function errorName(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : "Error";
}

function errorMessage(error: unknown): string {
  if (isNamedError(error, "TimeoutError"))
    return "Verification strategy timed out";
  if (error instanceof Error && error.message.trim().length > 0)
    return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unknown verification error";
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}
