import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  repositoryIngestionSchemaVersion,
  type ModuleDiscoveryProposal,
  type RepositoryIngestionArtifactRef,
  type RepositoryIngestionManifest,
  type RepositoryModuleKnowledgeReviewDecision,
  type RepositoryModuleWikiDraft,
  type RepositoryModuleWikiEvidenceBinding,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  applyRepositoryModuleReview,
  canonicalJson,
  createRepositoryIngestionManifest,
  deriveInitialRepositoryModuleWikiDraft,
  materializeRepositoryModuleBundle,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleEvidenceBundle,
  materializeRepositoryModuleIndexReceipt,
  materializeRepositoryModuleKnowledgeArtifacts,
  materializeRepositoryModuleKnowledgePage,
  materializeRepositoryModuleReview,
  materializeRepositoryModuleWikiProposal,
  recordRepositoryIngestionEvent,
  selectCurrentRepositoryModuleSummaryArtifactRefs,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
} from '@forexplore/workflow-core';
import type {
  ModuleKnowledgeIndexHead,
  ModuleKnowledgeIndexPublisher,
  ModuleKnowledgePublicationKey,
} from './module-knowledge-index-client';
import type { RepositoryModuleSummaryRequest } from './module-summary-client';
import {
  reviewAndPublishRepositoryModuleKnowledge,
  type RepositoryModuleKnowledgeReviewSubmission,
} from './repository-module-knowledge-publication';
import { withdrawRepositoryModuleKnowledgePublication } from './repository-module-knowledge-withdrawal';
import { generateRepositoryModuleSummaries } from './repository-module-summary';
import { RepositoryKnowledgePublicationStore } from './repository-knowledge-publication-store';
import type {
  PersistRepositoryIngestionArtifactsRequest,
  RepositoryIngestionStoredArtifact,
} from './repository-ingestion-store';

