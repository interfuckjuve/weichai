import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";
import type { BehaviorProjectBaseline } from "./behavior-workspace.js";

export type BehaviorSide = "source" | "target";
export interface BehaviorCommand {
  executable: string;
  args: string[];
}
export type ReuseClassification = "direct" | "adapt" | "not_applicable";
export type BehaviorExpectation = {
  rationale: string;
  provenance: string[];
} & (
  | { kind: "source" }
  | { kind: "requirement"; expected: BehaviorCaseResult }
  | { kind: "unresolved" }
);
export interface BehaviorCaseInput {
  caseId: string;
  intent: string;
  input: JsonValue;
  setup?: JsonValue;
  operations?: JsonValue[];
  observe?: JsonValue;
  expectation: BehaviorExpectation;
}
export interface BehaviorCaseResult {
  caseId: string;
  outcome: "return" | "exception";
  value?: JsonValue;
  error?: { category: string; message: string };
}
export interface BehaviorCollectionManifest {
  schemaVersion: "3.0";
  cases: BehaviorCaseInput[];
  testFiles: string[];
  resultFile?: string;
  notes: string;
  commands?: { setup: BehaviorCommand[]; run: BehaviorCommand };
}
export interface BehaviorTargetPlan {
  schemaVersion: "1.0";
  testBasis: { summary: string; evidence: string[] };
  cases: BehaviorCaseInput[];
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
  | "requirement-satisfied"
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
  expectation?: BehaviorExpectation;
  expected?: BehaviorCaseResult;
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
export interface BehaviorCommandRecord extends BehaviorProcessResult {
  commandId: string;
  /** False means the process/proxy stopped before completion evidence was recorded. */
  completed?: boolean;
  side?: BehaviorSide;
  command: BehaviorCommand;
  cwd: string;
  baselineValid: boolean;
  credentialHit: boolean;
  /** New test/helper files as they existed immediately before this command. */
  testFiles?: Record<string, string>;
}
export interface BehaviorAgentResult extends BehaviorProcessResult {
  /** Host-held records, never reconstructed from Agent-writable files. */
  commandEvidence?: BehaviorCommandRecord[];
  /** Exact plan captured by the Host before the first target command. */
  frozenPlan?: string;
}
export interface BehaviorAgentTask {
  side: BehaviorSide;
  /** A single session can use only these preconfigured command projects. */
  additionalProjects?: Partial<Record<BehaviorSide, BehaviorExecutionScope>>;
  executionSides?: BehaviorSide[];
  sessionRole?: "single-agent";
  /** Freeze this project file before any target command, not after observations. */
  expectationFile?: string;
  /** Final Host evidence is delivered even when the session fails. */
  onEvidence?: (evidence: BehaviorCommandRecord[], frozenPlan?: string) => void;
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
  runAgent(task: BehaviorAgentTask): Promise<BehaviorAgentResult>;
  runCommand(task: BehaviorCommandTask): Promise<BehaviorProcessResult>;
}
export interface BehaviorSourceSnapshot {
  schemaVersion: "3.0";
  subjectHash: string;
  casesHash: string;
  manifest: BehaviorCollectionManifest;
  observations: BehaviorCaseResult[];
}
export interface BehaviorReport {
  schemaVersion: "3.0";
  classification?: ReuseClassification;
  sourceExecuted?: boolean;
  stage: "eligibility" | "source" | "waiting-target" | "target" | "comparison";
  caseStatus: BehaviorCaseStatus;
  cases: BehaviorCaseReport[];
  evidence: BehaviorExecutionEvidence[];
  repairs: { side: BehaviorSide; attempt: number; reason: string }[];
  targetSubjectHash?: string;
  patchHash?: string;
  sourceSnapshot?: BehaviorSourceSnapshot;
  /** Agent2-authored target design, frozen by Host before target execution. */
  targetPlan?: BehaviorTargetPlan;
  limitations: string[];
}
