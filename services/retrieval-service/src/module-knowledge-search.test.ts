import { describe, expect, it, vi } from 'vitest';
import {
  repositoryIngestionSchemaVersion,
  repositoryKnowledgePublicationSchemaVersion,
  type IndexedModuleKnowledgeDocument,
  type RepositoryKnowledgePublication,
} from '@forexplore/contracts';
import {
  canonicalJson,
  materializeRepositoryModuleIndexReceipt,
  sha256Hex,
} from '@forexplore/workflow-core';
import { HashEmbeddingProvider } from './embedding.js';
import {
  createModuleKnowledgeIndexerMetadata,
  DefaultModuleKnowledgeIndexService,
  HybridModuleKnowledgeSearchEngine,
} from './module-knowledge-search.js';
import type {
  EmbeddedModuleKnowledgeGeneration,
  ModuleKnowledgeActivationRequest,
  ModuleKnowledgeHead,
  ModuleKnowledgeIndexReceipt,
  ModuleKnowledgePublicationKey,
  ModuleKnowledgeQuery,
  ModuleKnowledgeSearchStore,
  ModuleKnowledgeTombstoneRequest,
  ModuleKnowledgeWithdrawRequest,
  RetrievedModuleKnowledgeDocument,
} from './module-knowledge-types.js';

function publication(): RepositoryKnowledgePublication {
  const immutablePayload = {
    scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
    repositoryScopes: ['acme/orders'],
    generation: 1,
    source: {
      repositoryModuleBundleId: 'bundle-1',
      repositoryModuleBundleHash: 'd'.repeat(64),
      modules: [{
        moduleId: 'orders',
        evidenceBundleId: 'evidence-bundle-1',
        evidenceBundleHash: 'e'.repeat(64),
        wikiProposalId: 'wiki-proposal-1',
        wikiProposalHash: 'f'.repeat(64),
        knowledgeReviewId: 'knowledge-review-1',
        knowledgeReviewHash: '1'.repeat(64),
        knowledgePageId: 'wiki:orders',
        knowledgePageHash: 'a'.repeat(64),
      }],
    },
    artifacts: [],
  };
  const payloadHash = sha256Hex(canonicalJson(immutablePayload));
  const payload = {
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: `repository-knowledge-publication:${payloadHash.slice(0, 24)}`,
    ...immutablePayload,
    status: 'staged' as const,
    payloadHash,
    stagedAt: '2026-09-01T00:00:00.000Z',
    producer: { kind: 'knowledge-publisher' as const, id: 'test-publisher', version: '1' },
  };
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

const stagedPublication = publication();
const indexer = createModuleKnowledgeIndexerMetadata({
  embeddingProvider: 'hash',
  embeddingModel: 'forexplore-fnv1a-trigram-v1',
  embeddingDimension: 16,
  configuration: { algorithm: 'fnv1a-word-trigram', normalization: 'l2' },
});

function document(
  overrides: Partial<IndexedModuleKnowledgeDocument> = {},
): IndexedModuleKnowledgeDocument {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'indexed-module-knowledge:orders',
    documentKind: 'functional-module',
    artifactId: 'wiki:orders',
    artifactHash: 'a'.repeat(64),
    repositoryId: 'acme/orders',
    moduleId: 'orders',
    moduleCatalogId: 'catalog-1',
    publicationId: stagedPublication.id,
    publicationPayloadHash: stagedPublication.payloadHash,
    publicationGeneration: 1,
    channel: 'branch:main',
    title: 'Orders',
    summary: 'Owns order creation and status transitions.',
    languageIds: ['typescript'],
    capabilities: ['order management'],
    domainTerms: ['orders'],
    publicApiSignatures: ['createOrder(input: OrderInput): Order'],
    dependencyModuleIds: ['payments'],
    tags: ['commerce'],
    risks: ['Payment behavior is independently owned.'],
    boundaryStatus: 'reviewed',
    narrativeStatus: 'reviewed',
    verificationStatus: 'unverified',
    trustTier: 'reviewed',
    repositoryScopes: ['acme/orders'],
    searchableContent: 'Orders createOrder order management lifecycle',
    ...overrides,
  };
}

