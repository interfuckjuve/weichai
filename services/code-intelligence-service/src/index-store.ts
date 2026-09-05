import type {
  AnalysisRevisionRecord,
  DependencyEdgeRecord,
  IndexDiagnosticRecord,
  IndexedFileRecord,
  ModuleArtifactRecord,
  ProjectRecord,
  RepositoryAnalysisStatus,
  RepositoryId,
  RepositoryRecord,
  RepositoryRevisionScope,
  SearchDocumentRecord,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';

/**
 * Authoritative revision store for code intelligence. Search documents are a
 * projection owned by this store, never a replacement for the structural
 * index. Every method carrying repository data is deliberately revision
 * scoped so callers cannot accidentally join two repository snapshots.
 */
export interface IndexStore {
  initialize?(): Promise<void>;
  close?(): Promise<void>;

  putRepository(repository: RepositoryRecord): Promise<void>;
  getRepository(repositoryId: RepositoryId): Promise<RepositoryRecord | null>;
  listRepositories(): Promise<RepositoryRecord[]>;
  /** Removes a repository and all of its revision-scoped records. */
  removeRepository(repositoryId: RepositoryId): Promise<void>;

  putRevision(revision: AnalysisRevisionRecord): Promise<void>;
  getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null>;
  listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]>;

  /** Replaces only records in this revision; it never clears another repository. */
  putStructuralIndex(index: StructuralIndex, sourceTexts?: ReadonlyMap<string, string>): Promise<void>;
  getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null>;
  getSourceText(scope: RepositoryRevisionScope, relativePath: string): Promise<string | null>;

  listProjects(scope: RepositoryRevisionScope): Promise<ProjectRecord[]>;
  listFiles(scope: RepositoryRevisionScope): Promise<IndexedFileRecord[]>;
  listSymbols(scope: RepositoryRevisionScope): Promise<SymbolRecord[]>;
  listDependencyEdges(scope: RepositoryRevisionScope): Promise<DependencyEdgeRecord[]>;
  listDiagnostics(scope: RepositoryRevisionScope): Promise<IndexDiagnosticRecord[]>;

  putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void>;
  listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]>;
  replaceSearchDocuments(scope: RepositoryRevisionScope, documents: SearchDocumentRecord[], moduleArtifactId?: string): Promise<void>;
  listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]>;
  /** Optional full-text/vector-backed projection lookup; structural records remain authoritative. */
  searchSearchDocuments?(
    scope: RepositoryRevisionScope,
    query: string,
    limit: number,
    kind?: SearchDocumentRecord['kind'],
  ): Promise<SearchDocumentRecord[]>;

  /** Atomically flips the repository's active pointer after a completed build. */
  activateRevision(
    scope: RepositoryRevisionScope,
    status?: Extract<RepositoryAnalysisStatus, 'ready' | 'degraded'>,
  ): Promise<void>;
}

interface RevisionContents {
  index: StructuralIndex;
  sourceTexts: Map<string, string>;
  moduleArtifacts: Map<string, ModuleArtifactRecord>;
  searchDocuments: Map<string, SearchDocumentRecord>;
}

export function validateSummaryReplacement(documents: SearchDocumentRecord[], moduleArtifactId?: string): void {
  if (moduleArtifactId === undefined) return;
  if (!moduleArtifactId || documents.some((document) => document.kind !== 'summary' || document.moduleArtifactId !== moduleArtifactId)) {
    throw new Error('Partial projection replacement must contain only summaries for the selected artifact.');
  }
}

/**
 * Revision metadata is append-only apart from the one terminal transition
 * from `building`. Keeping this check shared between the in-memory and
 * SeekDB stores prevents a retry (or an unlucky generated ID collision) from
 * silently replacing evidence that has already been published.
 */
