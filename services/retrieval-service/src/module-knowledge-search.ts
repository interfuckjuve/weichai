import { createHash } from 'node:crypto';
import type { IndexedModuleKnowledgeDocument } from '@forexplore/contracts';
import { validateRepositoryKnowledgePublication } from '@forexplore/workflow-core';
import { requireRepositoryScopes } from './repository-scope.js';
import { overlap } from './text-analysis.js';
import type { EmbeddingProvider } from './types.js';
import type {
  EmbeddedModuleKnowledgeDocument,
  ModuleKnowledgeActivationRequest,
  ModuleKnowledgeHead,
  ModuleKnowledgeIndexReceipt,
  ModuleKnowledgeIndexerMetadata,
  ModuleKnowledgeIndexService,
  ModuleKnowledgePublicationKey,
  ModuleKnowledgeQuery,
  ModuleKnowledgeSearchEngine,
  ModuleKnowledgeSearchResult,
  ModuleKnowledgeSearchStore,
  ModuleKnowledgeStageRequest,
  ModuleKnowledgeTombstoneRequest,
  ModuleKnowledgeWithdrawRequest,
  RetrievedModuleKnowledgeDocument,
} from './module-knowledge-types.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
export const moduleKnowledgeProjectionVersion = 'module-knowledge-search-projection/1';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

export function createModuleKnowledgeIndexerMetadata(input: {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  /** Non-secret provider configuration included only through its hash. */
  configuration: unknown;
}): ModuleKnowledgeIndexerMetadata {
  const embeddingProvider = requiredKey(input.embeddingProvider, 'Embedding provider');
  const embeddingModel = requiredKey(input.embeddingModel, 'Embedding model');
  if (!Number.isSafeInteger(input.embeddingDimension) || input.embeddingDimension < 1) {
    throw new Error('Embedding dimension must be a positive safe integer.');
  }
  return {
    projectionVersion: moduleKnowledgeProjectionVersion,
    embeddingProvider,
    embeddingModel,
    embeddingDimension: input.embeddingDimension,
    configurationHash: sha256({
      projectionVersion: moduleKnowledgeProjectionVersion,
      embeddingProvider,
      embeddingModel,
      embeddingDimension: input.embeddingDimension,
      configuration: input.configuration,
    }),
  };
}

function validateIndexerMetadata(
  metadata: ModuleKnowledgeIndexerMetadata,
  embeddingDimension: number,
): void {
  if (
    metadata.projectionVersion !== moduleKnowledgeProjectionVersion ||
    !metadata.embeddingProvider.trim() ||
    !metadata.embeddingModel.trim() ||
    metadata.embeddingDimension !== embeddingDimension ||
    !sha256Pattern.test(metadata.configurationHash)
  ) {
    throw new Error('Module knowledge indexer metadata is invalid or incompatible.');
  }
}

function requiredKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty identifier without control characters.`);
  }
  return normalized;
}

function publicationKey<T extends ModuleKnowledgePublicationKey>(value: T): T {
  const repositoryId = requireRepositoryScopes(
    [value.repositoryId],
    'Module knowledge repository',
  )[0]!;
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error('Module knowledge generation must be a positive safe integer.');
  }
  return {
    ...value,
    repositoryId,
    channel: requiredKey(value.channel, 'Module knowledge channel'),
    publicationId: requiredKey(value.publicationId, 'Module knowledge publication ID'),
    generation: value.generation,
  };
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return requireRepositoryScopes(scopes, 'Module knowledge ACL scopes').sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateDocument(
  document: IndexedModuleKnowledgeDocument,
  request: ModuleKnowledgePublicationKey & { publicationPayloadHash: string },
  scopes: readonly string[],
): void {
  if (document.documentKind !== 'functional-module') {
    throw new Error(`Module index only accepts functional-module documents: ${document.id}.`);
  }
  if (document.repositoryId !== request.repositoryId) {
    throw new Error(`Module document ${document.id} belongs to another repository.`);
  }
  if (
    document.boundaryStatus !== 'reviewed' ||
    document.narrativeStatus !== 'reviewed' ||
    document.trustTier !== 'reviewed'
  ) {
    throw new Error(`Module document ${document.id} has not passed both review gates and cannot be staged.`);
  }
  if (document.verificationStatus !== 'unverified') {
    throw new Error(
      `Module document ${document.id} claims verification before the verification gate is enabled.`,
    );
  }
  if (!sha256Pattern.test(document.artifactHash)) {
    throw new Error(`Module document ${document.id} has an invalid artifact hash.`);
  }
  if (!document.searchableContent.trim()) {
    throw new Error(`Module document ${document.id} has no searchable content.`);
  }
  const documentScopes = normalizedScopes(document.repositoryScopes);
  if (
    !sameStrings(documentScopes, scopes) ||
    !sameStrings(document.repositoryScopes, scopes)
  ) {
    throw new Error(`Module document ${document.id} ACL scopes differ from its publication.`);
  }

  // Newer shared contracts carry these fields on the projection itself. Keep
  // this adapter compatible with legacy projections while rejecting a
  // conflicting value whenever the field is present.
  if (document.publicationId !== request.publicationId) {
    throw new Error(`Module document ${document.id} belongs to another publication.`);
  }
  if (document.publicationPayloadHash !== request.publicationPayloadHash) {
    throw new Error(`Module document ${document.id} is bound to another publication payload.`);
  }
  if (document.publicationGeneration !== request.generation) {
    throw new Error(`Module document ${document.id} belongs to another generation.`);
  }
  if (document.channel !== request.channel) {
    throw new Error(`Module document ${document.id} belongs to another channel.`);
  }
}

function generationHash(
  request: ModuleKnowledgePublicationKey & { publicationPayloadHash: string },
  documents: readonly EmbeddedModuleKnowledgeDocument[],
  indexerConfigurationHash: string,
): string {
  return sha256({
    repositoryId: request.repositoryId,
    channel: request.channel,
    publicationId: request.publicationId,
    publicationHash: request.publicationPayloadHash,
    generation: request.generation,
    indexerConfigurationHash,
    documents: [...documents]
      .map(({ document, projectionHash }) => ({
        documentId: document.id,
        moduleId: document.moduleId,
        artifactHash: document.artifactHash,
        projectionHash,
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId)),
  });
}

export class DefaultModuleKnowledgeIndexService implements ModuleKnowledgeIndexService {
  constructor(
    private readonly store: ModuleKnowledgeSearchStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly indexer: ModuleKnowledgeIndexerMetadata,
  ) {}

  async stage(input: ModuleKnowledgeStageRequest): Promise<ModuleKnowledgeIndexReceipt> {
    validateIndexerMetadata(this.indexer, this.embeddings.dimension);
    validateRepositoryKnowledgePublication(input.publication);
    if (input.publication.status !== 'staged') {
      throw new Error('Only a staged knowledge publication can be staged in the module index.');
    }
    const request = publicationKey({
      repositoryId: input.publication.scope.repositoryId,
      channel: input.publication.scope.channel,
      publicationId: input.publication.id,
      generation: input.publication.generation,
    });
    const envelope = {
      ...request,
      publicationPayloadHash: input.publication.payloadHash,
    };
    if (!sha256Pattern.test(envelope.publicationPayloadHash)) {
      throw new Error('Module knowledge publication payload hash must be lowercase SHA-256.');
    }
    if (input.documents.length === 0) {
      throw new Error('A module knowledge generation must contain at least one document.');
    }
    const scopes = normalizedScopes(input.repositoryScopes);
    if (!scopes.includes(request.repositoryId)) {
      throw new Error('Module knowledge ACL scopes must include its repository ID.');
    }
    const publicationScopes = normalizedScopes(input.publication.repositoryScopes);
    if (!sameStrings(scopes, publicationScopes)) {
      throw new Error('Module knowledge ACL scopes must exactly match the immutable publication scopes.');
    }

    const documentIds = new Set<string>();
    const moduleIds = new Set<string>();
    for (const document of input.documents) {
      validateDocument(document, envelope, scopes);
      if (documentIds.has(document.id)) {
        throw new Error(`Duplicate module knowledge document ID: ${document.id}.`);
      }
      if (moduleIds.has(document.moduleId)) {
        throw new Error(`Duplicate module knowledge module ID: ${document.moduleId}.`);
      }
      documentIds.add(document.id);
      moduleIds.add(document.moduleId);
    }
    const expectedModuleIds = input.publication.source.modules.map(({ moduleId }) => moduleId).sort();
    const projectedModuleIds = [...moduleIds].sort();
    if (!sameStrings(projectedModuleIds, expectedModuleIds)) {
      throw new Error('Module knowledge documents must cover exactly the immutable publication modules.');
    }

    const vectors = await this.embeddings.embed(
      input.documents.map((document) => document.searchableContent),
    );
    if (vectors.length !== input.documents.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${input.documents.length} module documents.`,
      );
    }
    const documents = input.documents.map((document, index) => {
      const embedding = vectors[index];
      if (!embedding) throw new Error(`Embedding provider omitted module document ${document.id}.`);
      if (embedding.length !== this.embeddings.dimension) {
        throw new Error(
          `Embedding for ${document.id} has ${embedding.length} dimensions; expected ${this.embeddings.dimension}.`,
        );
      }
      return {
        document,
        embedding,
        projectionHash: sha256({ document, embedding, indexer: this.indexer }),
      };
    });

    return this.store.stage({
      repositoryId: request.repositoryId,
      channel: request.channel,
      publicationId: request.publicationId,
      publication: input.publication,
      publicationPayloadHash: envelope.publicationPayloadHash,
      generation: request.generation,
      repositoryScopes: scopes,
      indexer: this.indexer,
      documents,
      generationContentHash: generationHash(
        envelope,
        documents,
        this.indexer.configurationHash,
      ),
    });
  }

  validate(key: ModuleKnowledgePublicationKey): Promise<ModuleKnowledgeIndexReceipt> {
    return this.store.validate(publicationKey(key));
  }

  activate(request: ModuleKnowledgeActivationRequest): Promise<ModuleKnowledgeHead> {
    const normalized = publicationKey(request);
    return this.store.activate({
      ...normalized,
      expectedActiveGeneration: request.expectedActiveGeneration === null
        ? null
        : (() => {
            if (!Number.isSafeInteger(request.expectedActiveGeneration) || request.expectedActiveGeneration < 1) {
              throw new Error('Expected active generation must be a positive safe integer.');
            }
            return request.expectedActiveGeneration;
          })(),
    });
  }

  withdraw(request: ModuleKnowledgeWithdrawRequest): Promise<ModuleKnowledgeHead> {
    const normalized = publicationKey(request);
    return this.store.withdraw({
      ...normalized,
      expectedActiveGeneration: (() => {
        if (!Number.isSafeInteger(request.expectedActiveGeneration) || request.expectedActiveGeneration < 1) {
          throw new Error('Expected active generation must be a positive safe integer.');
        }
        return request.expectedActiveGeneration;
      })(),
    });
  }

  tombstone(request: ModuleKnowledgeTombstoneRequest): Promise<void> {
    return this.store.tombstone(publicationKey(request));
  }
}

