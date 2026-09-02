import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
} from '@forexplore/contracts';
import { materializeRepositoryModuleIndexReceipt } from '@forexplore/workflow-core';
import {
  RepositoryKnowledgePublicationStore,
  repositoryKnowledgeCurrentProjectionPath,
  repositoryKnowledgePublicationRoot,
} from './repository-knowledge-publication-store';
import {
  SqliteRepositoryKnowledgePublicationRegistry,
  repositoryKnowledgeRegistryDatabasePath,
} from './repository-knowledge-publication-registry';

const roots: string[] = [];
const scope: RepositoryKnowledgePublicationScope = {
  repositoryId: 'repository://orders',
  channel: 'main',
};
const repositoryScopes = [scope.repositoryId];
const producer = {
  kind: 'knowledge-publisher' as const,
  id: 'test-publication-host',
  version: '1.0.0',
};
const source = {
  repositoryModuleBundleId: 'bundle:orders',
  repositoryModuleBundleHash: '1'.repeat(64),
  modules: [{
    moduleId: 'orders',
    evidenceBundleId: 'evidence:orders',
    evidenceBundleHash: '2'.repeat(64),
    wikiProposalId: 'wiki:orders',
    wikiProposalHash: '3'.repeat(64),
    knowledgeReviewId: 'knowledge-review:orders',
    knowledgeReviewHash: '4'.repeat(64),
    knowledgePageId: 'knowledge-page:orders',
    knowledgePageHash: '5'.repeat(64),
  }],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-publication-store-'));
  roots.push(root);
  return root;
}

function artifact(content: string) {
  return {
    id: `summary:${content}`,
    kind: 'repository-wiki' as const,
    relativePath: 'wiki/orders/summary.json',
    mediaType: 'application/json',
    content,
  };
}

function receipt(publication: RepositoryKnowledgePublication, updatedAt: string) {
  return materializeRepositoryModuleIndexReceipt({
    publication,
    status: 'validated',
    storeId: 'test-module-index',
    documentCount: 1,
    moduleIds: ['orders'],
    indexArtifactHash: 'a'.repeat(64),
    createdAt: publication.stagedAt,
    updatedAt,
  });
}

