import { describe, expect, it } from 'vitest';
import type {
  RepositoryIngestionManifest,
  RepositoryModuleCatalog,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  projectHistoryRepository,
  projectTargetWorkspaceRecord,
} from './module-explorer';

const hash = 'a'.repeat(64);
const producer = { kind: 'ingestion-host' as const, id: 'test' };

const ir = {
  schemaVersion: '1.1',
  id: 'ir-1',
  repositoryId: 'repo-1',
  profileId: 'profile-1',
  repositoryContentHash: hash,
  sourceShardIds: ['shard-1'],
  capabilities: ['symbol-index'],
  files: [{
    id: 'file-1',
    path: 'src/payment.ts',
    contentHash: hash,
    role: 'source',
    languageId: 'typescript',
    projectIds: [],
  }],
  entities: [
    {
      id: 'type-1',
      kind: 'type',
      name: 'PaymentService',
      languageId: 'typescript',
      fileId: 'file-1',
      range: { path: 'src/payment.ts', startLine: 1 },
      attributes: { staticSymbolKind: 'class' },
    },
    {
      id: 'callable-1',
      kind: 'callable',
      name: 'pay',
      languageId: 'typescript',
      fileId: 'file-1',
      containerEntityId: 'type-1',
      signature: 'pay(): Promise<void>',
      range: { path: 'src/payment.ts', startLine: 2 },
      attributes: { staticSymbolKind: 'method' },
    },
  ],
  apiSurfaces: [],
  dependencies: [],
  coverage: {
    discoveredFileCount: 1,
    analysedFileCount: 1,
    failedFileCount: 0,
    skippedFileCount: 0,
    languageIds: ['typescript'],
    missingCapabilities: [],
    segments: [],
  },
  diagnostics: [],
  contentHash: hash,
  producer,
  createdAt: '2026-09-02T00:00:00.000Z',
} as UnifiedRepositoryIR;

function catalog(status: RepositoryModuleCatalog['status']): RepositoryModuleCatalog {
  return {
    schemaVersion: '1.1',
    id: `catalog-${status}`,
    repositoryId: 'repo-1',
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: 'proposal-1',
    sourceProposalHash: hash,
    status,
    modules: [{
      id: 'payments',
      name: 'Payments',
      kind: 'business-capability',
      description: 'Payment capability',
      responsibilities: [],
      businessCapabilities: [],
      fileIds: ['file-1'],
      entityIds: ['type-1', 'callable-1'],
      entryPointEntityIds: ['callable-1'],
      publicApiEntityIds: ['callable-1'],
      boundaryRationale: 'test',
      evidenceRefs: [],
    }],
    assignments: [{
      fileId: 'file-1',
      moduleIds: ['payments'],
      kind: 'owned',
      rationale: 'test',
      evidenceRefs: [],
    }],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    ...(status === 'active' ? { reviewId: 'review-1', reviewHash: hash } : {}),
    contentHash: hash,
    producer,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

function manifest(status: RepositoryIngestionManifest['status']): RepositoryIngestionManifest {
  return {
    schemaVersion: '1.1',
    id: 'ingestion-1',
    repositoryId: 'repo-1',
    mode: 'full',
    status,
    repositoryContentHash: hash,
    requestedCapabilities: [],
    completedCapabilities: [],
    analysisAdapters: [],
    artifacts: {
      shards: [],
      moduleEvidenceBundles: [],
      moduleWikiProposals: status === 'ready' ? [{
        id: 'wiki-1',
        kind: 'repository-module-wiki-proposal',
        contentHash: hash,
      }] : [],
      moduleKnowledgeReviews: [],
      knowledgePublications: [],
      moduleIndexReceipts: [],
      publicationHeads: [],
      knowledge: [],
    },
    events: [],
    diagnostics: [],
    requestedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  } as RepositoryIngestionManifest;
}

describe('module workspace presentation', () => {
  it('projects only an active reviewed 01A catalog as selectable history modules', () => {
    const projected = projectHistoryRepository({
      registrationId: 'history:one',
      root: 'D:/history',
      name: 'history',
      analysisSnapshotId: 'analysis-1',
      manifest: manifest('ready'),
      ir,
      catalog: catalog('active'),
    });

    expect(projected.lifecycle).toMatchObject({
      ready: true,
      publicationActive: true,
      nextAction: 'withdraw-history-publication',
    });
    expect(projected.tree[0]?.historyModule).toEqual({
      repositoryRegistrationId: 'history:one',
      repositoryId: 'repo-1',
      catalogId: 'catalog-active',
      catalogHash: hash,
      moduleId: 'payments',
    });
    expect(projected.tree[0]?.children[0]?.children[0]?.children[0]?.historyModule)
      .toEqual(projected.tree[0]?.historyModule);
    expect(JSON.stringify(projected.tree)).toContain('pay(): Promise<void>');
  });

  it('keeps a draft 01A catalog browseable but does not mint a selection identity', () => {
    const projected = projectHistoryRepository({
      registrationId: 'history:draft',
      root: 'D:/history',
      name: 'history',
      manifest: manifest('awaiting-module-review'),
      ir,
      catalog: catalog('draft'),
    });

    expect(projected.lifecycle.nextAction).toBe('review-history-boundaries');
    expect(projected.lifecycle.ready).toBe(false);
    expect(projected.tree[0]?.historyModule).toBeUndefined();
  });

  it('keeps a withdrawn active catalog browseable but removes its formal selection identity', () => {
    const projected = projectHistoryRepository({
      registrationId: 'history:withdrawn',
      root: 'D:/history',
      name: 'history',
      manifest: manifest('superseded'),
      ir,
      catalog: catalog('active'),
    });

    expect(projected.lifecycle).toMatchObject({
      ready: false,
      publicationActive: false,
      nextAction: 'import-history',
    });
    expect(projected.tree[0]?.historyModule).toBeUndefined();
  });

  it('exposes initialization as the only action before 01B exists', () => {
    const projected = projectTargetWorkspaceRecord(
      null,
      'Target',
      'D:/target',
      'file:///D:/target',
    );

    expect(projected.id).toBe('file:///D:/target');
    expect(projected.lifecycle.nextAction).toBe('initialize-target');
    expect(projected.tree).toEqual([]);
  });
});