function mergeResults(
  semantic: RetrievedModuleKnowledgeDocument[],
  text: RetrievedModuleKnowledgeDocument[],
): RetrievedModuleKnowledgeDocument[] {
  const merged = new Map<string, { document: RetrievedModuleKnowledgeDocument; rrf: number }>();
  const add = (
    documents: RetrievedModuleKnowledgeDocument[],
    weight: number,
    score: 'semanticScore' | 'textScore',
  ) => {
    documents.forEach((document, index) => {
      const key = `${document.publicationId}\u0000${document.publicationGeneration}\u0000${document.id}`;
      const current = merged.get(key);
      merged.set(key, {
        document: {
          ...(current?.document ?? document),
          [score]: document[score],
        },
        rrf: (current?.rrf ?? 0) + weight / (60 + index + 1),
      });
    });
  };
  add(semantic, 0.65, 'semanticScore');
  add(text, 0.35, 'textScore');
  return [...merged.values()]
    .map(({ document, rrf }) => ({ ...document, hybridScore: rrf }))
    .sort((left, right) => (right.hybridScore ?? 0) - (left.hybridScore ?? 0));
}

function expandedLimit(topK: number): number {
  return Math.min(200, Math.max(30, topK * 5));
}

function searchableFields(document: IndexedModuleKnowledgeDocument): string {
  return [
    document.title,
    document.summary,
    document.searchableContent,
    ...document.capabilities,
    ...document.domainTerms,
    ...document.publicApiSignatures,
    ...document.tags,
  ].join('\n');
}

