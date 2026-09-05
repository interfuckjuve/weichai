import {
  isRepositoryRevisionScope,
  type AnalysisRevisionRecord,
  type CodeSymbolKind,
  type DefinitionLocation,
  type DependencyEdgeRecord,
  type EvidenceEnvelope,
  type EvidenceProvider,
  type FileStructure,
  type FindDefinitionRequest,
  type FindDefinitionResult,
  type FindReferencesRequest,
  type FindReferencesResult,
  type GetDependenciesRequest,
  type GetDependenciesResult,
  type GetDiagnosticsRequest,
  type GetDiagnosticsResult,
  type GetFileStructureRequest,
  type GetFileStructureResult,
  type GetRepositoryOverviewRequest,
  type GetRepositoryOverviewResult,
  type GetSymbolRequest,
  type GetSymbolResult,
  type IndexDiagnosticRecord,
  type IndexedFileRecord,
  type LanguageCapabilityLevel,
  type LanguageId,
  type ListProjectsRequest,
  type ListProjectsResult,
  type ListRepositoriesRequest,
  type ListRepositoriesResult,
  type ProjectRecord,
  type ReadSourceExcerptRequest,
  type ReadSourceExcerptResult,
  type ReferenceLocation,
  type RepositoryRevisionScope,
  type SearchSymbolsRequest,
  type SearchSymbolsResult,
  type SemanticEvidenceResult,
  type SemanticQueryResult,
  type SourceRange,
  type SymbolRecord,
} from '@forexplore/contracts';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import type { IndexStore } from './index-store.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_EXCERPT_CHARS = 32_000;

