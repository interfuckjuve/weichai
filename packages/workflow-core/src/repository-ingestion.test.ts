import { describe, expect, it } from 'vitest';
import {
  repositoryIngestionSchemaVersion,
  type AnalysisAdapterDescriptor,
  type RepositoryIngestionArtifactKind,
  type RepositoryIngestionArtifactRef,
  type RepositoryKnowledgeArtifact,
  type RepositoryKnowledgeArtifactFormat,
} from '@forexplore/contracts';
import {
  canTransitionRepositoryIngestionStatus,
  createRepositoryIngestionManifest,
  recordRepositoryIngestionEvent,
  selectCurrentRepositoryKnowledgePublicationArtifactRefs,
  selectCurrentRepositoryModuleSummaryArtifactRefs,
  serializeRepositoryIngestionManifest,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
} from './repository-ingestion';
import { sha256Hex } from './module-plan-utils';

const start = '2026-08-31T00:00:00.000Z';
const actor = { kind: 'system' as const, id: 'ingestion-host' };

const adapter: AnalysisAdapterDescriptor = {
  schemaVersion: repositoryIngestionSchemaVersion,
  id: 'java-static-analysis',
  name: 'Java static analysis',
  version: '1.0.0',
  languageIds: ['java'],
  capabilities: ['repository-profile', 'symbol-index'],
  modes: ['full', 'incremental'],
  shardStrategy: 'project',
  outputs: ['files', 'entities'],
  deterministic: true,
};

function artifact(
  id: string,
  kind: RepositoryIngestionArtifactKind,
  path = `.forexplore/${id}.json`,
): RepositoryIngestionArtifactRef {
  return {
    id,
    kind,
    contentHash: sha256Hex(id),
    hashAlgorithm: 'sha256',
    schemaVersion: repositoryIngestionSchemaVersion,
    path,
  };
}

function knowledge(
  id: string,
  format: RepositoryKnowledgeArtifactFormat,
  kind: RepositoryIngestionArtifactKind,
  path: string,
): RepositoryKnowledgeArtifact {
  return {
    artifact: artifact(id, kind, path),
    format,
    sourceArtifactIds: ['module-knowledge-review-orders-v1'],
    producer: { kind: 'ingestion-host', id: 'ingestion-host' },
  };
}

function initial() {
  return createRepositoryIngestionManifest({
    id: 'ingestion-orders-v1',
    repositoryId: 'repository-orders',
    mode: 'full',
    repositoryRevision: '1'.repeat(40),
    repositoryContentHash: 'a'.repeat(64),
    requestedCapabilities: ['symbol-index', 'repository-profile'],
    analysisAdapters: [adapter],
    requestedAt: start,
    actor,
  });
}

