import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TargetWorkspaceHostRecord } from './target-workspace-host';
import {
  FileSystemTargetWorkspaceHostStore,
  targetWorkspaceRecordFileName,
} from './target-workspace-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStorage(): Promise<{ root: string; storageDirectory: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-target-store-'));
  roots.push(root);
  return { root, storageDirectory: path.join(root, 'records') };
}

function fixture(
  repositoryRoot: string,
  workspaceId = 'target:payments',
): TargetWorkspaceHostRecord {
  return {
    role: 'target-workspace',
    workspaceId,
    repositoryRoot,
    stage: 'analysis-partial',
    latest: {
      analysis: {
        snapshotId: 'analysis:one',
        contentHash: 'analysis-hash',
      } as TargetWorkspaceHostRecord['latest']['analysis'],
      ir: {
        id: 'ir:one',
        repositoryId: 'payments',
        repositoryContentHash: 'repository-hash',
        contentHash: 'ir-hash',
      } as TargetWorkspaceHostRecord['latest']['ir'],
    },
    readiness: {
      ready: false,
      requiredCapabilities: ['file-inventory', 'symbol-index', 'api-surface'],
      blockingIssues: [{
        code: 'NO_ANALYSABLE_SOURCE',
        message: 'No source yet.',
      }],
      missingOptionalCapabilities: ['dependency-graph'],
    },
    constraints: [{
      id: 'target-boundary',
      description: 'Keep the target boundary explicit.',
      required: true,
    }],
    failure: 'Analysis is incomplete.',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
}

describe('FileSystemTargetWorkspaceHostStore', () => {
  it('persists a Host record and reloads independent copies after restart', async () => {
    const { root, storageDirectory } = await createStorage();
    const record = fixture(root);
    const first = new FileSystemTargetWorkspaceHostStore({ storageDirectory });

    await first.save(record);
    const restarted = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const loaded = await restarted.load(record.workspaceId);

    expect(loaded).toEqual(record);
    loaded!.constraints[0]!.description = 'mutated only in memory';
    await expect(restarted.load(record.workspaceId)).resolves.toEqual(record);
  });

  it('maps arbitrary logical workspace IDs to one safe hashed filename', async () => {
    const { root, storageDirectory } = await createStorage();
    const workspaceId = '../..\\escape/客户目标仓';
    const record = fixture(root, workspaceId);
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });

    await store.save(record);

    const fileName = targetWorkspaceRecordFileName(workspaceId);
    expect(fileName).toMatch(/^target-workspace-[a-f0-9]{64}\.json$/);
    expect(await readdir(storageDirectory)).toEqual([fileName]);
    await expect(stat(path.join(root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.load(workspaceId)).resolves.toEqual(record);
  });

  it('replaces an existing record through a temp file and atomic rename', async () => {
    const { root, storageDirectory } = await createStorage();
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const record = fixture(root);
    await store.save(record);
    const updated: TargetWorkspaceHostRecord = {
      ...record,
      failure: 'A newer Host-owned result.',
      updatedAt: '2026-09-02T00:01:00.000Z',
    };

    await store.save(updated);

    await expect(store.load(record.workspaceId)).resolves.toEqual(updated);
    const entries = await readdir(storageDirectory);
    expect(entries).toEqual([targetWorkspaceRecordFileName(record.workspaceId)]);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('uses a cross-instance compare-and-swap to reject a stale writer', async () => {
    const { root, storageDirectory } = await createStorage();
    const first = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const second = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const record = fixture(root);
    await first.save(record, null);
    const expected = await first.load(record.workspaceId);
    const winner = {
      ...record,
      failure: 'winner',
      updatedAt: '2026-09-02T00:01:00.000Z',
    };
    const staleWriter = {
      ...record,
      failure: 'stale writer',
      updatedAt: '2026-09-02T00:02:00.000Z',
    };

    await second.save(winner, expected);
    await expect(first.save(staleWriter, expected)).rejects.toThrow('compare-and-swap conflict');
    await expect(first.load(record.workspaceId)).resolves.toEqual(winner);
  });

  it('allows exactly one of two concurrent cross-instance CAS writers to win', async () => {
    const { root, storageDirectory } = await createStorage();
    const first = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const second = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    const record = fixture(root);
    await first.save(record, null);
    const expected = await first.load(record.workspaceId);
    const outcomes = await Promise.allSettled([
      first.save({ ...record, failure: 'first' }, expected),
      second.save({ ...record, failure: 'second' }, expected),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('returns null only when no record exists', async () => {
    const { storageDirectory } = await createStorage();
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });

    await expect(store.load('missing-workspace')).resolves.toBeNull();
  });

  it('fails closed for corrupt JSON instead of treating it as a missing record', async () => {
    const { root, storageDirectory } = await createStorage();
    const record = fixture(root);
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    await store.save(record);
    const destination = path.join(
      storageDirectory,
      targetWorkspaceRecordFileName(record.workspaceId),
    );

    await writeFile(destination, '{broken-json', 'utf8');

    await expect(store.load(record.workspaceId)).rejects.toThrow(/not valid JSON/);
  });

  it('fails closed when a syntactically valid record is changed outside the Host', async () => {
    const { root, storageDirectory } = await createStorage();
    const record = fixture(root);
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });
    await store.save(record);
    const destination = path.join(
      storageDirectory,
      targetWorkspaceRecordFileName(record.workspaceId),
    );
    const envelope = JSON.parse(await readFile(destination, 'utf8')) as {
      record: TargetWorkspaceHostRecord;
    };
    envelope.record.repositoryRoot = path.join(root, 'tampered');
    await writeFile(destination, JSON.stringify(envelope), 'utf8');

    await expect(store.load(record.workspaceId)).rejects.toThrow(/integrity check/);
  });

  it('rejects Webview-shaped or otherwise malformed values before writing', async () => {
    const { storageDirectory } = await createStorage();
    const store = new FileSystemTargetWorkspaceHostStore({ storageDirectory });

    await expect(store.save({
      type: 'SELECT_TARGET_ENTITY',
      workspaceId: '../../outside',
      entityId: 'method:pay',
    } as unknown as TargetWorkspaceHostRecord)).rejects.toThrow(/not a target workspace Host record/);
    await expect(readdir(storageDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the Host to provide an explicit absolute storage directory', () => {
    expect(() => new FileSystemTargetWorkspaceHostStore({
      storageDirectory: 'relative/target-workspaces',
    })).toThrow(/explicit absolute path/);
  });
});
