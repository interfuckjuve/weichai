import { resolveCrossLanguageBindings } from './cross-language-bindings.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AnalysisRevisionId,
  DependencyEdgeRecord,
  IndexedFileRecord,
  IndexedFileRole,
  IndexDiagnosticRecord,
  LanguageId,
  RepositoryId,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import {
  createDefaultLanguageRegistry,
  type LanguageRegistry,
} from './language-registry.js';
import {
  discoverProjects,
  projectForPath,
} from './project-discovery.js';
import {
  resolveSyntacticDependencies,
  syntacticDependencyCandidatePaths,
} from './syntactic-dependency-resolver.js';
import {
  indexTreeSitterFile,
  type TreeSitterDiagnostic,
  type TreeSitterExport,
  type TreeSitterFileIndex,
  type TreeSitterImport,
  type TreeSitterIndexRequest,
} from './tree-sitter-indexer.js';

export interface StructuralSourceFile {
  content: string;
  relativePath: string;
  sha256?: string;
  sizeBytes?: number;
  unavailableReason?: string;
}

export interface BuildStructuralIndexRequest {
  analysisRevision: AnalysisRevisionId;
  /**
   * Optional changed paths are advisory scan metadata. The caller owns the
   * diff calculation; this pure builder never touches the filesystem.
   */
  changedPaths?: readonly string[];
  files: readonly StructuralSourceFile[];
  /** Filesystem scans use lazy, immutable file contents and retain only facts. */
  retainSourceTexts?: boolean;
  signal?: AbortSignal;
  /** Optional test/host seam; normal callers use the real Tree-sitter indexer. */
  indexFile?: (request: TreeSitterIndexRequest) => TreeSitterFileIndex;
  languageRegistry?: LanguageRegistry;
  /** A completed prior structural revision of the same repository. */
  previousIndex?: StructuralIndex;
  repositoryId: RepositoryId;
}

/**
 * The immutable index is paired with an in-memory, revision-bound source map.
 * Persistence can use this map to write bounded excerpts without reopening a
 * mutable checkout after the scan completed.
 */
export interface StructuralIndexBuild {
  changedPaths?: string[];
  index: StructuralIndex;
  sourceFiles: ReadonlyMap<string, string>;
  sourceReader?: { read(relativePath: string): Promise<string | null>; dispose(): Promise<void> };
  stats: StructuralIndexBuildStats;
}

export interface StructuralIndexBuildStats {
  parserResources?: { peakWorkerRss: number; peakCombinedRss: number; workers: number };
  changedFileCount: number;
  reparsedFileCount: number;
  rebuiltDependencyEdgeCount: number;
  reusedDependencyEdgeCount: number;
  reusedFileCount: number;
}

interface IndexedSource {
  file: IndexedFileRecord;
  parserResult?: TreeSitterFileIndex;
  reused: boolean;
}

