import { createHash } from 'node:crypto';
import type {
  IndexedImplementationDocumentV2,
  MigrationRouteStage,
  MigrationRuntimeCapabilitySnapshot,
  RepositoryModuleCatalogRef,
  SearchCandidateScoreV2,
  SearchRequestV2,
} from '@forexplore/contracts';
import {
  materializeSearchCandidateV2,
  validateComposedMigrationRouteRef,
  validateIndexedImplementationDocumentV2,
  validateMigrationRuntimeCapabilitySnapshot,
  validateSearchRequestV2,
  validateSourceImplementationBundleV2,
} from '@forexplore/workflow-core';
import { expandedSearchText, overlap } from './text-analysis.js';
import { requireRepositoryScopes } from './repository-scope.js';
import type { EmbeddingProvider } from './types.js';
import type {
  EmbeddedImplementationIndexGenerationV2,
  ImplementationIndexGenerationV2,
  ImplementationIndexServiceV2,
  ImplementationIndexStoreV2,
  RetrievedImplementationDocumentV2,
  SearchEngineV2,
} from './implementation-index-v2-types.js';

/**
 * The trusted workspace host owns repository analysis and workspace mutation.
 * Retrieval may accept changes to these four stages only; every retrieval,
 * translation, validation, route-key, and policy fact remains service-owned.
 */
export const retrievalHostOwnedRuntimeOverrideStages = [
  'source-analysis',
  'target-analysis',
  'workspace-apply',
  'workspace-rollback',
] as const satisfies readonly MigrationRouteStage[];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameCatalog(
  left: RepositoryModuleCatalogRef,
  right: RepositoryModuleCatalogRef,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export type MaterializeImplementationIndexGenerationV2Input = Omit<
  ImplementationIndexGenerationV2,
  'id' | 'contentHash'
>;

export function materializeImplementationIndexGenerationV2(
  input: MaterializeImplementationIndexGenerationV2Input,
): ImplementationIndexGenerationV2 {
  if (input.schemaVersion !== '2.0') throw new Error('Implementation index generation schema is unsupported.');
  if (!input.repositoryId.trim() || input.repositoryId !== input.sourceCatalog.repositoryId) {
    throw new Error('Implementation index generation repository does not match its reviewed catalog.');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('Implementation index generation must be a positive integer.');
  }
  if (Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error('Implementation index generation requires an ISO-compatible timestamp.');
  }
  const repositoryScopes = requireRepositoryScopes(
    input.repositoryScopes,
    'Implementation index generation repository scopes',
  );
  if (!repositoryScopes.includes(input.repositoryId)) {
    throw new Error('Implementation index generation scopes must include its repository.');
  }
  const documents = input.documents
    .map((document) => validateIndexedImplementationDocumentV2(document))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (documents.length === 0 || new Set(documents.map((document) => document.id)).size !== documents.length) {
    throw new Error('Implementation index generation requires unique V2 documents.');
  }
  const sourceBundles = input.sourceBundles
    .map((bundle) => validateSourceImplementationBundleV2(bundle))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    sourceBundles.length === 0 ||
    new Set(sourceBundles.map((bundle) => bundle.id)).size !== sourceBundles.length
  ) {
    throw new Error('Implementation index generation requires unique source bundles.');
  }
  const bundleByRef = new Map(sourceBundles.map((bundle) => [
    `${bundle.id}:${bundle.contentHash}`,
    bundle,
  ]));
  for (const document of documents) {
    if (!sameCatalog(document.sourceCatalog, input.sourceCatalog)) {
      throw new Error(`Implementation index document ${document.id} has stale catalog lineage.`);
    }
    if (!document.sourceBundle?.id || !document.sourceBundle.contentHash) {
      throw new Error(`Implementation index document ${document.id} has no source bundle lineage.`);
    }
    const bundle = bundleByRef.get(`${document.sourceBundle.id}:${document.sourceBundle.contentHash}`);
    if (
      !bundle ||
      bundle.candidate.id !== document.candidate.id ||
      bundle.candidate.contentHash !== document.candidate.contentHash
    ) {
      throw new Error(`Implementation index document ${document.id} has no exact source bundle payload.`);
    }
  }
  const payload = {
    schemaVersion: '2.0' as const,
    repositoryId: input.repositoryId,
    generation: input.generation,
    sourceCatalog: input.sourceCatalog,
    repositoryScopes,
    documents,
    sourceBundles,
    createdAt: input.createdAt,
  };
  const contentHash = sha256(canonicalJson(payload));
  return { ...payload, id: `implementation-index-v2:${contentHash.slice(0, 24)}`, contentHash };
}