function readyManifest() {
  let manifest = initial();
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'ingestion-started',
    toStatus: 'profiling',
    occurredAt: '2026-08-31T00:00:01.000Z',
    actor,
    idempotencyKey: 'start',
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'profile-produced',
    toStatus: 'analyzing',
    occurredAt: '2026-08-31T00:00:02.000Z',
    actor,
    idempotencyKey: 'profile',
    artifacts: { profile: artifact('profile-v1', 'repository-profile') },
    completedCapabilities: ['repository-profile'],
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'shard-produced',
    toStatus: 'merging',
    occurredAt: '2026-08-31T00:00:03.000Z',
    actor,
    idempotencyKey: 'shard',
    artifacts: { shards: [artifact('shard-java-v1', 'analysis-shard')] },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'unified-ir-produced',
    toStatus: 'discovering-modules',
    occurredAt: '2026-08-31T00:00:04.000Z',
    actor,
    idempotencyKey: 'ir',
    artifacts: { unifiedRepositoryIr: artifact('ir-v1', 'unified-repository-ir') },
    completedCapabilities: ['symbol-index'],
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'module-proposal-produced',
    toStatus: 'awaiting-module-review',
    occurredAt: '2026-08-31T00:00:05.000Z',
    actor: { kind: 'agent', id: 'module-agent' },
    idempotencyKey: 'proposal',
    artifacts: {
      moduleDiscoveryProposal: artifact('proposal-v1', 'module-discovery-proposal'),
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-catalog-produced',
    occurredAt: '2026-08-31T00:00:06.000Z',
    actor: { kind: 'agent', id: 'module-agent' },
    idempotencyKey: 'draft-catalog',
    artifacts: { moduleCatalog: artifact('catalog-v1', 'module-catalog') },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-review-recorded',
    occurredAt: '2026-08-31T00:00:07.000Z',
    actor: { kind: 'human', id: 'architect' },
    idempotencyKey: 'module-review',
    artifacts: { moduleReview: artifact('review-v1', 'module-review') },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-catalog-produced',
    occurredAt: '2026-08-31T00:00:08.000Z',
    actor: { kind: 'system', id: 'ingestion-host' },
    idempotencyKey: 'active-catalog',
    artifacts: {
      activeModuleCatalog: artifact('catalog-active-v1', 'module-catalog'),
    },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'module-bundle-produced',
    toStatus: 'summarizing-modules',
    occurredAt: '2026-08-31T00:00:09.000Z',
    actor: { kind: 'system', id: 'ingestion-host' },
    idempotencyKey: 'module-bundle',
    artifacts: {
      moduleBundle: artifact('module-bundle-v1', 'repository-module-bundle'),
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-evidence-bundle-produced',
    occurredAt: '2026-08-31T00:00:10.000Z',
    actor: { kind: 'system', id: 'ingestion-host' },
    idempotencyKey: 'module-evidence',
    artifacts: {
      moduleEvidenceBundles: [artifact(
        'module-evidence-orders-v1',
        'repository-module-evidence-bundle',
      )],
    },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'module-wiki-proposal-produced',
    toStatus: 'awaiting-summary-review',
    occurredAt: '2026-08-31T00:00:11.000Z',
    actor: { kind: 'agent', id: 'module-summary-agent' },
    idempotencyKey: 'module-wiki-proposal',
    artifacts: {
      moduleWikiProposals: [artifact(
        'module-wiki-proposal-orders-v1',
        'repository-module-wiki-proposal',
      )],
    },
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'module-knowledge-review-recorded',
    toStatus: 'publishing-knowledge',
    occurredAt: '2026-08-31T00:00:12.000Z',
    actor: { kind: 'human', id: 'knowledge-reviewer' },
    idempotencyKey: 'module-knowledge-review',
    artifacts: {
      moduleKnowledgeReviews: [artifact(
        'module-knowledge-review-orders-v1',
        'repository-module-knowledge-review',
      )],
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'knowledge-artifact-produced',
    occurredAt: '2026-08-31T00:00:13.000Z',
    actor: { kind: 'system', id: 'knowledge-publisher' },
    idempotencyKey: 'knowledge',
    artifacts: {
      knowledge: [
        knowledge('orders-json', 'json', 'repository-wiki', '.forexplore/modules/orders/summary.json'),
        knowledge('orders-markdown', 'markdown', 'repository-wiki', '.forexplore/modules/orders/summary.md'),
        knowledge('modules-jsonl', 'jsonl', 'repository-search-index', '.forexplore/modules/modules.jsonl'),
        knowledge('summary-schema', 'json-schema', 'repository-wiki', '.forexplore/modules/summary.schema.json'),
        knowledge('module-log', 'log', 'analysis-log', '.forexplore/modules/log.md'),
      ],
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'knowledge-publication-staged',
    occurredAt: '2026-08-31T00:00:14.000Z',
    actor,
    idempotencyKey: 'publication-staged',
    artifacts: {
      knowledgePublications: [artifact(
        'publication-staged-v1',
        'repository-knowledge-publication',
      )],
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-index-receipt-produced',
    occurredAt: '2026-08-31T00:00:15.000Z',
    actor,
    idempotencyKey: 'module-index-receipts',
    artifacts: {
      moduleIndexReceipts: [
        artifact('index-receipt-staged-v1', 'repository-module-index-receipt'),
        artifact('index-receipt-validated-v1', 'repository-module-index-receipt'),
      ],
    },
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'knowledge-publication-activated',
    occurredAt: '2026-08-31T00:00:16.000Z',
    actor,
    idempotencyKey: 'publication-active',
    artifacts: {
      knowledgePublications: [artifact(
        'publication-active-v1',
        'repository-knowledge-publication',
      )],
      moduleIndexReceipts: [artifact(
        'index-receipt-active-v1',
        'repository-module-index-receipt',
      )],
      publicationHeads: [artifact(
        'publication-head-v1',
        'repository-knowledge-publication-head',
      )],
    },
  });
  return transitionRepositoryIngestionManifest(manifest, {
    type: 'ingestion-completed',
    toStatus: 'ready',
    occurredAt: '2026-08-31T00:00:17.000Z',
    actor,
    idempotencyKey: 'complete',
  });
}

describe('repository ingestion lifecycle', () => {
  it('creates a canonical queued manifest with an append-only request event', () => {
    const manifest = initial();

    expect(manifest.status).toBe('queued');
    expect(manifest.requestedCapabilities).toEqual(['repository-profile', 'symbol-index']);
    expect(manifest.events).toEqual([expect.objectContaining({
      sequence: 1,
      type: 'ingestion-requested',
      toStatus: 'queued',
    })]);
    expect(() => validateRepositoryIngestionManifest(manifest)).not.toThrow();
    expect(JSON.parse(serializeRepositoryIngestionManifest(manifest))).toEqual(manifest);
  });

  it('advances through full initialization and requires the complete wiki bundle before ready', () => {
    const manifest = readyManifest();

    expect(manifest.status).toBe('ready');
    expect(manifest.completedCapabilities).toEqual(['repository-profile', 'symbol-index']);
    expect(manifest.artifacts.knowledge.map((item) => item.format).sort()).toEqual([
      'json', 'json-schema', 'jsonl', 'log', 'markdown',
    ]);
    expect(manifest.artifacts.moduleCatalog?.id).toBe('catalog-v1');
    expect(manifest.artifacts.activeModuleCatalog?.id).toBe('catalog-active-v1');
    expect(manifest.artifacts.moduleReview?.id).toBe('review-v1');
    expect(manifest.artifacts.moduleBundle?.id).toBe('module-bundle-v1');
    expect(manifest.artifacts.moduleEvidenceBundles).toHaveLength(1);
    expect(manifest.artifacts.moduleWikiProposals).toHaveLength(1);
    expect(manifest.artifacts.moduleKnowledgeReviews).toHaveLength(1);
    expect(manifest.artifacts.knowledgePublications).toHaveLength(2);
    expect(manifest.artifacts.moduleIndexReceipts).toHaveLength(3);
    expect(manifest.artifacts.publicationHeads).toHaveLength(1);
    expect(manifest.events.map((event) => event.sequence)).toEqual(
      manifest.events.map((_event, index) => index + 1),
    );
    expect(manifest.completedAt).toBe('2026-08-31T00:00:17.000Z');
    expect(selectCurrentRepositoryModuleSummaryArtifactRefs(manifest)).toMatchObject({
      evidenceBundles: [{ id: 'module-evidence-orders-v1' }],
      wikiProposals: [{ id: 'module-wiki-proposal-orders-v1' }],
      knowledgeReviews: [{ id: 'module-knowledge-review-orders-v1' }],
    });
    expect(selectCurrentRepositoryKnowledgePublicationArtifactRefs(manifest)).toMatchObject({
      publications: [{ id: 'publication-active-v1' }],
      indexReceipts: [{ id: 'index-receipt-active-v1' }],
      publicationHeads: [{ id: 'publication-head-v1' }],
    });
    expect(() => validateRepositoryIngestionManifest(manifest)).not.toThrow();
  });

  it('replays the same event idempotently and rejects a conflicting key reuse', () => {
    const queued = initial();
    const update = {
      type: 'ingestion-started' as const,
      toStatus: 'profiling' as const,
      occurredAt: '2026-08-31T00:00:01.000Z',
      actor,
      idempotencyKey: 'start',
      message: 'Start profiling.',
    };
    const started = transitionRepositoryIngestionManifest(queued, update);

    expect(transitionRepositoryIngestionManifest(started, update)).toBe(started);
    expect(() => transitionRepositoryIngestionManifest(started, {
      ...update,
      message: 'Different command with the same key.',
    })).toThrow('idempotency key was reused');
  });

  it('does not treat a compensated activation as the current ready closure', () => {
    const ready = readyManifest();
    expect(() => recordRepositoryIngestionEvent(ready, {
      type: 'knowledge-publication-withdrawn',
      occurredAt: '2026-08-31T00:00:18.000Z',
      actor,
      idempotencyKey: 'compensated-activation',
      artifacts: {
        knowledgePublications: [artifact(
          'publication-withdrawn-v1',
          'repository-knowledge-publication',
        )],
        moduleIndexReceipts: [artifact(
          'index-receipt-withdrawn-v1',
          'repository-module-index-receipt',
        )],
      },
      details: { failure: 'remote activation failed', restoredPublicationId: null },
    })).toThrow('complete boundary, summary-review, publication, index, and active-head closure');
  });

  it('rejects skipped states and incomplete ready publication', () => {
    expect(canTransitionRepositoryIngestionStatus('queued', 'analyzing')).toBe(false);
    expect(() => transitionRepositoryIngestionManifest(initial(), {
      type: 'status-changed',
      toStatus: 'analyzing',
      occurredAt: '2026-08-31T00:00:01.000Z',
      actor,
      idempotencyKey: 'skip-profile',
    })).toThrow('cannot transition from queued to analyzing');

    let manifest = transitionRepositoryIngestionManifest(initial(), {
      type: 'ingestion-started',
      toStatus: 'profiling',
      occurredAt: '2026-08-31T00:00:01.000Z',
      actor,
      idempotencyKey: 'start',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      toStatus: 'analyzing',
      occurredAt: '2026-08-31T00:00:02.000Z',
      actor,
      idempotencyKey: 'analyze',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      toStatus: 'merging',
      occurredAt: '2026-08-31T00:00:03.000Z',
      actor,
      idempotencyKey: 'merge',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      toStatus: 'discovering-modules',
      occurredAt: '2026-08-31T00:00:04.000Z',
      actor,
      idempotencyKey: 'discover',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      toStatus: 'awaiting-module-review',
      occurredAt: '2026-08-31T00:00:05.000Z',
      actor,
      idempotencyKey: 'review',
    });
    expect(() => transitionRepositoryIngestionManifest(manifest, {
      type: 'ingestion-completed',
      toStatus: 'ready',
      occurredAt: '2026-08-31T00:00:06.000Z',
      actor,
      idempotencyKey: 'complete',
    })).toThrow('cannot transition from awaiting-module-review to ready');

    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'module-bundle-produced',
      toStatus: 'summarizing-modules',
      occurredAt: '2026-08-31T00:00:06.000Z',
      actor,
      idempotencyKey: 'summarize',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'module-wiki-proposal-produced',
      toStatus: 'awaiting-summary-review',
      occurredAt: '2026-08-31T00:00:07.000Z',
      actor,
      idempotencyKey: 'summary-review',
    });
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'module-knowledge-review-recorded',
      toStatus: 'publishing-knowledge',
      occurredAt: '2026-08-31T00:00:08.000Z',
      actor,
      idempotencyKey: 'publish',
    });
    expect(() => transitionRepositoryIngestionManifest(manifest, {
      type: 'ingestion-completed',
      toStatus: 'ready',
      occurredAt: '2026-08-31T00:00:09.000Z',
      actor,
      idempotencyKey: 'complete-after-gates',
    })).toThrow('complete boundary, summary-review, publication, index, and active-head closure');
  });

  it('requires a base for incremental runs and structured evidence for failure', () => {
    expect(() => createRepositoryIngestionManifest({
      id: 'incremental-v2',
      repositoryId: 'repository-orders',
      mode: 'incremental',
      repositoryContentHash: 'a'.repeat(64),
      requestedCapabilities: ['symbol-index'],
      analysisAdapters: [adapter],
      requestedAt: start,
      actor,
    })).toThrow('base manifest');

    expect(() => transitionRepositoryIngestionManifest(initial(), {
      type: 'ingestion-failed',
      toStatus: 'failed',
      occurredAt: '2026-08-31T00:00:01.000Z',
      actor,
      idempotencyKey: 'failed',
    })).toThrow('structured failure evidence');

    const failed = transitionRepositoryIngestionManifest(initial(), {
      type: 'ingestion-failed',
      toStatus: 'failed',
      occurredAt: '2026-08-31T00:00:01.000Z',
      actor,
      idempotencyKey: 'failed',
      failure: {
        code: 'ADAPTER_UNAVAILABLE',
        message: 'Java analysis adapter is unavailable.',
        retryable: true,
        failedStage: 'queued',
      },
    });
    expect(failed.failure?.code).toBe('ADAPTER_UNAVAILABLE');
  });

  it('detects event-log tampering during deterministic validation', () => {
    const manifest = readyManifest();
    const tampered = {
      ...manifest,
      events: manifest.events.map((event, index) =>
        index === 2 ? { ...event, sequence: 99 } : event,
      ),
    };

    expect(() => validateRepositoryIngestionManifest(tampered)).toThrow('sequence is not contiguous');
  });

  it('does not let artifact presence bypass the reviewed publication event gate', () => {
    const manifest = readyManifest();
    const tampered = {
      ...manifest,
      events: manifest.events.map((event) =>
        event.type === 'module-review-recorded'
          ? { ...event, type: 'status-changed' as const }
          : event,
      ),
    };

    expect(() => validateRepositoryIngestionManifest(tampered))
      .toThrow('requires boundary, summary review, staged index, and activation events');
  });

  it('does not count draft-sourced JSON or Markdown as reviewed ready evidence', () => {
    const manifest = readyManifest();
    const tampered = {
      ...manifest,
      artifacts: {
        ...manifest.artifacts,
        knowledge: manifest.artifacts.knowledge.map((item) =>
          item.format === 'json' || item.format === 'markdown'
            ? { ...item, sourceArtifactIds: ['catalog-v1'] }
            : item,
        ),
      },
    };

    expect(() => validateRepositoryIngestionManifest(tampered))
      .toThrow('lacks required knowledge format: json');
  });
});
