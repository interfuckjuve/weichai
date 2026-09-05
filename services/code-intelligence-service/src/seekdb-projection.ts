import { createHash } from 'node:crypto';
import type {
  ModuleArtifactRecord,
  ProjectAnalysisRecord,
  ProjectModule,
  SearchDocumentRecord,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import type { SearchProjection } from './analysis-coordinator.js';
import type { IndexStore } from './index-store.js';

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
  return record.proposal.modules.map((module: ProjectModule) => {
    const text = JSON.stringify({
      projectId: record.projectId,
      moduleId: module.id,
      name: module.name,
      kind: module.kind,
      description: module.description,
      purpose: module.purpose,
      domain: module.domain,
      language: module.language,
      coreApis: module.coreApis ?? [],
      dependsOn: module.dependsOn,
    });
    const identity = `${artifact.moduleArtifactId}\u0000${module.id}`;
    return {
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
  });
}

/**
 * Builds the non-authoritative SeekDB search projection. Replacement happens
 * at a single repository revision only; it intentionally never calls a global
 * clear, so indexing one historical repository cannot erase another.
 */
export class SeekDbProjection implements SearchProjection {
  constructor(private readonly store: IndexStore) {}

  async project(
    index: StructuralIndex,
    sourceTexts: ReadonlyMap<string, string> = new Map(),
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const documents = index.symbols.map((symbol) => symbolDocument(index, symbol));
    for (const [relativePath, source] of sourceTexts) {
      signal?.throwIfAborted();
      documents.push(fragmentDocument(index, relativePath, source));
    }
    const repository = await this.store.getRepository(index.repositoryId);
    const artifacts = await this.store.listModuleArtifacts(index);
    for (const artifact of artifacts) {
      documents.push(...summaryDocuments(index, artifact, repository?.activeRevision));
    }
    await this.store.replaceSearchDocuments(index, documents);
  }

  async projectModuleArtifacts(index: StructuralIndex, signal?: AbortSignal): Promise<void> {
    const sourceTexts = new Map<string, string>();
    for (const file of index.files) {
      const source = await this.store.getSourceText(index, file.relativePath);
      if (source !== null) sourceTexts.set(file.relativePath, source);
    }
    await this.project(index, sourceTexts, signal);
  }
}

export const seekDbProjectionInternals = {
  documentHash,
  documentId,
  fragmentDocument,
  summaryDocuments,
  symbolDocument,
};
