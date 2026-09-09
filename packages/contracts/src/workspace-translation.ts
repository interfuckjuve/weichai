/** Retrieval evidence is immutable; workspaceFiles are read live by the agents. */
export interface WorkspaceTranslationContext {
  id: string;
  kind: "source" | "interface" | "call-chain" | "configuration" | "dependency" | "summary";
  content: string;
  path?: string;
  repository?: string;
  revision?: string;
}

export interface WorkspaceTranslationRequest {
  spec: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: WorkspaceTranslationContext[];
  /** Exact workspace-relative paths available for live reads. */
  workspaceFiles: string[];
  /** Exact workspace-relative files that this task may create or update. */
  writeFiles: string[];
}

export interface WorkspaceTranslationPlan {
  summary: string;
  mappings: Array<{ source: string; targetPath: string; targetSymbol: string }>;
  dependencies: Array<{ name: string; strategy: "reuse" | "replace" | "adapt" | "translate"; detail: string }>;
  steps: Array<{ id: string; description: string; files: string[]; dependsOn: string[] }>;
}

/** Owned by the backend configuration, never by the model or HTTP payload. */
export interface WorkspaceCompileCommand {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface WorkspaceCompilation {
  command: WorkspaceCompileCommand;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  success: boolean;
  output: string;
  diagnostics: string[];
}

export type WorkspaceTranslationStatus =
  | "analyzing" | "translating" | "compiling" | "testing" | "completed"
  | "failed" | "cancelled" | "interrupted" | "rolling-back" | "rolled-back";

export interface WorkspaceTranslationChange {
  path: string;
  before: string | null;
  after: string;
  /** Recorded before writing so an interrupted write can be recovered. */
  applied: boolean;
  /** Last disk content while an update is journaled but not yet acknowledged. */
  pendingBefore?: string | null;
  rolledBack?: boolean;
}

export interface WorkspaceTranslationRun {
  id: string;
  workspaceRoot: string;
  status: WorkspaceTranslationStatus;
  request: WorkspaceTranslationRequest;
  createdAt: string;
  updatedAt: string;
  plan?: WorkspaceTranslationPlan;
  completedSteps: string[];
  changes: WorkspaceTranslationChange[];
  compilations: WorkspaceCompilation[];
  modelTurns: number;
  error?: string;
  /** A passing fixed test suite is evidence, not a proof of all behaviors. */
  acceptance: "compilation-only" | "behavior-verified";
  verification?: {
    command: WorkspaceCompileCommand;
    criteria: Array<{ path: string; hash: string }>;
    runs: Array<WorkspaceCompilation & { sourceSnapshot: string; planHash: string; filesUnchanged: boolean }>;
  };
}
