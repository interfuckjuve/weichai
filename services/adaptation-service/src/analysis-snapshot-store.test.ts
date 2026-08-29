import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyzeRepository,
  writeRepositoryAnalysisArtifact,
} from '@forexplore/code-indexer';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store';

const temporaryRoots: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-snapshot-store-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSource(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('FileStaticAnalysisSnapshotStore', () => {
  it('refuses sidecars whose static evidence was modified after indexing', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });
    const artifactPath = await writeRepositoryAnalysisArtifact(root, analysis);
    const store = new FileStaticAnalysisSnapshotStore({
      analysisRoot: path.join(root, '.forexplore', 'analysis'),
    });
    await expect(store.getSnapshot(analysis.snapshotId)).resolves.toEqual(analysis);

    const original = await readFile(artifactPath, 'utf8');
    const symbol = analysis.symbols.find((entry) => entry.name === 'Service');
    const dependency = analysis.dependencies.find((entry) => entry.kind === 'import');
    const diagnostic = analysis.diagnostics[0];
    if (!symbol || !dependency || !diagnostic) {
      throw new Error('Expected fixture static evidence for tamper test.');
    }

    const tamperCases: Array<{
      mutate: (artifact: typeof analysis) => void;
      name: string;
    }> = [
      {
        name: 'symbol',
        mutate: (artifact) => {
          const target = artifact.symbols.find((entry) => entry.id === symbol.id);
          if (!target) throw new Error('Expected symbol in persisted artifact.');
          target.qualifiedName = 'sample.TamperedService';
        },
      },
      {
        name: 'edge',
        mutate: (artifact) => {
          const target = artifact.dependencies.find((entry) => entry.id === dependency.id);
          if (!target) throw new Error('Expected dependency edge in persisted artifact.');
          target.evidence = target.evidence === 'semantic' ? 'syntactic' : 'semantic';
        },
      },
      {
        name: 'diagnostic',
        mutate: (artifact) => {
          const target = artifact.diagnostics.find((entry) => entry.id === diagnostic.id);
          if (!target) throw new Error('Expected diagnostic in persisted artifact.');
          target.code = 'TAMPERED_DIAGNOSTIC';
        },
      },
    ];

    for (const tamper of tamperCases) {
      const altered = JSON.parse(original) as typeof analysis;
      tamper.mutate(altered);
      await writeFile(artifactPath, `${JSON.stringify(altered, null, 2)}\n`, 'utf8');
      await expect(store.getSnapshot(analysis.snapshotId))
        .rejects
        .toThrow(/content hash/i);
    }
  });
});
