import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";

export type BehaviorSide = "source" | "target";
export interface BehaviorCommand {
  executable: string;
  args: string[];
}
export interface BehaviorCaseInput {
  caseId: string;
  intent: string;
  input: JsonValue;
}
export interface BehaviorCaseResult {
  caseId: string;
  outcome: "return" | "exception";
  value?: JsonValue;
  error?: { category: string; message: string };
}
export interface BehaviorCollectionManifest {
  schemaVersion: "1.0";
  cases: BehaviorCaseInput[];
  testFiles: string[];
  notes: string;
  commands: { setup: BehaviorCommand[]; run: BehaviorCommand };
}
export interface BehaviorTargetManifest {
  schemaVersion: "1.0";
  testFiles: string[];
  notes: string;
  commands: { setup: BehaviorCommand[]; run: BehaviorCommand };
}
export type BehaviorCaseStatus =
  | "verified-equivalent"
  | "translation-divergence"
  | "source-defect"
  | "accepted-difference"
  | "input-invalid"
  | "source-test-generation-failed"
  | "target-test-generation-failed"
  | "target-not-ready"
  | "command-failed"
  | "timeout"
  | "environment-unverified"
  | "workspace-integrity-failed"
  | "not-executed";
export interface BehaviorCaseReport {
  caseId: string;
  caseStatus: BehaviorCaseStatus;
  source: BehaviorCaseResult | null;
  target: BehaviorCaseResult | null;
}
export interface BehaviorProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}
export interface BehaviorExecutionEvidence extends BehaviorProcessResult {
  commandId: string;
  side: BehaviorSide;
  phase: "setup" | "run";
  command: BehaviorCommand;
  cwd: string;
}
/** The caller owns these existing directories. No implementation may clone them. */
export interface BehaviorSandbox {
  cwd: string;
  readRoots: string[];
  writeRoots: string[];
  /** Frozen harness and case files remain read-only even inside writable test roots. */
  readOnlyFiles?: string[];
}
export interface BehaviorAgentTask {
  side: BehaviorSide;
  sandbox: BehaviorSandbox;
  prompt: string;
  /** Redacted cumulative stream, bounded by the runtime. */
  onOutput?: (text: string) => void;
  deadlineAt: number;
  signal?: AbortSignal;
}
export interface BehaviorCommandTask {
  command: BehaviorCommand;
  sandbox: BehaviorSandbox;
  deadlineAt: number;
  signal?: AbortSignal;
}
export interface BehaviorRuntime {
  runAgent(task: BehaviorAgentTask): Promise<BehaviorProcessResult>;
  runCommand(task: BehaviorCommandTask): Promise<BehaviorProcessResult>;
}
export interface BehaviorSourceSnapshot {
  schemaVersion: "1.0";
  subjectHash: string;
  casesHash: string;
  manifest: BehaviorCollectionManifest;
  observations: BehaviorCaseResult[];
}
export interface BehaviorReport {
  schemaVersion: "1.0";
  stage: "eligibility" | "source" | "waiting-target" | "target" | "comparison";
  caseStatus: BehaviorCaseStatus;
  cases: BehaviorCaseReport[];
  evidence: BehaviorExecutionEvidence[];
  targetSubjectHash?: string;
  patchHash?: string;
  sourceSnapshot?: BehaviorSourceSnapshot;
  limitations: string[];
}