const configurationFileNames = new Set([
  'cmakelists.txt',
  'compile_commands.json',
  'oh-package.json5',
  'build-profile.json5',
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Structural index paths must be non-empty repository-relative paths: ${value}`);
  }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) {
    throw new Error(`Structural index paths must not be absolute: ${value}`);
  }
  return normalized;
}

function basename(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}

function isConfigurationPath(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return configurationFileNames.has(name) || /\.(?:csproj|sln)$/i.test(relativePath);
}

function isTestPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const name = basename(normalized);
  return (
    normalized.split('/').some((part) => part === 'test' || part === 'tests' || part === '__tests__') ||
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx') ||
    name.endsWith('.spec.ts') ||
    name.endsWith('.spec.tsx') ||
    name.endsWith('_test.go') ||
    name.startsWith('test_') ||
    name.endsWith('_test.py') ||
    name.endsWith('test.java') ||
    name.endsWith('tests.java') ||
    name.endsWith('tests.cs')
  );
}

function isGeneratedPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  const name = basename(normalized);
  return (
    normalized.split('/').some((part) => ['generated', 'generated-sources', 'autogen'].includes(part)) ||
    name.endsWith('.g.cs') ||
    name.endsWith('.generated.cs') ||
    name.endsWith('.designer.cs') ||
    name.endsWith('.assemblyinfo.cs')
  );
}

function roleForPath(relativePath: string, languageId?: LanguageId): IndexedFileRole {
  if (isConfigurationPath(relativePath)) return 'configuration';
  if (!languageId) return 'other';
  if (isGeneratedPath(relativePath)) return 'generated';
  if (isTestPath(relativePath)) return 'test';
  return 'source';
}

function fileId(repositoryId: RepositoryId, analysisRevision: AnalysisRevisionId, relativePath: string): string {
  return `file-${hash(JSON.stringify({ repositoryId, analysisRevision, relativePath })).slice(0, 24)}`;
}

function symbolId(repositoryId: RepositoryId, analysisRevision: AnalysisRevisionId, symbolKey: string): string {
  return `symbol-${hash(JSON.stringify({ repositoryId, analysisRevision, symbolKey })).slice(0, 24)}`;
}

function diagnosticId(
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
  diagnostic: Pick<IndexDiagnosticRecord, 'code' | 'message' | 'relativePath' | 'sourceRange' | 'provider'>,
): string {
  return `diagnostic-${hash(JSON.stringify({ repositoryId, analysisRevision, ...diagnostic })).slice(0, 24)}`;
}

function toDiagnostic(
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
  source: TreeSitterDiagnostic,
): IndexDiagnosticRecord {
  const base = {
    code: source.code,
    message: source.message,
    relativePath: source.relativePath,
    sourceRange: source.sourceRange ?? null,
    provider: 'tree-sitter' as const,
  };
  return {
    repositoryId,
    analysisRevision,
    diagnosticId: diagnosticId(repositoryId, analysisRevision, base),
    severity: source.severity,
    ...base,
    confidence: 0.75,
    evidenceLevel: 'structural',
  };
}

function failureDiagnostic(
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
  relativePath: string,
  error: unknown,
): IndexDiagnosticRecord {
  const base = {
    code: 'TREE_SITTER_INDEX_FAILURE',
    message: `Tree-sitter indexing failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000),
    relativePath,
    sourceRange: null,
    provider: 'tree-sitter' as const,
  };
  return {
    repositoryId,
    analysisRevision,
    diagnosticId: diagnosticId(repositoryId, analysisRevision, base),
    severity: 'warning',
    ...base,
    confidence: 0.1,
    evidenceLevel: 'unresolved',
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function analysisHash(input: {
  dependencyEdges: StructuralIndex['dependencyEdges'];
  diagnostics: StructuralIndex['diagnostics'];
  files: StructuralIndex['files'];
  projects: StructuralIndex['projects'];
  symbols: StructuralIndex['symbols'];
}): string {
  // Revision-local IDs and scope must not affect a content-addressed analysis
  // hash. The records themselves retain scope for storage/query isolation.
  const withoutScope = (entry: object, keys: readonly string[]): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...entry };
    for (const key of keys) delete copy[key];
    return copy;
  };
  const digest = createHash('sha256');
  const ids: Record<keyof typeof input, string | undefined> = {
    dependencyEdges: 'dependencyEdgeId', diagnostics: 'diagnosticId', files: 'fileId', projects: undefined, symbols: 'symbolId',
  };
  digest.update('{');
  let first = true;
  for (const name of Object.keys(ids).sort() as Array<keyof typeof input>) {
    const omitted = ['repositoryId', 'analysisRevision', ...(ids[name] ? [ids[name]!] : [])];
    const encoded = input[name].map((entry) => canonicalJson(withoutScope(entry, omitted))).sort(compareText);
    digest.update(`${first ? '' : ','}${JSON.stringify(name)}:[`);
    encoded.forEach((entry, index) => { if (index) digest.update(','); digest.update(entry); });
    digest.update(']');
    first = false;
  }
  return digest.update('}').digest('hex');
}

