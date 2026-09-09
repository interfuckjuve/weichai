import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AnalysisRevisionId,
  DependencyEdgeRecord,
  IndexedFileRecord,
  IndexDependencyKind,
  LanguageId,
  RepositoryId,
  SymbolRecord,
} from '@forexplore/contracts';
import type { ProjectReferenceSyntax } from './project-discovery.js';
import type { TreeSitterExport, TreeSitterImport } from './tree-sitter-indexer.js';

export interface SyntacticDependencyResolverRequest {
  analysisRevision: AnalysisRevisionId;
  exports?: readonly TreeSitterExport[];
  files: readonly IndexedFileRecord[];
  imports: readonly TreeSitterImport[];
  projectReferences?: readonly ProjectReferenceSyntax[];
  repositoryId: RepositoryId;
  symbols: readonly SymbolRecord[];
}

interface ResolutionCandidate {
  relativePath: string;
  symbolKey?: string;
}

interface Resolution {
  candidates: ResolutionCandidate[];
  internal: boolean;
  resolution: DependencyEdgeRecord['resolution'];
}

const sourceExtensions: Readonly<Record<string, readonly string[]>> = {
  c: ['.h', '.c'], cpp: ['.h', '.hpp', '.cpp'], kotlin: ['.kt', '.kts'], arkts: ['.ets', '.ts'],
  csharp: ['.cs'],
  go: ['.go'],
  java: ['.java'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx'],
  python: ['.py'],
  rust: ['.rs'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function canonicalPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function stableEdgeId(
  request: SyntacticDependencyResolverRequest,
  kind: IndexDependencyKind,
  sourceRelativePath: string,
  targetReference: string,
  startLine: number,
  startColumn: number,
): string {
  return `dependency-${hash(JSON.stringify({
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    kind,
    sourceRelativePath,
    targetReference,
    startLine,
    startColumn,
  }))}`;
}

function isInsideRepository(relativePath: string): boolean {
  return relativePath !== '..' && !relativePath.startsWith('../') && !path.posix.isAbsolute(relativePath);
}

function relativeCandidates(
  sourceRelativePath: string,
  targetReference: string,
  languageId: LanguageId,
): { candidates: string[]; internal: boolean } {
  if (languageId === 'c' || languageId === 'cpp') {
    if (targetReference.startsWith('<')) return { candidates: [], internal: false };
    const local = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelativePath), targetReference));
    return { candidates: isInsideRepository(local) ? [local] : [], internal: true };
  }
  if (!targetReference.startsWith('.')) return { candidates: [], internal: false };
  const sourceDirectory = path.posix.dirname(canonicalPath(sourceRelativePath));
  const base = path.posix.normalize(path.posix.join(sourceDirectory, targetReference));
  if (!isInsideRepository(base)) return { candidates: [], internal: false };
  const extensions = sourceExtensions[languageId] ?? [];
  const candidates = [base];
  if (!path.posix.extname(base)) {
    for (const extension of extensions) candidates.push(`${base}${extension}`);
    for (const extension of extensions) candidates.push(`${base}/index${extension}`);
    if (languageId === 'python') candidates.push(`${base}/__init__.py`);
  }
  return { candidates: [...new Set(candidates.map(canonicalPath))], internal: true };
}

function pythonCandidates(sourceRelativePath: string, targetReference: string): { candidates: string[]; internal: boolean } {
  if (targetReference.startsWith('.')) {
    const dots = /^\.+/.exec(targetReference)?.[0].length ?? 0;
    const suffix = targetReference.slice(dots).replaceAll('.', '/');
    let base = path.posix.dirname(canonicalPath(sourceRelativePath));
    for (let level = 1; level < dots; level += 1) base = path.posix.dirname(base);
    const target = suffix ? path.posix.join(base, suffix) : base;
    if (!isInsideRepository(target)) return { candidates: [], internal: false };
    return {
      candidates: [`${target}.py`, `${target}/__init__.py`].map(canonicalPath),
      internal: true,
    };
  }
  const target = targetReference.replaceAll('.', '/');
  return {
    candidates: [`${target}.py`, `${target}/__init__.py`].map(canonicalPath),
    internal: false,
  };
}