export class HybridModuleKnowledgeSearchEngine implements ModuleKnowledgeSearchEngine {
  constructor(
    private readonly store: ModuleKnowledgeSearchStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(input: ModuleKnowledgeQuery): Promise<ModuleKnowledgeSearchResult> {
    const repositoryId = requireRepositoryScopes(
      [input.repositoryId],
      'Module search repository',
    )[0]!;
    const repositoryScopes = normalizedScopes(input.repositoryScopes);
    if (!repositoryScopes.includes(repositoryId)) {
      throw new Error('Module search ACL scopes must include its repository ID.');
    }
    const query = input.query.trim();
    if (!query) throw new Error('Module search query must not be empty.');
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) {
      throw new Error('Module search topK must be an integer from 1 to 50.');
    }
    const request: ModuleKnowledgeQuery = {
      ...input,
      query,
      repositoryId,
      channel: requiredKey(input.channel, 'Module search channel'),
      repositoryScopes,
      languageIds: [...new Set(input.languageIds ?? [])],
      capabilities: [...new Set((input.capabilities ?? []).map((value) => value.trim()).filter(Boolean))],
    };
    const [embedding] = await this.embeddings.embed([query]);
    if (!embedding) throw new Error('Embedding provider returned no module query vector.');
    if (embedding.length !== this.embeddings.dimension) {
      throw new Error(
        `Module query embedding has ${embedding.length} dimensions; expected ${this.embeddings.dimension}.`,
      );
    }
    const limit = expandedLimit(input.topK);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = await this.store.activeHead(request.repositoryId, request.channel);
      if (
        !before ||
        before.publicationId === null ||
        before.publicationPayloadHash === null ||
        before.generation === null
      ) {
        throw new Error(
          `No active module knowledge publication for ${request.repositoryId} (${request.channel}).`,
        );
      }
      const [semantic, text] = await Promise.all([
        this.store.semanticSearch(embedding, request, limit),
        this.store.textSearch(query, request, limit),
      ]);
      const after = await this.store.activeHead(request.repositoryId, request.channel);
      const stable =
        after?.revision === before.revision &&
        after.publicationId === before.publicationId &&
        after.publicationPayloadHash === before.publicationPayloadHash &&
        after.generation === before.generation;
      if (!stable) continue;

      const documents = mergeResults(semantic, text);
      if (documents.some((document) =>
        document.repositoryId !== request.repositoryId ||
        document.channel !== request.channel ||
        document.publicationId !== before.publicationId ||
        document.publicationPayloadHash !== before.publicationPayloadHash ||
        document.publicationGeneration !== before.generation
      )) {
        continue;
      }

      const hits = documents
        .filter((document) =>
          document.boundaryStatus === 'reviewed' &&
          document.narrativeStatus === 'reviewed' &&
          document.trustTier === 'reviewed' &&
          document.verificationStatus === 'unverified'
        )
        .map((document) => {
          const lexical = overlap(query, searchableFields(document));
          const semanticScore = document.semanticScore ?? lexical;
          const textScore = document.textScore ?? lexical;
          const score = Math.max(0, Math.min(1, 0.6 * semanticScore + 0.4 * textScore));
          const { semanticScore: semanticComponent, textScore: textComponent,
            hybridScore: hybridComponent, ...projection } = document;
          return {
            document: projection,
            score,
            ranking: {
              ...(semanticComponent === undefined ? {} : { semantic: semanticComponent }),
              ...(textComponent === undefined ? {} : { text: textComponent }),
              ...(hybridComponent === undefined ? {} : { hybrid: hybridComponent }),
            },
          };
        })
        .sort((left, right) =>
          (right.ranking.hybrid ?? 0) - (left.ranking.hybrid ?? 0) || right.score - left.score
        )
        .slice(0, input.topK);
      return {
        scope: { repositoryId: request.repositoryId, channel: request.channel },
        activePublicationId: before.publicationId,
        activePublicationPayloadHash: before.publicationPayloadHash,
        activeGeneration: before.generation,
        hits,
      };
    }
    throw new Error('Module knowledge publication changed repeatedly during search; retry the request.');
  }
}

export const moduleKnowledgeSearchInternals = {
  canonicalize,
  expandedLimit,
  generationHash,
  mergeResults,
  publicationKey,
  sha256,
};