export function validateImplementationIndexGenerationV2(
  generation: ImplementationIndexGenerationV2,
): ImplementationIndexGenerationV2 {
  const { id, contentHash, ...input } = generation;
  const rebuilt = materializeImplementationIndexGenerationV2(input);
  if (id !== rebuilt.id || contentHash !== rebuilt.contentHash || canonicalJson(generation) !== canonicalJson(rebuilt)) {
    throw new Error('Implementation index generation content address is stale or invalid.');
  }
  return generation;
}

function queryText(request: SearchRequestV2): string {
  const target = request.target.entity;
  const raw = [
    target.name,
    target.qualifiedName ?? '',
    target.kind,
    target.signature ?? '',
    target.path,
    target.languageId,
    request.requirement,
  ].join('\n');
  return `${raw}\n${expandedSearchText(raw)}`;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mergeResults(
  semantic: RetrievedImplementationDocumentV2[],
  text: RetrievedImplementationDocumentV2[],
): RetrievedImplementationDocumentV2[] {
  const merged = new Map<string, { document: RetrievedImplementationDocumentV2; rrf: number }>();
  const add = (
    values: RetrievedImplementationDocumentV2[],
    weight: number,
    field: 'semanticScore' | 'textScore',
  ) => values.forEach((document, index) => {
    const current = merged.get(document.document.id);
    merged.set(document.document.id, {
      document: { ...(current?.document ?? document), [field]: document[field] },
      rrf: (current?.rrf ?? 0) + weight / (60 + index + 1),
    });
  });
  add(semantic, 0.65, 'semanticScore');
  add(text, 0.35, 'textScore');
  return [...merged.values()]
    .map(({ document, rrf }) => ({ ...document, hybridScore: rrf }))
    .sort((left, right) => (right.hybridScore ?? 0) - (left.hybridScore ?? 0));
}

function candidateScore(
  document: RetrievedImplementationDocumentV2,
  request: SearchRequestV2,
): SearchCandidateScoreV2 {
  const query = queryText(request);
  const indexed = document.document;
  const lexical = overlap(query, indexed.searchText);
  const semantic = clamp(document.semanticScore ?? lexical);
  const text = clamp(document.textScore === undefined ? lexical : 0.7 * document.textScore + 0.3 * lexical);
  const symbol = clamp(overlap(
    [request.target.entity.name, request.target.entity.signature ?? ''].join('\n'),
    [indexed.title, indexed.candidate.entity.signature ?? '', indexed.searchText].join('\n'),
  ));
  const contract = indexed.candidate.entity.languageId === request.route.sourceLanguageId ? 1 : 0;
  return {
    overall: clamp(0.45 * semantic + 0.25 * text + 0.2 * symbol + 0.1 * contract),
    semantic,
    symbol,
    contract,
    ...(document.hybridScore === undefined ? {} : { hybrid: clamp(document.hybridScore * 60) }),
  };
}

export class DefaultImplementationIndexServiceV2 implements ImplementationIndexServiceV2 {
  constructor(
    private readonly store: ImplementationIndexStoreV2,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async stage(generation: ImplementationIndexGenerationV2): Promise<void> {
    validateImplementationIndexGenerationV2(generation);
    const vectors = await this.embeddings.embed(generation.documents.map((document) => document.searchText));
    if (vectors.length !== generation.documents.length) {
      throw new Error('Embedding provider did not return one vector per V2 implementation document.');
    }
    const embedded: EmbeddedImplementationIndexGenerationV2 = {
      ...generation,
      documents: generation.documents.map((document, index) => {
        const embedding = vectors[index];
        if (!embedding) throw new Error(`Embedding provider omitted V2 document ${document.id}.`);
        return { document, embedding };
      }),
    };
    await this.store.stage(embedded);
  }

  validate(key: Parameters<ImplementationIndexStoreV2['validate']>[0]) {
    return this.store.validate(key);
  }

  activate(request: Parameters<ImplementationIndexStoreV2['activate']>[0]) {
    return this.store.activate(request);
  }
}

export class HybridImplementationSearchEngineV2 implements SearchEngineV2 {
  readonly runtimeCapabilities: MigrationRuntimeCapabilitySnapshot;

  constructor(
    private readonly store: ImplementationIndexStoreV2,
    private readonly embeddings: EmbeddingProvider,
    runtimeCapabilities: MigrationRuntimeCapabilitySnapshot,
    readonly allowedOverrideStages: readonly MigrationRouteStage[] =
      retrievalHostOwnedRuntimeOverrideStages,
  ) {
    this.runtimeCapabilities = validateMigrationRuntimeCapabilitySnapshot(runtimeCapabilities);
  }

  validateRequest(
    request: SearchRequestV2,
    combinedRuntimeCapabilities: MigrationRuntimeCapabilitySnapshot,
  ): void {
    validateComposedMigrationRouteRef(
      request.route,
      combinedRuntimeCapabilities,
      this.runtimeCapabilities,
      this.allowedOverrideStages,
    );
    validateSearchRequestV2(request, combinedRuntimeCapabilities);
  }

  async search(
    request: SearchRequestV2,
    combinedRuntimeCapabilities: MigrationRuntimeCapabilitySnapshot = this.runtimeCapabilities,
  ) {
    this.validateRequest(request, combinedRuntimeCapabilities);
    if (request.rerank) {
      throw new Error('SearchRequestV2 reranking is unsupported because no V2 lineage-preserving reranker is configured.');
    }
    const repositoryScopes = requireRepositoryScopes(request.repositoryScopes, 'SearchRequestV2 repository scopes');
    if (
      request.candidateLanguageIds.length !== 1 ||
      request.candidateLanguageIds[0] !== request.route.sourceLanguageId
    ) {
      throw new Error('SearchRequestV2 must use the exact route source language.');
    }
    const text = queryText(request);
    const [embedding] = await this.embeddings.embed([text]);
    if (!embedding) throw new Error('Embedding provider returned no V2 query vector.');
    const filters = {
      repositoryScopes,
      candidateLanguageIds: [...request.candidateLanguageIds],
    };
    const limit = Math.min(250, Math.max(50, request.topK * 5));
    const [semantic, lexical] = await Promise.all([
      this.store.semanticSearch(embedding, filters, limit),
      this.store.textSearch(text, filters, limit),
    ]);
    const retrieved = mergeResults(semantic, lexical)
      .map((entry) => {
        validateIndexedImplementationDocumentV2(entry.document);
        return entry;
      })
      .filter((entry) =>
        repositoryScopes.includes(entry.document.sourceCatalog.repositoryId) &&
        entry.document.candidate.entity.languageId === request.route.sourceLanguageId &&
        entry.document.sourceBundle.id.length > 0,
      )
      .slice(0, request.topK);
    const heads = new Map(await Promise.all(
      [...new Set(retrieved.map((entry) => entry.indexGeneration.repositoryId))]
        .map(async (repositoryId) => [repositoryId, await this.store.activeHead(repositoryId)] as const),
    ));
    for (const entry of retrieved) {
      const head = heads.get(entry.indexGeneration.repositoryId);
      if (
        !head ||
        head.generationId !== entry.indexGeneration.id ||
        head.generation !== entry.indexGeneration.generation ||
        head.generationContentHash !== entry.indexGeneration.contentHash ||
        head.sourceCatalogId !== entry.indexGeneration.sourceCatalogId ||
        head.sourceCatalogHash !== entry.indexGeneration.sourceCatalogHash
      ) {
        throw new Error('V2 implementation search returned a stale index generation.');
      }
    }
    const candidates = retrieved
      .map((entry) => materializeSearchCandidateV2({
        request,
        indexedDocument: entry.document,
        indexGeneration: entry.indexGeneration,
        score: candidateScore(entry, request),
        preview: entry.document.searchText.slice(0, 800),
        compatibility: [`Reviewed source module ${entry.document.moduleId}`],
        risks: [],
        createdAt: new Date().toISOString(),
      }, combinedRuntimeCapabilities))
      .sort((left, right) => right.score.overall - left.score.overall);
    const rankedDocuments = candidates.map((candidate) => {
      const entry = retrieved.find((value) => value.document.id === candidate.indexedDocumentId);
      if (!entry) throw new Error('V2 candidate lost its authoritative indexed document.');
      return entry.document;
    });
    return { candidates, indexedDocuments: rankedDocuments };
  }
}

export const implementationIndexV2Internals = { canonicalJson, mergeResults, queryText, sha256 };