describe('repository knowledge publication control-plane', () => {
  it('reuses the same staged or active canonical payload but never resurrects a withdrawn publication', async () => {
    const root = await repository();
    const storeOne = new RepositoryKnowledgePublicationStore();
    const storeTwo = new RepositoryKnowledgePublicationStore();
    const stageInput = {
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":"retry"}\n')],
      producer,
      stagedAt: '2026-09-01T08:00:00.000Z',
    };
    const [first, retry] = await Promise.all([
      storeOne.stage(stageInput),
      storeTwo.stage(stageInput),
    ]);
    expect(retry).toEqual(first);
    expect((await storeOne.read(root, scope)).publications).toHaveLength(1);

    const active = await storeOne.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T08:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T08:01:00.000Z',
    });
    await expect(storeTwo.stage(stageInput)).resolves.toEqual(active.publication);
    await expect(storeTwo.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T08:00:30.000Z'),
      expectedHead: active.head!,
      activatedAt: '2026-09-01T08:01:30.000Z',
    })).resolves.toEqual(active);
    const withdrawn = await storeOne.withdraw({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: active.indexReceipt,
      expectedHead: active.head!,
      reason: 'Exercise explicit withdrawal semantics.',
      withdrawnAt: '2026-09-01T08:02:00.000Z',
    });
    await expect(storeTwo.withdraw({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: active.indexReceipt,
      expectedHead: active.head!,
      reason: 'Retry the same explicit withdrawal.',
      withdrawnAt: '2026-09-01T08:03:00.000Z',
    })).resolves.toEqual(withdrawn);
    const replacement = await storeTwo.stage(stageInput);
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.generation).toBe(2);
  });

  it('uses a real SQLite registry and activates only through an exact head CAS', async () => {
    const root = await repository();
    const store = new RepositoryKnowledgePublicationStore({
      now: () => '2026-09-01T10:00:00.000Z',
    });
    const first = await store.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"module":"orders-v1"}\n')],
      producer,
    });
    const firstActivation = await store.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T10:01:00.000Z',
    });

    const bytes = await readFile(repositoryKnowledgeRegistryDatabasePath(root));
    expect(bytes.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
    expect(firstActivation.publication.status).toBe('active');
    expect(firstActivation.currentProjectionSynchronized).toBe(true);
    await expect(store.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T10:02:00.000Z'),
      expectedHead: null,
    })).rejects.toThrow('compare-and-swap conflict');

    const current = JSON.parse(await readFile(
      path.join(root, ...repositoryKnowledgeCurrentProjectionPath(scope).split('/')),
      'utf8',
    )) as { head: RepositoryKnowledgePublicationHead };
    expect(current.head).toEqual(firstActivation.head);
  });

  it('serializes concurrent writers and rejects a stale activation without moving the head', async () => {
    const root = await repository();
    const registryOne = new SqliteRepositoryKnowledgePublicationRegistry();
    const registryTwo = new SqliteRepositoryKnowledgePublicationRegistry();
    const storeOne = new RepositoryKnowledgePublicationStore({ registry: registryOne });
    const storeTwo = new RepositoryKnowledgePublicationStore({ registry: registryTwo });
    const [first, second] = await Promise.all([
      storeOne.stage({
        repositoryRoot: root,
        scope,
        repositoryScopes,
        source,
        artifacts: [artifact('{"version":1}\n')],
        producer,
        stagedAt: '2026-09-01T10:00:00.000Z',
      }),
      storeTwo.stage({
        repositoryRoot: root,
        scope,
        repositoryScopes,
        source,
        artifacts: [artifact('{"version":2}\n')],
        producer,
        stagedAt: '2026-09-01T10:00:01.000Z',
      }),
    ]);
    expect(new Set([first.generation, second.generation])).toEqual(new Set([1, 2]));

    const activated = await storeOne.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T10:01:00.000Z',
    });
    await expect(storeTwo.activate({
      repositoryRoot: root,
      scope,
      publicationId: second.id,
      indexReceipt: receipt(second, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T10:01:01.000Z',
    })).rejects.toThrow('compare-and-swap conflict');
    const snapshot = await storeOne.read(root, scope);
    expect(snapshot.head).toEqual(activated.head);
    expect(snapshot.publications.find((item) => item.id === second.id)?.status).toBe('staged');
  });

  it('does not reuse an equivalent staged generation after another writer advances the head', async () => {
    const root = await repository();
    const store = new RepositoryKnowledgePublicationStore();
    const retryInput = {
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":"stale-retry"}\n')],
      producer,
      stagedAt: '2026-09-01T10:00:00.000Z',
    };
    const stale = await store.stage(retryInput);
    const winner = await store.stage({
      ...retryInput,
      artifacts: [artifact('{"version":"winner"}\n')],
      stagedAt: '2026-09-01T10:00:01.000Z',
    });
    const activeWinner = await store.activate({
      repositoryRoot: root,
      scope,
      publicationId: winner.id,
      indexReceipt: receipt(winner, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T10:01:00.000Z',
    });

    const retried = await store.stage(retryInput);
    expect(retried.id).not.toBe(stale.id);
    expect(retried.generation).toBe(3);
    expect(retried.previousPublicationId).toBe(activeWinner.publication.id);
  });

  it('keeps immutable history and restores the predecessor when the current publication is withdrawn', async () => {
    const root = await repository();
    const store = new RepositoryKnowledgePublicationStore();
    const first = await store.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":1}\n')],
      producer,
      stagedAt: '2026-09-01T10:00:00.000Z',
    });
    const activeFirst = await store.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T10:01:00.000Z',
    });
    const second = await store.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":2}\n')],
      producer,
      stagedAt: '2026-09-01T10:02:00.000Z',
    });
    const activeSecond = await store.activate({
      repositoryRoot: root,
      scope,
      publicationId: second.id,
      indexReceipt: receipt(second, '2026-09-01T10:02:30.000Z'),
      expectedHead: activeFirst.head!,
      activatedAt: '2026-09-01T10:03:00.000Z',
    });
    const withdrawn = await store.withdraw({
      repositoryRoot: root,
      scope,
      publicationId: second.id,
      indexReceipt: activeSecond.indexReceipt,
      expectedHead: activeSecond.head!,
      reason: 'Rollback after production review.',
      withdrawnAt: '2026-09-01T10:04:00.000Z',
    });

    expect(withdrawn.publication.status).toBe('withdrawn');
    expect(withdrawn.restoredPublication).toEqual(expect.objectContaining({
      id: first.id,
      status: 'active',
      generation: 1,
    }));
    expect(withdrawn.head?.publicationId).toBe(first.id);
    const snapshot = await store.read(root, scope);
    expect(snapshot.head?.publicationId).toBe(first.id);
    expect(snapshot.publications.find((item) => item.id === second.id)?.status).toBe('withdrawn');

    for (const publication of snapshot.publications) {
      const statePath = path.join(
        root,
        ...repositoryKnowledgePublicationRoot(publication.id).split('/'),
        'states',
        `${publication.contentHash}.json`,
      );
      await expect(stat(statePath)).resolves.toBeDefined();
    }
    await expect(stat(path.join(root, ...first.artifacts[0]!.path!.split('/')))).resolves.toBeDefined();
  });

  it('keeps the previous current view intact on projection failure and reconciles from SQLite', async () => {
    const root = await repository();
    const registry = new SqliteRepositoryKnowledgePublicationRegistry();
    const healthyStore = new RepositoryKnowledgePublicationStore({ registry });
    const first = await healthyStore.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":1}\n')],
      producer,
      stagedAt: '2026-09-01T09:00:00.000Z',
    });
    const activeFirst = await healthyStore.activate({
      repositoryRoot: root,
      scope,
      publicationId: first.id,
      indexReceipt: receipt(first, '2026-09-01T09:00:30.000Z'),
      expectedHead: null,
      activatedAt: '2026-09-01T09:01:00.000Z',
    });
    const second = await healthyStore.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":2}\n')],
      producer,
      stagedAt: '2026-09-01T10:00:00.000Z',
    });
    const projectionWriter = vi.fn(async () => {
      throw new Error('injected projection failure');
    });
    const failingStore = new RepositoryKnowledgePublicationStore({
      registry,
      publishCurrentProjection: projectionWriter,
    });
    const activated = await failingStore.activate({
      repositoryRoot: root,
      scope,
      publicationId: second.id,
      indexReceipt: receipt(second, '2026-09-01T10:00:30.000Z'),
      expectedHead: activeFirst.head!,
      activatedAt: '2026-09-01T10:01:00.000Z',
    });
    expect(activated.currentProjectionSynchronized).toBe(false);
    expect((await failingStore.read(root, scope)).currentProjectionDirty).toBe(true);

    const projectionPath = path.join(
      root,
      ...repositoryKnowledgeCurrentProjectionPath(scope).split('/'),
    );
    const staleProjection = JSON.parse(await readFile(projectionPath, 'utf8')) as {
      head: RepositoryKnowledgePublicationHead;
    };
    expect(staleProjection.head.publicationId).toBe(first.id);

    await expect(healthyStore.reconcileCurrentProjection(root, scope)).resolves.toBe(true);
    expect((await healthyStore.read(root, scope)).currentProjectionDirty).toBe(false);
    const current = JSON.parse(await readFile(projectionPath, 'utf8')) as {
      head: RepositoryKnowledgePublicationHead;
    };
    expect(current.head.publicationId).toBe(second.id);
  });

  it('refuses activation after immutable publication bytes are modified', async () => {
    const root = await repository();
    const store = new RepositoryKnowledgePublicationStore();
    const staged = await store.stage({
      repositoryRoot: root,
      scope,
      repositoryScopes,
      source,
      artifacts: [artifact('{"version":1}\n')],
      producer,
      stagedAt: '2026-09-01T10:00:00.000Z',
    });
    const summaryPath = path.join(root, ...staged.artifacts[0]!.path!.split('/'));
    await writeFile(summaryPath, '{"tampered":true}\n', 'utf8');
    await expect(store.activate({
      repositoryRoot: root,
      scope,
      publicationId: staged.id,
      indexReceipt: receipt(staged, '2026-09-01T10:00:30.000Z'),
      expectedHead: null,
    })).rejects.toThrow('artifact hash mismatch');
    expect((await store.read(root, scope)).head).toBeUndefined();
  });
});
