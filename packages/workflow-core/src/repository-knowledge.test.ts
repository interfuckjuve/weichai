import { describe, expect, it } from 'vitest';
import {
  repositoryIngestionSchemaVersion,
  type ModuleDiscoveryProposal,
  type RepositoryArtifactProducer,
  type RepositoryIngestionEvent,
  type RepositoryModuleCatalog,
  type RepositoryModuleReview,
  type RepositoryModuleWikiDraft,
  type RepositoryModuleWikiEvidenceBinding,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  appendRepositoryModuleKnowledgeLog,
  applyRepositoryModuleReview,
  deriveInitialRepositoryModuleWikiDraft,
  materializeRepositoryModuleKnowledgeArtifacts,
  materializeIndexedModuleKnowledgeDocument,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleBundle,
  materializeRepositoryModuleKnowledgeIndexArtifact,
  materializeRepositoryModuleKnowledgeJsonlArtifact,
  materializeRepositoryModuleKnowledgeLogArtifact,
  materializeRepositoryModuleKnowledgePage,
  materializeRepositoryModuleKnowledgeSchemaArtifact,
  materializeRepositoryModuleReview,
  repositoryModuleKnowledgeIndexPath,
  repositoryModuleKnowledgeJsonPath,
  repositoryModuleKnowledgeJsonlPath,
  repositoryModuleKnowledgeLogPath,
  repositoryModuleKnowledgeMarkdownPath,
  repositoryModuleKnowledgeSchemaPath,
  serializeRepositoryModuleKnowledgeIndex,
  serializeRepositoryModuleKnowledgeJsonl,
  serializeRepositoryModuleKnowledgeSchema,
  validateRepositoryModuleKnowledgePage,
  validateRepositoryModuleBundle,
} from './repository-knowledge';
import { canonicalJson, sha256Hex } from './module-plan-utils';
import {
  activateRepositoryKnowledgePublication,
  createRepositoryImportBatch,
  finalizeRepositoryImportBatch,
  materializeRepositoryModuleEvidenceBundle,
  materializeRepositoryModuleIndexReceipt,
  materializeRepositoryModuleKnowledgeReview,
  materializeRepositoryModuleSummaryJsonSchemaArtifact,
  materializeRepositoryModuleWikiProposal,
  materializeReviewedRepositoryModuleKnowledgePage,
  repositoryModuleSummaryJsonSchema,
  stageRepositoryKnowledgePublication,
  updateRepositoryImportBatchItem,
  validateRepositoryKnowledgePublication,
  validateRepositoryKnowledgePublicationHead,
  validateRepositoryModuleIndexReceipt,
  validateRepositoryModuleSummaryRevisionContext,
  validateRepositoryModuleWikiProposal,
  withdrawRepositoryKnowledgePublication,
} from './repository-knowledge-lifecycle';

const now = '2026-08-31T00:00:00.000Z';
const irHash = 'a'.repeat(64);
const catalogHash = 'b'.repeat(64);
const producer: RepositoryArtifactProducer = {
  kind: 'module-discovery-agent',
  id: 'agenticodex-module-wiki',
  version: '1.0.0',
};

function ir(): UnifiedRepositoryIR {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'ir-orders-v1',
    repositoryId: 'repository-orders',
    profileId: 'profile-orders',
    repositoryRevision: '1'.repeat(40),
    repositoryContentHash: 'c'.repeat(64),
    sourceShardIds: ['shard-java'],
    capabilities: ['api-surface', 'dependency-graph', 'repository-profile', 'symbol-index'],
    files: [
      {
        id: 'file-orders',
        path: 'src/Orders.java',
        contentHash: 'd'.repeat(64),
        role: 'source',
        languageId: 'java',
        projectIds: ['project-orders'],
      },
      {
        id: 'file-contracts',
        path: 'src/Contracts.java',
        contentHash: 'e'.repeat(64),
        role: 'source',
        languageId: 'java',
        projectIds: ['project-orders'],
      },
    ],
    entities: [
      {
        id: 'entity-orders',
        kind: 'type',
        name: 'Orders',
        fileId: 'file-orders',
        languageId: 'java',
        signature: 'Orders.submit(Order): Receipt',
      },
      {
        id: 'entity-contracts',
        kind: 'type',
        name: 'Contracts',
        fileId: 'file-contracts',
        languageId: 'java',
        signature: 'Contracts.Order',
      },
    ],
    apiSurfaces: [
      {
        id: 'api-orders-submit',
        entityId: 'entity-orders',
        languageId: 'java',
        kind: 'type',
        name: 'Orders',
        qualifiedName: 'example.Orders',
        signature: 'Orders.submit(Order): Receipt',
        visibility: 'public',
        exposure: 'public',
        completeness: 'complete',
        missingFeatures: [],
        evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
      },
      {
        id: 'api-contracts-order',
        entityId: 'entity-contracts',
        languageId: 'java',
        kind: 'type',
        name: 'Contracts',
        qualifiedName: 'example.Contracts',
        signature: 'Contracts.Order',
        visibility: 'public',
        exposure: 'public',
        completeness: 'complete',
        missingFeatures: [],
        evidenceRefs: [{ id: 'entity-contracts', kind: 'semantic-analysis' }],
      },
    ],
    dependencies: [{
      id: 'edge-orders-contracts',
      sourceEntityId: 'entity-orders',
      targetEntityId: 'entity-contracts',
      sourceFileId: 'file-orders',
      targetFileId: 'file-contracts',
      kind: 'type-reference',
      internal: true,
      resolution: 'resolved',
      evidenceLevel: 'semantic',
      evidenceRefs: [{ id: 'edge-orders-contracts', kind: 'semantic-analysis' }],
    }],
    coverage: {
      discoveredFileCount: 2,
      analysedFileCount: 2,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['java'],
      missingCapabilities: [],
      segments: [{
        id: 'coverage-shard-java',
        shardId: 'shard-java',
        languageId: 'java',
        discoveredFileCount: 2,
        analysedFileCount: 2,
        failedFileCount: 0,
        skippedFileCount: 0,
        capabilities: ['api-surface', 'dependency-graph', 'symbol-index'],
        missingCapabilities: [],
        diagnosticIds: [],
      }],
    },
    diagnostics: [],
    contentHash: irHash,
    producer: { kind: 'ingestion-host', id: 'host' },
    createdAt: now,
  };
}