function rustCandidates(sourceRelativePath: string, targetReference: string): { candidates: string[]; internal: boolean } {
  if (!/^(?:crate|self|super)::/.test(targetReference)) return { candidates: [], internal: false };
  let components = targetReference.split('::');
  let base = path.posix.dirname(canonicalPath(sourceRelativePath));
  if (components[0] === 'crate') {
    base = '';
    components = components.slice(1);
  } else if (components[0] === 'super') {
    base = path.posix.dirname(base);
    components = components.slice(1);
  } else {
    components = components.slice(1);
  }
  // The final segment commonly names an imported type/item rather than a
  // module. Try both the full sequence and its module prefix; ambiguity is
  // preserved if both happen to exist.
  const options = [components, components.slice(0, -1)]
    .filter((parts) => parts.length > 0)
    .flatMap((parts) => {
      const modulePath = path.posix.join(base, ...parts);
      return [`${modulePath}.rs`, `${modulePath}/mod.rs`];
    })
    .map(canonicalPath);
  return { candidates: [...new Set(options)], internal: true };
}

function javaCandidates(targetReference: string, symbols: readonly SymbolRecord[]): ResolutionCandidate[] {
  const target = targetReference.replace(/\.\*$/, '');
  const wildcard = targetReference.endsWith('.*');
  return symbols
    .filter((symbol) =>
      ['java', 'kotlin'].includes(symbol.languageId) &&
      (wildcard
        ? symbol.qualifiedName.startsWith(`${target}.`)
        : symbol.qualifiedName === target),
    )
    .map((symbol) => ({ relativePath: symbol.relativePath, symbolKey: symbol.symbolKey }));
}

function csharpCandidates(targetReference: string, symbols: readonly SymbolRecord[]): ResolutionCandidate[] {
  return symbols
    .filter((symbol) =>
      symbol.languageId === 'csharp' &&
      (symbol.qualifiedName === targetReference || symbol.qualifiedName.startsWith(`${targetReference}.`)),
    )
    .map((symbol) => ({ relativePath: symbol.relativePath, symbolKey: symbol.symbolKey }));
}

function candidatesForImport(
  imported: TreeSitterImport,
  filesByPath: ReadonlyMap<string, IndexedFileRecord>,
  symbols: readonly SymbolRecord[],
): { candidates: ResolutionCandidate[]; internal: boolean } {
  const languageId = imported.languageId;
  if (languageId === 'java' || languageId === 'kotlin') {
    const candidates = javaCandidates(imported.targetReference, symbols);
    return { candidates, internal: candidates.length > 0 };
  }
  if (languageId === 'csharp') {
    const candidates = csharpCandidates(imported.targetReference, symbols);
    return { candidates, internal: candidates.length > 0 };
  }

  const pathResolution = languageId === 'python'
    ? pythonCandidates(imported.relativePath, imported.targetReference)
    : languageId === 'rust'
      ? rustCandidates(imported.relativePath, imported.targetReference)
      : relativeCandidates(imported.relativePath, imported.targetReference, languageId);
  const candidates = pathResolution.candidates
    .flatMap((relativePath) => filesByPath.has(relativePath) ? [{ relativePath }] : []);
  return { candidates, internal: pathResolution.internal || candidates.length > 0 };
}

/**
 * Candidate repository paths implied by a path-like import. Java/C# imports
 * resolve through qualified symbols and intentionally return no path hints;
 * a change to any same-language declaration can affect those edges.
 */
export function syntacticDependencyCandidatePaths(imported: TreeSitterImport): string[] {
  if (imported.languageId === 'java' || imported.languageId === 'kotlin' || imported.languageId === 'csharp') return [];
  const resolution = imported.languageId === 'python'
    ? pythonCandidates(imported.relativePath, imported.targetReference)
    : imported.languageId === 'rust'
      ? rustCandidates(imported.relativePath, imported.targetReference)
      : relativeCandidates(imported.relativePath, imported.targetReference, imported.languageId);
  return resolution.candidates;
}

function normalizeCandidates(candidates: readonly ResolutionCandidate[]): ResolutionCandidate[] {
  const byKey = new Map<string, ResolutionCandidate>();
  for (const candidate of candidates) {
    byKey.set(`${candidate.relativePath}\u0000${candidate.symbolKey ?? ''}`, candidate);
  }
  return [...byKey.values()].sort((left, right) =>
    compareText(`${left.relativePath}\u0000${left.symbolKey ?? ''}`, `${right.relativePath}\u0000${right.symbolKey ?? ''}`),
  );
}