function receipt(
  generation: EmbeddedModuleKnowledgeGeneration,
): ModuleKnowledgeIndexReceipt {
  return materializeRepositoryModuleIndexReceipt({
    publication: generation.publication,
    status: 'validated',
    storeId: 'test-module-store',
    documentCount: generation.documents.length,
    moduleIds: generation.documents.map(({ document: item }) => item.moduleId),
    indexArtifactHash: generation.generationContentHash,
    createdAt: '2026-09-01T00:01:00.000Z',
  });
}

function store(overrides: Partial<ModuleKnowledgeSearchStore> = {}): ModuleKnowledgeSearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    stage: vi.fn(async (generation) => receipt(generation)),
    validate: vi.fn(async () => { throw new Error('not configured'); }),
    activate: vi.fn(async () => { throw new Error('not configured'); }),
    withdraw: vi.fn(async () => { throw new Error('not configured'); }),
    tombstone: vi.fn(async () => undefined),
    activeHead: vi.fn(async () => ({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publicationId: stagedPublication.id,
      publicationPayloadHash: stagedPublication.payloadHash,
      generation: 1,
      revision: 1,
    })),
    semanticSearch: vi.fn(async () => []),
    textSearch: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('DefaultModuleKnowledgeIndexService', () => {
  it('embeds and stages a reviewed publication as an immutable generation', async () => {
    const searchStore = store();
    const service = new DefaultModuleKnowledgeIndexService(
      searchStore,
      new HashEmbeddingProvider(16),
      indexer,
    );

    const result = await service.stage({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document()],
    });

    expect(result).toMatchObject({
      generation: 1,
      documentCount: 1,
      status: 'validated',
    });
    const staged = vi.mocked(searchStore.stage).mock.calls[0]?.[0];
    expect(staged?.indexer).toEqual(indexer);
    expect(staged?.documents[0]?.embedding).toHaveLength(16);
    expect(staged?.documents[0]?.projectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(staged?.generationContentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds projection and embedding configuration lineage into the generation hash', async () => {
    const firstStore = store();
    const secondStore = store();
    const secondIndexer = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'hash',
      embeddingModel: 'forexplore-fnv1a-trigram-v1',
      embeddingDimension: 16,
      configuration: { algorithm: 'fnv1a-word-trigram', normalization: 'none' },
    });
    await new DefaultModuleKnowledgeIndexService(
      firstStore,
      new HashEmbeddingProvider(16),
      indexer,
    ).stage({
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document()],
    });
    await new DefaultModuleKnowledgeIndexService(
      secondStore,
      new HashEmbeddingProvider(16),
      secondIndexer,
    ).stage({
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document()],
    });

    const first = vi.mocked(firstStore.stage).mock.calls[0]?.[0];
    const second = vi.mocked(secondStore.stage).mock.calls[0]?.[0];
    expect(first?.indexer.configurationHash).not.toBe(second?.indexer.configurationHash);
    expect(first?.documents[0]?.projectionHash).not.toBe(second?.documents[0]?.projectionHash);
    expect(first?.generationContentHash).not.toBe(second?.generationContentHash);
  });

  it('does not let generated/discovered prose enter staging', async () => {
    const searchStore = store();
    const service = new DefaultModuleKnowledgeIndexService(
      searchStore,
      new HashEmbeddingProvider(16),
      indexer,
    );

    await expect(service.stage({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document({ narrativeStatus: 'generated', trustTier: 'discovered' })],
    })).rejects.toThrow('has not passed both review gates');
    expect(searchStore.stage).not.toHaveBeenCalled();
  });

  it('does not accept a claimed verified state before that gate is implemented', async () => {
    const searchStore = store();
    const service = new DefaultModuleKnowledgeIndexService(
      searchStore,
      new HashEmbeddingProvider(16),
      indexer,
    );

    await expect(service.stage({
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document({ verificationStatus: 'verified' })],
    })).rejects.toThrow('claims verification before the verification gate is enabled');
    expect(searchStore.stage).not.toHaveBeenCalled();
  });

  it('rejects a document whose ACL differs from the publication envelope', async () => {
    const searchStore = store();
    const service = new DefaultModuleKnowledgeIndexService(
      searchStore,
      new HashEmbeddingProvider(16),
      indexer,
    );

    await expect(service.stage({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document({ repositoryScopes: ['acme/other'] })],
    })).rejects.toThrow('ACL scopes differ');
    await expect(service.stage({
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document({ repositoryScopes: ['acme/orders', 'acme/orders'] })],
    })).rejects.toThrow('ACL scopes differ');
  });

  it('rejects request ACL scopes that differ from the immutable publication ACL', async () => {
    const searchStore = store();
    const service = new DefaultModuleKnowledgeIndexService(
      searchStore,
      new HashEmbeddingProvider(16),
      indexer,
    );

    await expect(service.stage({
      publication: stagedPublication,
      repositoryScopes: ['acme/orders', 'other/private'],
      documents: [document({ repositoryScopes: ['acme/orders', 'other/private'] })],
    })).rejects.toThrow('immutable publication scopes');
    expect(searchStore.stage).not.toHaveBeenCalled();
  });
});

