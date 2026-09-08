/* Generated from verifier JSON Schemas. Do not edit. */

/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "identifier".
 */
export type Identifier = string;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "fileReference".
 */
export type VerificationRunFileReference =
  | {
      availability: "available";
      path: RelativePath;
    }
  | {
      availability: "unavailable" | "omitted";
      reason: Message;
    };
/**
 * Safe normalized relative POSIX file path, checked by Host; no filesystem access in schema validation.
 *
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "relativePath".
 */
export type RelativePath = string;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "message".
 */
export type Message = string;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "stageId".
 */
export type VerificationStageId = string;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "stageState".
 */
export type VerificationStageState = "not-started" | "running" | "completed" | "failed" | "cancelled" | "skipped";
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "duration".
 */
export type Duration = number;
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "eventFileReference".
 */
export type VerificationRunEventFileReference = EventFileReference & EventFileReference1;
export type EventFileReference =
  | {
      availability: "available";
      path: RelativePath;
      [k: string]: unknown;
    }
  | {
      availability: "unavailable" | "omitted";
      reason: Message;
      [k: string]: unknown;
    };
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "agentTaskName".
 */
export type AgentTaskName = string;
/**
 * This interface was referenced by `VerificationInput`'s JSON-Schema
 * via the `definition` "filePatch".
 */
