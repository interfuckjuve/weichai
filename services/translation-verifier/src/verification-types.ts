import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import type {
  AdaptationRequestV2,
  FilePatch,
  RepositoryIngestionJsonValue,
} from "@forexplore/contracts";
import { calculatePatchHashV2, canonicalJson } from "@forexplore/workflow-core";

export interface VerificationStrategyDescriptor {
  id: string;
  version: string;
  displayName: string;
}

export interface VerificationArtifact {
  id: string;
  kind: string;
  path: string;
  contentHash: string;
  mediaType: string;
}

export interface VerificationIssue {
  id: string;
  kind: string;
  message: string;
  caseId?: string;
  sourceObservation?: RepositoryIngestionJsonValue;
  targetObservation?: RepositoryIngestionJsonValue;
  evidenceArtifactIds: string[];
}

export interface VerificationInput {
  schemaVersion: "1.0";
  request: AdaptationRequestV2;
  analysisReport: RepositoryIngestionJsonValue;
  migrationPlan: RepositoryIngestionJsonValue;
  translation: {
    round: number;
    generatedContent: string;
    files: FilePatch[];
    patchHash: string;
  };
}

export interface VerificationResult {
  schemaVersion: "1.0";
  strategyId: string;
  strategyVersion: string;
  subjectHash: string;
  round: number;
  status: "pass" | "warn" | "fail" | "unverified";
  summary: string;
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  strategyReport: RepositoryIngestionJsonValue;
  createdAt: string;
  contentHash: string;
}

export interface VerificationStrategyContext {
  workspace: {
    root: string;
    sourceRoot: string;
    targetRoot: string;
    strategyRoot: string;
    evidenceRoot: string;
  };
  deadlineAt: number;
  writeArtifact: (artifact: VerificationArtifact) => Promise<VerificationArtifact> | VerificationArtifact;
}

export interface VerificationStrategy {
  verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
}

export interface VerificationStrategyProvider {
  descriptor: VerificationStrategyDescriptor;
  create(): VerificationStrategy;
}

export interface VerificationStrategyOutput {
  status: "pass" | "warn" | "fail" | "unverified";
  summary: string;
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  strategyReport: RepositoryIngestionJsonValue;
}

const sha256Pattern = /^[0-9a-f]{64}$/;

export function createVerificationResult(
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  output: VerificationStrategyOutput,
  now: () => string = () => new Date().toISOString(),
): VerificationResult {
  assertVerificationInput(input);
  assertVerificationStrategyDescriptor(descriptor);
  const round = requireNonNegativeInteger(input.translation.round, "Verification translation round");
  const subjectHash = requireSha256(input.translation.patchHash, "Verification translation patch hash");
  const status = requireVerificationStatus(output.status, "Verification result status");
  const issues = requireVerificationArray(output.issues, "Verification result issues").map((issue) => validateIssue(issue));
  const artifacts = requireVerificationArray(output.artifacts, "Verification result artifacts").map((artifact) => validateArtifact(artifact));
  assertUniqueIds(issues.map((issue) => issue.id), "Verification issue");
  assertUniqueIds(artifacts.map((artifact) => artifact.id), "Verification artifact");
  if (output.status === "fail" && issues.length === 0) {
    throw new Error("Verification result status fail requires at least one issue.");
  }
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  for (const issue of issues) {
    for (const artifactId of issue.evidenceArtifactIds) {
      if (!artifactIds.has(requireNonEmptyString(artifactId, "Verification issue evidence artifact ID"))) {
        throw new Error("Verification issue evidence artifact reference must name a result artifact.");
      }
    }
  }

  const payload: Omit<VerificationResult, "contentHash"> = {
    schemaVersion: "1.0",
    strategyId: descriptor.id,
    strategyVersion: descriptor.version,
    subjectHash,
    round,
    status,
    summary: requireNonEmptyString(output.summary, "Verification result summary"),
    issues,
    artifacts,
    strategyReport: structuredClone(output.strategyReport),
    createdAt: requireNonEmptyString(now(), "Verification result createdAt"),
  };
  return {
    ...payload,
    contentHash: sha256Hex(canonicalJson(payload)),
  };
}

export function assertVerificationInput(input: VerificationInput): VerificationInput {
  if (!isRecord(input)) {
    throw new Error("Verification input must be an object.");
  }
  if (input.schemaVersion !== "1.0") {
    throw new Error("Verification input schemaVersion must be 1.0.");
  }
  if (!isRecord(input.translation)) {
    throw new Error("Verification input translation must be an object.");
  }
  requireNonNegativeInteger(input.translation.round, "Verification translation round");
  requireNonEmptyString(input.translation.generatedContent, "Verification translation generated content");
  if (!Array.isArray(input.translation.files) || input.translation.files.length === 0) {
    throw new Error("Verification translation must contain at least one patch.");
  }
  const expectedPatchHash = requireSha256(
    calculatePatchHashV2(input.translation.files),
    "Verification translation patch hash",
  );
  if (requireSha256(input.translation.patchHash, "Verification translation patch hash") !== expectedPatchHash) {
    throw new Error("Verification translation patch hash does not match its files.");
  }
  return input;
}