function dependencyEdgeId(
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
  edge: Pick<DependencyEdgeRecord, 'kind' | 'sourceRelativePath' | 'targetReference' | 'evidenceRanges'>,
): string {
  const range = edge.evidenceRanges[0];
  return `dependency-${hash(JSON.stringify({
    repositoryId,
    analysisRevision,
    kind: edge.kind,
    sourceRelativePath: edge.sourceRelativePath,
    targetReference: edge.targetReference ?? edge.kind,
    startLine: range?.startLine ?? 0,
    startColumn: range?.startColumn ?? 0,
  })).slice(0, 24)}`;
}

function rangeKey(range: NonNullable<IndexDiagnosticRecord['sourceRange']>): string {
  return `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`;
}

function edgeKey(edge: Pick<DependencyEdgeRecord, 'kind' | 'sourceRelativePath' | 'targetReference' | 'evidenceRanges'>): string {
  const range = edge.evidenceRanges[0];
  return `${edge.kind}\u0000${edge.sourceRelativePath}\u0000${edge.targetReference ?? ''}\u0000${range ? rangeKey(range) : ''}`;
}

function importKey(imported: TreeSitterImport): string {
  return `${imported.importKind === 're-export' ? 'export' : 'import'}\u0000${imported.relativePath}\u0000${imported.targetReference}\u0000${rangeKey(imported.sourceRange)}`;
}

function exportKey(exported: TreeSitterExport): string {
  return `export\u0000${exported.relativePath}\u0000${exported.targetReference ?? ''}\u0000${rangeKey(exported.sourceRange)}`;
}

function projectReferenceKey(reference: {
  sourceRange: NonNullable<IndexDiagnosticRecord['sourceRange']>;
  sourceRelativePath: string;
  targetReference: string;
}): string {
  return `project-reference\u0000${reference.sourceRelativePath}\u0000${reference.targetReference}\u0000${rangeKey(reference.sourceRange)}`;
}

function rehydrateSymbol(
  source: SymbolRecord,
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
  file: IndexedFileRecord,
): SymbolRecord {
  const { repositoryId: _repositoryId, analysisRevision: _analysisRevision, symbolId: _symbolId, projectId: _projectId, ...rest } = source;
  return {
    ...rest,
    repositoryId,
    analysisRevision,
    symbolId: symbolId(repositoryId, analysisRevision, source.symbolKey),
    ...(file.projectId ? { projectId: file.projectId } : {}),
  };
}

function rehydrateDiagnostic(
  source: IndexDiagnosticRecord,
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
): IndexDiagnosticRecord {
  const { repositoryId: _repositoryId, analysisRevision: _analysisRevision, diagnosticId: _diagnosticId, ...rest } = source;
  return {
    ...rest,
    repositoryId,
    analysisRevision,
    diagnosticId: diagnosticId(repositoryId, analysisRevision, rest),
  };
}

function rehydrateEdge(
  source: DependencyEdgeRecord,
  repositoryId: RepositoryId,
  analysisRevision: AnalysisRevisionId,
): DependencyEdgeRecord {
  const { repositoryId: _repositoryId, analysisRevision: _analysisRevision, dependencyEdgeId: _dependencyEdgeId, ...rest } = source;
  return {
    ...rest,
    repositoryId,
    analysisRevision,
    dependencyEdgeId: dependencyEdgeId(repositoryId, analysisRevision, rest),
  };
}

