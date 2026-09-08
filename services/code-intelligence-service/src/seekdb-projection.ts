import { createHash } from 'node:crypto';
import { indexModuleHierarchy } from '@forexplore/contracts';
import type {
  ModuleArtifactRecord,
  ProjectAnalysisRecord,
  ProjectModule,
  SearchDocumentRecord,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import type { SearchProjection } from './analysis-coordinator.js';
import type { IndexStore, SourceTextReader } from './index-store.js';

const MAX_FRAGMENT_CHARS = 12_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function documentId(scope: StructuralIndex, kind: string, identity: string): string {
  return `search-${sha256(`${scope.repositoryId}\u0000${scope.analysisRevision}\u0000${kind}\u0000${identity}`)}`;
}

function documentHash(title: string, text: string): string {
  return sha256(`${title}\u0000${text}`);
}

function symbolDocument(index: StructuralIndex, symbol: SymbolRecord): SearchDocumentRecord {
  const title = symbol.qualifiedName || symbol.name;
  const text = [
    title,
    symbol.signature ?? '',
    `kind: ${symbol.kind}`,
    `language: ${symbol.languageId}`,
    `path: ${symbol.relativePath}`,
    symbol.exported ? 'exported' : '',
  ].filter(Boolean).join('\n');
  return {
    repositoryId: index.repositoryId,
    analysisRevision: index.analysisRevision,
    searchDocumentId: documentId(index, 'symbol', symbol.symbolKey),
    kind: 'symbol',
    relativePath: symbol.relativePath,
    symbolKey: symbol.symbolKey,
    contentHash: documentHash(title, text),
    title,
    text,
  };
}

function fragmentDocument(index: StructuralIndex, relativePath: string, source: string): SearchDocumentRecord {
  const text = source.slice(0, MAX_FRAGMENT_CHARS);
  const title = relativePath;
  return {
    repositoryId: index.repositoryId,
    analysisRevision: index.analysisRevision,
    searchDocumentId: documentId(index, 'source-fragment', relativePath),
    kind: 'source-fragment',
    relativePath,
    contentHash: documentHash(title, text),
    title,
    text,
  };
}

function* sourceDocuments(index: StructuralIndex, relativePath: string, source: string, symbols: readonly SymbolRecord[]): Generator<SearchDocumentRecord> {
  const lineOffsets = [0];
  for (let position = 0; position < source.length; position++) if (source[position] === '\n') lineOffsets.push(position + 1);
  const offset = (line: number, column: number) => Math.min(source.length, (lineOffsets[line - 1] ?? source.length) + column - 1);
  const position = (value: number) => {
    let low = 0, high = lineOffsets.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineOffsets[middle]! <= value) low = middle; else high = middle; }
    return { line: low + 1, column: value - lineOffsets[low]! + 1 };
  };
  const declarations = symbols.map((symbol) => ({ symbol,
    start: offset(symbol.sourceRange.startLine, symbol.sourceRange.startColumn),
    end: offset(symbol.sourceRange.endLine, symbol.sourceRange.endColumn),
  })).filter((item) => item.end > item.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const callable = new Set(['function', 'method', 'constructor']);
  const containers = new Set(symbols.flatMap((symbol) => symbol.containerSymbolKey ? [symbol.containerSymbolKey] : []));
  const preferred = declarations.filter((item) => callable.has(item.symbol.kind) || !containers.has(item.symbol.symbolKey));
  const spans: Array<{ start: number; end: number; symbol?: SymbolRecord }> = [];
  let covered = 0;
  for (const item of preferred) {
    if (item.start < covered) continue;
    if (item.start > covered) spans.push({ start: covered, end: item.start });
    spans.push(item); covered = item.end;
  }
  if (covered < source.length) spans.push({ start: covered, end: source.length });
  for (const span of spans) {
    for (let start = span.start; start < span.end;) {
      let end = Math.min(start + MAX_FRAGMENT_CHARS, span.end);
      if (end < span.end) {
        const newline = source.lastIndexOf('\n', end);
        if (newline > start + MAX_FRAGMENT_CHARS / 2) end = newline + 1;
        if (/[\uD800-\uDBFF]/.test(source[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(source[end] ?? '')) end--;
      }
      const first = position(start), last = position(end);
      const range = { startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column };
      const title = span.symbol?.qualifiedName || relativePath;
      const text = source.slice(start, end);
      yield { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision,
        searchDocumentId: documentId(index, 'source-fragment', `${relativePath}:${start}:${end}`), kind: 'source-fragment',
        relativePath, ...(span.symbol ? { symbolKey: span.symbol.symbolKey } : {}), sourceRange: range,
        contentHash: documentHash(title, text), title, text };
      start = end;
    }
  }
}

function summaryDocuments(
  index: StructuralIndex,
  artifact: ModuleArtifactRecord,
  activeRevision: string | null | undefined = undefined,
): SearchDocumentRecord[] {
  // A search projection is never allowed to make an unbound or stale summary
  // look current. The authoritative store enforces the same rule on writes;
  // this defensive check also protects alternate IndexStore implementations.
  if (
    artifact.kind !== 'module-summary' ||
    artifact.status !== 'current' ||
    artifact.payload === undefined ||
    !artifact.planHash?.trim() ||
    artifact.analysisHash !== index.analysisHash ||
    activeRevision !== index.analysisRevision
  ) return [];
  const record = artifact.payload as Partial<ProjectAnalysisRecord>;
  if (!record.proposal || !Array.isArray(record.proposal.modules)) {
    const text = typeof artifact.payload === 'string' ? artifact.payload : JSON.stringify(artifact.payload);
    const title = `Module summary ${artifact.moduleArtifactId}`;
    return [{
      repositoryId: index.repositoryId,
      analysisRevision: index.analysisRevision,
      searchDocumentId: documentId(index, 'summary', artifact.moduleArtifactId),
      kind: 'summary',
      relativePath: null,
      moduleArtifactId: artifact.moduleArtifactId,
      contentHash: documentHash(title, text),
      title,
      text,
    }];
  }
  const tree = indexModuleHierarchy(record.proposal.modules);
  return record.proposal.modules.flatMap((module: ProjectModule) => {
    const nodeKind = module.nodeKind ?? 'module';
    const depth = tree.depthById.get(module.id)!;
    const hierarchy = { nodeKind, parentId: module.parentId ?? null, depth, planHash: artifact.planHash };
    const samples = tree.sourceFiles(module.id, 20);
    const text = JSON.stringify({
      projectId: record.projectId,
      moduleId: module.id,
      ...hierarchy,
      name: module.name,
      kind: module.kind,
      description: module.description,
      purpose: module.purpose,
      domain: module.domain,
      language: module.language,
      coreApis: module.coreApis ?? [],
      dependsOn: module.dependsOn,
      refinement: module.refinement,
      metrics: module.metrics,
    });
    const identity = `${artifact.moduleArtifactId}\u0000${module.id}${module.nodeKind !== undefined || module.parentId !== undefined ? `\u0000${nodeKind}\u0000${depth}` : ''}`;
    const base: SearchDocumentRecord = {
      repositoryId: index.repositoryId,
      analysisRevision: index.analysisRevision,
      searchDocumentId: documentId(index, 'summary', identity),
      kind: 'summary' as const,
      relativePath: null,
      moduleArtifactId: artifact.moduleArtifactId,
      contentHash: documentHash(module.name, text),
      title: module.name,
      text,
    };
    return [base, ...(['interface', 'dependency'] as const).map((view): SearchDocumentRecord => {
      const viewText = JSON.stringify({ projectId: record.projectId, moduleId: module.id, view,
        ...hierarchy,
        name: module.name, language: module.language,
        ...(view === 'interface' ? { coreApis: module.coreApis ?? [], purpose: module.purpose }
          : { sourceFiles: samples.files, sourceFilesTruncated: samples.truncated, dependsOn: module.dependsOn, domain: module.domain }) });
      return { ...base, searchDocumentId: documentId(index, 'summary', `${identity}\u0000${view}`),
        text: viewText, contentHash: documentHash(module.name, viewText) };
    })];
  });
}

/**
 * Builds the non-authoritative SeekDB search projection. Replacement happens
 * at a single repository revision only; it intentionally never calls a global
 * clear, so indexing one historical repository cannot erase another.
 */
export class SeekDbProjection implements SearchProjection {
  constructor(private readonly store: IndexStore, private readonly batchOptions: { maxDocuments?: number; maxBytes?: number } = {}) {}

  async projectFromSource(index: StructuralIndex, source: SourceTextReader, signal?: AbortSignal): Promise<void> {
    if (!this.store.appendSearchDocuments) throw new Error('Index store does not support bounded search projection batches.');
    const maxDocuments = this.batchOptions.maxDocuments ?? 128;
    const maxBytes = this.batchOptions.maxBytes ?? 512 * 1024;
    if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 2048 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 8 * 1024 * 1024) throw new Error('Projection batch budget is invalid.');
    const symbolsByPath = new Map<string, SymbolRecord[]>();
    for (const symbol of index.symbols) {
      const symbols = symbolsByPath.get(symbol.relativePath) ?? [];
      symbols.push(symbol); symbolsByPath.set(symbol.relativePath, symbols);
    }
    let documents: SearchDocumentRecord[] = [];
    let bytes = 0;
    const append = async (document: SearchDocumentRecord) => {
      const size = Buffer.byteLength(document.text, 'utf8');
      if (documents.length >= maxDocuments || (documents.length && bytes + size > maxBytes)) {
        await this.store.appendSearchDocuments!(index, documents, signal); documents = []; bytes = 0;
      }
      documents.push(document); bytes += size;
    };
    for (const file of index.files) {
      signal?.throwIfAborted();
      const symbols = symbolsByPath.get(file.relativePath) ?? [];
      for (const symbol of symbols) await append(symbolDocument(index, symbol));
      const text = await source.read(file.relativePath);
      if (text !== null) for (const document of sourceDocuments(index, file.relativePath, text, symbols)) await append(document);
    }
    if (documents.length) await this.store.appendSearchDocuments(index, documents, signal);
  }

  async project(
    index: StructuralIndex,
    sourceTexts: ReadonlyMap<string, string> = new Map(),
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const documents = index.symbols.map((symbol) => symbolDocument(index, symbol));
    for (const [relativePath, source] of sourceTexts) {
      signal?.throwIfAborted();
      documents.push(...sourceDocuments(index, relativePath, source, index.symbols.filter((symbol) => symbol.relativePath === relativePath)));
    }
    const repository = await this.store.getRepository(index.repositoryId);
    const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision };
    const artifacts = await this.store.listModuleArtifacts(scope);
    for (const artifact of artifacts) {
      documents.push(...summaryDocuments(index, artifact, repository?.activeRevision));
    }
    await this.store.replaceSearchDocuments(scope, documents);
  }

  async projectModuleArtifacts(index: StructuralIndex, signal?: AbortSignal, moduleArtifactId?: string): Promise<void> {
    const repository = await this.store.getRepository(index.repositoryId);
    const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision };
    const artifacts = moduleArtifactId && this.store.getModuleArtifacts
      ? await this.store.getModuleArtifacts(scope, [moduleArtifactId], signal)
      : await this.store.listModuleArtifacts(scope);
    for (const artifact of artifacts) {
      signal?.throwIfAborted();
      if (artifact.kind !== 'module-summary' || (moduleArtifactId !== undefined && artifact.moduleArtifactId !== moduleArtifactId)) continue;
      await this.store.replaceSearchDocuments(scope, summaryDocuments(index, artifact, repository?.activeRevision), artifact.moduleArtifactId);
    }
  }
}

export const seekDbProjectionInternals = {
  documentHash,
  documentId,
  fragmentDocument,
  sourceDocuments,
  summaryDocuments,
  symbolDocument,
};