export function validateRevisionWrite(
  existing: AnalysisRevisionRecord | null,
  next: AnalysisRevisionRecord,
): void {
  if (!next.repositoryId?.trim() || !next.analysisRevision?.trim()) {
    throw new Error('Analysis revisions require a repositoryId and analysisRevision.');
  }
  if (!next.analysisHash?.trim()) throw new Error('Analysis revisions require an analysisHash.');
  if (!next.indexerVersion?.trim()) throw new Error('Analysis revisions require an indexerVersion.');
  if (!next.createdAt?.trim()) throw new Error('Analysis revisions require a createdAt timestamp.');

  if (!existing) {
    if (next.status !== 'building') {
      throw new Error('Analysis revisions must be created in the building state.');
    }
    if (next.completedAt !== undefined || next.activatedAt !== undefined || next.failureReason !== undefined) {
      throw new Error('A building analysis revision cannot include terminal lifecycle fields.');
    }
    return;
  }

  assertScope(existing, next, 'Analysis revision');
  if (
    existing.createdAt !== next.createdAt ||
    existing.indexerVersion !== next.indexerVersion ||
    existing.analysisHash !== next.analysisHash ||
    existing.sourceRevision !== next.sourceRevision
  ) {
    throw new Error('Analysis revision identity metadata is immutable once created.');
  }
  if (existing.activatedAt !== undefined || next.activatedAt !== undefined) {
    throw new Error('Activated analysis revisions cannot be rewritten.');
  }
  if (existing.status !== 'building') {
    throw new Error(`Analysis revision ${next.analysisRevision} is immutable after ${existing.status}.`);
  }
  if (next.status !== 'ready' && next.status !== 'failed') {
    throw new Error('A building analysis revision may transition only to ready or failed.');
  }
  if (!next.completedAt?.trim()) {
    throw new Error('A terminal analysis revision requires a completedAt timestamp.');
  }
  if (next.status === 'ready' && next.failureReason !== undefined) {
    throw new Error('A ready analysis revision cannot include a failure reason.');
  }
  if (next.status === 'failed' && !next.failureReason?.trim()) {
    throw new Error('A failed analysis revision requires a failure reason.');
  }
}

function scopeKey(scope: RepositoryRevisionScope): string {
  return `${scope.repositoryId}\u0000${scope.analysisRevision}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertScope(
  expected: RepositoryRevisionScope,
  actual: RepositoryRevisionScope,
  label: string,
): void {
  if (
    expected.repositoryId !== actual.repositoryId ||
    expected.analysisRevision !== actual.analysisRevision
  ) {
    throw new Error(`${label} must belong to the supplied repository revision.`);
  }
}

export function assertArrayScopes<T extends RepositoryRevisionScope>(
  scope: RepositoryRevisionScope,
  values: readonly T[],
  label: string,
): void {
  for (const value of values) assertScope(scope, value, label);
}

export function assertRelativePath(value: string, label: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a non-empty repository-relative POSIX path.`);
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized !== value ||
    normalized.startsWith('./') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`${label} must be a non-empty repository-relative POSIX path.`);
  }
}

function assertRelativePathOrRoot(value: string, label: string): void {
  if (value === '') return;
  assertRelativePath(value, label);
}

function assertSourceRange(
  value: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  label: string,
): void {
  const coordinates = [value.startLine, value.startColumn, value.endLine, value.endColumn];
  if (!coordinates.every((coordinate) => Number.isInteger(coordinate) && coordinate >= 1)) {
    throw new Error(`${label} must have positive one-based source coordinates.`);
  }
  if (
    value.endLine < value.startLine ||
    (value.endLine === value.startLine && value.endColumn <= value.startColumn)
  ) {
    throw new Error(`${label} must be a non-empty end-exclusive source range.`);
  }
}

export function assertUnique<T>(values: readonly T[], id: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = id(value);
    if (seen.has(key)) throw new Error(`${label} contains duplicate ${key}.`);
    seen.add(key);
  }
}

