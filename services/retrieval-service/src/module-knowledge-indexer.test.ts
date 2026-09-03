import { describe, expect, it } from 'vitest';
import {
  repositoryIngestionSchemaVersion,
  repositoryKnowledgePublicationSchemaVersion,
  type RepositoryModuleCatalog,
  type RepositoryModuleKnowledgePage,
  type RepositoryKnowledgePublication,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  canonicalJson,
  materializeRepositoryModuleKnowledgePage,
  sha256Hex,
} from '@forexplore/workflow-core';
import { buildIndexedModuleKnowledgeDocument } from './module-knowledge-indexer.js';

const producer = { kind: 'human' as const, id: 'test-reviewer', version: '1' };

function fixture(): {
  page: RepositoryModuleKnowledgePage;
  generatedPage: RepositoryModuleKnowledgePage;
  publication: RepositoryKnowledgePublication;
  ir: UnifiedRepositoryIR;
  catalog: RepositoryModuleCatalog;
} {
  const ir: UnifiedRepositoryIR = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'ir-1',
    repositoryId: 'acme/orders',
    profileId: 'profile-1',
    repositoryContentHash: '0'.repeat(64),
    sourceShardIds: ['shard-1'],
    capabilities: ['api-surface', 'dependency-graph', 'file-inventory', 'symbol-index'],
    files: [{
      id: 'file-orders',
      path: 'src/orders.ts',
      contentHash: '1'.repeat(64),
      role: 'source',
      languageId: 'typescript',
      projectIds: ['project-1'],
    }],
    entities: [{
      id: 'entity-create-order',
      kind: 'callable',
      name: 'createOrder',
      qualifiedName: 'orders.createOrder',
      signature: 'createOrder(input: OrderInput): Order',
      languageId: 'typescript',
      fileId: 'file-orders',
    }],
    apiSurfaces: [{
      id: 'api-create-order',
      entityId: 'entity-create-order',
      languageId: 'typescript',
      kind: 'function',
      name: 'createOrder',
      qualifiedName: 'orders.createOrder',
      signature: 'createOrder(input: OrderInput): Order',
      visibility: 'exported',
      exposure: 'exported',
      parameters: [{
        name: 'input',
        position: 0,
        type: 'OrderInput',
        required: true,
      }],
      returnShape: { type: 'Order' },
      completeness: 'complete',
      missingFeatures: [],
      evidenceRefs: [{
        id: 'evidence-create-order',
        kind: 'syntactic-analysis',
        path: 'src/orders.ts',
      }],
    }],
    dependencies: [],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['typescript'],
      missingCapabilities: [],
      segments: [{
        id: 'segment-typescript',
        shardId: 'shard-1',
        languageId: 'typescript',
        discoveredFileCount: 1,
        analysedFileCount: 1,
        failedFileCount: 0,
        skippedFileCount: 0,
        capabilities: ['api-surface', 'dependency-graph', 'file-inventory', 'symbol-index'],
        missingCapabilities: [],
        diagnosticIds: [],
      }],
    },
    diagnostics: [],
    contentHash: 'a'.repeat(64),
    producer,
    createdAt: '2026-08-31T00:00:00.000Z',
  };
  const catalog: RepositoryModuleCatalog = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'catalog-1',
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: 'proposal-1',
    sourceProposalHash: 'c'.repeat(64),
    status: 'active',
    modules: [{
      id: 'orders',
      name: 'Orders',
      kind: 'business-capability',
      description: 'Creates and manages orders.',
      responsibilities: ['create orders'],
      businessCapabilities: ['order management'],
      fileIds: ['file-orders'],
      entityIds: ['entity-create-order'],
      entryPointEntityIds: ['entity-create-order'],
      publicApiEntityIds: ['entity-create-order'],
      boundaryRationale: 'Order ownership.',
      evidenceRefs: [],
    }],
    assignments: [{
      fileId: 'file-orders',
      moduleIds: ['orders'],
      kind: 'owned',
      rationale: 'Primary order implementation.',
      evidenceRefs: [],
    }],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    reviewId: 'review-1',
    reviewHash: 'd'.repeat(64),
    contentHash: 'b'.repeat(64),
    producer,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
  const generatedPage = materializeRepositoryModuleKnowledgePage({
    catalog,
    ir,
    moduleId: 'orders',
    wiki: {
      summary: 'Owns the order lifecycle.',
      architecture: 'Application service with a stable API.',
      publicInterfaces: 'createOrder is the public entry point.',
      dataFlow: 'Order input is validated and persisted.',
      operationalNotes: 'No background jobs.',
      reuseGuidance: 'Reuse through createOrder.',
      limitations: ['Payment is external.'],
      risks: ['Persistence contract is not verified.'],
      evidenceIds: [],
      tags: ['commerce'],
    },
    producer,
    createdAt: '2026-08-31T00:00:00.000Z',
  });
  const reviewedPayload = {
    ...Object.fromEntries(
      Object.entries(generatedPage).filter(([key]) => !['id', 'contentHash'].includes(key)),
    ),
    source: {
      ...generatedPage.source,
      evidenceBundleId: 'evidence-bundle-1',
      evidenceBundleHash: 'e'.repeat(64),
      wikiProposalId: 'wiki-proposal-1',
      wikiProposalHash: 'f'.repeat(64),
      knowledgeReviewId: 'knowledge-review-1',
      knowledgeReviewHash: '1'.repeat(64),
    },
    boundaryStatus: 'reviewed' as const,
    narrativeStatus: 'reviewed' as const,
    verificationStatus: 'unverified' as const,
    trustTier: 'reviewed' as const,
    producer: { kind: 'knowledge-publisher' as const, id: 'test-publisher', version: '1' },
  } as Omit<RepositoryModuleKnowledgePage, 'id' | 'contentHash'>;
  const reviewedHash = sha256Hex(canonicalJson(reviewedPayload));
  const page: RepositoryModuleKnowledgePage = {
    ...reviewedPayload,
    id: `repository-module-knowledge:orders:${reviewedHash.slice(0, 24)}`,
    contentHash: reviewedHash,
  };
  const immutablePublication = {
    scope: { repositoryId: ir.repositoryId, channel: 'branch:main' },
    repositoryScopes: [ir.repositoryId],
    generation: 1,
    source: {
      repositoryModuleBundleId: 'bundle-1',
      repositoryModuleBundleHash: '2'.repeat(64),
      modules: [{
        moduleId: 'orders',
        evidenceBundleId: 'evidence-bundle-1',
        evidenceBundleHash: 'e'.repeat(64),
        wikiProposalId: 'wiki-proposal-1',
        wikiProposalHash: 'f'.repeat(64),
        knowledgeReviewId: 'knowledge-review-1',
        knowledgeReviewHash: '1'.repeat(64),
        knowledgePageId: page.id,
        knowledgePageHash: page.contentHash,
      }],
    },
    artifacts: [],
  };
  const payloadHash = sha256Hex(canonicalJson(immutablePublication));
  const publicationPayload = {
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: `repository-knowledge-publication:${payloadHash.slice(0, 24)}`,
    ...immutablePublication,
    status: 'staged' as const,
    payloadHash,
    stagedAt: '2026-08-31T00:01:00.000Z',
    producer: { kind: 'knowledge-publisher' as const, id: 'test-publisher', version: '1' },
  };
  const publication: RepositoryKnowledgePublication = {
    ...publicationPayload,
    contentHash: sha256Hex(canonicalJson(publicationPayload)),
  };
  return { page, generatedPage, publication, ir, catalog };
}