function proposal(): ModuleDiscoveryProposal {
  const source = catalog();
  const withoutHash: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'proposal-orders-v1',
    repositoryId: 'repository-orders',
    sourceIrId: 'ir-orders-v1',
    sourceIrHash: irHash,
    objective: 'Discover functional order boundaries.',
    constraints: [],
    status: 'awaiting-review',
    modules: source.modules.map((module) => ({
      ...module,
      evidenceRefs: [{
        id: module.id === 'orders' ? 'entity-orders' : 'entity-contracts',
        kind: 'semantic-analysis' as const,
      }],
    })),
    assignments: source.assignments.map((assignment) => ({
      ...assignment,
      evidenceRefs: [{
        id: assignment.fileId,
        kind: 'source' as const,
      }],
    })),
    dependencies: source.dependencies,
    assumptions: ['Runtime ownership follows the static dependency direction.'],
    risks: ['Static evidence does not prove ordering semantics.'],
    unresolvedQuestions: ['Who owns payment capture?'],
    producer,
    createdAt: now,
  };
  return {
    ...withoutHash,
    contentHash: sha256Hex(canonicalJson(withoutHash)),
  };
}

function rehashProposal(value: ModuleDiscoveryProposal): ModuleDiscoveryProposal {
  const { contentHash: _ignored, ...withoutHash } = value;
  return { ...withoutHash, contentHash: sha256Hex(canonicalJson(withoutHash)) };
}

function catalog(): RepositoryModuleCatalog {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'catalog-orders-v1',
    repositoryId: 'repository-orders',
    sourceIrId: 'ir-orders-v1',
    sourceIrHash: irHash,
    sourceProposalId: 'proposal-orders-v1',
    sourceProposalHash: 'f'.repeat(64),
    status: 'draft',
    modules: [
      {
        id: 'orders',
        name: 'Orders',
        kind: 'business-capability',
        description: 'Owns order submission and status.',
        responsibilities: ['Read order status', 'Submit orders'],
        businessCapabilities: ['Order management'],
        fileIds: ['file-orders'],
        entityIds: ['entity-orders'],
        entryPointEntityIds: ['entity-orders'],
        publicApiEntityIds: ['entity-orders'],
        boundaryRationale: 'Order lifecycle changes together.',
        evidenceRefs: [{ id: 'evidence-orders', kind: 'semantic-analysis' }],
        tags: ['orders'],
      },
      {
        id: 'contracts',
        name: 'Contracts',
        kind: 'shared-kernel',
        description: 'Shared public contracts.',
        responsibilities: ['Define contracts'],
        businessCapabilities: [],
        fileIds: ['file-contracts'],
        entityIds: ['entity-contracts'],
        entryPointEntityIds: [],
        publicApiEntityIds: ['entity-contracts'],
        boundaryRationale: 'Public contract ownership.',
        evidenceRefs: [{ id: 'evidence-contracts', kind: 'semantic-analysis' }],
      },
    ],
    assignments: [
      {
        fileId: 'file-orders',
        moduleIds: ['orders'],
        kind: 'owned',
        rationale: 'Order implementation.',
        evidenceRefs: [{ id: 'evidence-orders', kind: 'semantic-analysis' }],
      },
      {
        fileId: 'file-contracts',
        moduleIds: ['contracts'],
        kind: 'owned',
        rationale: 'Contract implementation.',
        evidenceRefs: [{ id: 'evidence-contracts', kind: 'semantic-analysis' }],
      },
    ],
    dependencies: [{
      sourceModuleId: 'orders',
      targetModuleId: 'contracts',
      kind: 'type-reference',
      evidenceRefs: [{ id: 'edge-orders-contracts', kind: 'semantic-analysis' }],
    }],
    unassignedFileIds: [],
    overlappingFileIds: [],
    contentHash: catalogHash,
    producer,
    createdAt: now,
    updatedAt: now,
  };
}

function wiki(summary = 'Provides the repository order capability.'): RepositoryModuleWikiDraft {
  return {
    summary,
    architecture: 'Coordinates order persistence behind the order boundary.',
    publicInterfaces: 'Orders.submit and Orders.status.',
    dataFlow: 'Request → validation → persistence.',
    operationalNotes: 'Requires the shared contracts module.',
    reuseGuidance: 'Reuse when the target preserves the order lifecycle.',
    limitations: ['Does not own payment capture'],
    risks: ['Ordering semantics need target acceptance tests'],
    evidenceIds: ['edge-orders-contracts', 'evidence-orders'],
    tags: ['order-management', 'business'],
  };
}

function page(moduleId = 'orders') {
  return materializeRepositoryModuleKnowledgePage({
    catalog: catalog(),
    ir: ir(),
    moduleId,
    wiki: moduleId === 'orders' ? wiki() : {
      ...wiki('Defines contracts shared by repository modules.'),
      evidenceIds: ['evidence-contracts'],
    },
    producer,
    createdAt: now,
  });
}

function acceptedState(): {
  sourceIr: UnifiedRepositoryIR;
  sourceProposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
} {
  const sourceIr = ir();
  const sourceProposal = proposal();
  const draft = materializeRepositoryModuleCatalog(sourceProposal, sourceIr, {
    producer: { kind: 'ingestion-host', id: 'host' },
    createdAt: now,
  });
  const review = materializeRepositoryModuleReview(sourceProposal, sourceIr, {
    decision: 'accept',
    reviewerId: 'architect',
    decidedAt: now,
  });
  const applied = applyRepositoryModuleReview(draft, sourceProposal, sourceIr, review);
  if (!applied.catalog) throw new Error('Accepted test review did not produce a catalog.');
  return { sourceIr, sourceProposal, review, catalog: applied.catalog };
}