export function validateStructuralIndex(index: StructuralIndex): void {
  const scope: RepositoryRevisionScope = index;
  if (!index.analysisHash?.trim()) throw new Error('Structural indexes require an analysisHash.');
  assertArrayScopes(scope, index.projects, 'Project');
  assertArrayScopes(scope, index.files, 'File');
  assertArrayScopes(scope, index.symbols, 'Symbol');
  assertArrayScopes(scope, index.dependencyEdges, 'Dependency edge');
  assertArrayScopes(scope, index.diagnostics, 'Diagnostic');
  assertUnique(index.projects, (value) => value.projectId, 'Structural index projects');
  assertUnique(index.files, (value) => value.fileId, 'Structural index files');
  assertUnique(index.files, (value) => value.relativePath, 'Structural index files');
  assertUnique(index.symbols, (value) => value.symbolId, 'Structural index symbols');
  assertUnique(index.symbols, (value) => value.symbolKey, 'Structural index symbols');
  assertUnique(index.dependencyEdges, (value) => value.dependencyEdgeId, 'Structural index dependency edges');
  assertUnique(index.diagnostics, (value) => value.diagnosticId, 'Structural index diagnostics');
  const projectIds = new Set(index.projects.map((project) => project.projectId));
  const filesByPath = new Map(index.files.map((file) => [file.relativePath, file]));
  const symbolsByKey = new Map(index.symbols.map((symbol) => [symbol.symbolKey, symbol]));

  for (const project of index.projects) {
    assertRelativePathOrRoot(project.relativePath, 'Project path');
    if (!project.displayName?.trim() || !project.kind?.trim()) {
      throw new Error('Project records require a kind and display name.');
    }
    for (const manifestPath of project.manifestPaths) {
      assertRelativePath(manifestPath, 'Project manifest path');
      if (project.relativePath && !manifestPath.startsWith(`${project.relativePath}/`)) {
        throw new Error('Project manifest paths must remain within their project root.');
      }
    }
    for (const sourceRoot of project.sourceRoots) assertRelativePathOrRoot(sourceRoot, 'Project source root');
    for (const testRoot of project.testRoots) assertRelativePathOrRoot(testRoot, 'Project test root');
  }
  for (const file of index.files) {
    assertRelativePath(file.relativePath, 'Indexed file path');
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new Error('Indexed file sizeBytes must be a non-negative integer.');
    }
    if (file.projectId !== undefined && !projectIds.has(file.projectId)) {
      throw new Error(`Indexed file ${file.relativePath} references an unknown project.`);
    }
  }
  for (const symbol of index.symbols) {
    assertRelativePath(symbol.relativePath, 'Symbol path');
    if (!filesByPath.has(symbol.relativePath)) {
      throw new Error(`Symbol ${symbol.symbolKey} references a file that is not indexed.`);
    }
    if (symbol.projectId !== undefined && !projectIds.has(symbol.projectId)) {
      throw new Error(`Symbol ${symbol.symbolKey} references an unknown project.`);
    }
    if (symbol.containerSymbolKey !== undefined && !symbolsByKey.has(symbol.containerSymbolKey)) {
      throw new Error(`Symbol ${symbol.symbolKey} references an unknown container symbol.`);
    }
    assertSourceRange(symbol.sourceRange, 'Symbol source range');
  }
  for (const edge of index.dependencyEdges) {
    assertRelativePath(edge.sourceRelativePath, 'Dependency source path');
    if (!filesByPath.has(edge.sourceRelativePath)) {
      throw new Error(`Dependency edge ${edge.dependencyEdgeId} references a source file that is not indexed.`);
    }
    if (edge.targetRelativePath !== undefined) {
      assertRelativePath(edge.targetRelativePath, 'Dependency target path');
      if (!filesByPath.has(edge.targetRelativePath)) {
        throw new Error(`Dependency edge ${edge.dependencyEdgeId} references a target file that is not indexed.`);
      }
    }
    if (edge.sourceSymbolKey !== undefined && !symbolsByKey.has(edge.sourceSymbolKey)) {
      throw new Error(`Dependency edge ${edge.dependencyEdgeId} references an unknown source symbol.`);
    }
    if (edge.targetSymbolKey !== undefined && !symbolsByKey.has(edge.targetSymbolKey)) {
      throw new Error(`Dependency edge ${edge.dependencyEdgeId} references an unknown target symbol.`);
    }
    if (edge.evidenceRanges.length === 0) {
      throw new Error(`Dependency edge ${edge.dependencyEdgeId} requires at least one evidence range.`);
    }
    for (const range of edge.evidenceRanges) assertSourceRange(range, 'Dependency evidence range');
  }
  for (const diagnostic of index.diagnostics) {
    if (diagnostic.relativePath !== null) {
      assertRelativePath(diagnostic.relativePath, 'Diagnostic path');
      if (!filesByPath.has(diagnostic.relativePath)) {
        throw new Error(`Diagnostic ${diagnostic.diagnosticId} references a file that is not indexed.`);
      }
    }
    if (diagnostic.sourceRange !== null) {
      if (diagnostic.relativePath === null) {
        throw new Error(`Diagnostic ${diagnostic.diagnosticId} cannot have a source range without a source path.`);
      }
      assertSourceRange(diagnostic.sourceRange, 'Diagnostic source range');
    }
  }
}

