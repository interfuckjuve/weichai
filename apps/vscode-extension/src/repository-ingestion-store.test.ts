import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  persistRepositoryIngestionArtifacts,
  readRepositoryIngestionManifest,
  readRepositoryModuleKnowledgeLog,
  repositoryIngestionManifestPath,
} from './repository-ingestion-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'forexplore-ingestion-store-'));
  roots.push(value);
  return value;
}

describe('repository ingestion artifact store', () => {
  it('creates immutable evidence and atomically updates replayable wiki views', async () => {
    const repositoryRoot = await root();
    const request = {
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [
        {
          path: '.forexplore/ingestion/ingestion-1/ir.json',
          content: '{"ir":1}\n',
          mode: 'immutable' as const,
        },
        {
          path: '.forexplore/modules/orders/summary.md',
          content: '# Orders v1\n',
          mode: 'derived' as const,
        },
      ],
    };
    await persistRepositoryIngestionArtifacts(request);
    await persistRepositoryIngestionArtifacts({
      ...request,
      artifacts: [
        request.artifacts[0]!,
        { ...request.artifacts[1]!, content: '# Orders v2\n' },
      ],
    });

    await expect(readFile(path.join(repositoryRoot, '.forexplore/ingestion/ingestion-1/ir.json'), 'utf8'))
      .resolves.toBe('{"ir":1}\n');
    await expect(readFile(path.join(repositoryRoot, '.forexplore/modules/orders/summary.md'), 'utf8'))
      .resolves.toBe('# Orders v2\n');
  });

  it('rejects conflicting create-only evidence', async () => {
    const repositoryRoot = await root();
    const artifact = {
      path: '.forexplore/ingestion/ingestion-1/ir.json',
      content: '{"ir":1}\n',
      mode: 'immutable' as const,
    };
    await persistRepositoryIngestionArtifacts({ repositoryRoot, ingestionId: 'ingestion-1', artifacts: [artifact] });
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{ ...artifact, content: '{"ir":2}\n' }],
    })).rejects.toThrow('different content');
  });

  it('updates the manifest only through a matching compare-and-swap and writes it last', async () => {
    const repositoryRoot = await root();
    const manifestPath = repositoryIngestionManifestPath('ingestion-1');
    const first = '{"status":"awaiting-module-review"}\n';
    const second = '{"status":"ready"}\n';
    const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

    await persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{ path: manifestPath, content: first, mode: 'manifest' }],
    });
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{ path: manifestPath, content: second, mode: 'manifest' }],
    })).rejects.toThrow('already exists');
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: manifestPath,
        content: second,
        mode: 'manifest',
        expectedContentHash: '0'.repeat(64),
      }],
    })).rejects.toThrow('compare-and-swap conflict');
    await persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: manifestPath,
        content: second,
        mode: 'manifest',
        expectedContentHash: hash(first),
      }],
    });
    await expect(readFile(path.join(repositoryRoot, ...manifestPath.split('/')), 'utf8'))
      .resolves.toBe(second);

    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [
        { path: manifestPath, content: second, mode: 'manifest' },
        {
          path: '.forexplore/ingestion/ingestion-1/late.json',
          content: '{}\n',
          mode: 'immutable',
        },
      ],
    })).rejects.toThrow('persisted last');
  });

  it('rejects traversal, wrong namespaces, and symbolic-link parents', async () => {
    const repositoryRoot = await root();
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{ path: '../escape.json', content: '{}', mode: 'immutable' }],
    })).rejects.toThrow('unsafe');
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{ path: '.forexplore/modules/a.json', content: '{}', mode: 'immutable' }],
    })).rejects.toThrow('must be inside');

    const outside = await root();
    const forexplore = path.join(repositoryRoot, '.forexplore');
    await symlink(outside, forexplore, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/ingestion/ingestion-1/ir.json',
        content: '{}',
        mode: 'immutable',
      }],
    })).rejects.toThrow('symbolic link');
  });

  it('keeps the knowledge timeline append-only and reads missing state safely', async () => {
    const repositoryRoot = await root();
    expect(repositoryIngestionManifestPath('ingestion-1'))
      .toBe('.forexplore/ingestion/ingestion-1/manifest.json');
    await expect(readRepositoryIngestionManifest(repositoryRoot, 'ingestion-1')).resolves.toBeNull();
    await expect(readRepositoryModuleKnowledgeLog(repositoryRoot)).resolves.toBe('');

    const first = '# Log\n\nfirst\n';
    const second = `${first}second\n`;
    await persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/modules/log.md',
        content: first,
        mode: 'append-only-derived',
      }],
    });
    await persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/modules/log.md',
        content: second,
        mode: 'append-only-derived',
      }],
    });
    await expect(readRepositoryModuleKnowledgeLog(repositoryRoot)).resolves.toBe(second);
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/modules/log.md',
        content: '# rewritten\n',
        mode: 'append-only-derived',
      }],
    })).rejects.toThrow('not append-only');
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/modules/index.md',
        content: '# invalid mode\n',
        mode: 'append-only-derived',
      }],
    })).rejects.toThrow('Only .forexplore/modules/log.md');
  });

  it('refuses a symbolic-link artifact target before reading or updating it', async () => {
    const repositoryRoot = await root();
    const outside = await root();
    const outsideFile = path.join(outside, 'secret.md');
    await writeFile(outsideFile, 'outside secret\n', 'utf8');
    const moduleRoot = path.join(repositoryRoot, '.forexplore', 'modules');
    await mkdir(moduleRoot, { recursive: true });
    try {
      await symlink(outsideFile, path.join(moduleRoot, 'log.md'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    await expect(readRepositoryModuleKnowledgeLog(repositoryRoot))
      .rejects.toThrow('artifact target is a symbolic link');
    await expect(persistRepositoryIngestionArtifacts({
      repositoryRoot,
      ingestionId: 'ingestion-1',
      artifacts: [{
        path: '.forexplore/modules/log.md',
        content: 'outside secret\nappended\n',
        mode: 'append-only-derived',
      }],
    })).rejects.toThrow('artifact target is a symbolic link');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside secret\n');
  });
});
