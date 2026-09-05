/**
 * Versioned, repository-scoped contracts for the code-intelligence pipeline.
 *
 * These records are deliberately separate from the legacy retrieval and
 * `RepositoryStaticAnalysis` contracts.  The latter remain the compatibility
 * projection for the existing Java/C# migration workflow; these types are the
 * durable source of truth for a multi-repository structural/semantic index.
 */

/** Stable, host-generated repository identity. Never use a local path as an ID. */
export type RepositoryId = string;

/** Immutable completed analysis revision identity within one repository. */
export type AnalysisRevisionId = string;

export type ProjectId = string;
export type FileId = string;
export type SymbolId = string;
export type SymbolKey = string;
export type DependencyEdgeId = string;
export type ModuleArtifactId = string;
export type SearchDocumentId = string;
export type EvidenceId = string;

/** The required scope for every revision-backed semantic query. */
export interface RepositoryRevisionScope {
  repositoryId: RepositoryId;
  analysisRevision: AnalysisRevisionId;
}

/** A repository may be a read-only historical corpus or the editable target. */
export type RepositoryRole = 'history' | 'target';

/** User-visible lifecycle maintained by the repository registry/coordinator. */
export type RepositoryAnalysisStatus =
  | 'registered'
  | 'indexing'
  | 'ready'
  | 'degraded'
  | 'failed';

/** Lifecycle of an immutable revision before/after the atomic active switch. */
export type AnalysisRevisionStatus = 'building' | 'ready' | 'failed' | 'superseded';

/**
 * Registry-owned state. `localPath` is intentionally host/service-only: it
 * must never be returned by SemanticQueryPort, MCP, or a webview payload.
 */