/** Validate immutable source copies before any store mutates a revision. */
export function validateSourceTexts(
  index: StructuralIndex,
  sourceTexts: ReadonlyMap<string, string>,
): void {
  const sourcePaths = new Set(index.files.map((file) => file.relativePath));
  for (const [relativePath, text] of sourceTexts) {
    assertRelativePath(relativePath, 'Source text path');
    if (!sourcePaths.has(relativePath)) {
      throw new Error(`Source text path ${relativePath} is not indexed in this revision.`);
    }
    if (typeof text !== 'string') throw new Error(`Source text for ${relativePath} must be text.`);
  }
}

/**
 * Checks fields that are meaningful without looking up the structural
 * revision. SeekDB calls this before it opens a transaction, so malformed
 * path/scope input cannot cause a delete-and-replace attempt.
 */
export function validateSearchDocumentRecords(
  scope: RepositoryRevisionScope,
  documents: readonly SearchDocumentRecord[],
): void {
  assertArrayScopes(scope, documents, 'Search document');
  assertUnique(documents, (value) => value.searchDocumentId, 'Search documents');
  for (const document of documents) {
    if (!document.searchDocumentId?.trim() || !document.contentHash?.trim()) {
      throw new Error('Search documents require a stable ID and content hash.');
    }
    if (!document.title?.trim() || typeof document.text !== 'string') {
      throw new Error('Search documents require a title and text payload.');
    }
    if (document.relativePath !== null) assertRelativePath(document.relativePath, 'Search document path');
    switch (document.kind) {
      case 'symbol':
        if (document.relativePath === null || !document.symbolKey?.trim() || document.moduleArtifactId !== undefined) {
          throw new Error('Symbol search documents require a source path and symbolKey only.');
        }
        break;
      case 'source-fragment':
        if (document.relativePath === null || document.symbolKey !== undefined || document.moduleArtifactId !== undefined) {
          throw new Error('Source-fragment search documents require a source path only.');
        }
        break;
      case 'summary':
        if (document.relativePath !== null || document.symbolKey !== undefined || !document.moduleArtifactId?.trim()) {
          throw new Error('Summary search documents require a module artifact and no source path.');
        }
        break;
      default:
        throw new Error(`Unsupported search document kind: ${String(document.kind)}.`);
    }
  }
}

/** Validate projection links against one immutable structural revision. */
export function validateSearchDocumentsAgainstIndex(
  index: StructuralIndex,
  documents: readonly SearchDocumentRecord[],
  artifacts: ReadonlyMap<string, ModuleArtifactRecord>,
  repository: Pick<RepositoryRecord, 'activeRevision'> | null,
): void {
  validateSearchDocumentRecords(index, documents);
  const filesByPath = new Map(index.files.map((file) => [file.relativePath, file]));
  const symbolsByKey = new Map(index.symbols.map((symbol) => [symbol.symbolKey, symbol]));
  for (const document of documents) {
    if (document.kind === 'symbol') {
      const symbol = symbolsByKey.get(document.symbolKey!);
      if (!symbol || symbol.relativePath !== document.relativePath) {
        throw new Error(`Symbol search document ${document.searchDocumentId} does not match this structural revision.`);
      }
      continue;
    }
    if (document.kind === 'source-fragment') {
      if (!filesByPath.has(document.relativePath!)) {
        throw new Error(`Source-fragment search document ${document.searchDocumentId} does not match an indexed file.`);
      }
      continue;
    }
    const artifact = artifacts.get(document.moduleArtifactId!);
    if (!artifact || artifact.kind !== 'module-summary' || artifact.status !== 'current') {
      throw new Error(`Summary search document ${document.searchDocumentId} does not reference a current module summary.`);
    }
    validateModuleArtifact(artifact, index, repository);
  }
}

