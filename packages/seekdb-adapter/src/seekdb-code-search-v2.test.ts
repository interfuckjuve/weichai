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
  materializeSearchCandidateV2,
  materializeSearchRequestV2,
  materializeSourceImplementationBundleV2,
  sha256Hex,
} from '@forexplore/workflow-core';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbCodeSearchAdapterV2 } from './seekdb-code-search-v2.js';

const NOW = '2026-09-02T12:00:00.000Z';
const hash = (value: string) => value.repeat(64);

function route(): MigrationRouteDescriptor {
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'unknown-to-python',
    name: 'Unknown source to Python',
    version: '1.0.0',
    sourceLanguageId: 'vendor-language-x',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: [{
      stage: 'translation',
      providerId: 'translator',
      providerVersion: '1.0.0',
      capabilities: ['code-translation'],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'behavior-validation',
      providerId: 'verifier',
      providerVersion: '1.0.0',
      capabilities: ['migration-validation'],
      availability: { status: 'available', reasonCodes: [] },
    }],
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'unknown-python-policy',
      routeId: 'unknown-to-python',
      routeVersion: '1.0.0',
      checks: [{
        id: 'behavior',
        label: 'Behavior',
        phase: 'behavior',
        required: true,
        verifierId: 'verifier',
        verifierVersion: '1.0.0',
      }],
      createdAt: NOW,
    },
  };
}

function lineage(repositoryId: string, seed: string): RepositoryModuleCatalogRef {
  return {
    repositoryId,
    repositoryContentHash: hash(seed),
    unifiedRepositoryIrId: `${repositoryId}-ir`,
    unifiedRepositoryIrHash: hash(seed === '1' ? '2' : '7'),
    moduleCatalogId: `${repositoryId}-catalog`,
    moduleCatalogHash: hash(seed === '1' ? '3' : '8'),
    moduleReviewId: `${repositoryId}-review`,
    moduleReviewHash: hash(seed === '1' ? '4' : '9'),
  };
}

function fixture() {
  const runtime = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
  const routeRef = createMigrationRouteSnapshotRef(runtime, route().id);
  const sourceCatalog = lineage('source-repo', '1');
  const targetCatalog = lineage('target-repo', '6');
  const target = materializeMigrationTargetRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    workspaceId: 'target-workspace',
    targetWorkspaceSnapshotId: 'target-snapshot',
    targetWorkspaceSnapshotHash: hash('a'),
    lineage: targetCatalog,
    entity: {
      entityId: 'target-call',
      fileId: 'target-file',
      languageId: 'python',
      kind: 'top-level-function',
      name: 'target',
      path: 'target.py',
      fileContentHash: hash('b'),
      declarationIdentity: {
        kind: 'declaration',
        contentHash: hash('c'),
        schemaVersion: 'python-ast-v1',
        providerId: 'python-adapter',
        providerVersion: '1.0.0',
      },
    },
    route: routeRef,
    allowedModificationPaths: ['target.py'],
  }, runtime);
  const candidateRef = materializeImplementationCandidateRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    id: 'source-candidate',
    lineage: sourceCatalog,
    entity: {
      entityId: 'source-call',
      fileId: 'source-file',
      languageId: 'vendor-language-x',
      kind: 'vendor-operation',
      name: 'source',
      path: 'source.vendor',
    },
  });
  const content = 'vendor operation source';
  const bundle = materializeSourceImplementationBundleV2({
    candidate: candidateRef,
    primaryEntityId: 'source-call',
    files: [{
      fileId: 'source-file',
      path: 'source.vendor',
      languageId: 'vendor-language-x',
      role: 'primary',
      content,
      contentHash: sha256Hex(content),
    }],
    producer: { providerId: 'vendor-bundler', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const document = materializeIndexedImplementationDocumentV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    candidate: candidateRef,
    sourceCatalog,
    moduleId: 'source-module',
    entityId: 'source-call',
    fileId: 'source-file',
    fileContentHash: sha256Hex(content),
    sourceBundle: { id: bundle.id, contentHash: bundle.contentHash },
    title: 'Vendor source',
    summary: 'Reviewed source operation.',
    searchText: 'source operation',
    producer: { providerId: 'v2-indexer', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const request = materializeSearchRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    target,
    route: routeRef,
    requirement: 'Implement source behavior.',
    topK: 1,
    repositoryScopes: ['source-repo'],
    candidateLanguageIds: ['vendor-language-x'],
    rerank: false,
    createdAt: NOW,
  }, runtime);
  const candidate = materializeSearchCandidateV2({
    request,
    indexedDocument: document,
    indexGeneration: {
      repositoryId: 'source-repo',
      id: 'generation-1',
      generation: 1,
      contentHash: hash('d'),
      sourceCatalogId: sourceCatalog.moduleCatalogId,
      sourceCatalogHash: sourceCatalog.moduleCatalogHash,
    },
    score: { overall: 0.8, semantic: 0.8, symbol: 0.7, contract: 1 },
    createdAt: NOW,
  }, runtime);
  return { runtime, request, candidate, document, bundle };
}

describe('SeekDbCodeSearchAdapterV2', () => {
  it('sends the exact runtime snapshot and validates candidate and selected bundle lineage', async () => {
    const artifact = fixture();
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/v2/search')) {
        return Response.json({ candidates: [artifact.candidate], indexedDocuments: [artifact.document] });
      }
      return Response.json({ indexedDocument: artifact.document, bundle: artifact.bundle });
    });
    const adapter = new SeekDbCodeSearchAdapterV2({
      baseUrl: 'http://retrieval.local/',
      fetch,
      runtimeCapabilities: artifact.runtime,
    });

    await expect(adapter.search(artifact.request)).resolves.toEqual([artifact.candidate]);
    await expect(adapter.resolveSourceBundle({
      request: artifact.request,
      candidate: artifact.candidate,
    })).resolves.toEqual({ indexedDocument: artifact.document, bundle: artifact.bundle });
    const firstBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(firstBody.runtimeCapabilities).toEqual(artifact.runtime);
  });

  it('rejects a rotated/tampered runtime snapshot before issuing a request', async () => {
    const artifact = fixture();
    const fetch = vi.fn();
    const adapter = new SeekDbCodeSearchAdapterV2({
      baseUrl: 'http://retrieval.local',
      fetch,
      runtimeCapabilities: () => ({ ...artifact.runtime, contentHash: hash('f') }),
    });
    await expect(adapter.search(artifact.request)).rejects.toThrow(/hash|content/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