function importFromEdge(
  edge: DependencyEdgeRecord,
  file: IndexedFileRecord | undefined,
): TreeSitterImport | undefined {
  const range = edge.evidenceRanges[0];
  if (!file?.languageId || !range || !edge.targetReference || edge.kind !== 'import') return undefined;
  if (!['arkts', 'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'python', 'rust', 'typescript'].includes(file.languageId)) return undefined;
  return {
    importKind: 'import',
    languageId: file.languageId as TreeSitterImport['languageId'],
    relativePath: edge.sourceRelativePath,
    sourceRange: range,
    targetReference: edge.targetReference,
  };
}

function exportFromEdge(
  edge: DependencyEdgeRecord,
  file: IndexedFileRecord | undefined,
): TreeSitterExport | undefined {
  const range = edge.evidenceRanges[0];
  if (edge.kind !== 'export' || !file?.languageId || !range) return undefined;
  if (!['arkts', 'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'python', 'rust', 'typescript'].includes(file.languageId)) return undefined;
  return {
    exportKind: edge.targetRelativePath ? 're-export' : 'declaration',
    languageId: file.languageId as TreeSitterExport['languageId'],
    relativePath: edge.sourceRelativePath,
    sourceRange: range,
    ...(edge.targetReference ? { targetReference: edge.targetReference } : {}),
  };
}

function importForExport(exported: TreeSitterExport): TreeSitterImport | undefined {
  if (exported.exportKind !== 're-export' || !exported.targetReference) return undefined;
  return {
    importKind: 're-export',
    languageId: exported.languageId,
    relativePath: exported.relativePath,
    sourceRange: exported.sourceRange,
    targetReference: exported.targetReference,
  };
}

function edgeNeedsRebuild(input: {
  changedPaths: ReadonlySet<string>;
  changedLanguageIds: ReadonlySet<LanguageId>;
  currentFilesByPath: ReadonlyMap<string, IndexedFileRecord>;
  edge: DependencyEdgeRecord;
  previousFilesByPath: ReadonlyMap<string, IndexedFileRecord>;
}): boolean {
  const { changedPaths, currentFilesByPath, edge, previousFilesByPath } = input;
  if (changedPaths.has(edge.sourceRelativePath) || (edge.targetRelativePath && changedPaths.has(edge.targetRelativePath))) {
    return true;
  }
  if (edge.kind === 'project-reference') return false;
  if (edge.kind !== 'import' && edge.kind !== 'export') return false;
  const source = currentFilesByPath.get(edge.sourceRelativePath) ?? previousFilesByPath.get(edge.sourceRelativePath);
  const exported = exportFromEdge(edge, source);
  const imported = importFromEdge(edge, source) ?? (exported ? importForExport(exported) : undefined);
  if (!imported) return false;
  if (['java', 'kotlin'].includes(imported.languageId) && (input.changedLanguageIds.has('java') || input.changedLanguageIds.has('kotlin')) || imported.languageId === 'csharp' && input.changedLanguageIds.has('csharp')) {
    return true;
  }
  return syntacticDependencyCandidatePaths(imported).some((candidate) => changedPaths.has(candidate));
}

/**
 * Build a complete structural revision from an immutable source snapshot. It
 * deliberately has no filesystem access, allowing a coordinator to retain
 * the exact text it scanned and avoid a time-of-check/time-of-use reread.
 */
export function buildStructuralIndex(request: BuildStructuralIndexRequest): StructuralIndexBuild {
  const registry = request.languageRegistry ?? createDefaultLanguageRegistry();
  const sourceFiles = new Map<string, string>();
  const sources = new Map<string, StructuralSourceFile>();
  for (const source of request.files) {
    const relativePath = canonicalPath(source.relativePath);
    if (sources.has(relativePath)) throw new Error(`Structural index input has duplicate path: ${relativePath}`);
    sources.set(relativePath, source);
    if (request.retainSourceTexts !== false && !source.unavailableReason) sourceFiles.set(relativePath, source.content);
  }

  const previous = request.previousIndex;
  if (previous && previous.repositoryId !== request.repositoryId) {
    throw new Error('An incremental structural index must use a previous revision from the same repository.');
  }
  const previousFilesByPath = new Map((previous?.files ?? []).map((file) => [file.relativePath, file]));
  const suppliedChanges = new Set((request.changedPaths ?? []).map(canonicalPath));
  const changed = new Set(suppliedChanges);
  for (const [relativePath, source] of sources) {
    request.signal?.throwIfAborted();
    if (previousFilesByPath.get(relativePath)?.sha256 !== (source.sha256 ?? hash(Buffer.from(source.content, 'utf8')))) {
      changed.add(relativePath);
    }
  }
  for (const relativePath of previousFilesByPath.keys()) {
    if (!sources.has(relativePath)) changed.add(relativePath);
  }
  const changedPaths = [...changed].sort(compareText);
  const changedPathSet = new Set(changedPaths);

  const discovery = discoverProjects({
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    files: [...sources.entries()].map(([relativePath, source]) => ({
      relativePath,
      content: isConfigurationPath(relativePath) ? source.content : '',
      languageId: registry.resolvePath(relativePath)?.languageId,
    })),
  });

  const diagnostics: IndexDiagnosticRecord[] = [];
  const indexed: IndexedSource[] = [];
  const previousSymbolsByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of previous?.symbols ?? []) {
    if (symbol.provider !== 'tree-sitter') continue;
    const values = previousSymbolsByPath.get(symbol.relativePath) ?? [];
    values.push(symbol);
    previousSymbolsByPath.set(symbol.relativePath, values);
  }
  const previousDiagnosticsByPath = new Map<string, IndexDiagnosticRecord[]>();
  for (const diagnostic of previous?.diagnostics ?? []) {
    if (diagnostic.provider !== 'tree-sitter' || diagnostic.relativePath === null) continue;
    const values = previousDiagnosticsByPath.get(diagnostic.relativePath) ?? [];
    values.push(diagnostic);
    previousDiagnosticsByPath.set(diagnostic.relativePath, values);
  }
  const indexFile = request.indexFile ?? indexTreeSitterFile;
  let reparsedFileCount = 0;
  let reusedFileCount = 0;
  for (const [relativePath, source] of [...sources.entries()].sort(([left], [right]) => compareText(left, right))) {
    request.signal?.throwIfAborted();
    const registration = registry.resolvePath(relativePath);
    const project = projectForPath(discovery.projects, relativePath, registration?.languageId);
    const record: IndexedFileRecord = {
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
      fileId: fileId(request.repositoryId, request.analysisRevision, relativePath),
      relativePath,
      ...(registration ? { languageId: registration.languageId } : {}),
      role: roleForPath(relativePath, registration?.languageId),
      sha256: source.sha256 ?? hash(Buffer.from(source.content, 'utf8')),
      sizeBytes: source.sizeBytes ?? Buffer.byteLength(source.content, 'utf8'),
      parseStatus: registration ? 'parsed' : 'unsupported',
      ...(project ? { projectId: project.projectId } : {}),
    };
    if (source.unavailableReason) {
      record.parseStatus = 'failed';
      const diagnostic = failureDiagnostic(request.repositoryId, request.analysisRevision, relativePath, new Error(source.unavailableReason));
      diagnostic.code = 'SOURCE_CONTENT_UNAVAILABLE';
      diagnostics.push(diagnostic);
      indexed.push({ file: record, reused: false });
      continue;
    }
    const previousFile = previousFilesByPath.get(relativePath);
    const reuse = Boolean(
      previousFile &&
      previousFile.parseStatus !== 'failed' &&
      previousFile.sha256 === record.sha256 &&
      !changedPathSet.has(relativePath),
    );
    if (!registration) {
      if (reuse) {
        record.parseStatus = previousFile?.parseStatus ?? record.parseStatus;
        reusedFileCount += 1;
      }
      indexed.push({ file: record, reused: reuse });
      continue;
    }
    if (reuse) {
      record.parseStatus = previousFile?.parseStatus ?? record.parseStatus;
      diagnostics.push(...(previousDiagnosticsByPath.get(relativePath) ?? []).map((diagnostic) =>
        rehydrateDiagnostic(diagnostic, request.repositoryId, request.analysisRevision),
      ));
      indexed.push({ file: record, reused: true });
      reusedFileCount += 1;
      continue;
    }
    try {
      const parserResult = indexFile({ content: source.content, language: registration, relativePath });
      reparsedFileCount += 1;
      if (parserResult.diagnostics.length > 0) record.parseStatus = 'partial';
      diagnostics.push(...parserResult.diagnostics.map((diagnostic) =>
        toDiagnostic(request.repositoryId, request.analysisRevision, diagnostic),
      ));
      indexed.push({ file: record, parserResult, reused: false });
    } catch (error) {
      reparsedFileCount += 1;
      record.parseStatus = 'failed';
      diagnostics.push(failureDiagnostic(request.repositoryId, request.analysisRevision, relativePath, error));
      indexed.push({ file: record, reused: false });
    }
  }

  const symbols: SymbolRecord[] = indexed
    .flatMap(({ file, parserResult, reused }) => {
      if (reused) {
        return (previousSymbolsByPath.get(file.relativePath) ?? []).map((symbol) =>
          rehydrateSymbol(symbol, request.repositoryId, request.analysisRevision, file),
        );
      }
      return (parserResult?.declarations ?? []).map((declaration): SymbolRecord => ({
        repositoryId: request.repositoryId,
        analysisRevision: request.analysisRevision,
        symbolId: symbolId(request.repositoryId, request.analysisRevision, declaration.symbolKey),
        symbolKey: declaration.symbolKey,
        astDeclarationId: declaration.astDeclarationId,
        name: declaration.name,
        qualifiedName: declaration.qualifiedName,
        kind: declaration.kind === 'implementation' ? 'impl' : declaration.kind,
        languageId: file.languageId ?? 'unknown',
        relativePath: declaration.relativePath,
        sourceRange: declaration.sourceRange,
        signature: declaration.signature || undefined,
        ...(declaration.containerSymbolKey ? { containerSymbolKey: declaration.containerSymbolKey } : {}),
        ...(file.projectId ? { projectId: file.projectId } : {}),
        exported: declaration.isExported,
        provider: 'tree-sitter',
        confidence: 0.75,
        evidenceLevel: 'structural',
      }));
    })
    .sort((left, right) => compareText(left.symbolKey, right.symbolKey));

  const currentFiles = indexed.map(({ file }) => file);
  const currentFilesByPath = new Map(currentFiles.map((file) => [file.relativePath, file]));
  const changedLanguageIds = new Set<LanguageId>(changedPaths.flatMap((relativePath) => {
    const file = currentFilesByPath.get(relativePath) ?? previousFilesByPath.get(relativePath);
    return file?.languageId ? [file.languageId] : [];
  }));
  const previousEdges = (previous?.dependencyEdges ?? []).filter((edge) => edge.provider === 'tree-sitter' && !edge.kind.endsWith('-binding'));
  const previousEdgeByKey = new Map(previousEdges.map((edge) => [edgeKey(edge), edge]));
  const currentImports: TreeSitterImport[] = [];
  const currentExports: TreeSitterExport[] = [];
  const currentEdgeKeys = new Set<string>();
  for (const source of indexed) {
    if (source.parserResult) {
      for (const imported of source.parserResult.imports) {
        currentImports.push(imported);
        currentEdgeKeys.add(importKey(imported));
      }
      for (const exported of source.parserResult.exports) {
        currentExports.push(exported);
        currentEdgeKeys.add(exportKey(exported));
      }
      continue;
    }
    if (!source.reused) continue;
    for (const edge of previousEdges.filter((candidate) => candidate.sourceRelativePath === source.file.relativePath)) {
      const imported = importFromEdge(edge, source.file);
      if (imported) currentEdgeKeys.add(importKey(imported));
      const exported = exportFromEdge(edge, source.file);
      if (exported) currentEdgeKeys.add(exportKey(exported));
    }
  }
  for (const reference of discovery.projectReferences) currentEdgeKeys.add(projectReferenceKey(reference));

  const needEdgeRebuild = (edge: DependencyEdgeRecord): boolean => edgeNeedsRebuild({
    edge,
    changedPaths: changedPathSet,
    changedLanguageIds,
    currentFilesByPath,
    previousFilesByPath,
  });
  for (const edge of previousEdges) {
    if (!currentFilesByPath.has(edge.sourceRelativePath) || !needEdgeRebuild(edge)) continue;
    // A changed source has just supplied fresh syntax evidence above.  Its
    // prior edges must be discarded, not fed back into resolution, otherwise
    // a removed/renamed import survives into the new immutable revision.
    // Prior evidence is only useful when an unchanged source needs its target
    // rebound because a potential target/project changed.
    if (changedPathSet.has(edge.sourceRelativePath)) continue;
    const source = currentFilesByPath.get(edge.sourceRelativePath);
    const imported = importFromEdge(edge, source);
    if (imported) currentImports.push(imported);
    const exported = exportFromEdge(edge, source);
    if (exported) currentExports.push(exported);
  }
  const currentProjectReferences = discovery.projectReferences.filter((reference) => {
    const previousEdge = previousEdgeByKey.get(projectReferenceKey(reference));
    return !previousEdge || needEdgeRebuild(previousEdge);
  });
  const rebuiltDependencies = resolveSyntacticDependencies({
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    files: currentFiles,
    symbols,
    imports: currentImports,
    exports: currentExports,
    projectReferences: currentProjectReferences,
  });
  const reusedDependencies = previousEdges
    .filter((edge) =>
      currentFilesByPath.has(edge.sourceRelativePath) &&
      currentEdgeKeys.has(edgeKey(edge)) &&
      !needEdgeRebuild(edge),
    )
    .map((edge) => rehydrateEdge(edge, request.repositoryId, request.analysisRevision));
  const bindings = resolveCrossLanguageBindings({ repositoryId: request.repositoryId, analysisRevision: request.analysisRevision,
    files: currentFiles, symbols, signal: request.signal,
    read: relativePath => { const source = sources.get(relativePath); return source && !source.unavailableReason ? source.content : undefined; } });
  const dependencyById = new Map<string, DependencyEdgeRecord>();
  for (const edge of [...reusedDependencies, ...rebuiltDependencies, ...bindings]) dependencyById.set(edge.dependencyEdgeId, edge);
  const dependencies = [...dependencyById.values()].sort((left, right) => compareText(left.dependencyEdgeId, right.dependencyEdgeId));

  const index: StructuralIndex = {
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    analysisHash: analysisHash({
      files: indexed.map(({ file }) => file),
      projects: discovery.projects,
      symbols,
      dependencyEdges: dependencies,
      diagnostics,
    }),
    projects: discovery.projects,
    files: indexed.map(({ file }) => file).sort((left, right) => compareText(left.relativePath, right.relativePath)),
    symbols,
    dependencyEdges: dependencies,
    diagnostics: diagnostics.sort((left, right) => compareText(left.diagnosticId, right.diagnosticId)),
  };

  return {
    index,
    sourceFiles,
    changedPaths,
    stats: {
      changedFileCount: changedPaths.length,
      reparsedFileCount,
      rebuiltDependencyEdgeCount: rebuiltDependencies.length + bindings.length,
      reusedDependencyEdgeCount: reusedDependencies.length,
      reusedFileCount,
    },
  };
}

export const structuralIndexInternals = {
  analysisHash,
  canonicalPath,
  isConfigurationPath,
  isGeneratedPath,
  isTestPath,
  roleForPath,
};
