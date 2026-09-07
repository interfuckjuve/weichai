import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import type {
  AdaptationRequestV2,
  FilePatch,
  RepositoryIngestionJsonValue,
} from "@forexplore/contracts";
import { calculatePatchHashV2, canonicalJson } from "@forexplore/workflow-core";
import {
  assertSchema,
  validateInputSchema,
  validateResultSchema,
  validateStrategyOutputSchema,
  validateDescriptorSchema,
  validateReceiptSchema,
} from "./verification-schemas.js";

export interface VerificationResultArtifact {
  id: string;
  kind: "verification-result";
  path: string;
  contentHash: string;
  size: number;
  mediaType: "application/json";
}

export type VerificationReceipt =
  | { result: VerificationResult; resultArtifact: VerificationResultArtifact }
  | { result: VerificationResult; resultArtifact?: undefined };

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
  writeArtifact: (
    artifact: VerificationArtifact,
  ) => Promise<VerificationArtifact> | VerificationArtifact;
}

export interface VerificationStrategy {
  verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput>;
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
    round: input.translation.round,
    status: output.status,
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

export function assertVerificationResult(
  result: VerificationResult,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
): VerificationResult {
  assertVerificationInput(input);
  assertSchema(
    validateDescriptorSchema,
    descriptor,
    "Verification strategy descriptor",
  );
  assertSchema(validateResultSchema, result, "Verification result");
  if (result.strategyId !== descriptor.id) {
    throw new Error(
      "Verification result strategy ID does not match the selected strategy.",
    );
  }
  if (result.strategyVersion !== descriptor.version) {
    throw new Error(
      "Verification result strategy version does not match the selected strategy.",
    );
  }
  if (result.round !== input.translation.round) {
    throw new Error(
      "Verification result round does not match the verification input.",
    );
  }
  if (result.subjectHash !== input.translation.patchHash) {
    throw new Error(
      "Verification result subject hash does not match the selected patch hash.",
    );
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
  if (
    result.contentHash !== expected.contentHash ||
    canonicalJson(expected) !== canonicalJson(result)
  ) {
    throw new Error(
      "Verification result content hash does not match its materialized envelope.",
    );
  }
  return result;
}

export function assertVerificationReceipt(
  receipt: VerificationReceipt,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
): VerificationReceipt {
  assertSchema(validateReceiptSchema, receipt, "Verification receipt");
  assertVerificationResult(receipt.result, input, descriptor);
  if (receipt.resultArtifact === undefined) {
    if (
      receipt.result.status !== "unverified" ||
      !receipt.result.issues.some(
        (issue) =>
          issue.id === "artifact-persistence-failed" &&
          issue.kind === "artifact-persistence-failed",
      )
    ) {
      throw new Error(
        "Verification receipt may omit its result artifact only for artifact-persistence-failed.",
      );
    }
    return receipt;
  }
  const artifact = receipt.resultArtifact;
  const path = normalizeArtifactPath(artifact.path);
  const bytes = Buffer.from(canonicalJson(receipt.result), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    artifact.path !== path ||
    artifact.contentHash !== hash ||
    artifact.size !== bytes.byteLength ||
    artifact.id !== `verification-result:${path}`
  ) {
    throw new Error(
      "Verification receipt result artifact metadata does not match the canonical result bytes.",
    );
  }
  return receipt;
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

function normalizeArtifactPath(value: string): string {
  return normalizeRepositoryRelativePath(value, "Verification artifact path");
}

function normalizeRepositoryRelativePath(
  value: unknown,
  label: string,
): string {
  const pathValue = requireString(value, label);
  if (
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\") ||
    /^[A-Za-z]:/.test(pathValue) ||
    /^\\\\/.test(pathValue)
  ) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  if (pathValue.includes("\\")) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  const normalized = pathPosix.normalize(pathValue);
  if (
    normalized !== pathValue ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  return normalized;
}

function cloneJsonValue<T>(value: T, label: string): T {
  assertJsonCompatible(value, label);
  return structuredClone(value);
}

function assertJsonCompatible(value: unknown, label: string): void {
  assertJsonCompatibleValue(value, label, new Set<object>());
}

function assertJsonCompatibleValue(
  value: unknown,
  label: string,
  active: Set<object>,
): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `${label} must be JSON-compatible; non-finite numbers are not allowed.`,
        );
      }
      return;
    case "undefined":
      throw new Error(
        `${label} must be JSON-compatible; undefined is not allowed.`,
      );
    case "function":
      throw new Error(
        `${label} must be JSON-compatible; functions are not allowed.`,
      );
    case "symbol":
      throw new Error(
        `${label} must be JSON-compatible; symbols are not allowed.`,
      );
    case "bigint":
      throw new Error(
        `${label} must be JSON-compatible; bigints are not allowed.`,
      );
    case "object":
      break;
    default:
      throw new Error(
        `${label} must be JSON-compatible; unsupported values are not allowed.`,
      );
  }

  if (value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (active.has(value)) {
      throw new Error(
        `${label} must be JSON-compatible; cyclic references are not allowed.`,
      );
    }
    active.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error(
          `${label} must be JSON-compatible; symbol keys are not allowed.`,
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        assertJsonCompatibleValue(value[index], `${label}[${index}]`, active);
      }
    } finally {
      active.delete(value);
    }
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      `${label} must be JSON-compatible; non-plain objects are not allowed.`,
    );
  }
  if (active.has(value)) {
    throw new Error(
      `${label} must be JSON-compatible; cyclic references are not allowed.`,
    );
  }
  active.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `${label} must be JSON-compatible; symbol keys are not allowed.`,
      );
    }
    for (const key of Object.keys(value)) {
      assertJsonCompatibleValue(value[key], `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