describe('buildIndexedModuleKnowledgeDocument', () => {
  it('creates a distinct functional-module search projection', () => {
    const { page, publication, ir, catalog } = fixture();
    const document = buildIndexedModuleKnowledgeDocument(
      page,
      ir,
      catalog,
      ['acme/orders'],
      publication,
    );

    expect(document.documentKind).toBe('functional-module');
    expect(document.languageIds).toEqual(['typescript']);
    expect(document.publicApiSignatures).toEqual(['createOrder(input: OrderInput): Order']);
    expect(document.capabilities).toContain('order management');
    expect(document.searchableContent).toContain('Owns the order lifecycle.');
    expect(document.trustTier).toBe('reviewed');
    expect(document.narrativeStatus).toBe('reviewed');
    expect(document.publicationGeneration).toBe(1);
  });

  it('does not project generated prose before the independent summary review', () => {
    const { generatedPage, publication, ir, catalog } = fixture();
    expect(() => buildIndexedModuleKnowledgeDocument(
      generatedPage,
      ir,
      catalog,
      ['acme/orders'],
      publication,
    )).toThrow('Only independently reviewed module knowledge');
  });

  it('rejects a knowledge page bound to another IR', () => {
    const { page, publication, ir, catalog } = fixture();
    page.source.unifiedRepositoryIrHash = 'stale-hash';

    expect(() => buildIndexedModuleKnowledgeDocument(page, ir, catalog, ['acme/orders'], publication))
      .toThrow('does not match its immutable sources');
  });

  it('rejects unknown public API evidence', () => {
    const { page, publication, ir, catalog } = fixture();
    page.raw.publicApiEntityIds = ['missing'];

    expect(() => buildIndexedModuleKnowledgeDocument(page, ir, catalog, ['acme/orders'], publication))
      .toThrow('does not match its immutable sources');
  });

  it('does not let a projection replace the immutable publication ACL', () => {
    const { page, publication, ir, catalog } = fixture();

    expect(() => buildIndexedModuleKnowledgeDocument(
      page,
      ir,
      catalog,
      ['acme/orders', 'other/private'],
      publication,
    )).toThrow('immutable publication ACL');
  });
});
