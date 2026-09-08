import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationIssue,
  VerificationArtifact,
} from "../schemas/verification-types.js";
import { VerificationArtifactPersistenceError } from "./verification-artifact-store.js";
import { canonicalJson } from "@forexplore/workflow-core";
import {
  assertSchema,
  validateDescriptorSchema,
  validateStrategyOutputSchema,
  validateResultSchema,
} from "../schemas/compile-schema-validators.js";
import { assertVerificationInput } from "../schemas/validate-verification-input.js";
import {
  assertVerificationAssessment,
  deriveCompatibilityStatus,
  failureAssessment,
} from "../schemas/verification-assessment.js";
import {
  cloneJsonValue,
  normalizeArtifactPath,
  sha256Hex,
} from "../schemas/validate-json-paths.js";

export function createVerificationResult(
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  output: VerificationStrategyOutput,
  now: () => string = () => new Date().toISOString(),
): VerificationResult {
  assertVerificationInput(input);
  assertSchema(
    validateDescriptorSchema,
    descriptor,
    "Verification strategy descriptor",
  );
  assertSchema(validateStrategyOutputSchema, output, "Verification result");
  assertVerificationAssessment(output, input);
  if (output.status !== deriveCompatibilityStatus(output))
    throw new Error(
      "Verification compatibility status does not match the detailed assessments.",
    );
  const issues = output.issues.map((issue) => materializeIssue(issue));
  const artifacts = output.artifacts.map((artifact) =>
    materializeArtifact(artifact),
  );
  assertUniqueIds(
    issues.map((issue) => issue.id),
    "Verification issue",
  );
  assertUniqueIds(
    artifacts.map((artifact) => artifact.id),
    "Verification artifact",
  );
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  for (const issue of issues) {
    for (const artifactId of issue.evidenceArtifactIds) {
      if (!artifactIds.has(artifactId)) {
        throw new Error(
          "Verification issue evidence artifact reference must name a result artifact.",
        );
      }
    }
  }

  const payload: Omit<VerificationResult, "contentHash"> = {
    schemaVersion: "1.0",
    strategyId: descriptor.id,
    strategyVersion: descriptor.version,
    subjectHash: input.translation.patchHash,
    inputHash: sha256Hex(canonicalJson(input)),
    round: input.translation.round,
    status: deriveCompatibilityStatus(output),
    mode: output.mode,
    referenceDecision: output.referenceDecision,
    referenceReason: output.referenceReason,
    executionStatus: output.executionStatus,
    sourceAssessment: output.sourceAssessment,
    targetAssessment: output.targetAssessment,
    problems: output.problems.map((problem) => ({ ...problem })),
    summary: output.summary,
    issues,
    artifacts,
    strategyReport: cloneJsonValue(
      output.strategyReport,
      "Verification strategy report",
    ),
    createdAt: now(),
  };
  const result = {
    ...payload,
    contentHash: sha256Hex(canonicalJson(payload)),
  };
  assertSchema(validateResultSchema, result, "Verification result");
  return result;
}

function assertUniqueIds(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} IDs must be unique.`);
    }
    seen.add(value);
  }
}

function materializeIssue(issue: VerificationIssue): VerificationIssue {
  return {
    id: issue.id,
    kind: issue.kind,
    message: issue.message,
    ...(issue.caseId === undefined ? {} : { caseId: issue.caseId }),
    ...(issue.sourceObservation === undefined
      ? {}
      : {
          sourceObservation: cloneJsonValue(
            issue.sourceObservation,
            "Verification issue source observation",
          ),
        }),
    ...(issue.targetObservation === undefined
      ? {}
      : {
          targetObservation: cloneJsonValue(
            issue.targetObservation,
            "Verification issue target observation",
          ),
        }),
    evidenceArtifactIds: [...issue.evidenceArtifactIds],
  };
}

function materializeArtifact(
  artifact: VerificationArtifact,
): VerificationArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    path: normalizeArtifactPath(artifact.path),
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType,
  };
}

export function createUnverifiedResult(
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
      status: "unverified",
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
