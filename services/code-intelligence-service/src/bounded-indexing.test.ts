import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStructuralIndex } from '@forexplore/code-indexer';
import { InMemoryIndexStore, sliceSourceText, validateSearchDocumentsAgainstIndex } from './index-store.js';
import { createCodeIntelligenceRuntime } from './index.js';
import { seekDbProjectionInternals } from './seekdb-projection.js';
import { SeekDbIndexStore } from './seekdb-index-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

async function fixture(source: string, store = new InMemoryIndexStore()) {
  const root = await mkdtemp(path.join(tmpdir(), 'bounded-index-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), source);
  const runtime = await createCodeIntelligenceRuntime({ store });
  await runtime.registry.register({ repositoryId: 'bounded', localPath: root, role: 'target' });
  const run = await runtime.coordinator.run({ repositoryId: 'bounded' });
  return { root, runtime, store, scope: run.scope };
}

describe('bounded indexing and local reads', () => {
  it('projects a complete long implementation, including searchable tail ranges', async () => {
    const source = 'export function recoverUpload() {\n' + '  // pending upload progress\n'.repeat(1600) + '  return "tailRecoveryMarker";\n}\n';
    const { store, scope } = await fixture(source);
    const index = (await store.getStructuralIndex(scope))!;
    const fragments = (await store.listSearchDocuments(scope)).filter((document) => document.kind === 'source-fragment')
      .sort((a, b) => a.sourceRange!.startLine - b.sourceRange!.startLine || a.sourceRange!.startColumn - b.sourceRange!.startColumn);
    expect(fragments.map((document) => document.text).join('')).toBe(source);
    expect(fragments.every((document) => document.text.length <= 12000)).toBe(true);
    const hit = (await store.searchSearchDocuments(scope, 'tailRecoveryMarker', 10, 'source-fragment'))[0]!;
    expect(hit.sourceRange!.startLine).toBeGreaterThan(1000);
    const slice = await store.getSourceSlice(scope, 'main.ts', hit.sourceRange, 32000);
    expect(slice?.text).toBe(hit.text);
    expect(slice?.truncated).toBe(false);
    expect(slice?.file.sha256).toBe(index.files[0]!.sha256);
    expect(() => validateSearchDocumentsAgainstIndex(index, [{ ...hit, sourceRange: { ...hit.sourceRange!, endLine: 99999 } }], new Map(), null)).toThrow('declared symbol range');
  });

  it('keeps the previous active revision when a later projection batch fails', async () => {
    const { root, runtime, store, scope } = await fixture('export function stable() { return 1; }');
    const originalAppend = store.appendSearchDocuments.bind(store);
    let calls = 0;
    vi.spyOn(store, 'appendSearchDocuments').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('projection batch unavailable');
      await originalAppend(...args);
    });
    await writeFile(path.join(root, 'main.ts'), Array.from({ length: 350 }, (_, index) => `export function changed${index}() { return ${index}; }`).join('\n'));
    await expect(runtime.coordinator.run({ repositoryId: 'bounded' })).rejects.toThrow('projection batch unavailable');
    expect((await store.getRepository('bounded'))?.activeRevision).toBe(scope.analysisRevision);
    expect(await store.searchSearchDocuments(scope, 'stable', 10)).not.toHaveLength(0);
    expect((await store.listRevisions('bounded')).some((revision) => revision.status === 'failed')).toBe(true);
  });

  it('returns precise end-exclusive slices and marks budget truncation', () => {
    expect(sliceSourceText('first\nsecond\nthird', { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 }, 32)).toEqual({
      text: 'econd\nth', sourceRange: { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 }, truncated: false,
    });
    expect(sliceSourceText('first\nsecond', undefined, 7)).toEqual({ text: 'first\ns',
      sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 2 }, truncated: true });
    expect(sliceSourceText('only', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 }, 20)).toBeNull();
  });

  it('uses local symbol and dependency filters without whole-index reads', async () => {
    const { store, scope } = await fixture('export function first() {}\nexport function second() {}\n');
    vi.spyOn(store, 'getStructuralIndex').mockRejectedValue(new Error('unbounded read'));
    vi.spyOn(store, 'listSymbols').mockRejectedValue(new Error('unbounded read'));
    expect(await store.getStructuralIndexMetadata(scope)).toMatchObject(scope);
    expect(await store.getRevisionStatistics(scope)).toEqual({ projects: 1, files: 1, symbols: 2, dependencies: 2,
      diagnostics: 0, languages: [{ languageId: 'typescript', fileCount: 1, hasSemanticSymbols: false }] });
    const symbols = await store.querySymbols(scope, { relativePaths: ['main.ts'], kinds: ['function'], limit: 1 });
    expect(symbols.symbols).toHaveLength(1);
    expect(symbols.truncated).toBe(true);
    expect(await store.querySymbols(scope, { relativePaths: ['main.ts'], projectId: 'wrong-project', limit: 10 })).toEqual({ symbols: [], truncated: false });
    const dependencies = await store.queryDependencies(scope, { relativePaths: ['main.ts'], direction: 'outgoing', limit: 10 });
    expect(dependencies.dependencies).toHaveLength(2);
    expect(dependencies.dependencies.every((edge) => edge.kind === 'export')).toBe(true);
    expect(await store.queryDependencies(scope, { relativePaths: ['main.ts'], direction: 'incoming', limit: 10 })).toEqual({ dependencies: [], truncated: false });
    await expect(store.querySymbols(scope, { limit: 10 })).rejects.toThrow('anchors');
  });

  it('covers unsupported text as explicitly unbound chunks', () => {
    const source = '<project>' + 'dependency '.repeat(3000) + '</project>';
    const { index } = buildStructuralIndex({ repositoryId: 'xml', analysisRevision: 'one', files: [{ relativePath: 'pom.xml', content: source }] });
    const fragments = [...seekDbProjectionInternals.sourceDocuments(index, 'pom.xml', source, [])];
    expect(fragments.map((document) => document.text).join('')).toBe(source);
    expect(fragments.every((document) => document.symbolKey === undefined)).toBe(true);
  });

  it('pushes local filters, limits and source ranges into database reads', async () => {
    const query = vi.fn().mockResolvedValue([[]]);
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' },
      { query } as unknown as Pool);
    const scope = { repositoryId: 'repository', analysisRevision: 'revision' };
    await store.querySymbols(scope, { relativePaths: ['src/a.ts'], symbolKeys: ['key'], projectId: 'project', kinds: ['method'], limit: 8 });
    expect(query.mock.calls[0]![0]).toContain('symbol_key IN (?) OR relative_path IN (?)');
    expect(query.mock.calls[0]![0]).toContain('project_id = ? AND kind IN (?)');
    expect(query.mock.calls[0]![1]).toEqual(['repository', 'revision', 'key', 'src/a.ts', 'project', 'method', 9]);
    await store.queryDependencies(scope, { relativePaths: ['src/a.ts'], direction: 'incoming', limit: 4 });
    expect(query.mock.calls[1]![0]).toContain('d.target_relative_path IN (?)');
    expect(query.mock.calls[1]![1]).toEqual(['repository', 'revision', 'src/a.ts', 5]);
    query.mockResolvedValueOnce([[{ file_id: 'file', relative_path: 'src/a.ts', language_id: 'typescript', role: 'source',
      sha256: 'a'.repeat(64), size_bytes: 50, parse_status: 'parsed', project_id: 'project', source_text: 'second\nthird' }]]);
    const range = { startLine: 2, startColumn: 2, endLine: 3, endColumn: 3 };
    const slice = await store.getSourceSlice(scope, 'src/a.ts', range, 100);
    expect(query.mock.calls[2]![0]).toContain('SUBSTRING(source_text');
    expect(query.mock.calls[2]![0]).toContain('SUBSTRING_INDEX');
    expect(slice).toMatchObject({ text: 'econd\nth', sourceRange: range, truncated: false });
    expect(query.mock.calls[2]![1]).toEqual([2, 2, 103, 'repository', 'revision', 'src/a.ts', 2]);
  });

  it('fuses bounded candidate IDs before fetching source documents', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ search_document_id: 'shared', text_score: 4 }, { search_document_id: 'lexical', text_score: 3 }]])
      .mockResolvedValueOnce([[{ search_document_id: 'semantic', semantic_score: 0.9 }, { search_document_id: 'shared', semantic_score: 0.8 }]])
      .mockResolvedValueOnce([[{ search_document_id: 'shared', kind: 'source-fragment', relative_path: 'src/a.ts',
        symbol_key: null, source_range: null, module_artifact_id: null, content_hash: 'a'.repeat(64), title: 'implementation', document_text: 'actual code' }]]);
    const store = new SeekDbIndexStore({ host: 'localhost', port: 2881, user: 'root', password: '', database: 'bounded_test' }, { query } as unknown as Pool);
    const results = await store.searchSearchDocuments({ repositoryId: 'repository', analysisRevision: 'revision', projectId: 'project' }, 'matching implementation', 1, 'source-fragment');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ searchDocumentId: 'shared', text: 'actual code', retrievalScore: { lexical: 4, semantic: 0.8 } });
    expect(query.mock.calls[0]![0]).not.toContain('document_text');
    expect(query.mock.calls[0]![0]).toContain('JOIN `bounded_test`.`files` f');
    expect(query.mock.calls[0]![1]).toEqual(['matching implementation', 'project', 'repository', 'revision', 'source-fragment', 'matching implementation', 24]);
    expect(query.mock.calls[1]![0]).not.toContain('document_text');
    expect(query.mock.calls[2]![1]).toEqual(['repository', 'revision', 'shared', 1]);
  });
});