export interface RepositoryRecord {
  repositoryId: RepositoryId;
  displayName: string;
  localPath: string;
  role: RepositoryRole;
  analysisStatus: RepositoryAnalysisStatus;
  /** Completed revision exposed to readers while a replacement is building. */
  activeRevision: AnalysisRevisionId | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe presentation subset that may cross the semantic-query boundary. */
export type RepositoryDescriptor = Omit<RepositoryRecord, 'localPath'>;

/** Immutable metadata for one analysis build. */
export interface AnalysisRevisionRecord extends RepositoryRevisionScope {
  status: AnalysisRevisionStatus;
  /** Hash of the complete analyzed evidence, not merely a Git commit. */
  analysisHash: string;
  /** Optional VCS revision observed while scanning. */
  sourceRevision?: string;
  indexerVersion: string;
  createdAt: string;
  completedAt?: string;
  activatedAt?: string;
  failureReason?: string;
}

/** Built-in initial language identifiers; registries may add additional IDs. */
export type BuiltInLanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust';

/**
 * A language registry is extensible: a grammar installed after v1 must not
 * require a shared-contract release just to be represented in stored data.
 */
export type LanguageId = BuiltInLanguageId | (string & {});

export type LanguageCapabilityLevel = 'structural' | 'semantic';

/**
 * Registry metadata for a Tree-sitter grammar and any optional semantic
 * provider. A `structural` language is still fully indexable at file,
 * declaration, import/export, and range level.
 */
export interface LanguageRegistration {
  languageId: LanguageId;
  displayName: string;
  fileExtensions: string[];
  grammar: string;
  capabilityLevel: LanguageCapabilityLevel;
  semanticProviders?: Array<Exclude<EvidenceProvider, 'tree-sitter'>>;
}

/** All source positions are one-based and end-exclusive. */
export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type IndexedFileRole = 'source' | 'test' | 'generated' | 'configuration' | 'other';
export type FileParseStatus = 'parsed' | 'partial' | 'failed' | 'unsupported';

/** Project boundary recognized from a build/package manifest. */
export interface ProjectRecord extends RepositoryRevisionScope {
  /** Query-only inventory, including files without symbols, for explicit analysis coverage. */
  files?: Array<{ relativePath: string; role: IndexedFileRole; parseStatus: FileParseStatus }>;
  projectId: ProjectId;
  /** Maven, Gradle, dotnet, Node, Python, Go, Cargo, or a future registry kind. */
  kind: string;
  displayName: string;
  relativePath: string;
  manifestPaths: string[];
  sourceRoots: string[];
  testRoots: string[];
  languageIds: LanguageId[];
}

/** One file in the immutable structural revision. Paths are repository-relative POSIX paths. */
export interface IndexedFileRecord extends RepositoryRevisionScope {
  fileId: FileId;
  relativePath: string;
  languageId?: LanguageId;
  role: IndexedFileRole;
  sha256: string;
  sizeBytes: number;
  parseStatus: FileParseStatus;
  projectId?: ProjectId;
}

/**
 * Extensible declaration kind emitted by a Tree-sitter grammar or a semantic
 * provider. The common literals cover the normalized v1 presentation model.
 */
export type CodeSymbolKind =
  | 'project'
  | 'package'
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'record'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'function'
  | 'method'
  | 'constructor'
  | 'field'
  | 'property'
  | 'variable'
  | 'type-alias'
  | 'unknown'
  | (string & {});

/** Evidence producer, intentionally limited to real parsing/semantic providers. */
export type EvidenceProvider = 'tree-sitter' | 'lsp' | 'java-csharp-specialized';

/**
 * Structural evidence never claims cross-file semantic resolution. Ambiguous
 * and unresolved values are durable facts, not errors to be guessed away.
 */
export type EvidenceLevel = 'structural' | 'syntactic' | 'semantic' | 'ambiguous' | 'unresolved';

/** A normalized declaration; `symbolKey` is stable across revisions when its AST identity is unchanged. */
export interface SymbolRecord extends RepositoryRevisionScope {
  symbolId: SymbolId;
  /**
   * Qualified name + signature + AST declaration identity. It must not be
   * derived from a line number, which is only a revision-local location.
   */
  symbolKey: SymbolKey;
  astDeclarationId: string;
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  languageId: LanguageId;
  relativePath: string;
  sourceRange: SourceRange;
  signature?: string;
  containerSymbolKey?: SymbolKey;
  projectId?: ProjectId;
  exported: boolean;
  provider: EvidenceProvider;
  confidence: number;
  evidenceLevel: EvidenceLevel;
}

export type IndexDependencyKind =
  | 'import'
  | 'export'
  | 'project-reference'
  | 'package-reference'
  | 'inheritance'
  | 'implementation'
  | 'type-reference'
  | 'invocation'
  | 'member-access'
  | 'test-reference'
  | 'unknown'
  | (string & {});

export type IndexDependencyResolution = 'resolved' | 'ambiguous' | 'unresolved';

/**
 * Dependency graph record. A missing target is intentional evidence for an
 * unresolved/ambiguous source reference and must survive persistence.
 */
export interface DependencyEdgeRecord extends RepositoryRevisionScope {
  dependencyEdgeId: DependencyEdgeId;
  kind: IndexDependencyKind;
  sourceSymbolKey?: SymbolKey;
  targetSymbolKey?: SymbolKey;
  sourceRelativePath: string;
  targetRelativePath?: string;
  targetReference?: string;
  internal: boolean;
  resolution: IndexDependencyResolution;
  provider: EvidenceProvider;
  confidence: number;
  evidenceLevel: EvidenceLevel;
  evidenceRanges: SourceRange[];
}

export type IndexDiagnosticSeverity = 'info' | 'warning' | 'error';

/** Parser, resolver, compiler, or LSP diagnostic retained with its revision. */
export interface IndexDiagnosticRecord extends RepositoryRevisionScope {
  diagnosticId: string;
  severity: IndexDiagnosticSeverity;
  message: string;
  code?: string;
  relativePath: string | null;
  sourceRange: SourceRange | null;
  provider: EvidenceProvider;
  confidence: number;
  evidenceLevel: EvidenceLevel;
}

export type ModuleArtifactKind = 'module-plan' | 'module-summary' | 'migration-run' | 'other';
export type ModuleArtifactStatus = 'current' | 'stale' | 'invalidated' | 'superseded';

/**
 * Versioned module artifact. A module summary must bind this record's
 * repository/revision/analysisHash/planHash before it can be shown as current.
 */
export interface ModuleArtifactRecord extends RepositoryRevisionScope {
  moduleArtifactId: ModuleArtifactId;
  kind: ModuleArtifactKind;
  status: ModuleArtifactStatus;
  analysisHash: string;
  planHash?: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  /** Store-owned JSON payload; query clients receive only authorized artifacts. */
  payload?: unknown;
}

export type SearchDocumentKind = 'symbol' | 'source-fragment' | 'summary';

/** SeekDB projection document, never the authoritative dependency graph. */
export interface SearchDocumentRecord extends RepositoryRevisionScope {
  searchDocumentId: SearchDocumentId;
  kind: SearchDocumentKind;
  relativePath: string | null;
  symbolKey?: SymbolKey;
  moduleArtifactId?: ModuleArtifactId;
  contentHash: string;
  title: string;
  text: string;
  /** Query-time scores, never authoritative persisted facts or calibrated probabilities. */
  retrievalScore?: { semantic?: number; lexical?: number; fusion: number };
}

/** Complete output of a structural scan before optional semantic enrichment. */
export interface StructuralIndex extends RepositoryRevisionScope {
  analysisHash: string;
  projects: ProjectRecord[];
  files: IndexedFileRecord[];
  symbols: SymbolRecord[];
  dependencyEdges: DependencyEdgeRecord[];
  diagnostics: IndexDiagnosticRecord[];
}

/**
 * Uniform evidence fields attached to every source-backed SemanticQueryPort
 * result. Repository metadata can use a revision-level synthetic evidence ID
 * with null path/range; source evidence always carries both locations.
 */
export interface EvidenceEnvelope extends RepositoryRevisionScope {
  evidenceId: EvidenceId;
  provider: EvidenceProvider;
  /** Closed interval 0..1, assigned by the producing provider. */
  confidence: number;
  evidenceLevel: EvidenceLevel;
  relativePath: string | null;
  sourceRange: SourceRange | null;
}

/** A source-backed query value that preserves its evidence and revision scope. */
export interface SemanticQueryResult<T> extends EvidenceEnvelope {
  value: T;
}

/**
 * Stronger envelope for definition/reference results. Tree-sitter declarations
 * are useful structural facts, but never satisfy this semantic lookup shape.
 */
export interface SemanticEvidenceEnvelope extends EvidenceEnvelope {
  provider: Exclude<EvidenceProvider, 'tree-sitter'>;
  evidenceLevel: 'semantic';
}

export interface SemanticEvidenceResult<T> extends SemanticEvidenceEnvelope {
  value: T;
}

/** Repository list is the sole discovery query and therefore has no required revision input. */
export interface ListRepositoriesRequest {
  roles?: RepositoryRole[];
}

export interface RepositoryListItem extends RepositoryDescriptor {
  /** Mirrors `activeRevision`, named explicitly for clients that select a revision next. */
  analysisRevision: AnalysisRevisionId | null;
}

export interface ListRepositoriesResult {
  repositories: RepositoryListItem[];
}

export interface RepositoryOverview {
  repository: RepositoryDescriptor;
  revision: AnalysisRevisionRecord;
  projectCount: number;
  fileCount: number;
  symbolCount: number;
  dependencyCount: number;
  diagnosticCount: number;
  languages: Array<{
    languageId: LanguageId;
    capabilityLevel: LanguageCapabilityLevel;
    fileCount: number;
  }>;
}

export interface GetRepositoryOverviewRequest extends RepositoryRevisionScope {}

export interface GetRepositoryOverviewResult {
  overview: SemanticQueryResult<RepositoryOverview>;
}

export interface ListProjectsRequest extends RepositoryRevisionScope {}

export interface ListProjectsResult {
  projects: Array<SemanticQueryResult<ProjectRecord>>;
}

export interface FileStructure {
  file: IndexedFileRecord;
  containers: SymbolRecord[];
  declarations: SymbolRecord[];
  imports: DependencyEdgeRecord[];
  exports: DependencyEdgeRecord[];
  diagnostics: IndexDiagnosticRecord[];
}

export interface GetFileStructureRequest extends RepositoryRevisionScope {
  relativePath: string;
}

export interface GetFileStructureResult {
  file: SemanticQueryResult<FileStructure> | null;
}

export interface SearchSymbolsRequest extends RepositoryRevisionScope {
  query: string;
  languageIds?: LanguageId[];
  kinds?: CodeSymbolKind[];
  projectIds?: ProjectId[];
  relativePathPrefix?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchSymbolsResult {
  symbols: Array<SemanticQueryResult<SymbolRecord>>;
  nextCursor?: string;
}

export interface GetSymbolRequest extends RepositoryRevisionScope {
  symbolKey: SymbolKey;
}

export interface GetSymbolResult {
  symbol: SemanticQueryResult<SymbolRecord> | null;
}

/** Semantic lookups must explicitly distinguish unavailable providers from an empty result set. */
export type SemanticLookupAvailability = 'available' | 'unavailable';

export interface SemanticLookupStatus {
  availability: SemanticLookupAvailability;
  /** Set when semantic lookup is unavailable, degraded, or intentionally unsupported. */
  reason?: string;
}

export interface DefinitionLocation {
  symbol: SymbolRecord;
}

export interface FindDefinitionRequest extends RepositoryRevisionScope {
  /** The reference being resolved; it is revision-local, unlike symbolKey. */
  relativePath: string;
  sourceRange: SourceRange;
}

export interface FindDefinitionResult extends SemanticLookupStatus {
  definitions: Array<SemanticEvidenceResult<DefinitionLocation>>;
}

export interface ReferenceLocation {
  symbolKey?: SymbolKey;
  relativePath: string;
  sourceRange: SourceRange;
  referenceKind?: IndexDependencyKind;
}

export interface FindReferencesRequest extends RepositoryRevisionScope {
  symbolKey: SymbolKey;
  limit?: number;
  cursor?: string;
}

export interface FindReferencesResult extends SemanticLookupStatus {
  references: Array<SemanticEvidenceResult<ReferenceLocation>>;
  nextCursor?: string;
}

export interface GetDependenciesRequest extends RepositoryRevisionScope {
  /** Filter by a source/target symbol, file, or project without accepting local paths. */
  symbolKey?: SymbolKey;
  relativePath?: string;
  projectId?: ProjectId;
  direction?: 'incoming' | 'outgoing' | 'both';
  kinds?: IndexDependencyKind[];
  resolution?: IndexDependencyResolution[];
  limit?: number;
  cursor?: string;
}

export interface GetDependenciesResult {
  dependencies: Array<SemanticQueryResult<DependencyEdgeRecord>>;
  nextCursor?: string;
}

export interface GetDiagnosticsRequest extends RepositoryRevisionScope {
  relativePath?: string;
  severities?: IndexDiagnosticSeverity[];
  providers?: EvidenceProvider[];
  limit?: number;
  cursor?: string;
}

export interface GetDiagnosticsResult {
  diagnostics: Array<SemanticQueryResult<IndexDiagnosticRecord>>;
  nextCursor?: string;
}

export interface ReadSourceExcerptRequest extends RepositoryRevisionScope {
  relativePath: string;
  sourceRange?: SourceRange;
  maxChars?: number;
}

export interface SourceExcerpt {
  text: string;
  truncated: boolean;
}

export interface ReadSourceExcerptResult {
  excerpt: SemanticQueryResult<SourceExcerpt> | null;
}

const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** Runtime boundary helper for registry/MCP adapters; it intentionally rejects paths. */
export function isStableRepositoryIdentifier(value: unknown): value is string {
  return typeof value === 'string' && stableIdentifierPattern.test(value);
}

/** Runtime boundary helper for the mandatory revision scope on all data queries. */
export function isRepositoryRevisionScope(value: unknown): value is RepositoryRevisionScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = value as Partial<RepositoryRevisionScope>;
  return (
    isStableRepositoryIdentifier(scope.repositoryId) &&
    isStableRepositoryIdentifier(scope.analysisRevision)
  );
}

/** Lightweight invariant helper useful at MCP/HTTP boundaries. */
export function isSourceRange(value: unknown): value is SourceRange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const range = value as Partial<SourceRange>;
  if (![range.startLine, range.startColumn, range.endLine, range.endColumn]
    .every((part) => Number.isInteger(part) && (part as number) >= 1)) {
    return false;
  }
  return range.endLine! > range.startLine! || (
    range.endLine === range.startLine && range.endColumn! > range.startColumn!
  );
}