describe('HybridModuleKnowledgeSearchEngine', () => {
  it('keeps module retrieval independent and scoped to repository plus channel', async () => {
    const active: RetrievedModuleKnowledgeDocument = {
      ...document(),
      semanticScore: 0.9,
    };
    const semanticSearch = vi.fn(async () => [active]);
    const textSearch = vi.fn(async () => [{ ...active, semanticScore: undefined, textScore: 0.8 }]);
    const searchStore = store({ semanticSearch, textSearch });
    const engine = new HybridModuleKnowledgeSearchEngine(
      searchStore,
      new HashEmbeddingProvider(16),
    );
    const query: ModuleKnowledgeQuery = {
      query: 'create an order',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: ['acme/orders'],
      topK: 5,
    };

    const result = await engine.search(query);

    expect(result).toMatchObject({
      scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
      activePublicationId: stagedPublication.id,
      activePublicationPayloadHash: stagedPublication.payloadHash,
      activeGeneration: 1,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.document).toMatchObject({
      documentKind: 'functional-module',
      publicationId: stagedPublication.id,
      publicationGeneration: 1,
      channel: 'branch:main',
    });
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ repositoryId: 'acme/orders', channel: 'branch:main' }),
      30,
    );
  });

  it('defensively excludes unreviewed store results', async () => {
    const base = {
      ...document(),
      semanticScore: 0.9,
    } satisfies RetrievedModuleKnowledgeDocument;
    const searchStore = store({
      semanticSearch: vi.fn(async () => [
        base,
        { ...base, id: 'draft', narrativeStatus: 'generated', trustTier: 'discovered' },
      ]),
    });
    const engine = new HybridModuleKnowledgeSearchEngine(
      searchStore,
      new HashEmbeddingProvider(16),
    );

    const result = await engine.search({
      query: 'orders',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: ['acme/orders'],
      topK: 5,
    });

    expect(result.hits.map(({ document }) => document.id)).toEqual([base.id]);
  });

  it('fails a query when a store returns a document outside the stable active head', async () => {
    const wrongHead = {
      ...document(),
      channel: 'branch:old',
      semanticScore: 0.9,
    } satisfies RetrievedModuleKnowledgeDocument;
    const engine = new HybridModuleKnowledgeSearchEngine(
      store({ semanticSearch: vi.fn(async () => [wrongHead]) }),
      new HashEmbeddingProvider(16),
    );

    await expect(engine.search({
      query: 'orders',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: ['acme/orders'],
      topK: 5,
    })).rejects.toThrow('changed repeatedly during search');
  });
});

// These declarations make the test double fail compilation whenever the
// lifecycle port changes without updating its proof fixtures.
void ({} as ModuleKnowledgeActivationRequest);
void ({} as ModuleKnowledgePublicationKey);
void ({} as ModuleKnowledgeHead);
void ({} as ModuleKnowledgeTombstoneRequest);
void ({} as ModuleKnowledgeWithdrawRequest);
