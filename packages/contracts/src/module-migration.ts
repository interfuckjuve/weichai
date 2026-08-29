import type { Language } from './module';
import type { ValidationRecord } from './validation';

/**
 * Schema version for artifacts produced by the repository architecture and
 * module migration workflow.  These artifacts deliberately live beside the
 * existing symbol-retrieval contracts: a dependency graph is not retrieval
 * metadata and must retain its own evidence and snapshot identity.
 */
export const moduleMigrationSchemaVersion = '1.0' as const;

export type StaticFileRole =
  | 'source'
  | 'test'
  | 'generated'
  | 'configuration'
  | 'other';

export interface StaticAnalysisFile {
  /** Workspace-relative, POSIX-normalized path. */
  path: string;
  sha256: string;
  role: StaticFileRole;
  language?: Language;
  project?: string;
}

export type StaticSymbolKind =
  | 'project'
  | 'package'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'record'
  | 'struct'
  | 'enum'
  | 'method'
  | 'constructor'
  | 'function'
  | 'field'
  | 'property'
  | 'unknown';

export interface StaticSourceRange {
  path: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

/** A symbol collected from the immutable static-analysis snapshot. */
export interface StaticSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: StaticSymbolKind;
  language: Language;
  path: string;
  range?: StaticSourceRange;
  signature?: string;
  project?: string;
  /** True when this symbol belongs to a test file or test-only type. */
  testOnly?: boolean;
}

export type DependencyKind =
  | 'import'
  | 'project-reference'
  | 'inheritance'
  | 'implementation'
  | 'type-reference'
  | 'invocation'
  | 'member-access'
  | 'test-reference'
  | 'unknown';

/** How confidently the analyser established a dependency edge. */
export type DependencyEvidenceLevel =
  | 'semantic'
  | 'syntactic'
  | 'ambiguous'
  | 'unresolved';

export type DependencyResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved';

/**
 * A code-level dependency edge.  `target*` remains optional specifically so
 * a parser can preserve an unresolved reference as evidence instead of
 * inventing a destination.
 */
export interface DependencyEdge {
  id: string;
  sourceSymbolId?: string;
  targetSymbolId?: string;
  sourcePath: string;
  targetPath?: string;
  kind: DependencyKind;
  internal: boolean;
  resolution: DependencyResolutionStatus;
  evidence: DependencyEvidenceLevel;
  evidenceRanges: StaticSourceRange[];
  snapshotId: string;
  /** Original text when a target cannot be uniquely resolved. */
  targetReference?: string;
}

export type StaticAnalysisDiagnosticSeverity = 'info' | 'warn' | 'error';

export interface StaticAnalysisDiagnostic {
  id: string;
  severity: StaticAnalysisDiagnosticSeverity;
  message: string;
  path?: string;
  range?: StaticSourceRange;
  code?: string;
}

export interface RepositoryIdentity {
  /** Root is informational only; all artifact paths remain relative. */
  root?: string;
  remote?: string;
  revision?: string;
}

/**
 * Immutable repository-analysis snapshot consumed by architecture planning.
 * Callers must never combine records from two snapshot IDs.
 */
export interface RepositoryStaticAnalysis {
  schemaVersion: typeof moduleMigrationSchemaVersion;
  snapshotId: string;
  contentHash: string;
  analyzerVersion: string;
  createdAt: string;
  repository: RepositoryIdentity;
  files: StaticAnalysisFile[];
  symbols: StaticSymbol[];
  dependencies: DependencyEdge[];
  diagnostics: StaticAnalysisDiagnostic[];
}

export type FunctionalModuleKind =
  | 'feature'
  | 'shared-contract'
  | 'infrastructure'
  | 'integration'
  | 'test-support'
  | 'other';

/**
 * Module IDs are persisted in plan artifacts and used as graph identities.
 * Keep them deliberately narrow so they remain safe in UI, JSON, Git
 * metadata, and diagnostic contexts.  Scheduler internals still use
 * collision-safe tuple keys as defense in depth, but untrusted architecture
 * output must not introduce separators or control characters into IDs.
 */
export const moduleIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidModuleId(value: unknown): value is string {
  return typeof value === 'string' && moduleIdPattern.test(value);
}

/** A functional ownership unit proposed by the architect and checked by host code. */
export interface FunctionalModule {
  id: string;
  name: string;
  kind: FunctionalModuleKind;
  description: string;
  /** Source files exclusively owned by this module. */
  sourceFiles: string[];
  testFiles?: string[];
  generatedFiles?: string[];
  symbolIds: string[];
  /** `A.dependsOn = [B]` means B must execute before A. */
  dependsOn: string[];
  /** Files expected to be edited while preparing this module. */
  writeSet: string[];
  /** Logical resources such as public contracts, project files, or generators. */
  resourceLocks: string[];
  /** Static edge IDs and symbols that substantiate this module boundary. */
  evidenceIds: string[];
}

export type FileAssignmentKind = 'module' | 'test' | 'generated' | 'excluded';

/** Explicit accounting prevents silently losing files outside a module. */
export interface ModuleFileAssignment {
  path: string;
  kind: FileAssignmentKind;
  moduleId?: string;
  reason?: string;
}

export type ModuleDependencySource = 'static' | 'architect' | 'human';

/** A module-level edge with the same dependent -> prerequisite direction. */
export interface ModuleDependency {
  moduleId: string;
  dependsOnModuleId: string;
  source: ModuleDependencySource;
  evidenceEdgeIds: string[];
}

