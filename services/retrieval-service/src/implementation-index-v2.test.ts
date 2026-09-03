import {
  migrationExecutionV2SchemaVersion,
  migrationReferenceSchemaVersion,
  migrationRouteSchemaVersion,
  validationPolicySchemaVersion,
  type MigrationRouteDescriptor,
  type RepositoryModuleCatalogRef,
} from '@forexplore/contracts';
import {
  createMigrationRouteSnapshotRef,
  materializeImplementationCandidateRefV2,
  materializeIndexedImplementationDocumentV2,
  materializeMigrationRuntimeCapabilitySnapshot,
  materializeMigrationTargetRefV2,
  materializeSearchRequestV2,
  materializeSourceImplementationBundleV2,
} from '@forexplore/workflow-core';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { HashEmbeddingProvider } from './embedding.js';
import { createHttpServer } from './http-server.js';
import {
  HybridImplementationSearchEngineV2,
  materializeImplementationIndexGenerationV2,
} from './implementation-index-v2.js';
import type {
  ImplementationIndexGenerationV2,
  ImplementationIndexStoreV2,
  RetrievedImplementationDocumentV2,
} from './implementation-index-v2-types.js';
import { ImplementationIndexV2ConflictError } from './seekdb-implementation-index-v2-store.js';

const NOW = '2026-09-02T12:00:00.000Z';
const sha = (character: string) => character.repeat(64);

function route(): MigrationRouteDescriptor {
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'research-x-to-python',
    name: 'Research X to Python',
    version: '1.0.0',
    sourceLanguageId: 'research-lang-x',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: [{
      stage: 'source-analysis',
      providerId: 'external-host-analysis',
      providerVersion: '1.0.0',
      capabilities: [],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'target-analysis',
      providerId: 'external-host-analysis',
      providerVersion: '1.0.0',
      capabilities: [],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'translation',
      providerId: 'open-translator',
      providerVersion: '1.0.0',
      capabilities: ['code-translation'],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'behavior-validation',
      providerId: 'python-verifier',
      providerVersion: '1.0.0',
      capabilities: ['migration-validation'],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'workspace-apply',
      providerId: 'external-host-workspace',
      providerVersion: '1.0.0',
      capabilities: ['workspace-apply'],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'workspace-rollback',
      providerId: 'external-host-workspace',
      providerVersion: '1.0.0',
      capabilities: ['workspace-rollback'],
      availability: { status: 'available', reasonCodes: [] },
    }],
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'research-x-python-policy',
      routeId: 'research-x-to-python',
      routeVersion: '1.0.0',
      checks: [{
        id: 'behavior',
        label: 'Behavior parity',
        phase: 'behavior',
        required: true,
        verifierId: 'python-verifier',
        verifierVersion: '1.0.0',
      }],
      createdAt: NOW,
    },
  };
}

function catalog(repositoryId: string, seed: string): RepositoryModuleCatalogRef {
  return {
    repositoryId,
    repositoryRevision: `${repositoryId}-commit`,
    repositoryContentHash: sha(seed),
    unifiedRepositoryIrId: `${repositoryId}-ir`,
    unifiedRepositoryIrHash: sha(seed === '1' ? '2' : '8'),
    moduleCatalogId: `${repositoryId}-catalog`,
    moduleCatalogHash: sha(seed === '1' ? '3' : '9'),
    moduleReviewId: `${repositoryId}-review`,
    moduleReviewHash: sha(seed === '1' ? '4' : 'a'),
  };
}

