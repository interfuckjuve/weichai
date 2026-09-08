import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationIssue,
  VerificationArtifact,
} from "./verification-types.js";
import { canonicalJson } from "@forexplore/workflow-core";
import {
  assertSchema,
  validateDescriptorSchema,
  validateStrategyOutputSchema,
  validateResultSchema,
} from "./compile-schema-validators.js";
import { assertVerificationInput } from "./validate-verification-input.js";
import { assertVerificationAssessment } from "./verification-assessment.js";
import {
  cloneJsonValue,
  normalizeArtifactPath,
  sha256Hex,
} from "./validate-json-paths.js";

/** Validate and detach strategy findings without constructing a result envelope. */
export function normalizeVerificationStrategyOutput(
  input: VerificationInput,
  output: VerificationStrategyOutput,
): VerificationStrategyOutput {
  assertSchema(validateStrategyOutputSchema, output, "Verification result");
  assertVerificationAssessment(output, input);
  const issues = output.issues.map((issue) => materializeIssue(issue));
  const artifacts = output.artifacts.map((artifact) => materializeArtifact(artifact));
  assertUniqueIds(issues.map((issue) => issue.id), "Verification issue");
  assertUniqueIds(artifacts.map((artifact) => artifact.id), "Verification artifact");
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
  return {
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
    strategyReport: cloneJsonValue(output.strategyReport, "Verification strategy report"),
  };
}

/** Validate independent findings before hashing the output 2.0 envelope. */
export function createVerificationResult(
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  output: VerificationStrategyOutput,
  now: () => string = () => new Date().toISOString(),
): VerificationResult {
  assertVerificationInput(input);
  assertSchema(validateDescriptorSchema, descriptor, "Verification strategy descriptor");
  const normalized = normalizeVerificationStrategyOutput(input, output);
  const payload: Omit<VerificationResult, "contentHash"> = {
    schemaVersion: "2.0",
    strategyId: descriptor.id,
    strategyVersion: descriptor.version,
    subjectHash: input.translation.patchHash,
    inputHash: sha256Hex(canonicalJson(input)),
    round: input.translation.round,
    ...normalized,
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

function materializeArtifact(artifact: VerificationArtifact): VerificationArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    path: normalizeArtifactPath(artifact.path),
    contentHash: artifact.contentHash,
    mediaType: artifact.mediaType,
  };
}
