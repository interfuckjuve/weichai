import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";
import type { BehaviorProjectBaseline } from "./behavior-workspace.js";

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
  schemaVersion: "2.0";
  cases: BehaviorCaseInput[];
  testFiles: string[];
  resultFile?: string;
  notes: string;
  commands: { setup: BehaviorCommand[]; run: BehaviorCommand };
}
export interface BehaviorTargetManifest {
  schemaVersion: "2.0";
  testFiles: string[];
  resultFile?: string;
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
  resultFile?: string;
  resultText?: string;
}
/** The caller owns these existing directories. No implementation may clone them. */
export interface BehaviorExecutionScope {
  cwd: string;
  readRoots: string[];
  /** Logical test/build permissions, not OS sandbox boundaries. */
  writeRoots: string[];
  /** Host replay checks these frozen harness and input files before and after commands. */
  readOnlyFiles?: string[];
  /** Original caller-owned files, retained across a bounded test-harness repair. */
  baseline?: BehaviorProjectBaseline;
}
export interface BehaviorAgentTask {
  side: BehaviorSide;
  sandbox: BehaviorExecutionScope;
  prompt: string;
  /** Redacted cumulative stream, bounded by the runtime. */
  onOutput?: (text: string) => void;
  deadlineAt: number;
  signal?: AbortSignal;
}
export interface BehaviorCommandTask {
  command: BehaviorCommand;
  sandbox: BehaviorExecutionScope;
  deadlineAt: number;
  signal?: AbortSignal;
}
export interface BehaviorRuntime {
  runAgent(task: BehaviorAgentTask): Promise<BehaviorProcessResult>;
  runCommand(task: BehaviorCommandTask): Promise<BehaviorProcessResult>;
}
export interface BehaviorSourceSnapshot {
  schemaVersion: "2.0";
  subjectHash: string;
  casesHash: string;
  manifest: BehaviorCollectionManifest;
  observations: BehaviorCaseResult[];
}
export interface BehaviorReport {
  schemaVersion: "2.0";
  stage: "eligibility" | "source" | "waiting-target" | "target" | "comparison";
  caseStatus: BehaviorCaseStatus;
  cases: BehaviorCaseReport[];
  evidence: BehaviorExecutionEvidence[];
  repairs: { side: BehaviorSide; attempt: number; reason: string }[];
  targetSubjectHash?: string;
  patchHash?: string;
  sourceSnapshot?: BehaviorSourceSnapshot;
  limitations: string[];
}