export type ModulePlanStatus =
  | 'proposed'
  | 'validated'
  | 'approved'
  | 'invalidated'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled-back';

export type PlanDecisionKind =
  | 'plan-approval'
  | 'wave-approval'
  | 'risk-acceptance'
  | 'note';

export type PlanDecisionStatus = 'approved' | 'rejected' | 'accepted' | 'recorded';

/** Human-only data.  Every approval binds to both snapshot and plan hash. */
export interface PlanDecision {
  id: string;
  kind: PlanDecisionKind;
  status: PlanDecisionStatus;
  snapshotId: string;
  planHash: string;
  actor: string;
  decidedAt: string;
  waveId?: string;
  /**
   * Required for a wave approval. It binds the human decision to the exact
   * prepared patch bundle and independent validation evidence, not merely to
   * the earlier architecture schedule.
   */
  preparedHash?: string;
  note?: string;
  riskIds?: string[];
}

export type ExecutionGroupKind = 'module' | 'scc' | 'shared-contract';

/** A non-splittable transaction unit.  SCC members execute serially. */
export interface ExecutionGroup {
  id: string;
  kind: ExecutionGroupKind;
  moduleIds: string[];
  dependsOnGroupIds: string[];
  executionMode: 'serial';
  atomic: true;
  writeSet: string[];
  resourceLocks: string[];
  reasons: string[];
}

export type ExecutionWaveStatus =
  | 'pending'
  | 'prepared'
  | 'awaiting-approval'
  | 'approved'
  | 'committing'
  | 'committed'
  | 'failed'
  | 'rolled-back';

/**
 * Groups in the same wave may prepare in parallel only if this schedule put
 * them there.  Commit approval and commit itself apply to the entire wave.
 */
export interface ExecutionWave {
  id: string;
  order: number;
  groupIds: string[];
  moduleIds: string[];
  dependsOnWaveIds: string[];
  maxParallelism: number;
  requiresApproval: boolean;
  status: ExecutionWaveStatus;
  parallelismBlockedBy: string[];
}

export type WaveTransactionStatus =
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'rolled-back';

/** Durable state needed to recover a module-wave transaction. */
export interface WaveTransaction {
  id: string;
  runId: string;
  waveId: string;
  snapshotId: string;
  planHash: string;
  /** The sole managed migration ref for this run. Included in prepared approval evidence. */
  branchName: string;
  /** Hash of the reviewed prepared patch bundle and validation evidence. */
  preparedHash: string;
  status: WaveTransactionStatus;
  /** Git commit used as the immutable baseline while this wave was prepared. */
  baseCommit: string;
  baselineFileHashes: Record<string, string | null>;
  checkpointId?: string;
  worktreePath?: string;
  /**
   * Resolved after publication when available. A commit cannot embed its own
   * object ID in the run manifest stored inside that same commit, so durable
   * recovery also uses the managed branch and transaction trailer.
   */
  commit?: string;
  preparedAt: string;
  completedAt?: string;
  failureReason?: string;
}

/** Unscheduled architect output.  Host validation and scheduling own all safety decisions. */
export interface ModuleMigrationProposal {
  schemaVersion: typeof moduleMigrationSchemaVersion;
  snapshotId: string;
  objective: string;
  modules: FunctionalModule[];
  fileAssignments: ModuleFileAssignment[];
  dependencies?: ModuleDependency[];
  risks?: string[];
}

/** Backward-friendly name for the architect's untrusted functional proposal. */
export type FunctionalModuleProposal = ModuleMigrationProposal;

/**
 * Read-only input for Agenticodex.  The host supplies an already persisted
 * snapshot; callers must not substitute arbitrary browser-provided source.
 */
export interface RepositoryArchitectureRequest {
  schemaVersion: typeof moduleMigrationSchemaVersion;
  analysis: RepositoryStaticAnalysis;
  objective: string;
  immutableConstraints?: string[];
}

/** A deterministic, reviewable plan derived from a verified proposal. */
export interface ModuleMigrationPlan extends ModuleMigrationProposal {
  id: string;
  analysisHash: string;
  status: ModulePlanStatus;
  planHash: string;
  executionGroups: ExecutionGroup[];
  executionWaves: ExecutionWave[];
  decisions: PlanDecision[];
  createdAt: string;
  updatedAt: string;
}

export type MigrationRunStatus =
  | 'planned'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled-back';

/** Immutable-per-run audit record; transactions append rather than overwrite evidence. */
export interface MigrationRunManifest {
  schemaVersion: typeof moduleMigrationSchemaVersion;
  id: string;
  snapshotId: string;
  analysisHash: string;
  planId: string;
  planHash: string;
  status: MigrationRunStatus;
  createdAt: string;
  updatedAt: string;
  decisions: PlanDecision[];
  validation: ValidationRecord[];
  transactions: WaveTransaction[];
  artifactPaths: {
    analysis: string;
    summary: string;
    manifest: string;
  };
}

/** The portable shape written to `.forexplore/module-summary.json`. */
export interface ModuleSummary {
  schemaVersion: typeof moduleMigrationSchemaVersion;
  generated: {
    snapshotId: string;
    analysisHash: string;
    planId: string;
    planHash: string;
    status: ModulePlanStatus;
    modules: FunctionalModule[];
    dependencies: ModuleDependency[];
    executionGroups: ExecutionGroup[];
    executionWaves: ExecutionWave[];
    risks: string[];
  };
  human: {
    approvalsCurrent: boolean;
    decisions: PlanDecision[];
    notes: string[];
    acceptedRisks: string[];
  };
}