function reviewedKnowledgeFixture() {
  const accepted = acceptedState();
  const generatedPages = accepted.catalog.modules.map((module) =>
    materializeRepositoryModuleKnowledgePage({
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      moduleId: module.id,
      wiki: deriveInitialRepositoryModuleWikiDraft(
        accepted.sourceProposal,
        accepted.catalog,
        accepted.sourceIr,
        module.id,
      ),
      producer,
      createdAt: now,
    }),
  );
  const boundaryBundle = materializeRepositoryModuleBundle({
    proposal: accepted.sourceProposal,
    review: accepted.review,
    catalog: accepted.catalog,
    ir: accepted.sourceIr,
    knowledgePages: generatedPages,
    producer: { kind: 'ingestion-host', id: 'host' },
    createdAt: now,
  });
  const evidenceBundles = accepted.catalog.modules.map((module) => {
    const content = `Evidence for ${module.id}`;
    const primaryEvidenceId = module.id === 'orders' ? 'entity-orders' : 'entity-contracts';
    const sourcePath = module.id === 'orders' ? 'src/Orders.java' : 'src/Contracts.java';
    return materializeRepositoryModuleEvidenceBundle({
      repositoryModuleBundle: boundaryBundle,
      moduleId: module.id,
      items: [{
        id: `evidence-item-${module.id}`,
        kind: 'source-slice',
        evidenceKind: 'source',
        evidenceRefIds: [primaryEvidenceId],
        path: sourcePath,
        mediaType: 'text/plain',
        content,
        byteLength: new TextEncoder().encode(content).byteLength,
        contentHash: sha256Hex(content),
        truncated: false,
      }],
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    });
  });
  const wikiProposals = evidenceBundles.map((evidenceBundle) => {
    const narrative = deriveInitialRepositoryModuleWikiDraft(
      accepted.sourceProposal,
      accepted.catalog,
      accepted.sourceIr,
      evidenceBundle.moduleId,
    );
    return materializeRepositoryModuleWikiProposal({
      evidenceBundle,
      narrative,
      evidenceBindings: claimBindings(narrative),
      generation: {
        modelId: 'summary-model',
        promptTemplateId: 'module-summary',
        promptTemplateVersion: '1.0.0',
      },
      producer: { kind: 'module-summary-agent', id: 'summary-agent', version: '1.0.0' },
      createdAt: now,
    });
  });
  const knowledgeReviews = wikiProposals.map((proposal, index) =>
    materializeRepositoryModuleKnowledgeReview(proposal, evidenceBundles[index]!, {
      decision: 'accept',
      reviewerId: 'knowledge-owner',
      reviewedAt: now,
    }),
  );
  const knowledgePages = wikiProposals.map((proposal, index) =>
    materializeReviewedRepositoryModuleKnowledgePage({
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      evidenceBundle: evidenceBundles[index]!,
      wikiProposal: proposal,
      knowledgeReview: knowledgeReviews[index]!,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      createdAt: now,
    }),
  );
  const artifacts = [
    ...knowledgePages.flatMap((page) => [{
      id: `${page.id}:json`,
      kind: 'repository-wiki' as const,
      contentHash: page.contentHash,
      hashAlgorithm: 'sha256' as const,
      path: `.forexplore/publications/generation-1/${page.moduleId}/summary.json`,
      mediaType: 'application/json',
    }, {
      id: `${page.id}:markdown`,
      kind: 'repository-wiki' as const,
      contentHash: page.contentHash,
      hashAlgorithm: 'sha256' as const,
      path: `.forexplore/publications/generation-1/${page.moduleId}/summary.md`,
      mediaType: 'text/markdown',
    }]),
    {
      id: 'module-summary-schema-v1',
      kind: 'repository-wiki' as const,
      contentHash: '7'.repeat(64),
      hashAlgorithm: 'sha256' as const,
      path: '.forexplore/publications/generation-1/summary.schema.json',
      mediaType: 'application/schema+json',
    },
    {
      id: 'module-index-jsonl-v1',
      kind: 'repository-search-index' as const,
      contentHash: '8'.repeat(64),
      hashAlgorithm: 'sha256' as const,
      path: '.forexplore/publications/generation-1/modules.jsonl',
      mediaType: 'application/x-ndjson',
    },
  ];
  return {
    accepted,
    boundaryBundle,
    evidenceBundles,
    wikiProposals,
    knowledgeReviews,
    knowledgePages,
    artifacts,
  };
}

function claimBindings(narrative: RepositoryModuleWikiDraft): RepositoryModuleWikiEvidenceBinding[] {
  const result: RepositoryModuleWikiEvidenceBinding[] = [];
  const evidenceIds = [...narrative.evidenceIds];
  for (const section of [
    'summary', 'architecture', 'publicInterfaces', 'dataFlow', 'operationalNotes', 'reuseGuidance',
  ] as const) {
    if (narrative[section].trim()) {
      result.push({ section, claim: narrative[section], evidenceIds });
    }
  }
  for (const section of ['limitations', 'risks'] as const) {
    for (const claim of narrative[section]) result.push({ section, claim, evidenceIds });
  }
  return result;
}