function resolutionFor(candidates: readonly ResolutionCandidate[], internal: boolean): Resolution {
  const normalized = normalizeCandidates(candidates);
  const paths = [...new Set(normalized.map((candidate) => candidate.relativePath))];
  if (paths.length === 1) return { candidates: normalized, internal, resolution: 'resolved' };
  if (paths.length > 1) return { candidates: normalized, internal: true, resolution: 'ambiguous' };
  return { candidates: [], internal, resolution: 'unresolved' };
}

function edgeEvidence(
  resolution: Resolution,
): Pick<DependencyEdgeRecord, 'confidence' | 'evidenceLevel'> {
  switch (resolution.resolution) {
    case 'resolved':
      return { confidence: 0.85, evidenceLevel: 'syntactic' };
    case 'ambiguous':
      return { confidence: 0.4, evidenceLevel: 'ambiguous' };
    case 'unresolved':
      return { confidence: 0.2, evidenceLevel: 'unresolved' };
  }
}

function edgeForImport(
  request: SyntacticDependencyResolverRequest,
  imported: TreeSitterImport,
  filesByPath: ReadonlyMap<string, IndexedFileRecord>,
): DependencyEdgeRecord {
  const candidates = candidatesForImport(imported, filesByPath, request.symbols);
  const resolution = resolutionFor(candidates.candidates, candidates.internal);
  const targetPaths = [...new Set(resolution.candidates.map((candidate) => candidate.relativePath))];
  const targetSymbols = [...new Set(resolution.candidates.flatMap((candidate) =>
    candidate.symbolKey ? [candidate.symbolKey] : [],
  ))];
  const kind: IndexDependencyKind = imported.importKind === 're-export' ? 'export' : 'import';
  return {
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    dependencyEdgeId: stableEdgeId(
      request,
      kind,
      imported.relativePath,
      imported.targetReference,
      imported.sourceRange.startLine,
      imported.sourceRange.startColumn,
    ),
    kind,
    sourceRelativePath: imported.relativePath,
    ...(resolution.resolution === 'resolved' && targetPaths[0] ? { targetRelativePath: targetPaths[0] } : {}),
    ...(resolution.resolution === 'resolved' && targetSymbols.length === 1
      ? { targetSymbolKey: targetSymbols[0] }
      : {}),
    targetReference: imported.targetReference,
    internal: resolution.internal,
    resolution: resolution.resolution,
    provider: 'tree-sitter',
    ...edgeEvidence(resolution),
    evidenceRanges: [imported.sourceRange],
  };
}

function normalizedProjectReference(sourceRelativePath: string, targetReference: string): string | undefined {
  const normalizedTarget = targetReference.replaceAll('\\', '/');
  // Project discovery deliberately retains absolute and scheme-qualified
  // syntax as explicit external evidence. `path.posix.join` would otherwise
  // turn `/outside/project` into a path below the source directory and make
  // an external unresolved reference look repository-internal.
  if (
    path.posix.isAbsolute(normalizedTarget) ||
    /^[A-Za-z]:\//.test(normalizedTarget) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedTarget)
  ) return undefined;
  const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelativePath), normalizedTarget));
  return isInsideRepository(candidate) ? canonicalPath(candidate) : undefined;
}

function edgeForProjectReference(
  request: SyntacticDependencyResolverRequest,
  reference: ProjectReferenceSyntax,
  filesByPath: ReadonlyMap<string, IndexedFileRecord>,
): DependencyEdgeRecord {
  const target = normalizedProjectReference(reference.sourceRelativePath, reference.targetReference);
  const targetExists = target ? filesByPath.get(target) : undefined;
  const resolution: Resolution = targetExists
    ? { candidates: [{ relativePath: targetExists.relativePath }], internal: true, resolution: 'resolved' }
    : { candidates: [], internal: Boolean(target), resolution: 'unresolved' };
  return {
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    dependencyEdgeId: stableEdgeId(
      request,
      'project-reference',
      reference.sourceRelativePath,
      reference.targetReference,
      reference.sourceRange.startLine,
      reference.sourceRange.startColumn,
    ),
    kind: 'project-reference',
    sourceRelativePath: reference.sourceRelativePath,
    ...(targetExists ? { targetRelativePath: targetExists.relativePath } : {}),
    targetReference: reference.targetReference,
    internal: resolution.internal,
    resolution: resolution.resolution,
    provider: 'tree-sitter',
    ...edgeEvidence(resolution),
    evidenceRanges: [reference.sourceRange],
  };
}

