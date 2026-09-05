import type {
  AnalysisRevisionRecord,
  ModuleArtifactRecord,
  RepositoryRecord,
  StructuralIndex,
} from '@forexplore/contracts';
import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { AnalysisCoordinator, type StructuralScanner } from './analysis-coordinator.js';
import { InMemoryIndexStore } from './index-store.js';
import { RepositoryRegistry } from './repository-registry.js';
import { SeekDbIndexStore } from './seekdb-index-store.js';
import { SeekDbProjection } from './seekdb-projection.js';

const hash = (character: string): string => character.repeat(64);
const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

function repository(repositoryId = 'history-one'): RepositoryRecord {
  return {
    repositoryId,
    displayName: repositoryId,
    localPath: `C:/registered/${repositoryId}`,
    role: 'history',
    analysisStatus: 'registered',
    activeRevision: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
}

function structural(
  repositoryId = 'history-one',
  analysisRevision = 'revision-one',
  analysisHash = hash('a'),
): StructuralIndex {
  const projectId = `project-${analysisRevision}`;
  const fileId = `file-${analysisRevision}`;
  const symbolKey = `symbol:${analysisRevision}:Example`;
  return {
    repositoryId,
    analysisRevision,
    analysisHash,
    projects: [{
      repositoryId,
      analysisRevision,
      projectId,
      kind: 'node',
      displayName: 'example',
      relativePath: '',
      manifestPaths: ['package.json'],
      sourceRoots: ['src'],
      testRoots: ['test'],
      languageIds: ['typescript'],
    }],
    files: [{
      repositoryId,
      analysisRevision,
      fileId,
      relativePath: 'src/example.ts',
      languageId: 'typescript',
      role: 'source',
      sha256: hash('b'),
      sizeBytes: 23,
      parseStatus: 'parsed',
      projectId,
    }],
    symbols: [{
      repositoryId,
      analysisRevision,
      symbolId: `symbol-${analysisRevision}`,
      symbolKey,
      astDeclarationId: `ast:${analysisRevision}:Example`,
      name: 'Example',
      qualifiedName: `example.${analysisRevision}.Example`,
      kind: 'class',
      languageId: 'typescript',
      relativePath: 'src/example.ts',
      sourceRange: range,
      projectId,
      exported: true,
      provider: 'tree-sitter',
      confidence: 1,
      evidenceLevel: 'structural',
    }],
    dependencyEdges: [],
    diagnostics: [],
  };
}

function readyRevision(index: StructuralIndex): AnalysisRevisionRecord {
  return {
    repositoryId: index.repositoryId,
    analysisRevision: index.analysisRevision,
    status: 'ready',
    analysisHash: index.analysisHash,
    indexerVersion: 'test',
    createdAt: '2026-09-04T00:00:00.000Z',
    completedAt: '2026-09-04T00:00:01.000Z',
  };
}

async function persistReady(store: InMemoryIndexStore, index: StructuralIndex): Promise<void> {
  const ready = readyRevision(index);
  await store.putRevision({ ...ready, status: 'building', completedAt: undefined });
  await store.putStructuralIndex(index, new Map([['src/example.ts', 'export class Example {}\n']]));
  await store.putRevision(ready);
}

describe('revision store hardening', () => {
  it('accepts only a single building-to-terminal lifecycle and never rewrites a completed revision', async () => {
    const store = new InMemoryIndexStore();
    const index = structural();
    await store.putRepository(repository());

    await expect(store.putRevision(readyRevision(index))).rejects.toThrow('created in the building state');
    await persistReady(store, index);
    await expect(store.putRevision({
      ...readyRevision(index),
      analysisHash: hash('c'),
    })).rejects.toThrow('immutable');

    const persisted = await store.getRevision(index);
    expect(persisted).toMatchObject({ status: 'ready', analysisHash: hash('a') });

    const failedIndex = structural(index.repositoryId, 'failed-once', hash('d'));
    const failed = readyRevision(failedIndex);
    await store.putRevision({ ...failed, status: 'building', completedAt: undefined });
    await store.putRevision({
      ...failed,
      status: 'failed',
      failureReason: 'intentional failure',
    });
    await expect(store.putRevision(failed)).rejects.toThrow('immutable');
  });

  it('records a failed lifecycle without replacing the prior active revision, and rejects a generated-ID collision before scanning', async () => {
    const store = new InMemoryIndexStore();
    await store.putRepository(repository());
    const active = structural();
    await persistReady(store, active);
    await store.activateRevision(active);
    const registry = new RepositoryRegistry(store, {
      resolveLocalPath: async (value) => value,
      clock: { now: () => '2026-09-04T00:00:02.000Z' },
    });
    const collisionScanner: StructuralScanner = { scan: vi.fn() };
    const collision = new AnalysisCoordinator(registry, store, collisionScanner, new SeekDbProjection(store), {
      revisionIdGenerator: () => active.analysisRevision,
      indexerVersion: 'test',
    });
    await expect(collision.run({ repositoryId: active.repositoryId })).rejects.toThrow('already exists');
    expect(collisionScanner.scan).not.toHaveBeenCalled();
    expect((await store.getRepository(active.repositoryId))?.analysisStatus).toBe('ready');
    expect(await store.getRevision(active)).toMatchObject({ status: 'ready', analysisHash: active.analysisHash });

    const scanner: StructuralScanner = {
      scan: vi.fn(async () => {
        throw new Error('scanner failed');
      }),
    };
    const coordinator = new AnalysisCoordinator(registry, store, scanner, new SeekDbProjection(store), {
      revisionIdGenerator: () => 'failed-revision',
      clock: { now: () => '2026-09-04T00:00:03.000Z' },
      indexerVersion: 'test',
    });

    await expect(coordinator.run({ repositoryId: active.repositoryId })).rejects.toThrow('scanner failed');
    expect(await store.getRevision({ repositoryId: active.repositoryId, analysisRevision: 'failed-revision' }))
      .toMatchObject({ status: 'failed' });
    expect((await store.getRepository(active.repositoryId))?.activeRevision).toBe(active.analysisRevision);
  });

  it('rejects malformed structural child paths/source text before replacing the revision contents', async () => {
    const store = new InMemoryIndexStore();
    const index = structural();
    await store.putRepository(repository());
    await store.putRevision({ ...readyRevision(index), status: 'building', completedAt: undefined });

    await expect(store.putStructuralIndex({
      ...index,
      symbols: [{ ...index.symbols[0]!, relativePath: 'C:/outside.ts' }],
    })).rejects.toThrow('repository-relative');
    await expect(store.putStructuralIndex(index, new Map([['../outside.ts', 'nope']])))
      .rejects.toThrow('repository-relative');
    expect(await store.getStructuralIndex(index)).toBeNull();
  });

  it('requires a bound planHash and an active ready revision before publishing a current module summary', async () => {
    const store = new InMemoryIndexStore();
    const index = structural();
    await store.putRepository(repository());
    await persistReady(store, index);
    const base: ModuleArtifactRecord = {
      repositoryId: index.repositoryId,
      analysisRevision: index.analysisRevision,
      moduleArtifactId: 'summary-one',
      kind: 'module-summary',
      status: 'current',
      analysisHash: index.analysisHash,
      contentHash: hash('d'),
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      payload: { title: 'summary' },
    };
    await expect(store.putModuleArtifact(base)).rejects.toThrow('planHash');
    await expect(store.putModuleArtifact({ ...base, planHash: hash('e') }))
      .rejects.toThrow('active analysis revision');

    await store.activateRevision(index);
    await store.putModuleArtifact({ ...base, planHash: hash('e') });
    await new SeekDbProjection(store).projectModuleArtifacts(index);
    expect((await store.listSearchDocuments(index)).some((document) => document.kind === 'summary')).toBe(true);

    const replacement = structural(index.repositoryId, 'revision-two', hash('f'));
    await persistReady(store, replacement);
    await store.activateRevision(replacement);
    expect((await store.listModuleArtifacts(index))[0]?.status).toBe('stale');
    expect((await store.listSearchDocuments(index)).some((document) => document.kind === 'summary')).toBe(false);
  });
});

describe('SeekDbIndexStore pre-write validation', () => {
  it('rejects malformed structural and search projection input before issuing a database query', async () => {
    const query = vi.fn();
    const pool = { query, getConnection: vi.fn(), end: vi.fn() } as unknown as Pool;
    const store = new SeekDbIndexStore({
      host: 'localhost',
      port: 2881,
      user: 'root',
      password: '',
      database: 'code_intelligence_test',
    }, pool);
    const index = structural();

    await expect(store.putStructuralIndex({
      ...index,
      files: [{ ...index.files[0]!, repositoryId: 'other-repository' }],
    })).rejects.toThrow('supplied repository revision');
    await expect(store.replaceSearchDocuments(index, [{
      repositoryId: index.repositoryId,
      analysisRevision: index.analysisRevision,
      searchDocumentId: 'bad-doc',
      kind: 'source-fragment',
      relativePath: 'C:/outside.ts',
      contentHash: hash('f'),
      title: 'bad',
      text: 'bad',
    }])).rejects.toThrow('repository-relative');
    expect(query).not.toHaveBeenCalled();
  });
});