export function assertVerificationResult(
  result: VerificationResult,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
): VerificationResult {
  assertVerificationInput(input);
  assertVerificationStrategyDescriptor(descriptor);
  if (result.strategyId !== descriptor.id) {
    throw new Error("Verification result strategy ID does not match the selected strategy.");
  }
  if (result.strategyVersion !== descriptor.version) {
    throw new Error("Verification result strategy version does not match the selected strategy.");
  }
  if (result.round !== input.translation.round) {
    throw new Error("Verification result round does not match the verification input.");
  }
  if (result.subjectHash !== input.translation.patchHash) {
    throw new Error("Verification result subject hash does not match the selected patch hash.");
  }
  const expected = createVerificationResult(
    input,
    descriptor,
    {
      status: result.status,
      summary: result.summary,
      issues: result.issues,
      artifacts: result.artifacts,
      strategyReport: result.strategyReport,
    },
    () => result.createdAt,
  );
  if (result.contentHash !== expected.contentHash || canonicalJson(expected) !== canonicalJson(result)) {
    throw new Error("Verification result content hash does not match its materialized envelope.");
  }
  return result;
}

function requireVerificationStatus(value: string, label: string): VerificationResult["status"] {
  if (value !== "pass" && value !== "warn" && value !== "fail" && value !== "unverified") {
    throw new Error(`${label} must be one of pass, warn, fail, or unverified.`);
  }
  return value;
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

function validateIssue(issue: VerificationIssue): VerificationIssue {
  if (!isRecord(issue)) {
    throw new Error("Verification issue must be an object.");
  }
  const evidenceArtifactIds = requireVerificationArray(
    issue.evidenceArtifactIds,
    "Verification issue evidence artifact IDs",
  ).map((artifactId) => requireNonEmptyString(artifactId, "Verification issue evidence artifact ID"));
  return {
    id: requireNonEmptyString(issue.id, "Verification issue ID"),
    kind: requireNonEmptyString(issue.kind, "Verification issue kind"),
    message: requireNonEmptyString(issue.message, "Verification issue message"),
    ...(issue.caseId === undefined ? {} : { caseId: requireNonEmptyString(issue.caseId, "Verification issue case ID") }),
    ...(issue.sourceObservation === undefined ? {} : { sourceObservation: structuredClone(issue.sourceObservation) }),
    ...(issue.targetObservation === undefined ? {} : { targetObservation: structuredClone(issue.targetObservation) }),
    evidenceArtifactIds,
  };
}

function requireVerificationArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function validateArtifact(artifact: VerificationArtifact): VerificationArtifact {
  if (!isRecord(artifact)) {
    throw new Error("Verification artifact must be an object.");
  }
  return {
    id: requireNonEmptyString(artifact.id, "Verification artifact ID"),
    kind: requireNonEmptyString(artifact.kind, "Verification artifact kind"),
    path: normalizeArtifactPath(artifact.path),
    contentHash: requireSha256(artifact.contentHash, "Verification artifact content hash"),
    mediaType: requireNonEmptyString(artifact.mediaType, "Verification artifact media type"),
  };
}

function normalizeArtifactPath(value: string): string {
  const pathValue = requireNonEmptyString(value, "Verification artifact path");
  if (pathValue.startsWith("/") || pathValue.startsWith("\\") || /^[A-Za-z]:/.test(pathValue) || /^\\\\/.test(pathValue)) {
    throw new Error("Verification artifact path must be a normalized relative path.");
  }
  if (pathValue.includes("\\")) {
    throw new Error("Verification artifact path must use normalized relative separators.");
  }
  const normalized = pathPosix.normalize(pathValue);
  if (normalized !== pathValue || normalized === "." || normalized === "" || normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..")) {
    throw new Error("Verification artifact path must be a normalized relative path.");
  }
  return normalized;
}

function assertVerificationStrategyDescriptor(
  descriptor: VerificationStrategyDescriptor,
): VerificationStrategyDescriptor {
  if (!isRecord(descriptor)) {
    throw new Error("Verification strategy descriptor must be an object.");
  }
  return {
    id: requireNonEmptyString(descriptor.id, "Verification strategy descriptor ID"),
    version: requireNonEmptyString(descriptor.version, "Verification strategy descriptor version"),
    displayName: requireNonEmptyString(descriptor.displayName, "Verification strategy descriptor display name"),
  };
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (!sha256Pattern.test(text)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex string.`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