const roots: string[] = [];
const repositoryId = 'repository-orders';
const scope = { repositoryId, channel: 'branch:main' };
const t0 = '2026-09-01T00:00:00.000Z';
const reviewTime = '2026-09-01T00:01:00.000Z';
const producer = { kind: 'module-discovery-agent' as const, id: 'discovery-agent', version: '1.0.0' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repository module knowledge review and publication', () => {
  it.each([
    ['revise', 'revision-required', 'summarizing-modules'],
    ['reject', 'rejected', 'superseded'],
  ] as const)('keeps the second gate closed for a %s decision', async (decision, outcome, status) => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const result = await run(fixture, remote, submissions(decision));

    expect(result.outcome).toBe(outcome);
    expect(result.manifest.status).toBe(status);
    expect(remote.stage).not.toHaveBeenCalled();
    expect((await fixture.store.read(fixture.root, scope)).head).toBeUndefined();
    expect(result.manifest.artifacts.knowledgePublications).toHaveLength(0);
    const replay = await run(fixture, remote, submissions(decision));
    expect(replay.outcome).toBe(outcome);
    expect(replay.reviews).toHaveLength(2);
    expect(remote.stage).not.toHaveBeenCalled();
  });

  it('publishes only a complete accepted closure with machine schema and one scoped document per module', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const result = await run(fixture, remote, submissions('accept'));

    expect(result.outcome).toBe('ready');
    expect(result.manifest.status).toBe('ready');
    expect(result.publication).toMatchObject({
      status: 'active',
      repositoryScopes: [repositoryId, 'tenant:orders'],
    });
    expect(result.manifest.artifacts.knowledgePublications).toHaveLength(2);
    expect(result.manifest.artifacts.moduleIndexReceipts).toHaveLength(2);
    expect(result.manifest.artifacts.publicationHeads).toHaveLength(1);
    expect(new Set(result.manifest.artifacts.knowledge.map((item) => item.format))).toEqual(
      expect.objectContaining(new Set(['json', 'markdown', 'json-schema', 'jsonl', 'search-index', 'log'])),
    );
    const schema = [...fixture.contents.entries()].find(([artifactPath]) =>
      artifactPath.endsWith('/summary.schema.json') && artifactPath.includes('/reviewed-modules/')
    );
    expect(schema).toBeDefined();
    expect(JSON.parse(schema![1])).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
    expect(remote.stage).toHaveBeenCalledTimes(1);
    const staged = remote.stage.mock.calls[0]![0];
    expect(staged.documents).toHaveLength(2);
    expect(staged.documents.find((document) => document.moduleId === 'orders')).toMatchObject({
      documentKind: 'functional-module',
      repositoryId,
      moduleId: 'orders',
      repositoryScopes: [repositoryId, 'tenant:orders'],
    });

    const replay = await run(fixture, remote, submissions('accept'));
    expect(replay.outcome).toBe('reused');
    expect(remote.stage).toHaveBeenCalledTimes(1);

    remote.head = { ...remote.previousHead, revision: remote.head.revision + 1 };
    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'drifted from the active module-index head',
    );
  });

  it('carries accepted modules across a partial revise round and reviews only the pending successor', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const first = await run(fixture, remote, [
      submission('contracts', 'accept'),
      submission('orders', 'revise'),
    ]);
    expect(first.outcome).toBe('revision-required');
    expect(first.manifest.status).toBe('summarizing-modules');

    const summarizeModule = vi.fn(async (request: RepositoryModuleSummaryRequest) => {
      expect(request.evidenceBundle.moduleId).toBe('orders');
      expect(request.previousProposal?.moduleId).toBe('orders');
      expect(request.reviseReview).toMatchObject({ moduleId: 'orders', decision: 'revise' });
      const narrative = {
        ...request.previousProposal!.narrative,
        summary: `${request.previousProposal!.narrative.summary} Includes reviewed failure modes.`,
      };
      return materializeRepositoryModuleWikiProposal({
        evidenceBundle: request.evidenceBundle,
        narrative,
        evidenceBindings: claimBindings(narrative),
        generation: {
          modelId: 'summary-model',
          promptTemplateId: 'module-summary',
          promptTemplateVersion: '1.1.0',
        },
        previousProposal: request.previousProposal,
        reviseReview: request.reviseReview,
        producer: { kind: 'module-summary-agent', id: 'summary-agent', version: '1.1.0' },
        createdAt: '2026-09-01T00:01:05.000Z',
      });
    });
    await generateRepositoryModuleSummaries({
      repositoryRoot: fixture.root,
      ingestionId: fixture.manifest().id,
    }, {
      summarizeModule,
      loadManifest: async () => fixture.manifest(),
      readArtifact: async (_root, _ingestion, artifact) => fixture.contents.get(artifact.path!)!,
      verifyStoredArtifacts: async () => undefined,
      persist: (request) => fixture.persist(request),
      now: () => '2026-09-01T00:01:05.000Z',
    });
    expect(summarizeModule).toHaveBeenCalledTimes(1);
    const current = selectCurrentRepositoryModuleSummaryArtifactRefs(fixture.manifest());
    expect(current.wikiProposals).toHaveLength(2);
    expect(current.knowledgeReviews).toHaveLength(1);

    const second = await run(fixture, remote, [{
      ...submission('orders', 'accept'),
      reviewedAt: '2026-09-01T00:01:06.000Z',
    }]);
    expect(second.outcome).toBe('ready');
    const latestReviewEvent = [...second.manifest.events].reverse().find((event) =>
      event.type === 'module-knowledge-review-recorded'
    );
    expect(latestReviewEvent?.artifactRefs?.filter((ref) =>
      ref.kind === 'repository-module-knowledge-review'
    )).toHaveLength(2);
    expect(second.reviews.map((review) => [review.moduleId, review.decision])).toEqual([
      ['contracts', 'accept'],
      ['orders', 'accept'],
    ]);
  });

  it('reuses the same staged generation after a pre-activation crash and rejects ACL drift on replay', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const activate = vi.spyOn(fixture.store, 'activate');
    activate.mockRejectedValueOnce(new Error('injected local activation crash'));

    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'injected local activation crash',
    );
    expect(fixture.manifest().status).toBe('publishing-knowledge');
    const stagedId = (await fixture.store.read(fixture.root, scope)).publications[0]!.id;
    await expect(run(fixture, remote, submissions('accept'), ['tenant:changed', repositoryId]))
      .rejects.toThrow('ACL conflicts');

    const result = await run(fixture, remote, submissions('accept'));
    expect(result.outcome).toBe('ready');
    expect(result.publication?.id).toBe(stagedId);
    expect(result.publication?.generation).toBe(1);
  });

  it('compensates an ambiguous remote activation failure and records the withdrawn state in the ledger', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    remote.failActivationAfterCommit = true;

    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'Both activation heads were compensated',
    );
    expect(fixture.manifest().status).toBe('publishing-knowledge');
    expect(fixture.manifest().events.at(-1)?.type).toBe('knowledge-publication-withdrawn');
    const snapshot = await fixture.store.read(fixture.root, scope);
    expect(snapshot.head).toBeUndefined();
    expect(snapshot.publications.some((publication) => publication.status === 'withdrawn')).toBe(true);
    expect(remote.head.generation).toBeNull();
    expect(remote.withdraw).toHaveBeenCalledTimes(1);
  });

  it('resumes from an already-active local/remote generation without staging it again', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    remote.failActivationAfterCommit = true;
    remote.withdraw.mockRejectedValueOnce(new Error('injected remote compensation outage'));
    vi.spyOn(fixture.store, 'withdraw').mockRejectedValueOnce(
      new Error('injected local compensation outage'),
    );

    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'Compensation requires recovery',
    );
    expect((await fixture.store.read(fixture.root, scope)).head).toBeDefined();
    expect(fixture.manifest().status).toBe('publishing-knowledge');
    remote.failActivationAfterCommit = false;

    const recovered = await run(fixture, remote, submissions('accept'));
    expect(recovered.outcome).toBe('ready');
    expect(remote.stage).toHaveBeenCalledTimes(1);
    expect(remote.activate).toHaveBeenCalledTimes(2);
    expect(recovered.publication?.generation).toBe(1);
  });

  it('keeps a local activation CAS failure staged and never advances the remote head or ready state', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    vi.spyOn(fixture.store, 'activate').mockRejectedValueOnce(
      new Error('Repository knowledge publication head compare-and-swap conflict.'),
    );

    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'compare-and-swap conflict',
    );
    expect(fixture.manifest().status).toBe('publishing-knowledge');
    expect(remote.activate).not.toHaveBeenCalled();
    expect((await fixture.store.read(fixture.root, scope)).head).toBeUndefined();
  });

  it('compensates both heads when the final ready manifest commit fails before publication', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const basePersist = fixture.persist;
    let injected = false;
    fixture.persist = vi.fn(async (request: PersistRepositoryIngestionArtifactsRequest) => {
      const marker = request.artifacts.find((artifact) => artifact.mode === 'manifest');
      const next = marker === undefined ? undefined : JSON.parse(marker.content) as RepositoryIngestionManifest;
      if (!injected && next?.status === 'ready') {
        injected = true;
        throw new Error('injected final manifest persistence failure');
      }
      return basePersist(request);
    });

    await expect(run(fixture, remote, submissions('accept'))).rejects.toThrow(
      'Both activation heads were compensated',
    );
    expect(fixture.manifest().events.at(-1)?.type).toBe('knowledge-publication-withdrawn');
    expect((await fixture.store.read(fixture.root, scope)).head).toBeUndefined();
    expect(remote.head.generation).toBeNull();
  });

  it('does not undo a concurrent identical ready commit after the final manifest CAS loses', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const basePersist = fixture.persist;
    let injected = false;
    fixture.persist = vi.fn(async (request: PersistRepositoryIngestionArtifactsRequest) => {
      const marker = request.artifacts.find((artifact) => artifact.mode === 'manifest');
      const next = marker === undefined ? undefined : JSON.parse(marker.content) as RepositoryIngestionManifest;
      if (!injected && next?.status === 'ready') {
        injected = true;
        await basePersist(request);
        throw new Error('repository ingestion manifest compare-and-swap conflict');
      }
      return basePersist(request);
    });

    const result = await run(fixture, remote, submissions('accept'));
    expect(result.outcome).toBe('reused');
    expect(fixture.manifest().status).toBe('ready');
    expect(remote.withdraw).not.toHaveBeenCalled();
    expect((await fixture.store.read(fixture.root, scope)).head?.publicationId).toBe(result.publication?.id);
  });
});

