import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepositoryStructuralIndex } from './repository-scan.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('scanRepositoryStructuralIndex', () => {
  it('captures only indexable source/manifests beneath the registered root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-scan-'));
    temporaryRoots.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"scan-fixture"}');
    await writeFile(path.join(root, 'src', 'main.ts'), 'export class Main {}');
    await writeFile(path.join(root, 'node_modules', 'ignored', 'dependency.ts'), 'export class Ignored {}');
    await writeFile(path.join(root, '.git', 'hidden.ts'), 'export class Hidden {}');
    await writeFile(path.join(root, 'README.md'), 'not structural source');

    const result = await scanRepositoryStructuralIndex({
      repositoryId: 'history-scan',
      analysisRevision: 'scan-revision',
      repositoryRoot: root,
    });

    expect(result.index.files.map((file) => file.relativePath)).toEqual([
      'package.json',
      'src/main.ts',
    ]);
    expect(result.sourceFiles.get('src/main.ts')).toBe('export class Main {}');
    expect(result.index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Main', relativePath: 'src/main.ts' }),
    ]));
    expect([...result.sourceFiles.keys()]).not.toContain('node_modules/ignored/dependency.ts');
  });
});