/** Shared policy for writing version-bound module artifacts. */
export function validateModuleArtifact(
  artifact: ModuleArtifactRecord,
  index: StructuralIndex,
  repository: Pick<RepositoryRecord, 'activeRevision'> | null,
): void {
  assertScope(index, artifact, 'Module artifact');
  if (!artifact.moduleArtifactId?.trim() || !artifact.contentHash?.trim()) {
    throw new Error('Module artifacts require a stable ID and content hash.');
  }
  if (index.analysisHash !== artifact.analysisHash) {
    throw new Error('Module artifact analysisHash must match its structural revision.');
  }
  if (artifact.kind !== 'module-summary') return;
  if (!artifact.planHash?.trim()) {
    throw new Error('Module summaries require a planHash bound to their analysis revision.');
  }
  if (artifact.payload === undefined) {
    throw new Error('Module summaries require a payload before they can be projected or displayed.');
  }
  if (artifact.status === 'current' && repository?.activeRevision !== artifact.analysisRevision) {
    throw new Error('A current module summary may only be written for the active analysis revision.');
  }
}

/**
 * Deterministic in-memory implementation used by unit tests, local demos, and
 * host compositions that have not configured SeekDB yet. It mirrors the
 * revision isolation rules of the durable SeekDB implementation.
 */
export class InMemoryIndexStore implements IndexStore {
  readonly #repositories = new Map<RepositoryId, RepositoryRecord>();
  readonly #revisions = new Map<string, AnalysisRevisionRecord>();
  readonly #contents = new Map<string, RevisionContents>();

  async putRepository(repository: RepositoryRecord): Promise<void> {
    this.#repositories.set(repository.repositoryId, clone(repository));
  }