describe('repository module knowledge withdrawal', () => {
  it('restores the predecessor and atomically audits the ready-to-superseded transition', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const predecessor = await seedActivePredecessor(fixture, remote);
    const ready = await run(fixture, remote, submissions('accept'));

    const result = await withdrawRun(fixture, remote);

    expect(result.outcome).toBe('withdrawn');
    expect(result.manifest.status).toBe('superseded');
    expect(result.manifest.events.slice(-2).map((event) => event.type)).toEqual([
      'ingestion-superseded',
      'knowledge-publication-withdrawn',
    ]);
    const audit = result.manifest.events.at(-1);
    expect(audit).toMatchObject({
      actor: { kind: 'human', id: 'knowledge-owner' },
      details: {
        update: {
          reason: 'retire stale module knowledge',
          restoredPublicationId: predecessor.id,
          remoteHead: {
            publicationId: predecessor.id,
            publicationPayloadHash: predecessor.payloadHash,
            generation: predecessor.generation,
          },
        },
      },
    });
    expect(result.restoredHead?.publicationId).toBe(predecessor.id);
    expect(result.remoteHead).toMatchObject({
      publicationId: predecessor.id,
      publicationPayloadHash: predecessor.payloadHash,
      generation: predecessor.generation,
    });
    const snapshot = await fixture.store.read(fixture.root, scope);
    expect(snapshot.head?.publicationId).toBe(predecessor.id);
    expect(snapshot.publications.find((item) => item.id === ready.publication?.id)?.status).toBe('withdrawn');
    expect(snapshot.publications.find((item) => item.id === predecessor.id)?.status).toBe('active');
  });

  it('represents withdrawal without a predecessor as an empty durable local and remote head', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    await run(fixture, remote, submissions('accept'));

    const result = await withdrawRun(fixture, remote);

    expect(result.restoredHead).toBeUndefined();
    expect(result.remoteHead).toMatchObject({
      publicationId: null,
      publicationPayloadHash: null,
      generation: null,
    });
    expect((await fixture.store.read(fixture.root, scope)).head).toBeUndefined();
    expect(await remote.readHead(scope)).toBeNull();
  });

  it('replays a remote-first withdrawal after the first local registry attempt fails', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    await run(fixture, remote, submissions('accept'));
    const localWithdraw = vi.spyOn(fixture.store, 'withdraw');
    localWithdraw.mockRejectedValueOnce(new Error('injected local withdrawal failure'));

    await expect(withdrawRun(fixture, remote)).rejects.toThrow('injected local withdrawal failure');
    expect(fixture.manifest().status).toBe('ready');
    expect(await remote.readHead(scope)).toBeNull();

    const recovered = await withdrawRun(fixture, remote);
    expect(recovered.outcome).toBe('withdrawn');
    expect(recovered.manifest.status).toBe('superseded');
    expect(remote.withdraw).toHaveBeenCalledTimes(1);
    expect(localWithdraw).toHaveBeenCalledTimes(2);
  });

  it('replays local idempotently after remote and local withdrawal commit before manifest persistence fails', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    const ready = await run(fixture, remote, submissions('accept'));
    const basePersist = fixture.persist;
    let injected = false;
    fixture.persist = vi.fn(async (request: PersistRepositoryIngestionArtifactsRequest) => {
      const marker = request.artifacts.find((artifact) => artifact.mode === 'manifest');
      const next = marker === undefined ? undefined : JSON.parse(marker.content) as RepositoryIngestionManifest;
      if (!injected && next?.status === 'superseded') {
        injected = true;
        throw new Error('injected withdrawal manifest failure');
      }
      return basePersist(request);
    });

    await expect(withdrawRun(fixture, remote)).rejects.toThrow('injected withdrawal manifest failure');
    expect(fixture.manifest().status).toBe('ready');
    expect((await fixture.store.read(fixture.root, scope)).head).toBeUndefined();
    expect((await fixture.store.read(fixture.root, scope)).publications.find((item) =>
      item.id === ready.publication?.id
    )?.status).toBe('withdrawn');

    const recovered = await withdrawRun(fixture, remote);
    expect(recovered.outcome).toBe('withdrawn');
    expect(recovered.manifest.status).toBe('superseded');
    expect(remote.withdraw).toHaveBeenCalledTimes(1);
  });

  it('fails closed on remote head drift before mutating the local registry or manifest', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    await run(fixture, remote, submissions('accept'));
    remote.head = {
      repositoryId,
      channel: scope.channel,
      publicationId: 'repository-knowledge-publication:foreign',
      publicationPayloadHash: 'f'.repeat(64),
      generation: 99,
      revision: remote.head.revision + 1,
    };
    const localWithdraw = vi.spyOn(fixture.store, 'withdraw');

    await expect(withdrawRun(fixture, remote)).rejects.toThrow('remote module-index head has drifted');
    expect(localWithdraw).not.toHaveBeenCalled();
    expect(fixture.manifest().status).toBe('ready');
    expect((await fixture.store.read(fixture.root, scope)).head).toBeDefined();
  });

  it('returns reused for an identical completed withdrawal without repeating either mutation', async () => {
    const fixture = await createFixture();
    const remote = new FakeIndexPublisher();
    await run(fixture, remote, submissions('accept'));
    const localWithdraw = vi.spyOn(fixture.store, 'withdraw');
    await withdrawRun(fixture, remote);

    const replay = await withdrawRun(fixture, remote);

    expect(replay.outcome).toBe('reused');
    expect(replay.remoteHead).toBeNull();
    expect(remote.withdraw).toHaveBeenCalledTimes(1);
    expect(localWithdraw).toHaveBeenCalledTimes(1);
  });
});

