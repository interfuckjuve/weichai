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
  it('keeps production source bytes on disk and reports files beyond the parsing limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-stream-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'small.ts'), 'export const original = 1;');
    await writeFile(path.join(root, 'large.ts'), 'x'.repeat(256));
    const result = await scanRepositoryStructuralIndex({ repositoryId: 'stream', analysisRevision: 'one', repositoryRoot: root,
      retainSourceTexts: false, isolatedParsing: true, maxFileBytes: 128 });
    try {
      expect(result.sourceFiles.size).toBe(0);
      expect(result.index.symbols.some((symbol) => symbol.name === 'original')).toBe(true);
      expect(result.stats.parserResources?.workers).toBe(1);
      expect(result.index.files.find((file) => file.relativePath === 'large.ts')).toMatchObject({ parseStatus: 'failed', sizeBytes: 256 });
      expect(result.index.diagnostics).toContainEqual(expect.objectContaining({ relativePath: 'large.ts', code: 'SOURCE_CONTENT_UNAVAILABLE' }));
      await writeFile(path.join(root, 'small.ts'), 'export const changed = 2;');
      expect(await result.sourceReader!.read('small.ts')).toBe('export const original = 1;');
      expect(await result.sourceReader!.read('large.ts')).toBeNull();
    } finally { await result.sourceReader!.dispose(); }
    await expect(result.sourceReader!.read('small.ts')).rejects.toThrow();
  });

  it('parses large Java input through bounded native input buffers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-indexer-java-'));
    temporaryRoots.push(root);
    const source = 'public class Large {\n' + Array.from({ length: 1200 }, (_, index) => `public int method${index}() { return ${index}; }`).join('\n') + '\n}';
    await writeFile(path.join(root, 'Large.java'), source);
    const result = await scanRepositoryStructuralIndex({ repositoryId: 'large-java', analysisRevision: 'one', repositoryRoot: root });
    expect(source.length).toBeGreaterThan(32768);
    expect(result.index.symbols).toHaveLength(1201);
    expect(result.index.diagnostics).toEqual([]);
  });

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