  async getRepository(repositoryId: RepositoryId): Promise<RepositoryRecord | null> {
    const value = this.#repositories.get(repositoryId);
    return value ? clone(value) : null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    return [...this.#repositories.values()]
      .map(clone)
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  }

  async removeRepository(repositoryId: RepositoryId): Promise<void> {
    this.#repositories.delete(repositoryId);
    const prefix = `${repositoryId}\u0000`;
    for (const key of [...this.#revisions.keys()]) {
      if (key.startsWith(prefix)) this.#revisions.delete(key);
    }
    for (const key of [...this.#contents.keys()]) {
      if (key.startsWith(prefix)) this.#contents.delete(key);
    }
  }

  async putRevision(revision: AnalysisRevisionRecord): Promise<void> {
    if (!this.#repositories.has(revision.repositoryId)) {
      throw new Error(`Repository ${revision.repositoryId} is not registered.`);
    }
    const key = scopeKey(revision);
    const existing = this.#revisions.get(key) ?? null;
    validateRevisionWrite(existing, revision);
    this.#revisions.set(key, clone(revision));
  }

  async getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null> {
    const revision = this.#revisions.get(scopeKey(scope));
    return revision ? clone(revision) : null;
  }

  async listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]> {
    return [...this.#revisions.values()]
      .filter((value) => value.repositoryId === repositoryId)
      .map(clone)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async putStructuralIndex(
    index: StructuralIndex,
    sourceTexts: ReadonlyMap<string, string> = new Map(),
  ): Promise<void> {
    validateStructuralIndex(index);
    validateSourceTexts(index, sourceTexts);
    const revision = this.#revisions.get(scopeKey(index));
    if (!revision) throw new Error('Cannot write an index for an unknown analysis revision.');
    if (revision.status !== 'building') {
      throw new Error('Structural indexes may be written only while an analysis revision is building.');
    }
    if (revision.analysisHash !== index.analysisHash) {
      throw new Error('Structural index analysisHash must match its analysis revision.');
    }

    const copiedTexts = new Map<string, string>();
    for (const [relativePath, text] of sourceTexts) {
      copiedTexts.set(relativePath, text);
    }

    this.#contents.set(scopeKey(index), {
      index: clone(index),
      sourceTexts: copiedTexts,
      // A structural revision is immutable. The building-only check above
      // means a retry cannot retain artifacts/projections from a failed
      // partial write under the same revision identity.
      moduleArtifacts: new Map(),
      searchDocuments: new Map(),
    });
  }

  async getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null> {
    const contents = this.#contents.get(scopeKey(scope));
    return contents ? clone(contents.index) : null;
  }

  async getSourceText(scope: RepositoryRevisionScope, relativePath: string): Promise<string | null> {
    assertRelativePath(relativePath, 'Source text path');
    return this.#contents.get(scopeKey(scope))?.sourceTexts.get(relativePath) ?? null;
  }

  async listProjects(scope: RepositoryRevisionScope): Promise<ProjectRecord[]> {
    return clone(this.#contents.get(scopeKey(scope))?.index.projects ?? []);
  }

  async listFiles(scope: RepositoryRevisionScope): Promise<IndexedFileRecord[]> {
    return clone(this.#contents.get(scopeKey(scope))?.index.files ?? []);
  }

  async listSymbols(scope: RepositoryRevisionScope): Promise<SymbolRecord[]> {
    return clone(this.#contents.get(scopeKey(scope))?.index.symbols ?? []);
  }

  async listDependencyEdges(scope: RepositoryRevisionScope): Promise<DependencyEdgeRecord[]> {
    return clone(this.#contents.get(scopeKey(scope))?.index.dependencyEdges ?? []);
  }

  async listDiagnostics(scope: RepositoryRevisionScope): Promise<IndexDiagnosticRecord[]> {
    return clone(this.#contents.get(scopeKey(scope))?.index.diagnostics ?? []);
  }

  async putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void> {
    const contents = this.#contents.get(scopeKey(artifact));
    if (!contents) throw new Error('Cannot write a module artifact before its structural index exists.');
    const revision = this.#revisions.get(scopeKey(artifact));
    const repository = this.#repositories.get(artifact.repositoryId) ?? null;
    if (!revision) throw new Error('Cannot write an artifact for an unknown analysis revision.');
    if (artifact.kind === 'module-summary' && artifact.status === 'current' && revision.status !== 'ready') {
      throw new Error('A current module summary requires a completed ready analysis revision.');
    }
    validateModuleArtifact(artifact, contents.index, repository);
    contents.moduleArtifacts.set(artifact.moduleArtifactId, clone(artifact));
  }

  async listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]> {
    const values = this.#contents.get(scopeKey(scope))?.moduleArtifacts.values() ?? [];
    return [...values].map(clone).sort((left, right) => left.moduleArtifactId.localeCompare(right.moduleArtifactId));
  }

  async replaceSearchDocuments(
    scope: RepositoryRevisionScope,
    documents: SearchDocumentRecord[],
    moduleArtifactId?: string,
  ): Promise<void> {
    validateSummaryReplacement(documents, moduleArtifactId);
    const contents = this.#contents.get(scopeKey(scope));
    if (!contents) throw new Error('Cannot project search documents before its structural index exists.');
    const revision = this.#revisions.get(scopeKey(scope));
    if (!revision || (revision.status !== 'building' && revision.status !== 'ready')) {
      throw new Error('Search documents may be projected only for a building or ready analysis revision.');
    }
    validateSearchDocumentsAgainstIndex(
      contents.index,
      documents,
      contents.moduleArtifacts,
      this.#repositories.get(scope.repositoryId) ?? null,
    );
    const replacement = new Map<string, SearchDocumentRecord>();
    if (moduleArtifactId !== undefined) {
      for (const document of contents.searchDocuments.values()) {
        if (document.kind !== 'summary' || document.moduleArtifactId !== moduleArtifactId) replacement.set(document.searchDocumentId, document);
      }
    }
    for (const document of documents) replacement.set(document.searchDocumentId, clone(document));
    contents.searchDocuments = replacement;
  }

  async listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]> {
    const values = this.#contents.get(scopeKey(scope))?.searchDocuments.values() ?? [];
    return [...values].map(clone).sort((left, right) => left.searchDocumentId.localeCompare(right.searchDocumentId));
  }

  async searchSearchDocuments(
    scope: RepositoryRevisionScope,
    query: string,
    limit: number,
    kind: SearchDocumentRecord['kind'] = 'symbol',
  ): Promise<SearchDocumentRecord[]> {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || !Number.isInteger(limit) || limit < 1) return [];
    const terms = normalized.split(/\s+/).filter(Boolean);
    return (await this.listSearchDocuments(scope))
      .filter((document) => document.kind === kind)
      .map((document) => ({
        document,
        score: terms.reduce((total, term) =>
          total + `${document.title}\n${document.text}`.toLocaleLowerCase().split(term).length - 1,
        0),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.document.searchDocumentId.localeCompare(right.document.searchDocumentId))
      .slice(0, limit)
      .map(({ document }) => document);
  }

  async activateRevision(
    scope: RepositoryRevisionScope,
    status: Extract<RepositoryAnalysisStatus, 'ready' | 'degraded'> = 'ready',
  ): Promise<void> {
    const repository = this.#repositories.get(scope.repositoryId);
    const revision = this.#revisions.get(scopeKey(scope));
    if (!repository || !revision) throw new Error('Cannot activate an unknown repository revision.');
    if (revision.status !== 'ready') throw new Error('Only a ready analysis revision can be activated.');
    if (!revision.completedAt || revision.failureReason !== undefined) {
      throw new Error('Only a completed successful analysis revision can be activated.');
    }
    if (!this.#contents.has(scopeKey(scope))) throw new Error('Cannot activate a revision without a structural index.');

    if (repository.activeRevision === scope.analysisRevision) {
      // The caller may retry after a response loss. Do not mutate activation
      // timestamps or artifacts for an already-active immutable revision.
      return;
    }

    const previousScope = repository.activeRevision
      ? { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision }
      : null;
    if (previousScope && previousScope.analysisRevision !== scope.analysisRevision) {
      const previous = this.#revisions.get(scopeKey(previousScope));
      if (previous && previous.status === 'ready') {
        previous.status = 'superseded';
        this.#revisions.set(scopeKey(previousScope), previous);
      }
      const previousContents = this.#contents.get(scopeKey(previousScope));
      if (previousContents) {
        for (const [id, artifact] of previousContents.moduleArtifacts) {
          if (artifact.status === 'current') {
            previousContents.moduleArtifacts.set(id, { ...artifact, status: 'stale' });
          }
        }
        // SearchDocumentRecord deliberately has no mutable status field.
        // Remove only the stale summary projection so a legacy caller cannot
        // mistake it for a current summary; keep structural documents for
        // historical revision queries.
        for (const [id, document] of previousContents.searchDocuments) {
          if (document.kind === 'summary') previousContents.searchDocuments.delete(id);
        }
      }
    }

    const activatedAt = new Date().toISOString();
    this.#revisions.set(scopeKey(scope), { ...revision, activatedAt });
    this.#repositories.set(scope.repositoryId, {
      ...repository,
      activeRevision: scope.analysisRevision,
      analysisStatus: status,
      updatedAt: activatedAt,
    });
  }
}

export const indexStoreInternals = {
  assertArrayScopes,
  assertRelativePath,
  assertScope,
  scopeKey,
  validateModuleArtifact,
  validateRevisionWrite,
  validateSearchDocumentRecords,
  validateSearchDocumentsAgainstIndex,
  validateStructuralIndex,
  validateSourceTexts,
};