async function withdrawRun(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  remote: FakeIndexPublisher,
) {
  return withdrawRepositoryModuleKnowledgePublication({
    repositoryRoot: fixture.root,
    ingestionId: fixture.manifest().id,
    scope,
    reason: 'retire stale module knowledge',
    actorId: 'knowledge-owner',
  }, {
    publicationStore: fixture.store,
    indexPublisher: remote,
    loadManifest: async () => fixture.manifest(),
    readArtifact: async (_root, _ingestion, artifact) => {
      const content = artifact.path === undefined ? undefined : fixture.contents.get(artifact.path);
      if (content === undefined) throw new Error(`Missing test artifact: ${artifact.path}`);
      return content;
    },
    verifyStoredArtifacts: async () => undefined,
    persist: (request) => fixture.persist(request),
    now: () => '2026-09-01T00:02:00.000Z',
  });
}

async function seedActivePredecessor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  remote: FakeIndexPublisher,
) {
  const staged = await fixture.store.stage({
    repositoryRoot: fixture.root,
    scope,
    repositoryScopes: [repositoryId, 'tenant:orders'],
    source: {
      repositoryModuleBundleId: 'repository-module-bundle:predecessor',
      repositoryModuleBundleHash: '1'.repeat(64),
      modules: [{
        moduleId: 'legacy-orders',
        evidenceBundleId: 'repository-module-evidence-bundle:legacy-orders',
        evidenceBundleHash: '2'.repeat(64),
        wikiProposalId: 'repository-module-wiki-proposal:legacy-orders',
        wikiProposalHash: '3'.repeat(64),
        knowledgeReviewId: 'repository-module-knowledge-review:legacy-orders',
        knowledgeReviewHash: '4'.repeat(64),
        knowledgePageId: 'repository-module-knowledge-page:legacy-orders',
        knowledgePageHash: '5'.repeat(64),
      }],
    },
    artifacts: [{
      id: 'repository-module-knowledge-page:legacy-orders',
      kind: 'repository-wiki',
      relativePath: 'wiki/legacy-orders/summary.json',
      mediaType: 'application/json',
      content: '{}\n',
      createdAt: '2026-09-01T00:00:10.000Z',
    }],
    producer: { kind: 'knowledge-publisher', id: 'predecessor-fixture', version: '1.0.0' },
    stagedAt: '2026-09-01T00:00:10.000Z',
  });
  const validatedReceipt = materializeRepositoryModuleIndexReceipt({
    publication: staged,
    status: 'validated',
    storeId: 'fake-module-index',
    documentCount: 1,
    moduleIds: ['legacy-orders'],
    indexArtifactHash: '6'.repeat(64),
    createdAt: '2026-09-01T00:00:10.000Z',
    updatedAt: '2026-09-01T00:00:11.000Z',
  });
  const activated = await fixture.store.activate({
    repositoryRoot: fixture.root,
    scope,
    publicationId: staged.id,
    indexReceipt: validatedReceipt,
    expectedHead: null,
    activatedAt: '2026-09-01T00:00:12.000Z',
  });
  if (activated.head === undefined) throw new Error('predecessor fixture did not activate');
  remote.head = {
    repositoryId,
    channel: scope.channel,
    publicationId: activated.publication.id,
    publicationPayloadHash: activated.publication.payloadHash,
    generation: activated.publication.generation,
    revision: 1,
  };
  return activated.publication;
}