describe('repository module knowledge', () => {
  it('materializes a content-addressed draft catalog and activates only an accepted review', () => {
    const sourceIr = ir();
    const sourceProposal = proposal();
    const draft = materializeRepositoryModuleCatalog(sourceProposal, sourceIr, {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    });
    const acceptedReview = materializeRepositoryModuleReview(sourceProposal, sourceIr, {
      decision: 'accept',
      reviewerId: 'architect',
      decidedAt: now,
    });
    const reviseReview = materializeRepositoryModuleReview(sourceProposal, sourceIr, {
      decision: 'revise',
      reviewerId: 'architect',
      decidedAt: now,
    });
    const rejectReview = materializeRepositoryModuleReview(sourceProposal, sourceIr, {
      decision: 'reject',
      reviewerId: 'architect',
      decidedAt: now,
    });
    const accepted = applyRepositoryModuleReview(draft, sourceProposal, sourceIr, acceptedReview);
    const revised = applyRepositoryModuleReview(draft, sourceProposal, sourceIr, reviseReview);
    const rejected = applyRepositoryModuleReview(draft, sourceProposal, sourceIr, rejectReview);

    expect(draft).toMatchObject({
      id: `repository-module-catalog:${draft.contentHash.slice(0, 24)}`,
      sourceProposalId: 'proposal-orders-v1',
      status: 'draft',
      unassignedFileIds: [],
      overlappingFileIds: [],
    });
    expect(draft.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.catalog).toMatchObject({
      status: 'active',
      reviewId: acceptedReview.id,
      reviewHash: acceptedReview.contentHash,
    });
    expect(revised.catalog).toBeUndefined();
    expect(revised.replacementProposalRequired).toBe(true);
    expect(rejected.catalog).toBeUndefined();
    expect(rejected.replacementProposalRequired).toBe(false);
    expect(reviseReview.replacementProposalRequired).toBe(true);
    expect(rejectReview.replacementProposalRequired).toBe(false);
    expect(() => materializeRepositoryModuleCatalog(sourceProposal, sourceIr, {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
      review: acceptedReview,
    })).toThrow('use applyRepositoryModuleReview');
  });

  it('rejects invented IDs, incomplete or duplicate assignments, and an IR hash mismatch', () => {
    const invented = proposal();
    invented.modules[0]!.fileIds[0] = 'invented-file';
    expect(() => materializeRepositoryModuleCatalog(rehashProposal(invented), ir(), {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('invented file ID');

    const incomplete = proposal();
    incomplete.assignments.pop();
    expect(() => materializeRepositoryModuleCatalog(rehashProposal(incomplete), ir(), {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('do not account for IR file');

    const duplicate = proposal();
    duplicate.assignments.push({ ...duplicate.assignments[0]! });
    expect(() => materializeRepositoryModuleCatalog(rehashProposal(duplicate), ir(), {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('duplicate assignment');

    const mismatch = proposal();
    mismatch.sourceIrHash = 'f'.repeat(64);
    expect(() => materializeRepositoryModuleCatalog(rehashProposal(mismatch), ir(), {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('does not bind to the supplied unified IR');
  });

  it.each(['private', 'unknown'] as const)(
    'rejects a module public API whose language adapter classifies it as %s',
    (exposure) => {
      const sourceIr = ir();
      sourceIr.apiSurfaces[0]!.exposure = exposure;
      expect(() => materializeRepositoryModuleCatalog(proposal(), sourceIr, {
        producer: { kind: 'ingestion-host', id: 'host' },
        createdAt: now,
      })).toThrow('non-public or unknown exposure');
    },
  );

  it('rejects an API surface that invents evidence and then cites it as its own proof', () => {
    const sourceIr = ir();
    sourceIr.apiSurfaces[0]!.evidenceRefs = [{
      id: 'invented-surface-evidence',
      kind: 'semantic-analysis',
    }];
    expect(() => materializeRepositoryModuleCatalog(proposal(), sourceIr, {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('invented or absent IR evidence');
  });

  it('rejects global capability claims that a shard/language coverage segment omits', () => {
    const sourceIr = ir();
    sourceIr.coverage.segments[0]!.capabilities = ['dependency-graph', 'symbol-index'];
    expect(() => materializeRepositoryModuleCatalog(proposal(), sourceIr, {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    })).toThrow('does not account for capability api-surface');
  });

  it('projects a discovery proposal into a deterministic evidence-bound initial wiki draft', () => {
    const sourceProposal = proposal();
    const draftCatalog = materializeRepositoryModuleCatalog(sourceProposal, ir(), {
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    });
    const draft = deriveInitialRepositoryModuleWikiDraft(
      sourceProposal,
      draftCatalog,
      ir(),
      'orders',
    );

    expect(draft).toEqual({
      summary: 'Owns order submission and status.',
      architecture: 'Order lifecycle changes together.',
      publicInterfaces: 'Orders.submit(Order): Receipt',
      dataFlow: 'orders -> contracts (type-reference)',
      operationalNotes: '',
      reuseGuidance: [
        'Business capabilities: Order management',
        'Responsibilities: Read order status; Submit orders',
      ].join('\n'),
      limitations: [
        'Assumption: Runtime ownership follows the static dependency direction.',
        'Unresolved: Who owns payment capture?',
      ],
      risks: ['Static evidence does not prove ordering semantics.'],
      evidenceIds: ['api-orders-submit', 'edge-orders-contracts', 'entity-orders'],
      tags: ['orders'],
    });
    expect(() => deriveInitialRepositoryModuleWikiDraft(
      sourceProposal,
      { ...draftCatalog, sourceProposalId: 'another-proposal' },
      ir(),
      'orders',
    )).toThrow('does not bind to the supplied discovery proposal');
  });

  it('separates immutable raw facts from normalized Agent-maintained wiki content', () => {
    const first = page();
    const reorderedCatalog = catalog();
    reorderedCatalog.modules[0]!.responsibilities.reverse();
    const reorderedWiki = wiki();
    reorderedWiki.tags!.reverse();
    const second = materializeRepositoryModuleKnowledgePage({
      catalog: reorderedCatalog,
      ir: ir(),
      moduleId: 'orders',
      wiki: reorderedWiki,
      producer,
      createdAt: now,
    });

    expect(second).toEqual(first);
    expect(first.id).toBe(`repository-module-knowledge:orders:${first.contentHash.slice(0, 24)}`);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.raw.fileIds).toEqual(['file-orders']);
    expect(first.raw.filePaths).toEqual(['src/Orders.java']);
    expect(first.raw.languageIds).toEqual(['java']);
    expect(first.raw.apiSurfaceIds).toEqual(['api-orders-submit']);
    expect(first.raw.publicApiSignatures).toEqual(['Orders.submit(Order): Receipt']);
    expect(first.trustTier).toBe('discovered');
    expect(first.wiki.evidenceIds).toEqual(['edge-orders-contracts', 'evidence-orders']);
    expect(() => validateRepositoryModuleKnowledgePage(first, catalog(), ir())).not.toThrow();
  });

  it('does not treat an accepted module boundary as reviewed narrative or searchable knowledge', () => {
    const accepted = acceptedState();
    const generated = materializeRepositoryModuleKnowledgePage({
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      moduleId: 'orders',
      wiki: {
        ...wiki(),
        evidenceIds: ['api-orders-submit', 'edge-orders-contracts', 'entity-orders'],
      },
      producer,
      createdAt: now,
    });
    expect(generated).toMatchObject({
      boundaryStatus: 'reviewed',
      narrativeStatus: 'generated',
      verificationStatus: 'unverified',
      trustTier: 'discovered',
    });
    expect(() => materializeIndexedModuleKnowledgeDocument(
      generated,
      accepted.catalog,
      accepted.sourceIr,
      ['repository-orders'],
      {
        id: 'publication-v1',
        payloadHash: 'f'.repeat(64),
        scope: { repositoryId: 'repository-orders', channel: 'refs/heads/main' },
        repositoryScopes: ['repository-orders'],
        generation: 1,
        status: 'active',
        source: {
          repositoryModuleBundleId: 'bundle-v1',
          repositoryModuleBundleHash: 'e'.repeat(64),
          modules: [{
            moduleId: 'orders',
            evidenceBundleId: 'evidence-v1',
            evidenceBundleHash: 'd'.repeat(64),
            wikiProposalId: 'wiki-v1',
            wikiProposalHash: 'c'.repeat(64),
            knowledgeReviewId: 'review-v1',
            knowledgeReviewHash: 'b'.repeat(64),
            knowledgePageId: generated.id,
            knowledgePageHash: generated.contentHash,
          }],
        },
      },
    )).toThrow('Only independently reviewed');
  });

  it('rejects unknown evidence, unsafe module IDs, and tampered raw facts', () => {
    expect(() => materializeRepositoryModuleKnowledgePage({
      catalog: catalog(),
      ir: ir(),
      moduleId: 'orders',
      wiki: { ...wiki(), evidenceIds: ['invented-evidence'] },
      producer,
      createdAt: now,
    })).toThrow('unknown immutable evidence');

    expect(() => repositoryModuleKnowledgeJsonPath('../orders')).toThrow('Unsafe repository module ID');

    const valid = page();
    const tampered = {
      ...valid,
      raw: { ...valid.raw, fileIds: ['file-contracts'] },
    };
    expect(() => validateRepositoryModuleKnowledgePage(tampered, catalog(), ir()))
      .toThrow('does not match its immutable sources');
  });

  it('materializes a deterministic reviewed module bundle and rejects tampering', () => {
    const accepted = acceptedState();
    const knowledgePages = accepted.catalog.modules.map((module) =>
      materializeRepositoryModuleKnowledgePage({
        catalog: accepted.catalog,
        ir: accepted.sourceIr,
        moduleId: module.id,
        wiki: deriveInitialRepositoryModuleWikiDraft(
          accepted.sourceProposal,
          accepted.catalog,
          accepted.sourceIr,
          module.id,
        ),
        producer,
        createdAt: now,
      }),
    );
    const bundle = materializeRepositoryModuleBundle({
      proposal: accepted.sourceProposal,
      review: accepted.review,
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      knowledgePages: [...knowledgePages].reverse(),
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    });

    expect(bundle).toMatchObject({
      id: `repository-module-bundle:${bundle.contentHash.slice(0, 24)}`,
      repositoryId: 'repository-orders',
      source: {
        moduleReviewId: accepted.review.id,
        moduleCatalogId: accepted.catalog.id,
      },
    });
    expect(bundle.knowledgePages.map((page) => page.moduleId)).toEqual(['contracts', 'orders']);
    expect(bundle.apiSurfaces.map((surface) => surface.id)).toEqual([
      'api-contracts-order',
      'api-orders-submit',
    ]);
    expect(() => validateRepositoryModuleBundle(bundle, {
      proposal: accepted.sourceProposal,
      review: accepted.review,
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      knowledgePages,
    })).not.toThrow();
    expect(() => validateRepositoryModuleBundle({
      ...bundle,
      repositoryContentHash: '0'.repeat(64),
    }, {
      proposal: accepted.sourceProposal,
      review: accepted.review,
      catalog: accepted.catalog,
      ir: accepted.sourceIr,
      knowledgePages,
    })).toThrow('immutable source closure');
  });

  it('serializes deterministic JSON and Markdown artifacts at per-module paths', () => {
    const knowledge = page();
    const artifacts = materializeRepositoryModuleKnowledgeArtifacts(knowledge);

    expect(artifacts.map((item) => item.descriptor.artifact.path)).toEqual([
      repositoryModuleKnowledgeJsonPath('orders'),
      repositoryModuleKnowledgeMarkdownPath('orders'),
    ]);
    expect(artifacts.map((item) => item.descriptor.format)).toEqual(['json', 'markdown']);
    expect(artifacts.every((item) => /^[0-9a-f]{64}$/.test(item.descriptor.artifact.contentHash)))
      .toBe(true);
    expect(JSON.parse(artifacts[0]!.content)).toEqual(knowledge);
    expect(artifacts[1]!.content).toContain('## Reuse guidance');
    expect(artifacts[1]!.content).toContain('## Languages');
    expect(artifacts[1]!.content).toContain('`Orders.submit(Order): Receipt`');
    expect(artifacts[1]!.content).toContain('Unified IR: `ir-orders-v1`');
  });

  it('includes the complete review provenance in reviewed JSON and Markdown descriptors', () => {
    const fixture = reviewedKnowledgeFixture();
    const page = fixture.knowledgePages[0]!;
    const artifacts = materializeRepositoryModuleKnowledgeArtifacts(page);
    expect(artifacts[0]!.descriptor.sourceArtifactIds).toEqual(expect.arrayContaining([
      page.source.unifiedRepositoryIrId,
      page.source.moduleCatalogId,
      page.source.evidenceBundleId,
      page.source.wikiProposalId,
      page.source.knowledgeReviewId,
    ]));
    expect(artifacts[1]!.descriptor.sourceArtifactIds).toEqual(
      artifacts[0]!.descriptor.sourceArtifactIds,
    );
  });

  it('requires actionable revise feedback and binds a successor proposal to that signed closure', () => {
    const fixture = reviewedKnowledgeFixture();
    const evidenceBundle = fixture.evidenceBundles[0]!;
    const previousProposal = fixture.wikiProposals[0]!;
    expect(() => materializeRepositoryModuleKnowledgeReview(previousProposal, evidenceBundle, {
      decision: 'revise',
      reviewerId: 'knowledge-owner',
      reviewedAt: now,
    })).toThrow('non-empty actionable comment');

    const reviseReview = materializeRepositoryModuleKnowledgeReview(previousProposal, evidenceBundle, {
      decision: 'revise',
      reviewerId: 'knowledge-owner',
      comment: 'Clarify the public API limitation and avoid implying runtime guarantees.',
      reviewedAt: now,
    });
    const narrative = {
      ...previousProposal.narrative,
      summary: `${previousProposal.narrative.summary} Runtime behavior remains unverified.`,
    };
    const successor = materializeRepositoryModuleWikiProposal({
      evidenceBundle,
      narrative,
      evidenceBindings: claimBindings(narrative),
      generation: {
        modelId: 'summary-model',
        promptTemplateId: 'module-summary',
        promptTemplateVersion: '1.1.0',
      },
      previousProposal,
      reviseReview,
      producer: { kind: 'module-summary-agent', id: 'summary-agent', version: '1.1.0' },
      createdAt: now,
    });
    expect(successor.revision).toEqual({
      previousProposalId: previousProposal.id,
      previousProposalHash: previousProposal.contentHash,
      reviseReviewId: reviseReview.id,
      reviseReviewHash: reviseReview.contentHash,
    });
    expect(() => validateRepositoryModuleSummaryRevisionContext(evidenceBundle, {
      previousProposal,
      reviseReview,
    })).not.toThrow();
    expect(() => validateRepositoryModuleWikiProposal(successor, evidenceBundle, {
      previousProposal,
      reviseReview,
    })).not.toThrow();
    expect(() => validateRepositoryModuleWikiProposal(successor, evidenceBundle, {
      previousProposal,
      reviseReview: { ...reviseReview, comment: 'tampered feedback' },
    })).toThrow('does not match');
  });

  it('builds a stable index sorted by module ID', () => {
    const orders = page('orders');
    const contracts = page('contracts');
    const first = serializeRepositoryModuleKnowledgeIndex([orders, contracts]);
    const second = serializeRepositoryModuleKnowledgeIndex([contracts, orders]);

    expect(first).toBe(second);
    expect(first.indexOf('`contracts`')).toBeLessThan(first.indexOf('`orders`'));
    const artifact = materializeRepositoryModuleKnowledgeIndexArtifact(
      [orders, contracts],
      { kind: 'ingestion-host', id: 'host' },
      now,
    );
    expect(artifact.descriptor.artifact.path).toBe(repositoryModuleKnowledgeIndexPath);
    expect(artifact.descriptor.format).toBe('search-index');
  });

  it('materializes the wiki maintenance schema separately from content and history', () => {
    const schema = serializeRepositoryModuleKnowledgeSchema();
    expect(schema).toContain('The `raw` object');
    expect(schema).toContain('`index.md` is the content-oriented module catalog');
    expect(schema).toContain('`log.md` is append-only');
    const artifact = materializeRepositoryModuleKnowledgeSchemaArtifact(producer, now);
    expect(artifact.descriptor.artifact.path).toBe(repositoryModuleKnowledgeSchemaPath);
    expect(artifact.descriptor.format).toBe('markdown');
    expect(artifact.content).toBe(schema);
  });

  it('keeps generated prose unreviewed until the independent Summary review gate', () => {
    const fixture = reviewedKnowledgeFixture();
    const proposal = fixture.wikiProposals.find((item) => item.moduleId === 'orders')!;
    const review = fixture.knowledgeReviews.find((item) => item.moduleId === 'orders')!;
    const page = fixture.knowledgePages.find((item) => item.moduleId === 'orders')!;

    expect(proposal.producer.kind).toBe('module-summary-agent');
    expect(proposal.evidenceBindings.every((binding) => binding.evidenceIds.length > 0)).toBe(true);
    expect(review.decision).toBe('accept');
    expect(page).toMatchObject({
      boundaryStatus: 'reviewed',
      narrativeStatus: 'reviewed',
      verificationStatus: 'unverified',
      trustTier: 'reviewed',
      producer: { kind: 'knowledge-publisher' },
      source: {
        evidenceBundleId: expect.any(String),
        wikiProposalId: proposal.id,
        knowledgeReviewId: review.id,
      },
    });
    const jsonl = serializeRepositoryModuleKnowledgeJsonl([...fixture.knowledgePages].reverse());
    const lines = jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.moduleId)).toEqual(['contracts', 'orders']);
    const jsonlArtifact = materializeRepositoryModuleKnowledgeJsonlArtifact(
      fixture.knowledgePages,
      { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      now,
    );
    expect(jsonlArtifact.descriptor).toMatchObject({
      format: 'jsonl',
      artifact: {
        path: repositoryModuleKnowledgeJsonlPath,
        mediaType: 'application/x-ndjson',
      },
    });
  });

  it('stages reviewed Wiki projections, validates the module index, then activates and restores by CAS', () => {
    const fixture = reviewedKnowledgeFixture();
    expect(() => stageRepositoryKnowledgePublication({
      scope: { repositoryId: 'repository-orders', channel: 'refs/heads/main' },
      repositoryScopes: ['tenant/orders'],
      generation: 1,
      repositoryModuleBundle: fixture.boundaryBundle,
      knowledgePages: fixture.knowledgePages,
      evidenceBundles: fixture.evidenceBundles,
      wikiProposals: fixture.wikiProposals,
      knowledgeReviews: fixture.knowledgeReviews,
      artifacts: fixture.artifacts,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      stagedAt: now,
    })).toThrow('must include its repository ID');
    const staged = stageRepositoryKnowledgePublication({
      scope: { repositoryId: 'repository-orders', channel: 'refs/heads/main' },
      repositoryScopes: ['repository-orders', 'tenant/orders'],
      generation: 1,
      repositoryModuleBundle: fixture.boundaryBundle,
      knowledgePages: fixture.knowledgePages,
      evidenceBundles: fixture.evidenceBundles,
      wikiProposals: fixture.wikiProposals,
      knowledgeReviews: fixture.knowledgeReviews,
      artifacts: fixture.artifacts,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      stagedAt: now,
    });
    const stagedDocument = materializeIndexedModuleKnowledgeDocument(
      fixture.knowledgePages.find((item) => item.moduleId === 'orders')!,
      fixture.accepted.catalog,
      fixture.accepted.sourceIr,
      staged.repositoryScopes,
      staged,
    );
    expect(stagedDocument).toMatchObject({
      publicationId: staged.id,
      publicationGeneration: 1,
      channel: 'refs/heads/main',
      boundaryStatus: 'reviewed',
      narrativeStatus: 'reviewed',
    });
    expect(() => materializeIndexedModuleKnowledgeDocument(
      fixture.knowledgePages.find((item) => item.moduleId === 'orders')!,
      fixture.accepted.catalog,
      fixture.accepted.sourceIr,
      ['repository-orders'],
      staged,
    )).toThrow('exactly match');

    const receipt = materializeRepositoryModuleIndexReceipt({
      publication: staged,
      status: 'validated',
      storeId: 'seekdb-module-knowledge',
      documentCount: 2,
      moduleIds: ['orders', 'contracts'],
      indexArtifactHash: '9'.repeat(64),
      createdAt: now,
    });
    const first = activateRepositoryKnowledgePublication({
      publication: staged,
      indexReceipt: receipt,
      activatedAt: now,
    });
    expect(first).toMatchObject({
      publication: { status: 'active' },
      indexReceipt: { status: 'active' },
      head: { publicationId: staged.id, generation: 1 },
    });

    const stagedSecond = stageRepositoryKnowledgePublication({
      scope: staged.scope,
      repositoryScopes: staged.repositoryScopes,
      generation: 2,
      repositoryModuleBundle: fixture.boundaryBundle,
      knowledgePages: fixture.knowledgePages,
      evidenceBundles: fixture.evidenceBundles,
      wikiProposals: fixture.wikiProposals,
      knowledgeReviews: fixture.knowledgeReviews,
      artifacts: fixture.artifacts,
      previousPublicationId: first.publication.id,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      stagedAt: now,
    });
    const secondReceipt = materializeRepositoryModuleIndexReceipt({
      publication: stagedSecond,
      status: 'validated',
      storeId: 'seekdb-module-knowledge',
      documentCount: 2,
      moduleIds: ['contracts', 'orders'],
      indexArtifactHash: '8'.repeat(64),
      createdAt: now,
    });
    expect(() => activateRepositoryKnowledgePublication({
      publication: stagedSecond,
      indexReceipt: secondReceipt,
      currentHead: first.head,
      expectedHeadHash: '0'.repeat(64),
      activatedAt: now,
    })).toThrow('CAS head is stale');

    const second = activateRepositoryKnowledgePublication({
      publication: stagedSecond,
      indexReceipt: secondReceipt,
      currentHead: first.head,
      expectedHeadHash: first.head.contentHash,
      activatedAt: now,
    });
    const withdrawn = withdrawRepositoryKnowledgePublication({
      publication: second.publication,
      indexReceipt: second.indexReceipt,
      currentHead: second.head,
      expectedHeadHash: second.head.contentHash,
      withdrawnAt: now,
      restorePublication: first.publication,
    });
    expect(withdrawn.publication.status).toBe('withdrawn');
    expect(withdrawn.indexReceipt.status).toBe('withdrawn');
    expect(withdrawn.head).toMatchObject({
      publicationId: first.publication.id,
      generation: 1,
    });
  });

  it('rejects forged lifecycle states and non-canonical publication heads at runtime boundaries', () => {
    const fixture = reviewedKnowledgeFixture();
    const staged = stageRepositoryKnowledgePublication({
      scope: { repositoryId: 'repository-orders', channel: 'refs/heads/main' },
      repositoryScopes: ['repository-orders'],
      generation: 1,
      repositoryModuleBundle: fixture.boundaryBundle,
      knowledgePages: fixture.knowledgePages,
      evidenceBundles: fixture.evidenceBundles,
      wikiProposals: fixture.wikiProposals,
      knowledgeReviews: fixture.knowledgeReviews,
      artifacts: fixture.artifacts,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      stagedAt: now,
    });
    const receipt = materializeRepositoryModuleIndexReceipt({
      publication: staged,
      status: 'validated',
      storeId: 'seekdb-module-knowledge',
      documentCount: 2,
      moduleIds: ['contracts', 'orders'],
      indexArtifactHash: '9'.repeat(64),
      createdAt: now,
    });
    const active = activateRepositoryKnowledgePublication({
      publication: staged,
      indexReceipt: receipt,
      activatedAt: now,
    });
    const { contentHash: _publicationHash, ...publicationBody } = staged;
    const forgedPublicationBody = { ...publicationBody, status: 'corrupted' };
    const forgedPublication = {
      ...forgedPublicationBody,
      contentHash: sha256Hex(canonicalJson(forgedPublicationBody)),
    } as unknown as typeof staged;
    expect(() => validateRepositoryKnowledgePublication(forgedPublication))
      .toThrow('unsupported status');

    const { contentHash: _receiptHash, ...receiptBody } = receipt;
    const forgedReceiptBody = { ...receiptBody, status: 'corrupted' };
    const forgedReceipt = {
      ...forgedReceiptBody,
      contentHash: sha256Hex(canonicalJson(forgedReceiptBody)),
    } as unknown as typeof receipt;
    expect(() => validateRepositoryModuleIndexReceipt(forgedReceipt))
      .toThrow('unsupported status');

    const { contentHash: _headHash, ...headBody } = active.head;
    const forgedHeadBody = {
      ...headBody,
      scope: { ...headBody.scope, channel: ` ${headBody.scope.channel}` },
    };
    const forgedHead = {
      ...forgedHeadBody,
      contentHash: sha256Hex(canonicalJson(forgedHeadBody)),
    };
    expect(() => validateRepositoryKnowledgePublicationHead(forgedHead))
      .toThrow('scope must be canonical');
  });

  it('finalizes a per-repository batch with partial success without rolling back another repository', () => {
    const fixture = reviewedKnowledgeFixture();
    const staged = stageRepositoryKnowledgePublication({
      scope: { repositoryId: 'repository-orders', channel: 'refs/heads/main' },
      repositoryScopes: ['repository-orders', 'tenant/orders'],
      generation: 1,
      repositoryModuleBundle: fixture.boundaryBundle,
      knowledgePages: fixture.knowledgePages,
      evidenceBundles: fixture.evidenceBundles,
      wikiProposals: fixture.wikiProposals,
      knowledgeReviews: fixture.knowledgeReviews,
      artifacts: fixture.artifacts,
      producer: { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      stagedAt: now,
    });
    const receipt = materializeRepositoryModuleIndexReceipt({
      publication: staged,
      status: 'validated',
      storeId: 'seekdb-module-knowledge',
      documentCount: 2,
      moduleIds: ['contracts', 'orders'],
      indexArtifactHash: '9'.repeat(64),
      createdAt: now,
    });
    const active = activateRepositoryKnowledgePublication({
      publication: staged,
      indexReceipt: receipt,
      activatedAt: now,
    }).publication;
    let batch = createRepositoryImportBatch({
      id: 'batch-1',
      items: [{
        id: 'orders-item',
        scope: staged.scope,
        ingestionManifestId: 'ingestion-orders',
        ingestionManifestHash: '1'.repeat(64),
        status: 'pending',
      }, {
        id: 'billing-item',
        scope: { repositoryId: 'repository-billing', channel: 'refs/heads/main' },
        ingestionManifestId: 'ingestion-billing',
        ingestionManifestHash: '2'.repeat(64),
        status: 'pending',
      }],
      producer: { kind: 'ingestion-host', id: 'host' },
      createdAt: now,
    });
    batch = updateRepositoryImportBatchItem(batch, 'orders-item', {
      status: 'staged',
      publication: staged,
      updatedAt: now,
    });
    batch = updateRepositoryImportBatchItem(batch, 'orders-item', {
      status: 'active',
      publication: active,
      updatedAt: now,
    });
    batch = updateRepositoryImportBatchItem(batch, 'billing-item', {
      status: 'failed',
      failure: { code: 'INDEX_FAILED', message: 'Index staging failed.', retryable: true },
      updatedAt: now,
    });
    const complete = finalizeRepositoryImportBatch(batch, now);

    expect(complete.status).toBe('completed-with-errors');
    expect(complete.items.find((item) => item.id === 'orders-item')?.status).toBe('active');
    expect(complete.items.find((item) => item.id === 'billing-item')?.status).toBe('failed');
  });

  it('exports a versioned Draft 2020-12 JSON Schema artifact independently from schema guidance', () => {
    const schema = repositoryModuleSummaryJsonSchema() as Record<string, unknown>;
    const artifact = materializeRepositoryModuleSummaryJsonSchemaArtifact(
      { kind: 'knowledge-publisher', id: 'knowledge-publisher' },
      now,
    );

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toContain('/repository-module-summary/1.0/');
    expect(artifact.descriptor).toMatchObject({
      format: 'json-schema',
      artifact: {
        path: '.forexplore/modules/summary.schema.json',
        mediaType: 'application/schema+json',
        schemaVersion: '1.0',
      },
    });
    expect(JSON.parse(artifact.content)).toEqual(schema);
  });

  it('appends timeline entries byte-for-byte and replays an event idempotently', () => {
    const event: RepositoryIngestionEvent = {
      id: 'event-knowledge-orders',
      ingestionId: 'ingestion-orders',
      sequence: 7,
      type: 'knowledge-artifact-produced',
      occurredAt: now,
      actor: { kind: 'agent', id: 'agenticodex-module-wiki' },
      idempotencyKey: 'knowledge:orders:v1',
      fromStatus: 'awaiting-module-review',
      toStatus: 'ready',
      artifactRefs: materializeRepositoryModuleKnowledgeArtifacts(page())
        .map((item) => item.descriptor.artifact),
      message: 'Published reviewed module knowledge.',
    };
    const existing = '# Module Knowledge Timeline\n\n';
    const appended = appendRepositoryModuleKnowledgeLog(existing, event);

    expect(appended.startsWith(existing)).toBe(true);
    expect(appendRepositoryModuleKnowledgeLog(appended, event)).toBe(appended);
    expect(() => appendRepositoryModuleKnowledgeLog(appended, {
      ...event,
      id: 'another-event',
    })).toThrow('idempotency key was reused');

    const artifact = materializeRepositoryModuleKnowledgeLogArtifact(
      appended,
      ['catalog-orders-v1'],
      { kind: 'ingestion-host', id: 'host' },
      now,
    );
    expect(artifact.descriptor.artifact.path).toBe(repositoryModuleKnowledgeLogPath);
    expect(artifact.descriptor.format).toBe('log');
  });
});
