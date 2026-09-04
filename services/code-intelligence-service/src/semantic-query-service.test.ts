import type {
  AnalysisRevisionRecord,
  ModuleArtifactRecord,
  RepositoryRecord,
  StructuralIndex,
} from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';
import { AnalysisCoordinator, type StructuralScanner } from './analysis-coordinator.js';
import { InMemoryIndexStore } from './index-store.js';
import { RepositoryRegistry } from './repository-registry.js';
import { SeekDbProjection } from './seekdb-projection.js';
import { SemanticQueryService, type SemanticProvider } from './semantic-query-service.js';

const range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 14 };

function repository(repositoryId: string): RepositoryRecord {
  return {
    repositoryId,
    displayName: repositoryId,
    localPath: `C:/host-only/${repositoryId}`,
    role: 'history',
    analysisStatus: 'registered',
    activeRevision: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  };
}

function revision(repositoryId: string, analysisRevision: string, analysisHash: string): AnalysisRevisionRecord {
  return {
    repositoryId,
    analysisRevision,
    status: 'ready',
    analysisHash,
    indexerVersion: 'test',
    createdAt: '2026-09-04T00:00:00.000Z',
    completedAt: '2026-09-04T00:00:01.000Z',
  };
}

function index(repositoryId: string, analysisRevision: string, analysisHash: string): StructuralIndex {
  const fileId = `${repositoryId}-${analysisRevision}-file`;
  const symbolKey = `symbol:${repositoryId}:${analysisRevision}:First`;
  return {
    repositoryId,
    analysisRevision,
    analysisHash,
    projects: [{
      repositoryId,
      analysisRevision,
      projectId: `${repositoryId}-${analysisRevision}-project`,
      kind: 'node',
      displayName: 'sample',
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
      relativePath: 'src/first.ts',
      languageId: 'typescript',
      role: 'source',
      sha256: 'a'.repeat(64),
      sizeBytes: 15,
      parseStatus: 'parsed',
      projectId: `${repositoryId}-${analysisRevision}-project`,
    }],
    symbols: [{
      repositoryId,
      analysisRevision,
      symbolId: `${repositoryId}-${analysisRevision}-symbol`,
      symbolKey,
      astDeclarationId: `ast:${repositoryId}:${analysisRevision}:First`,
      name: 'First',
      qualifiedName: `sample.${repositoryId}.First`,
      kind: 'class',
      languageId: 'typescript',
      relativePath: 'src/first.ts',
      sourceRange: range,
      signature: 'export class First',
      projectId: `${repositoryId}-${analysisRevision}-project`,
      exported: true,
      provider: 'tree-sitter',
      confidence: 0.9,
      evidenceLevel: 'structural',
    }],
    dependencyEdges: [{
      repositoryId,
      analysisRevision,
      dependencyEdgeId: `${repositoryId}-${analysisRevision}-edge`,
      kind: 'import',
      sourceRelativePath: 'src/first.ts',
      targetReference: './missing',
      internal: true,
      resolution: 'unresolved',
      provider: 'tree-sitter',
      confidence: 0.2,
      evidenceLevel: 'unresolved',
      evidenceRanges: [range],
    }],
    diagnostics: [],
  };
}

async function seed(
  store: InMemoryIndexStore,
  repositoryId: string,
  analysisRevision: string,
  analysisHash = 'b'.repeat(64),
): Promise<StructuralIndex> {
  const structural = index(repositoryId, analysisRevision, analysisHash);
  await store.putRepository(repository(repositoryId));
  const ready = revision(repositoryId, analysisRevision, analysisHash);
  await store.putRevision({
    ...ready,
    status: 'building',
    completedAt: undefined,
  });
  await store.putStructuralIndex(structural, new Map([['src/first.ts', 'export class First {}\n']]));
  await store.putRevision(ready);
  return structural;
}