function submissions(decision: RepositoryModuleKnowledgeReviewDecision): RepositoryModuleKnowledgeReviewSubmission[] {
  return ['contracts', 'orders'].map((moduleId) => submission(moduleId, decision));
}

function submission(
  moduleId: string,
  decision: RepositoryModuleKnowledgeReviewDecision,
): RepositoryModuleKnowledgeReviewSubmission {
  return {
    moduleId,
    decision,
    reviewerId: 'knowledge-owner',
    ...(decision === 'revise' ? { comment: 'Add the missing failure-mode evidence.' } : {}),
    reviewedAt: reviewTime,
  };
}

async function run(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  remote: FakeIndexPublisher,
  reviews: RepositoryModuleKnowledgeReviewSubmission[],
  repositoryScopes = ['tenant:orders', repositoryId],
) {
  return reviewAndPublishRepositoryModuleKnowledge({
    repositoryRoot: fixture.root,
    ingestionId: fixture.manifest().id,
    scope,
    repositoryScopes,
    reviews,
  }, {
    publicationStore: fixture.store,
    indexPublisher: remote,
    loadManifest: async () => fixture.manifest(),
    readArtifact: async (_root, _ingestion, artifact) => {
      const content = artifact.path === undefined ? undefined : fixture.contents.get(artifact.path);
      if (content === undefined) throw new Error(`Missing test artifact: ${artifact.path}`);
      return content;
    },
    verifyStoredArtifacts: async () => undefined,
    persist: (request) => fixture.persist(request),
    now: () => '2026-09-01T00:01:10.000Z',
  });
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-knowledge-publication-'));
  roots.push(root);
  const contents = new Map<string, string>();
  const ir = sourceIr();
  const discovery = discoveryProposal();
  const draft = materializeRepositoryModuleCatalog(discovery, ir, {
    producer: { kind: 'ingestion-host', id: 'fixture-host' },
    createdAt: t0,
  });
  const boundaryReview = materializeRepositoryModuleReview(discovery, ir, {
    decision: 'accept',
    reviewerId: 'architect',
    decidedAt: t0,
  });
  const applied = applyRepositoryModuleReview(draft, discovery, ir, boundaryReview);
  if (applied.catalog === undefined) throw new Error('fixture boundary review did not activate');
  const catalog = applied.catalog;
  const generatedPages = catalog.modules.map((module) => materializeRepositoryModuleKnowledgePage({
    catalog,
    ir,
    moduleId: module.id,
    wiki: deriveInitialRepositoryModuleWikiDraft(discovery, catalog, ir, module.id),
    producer,
    createdAt: t0,
  }));
  const bundle = materializeRepositoryModuleBundle({
    proposal: discovery,
    review: boundaryReview,
    catalog,
    ir,
    knowledgePages: generatedPages,
    producer: { kind: 'ingestion-host', id: 'fixture-host' },
    createdAt: t0,
  });
  const evidenceBundles = catalog.modules.map((module) => {
    const evidenceContent = `Evidence for ${module.id}`;
    return materializeRepositoryModuleEvidenceBundle({
      repositoryModuleBundle: bundle,
      moduleId: module.id,
      items: [{
        id: `evidence-item-${module.id}`,
        kind: 'source-slice',
        evidenceKind: 'source',
        evidenceRefIds: [`entity-${module.id}`],
        path: `src/${module.name}.java`,
        mediaType: 'text/plain',
        content: evidenceContent,
        byteLength: Buffer.byteLength(evidenceContent, 'utf8'),
        contentHash: sha256Hex(evidenceContent),
        truncated: false,
      }],
      producer: { kind: 'ingestion-host', id: 'fixture-host' },
      createdAt: '2026-09-01T00:00:08.000Z',
    });
  });
  const wikiProposals = evidenceBundles.map((evidence) => {
    const narrative = deriveInitialRepositoryModuleWikiDraft(discovery, catalog, ir, evidence.moduleId);
    return materializeRepositoryModuleWikiProposal({
      evidenceBundle: evidence,
      narrative,
      evidenceBindings: claimBindings(narrative),
      generation: {
        modelId: 'summary-model',
        promptTemplateId: 'module-summary',
        promptTemplateVersion: '1.0.0',
      },
      producer: { kind: 'module-summary-agent', id: 'summary-agent', version: '1.0.0' },
      createdAt: '2026-09-01T00:00:09.000Z',
    });
  });
  const runRoot = '.forexplore/ingestion/ingestion-orders';
  const profileRef = ref('profile-orders', 'repository-profile', `${runRoot}/profile.json`, '{}\n', t0);
  const irArtifact = jsonRef(ir.id, 'unified-repository-ir', `${runRoot}/ir.json`, ir, t0);
  const discoveryArtifact = jsonRef(discovery.id, 'module-discovery-proposal', `${runRoot}/proposal.json`, discovery, t0);
  const draftArtifact = jsonRef(draft.id, 'module-catalog', `${runRoot}/draft-catalog.json`, draft, t0);
  const reviewArtifact = jsonRef(boundaryReview.id, 'module-review', `${runRoot}/boundary-review.json`, boundaryReview, t0);
  const catalogArtifact = jsonRef(catalog.id, 'module-catalog', `${runRoot}/active-catalog.json`, catalog, t0);
  const bundleArtifact = jsonRef(bundle.id, 'repository-module-bundle', `${runRoot}/bundle.json`, bundle, t0);
  const evidenceArtifacts = evidenceBundles.map((evidence) => jsonRef(
    evidence.id,
    'repository-module-evidence-bundle',
    `${runRoot}/evidence-${evidence.moduleId}.json`,
    evidence,
    evidence.createdAt,
  ));
  const proposalArtifacts = wikiProposals.map((proposal) => jsonRef(
    proposal.id,
    'repository-module-wiki-proposal',
    `${runRoot}/summary-proposals/${safeName(proposal.id)}.json`,
    proposal,
    proposal.createdAt,
  ));
  for (const artifact of [
    profileRef, irArtifact, discoveryArtifact, draftArtifact, reviewArtifact, catalogArtifact,
    bundleArtifact, ...evidenceArtifacts, ...proposalArtifacts,
  ]) {
    contents.set(artifact.ref.path!, artifact.content);
  }
  const generatedArtifacts = generatedPages.flatMap(materializeRepositoryModuleKnowledgeArtifacts).map((item) => {
    const suffix = item.descriptor.artifact.path!.slice('.forexplore/modules/'.length);
    const artifactPath = `${runRoot}/generated/${suffix}`;
    const artifactRef = {
      ...item.descriptor.artifact,
      path: artifactPath,
      byteLength: Buffer.byteLength(item.content, 'utf8'),
    };
    contents.set(artifactPath, item.content);
    return { ...item.descriptor, artifact: artifactRef };
  });
  const logContent = '# ingestion log\n';
  const logRef = ref('knowledge-log', 'analysis-log', '.forexplore/modules/log.md', logContent, t0);
  contents.set(logRef.ref.path!, logContent);

  let manifest = createRepositoryIngestionManifest({
    id: 'ingestion-orders',
    repositoryId,
    mode: 'full',
    repositoryContentHash: ir.repositoryContentHash,
    requestedCapabilities: ['symbol-index'],
    analysisAdapters: [],
    requestedAt: t0,
    actor: { kind: 'system', id: 'fixture' },
  });
  const at = (seconds: number) => `2026-09-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;
  manifest = transitionRepositoryIngestionManifest(manifest, event('ingestion-started', at(1), 'profiling'));
  manifest = transitionRepositoryIngestionManifest(manifest, {
    ...event('profile-produced', at(2), 'analyzing'),
    artifacts: { profile: profileRef.ref },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    ...event('unified-ir-produced', at(3), 'merging'),
    artifacts: { unifiedRepositoryIr: irArtifact.ref },
    completedCapabilities: ['symbol-index'],
  });
  manifest = transitionRepositoryIngestionManifest(manifest, event('status-changed', at(4), 'discovering-modules'));
  manifest = transitionRepositoryIngestionManifest(manifest, {
    ...event('module-proposal-produced', at(5), 'awaiting-module-review'),
    artifacts: {
      moduleDiscoveryProposal: discoveryArtifact.ref,
      moduleCatalog: draftArtifact.ref,
      knowledge: [
        {
          artifact: logRef.ref,
          format: 'log',
          sourceArtifactIds: [discoveryArtifact.ref.id],
          producer: { kind: 'ingestion-host', id: 'fixture-host' },
        },
      ],
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-review-recorded',
    occurredAt: at(6),
    actor: { kind: 'human', id: 'architect' },
    idempotencyKey: 'fixture:boundary-review',
    artifacts: { moduleReview: reviewArtifact.ref },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-catalog-produced',
    occurredAt: at(6),
    actor: { kind: 'system', id: 'fixture' },
    idempotencyKey: 'fixture:active-catalog',
    artifacts: { activeModuleCatalog: catalogArtifact.ref },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'knowledge-artifact-produced',
    occurredAt: at(6),
    actor: { kind: 'system', id: 'fixture' },
    idempotencyKey: 'fixture:accepted-boundary-pages',
    artifacts: { knowledge: generatedArtifacts },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    ...event('module-bundle-produced', at(7), 'summarizing-modules'),
    artifacts: { moduleBundle: bundleArtifact.ref },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-evidence-bundle-produced',
    occurredAt: at(8),
    actor: { kind: 'system', id: 'fixture' },
    idempotencyKey: 'fixture:evidence',
    artifacts: { moduleEvidenceBundles: evidenceArtifacts.map((artifact) => artifact.ref) },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    ...event('module-wiki-proposal-produced', at(9), 'awaiting-summary-review'),
    artifacts: { moduleWikiProposals: proposalArtifacts.map((artifact) => artifact.ref) },
  });
  validateRepositoryIngestionManifest(manifest);

  const holder = { manifest };
  const basePersist = vi.fn(async (request: PersistRepositoryIngestionArtifactsRequest) => {
    for (const artifact of request.artifacts) {
      if (artifact.mode === 'manifest') {
        holder.manifest = JSON.parse(artifact.content) as RepositoryIngestionManifest;
      } else {
        contents.set(artifact.path, artifact.content);
      }
    }
    return request.artifacts.map((artifact) => artifact.path);
  });
  const fixture = {
    root,
    contents,
    store: new RepositoryKnowledgePublicationStore(),
    manifest: () => holder.manifest,
    persist: basePersist as (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>,
  };
  return fixture;
}

function event(
  type: Parameters<typeof transitionRepositoryIngestionManifest>[1]['type'],
  occurredAt: string,
  toStatus: Parameters<typeof transitionRepositoryIngestionManifest>[1]['toStatus'],
) {
  return {
    type,
    occurredAt,
    actor: { kind: 'system' as const, id: 'fixture' },
    idempotencyKey: `fixture:${type}:${toStatus}`,
    toStatus,
  };
}

function jsonRef(
  id: string,
  kind: RepositoryIngestionArtifactRef['kind'],
  artifactPath: string,
  value: unknown,
  createdAt: string,
) {
  return ref(id, kind, artifactPath, `${canonicalJson(value)}\n`, createdAt);
}

function ref(
  id: string,
  kind: RepositoryIngestionArtifactRef['kind'],
  artifactPath: string,
  content: string,
  createdAt: string,
): { ref: RepositoryIngestionArtifactRef; content: string } {
  return {
    ref: {
      id,
      kind,
      contentHash: sha256Hex(content),
      hashAlgorithm: 'sha256',
      schemaVersion: repositoryIngestionSchemaVersion,
      path: artifactPath,
      mediaType: 'application/json',
      byteLength: Buffer.byteLength(content, 'utf8'),
      createdAt,
    },
    content,
  };
}

function sourceIr(): UnifiedRepositoryIR {
  const body: Omit<UnifiedRepositoryIR, 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'ir-orders-v1',
    repositoryId,
    profileId: 'profile-orders',
    repositoryContentHash: 'c'.repeat(64),
    sourceShardIds: ['shard-java'],
    capabilities: ['symbol-index'],
    files: [{
      id: 'file-contracts',
      path: 'src/Contracts.java',
      contentHash: 'e'.repeat(64),
      role: 'source',
      languageId: 'java',
      projectIds: ['project-orders'],
    }, {
      id: 'file-orders',
      path: 'src/Orders.java',
      contentHash: 'd'.repeat(64),
      role: 'source',
      languageId: 'java',
      projectIds: ['project-orders'],
    }],
    entities: [{
      id: 'entity-contracts',
      kind: 'type',
      name: 'Contracts',
      fileId: 'file-contracts',
      languageId: 'java',
      signature: 'Contracts.Order',
    }, {
      id: 'entity-orders',
      kind: 'type',
      name: 'Orders',
      fileId: 'file-orders',
      languageId: 'java',
      signature: 'Orders.submit(Order): Receipt',
    }],
    apiSurfaces: [{
      id: 'api-contracts',
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
    }, {
      id: 'api-orders',
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
    }],
    dependencies: [],
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
        capabilities: ['symbol-index'],
        missingCapabilities: [],
        diagnosticIds: [],
      }],
    },
    diagnostics: [],
    producer: { kind: 'ingestion-host', id: 'fixture-host' },
    createdAt: t0,
  };
  return { ...body, contentHash: sha256Hex(canonicalJson(body)) };
}

function discoveryProposal(): ModuleDiscoveryProposal {
  const body: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'proposal-orders-v1',
    repositoryId,
    sourceIrId: 'ir-orders-v1',
    sourceIrHash: sourceIr().contentHash,
    objective: 'Discover the order capability.',
    constraints: [],
    status: 'awaiting-review',
    modules: [{
      id: 'contracts',
      name: 'Contracts',
      kind: 'shared-kernel',
      description: 'Defines shared public contracts.',
      responsibilities: ['Define contracts'],
      businessCapabilities: [],
      fileIds: ['file-contracts'],
      entityIds: ['entity-contracts'],
      entryPointEntityIds: [],
      publicApiEntityIds: ['entity-contracts'],
      boundaryRationale: 'Public contract ownership.',
      evidenceRefs: [{ id: 'entity-contracts', kind: 'semantic-analysis' }],
      tags: ['contracts'],
    }, {
      id: 'orders',
      name: 'Orders',
      kind: 'business-capability',
      description: 'Owns order submission.',
      responsibilities: ['Submit orders'],
      businessCapabilities: ['Order management'],
      fileIds: ['file-orders'],
      entityIds: ['entity-orders'],
      entryPointEntityIds: ['entity-orders'],
      publicApiEntityIds: ['entity-orders'],
      boundaryRationale: 'Order lifecycle changes together.',
      evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
      tags: ['orders'],
    }],
    assignments: [{
      fileId: 'file-contracts',
      moduleIds: ['contracts'],
      kind: 'owned',
      rationale: 'Contract implementation.',
      evidenceRefs: [{ id: 'file-contracts', kind: 'source' }],
    }, {
      fileId: 'file-orders',
      moduleIds: ['orders'],
      kind: 'owned',
      rationale: 'Order implementation.',
      evidenceRefs: [{ id: 'file-orders', kind: 'source' }],
    }],
    dependencies: [],
    assumptions: [],
    risks: ['Static evidence does not prove runtime behavior.'],
    unresolvedQuestions: [],
    producer,
    createdAt: t0,
  };
  return { ...body, contentHash: sha256Hex(canonicalJson(body)) };
}

function claimBindings(narrative: RepositoryModuleWikiDraft): RepositoryModuleWikiEvidenceBinding[] {
  const result: RepositoryModuleWikiEvidenceBinding[] = [];
  for (const section of ['summary', 'architecture', 'publicInterfaces', 'dataFlow', 'operationalNotes', 'reuseGuidance'] as const) {
    if (narrative[section].trim()) result.push({ section, claim: narrative[section], evidenceIds: [...narrative.evidenceIds] });
  }
  for (const section of ['limitations', 'risks'] as const) {
    for (const claim of narrative[section]) result.push({ section, claim, evidenceIds: [...narrative.evidenceIds] });
  }
  return result;
}

function safeName(value: string): string {
  return `${value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}-${sha256Hex(value).slice(0, 12)}`;
}

class FakeIndexPublisher implements ModuleKnowledgeIndexPublisher {
  readonly stage = vi.fn(async (input: Parameters<ModuleKnowledgeIndexPublisher['stage']>[0]) => {
    this.publication = input.publication;
    this.documents = input.documents;
    return materializeRepositoryModuleIndexReceipt({
      publication: input.publication,
      status: 'staged',
      storeId: 'fake-module-index',
      documentCount: input.documents.length,
      moduleIds: input.documents.map((document) => document.moduleId),
      indexArtifactHash: sha256Hex(canonicalJson(input.documents)),
      createdAt: input.publication.stagedAt,
    });
  });

  readonly validate = vi.fn(async (_key: ModuleKnowledgePublicationKey) => {
    if (this.publication === undefined) throw new Error('not staged');
    return materializeRepositoryModuleIndexReceipt({
      publication: this.publication,
      status: 'validated',
      storeId: 'fake-module-index',
      documentCount: this.documents.length,
      moduleIds: this.documents.map((document) => document.moduleId),
      indexArtifactHash: sha256Hex(canonicalJson(this.documents)),
      createdAt: this.publication.stagedAt,
      updatedAt: new Date(Date.parse(this.publication.stagedAt) + 1_000).toISOString(),
    });
  });

  readonly readHead = vi.fn(async (requestedScope: typeof scope): Promise<ModuleKnowledgeIndexHead | null> => {
    if (
      requestedScope.repositoryId !== this.head.repositoryId ||
      requestedScope.channel !== this.head.channel
    ) throw new Error('remote head scope mismatch');
    return this.head.publicationId === null ? null : { ...this.head };
  });

  readonly activate = vi.fn(async (
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number | null,
  ): Promise<ModuleKnowledgeIndexHead> => {
    if (this.head.publicationId === key.publicationId && this.head.generation === key.generation) return this.head;
    if (this.head.generation !== expectedActiveGeneration) throw new Error('remote CAS conflict');
    this.previousHead = { ...this.head };
    this.head = {
      repositoryId: key.repositoryId,
      channel: key.channel,
      publicationId: key.publicationId,
      publicationPayloadHash: this.publication?.payloadHash ?? null,
      generation: key.generation,
      revision: this.head.revision + 1,
    };
    if (this.failActivationAfterCommit) throw new Error('injected remote activation timeout');
    return this.head;
  });

  readonly withdraw = vi.fn(async (
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number,
  ): Promise<ModuleKnowledgeIndexHead> => {
    if (this.head.generation !== expectedActiveGeneration || this.head.publicationId !== key.publicationId) {
      if (this.head.generation === this.previousHead.generation && this.head.publicationId === this.previousHead.publicationId) {
        return this.head;
      }
      throw new Error('remote withdrawal CAS conflict');
    }
    this.head = { ...this.previousHead, revision: this.head.revision + 1 };
    return this.head;
  });

  failActivationAfterCommit = false;
  publication?: Parameters<ModuleKnowledgeIndexPublisher['stage']>[0]['publication'];
  documents: Parameters<ModuleKnowledgeIndexPublisher['stage']>[0]['documents'] = [];
  previousHead: ModuleKnowledgeIndexHead = {
    repositoryId,
    channel: scope.channel,
    publicationId: null,
    publicationPayloadHash: null,
    generation: null,
    revision: 0,
  };
  head: ModuleKnowledgeIndexHead = { ...this.previousHead };
}
