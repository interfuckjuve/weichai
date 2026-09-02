import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ModuleDiscoveryProposal,
  RepositoryStaticAnalysis,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  canonicalJson,
  materializeRepositoryModuleWikiProposal,
  sha256Hex,
} from '@forexplore/workflow-core';
import {
  analyzeRepository,
  bridgeRepositoryStaticAnalysis,
  RepositoryLanguageRegistry,
  writeRepositoryAnalysisArtifact,
} from '@forexplore/code-indexer';
import {
  calculateRepositoryIngestionId,
  defaultRepositoryKnowledgeScope,
  initializeRepositoryAfterStaticAnalysis,
  repositoryIngestionInitializationPreview,
} from './repository-ingestion-coordinator';
import { reviewRepositoryModulePublication } from './repository-module-publication';
import { generateRepositoryModuleSummaries } from './repository-module-summary';
import { reviewAndPublishRepositoryModuleKnowledge } from './repository-module-knowledge-publication';

const roots: string[] = [];
const now = '2026-08-31T10:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-ingestion-coordinator-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'orders.ts'), [
    'export class OrderService {}',
    'export function submitOrder() {}',
  ].join('\n'), 'utf8');
  // A repository script is inert input. Initialization must never execute it.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { postinstall: 'node -e "require(\\\'fs\\\').writeFileSync(\\\'EXECUTED\\\', \\\'1\\\')"' },
  }), 'utf8');
  return root;
}

async function unknownLanguageRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-ingestion-unknown-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'Orders.kt'), 'class Orders\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Orders\n', 'utf8');
  return root;
}

async function customLanguageRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-ingestion-custom-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'Orders.acme'), 'public capability Orders\n', 'utf8');
  return root;
}

async function analysis(root: string): Promise<RepositoryStaticAnalysis> {
  return analyzeRepository({ root, createdAt: now, allowDirtyWorktreeForPlanning: true });
}

function proposal(ir: UnifiedRepositoryIR): ModuleDiscoveryProposal {
  const sourceFiles = ir.files.filter((file) => file.role === 'source');
  const sourceFileIds = sourceFiles.map((file) => file.id);
  const sourceFileId = sourceFileIds[0]!;
  const entityIds = ir.entities
    .filter((entity) => entity.fileId !== undefined && sourceFileIds.includes(entity.fileId))
    .map((entity) => entity.id);
  const withoutHash: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'module-proposal-orders',
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    constraints: [],
    status: 'awaiting-review',
    modules: [{
      id: 'orders',
      name: 'Orders',
      kind: 'business-capability',
      description: 'Owns order submission behavior.',
      responsibilities: ['Submit orders'],
      businessCapabilities: ['Order management'],
      fileIds: sourceFileIds,
      entityIds,
      entryPointEntityIds: [],
      publicApiEntityIds: [],
      boundaryRationale: 'All order source evidence is kept in one functional boundary.',
      evidenceRefs: [{ id: sourceFileId, kind: 'source' }],
      tags: ['orders'],
    }],
    assignments: ir.files.map((file) => ({
      fileId: file.id,
      moduleIds: file.role === 'source' ? ['orders'] : [],
      kind: file.role === 'source' ? 'owned' as const : 'excluded' as const,
      rationale: file.role === 'source'
        ? 'The file implements the order capability.'
        : 'Non-source evidence remains outside the functional module.',
      evidenceRefs: [{ id: file.id, kind: 'source' as const }],
    })),
    dependencies: [],
    assumptions: [],
    risks: ['Business behavior is not independently verified.'],
    unresolvedQuestions: [],
    producer: {
      kind: 'module-discovery-agent',
      id: 'test-module-discovery-agent',
      version: '1.0.0',
    },
    createdAt: now,
  };
  return { ...withoutHash, contentHash: sha256Hex(canonicalJson(withoutHash)) };
}