export type FilePatchSchemaSubset = {
  /**
   * This interface was referenced by `VerificationInput`'s JSON-Schema
   * via the `definition` "nonEmptyString".
   */
  path: string;
  status: "created" | "modified";
  additions: number;
  deletions: number;
  expectedAbsent?: true;
  /**
   * This interface was referenced by `VerificationInput`'s JSON-Schema
   * via the `definition` "sha256".
   */
  expectedOriginalSha256?: string;
  hunks: {
    header: string;
    lines: {
      type: "context" | "add" | "remove";
      content: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
};
/**
 * Public verify()/CLI result. verifyWithReceipt() uses #/definitions/receipt. SHA-256 bindings, unique IDs, evidence references and canonical receipt metadata require host validation in addition to this schema.
 *
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "resultSnapshot".
 */
export type VerificationOutputSchema = VerificationResult;
export type VerificationResult = VerificationStrategyOutput & {
  schemaVersion: "1.0";
  strategyId: string;
  strategyVersion: string;
  subjectHash: string;
  round: number;
  status?: unknown;
  summary?: unknown;
  issues?: unknown;
  artifacts?: unknown;
  strategyReport?: unknown;
  createdAt: string;
  contentHash: string;
  mode?: unknown;
  referenceDecision?: unknown;
  referenceReason?: unknown;
  executionStatus?: unknown;
  sourceAssessment?: unknown;
  targetAssessment?: unknown;
  problems?: unknown;
  /**
   * SHA-256 of canonical complete VerificationInput, including reference policy, independent test basis and both snapshots.
   */
  inputHash: string;
};

/**
 * Bounded Host diagnostics, not canonical verification evidence. References name actual files only when available. Host validates normalized relative paths and the persistence layer must enforce existence and containment. Durations are inclusive monotonic measurements; absent measurements are omitted, never invented.
 */
export interface VerificationRun {
  schemaVersion: "1.0";
  runId: Identifier;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  /**
   * Through failure handling, cleanup and response preparation, excluding the final run-record write and caller transport.
   */
  totalDurationMs?: number;
  input: VerificationRunFileReference;
  strategy: VerificationRunStrategySelection;
  /**
   * @maxItems 1024
   */
  stages: VerificationStage[];
  agentTimeline: VerificationRunEventFileReference;
  hostEvents: VerificationRunEventFileReference;
  report: VerificationRunFileReference;
  /**
   * @maxItems 256
   */
  diagnostics: VerificationRunDiagnostic[];
}
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "strategySelection".
 */
export interface VerificationRunStrategySelection {
  requestedId?: Identifier;
  selected?: VerificationStrategyDescriptor;
  selection: "explicit" | "default";
  applicability: "not-checked" | "supported" | "unsupported" | "failed";
  reason?: Message;
}
export interface VerificationStrategyDescriptor {
  id: string;
  version: string;
  displayName: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "stage".
 */
export interface VerificationStage {
  id: VerificationStageId;
  state: VerificationStageState;
  name: Identifier;
  scope: "framework" | "strategy";
  parentId?: VerificationStageId;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  durationMs?: Duration;
  error?: Message;
  reason?: Message;
  /**
   * @maxItems 256
   */
  artifacts?: VerificationRunFileReference[];
}
export interface EventFileReference1 {
  availability?: unknown;
  path?: unknown;
  reason?: unknown;
  source: Identifier;
  completeness: "complete" | "partial" | "buffered" | "unavailable" | "truncated";
}
/**
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "diagnostic".
 */
export interface VerificationRunDiagnostic {
  code: Identifier;
  message: Message;
  stageId?: VerificationStageId;
}
/**
 * Allowlisted metadata only. Source identifies actual observation provenance; kind/event do not imply exact process boundaries. Task occurrence IDs are assigned by Host, and task names may repeat.
 *
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "event".
 */
export interface VerificationRunEvent {
  kind: Identifier;
  source: Identifier;
  runId: Identifier;
  sequence: number;
  receivedAt: Timestamp;
  offsetMs?: Duration;
  operationId?: Identifier;
  parentOperationId?: Identifier;
  name?: Identifier;
  event?: Identifier;
  durationMs?: Duration;
  exitCode?: number;
  timedOut?: boolean;
  commandId?: Identifier;
}
/**
 * Public translation-verifier input. This schema validates the framework-owned envelope and staged artifacts; strategy-specific context and upstream AdaptationRequestV2 lineage are validated by their owners. Content hashes, patch hashes and safe normalized paths are additionally checked by the host.
 *
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "inputSnapshot".
 */
export interface VerificationInput {
  schemaVersion: "1.0";
  /**
   * AdaptationRequestV2. Only the framework-required subset is mandatory here, preserving standalone strategies. Additional upstream fields are preserved as JSON.
   */
  request: {
    /**
     * User requirements consumed by the selected strategy.
     */
    requirement?: string;
    /**
     * Upstream language-open migration route.
     */
    route?: {
      [k: string]: unknown;
    };
    /**
     * Upstream source implementation identity.
     */
    candidate?: {
      [k: string]: unknown;
    };
    /**
     * Upstream target symbol identity.
     */
    target?: {
      [k: string]: unknown;
    };
    sourceBundle: {
      files: StagedFileSchemaSubset[];
      [k: string]: unknown;
    };
    targetContext: {
      sourceFiles: StagedFileSchemaSubset[];
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  /**
   * Strategy-owned JSON analysis; not necessarily a differential-smoke report.
   */
  analysisReport: {
    [k: string]: unknown;
  };
  /**
   * Strategy-owned JSON migration plan.
   */
  migrationPlan: {
    [k: string]: unknown;
  };
  translation: {
    round: number;
    /**
     * This interface was referenced by `VerificationInput`'s JSON-Schema
     * via the `definition` "nonEmptyString".
     */
    generatedContent: string;
    /**
     * @minItems 1
     */
    files: [FilePatchSchemaSubset, ...FilePatchSchemaSubset[]];
    /**
     * This interface was referenced by `VerificationInput`'s JSON-Schema
     * via the `definition` "sha256".
     */
    patchHash: string;
    [k: string]: unknown;
  };
  /**
   * Host-owned reference trust decision and independent test basis. Omission never authorizes source execution.
   */
  verificationPolicy?: {
    referenceDecision: "accepted" | "rejected" | "undetermined";
    /**
     * This interface was referenced by `VerificationInput`'s JSON-Schema
     * via the `definition` "nonEmptyString".
     */
    reason: string;
    /**
     * Host-confirmed requirements or acceptance criteria, independent of either implementation and the implementing Agent.
     */
    testBasis?: string;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `VerificationInput`'s JSON-Schema
 * via the `definition` "stagedFile".
 */
export interface StagedFileSchemaSubset {
  /**
   * Normalized, safe repository-relative POSIX path; checked by the host.
   */
  path: string;
  /**
   * This interface was referenced by `VerificationInput`'s JSON-Schema
   * via the `definition` "nonEmptyString".
   */
  content: string;
  /**
   * This interface was referenced by `VerificationInput`'s JSON-Schema
   * via the `definition` "sha256".
   */
  contentHash: string;
  [k: string]: unknown;
}
export interface VerificationStrategyOutput {
  /**
   * Deprecated compatibility projection only. Never compare this field without mode and the independent assessments. Host validates it against the detailed fields.
   */
  status: "pass" | "warn" | "fail" | "unverified";
  summary: string;
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  /**
   * Strategy-owned JSON report. The selected strategy validates its internal format.
   */
  strategyReport: {
    [k: string]: unknown;
  };
  mode: "differential" | "target_only";
  referenceDecision: "accepted" | "rejected" | "undetermined";
  referenceReason: string;
  executionStatus: "completed" | "partial" | "failed" | "cancelled";
  sourceAssessment: "bug_found" | "no_bug_observed" | "suspected_bug" | "inconclusive" | "not_checked";
  targetAssessment: "bug_found" | "no_bug_observed" | "suspected_bug" | "inconclusive" | "not_checked";
  problems: VerificationProblem[];
  [k: string]: unknown;
}
export interface VerificationIssue {
  id: string;
  kind: string;
  message: string;
  caseId?: string;
  /**
   * Strategy-owned JSON source observation.
   */
  sourceObservation?: {
    [k: string]: unknown;
  };
  /**
   * Strategy-owned JSON target observation.
   */
  targetObservation?: {
    [k: string]: unknown;
  };
  evidenceArtifactIds: string[];
  [k: string]: unknown;
}
export interface VerificationArtifact {
  id: string;
  kind: string;
  /**
   * Safe normalized relative path within the artifact store; checked by the host.
   */
  path: string;
  contentHash: string;
  mediaType: string;
  [k: string]: unknown;
}
export interface VerificationProblem {
  code:
    | "report_missing"
    | "report_invalid_json"
    | "report_schema_invalid"
    | "report_evidence_invalid"
    | "agent_timeout"
    | "command_timeout"
    | "agent_error"
    | "environment_unavailable"
    | "insufficient_test_basis"
    | "workspace_integrity_violation"
    | "context_incomplete"
    | "unsupported_language"
    | "input_invalid"
    | "artifact_persistence_failed"
    | "internal_error"
    | "cancelled";
  message: string;
  side?: "source" | "target";
  commandId?: string;
}
/**
 * resultArtifact may be absent only for an unverified artifact-persistence-failed result; the host enforces this cross-field rule and canonical-byte metadata.
 *
 * This interface was referenced by `VerificationRun`'s JSON-Schema
 * via the `definition` "receipt".
 */
export interface VerificationReceipt {
  result: VerificationResult;
  resultArtifact?: VerificationResultArtifact;
  [k: string]: unknown;
}
export interface VerificationResultArtifact {
  id: string;
  kind: "verification-result";
  path: string;
  contentHash: string;
  size: number;
  mediaType: "application/json";
  [k: string]: unknown;
}
