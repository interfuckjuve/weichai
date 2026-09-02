import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { createHttpServer } from './http-server.js';
import { ModuleKnowledgeCasError } from './seekdb-module-knowledge-store.js';
import type {
  ModuleKnowledgeIndexService,
  ModuleKnowledgeSearchEngine,
  ModuleKnowledgeSearchStore,
} from './module-knowledge-types.js';
import type { SearchEngine, SearchStore } from './types.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

function symbolStore(): SearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    semanticSearch: vi.fn(async () => []),
    textSearch: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

function moduleStore(): ModuleKnowledgeSearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    stage: vi.fn(async () => { throw new Error('not configured'); }),
    validate: vi.fn(async () => { throw new Error('not configured'); }),
    activate: vi.fn(async () => { throw new Error('not configured'); }),
    withdraw: vi.fn(async () => { throw new Error('not configured'); }),
    tombstone: vi.fn(async () => undefined),
    activeHead: vi.fn(async () => null),
    semanticSearch: vi.fn(async () => []),
    textSearch: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

function moduleIndex(overrides: Partial<ModuleKnowledgeIndexService> = {}): ModuleKnowledgeIndexService {
  return {
    stage: vi.fn(async (request) => materializeRepositoryModuleIndexReceipt({
      publication: request.publication,
      status: 'validated',
      storeId: 'test-module-store',
      documentCount: request.documents.length,
      moduleIds: request.documents.map(({ moduleId }) => moduleId),
      indexArtifactHash: 'c'.repeat(64),
      createdAt: '2026-09-01T00:01:00.000Z',
    })),
    validate: vi.fn(async () => { throw new Error('not configured'); }),
    activate: vi.fn(async () => { throw new Error('not configured'); }),
    withdraw: vi.fn(async () => { throw new Error('not configured'); }),
    tombstone: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function listen(options: {
  moduleEngine?: ModuleKnowledgeSearchEngine;
  moduleIndex?: ModuleKnowledgeIndexService;
  moduleStore?: ModuleKnowledgeSearchStore;
  moduleIndexToken?: string;
  allowedRepositories?: string[];
}): Promise<string> {
  const engine: SearchEngine = { search: vi.fn(async () => []) };
  const server = createHttpServer({
    engine,
    store: symbolStore(),
    corsOrigin: '*',
    allowedRepositories: options.allowedRepositories ?? ['acme/orders'],
    moduleEngine: options.moduleEngine,
    moduleIndex: options.moduleIndex,
    moduleStore: options.moduleStore ?? moduleStore(),
    moduleIndexToken: options.moduleIndexToken,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

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

function document(): IndexedModuleKnowledgeDocument {
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
    summary: 'Owns orders.',
    languageIds: ['typescript'],
    capabilities: ['order management'],
    domainTerms: ['orders'],
    publicApiSignatures: ['createOrder(): Order'],
    dependencyModuleIds: [],
    tags: [],
    risks: [],
    boundaryStatus: 'reviewed',
    narrativeStatus: 'reviewed',
    verificationStatus: 'unverified',
    trustTier: 'reviewed',
    repositoryScopes: ['acme/orders'],
    searchableContent: 'Orders createOrder',
  };
}

describe('module knowledge HTTP boundary', () => {
  it('serves an independent, repository/channel-scoped module query', async () => {
    const result = {
      scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
      activePublicationId: stagedPublication.id,
      activePublicationPayloadHash: stagedPublication.payloadHash,
      activeGeneration: 1,
      hits: [],
    };
    const search = vi.fn(async () => result);
    const url = await listen({ moduleEngine: { search } });
    const response = await fetch(`${url}/v1/module-knowledge/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'order creation',
        repositoryId: 'acme/orders',
        channel: 'branch:main',
        repositoryScopes: ['acme/orders'],
        topK: 5,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(search).toHaveBeenCalledWith({
      query: 'order creation',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: ['acme/orders'],
      topK: 5,
    });
  });

  it('requires the shared module-search ACL field instead of inventing client authority', async () => {
    const search = vi.fn(async () => ({
      scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
      activePublicationId: stagedPublication.id,
      activePublicationPayloadHash: stagedPublication.payloadHash,
      activeGeneration: 1,
      hits: [],
    }));
    const url = await listen({ moduleEngine: { search } });
    const response = await fetch(`${url}/v1/module-knowledge/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'order creation',
        repositoryId: 'acme/orders',
        channel: 'branch:main',
        topK: 5,
      }),
    });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('fails module-index writes closed unless the deployment token matches', async () => {
    const index = moduleIndex();
    const url = await listen({ moduleIndex: index, moduleIndexToken: 'writer-secret' });
    const body = {
      publication: stagedPublication,
      repositoryScopes: ['acme/orders'],
      documents: [document()],
    };

    const unauthorized = await fetch(`${url}/v1/module-knowledge/generations/stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const authorized = await fetch(`${url}/v1/module-knowledge/generations/stage`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(201);
    expect(index.stage).toHaveBeenCalledOnce();
  });

  it('rejects stage ACL scopes outside the deployment allow-list', async () => {
    const index = moduleIndex();
    const url = await listen({ moduleIndex: index, moduleIndexToken: 'writer-secret' });
    const response = await fetch(`${url}/v1/module-knowledge/generations/stage`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        publication: stagedPublication,
        repositoryScopes: ['acme/orders', 'other/private'],
        documents: [document()],
      }),
    });

    expect(response.status).toBe(403);
    expect(index.stage).not.toHaveBeenCalled();
  });

  it('exposes CAS conflicts without silently replacing a newer active generation', async () => {
    const activate = vi.fn(async () => {
      throw new ModuleKnowledgeCasError('head changed');
    });
    const url = await listen({
      moduleIndex: moduleIndex({ activate }),
      moduleIndexToken: 'writer-secret',
    });
    const response = await fetch(`${url}/v1/module-knowledge/generations/activate`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repositoryId: 'acme/orders',
        channel: 'branch:main',
        publicationId: 'publication-2',
        generation: 2,
        expectedActiveGeneration: 1,
      }),
    });

    expect(response.status).toBe(409);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('reads the authenticated active head including its publication payload hash', async () => {
    const activeHead = vi.fn(async () => ({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publicationId: stagedPublication.id,
      publicationPayloadHash: stagedPublication.payloadHash,
      generation: 1,
      revision: 4,
    }));
    const store = moduleStore();
    store.activeHead = activeHead;
    const url = await listen({
      moduleStore: store,
      moduleIndexToken: 'writer-secret',
    });
    const unauthorized = await fetch(`${url}/v1/module-knowledge/generations/head`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(stagedPublication.scope),
    });
    const response = await fetch(`${url}/v1/module-knowledge/generations/head`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer writer-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify(stagedPublication.scope),
    });

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      head: expect.objectContaining({
        publicationPayloadHash: stagedPublication.payloadHash,
        revision: 4,
      }),
    });
    expect(activeHead).toHaveBeenCalledWith('acme/orders', 'branch:main');
  });

  it('rejects module queries outside the deployment ACL', async () => {
    const search = vi.fn(async () => ({
      scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
      activePublicationId: stagedPublication.id,
      activePublicationPayloadHash: stagedPublication.payloadHash,
      activeGeneration: 1,
      hits: [],
    }));
    const url = await listen({ moduleEngine: { search } });
    const response = await fetch(`${url}/v1/module-knowledge/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'secrets',
        repositoryId: 'other/private',
        channel: 'branch:main',
        repositoryScopes: ['other/private'],
        topK: 5,
      }),
    });

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });
});