function edgeForExport(
  request: SyntacticDependencyResolverRequest,
  exported: TreeSitterExport,
  filesByPath: ReadonlyMap<string, IndexedFileRecord>,
  localSymbols: readonly SymbolRecord[],
): DependencyEdgeRecord {
  const kind: IndexDependencyKind = 'export';
  const reExport = exported.exportKind === 're-export' && Boolean(exported.targetReference);
  const imported: TreeSitterImport | undefined = reExport && exported.targetReference
    ? {
      importKind: 're-export',
      languageId: exported.languageId,
      relativePath: exported.relativePath,
      sourceRange: exported.sourceRange,
      targetReference: exported.targetReference,
    }
    : undefined;
  const importedCandidates = imported
    ? candidatesForImport(imported, filesByPath, request.symbols)
    : undefined;
  const localCandidates = imported
    ? []
    : localSymbols
      .filter((symbol) =>
        symbol.relativePath === exported.relativePath &&
        (!exported.targetReference ||
          symbol.name === exported.targetReference ||
          symbol.qualifiedName === exported.targetReference),
      )
      .map((symbol) => ({ relativePath: symbol.relativePath, symbolKey: symbol.symbolKey }));
  const resolution = importedCandidates
    ? resolutionFor(importedCandidates.candidates, importedCandidates.internal)
    : resolutionFor(localCandidates, true);
  const targetPaths = [...new Set(resolution.candidates.map((candidate) => candidate.relativePath))];
  const targetSymbols = [...new Set(resolution.candidates.flatMap((candidate) =>
    candidate.symbolKey ? [candidate.symbolKey] : [],
  ))];
  return {
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    dependencyEdgeId: stableEdgeId(
      request,
      kind,
      exported.relativePath,
      exported.targetReference ?? exported.exportKind,
      exported.sourceRange.startLine,
      exported.sourceRange.startColumn,
    ),
    kind,
    ...(imported ? {} : targetSymbols.length === 1 ? { sourceSymbolKey: targetSymbols[0] } : {}),
    sourceRelativePath: exported.relativePath,
    ...(reExport && resolution.resolution === 'resolved' && targetPaths[0]
      ? { targetRelativePath: targetPaths[0] }
      : {}),
    ...(reExport && resolution.resolution === 'resolved' && targetSymbols.length === 1
      ? { targetSymbolKey: targetSymbols[0] }
      : {}),
    ...(exported.targetReference ? { targetReference: exported.targetReference } : {}),
    internal: resolution.internal,
    resolution: resolution.resolution,
    provider: 'tree-sitter',
    ...edgeEvidence(resolution),
    evidenceRanges: [exported.sourceRange],
  };
}

/**
 * Resolve only explicit import/export and project-reference syntax. It never
 * promotes a call, member access, type name, package alias, or dynamic module
 * expression into a definition/reference edge. Multiple targets are retained
 * as `ambiguous`; an absent target is retained as `unresolved`.
 */
export function resolveSyntacticDependencies(
  request: SyntacticDependencyResolverRequest,
): DependencyEdgeRecord[] {
  const filesByPath = new Map(request.files.map((file) => [canonicalPath(file.relativePath), file]));
  const symbolsByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of request.symbols) {
    const symbols = symbolsByPath.get(symbol.relativePath) ?? [];
    symbols.push(symbol); symbolsByPath.set(symbol.relativePath, symbols);
  }
  const edges = [
    ...request.imports.map((imported) => edgeForImport(request, imported, filesByPath)),
    ...(request.exports ?? []).map((exported) => edgeForExport(request, exported, filesByPath, symbolsByPath.get(exported.relativePath) ?? [])),
    ...(request.projectReferences ?? []).map((reference) => edgeForProjectReference(request, reference, filesByPath)),
  ];
  const unique = new Map<string, DependencyEdgeRecord>();
  for (const edge of edges) unique.set(edge.dependencyEdgeId, edge);
  return [...unique.values()].sort((left, right) => compareText(left.dependencyEdgeId, right.dependencyEdgeId));
}

export const syntacticDependencyResolverInternals = {
  canonicalPath,
  edgeEvidence,
  normalizedProjectReference,
  pythonCandidates,
  relativeCandidates,
  resolutionFor,
  rustCandidates,
  syntacticDependencyCandidatePaths,
};