describe('repository ingestion coordinator', () => {
  it('carries a third-party LanguageId through analysis, review, and the downstream Bundle', async () => {
    const root = await customLanguageRepository();
    const registry = new RepositoryLanguageRegistry([{
      id: 'acme.repository-adapter',
      version: '2.1.0',
      languageId: 'acme-lang',
      capabilities: ['file-inventory', 'symbol-index', 'api-surface'],
      configurationHash: 'acme-config-v1',
      fileExtensions: ['.acme'],
      analysisLevel: 'deep',
      analyze(file) {
        return {
          file,
          imports: [],
          references: [],
          symbols: [{
            id: 'acme-symbol-orders',
            name: 'Orders',
            qualifiedName: 'sample.Orders',
            kind: 'class',
            language: 'acme-lang',
            path: file.path,
            range: { path: file.path, startLine: 1, startColumn: 1 },
            signature: 'public capability Orders',
            visibility: 'public',
            exported: true,
          }],
        };
      },
    }]);
    const snapshot = await analyzeRepository({
      root,
      createdAt: now,
      allowDirtyWorktreeForPlanning: true,
      languageRegistry: registry,
    });
    const bridged = bridgeRepositoryStaticAnalysis(snapshot);
    const initialized = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules: async () => proposal(bridged.unifiedIr), now: () => now },
    );
    const published = await reviewRepositoryModulePublication({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
      decision: 'accept',
      reviewerId: 'reviewer-acme',
    }, { now: () => '2026-08-31T10:05:00.000Z' });

    expect(published.bundle?.files.map((file) => file.languageId)).toContain('acme-lang');
    expect(published.bundle?.entities.map((entity) => entity.languageId)).toContain('acme-lang');
    expect(published.bundle?.apiSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityId: 'acme-symbol-orders',
        languageId: 'acme-lang',
        exposure: 'public',
      }),
    ]));
    expect(snapshot.analysisAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'acme.repository-adapter',
        languageId: 'acme-lang',
        version: '2.1.0',
      }),
    ]));
  });

  it('stops at partial and never calls the Agent for inventory-only source evidence', async () => {
    const root = await unknownLanguageRepository();
    const snapshot = await analysis(root);
    const discoverModules = vi.fn();
    const first = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    );
    const replay = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => '2026-08-31T11:00:00.000Z' },
    );

    expect(first.status).toBe('partial');
    expect(first.readiness?.ready).toBe(false);
    expect(first.readiness?.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNCLASSIFIED_REPOSITORY_FILE' }),
      expect.objectContaining({ code: 'NO_ANALYSABLE_SOURCE' }),
    ]));
    expect(first.manifest.artifacts.moduleDiscoveryProposal).toBeUndefined();
    expect(replay.status).toBe('partial');
    expect(replay.reused).toBe(true);
    expect(discoverModules).not.toHaveBeenCalled();
  });

  it('publishes only an explicitly accepted review as an active, content-addressed Bundle', async () => {
    const root = await repository();
    const snapshot = await analysis(root);
    const bridged = bridgeRepositoryStaticAnalysis(snapshot);
    const discoverModules = vi.fn(async () => proposal(bridged.unifiedIr));
    const initialized = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    );

    const published = await reviewRepositoryModulePublication({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
      decision: 'accept',
      reviewerId: 'reviewer-alice',
      comment: 'The repository boundary matches the owned source evidence.',
    }, { now: () => '2026-08-31T10:05:00.000Z' });

    expect(published.outcome).toBe('summarizing-modules');
    expect(published.manifest.status).toBe('summarizing-modules');
    expect(published.catalog?.status).toBe('active');
    expect(published.knowledgePages?.every((page) =>
      page.boundaryStatus === 'reviewed' &&
      page.narrativeStatus === 'generated' &&
      page.trustTier === 'discovered',
    )).toBe(true);
    expect(published.evidenceBundles).toHaveLength(published.catalog?.modules.length ?? 0);
    expect(published.bundle).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^repository-module-bundle:/),
      repositoryId: bridged.unifiedIr.repositoryId,
      source: expect.objectContaining({
        moduleReviewId: published.review.id,
        moduleCatalogId: published.catalog?.id,
      }),
    }));
    expect(published.manifest.artifacts).toEqual(expect.objectContaining({
      moduleReview: expect.objectContaining({ kind: 'module-review' }),
      activeModuleCatalog: expect.objectContaining({ kind: 'module-catalog' }),
      moduleBundle: expect.objectContaining({ kind: 'repository-module-bundle' }),
      moduleEvidenceBundles: expect.arrayContaining([
        expect.objectContaining({ kind: 'repository-module-evidence-bundle' }),
      ]),
    }));
    await expect(stat(path.join(
      root,
      '.forexplore',
      'ingestion',
      initialized.ingestionId,
      'repository-module-bundle.json',
    ))).resolves.toBeDefined();

    const replay = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => '2026-08-31T11:00:00.000Z' },
    );
    expect(replay.status).toBe('summarizing-modules');
    expect(replay.reused).toBe(true);
    expect(discoverModules).toHaveBeenCalledTimes(1);
  });

  it('runs the independent Summary Agent and stops at the second human gate', async () => {
    const root = await repository();
    const snapshot = await analysis(root);
    const bridged = bridgeRepositoryStaticAnalysis(snapshot);
    const initialized = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules: async () => proposal(bridged.unifiedIr), now: () => now },
    );
    await reviewRepositoryModulePublication({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
      decision: 'accept',
      reviewerId: 'reviewer-boundary',
    }, { now: () => '2026-08-31T10:05:00.000Z' });
    const summarizeModule = vi.fn(async ({ evidenceBundle }: {
      evidenceBundle: import('@forexplore/contracts').RepositoryModuleEvidenceBundle;
    }) => {
      const evidenceId = evidenceBundle.scope.evidenceIds[0]!;
      const summary = 'Summarizes the accepted order module from bounded source evidence.';
      return materializeRepositoryModuleWikiProposal({
        evidenceBundle,
        narrative: {
          summary,
          architecture: '',
          publicInterfaces: '',
          dataFlow: '',
          operationalNotes: '',
          reuseGuidance: '',
          limitations: [],
          risks: [],
          evidenceIds: [evidenceId],
        },
        evidenceBindings: [{ section: 'summary', claim: summary, evidenceIds: [evidenceId] }],
        generation: {
          modelId: 'summary-test',
          promptTemplateId: 'summary-test-prompt',
          promptTemplateVersion: '1',
        },
        producer: { kind: 'module-summary-agent', id: 'summary-test', version: '1' },
        createdAt: '2026-08-31T10:06:00.000Z',
      });
    });

    const generated = await generateRepositoryModuleSummaries({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
    }, {
      summarizeModule,
      now: () => '2026-08-31T10:07:00.000Z',
    });

    expect(generated.manifest.status).toBe('awaiting-summary-review');
    expect(generated.wikiProposals).toHaveLength(1);
    expect(generated.wikiProposals[0]).toMatchObject({
      moduleId: 'orders',
      producer: { kind: 'module-summary-agent' },
    });
    expect(generated.manifest.artifacts.moduleKnowledgeReviews).toEqual([]);
    expect(generated.manifest.artifacts.knowledgePublications).toEqual([]);
    expect(generated.manifest.artifacts.moduleIndexReceipts).toEqual([]);
    expect(summarizeModule).toHaveBeenCalledTimes(1);

    const replay = await generateRepositoryModuleSummaries({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
    }, {
      summarizeModule: vi.fn(async () => { throw new Error('must not run'); }),
    });
    expect(replay.reused).toBe(true);
    expect(replay.wikiProposals).toEqual(generated.wikiProposals);

    const revision = await reviewAndPublishRepositoryModuleKnowledge({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
      scope: { repositoryId: generated.manifest.repositoryId, channel: 'refs/heads/main' },
      repositoryScopes: [generated.manifest.repositoryId],
      reviews: [{
        moduleId: 'orders',
        decision: 'revise',
        reviewerId: 'knowledge-owner',
        comment: 'State explicitly that runtime behavior remains unverified.',
      }],
    }, {
      publicationStore: {} as never,
      indexPublisher: {} as never,
      now: () => '2026-08-31T10:08:00.000Z',
    });
    expect(revision.outcome).toBe('revision-required');
    expect(revision.manifest.status).toBe('summarizing-modules');

    const successorSummary = vi.fn(async (request: import('./module-summary-client').RepositoryModuleSummaryRequest) => {
      expect(request.previousProposal?.id).toBe(generated.wikiProposals[0]!.id);
      expect(request.reviseReview).toMatchObject({
        decision: 'revise',
        comment: 'State explicitly that runtime behavior remains unverified.',
      });
      const evidenceId = request.evidenceBundle.scope.evidenceIds[0]!;
      const summary = 'Summarizes the accepted module while keeping runtime behavior explicitly unverified.';
      return materializeRepositoryModuleWikiProposal({
        evidenceBundle: request.evidenceBundle,
        narrative: {
          summary,
          architecture: '',
          publicInterfaces: '',
          dataFlow: '',
          operationalNotes: '',
          reuseGuidance: '',
          limitations: [],
          risks: [],
          evidenceIds: [evidenceId],
        },
        evidenceBindings: [{ section: 'summary', claim: summary, evidenceIds: [evidenceId] }],
        generation: {
          modelId: 'summary-test',
          promptTemplateId: 'summary-test-prompt',
          promptTemplateVersion: '1.1.0',
        },
        previousProposal: request.previousProposal,
        reviseReview: request.reviseReview,
        producer: { kind: 'module-summary-agent', id: 'summary-test', version: '1.1.0' },
        createdAt: '2026-08-31T10:09:00.000Z',
      });
    });
    const regenerated = await generateRepositoryModuleSummaries({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
    }, {
      summarizeModule: successorSummary,
      now: () => '2026-08-31T10:10:00.000Z',
    });
    expect(successorSummary).toHaveBeenCalledTimes(1);
    expect(regenerated.manifest.status).toBe('awaiting-summary-review');
    expect(regenerated.wikiProposals[0]!.revision).toMatchObject({
      previousProposalId: generated.wikiProposals[0]!.id,
      reviseReviewId: revision.reviews[0]!.id,
    });
  });

  it.each([
    ['revise', 'revision-required', true],
    ['reject', 'rejected', false],
  ] as const)('records %s without publishing an active catalog or Bundle', async (
    decision,
    expectedOutcome,
    replacementProposalRequired,
  ) => {
    const root = await repository();
    const snapshot = await analysis(root);
    const bridged = bridgeRepositoryStaticAnalysis(snapshot);
    const initialized = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules: async () => proposal(bridged.unifiedIr), now: () => now },
    );
    const reviewed = await reviewRepositoryModulePublication({
      repositoryRoot: root,
      ingestionId: initialized.ingestionId,
      decision,
      reviewerId: 'reviewer-bob',
    }, { now: () => '2026-08-31T10:05:00.000Z' });

    expect(reviewed.outcome).toBe(expectedOutcome);
    expect(reviewed.review.replacementProposalRequired).toBe(replacementProposalRequired);
    expect(reviewed.manifest.status).toBe('superseded');
    expect(reviewed.catalog).toBeUndefined();
    expect(reviewed.bundle).toBeUndefined();
    expect(reviewed.manifest.artifacts.activeModuleCatalog).toBeUndefined();
    expect(reviewed.manifest.artifacts.moduleBundle).toBeUndefined();
  });

  it('dynamically initializes once, persists immutable evidence last-committed by a review-gated manifest', async () => {
    const root = await repository();
    const snapshot = await analysis(root);
    await writeRepositoryAnalysisArtifact(root, snapshot);
    const bridged = bridgeRepositoryStaticAnalysis(snapshot);
    const discoverModules = vi.fn(async () => proposal(bridged.unifiedIr));

    const first = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    );
    const second = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => '2026-08-31T11:00:00.000Z' },
    );

    expect(first.status).toBe('awaiting-module-review');
    expect(first.manifest.status).toBe('awaiting-module-review');
    expect(first.catalog?.status).toBe('draft');
    expect(first.catalog?.reviewId).toBeUndefined();
    expect(first.catalog?.reviewHash).toBeUndefined();
    expect(first.knowledgePages?.[0]?.trustTier).toBe('discovered');
    expect(second.reused).toBe(true);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.searchProjectionCount).toBe(first.searchProjectionCount);
    expect(discoverModules).toHaveBeenCalledTimes(1);

    const runRoot = path.join(root, '.forexplore', 'ingestion', first.ingestionId);
    for (const relative of [
      'profile.json',
      'unified-ir.json',
      'module-proposal.json',
      'module-catalog.json',
      'manifest.json',
    ]) {
      await expect(stat(path.join(runRoot, relative))).resolves.toBeDefined();
    }
    for (const relative of [
      'draft-modules/orders/summary.json',
      'draft-modules/orders/summary.md',
      'draft-modules/index.md',
      'draft-modules/schema.md',
      'knowledge-history/log.md',
    ]) {
      await expect(stat(path.join(runRoot, relative))).resolves.toBeDefined();
    }
    await expect(stat(path.join(root, '.forexplore', 'modules', 'log.md'))).resolves.toBeDefined();
    expect(first.searchProjectionCount).toBe(0);
    expect(first.manifest.artifacts.knowledge.some((knowledge) =>
      knowledge.artifact.mediaType === 'application/x-ndjson' ||
      knowledge.artifact.path?.endsWith('.jsonl'),
    )).toBe(false);
    expect(first.manifest.artifacts.knowledge).toEqual(expect.arrayContaining([
      expect.objectContaining({
        format: 'markdown',
        artifact: expect.objectContaining({
          path: expect.stringContaining(`/draft-modules/schema.md`),
        }),
      }),
    ]));
    await expect(stat(path.join(root, 'EXECUTED'))).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(
      path.join(runRoot, 'draft-modules', 'orders', 'summary.md'),
      '# tampered\n',
      'utf8',
    );
    await expect(initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    )).rejects.toThrow('artifact hash mismatch');
    expect(discoverModules).toHaveBeenCalledTimes(1);
  });

  it('keeps every historical manifest verifiable after a later repository revision updates current views', async () => {
    const root = await repository();
    const firstSnapshot = await analysis(root);
    const firstIr = bridgeRepositoryStaticAnalysis(firstSnapshot).unifiedIr;
    const irBySnapshot = new Map([[firstSnapshot.snapshotId, firstIr]]);
    const discoverModules = vi.fn(async ({ snapshotId }: { snapshotId: string }) => {
      const ir = irBySnapshot.get(snapshotId);
      if (!ir) throw new Error(`Unexpected snapshot: ${snapshotId}`);
      return proposal(ir);
    });
    const first = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: firstSnapshot },
      { discoverModules, now: () => now },
    );

    await writeFile(path.join(root, 'src', 'orders.ts'), [
      'export class OrderService {}',
      'export function submitOrder() {}',
      'export function cancelOrder() {}',
    ].join('\n'), 'utf8');
    const secondSnapshot = await analyzeRepository({
      root,
      createdAt: '2026-09-01T11:00:00.000Z',
      allowDirtyWorktreeForPlanning: true,
    });
    irBySnapshot.set(secondSnapshot.snapshotId, bridgeRepositoryStaticAnalysis(secondSnapshot).unifiedIr);
    const second = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: secondSnapshot },
      { discoverModules, now: () => '2026-09-01T11:00:00.000Z' },
    );

    expect(second.ingestionId).not.toBe(first.ingestionId);
    for (const result of [first, second]) {
      expect(result.manifest.artifacts.knowledge.every((knowledge) =>
        knowledge.artifact.path?.startsWith(`.forexplore/ingestion/${result.ingestionId}/`),
      )).toBe(true);
    }
    const replayFirst = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: firstSnapshot },
      { discoverModules, now: () => '2026-09-01T12:00:00.000Z' },
    );
    const replaySecond = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: secondSnapshot },
      { discoverModules, now: () => '2026-09-01T12:00:00.000Z' },
    );
    expect(replayFirst.reused).toBe(true);
    expect(replaySecond.reused).toBe(true);
    expect(discoverModules).toHaveBeenCalledTimes(2);
  });

  it('preserves the static snapshot and commits explicit failure evidence without a legacy fallback', async () => {
    const root = await repository();
    const snapshot = await analysis(root);
    const staticArtifactPath = await writeRepositoryAnalysisArtifact(root, snapshot);
    const discoverModules = vi.fn(async () => {
      throw new Error('module discovery service unavailable');
    });

    const first = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    );
    const replay = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      { discoverModules, now: () => now },
    );

    expect(first.status).toBe('failed');
    expect(first.failureMessage).toContain('service unavailable');
    expect(first.manifest.failure).toEqual(expect.objectContaining({
      code: 'MODULE_DISCOVERY_INITIALIZATION_FAILED',
      failedStage: 'discovering-modules',
    }));
    expect(replay.reused).toBe(true);
    expect(discoverModules).toHaveBeenCalledTimes(1);
    await expect(stat(staticArtifactPath)).resolves.toBeDefined();
    await expect(stat(path.join(
      root,
      '.forexplore',
      'ingestion',
      first.ingestionId,
      'manifest.json',
    ))).resolves.toBeDefined();
    await expect(stat(path.join(
      root,
      '.forexplore',
      'ingestion',
      first.ingestionId,
      'module-catalog.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a stable content/version ID and exposes review and publication boundaries in previews', async () => {
    const root = await repository();
    const snapshot = await analysis(root);
    expect(calculateRepositoryIngestionId(snapshot)).toBe(calculateRepositoryIngestionId({
      ...snapshot,
      createdAt: '2099-01-01T00:00:00.000Z',
    }));
    expect(calculateRepositoryIngestionId(snapshot, [{
      id: 'keep-api',
      description: 'Keep public APIs together.',
      required: true,
    }])).not.toBe(calculateRepositoryIngestionId(snapshot));
    expect(calculateRepositoryIngestionId(snapshot, [], ['tenant/repository-a']))
      .not.toBe(calculateRepositoryIngestionId(snapshot, [], ['tenant/repository-b']));
    expect(defaultRepositoryKnowledgeScope(
      bridgeRepositoryStaticAnalysis(snapshot).profile.repositoryId,
    )).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    const result = await initializeRepositoryAfterStaticAnalysis(
      { repositoryRoot: root, analysis: snapshot },
      {
        discoverModules: async () => proposal(bridgeRepositoryStaticAnalysis(snapshot).unifiedIr),
        now: () => now,
      },
    );
    expect(repositoryIngestionInitializationPreview(result)).toEqual(expect.objectContaining({
      status: 'awaiting-module-review',
      humanModuleReviewRequired: true,
      moduleCatalogApproved: false,
      searchDatabaseUpserted: false,
      searchProjectionDocumentCount: 0,
    }));
  });
});