describe('SemanticQueryService', () => {
  it('keeps independent repository revisions isolated and never exposes local paths', async () => {
    const store = new InMemoryIndexStore();
    const left = await seed(store, 'history-one', 'revision-one', '1'.repeat(64));
    const right = await seed(store, 'history-two', 'revision-two', '2'.repeat(64));
    await store.activateRevision(left);
    await store.activateRevision(right);
    const query = new SemanticQueryService(store);

    const repositories = await query.listRepositories();
    expect(repositories.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: 'history-one', analysisRevision: 'revision-one' }),
      expect.objectContaining({ repositoryId: 'history-two', analysisRevision: 'revision-two' }),
    ]));
    expect(JSON.stringify(repositories)).not.toContain('C:/host-only');

    const symbols = await query.searchSymbols({
      repositoryId: left.repositoryId,
      analysisRevision: left.analysisRevision,
      query: 'First',
    });
    expect(symbols.symbols).toHaveLength(1);
    expect(symbols.symbols[0]).toMatchObject({
      repositoryId: 'history-one',
      analysisRevision: 'revision-one',
      provider: 'tree-sitter',
      evidenceLevel: 'structural',
    });
    expect(symbols.symbols[0]?.value.qualifiedName).toContain('history-one');

    const excerpt = await query.readSourceExcerpt({
      repositoryId: left.repositoryId,
      analysisRevision: left.analysisRevision,
      relativePath: 'src/first.ts',
    });
    expect(excerpt.excerpt?.value).toEqual({ text: 'export class First {}\n', truncated: false });
  });

  it('preserves unresolved dependencies instead of fabricating semantic definition/reference evidence', async () => {
    const store = new InMemoryIndexStore();
    const structural = await seed(store, 'history-one', 'revision-one');
    await store.activateRevision(structural);
    const query = new SemanticQueryService(store);
    const scope = { repositoryId: structural.repositoryId, analysisRevision: structural.analysisRevision };

    const dependencies = await query.getDependencies({ ...scope, relativePath: 'src/first.ts' });
    expect(dependencies.dependencies[0]?.value).toMatchObject({
      resolution: 'unresolved',
      evidenceLevel: 'unresolved',
      targetReference: './missing',
    });
    await expect(query.findDefinition({ ...scope, relativePath: 'src/first.ts', sourceRange: range }))
      .resolves.toEqual(expect.objectContaining({ availability: 'unavailable', definitions: [] }));
    await expect(query.findReferences({ ...scope, symbolKey: structural.symbols[0]!.symbolKey }))
      .resolves.toEqual(expect.objectContaining({ availability: 'unavailable', references: [] }));
  });

  it('rejects a semantic provider that attempts to return Tree-sitter or cross-revision evidence', async () => {
    const store = new InMemoryIndexStore();
    const structural = await seed(store, 'history-one', 'revision-one');
    await store.activateRevision(structural);
    const provider: SemanticProvider = {
      provider: 'lsp',
      isAvailable: async () => ({ available: true }),
      findDefinition: async () => [{
        repositoryId: 'other-repository',
        analysisRevision: 'other-revision',
        evidenceId: 'bad',
        provider: 'lsp',
        confidence: 1,
        evidenceLevel: 'semantic',
        relativePath: 'src/first.ts',
        sourceRange: range,
        value: { symbol: structural.symbols[0]! },
      }],
    };
    const query = new SemanticQueryService(store, { semanticProviders: [provider] });
    await expect(query.findDefinition({
      repositoryId: structural.repositoryId,
      analysisRevision: structural.analysisRevision,
      relativePath: 'src/first.ts',
      sourceRange: range,
    })).rejects.toThrow('different analysis revision');
  });

  it('rejects nested semantic facts that escape the requested revision or repository paths', async () => {
    const store = new InMemoryIndexStore();
    const structural = await seed(store, 'history-one', 'revision-one');
    await store.activateRevision(structural);
    const provider: SemanticProvider = {
      provider: 'lsp',
      isAvailable: async () => ({ available: true }),
      findDefinition: async () => [{
        repositoryId: structural.repositoryId,
        analysisRevision: structural.analysisRevision,
        evidenceId: 'outer-definition',
        provider: 'lsp',
        confidence: 1,
        evidenceLevel: 'semantic',
        relativePath: 'src/first.ts',
        sourceRange: range,
        value: {
          symbol: {
            ...structural.symbols[0]!,
            repositoryId: 'other-repository',
            analysisRevision: 'other-revision',
          },
        },
      }],
      findReferences: async () => [{
        repositoryId: structural.repositoryId,
        analysisRevision: structural.analysisRevision,
        evidenceId: 'outer-reference',
        provider: 'lsp',
        confidence: 1,
        evidenceLevel: 'semantic',
        relativePath: 'src/first.ts',
        sourceRange: range,
        value: {
          relativePath: 'C:/outside.ts',
          sourceRange: range,
        },
      }],
    };
    const query = new SemanticQueryService(store, { semanticProviders: [provider] });
    const scope = { repositoryId: structural.repositoryId, analysisRevision: structural.analysisRevision };
    await expect(query.findDefinition({ ...scope, relativePath: 'src/first.ts', sourceRange: range }))
      .rejects.toThrow('different analysis revision');
    await expect(query.findReferences({ ...scope, symbolKey: structural.symbols[0]!.symbolKey }))
      .rejects.toThrow('repository-relative');
  });

  it('marks prior current summaries stale only when a new revision becomes active', async () => {
    const store = new InMemoryIndexStore();
    const first = await seed(store, 'history-one', 'revision-one', '1'.repeat(64));
    await store.activateRevision(first);
    const artifact: ModuleArtifactRecord = {
      repositoryId: first.repositoryId,
      analysisRevision: first.analysisRevision,
      moduleArtifactId: 'summary-one',
      kind: 'module-summary',
      status: 'current',
      analysisHash: first.analysisHash,
      planHash: '3'.repeat(64),
      contentHash: '4'.repeat(64),
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      payload: { title: 'old summary' },
    };
    await store.putModuleArtifact(artifact);
    const second = index('history-one', 'revision-two', '2'.repeat(64));
    const secondReady = revision(second.repositoryId, second.analysisRevision, second.analysisHash);
    await store.putRevision({
      ...secondReady,
      status: 'building',
      completedAt: undefined,
    });
    await store.putStructuralIndex(second, new Map([['src/first.ts', 'export class First { next() {} }\n']]));
    await store.putRevision(secondReady);

    await store.activateRevision(second);
    expect((await store.listModuleArtifacts(first))[0]?.status).toBe('stale');
    expect((await store.getRepository('history-one'))?.activeRevision).toBe('revision-two');
  });

  it('does not atomically switch the active revision until projection completes', async () => {
    const store = new InMemoryIndexStore();
    const registry = new RepositoryRegistry(store, {
      idGenerator: () => 'history-one',
      resolveLocalPath: async () => 'C:/registered/history-one',
      clock: { now: () => '2026-09-04T00:00:00.000Z' },
    });
    await registry.register({ localPath: 'C:/registered/history-one', role: 'history' });
    const scanner: StructuralScanner = {
      scan: async (request) => {
        const structural = index(request.repositoryId, request.analysisRevision, '5'.repeat(64));
        return { index: structural, sourceTexts: new Map([['src/first.ts', 'export class First {}\n']]) };
      },
    };
    const coordinator = new AnalysisCoordinator(registry, store, scanner, new SeekDbProjection(store), {
      revisionIdGenerator: () => 'revision-one',
      clock: { now: () => '2026-09-04T00:00:01.000Z' },
    });

    await coordinator.run({ repositoryId: 'history-one' });
    expect((await store.getRepository('history-one'))?.activeRevision).toBe('revision-one');
    expect((await store.listSearchDocuments({ repositoryId: 'history-one', analysisRevision: 'revision-one' })).length)
      .toBeGreaterThan(0);
  });
});