function fixture() {
  const runtime = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
  const routeRef = createMigrationRouteSnapshotRef(runtime, route().id);
  const sourceCatalog = catalog('source-repository', '1');
  const targetCatalog = catalog('target-repository', '7');
  const target = materializeMigrationTargetRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    workspaceId: 'python-workspace',
    targetWorkspaceSnapshotId: 'target-snapshot',
    targetWorkspaceSnapshotHash: sha('b'),
    lineage: targetCatalog,
    entity: {
      entityId: 'target-function',
      fileId: 'target-file',
      languageId: 'python',
      kind: 'top-level-function',
      name: 'normalize',
      path: 'src/normalize.py',
      signature: 'def normalize(value):',
      fileContentHash: sha('c'),
      declarationIdentity: {
        kind: 'declaration',
        contentHash: sha('d'),
        schemaVersion: 'python-ast-v1',
        providerId: 'python-analyzer',
        providerVersion: '1.0.0',
      },
    },
    route: routeRef,
    allowedModificationPaths: ['src/normalize.py'],
  }, runtime);
  const candidate = materializeImplementationCandidateRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    id: 'candidate-research-x',
    lineage: sourceCatalog,
    entity: {
      entityId: 'source-operation',
      fileId: 'source-file',
      languageId: 'research-lang-x',
      kind: 'domain-operation',
      name: 'normalize',
      path: 'src/normalize.rx',
      signature: 'operation normalize(value)',
    },
  });
  const sourceBundle = materializeSourceImplementationBundleV2({
    candidate,
    primaryEntityId: 'source-operation',
    files: [{
      fileId: 'source-file',
      path: 'src/normalize.rx',
      languageId: 'research-lang-x',
      role: 'primary',
      content: 'operation normalize(value) { return value; }',
      contentHash: 'b3e477a764068439b7dd6224747fb6486834bc00cdaafc6e2cd5bad27ea5c3c1',
    }],
    producer: { providerId: 'research-x-bundler', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const document = materializeIndexedImplementationDocumentV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    candidate,
    sourceCatalog,
    moduleId: 'source-module',
    entityId: 'source-operation',
    fileId: 'source-file',
    fileContentHash: sourceBundle.files[0]!.contentHash,
    sourceBundle: { id: sourceBundle.id, contentHash: sourceBundle.contentHash },
    title: 'Normalize operation',
    summary: 'Normalizes a domain value.',
    searchText: 'normalize domain value',
    producer: { providerId: 'v2-indexer', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const generation = materializeImplementationIndexGenerationV2({
    schemaVersion: '2.0',
    repositoryId: sourceCatalog.repositoryId,
    generation: 1,
    sourceCatalog,
    repositoryScopes: [sourceCatalog.repositoryId],
    documents: [document],
    sourceBundles: [sourceBundle],
    createdAt: NOW,
  });
  const request = materializeSearchRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    target,
    route: routeRef,
    requirement: 'Implement normalization.',
    topK: 3,
    repositoryScopes: [sourceCatalog.repositoryId],
    candidateLanguageIds: ['research-lang-x'],
    rerank: false,
    createdAt: NOW,
  }, runtime);
  const generationRef = {
    repositoryId: generation.repositoryId,
    id: generation.id,
    generation: generation.generation,
    contentHash: generation.contentHash,
    sourceCatalogId: sourceCatalog.moduleCatalogId,
    sourceCatalogHash: sourceCatalog.moduleCatalogHash,
  };
  return { runtime, sourceCatalog, sourceBundle, document, generation, request, generationRef };
}

function storeFor(
  artifact: ReturnType<typeof fixture>,
  overrides: Partial<ImplementationIndexStoreV2> = {},
): ImplementationIndexStoreV2 {
  const retrieved: RetrievedImplementationDocumentV2 = {
    document: artifact.document,
    indexGeneration: artifact.generationRef,
    semanticScore: 0.9,
    textScore: 0.8,
  };
  return {
    ping: async () => undefined,
    initialize: async () => undefined,
    stage: async () => undefined,
    validate: async () => artifact.generation,
    activate: async () => ({
      repositoryId: artifact.generation.repositoryId,
      generationId: artifact.generation.id,
      generation: artifact.generation.generation,
      generationContentHash: artifact.generation.contentHash,
      sourceCatalogId: artifact.sourceCatalog.moduleCatalogId,
      sourceCatalogHash: artifact.sourceCatalog.moduleCatalogHash,
      revision: 1,
    }),
    activeHead: async () => ({
      repositoryId: artifact.generation.repositoryId,
      generationId: artifact.generation.id,
      generation: artifact.generation.generation,
      generationContentHash: artifact.generation.contentHash,
      sourceCatalogId: artifact.sourceCatalog.moduleCatalogId,
      sourceCatalogHash: artifact.sourceCatalog.moduleCatalogHash,
      revision: 1,
    }),
    resolveSourceBundle: async () => ({
      indexedDocument: artifact.document,
      bundle: artifact.sourceBundle,
    }),
    semanticSearch: async () => [retrieved],
    textSearch: async () => [retrieved],
    close: async () => undefined,
    ...overrides,
  };
}

describe('V2 reviewed implementation indexing and retrieval', () => {
  it('returns an open-language candidate for a Python top-level target with exact generation lineage', async () => {
    const artifact = fixture();
    const engine = new HybridImplementationSearchEngineV2(
      storeFor(artifact),
      new HashEmbeddingProvider(8),
      artifact.runtime,
    );
    const result = await engine.search(artifact.request, artifact.runtime);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      requestId: artifact.request.id,
      candidate: { entity: { languageId: 'research-lang-x', kind: 'domain-operation' } },
      indexGeneration: artifact.generationRef,
      sourceBundle: { id: artifact.sourceBundle.id, contentHash: artifact.sourceBundle.contentHash },
    });
    expect(result.indexedDocuments).toEqual([artifact.document]);
  });

  it('HTTP search and selected-bundle resolution enforce combined runtime, ACL, lineage, and generation freshness', async () => {
    const artifact = fixture();
    let staleGeneration = false;
    const store = storeFor(artifact, {
      resolveSourceBundle: async () => {
        if (staleGeneration) {
          throw new ImplementationIndexV2ConflictError('Selected bundle generation is stale.');
        }
        return { indexedDocument: artifact.document, bundle: artifact.sourceBundle };
      },
    });
    const engine = new HybridImplementationSearchEngineV2(
      store,
      new HashEmbeddingProvider(8),
      artifact.runtime,
    );
    const server = createHttpServer({
      engine: { search: async () => [] } as never,
      store: { ping: async () => undefined } as never,
      corsOrigin: '*',
      allowedRepositories: ['source-repository'],
      implementationEngineV2: engine,
      implementationStoreV2: store,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      const search = await post('/v2/search', {
        request: artifact.request,
        runtimeCapabilities: artifact.runtime,
      });
      expect(search.status).toBe(200);
      const searchBody = await search.json() as { candidates: typeof artifact.request[] };
      const candidate = (searchBody as unknown as { candidates: unknown[] }).candidates[0];

      const resolved = await post('/v2/source-bundles/resolve', {
        resolution: { request: artifact.request, candidate },
        runtimeCapabilities: artifact.runtime,
      });
      expect(resolved.status).toBe(200);
      await expect(resolved.json()).resolves.toMatchObject({
        bundle: { id: artifact.sourceBundle.id, contentHash: artifact.sourceBundle.contentHash },
      });

      const tamperedRuntime = await post('/v2/search', {
        request: artifact.request,
        runtimeCapabilities: { ...artifact.runtime, contentHash: sha('f') },
      });
      expect(tamperedRuntime.status).toBe(400);

      const unauthorizedRequest = materializeSearchRequestV2({
        ...artifact.request,
        repositoryScopes: ['other-repository'],
      }, artifact.runtime);
      const unauthorized = await post('/v2/search', {
        request: unauthorizedRequest,
        runtimeCapabilities: artifact.runtime,
      });
      expect(unauthorized.status).toBe(403);

      const lineageMismatch = await post('/v2/source-bundles/resolve', {
        resolution: {
          request: artifact.request,
          candidate: { ...(candidate as object), requestHash: sha('e') },
        },
        runtimeCapabilities: artifact.runtime,
      });
      expect(lineageMismatch.status).toBe(409);

      const candidateOutsideAcl = await post('/v2/source-bundles/resolve', {
        resolution: {
          request: artifact.request,
          candidate: {
            ...(candidate as object),
            indexGeneration: {
              ...(candidate as { indexGeneration: object }).indexGeneration,
              repositoryId: 'other-repository',
            },
          },
        },
        runtimeCapabilities: artifact.runtime,
      });
      expect(candidateOutsideAcl.status).toBe(403);

      staleGeneration = true;
      const stale = await post('/v2/source-bundles/resolve', {
        resolution: { request: artifact.request, candidate },
        runtimeCapabilities: artifact.runtime,
      });
      expect(stale.status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    }
  });

  it('rejects legacy/unbundled records and stale catalogs instead of synthesizing V2 lineage', () => {
    const artifact = fixture();
    expect(() => materializeImplementationIndexGenerationV2({
      ...artifact.generation,
      sourceBundles: [],
    } as unknown as Omit<ImplementationIndexGenerationV2, 'id' | 'contentHash'>)).toThrow(/source bundles/i);
    expect(() => materializeImplementationIndexGenerationV2({
      ...artifact.generation,
      sourceCatalog: { ...artifact.sourceCatalog, moduleCatalogHash: sha('f') },
    } as unknown as Omit<ImplementationIndexGenerationV2, 'id' | 'contentHash'>)).toThrow(/stale catalog lineage/i);
  });

  it('fails closed for reranking, tampered runtime snapshots, and stale active generations', async () => {
    const artifact = fixture();
    const engine = new HybridImplementationSearchEngineV2(
      storeFor(artifact),
      new HashEmbeddingProvider(8),
      artifact.runtime,
    );
    const rerank = materializeSearchRequestV2({
      ...artifact.request,
      rerank: true,
    }, artifact.runtime);
    await expect(engine.search(rerank, artifact.runtime)).rejects.toThrow(/reranking is unsupported/i);
    await expect(engine.search(artifact.request, {
      ...artifact.runtime,
      contentHash: sha('f'),
    })).rejects.toThrow(/hash|content/i);

    const stale = new HybridImplementationSearchEngineV2(
      storeFor(artifact, {
        activeHead: async () => ({
          repositoryId: artifact.generation.repositoryId,
          generationId: 'new-generation',
          generation: 2,
          generationContentHash: sha('e'),
          sourceCatalogId: artifact.sourceCatalog.moduleCatalogId,
          sourceCatalogHash: artifact.sourceCatalog.moduleCatalogHash,
          revision: 2,
        }),
      }),
      new HashEmbeddingProvider(8),
      artifact.runtime,
    );
    await expect(stale.search(artifact.request, artifact.runtime)).rejects.toThrow(/stale index generation/i);
  });

  it('accepts only the four Host-owned stage overrides in a combined snapshot', async () => {
    const artifact = fixture();
    const serviceRoute = artifact.runtime.routes[0]!;
    const combined = materializeMigrationRuntimeCapabilitySnapshot({
      routes: [{
        ...serviceRoute,
        stages: serviceRoute.stages.map((stage) =>
          ['source-analysis', 'target-analysis', 'workspace-apply', 'workspace-rollback'].includes(stage.stage)
            ? {
                ...stage,
                providerId: `trusted-host.${stage.stage}`,
                requirements: ['workspace:reviewed'],
              }
            : stage),
      }],
      createdAt: artifact.runtime.createdAt,
    });
    const combinedRoute = createMigrationRouteSnapshotRef(combined, serviceRoute.id);
    const { id: _targetId, contentHash: _targetHash, ...targetInput } = artifact.request.target;
    const target = materializeMigrationTargetRefV2({ ...targetInput, route: combinedRoute }, combined);
    const request = materializeSearchRequestV2({
      schemaVersion: migrationExecutionV2SchemaVersion,
      target,
      route: combinedRoute,
      requirement: artifact.request.requirement,
      topK: artifact.request.topK,
      repositoryScopes: artifact.request.repositoryScopes,
      candidateLanguageIds: artifact.request.candidateLanguageIds,
      rerank: false,
      createdAt: NOW,
    }, combined);
    const engine = new HybridImplementationSearchEngineV2(
      storeFor(artifact),
      new HashEmbeddingProvider(8),
      artifact.runtime,
    );
    await expect(engine.search(request, combined)).resolves.toMatchObject({
      candidates: [{ requestId: request.id }],
    });

    const protectedTamper = materializeMigrationRuntimeCapabilitySnapshot({
      routes: [{
        ...serviceRoute,
        stages: serviceRoute.stages.map((stage) => stage.stage === 'translation'
          ? { ...stage, providerId: 'client-forged-translator' }
          : stage),
      }],
      createdAt: artifact.runtime.createdAt,
    });
    const tamperedRoute = createMigrationRouteSnapshotRef(protectedTamper, serviceRoute.id);
    const tamperedTarget = materializeMigrationTargetRefV2(
      { ...targetInput, route: tamperedRoute },
      protectedTamper,
    );
    const tamperedRequest = materializeSearchRequestV2({
      schemaVersion: migrationExecutionV2SchemaVersion,
      target: tamperedTarget,
      route: tamperedRoute,
      requirement: artifact.request.requirement,
      topK: artifact.request.topK,
      repositoryScopes: artifact.request.repositoryScopes,
      candidateLanguageIds: artifact.request.candidateLanguageIds,
      rerank: false,
      createdAt: NOW,
    }, protectedTamper);
    await expect(engine.search(tamperedRequest, protectedTamper)).rejects.toThrow(/protected stage translation/i);
  });
});