export interface SemanticProvider {
  readonly provider: Exclude<EvidenceProvider, 'tree-sitter'>;
  /** Omit only when a host-pinned provider can serve every indexed language. */
  readonly supportedLanguageIds?: readonly LanguageId[];
  isAvailable(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<{ available: boolean; reason?: string }>;
  findDefinition?(
    request: FindDefinitionRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<DefinitionLocation>>>;
  findReferences?(
    request: FindReferencesRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<ReferenceLocation>>>;
}

export interface SemanticQueryServiceOptions {
  /** Optional language capabilities from LanguageRegistry; inferred when omitted. */
  languageCapabilities?: ReadonlyMap<LanguageId, LanguageCapabilityLevel>;
  semanticProviders?: readonly SemanticProvider[];
}

function assertRelativePath(relativePath: string): void {
  const normalized = relativePath.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error('Semantic queries accept only non-empty repository-relative paths.');
  }
}

function normalizePath(relativePath: string): string {
  assertRelativePath(relativePath);
  return relativePath.replaceAll('\\', '/');
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`Query limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function decodeCursor(value: string | undefined): number {
  if (!value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isInteger(decoded.offset) || (decoded.offset as number) < 0) throw new Error('invalid');
    return decoded.offset as number;
  } catch {
    throw new Error('Query cursor is invalid.');
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function paginate<T>(values: readonly T[], limitValue: number | undefined, cursor: string | undefined): {
  values: T[];
  nextCursor?: string;
} {
  const limit = boundedLimit(limitValue);
  const offset = decodeCursor(cursor);
  const page = values.slice(offset, offset + limit);
  return {
    values: page,
    ...(offset + page.length < values.length ? { nextCursor: encodeCursor(offset + page.length) } : {}),
  };
}

function sourceEnvelope<T>(
  scope: RepositoryRevisionScope,
  evidence: Omit<EvidenceEnvelope, keyof RepositoryRevisionScope>,
  value: T,
): SemanticQueryResult<T> {
  return { ...scope, ...evidence, value };
}

function symbolResult(scope: RepositoryRevisionScope, symbol: SymbolRecord): SemanticQueryResult<SymbolRecord> {
  return sourceEnvelope(scope, {
    evidenceId: `symbol:${symbol.symbolId}`,
    provider: symbol.provider,
    confidence: symbol.confidence,
    evidenceLevel: symbol.evidenceLevel,
    relativePath: symbol.relativePath,
    sourceRange: symbol.sourceRange,
  }, symbol);
}

function projectResult(scope: RepositoryRevisionScope, project: ProjectRecord): SemanticQueryResult<ProjectRecord> {
  return sourceEnvelope(scope, {
    evidenceId: `project:${project.projectId}`,
    provider: 'tree-sitter',
    confidence: 1,
    evidenceLevel: 'structural',
    relativePath: project.manifestPaths[0] ?? null,
    sourceRange: null,
  }, project);
}

function edgeResult(
  scope: RepositoryRevisionScope,
  edge: DependencyEdgeRecord,
): SemanticQueryResult<DependencyEdgeRecord> {
  return sourceEnvelope(scope, {
    evidenceId: `dependency:${edge.dependencyEdgeId}`,
    provider: edge.provider,
    confidence: edge.confidence,
    evidenceLevel: edge.evidenceLevel,
    relativePath: edge.sourceRelativePath,
    sourceRange: edge.evidenceRanges[0] ?? null,
  }, edge);
}

function diagnosticResult(
  scope: RepositoryRevisionScope,
  diagnostic: IndexDiagnosticRecord,
): SemanticQueryResult<IndexDiagnosticRecord> {
  return sourceEnvelope(scope, {
    evidenceId: `diagnostic:${diagnostic.diagnosticId}`,
    provider: diagnostic.provider,
    confidence: diagnostic.confidence,
    evidenceLevel: diagnostic.evidenceLevel,
    relativePath: diagnostic.relativePath,
    sourceRange: diagnostic.sourceRange,
  }, diagnostic);
}

function isContainer(kind: CodeSymbolKind): boolean {
  return ['package', 'module', 'namespace', 'class', 'interface', 'record', 'struct', 'enum', 'trait', 'impl']
    .includes(kind);
}

function inferredCapability(symbols: readonly SymbolRecord[], languageId: LanguageId): LanguageCapabilityLevel {
  return symbols.some((symbol) => symbol.languageId === languageId && symbol.provider !== 'tree-sitter')
    ? 'semantic'
    : 'structural';
}

function sameScope(
  expected: RepositoryRevisionScope,
  result: RepositoryRevisionScope,
): void {
  if (result.repositoryId !== expected.repositoryId || result.analysisRevision !== expected.analysisRevision) {
    throw new Error('Semantic provider returned evidence for a different analysis revision.');
  }
}

function assertSemanticEvidence<T>(
  scope: RepositoryRevisionScope,
  provider: SemanticProvider,
  result: SemanticEvidenceResult<T>,
): void {
  sameScope(scope, result);
  if (result.provider !== provider.provider || result.evidenceLevel !== 'semantic') {
    throw new Error('Definition/reference results must be semantic evidence from their declared provider.');
  }
  if (result.relativePath === null || result.sourceRange === null) {
    throw new Error('Definition/reference semantic evidence must identify a repository-relative source range.');
  }
  assertRelativePath(result.relativePath);
  assertSourceRange(result.sourceRange, 'Semantic evidence');
}

function assertSourceRange(range: SourceRange, label: string): void {
  const positions = [range.startLine, range.startColumn, range.endLine, range.endColumn];
  if (!positions.every((position) => Number.isInteger(position) && position >= 1)) {
    throw new Error(`${label} must use positive one-based source coordinates.`);
  }
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endColumn <= range.startColumn)
  ) {
    throw new Error(`${label} must use a non-empty end-exclusive source range.`);
  }
}

function assertDefinitionEvidence(
  scope: RepositoryRevisionScope,
  provider: SemanticProvider,
  result: SemanticEvidenceResult<DefinitionLocation>,
): void {
  assertSemanticEvidence(scope, provider, result);
  const symbol = result.value.symbol;
  sameScope(scope, symbol);
  assertRelativePath(symbol.relativePath);
  assertSourceRange(symbol.sourceRange, 'Definition symbol');
}

function assertReferenceEvidence(
  scope: RepositoryRevisionScope,
  provider: SemanticProvider,
  result: SemanticEvidenceResult<ReferenceLocation>,
): void {
  assertSemanticEvidence(scope, provider, result);
  const reference = result.value;
  assertRelativePath(reference.relativePath);
  assertSourceRange(reference.sourceRange, 'Reference location');
  // The nested reference is the source fact returned to an Agent; it must
  // agree with the outer semantic envelope rather than point elsewhere.
  if (
    reference.relativePath !== result.relativePath ||
    reference.sourceRange.startLine !== result.sourceRange!.startLine ||
    reference.sourceRange.startColumn !== result.sourceRange!.startColumn ||
    reference.sourceRange.endLine !== result.sourceRange!.endLine ||
    reference.sourceRange.endColumn !== result.sourceRange!.endColumn
  ) {
    throw new Error('Reference location must match its semantic evidence envelope.');
  }
}

function lineColumnOffset(text: string, line: number, column: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) return null;
  let cursor = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = text.indexOf('\n', cursor);
    if (next === -1) return null;
    cursor = next + 1;
    currentLine += 1;
  }
  const lineEnd = text.indexOf('\n', cursor);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return cursor + column - 1 <= end ? cursor + column - 1 : null;
}

function sourceRangeForFile(text: string): SourceRange {
  const lines = text.split('\n');
  const lastLine = Math.max(1, lines.length);
  const last = lines[lastLine - 1] ?? '';
  return { startLine: 1, startColumn: 1, endLine: lastLine, endColumn: last.length + 1 };
}

function excerpt(text: string, range: SourceRange | undefined, maxChars: number): { text: string; truncated: boolean; range: SourceRange } | null {
  const selectedRange = range ?? sourceRangeForFile(text);
  const start = lineColumnOffset(text, selectedRange.startLine, selectedRange.startColumn);
  const end = lineColumnOffset(text, selectedRange.endLine, selectedRange.endColumn);
  if (start === null || end === null || end <= start) return null;
  const selected = text.slice(start, end);
  return {
    text: selected.slice(0, maxChars),
    truncated: selected.length > maxChars,
    range: selectedRange,
  };
}

/**
 * Revision-scoped read model used by MCP, agents, and webviews. It owns no
 * filesystem or database capability beyond the injected store and refuses to
 * synthesize a semantic definition/reference from Tree-sitter facts.
 */
export class SemanticQueryService implements SemanticQueryPort {
  readonly #semanticProviders: readonly SemanticProvider[];
  readonly #languageCapabilities: ReadonlyMap<LanguageId, LanguageCapabilityLevel>;

  constructor(
    private readonly store: IndexStore,
    options: SemanticQueryServiceOptions = {},
  ) {
    this.#semanticProviders = options.semanticProviders ?? [];
    this.#languageCapabilities = options.languageCapabilities ?? new Map();
  }

  async listRepositories(request: ListRepositoriesRequest = {}, signal?: AbortSignal): Promise<ListRepositoriesResult> {
    signal?.throwIfAborted();
    const roles = request.roles ? new Set(request.roles) : null;
    const repositories = (await this.store.listRepositories())
      .filter((repository) => !roles || roles.has(repository.role))
      .map(({ localPath: _localPath, ...repository }) => ({
        ...repository,
        analysisRevision: repository.activeRevision,
      }));
    return { repositories };
  }

  async getRepositoryOverview(
    request: GetRepositoryOverviewRequest,
    signal?: AbortSignal,
  ): Promise<GetRepositoryOverviewResult> {
    const { repository, revision, index } = await this.#scope(request, signal);
    const languageIds = [...new Set(index.files.flatMap((file) => file.languageId ? [file.languageId] : []))]
      .sort((left, right) => left.localeCompare(right));
    const semanticProviders = await this.#availableSemanticProviders(request, signal, 'findDefinition');
    const overview = {
      repository: (() => {
        const { localPath: _localPath, ...safe } = repository;
        return safe;
      })(),
      revision,
      projectCount: index.projects.length,
      fileCount: index.files.length,
      symbolCount: index.symbols.length,
      dependencyCount: index.dependencyEdges.length,
      diagnosticCount: index.diagnostics.length,
      languages: languageIds.map((languageId) => ({
        languageId,
        capabilityLevel: semanticProviders.some((provider) =>
          !provider.supportedLanguageIds || provider.supportedLanguageIds.includes(languageId),
        )
          ? 'semantic'
          : this.#languageCapabilities.get(languageId) ?? inferredCapability(index.symbols, languageId),
        fileCount: index.files.filter((file) => file.languageId === languageId).length,
      })),
    };
    return {
      overview: sourceEnvelope(request, {
        evidenceId: `revision:${request.repositoryId}:${request.analysisRevision}`,
        provider: 'tree-sitter',
        confidence: 1,
        evidenceLevel: 'structural',
        relativePath: null,
        sourceRange: null,
      }, overview),
    };
  }

  async listProjects(request: ListProjectsRequest, signal?: AbortSignal): Promise<ListProjectsResult> {
    const { index } = await this.#scope(request, signal);
    return { projects: index.projects.map((project) => projectResult(request, {
      ...project,
      files: index.files.filter((file) => file.projectId === project.projectId)
        .map(({ relativePath, role, parseStatus }) => ({ relativePath, role, parseStatus })),
    })) };
  }

  async getFileStructure(
    request: GetFileStructureRequest,
    signal?: AbortSignal,
  ): Promise<GetFileStructureResult> {
    const { index } = await this.#scope(request, signal);
    const relativePath = normalizePath(request.relativePath);
    const file = index.files.find((entry) => entry.relativePath === relativePath);
    if (!file) return { file: null };
    const declarations = index.symbols.filter((symbol) => symbol.relativePath === relativePath);
    const structure: FileStructure = {
      file,
      containers: declarations.filter((symbol) => isContainer(symbol.kind)),
      declarations,
      imports: index.dependencyEdges.filter((edge) => edge.sourceRelativePath === relativePath && edge.kind === 'import'),
      exports: index.dependencyEdges.filter((edge) => edge.sourceRelativePath === relativePath && edge.kind === 'export'),
      diagnostics: index.diagnostics.filter((diagnostic) => diagnostic.relativePath === relativePath),
    };
    return {
      file: sourceEnvelope(request, {
        evidenceId: `file:${file.fileId}`,
        provider: 'tree-sitter',
        confidence: file.parseStatus === 'parsed' ? 1 : 0.5,
        evidenceLevel: 'structural',
        relativePath,
        sourceRange: null,
      }, structure),
    };
  }

  async searchSymbols(request: SearchSymbolsRequest, signal?: AbortSignal): Promise<SearchSymbolsResult> {
    const { index } = await this.#scope(request, signal);
    const query = request.query.trim().toLocaleLowerCase();
    if (!query) throw new Error('Symbol search query must not be empty.');
    const languageIds = request.languageIds ? new Set(request.languageIds) : null;
    const kinds = request.kinds ? new Set(request.kinds) : null;
    const projectIds = request.projectIds ? new Set(request.projectIds) : null;
    const pathPrefix = request.relativePathPrefix ? normalizePath(request.relativePathPrefix) : null;
    const matches = index.symbols
      .filter((symbol) => {
        const haystack = `${symbol.name}\n${symbol.qualifiedName}\n${symbol.signature ?? ''}`.toLocaleLowerCase();
        return haystack.includes(query)
          && (!languageIds || languageIds.has(symbol.languageId))
          && (!kinds || kinds.has(symbol.kind))
          && (!projectIds || (symbol.projectId !== undefined && projectIds.has(symbol.projectId)))
          && (!pathPrefix || symbol.relativePath.startsWith(pathPrefix));
      })
      .sort((left, right) => left.symbolKey.localeCompare(right.symbolKey));
    // SeekDB's projection is an accelerator only. It supplies relevance order
    // by full-text/vector search; this read model still maps every hit back to
    // the authoritative, revision-scoped structural symbol before returning
    // it, and retains a deterministic structural fallback when no projection
    // is available (e.g. in-memory tests or a just-created revision).
    const projection = await this.store.searchSearchDocuments?.(
      request,
      query,
      Math.min(request.limit ?? MAX_LIMIT, MAX_LIMIT),
    ) ?? [];
    const matchesByKey = new Map(matches.map((symbol) => [symbol.symbolKey, symbol]));
    const ranked = projection
      .flatMap((document) => document.kind === 'symbol' && document.symbolKey
        ? [matchesByKey.get(document.symbolKey)]
        : [])
      .filter((symbol): symbol is SymbolRecord => symbol !== undefined);
    const rankedKeys = new Set(ranked.map((symbol) => symbol.symbolKey));
    const ordered = [...ranked, ...matches.filter((symbol) => !rankedKeys.has(symbol.symbolKey))];
    const page = paginate(ordered, request.limit, request.cursor);
    return { symbols: page.values.map((symbol) => symbolResult(request, symbol)), ...('nextCursor' in page ? { nextCursor: page.nextCursor } : {}) };
  }

  async getSymbol(request: GetSymbolRequest, signal?: AbortSignal): Promise<GetSymbolResult> {
    const { index } = await this.#scope(request, signal);
    const symbol = index.symbols.find((entry) => entry.symbolKey === request.symbolKey);
    return { symbol: symbol ? symbolResult(request, symbol) : null };
  }

  async findDefinition(request: FindDefinitionRequest, signal?: AbortSignal): Promise<FindDefinitionResult> {
    await this.#scope(request, signal);
    assertRelativePath(request.relativePath);
    const available = await this.#availableSemanticProviders(request, signal, 'findDefinition');
    if (available.length === 0) {
      return {
        availability: 'unavailable',
        reason: 'No LSP or specialized semantic provider is available for this revision.',
        definitions: [],
      };
    }
    const definitions = (await Promise.all(available.map(async (provider) => {
      const results = await provider.findDefinition!(request, signal);
      results.forEach((result) => assertDefinitionEvidence(request, provider, result));
      return results;
    }))).flat();
    return { availability: 'available', definitions };
  }

  async findReferences(request: FindReferencesRequest, signal?: AbortSignal): Promise<FindReferencesResult> {
    await this.#scope(request, signal);
    const available = await this.#availableSemanticProviders(request, signal, 'findReferences');
    if (available.length === 0) return { availability: 'unavailable', reason: 'No LSP or specialized semantic provider is available for this revision.', references: [] };
    const references = (await Promise.all(available.map(async (provider) => {
      const results = await provider.findReferences!(request, signal);
      results.forEach((result) => assertReferenceEvidence(request, provider, result));
      return results;
    }))).flat();
    const sorted = references.sort((left, right) => `${left.relativePath}:${left.evidenceId}`.localeCompare(`${right.relativePath}:${right.evidenceId}`));
    const page = paginate(sorted, request.limit, request.cursor);
    return { availability: 'available', references: page.values, ...('nextCursor' in page ? { nextCursor: page.nextCursor } : {}) };
  }

  async getDependencies(request: GetDependenciesRequest, signal?: AbortSignal): Promise<GetDependenciesResult> {
    const { index } = await this.#scope(request, signal);
    if (!request.symbolKey && !request.relativePath && !request.projectId) {
      throw new Error('Dependency queries require symbolKey, relativePath, or projectId.');
    }
    const relativePath = request.relativePath ? normalizePath(request.relativePath) : undefined;
    const projectFiles = request.projectId
      ? new Set(index.files.filter((file) => file.projectId === request.projectId).map((file) => file.relativePath))
      : null;
    const direction = request.direction ?? 'both';
    const kinds = request.kinds ? new Set(request.kinds) : null;
    const resolutions = request.resolution ? new Set(request.resolution) : null;
    const matches = index.dependencyEdges.filter((edge) => {
      const sourceMatches = (!request.symbolKey || edge.sourceSymbolKey === request.symbolKey)
        && (!relativePath || edge.sourceRelativePath === relativePath)
        && (!projectFiles || projectFiles.has(edge.sourceRelativePath));
      const targetMatches = (!request.symbolKey || edge.targetSymbolKey === request.symbolKey)
        && (!relativePath || edge.targetRelativePath === relativePath)
        && (!projectFiles || (edge.targetRelativePath !== undefined && projectFiles.has(edge.targetRelativePath)));
      const directionMatches = direction === 'incoming' ? targetMatches : direction === 'outgoing' ? sourceMatches : sourceMatches || targetMatches;
      return directionMatches && (!kinds || kinds.has(edge.kind)) && (!resolutions || resolutions.has(edge.resolution));
    }).sort((left, right) => left.dependencyEdgeId.localeCompare(right.dependencyEdgeId));
    const page = paginate(matches, request.limit, request.cursor);
    return { dependencies: page.values.map((edge) => edgeResult(request, edge)), ...('nextCursor' in page ? { nextCursor: page.nextCursor } : {}) };
  }

  async getDiagnostics(request: GetDiagnosticsRequest, signal?: AbortSignal): Promise<GetDiagnosticsResult> {
    const { index } = await this.#scope(request, signal);
    const relativePath = request.relativePath ? normalizePath(request.relativePath) : undefined;
    const severities = request.severities ? new Set(request.severities) : null;
    const providers = request.providers ? new Set(request.providers) : null;
    const matches = index.diagnostics
      .filter((diagnostic) => (!relativePath || diagnostic.relativePath === relativePath)
        && (!severities || severities.has(diagnostic.severity))
        && (!providers || providers.has(diagnostic.provider)))
      .sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId));
    const page = paginate(matches, request.limit, request.cursor);
    return { diagnostics: page.values.map((diagnostic) => diagnosticResult(request, diagnostic)), ...('nextCursor' in page ? { nextCursor: page.nextCursor } : {}) };
  }

  async readSourceExcerpt(
    request: ReadSourceExcerptRequest,
    signal?: AbortSignal,
  ): Promise<ReadSourceExcerptResult> {
    const { index } = await this.#scope(request, signal);
    const relativePath = normalizePath(request.relativePath);
    const file = index.files.find((entry) => entry.relativePath === relativePath);
    if (!file) return { excerpt: null };
    const source = await this.store.getSourceText(request, relativePath);
    if (source === null) return { excerpt: null };
    const maxChars = request.maxChars ?? MAX_EXCERPT_CHARS;
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_EXCERPT_CHARS) {
      throw new Error(`maxChars must be an integer between 1 and ${MAX_EXCERPT_CHARS}.`);
    }
    const selected = excerpt(source, request.sourceRange, maxChars);
    if (!selected) throw new Error('Requested source range is outside the indexed source file.');
    return {
      excerpt: sourceEnvelope(request, {
        evidenceId: `file:${file.fileId}`,
        provider: 'tree-sitter',
        confidence: file.parseStatus === 'parsed' ? 1 : 0.5,
        evidenceLevel: 'structural',
        relativePath,
        sourceRange: selected.range,
      }, { text: selected.text, truncated: selected.truncated }),
    };
  }

  async #scope(
    scope: RepositoryRevisionScope,
    signal?: AbortSignal,
  ): Promise<{ repository: Awaited<ReturnType<IndexStore['getRepository']>> & {}; revision: AnalysisRevisionRecord; index: Awaited<ReturnType<IndexStore['getStructuralIndex']>> & {} }> {
    signal?.throwIfAborted();
    if (!isRepositoryRevisionScope(scope)) throw new Error('Every semantic query requires a valid repositoryId and analysisRevision.');
    const [repository, revision, index] = await Promise.all([
      this.store.getRepository(scope.repositoryId),
      this.store.getRevision(scope),
      this.store.getStructuralIndex(scope),
    ]);
    if (!repository || !revision || !index) throw new Error('Repository analysis revision was not found.');
    if (revision.status !== 'ready' && revision.status !== 'superseded') {
      throw new Error('Repository analysis revision is not ready for read-only queries.');
    }
    return { repository, revision, index };
  }

  async #availableSemanticProviders(
    scope: RepositoryRevisionScope,
    signal: AbortSignal | undefined,
    operation: 'findDefinition' | 'findReferences',
  ): Promise<SemanticProvider[]> {
    const candidates = this.#semanticProviders.filter((provider) => provider[operation] !== undefined);
    const availability = await Promise.all(candidates.map(async (provider) => ({
      provider,
      status: await provider.isAvailable(scope, signal),
    })));
    return availability.filter((entry) => entry.status.available).map((entry) => entry.provider);
  }
}

export const semanticQueryInternals = {
  boundedLimit,
  decodeCursor,
  encodeCursor,
  excerpt,
  lineColumnOffset,
  normalizePath,
  paginate,
};
