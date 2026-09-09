import { describe, expect, it } from 'vitest';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { buildProjectExplorer, readExplorerChildren } from './project-explorer';

function entry(): Awaited<ReturnType<CodeIntelligenceHost['explorerData']>>[number] {
  const scope = { repositoryId: 'target', analysisRevision: 'revision' };
  return {
    repository: { repositoryId: 'target', displayName: 'Target', localPath: '/target', role: 'target',
      activeRevision: 'revision', analysisStatus: 'ready', createdAt: '', updatedAt: '' },
    selectedTarget: true, projectId: 'project',
    index: { ...scope, analysisHash: 'hash', diagnostics: [], dependencyEdges: [],
      projects: [{ ...scope, projectId: 'project', kind: 'node', displayName: 'Target', relativePath: '', manifestPaths: ['package.json'], sourceRoots: [''], testRoots: [], languageIds: ['typescript'] }],
      files: ['payment.ts', 'receipt.ts'].map((relativePath) => ({ ...scope, fileId: relativePath, relativePath, projectId: 'project',
        languageId: 'typescript', role: 'source', sha256: 'hash', sizeBytes: 100, parseStatus: 'parsed' })),
      symbols: [{ ...scope, symbolId: 'pay', symbolKey: 'pay', astDeclarationId: 'pay', name: 'pay', qualifiedName: 'pay', kind: 'function',
        languageId: 'typescript', relativePath: 'payment.ts', projectId: 'project', exported: true, provider: 'tree-sitter', confidence: 1,
        evidenceLevel: 'structural', sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 } }] },
    analysis: { ...scope, projectId: 'project', state: 'ready', projection: 'ready', analysisProfile: 'code-understanding/v1', updatedAt: '',
      proposal: { ...scope, analysisHash: 'hash', objective: 'understand', summary: 'Payments', modules: [{ id: 'payments', name: 'Payments',
        kind: 'feature', description: 'Payments with receipts', language: 'TypeScript', sourceFiles: ['payment.ts', 'receipt.ts'],
        coreApis: ['pay'], symbolKeys: ['pay'], dependsOn: [], evidenceIds: ['pay'] }] } },
  };
}

describe('live project explorer module selection', () => {
  it('preserves adaptive module branches, scoped directories and unique ancestor counts', async () => {
    const data = entry();
    const paths = ['src/payment.ts', 'src/receipt.ts', 'src/audit.ts', 'tools/config.ts'];
    const templateFile = data.index.files[0]!;
    data.index.files = paths.map((relativePath) => ({ ...templateFile, relativePath, fileId: relativePath }));
    data.index.symbols[0]!.relativePath = paths[0]!;
    const template = data.analysis!.proposal!.modules[0]!;
    const node = (id: string, parentId: string | null, sourceFiles: string[], state: 'leaf' | 'split' | 'deferred') => ({
      ...template, id, name: id, parentId, nodeKind: 'module' as const, sourceFiles,
      symbolKeys: sourceFiles.includes(paths[0]!) ? ['pay'] : [],
      refinement: { state, reason: `${id} boundary`, decisionSource: state === 'deferred' ? 'budget' as const : 'model' as const },
    });
    data.analysis!.proposal!.modules = [
      { ...node('application', null, [], 'split'), nodeKind: 'subsystem' },
      node('payments', 'application', [paths[0]!], 'leaf'),
      node('reports', 'application', [], 'split'),
      node('receipts', 'reports', [paths[1]!], 'leaf'),
      node('audit', 'reports', [paths[2]!], 'deferred'),
      node('config', null, [paths[3]!], 'leaf'),
    ];
    data.analysis!.proposal!.hierarchy = { version: 1, algorithm: 'adaptive-module-tree/v1', maxDepth: 2,
      decisionCount: 6, modelDecisionCount: 5, deferredCount: 1 };
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    const workspace = result.presentation.target;
    expect(workspace.tree.map((item) => item.name)).toEqual(['application', 'config']);
    expect(workspace.rootTotal).toBe(2);
    expect(workspace.stats).toMatchObject({ modules: 6, files: 4, methods: 1 });
    expect(workspace.analysis?.hierarchy).toEqual({ nodeCount: 6, rootCount: 2, moduleCount: 5, subsystemCount: 1,
      leafCount: 3, splitCount: 2, deferredCount: 1, unknownCount: 0, maxDepth: 2 });
    expect(workspace.analysis?.proposal?.hierarchy?.modelDecisionCount).toBe(5);
    expect(workspace.analysis?.proposal).not.toHaveProperty('modules');
    expect(workspace.tree[0]).toMatchObject({ nodeKind: 'subsystem', parentId: null, depth: 0,
      children: [], childrenTotal: 2, contents: { files: 3, methods: 1 } });
    expect(workspace.tree.reduce((count, item) => count + item.contents!.files, 0)).toBe(4);
    expect(result.targets.get(workspace.tree[0]!.targetId!)?.module?.sourceFiles).toEqual(paths.slice(0, 3));
    const scope = { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', offset: 0 };
    const page = (nodeId: string) => readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId }).nodes;
    expect(page('module:application').map((item) => item.name)).toEqual(['payments', 'reports']);
    expect(page('module:reports').map((item) => item.depth)).toEqual([2, 2]);
    const paymentDirectory = page('module:payments')[0]!;
    const receiptDirectory = page('module:receipts')[0]!;
    expect(paymentDirectory).toMatchObject({ kind: 'folder', name: 'src', childrenTotal: 1 });
    expect(receiptDirectory).toMatchObject({ kind: 'folder', name: 'src', childrenTotal: 1 });
    expect(receiptDirectory.id).not.toBe(paymentDirectory.id);
    expect(page(paymentDirectory.id).map((item) => item.path)).toEqual(['src/payment.ts']);
    expect(page(receiptDirectory.id).map((item) => item.path)).toEqual(['src/receipt.ts']);
    expect(page('file:src/payment.ts')[0]?.name).toBe('pay');
    expect(page('module:reports')[1]?.refinement).toMatchObject({ state: 'deferred', decisionSource: 'budget' });
  });

  it('pages root modules while retaining all module targets and complete statistics', async () => {
    const data = entry();
    const template = data.analysis!.proposal!.modules[0]!;
    data.analysis!.proposal!.modules = Array.from({ length: 205 }, (_, index) => ({ ...template, id: `module-${index}`, name: `Module ${index}` }));
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    expect(result.presentation.target.rootTotal).toBe(205);
    expect(result.presentation.target.tree).toHaveLength(80);
    expect(result.presentation.target.stats.modules).toBe(205);
    const scope = { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', nodeId: '$root' };
    const nodes = [0, 80, 160].flatMap((offset) => {
      const page = readExplorerChildren(result.childrenByNodeId, { ...scope, offset });
      expect(page.total).toBe(205);
      expect(page.nodes.length).toBeLessThanOrEqual(80);
      return page.nodes;
    });
    expect(new Set(nodes.map((node) => node.id)).size).toBe(205);
    expect(nodes.at(-1)?.name).toBe('Module 204');
    expect(nodes.every((node) => result.targets.has(node.targetId!))).toBe(true);
  });

  it('keeps complete counts and targets while sending symbols only in bounded child pages', async () => {
    const data = entry();
    const template = data.index.symbols[0]!;
    data.index.symbols = Array.from({ length: 205 }, (_, i) => ({ ...template,
      symbolKey: `symbol-${i}`, symbolId: `symbol-${i}`, astDeclarationId: `symbol-${i}`,
      name: `function${String(i).padStart(3, '0')}`, qualifiedName: `function${String(i).padStart(3, '0')}`,
      sourceRange: { startLine: i + 1, endLine: i + 1, startColumn: 1, endColumn: 20 },
    }));
    data.analysis!.proposal!.modules[0]!.symbolKeys = data.index.symbols.map((symbol) => symbol.symbolKey);
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    const workspace = result.presentation.target;
    expect(workspace.stats.methods).toBe(205);
    expect(workspace.tree[0]).toMatchObject({ children: [], childrenTotal: 2, contents: { files: 2, methods: 205 } });
    expect(JSON.stringify(workspace)).not.toContain('symbolKeys');
    expect(JSON.stringify(workspace)).not.toContain('function204');
    const scope = { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project' };
    const files = readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId: 'module:payments', offset: 0 });
    expect(files.nodes.map((node) => node.path)).toEqual(['payment.ts', 'receipt.ts']);
    const first = readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId: 'file:payment.ts', offset: 0 });
    const last = readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId: 'file:payment.ts', offset: 160 });
    expect(first.total).toBe(205);
    expect(first.nodes).toHaveLength(80);
    expect(last.nodes).toHaveLength(45);
    expect(last.nodes.at(-1)?.name).toBe('function204');
    expect(result.targets.has(last.nodes.at(-1)!.targetId!)).toBe(true);
    const search = readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId: '$search', offset: 0, query: 'function204' });
    expect(search.total).toBe(1);
    expect(search.nodes[0]?.name).toBe('function204');
    expect(() => readExplorerChildren(result.childrenByNodeId, { ...scope, analysisRevision: 'other', nodeId: 'file:payment.ts', offset: 0 })).toThrow('no longer visible');
    expect(() => readExplorerChildren(result.childrenByNodeId, { ...scope, nodeId: 'file:payment.ts', offset: -1 })).toThrow('offset');
  });

  it('selects a complete current target module with snapshot identity', async () => {
    const result = await buildProjectExplorer({ explorerData: async () => [entry()] });
    const id = result.presentation.target.tree[0]!.targetId!;
    expect(result.targets.get(id)).toMatchObject({ kind: 'module', name: 'Payments',
      module: { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', sourceFiles: ['payment.ts', 'receipt.ts'], coreApis: ['pay'] } });
    expect(result.presentation.target.analysis?.hierarchy).toMatchObject({ rootCount: 1, moduleCount: 1,
      subsystemCount: 0, leafCount: 0, unknownCount: 1, maxDepth: 0 });
    expect(result.presentation.target.tree[0]?.refinement).toBeUndefined();
  });

  it('does not insert a selected module as an extra method into its representative file', async () => {
    const host = { explorerData: async () => [entry()] };
    const first = await buildProjectExplorer(host);
    const target = first.targets.get(first.presentation.target.tree[0]!.targetId!)!;
    const selected = await buildProjectExplorer(host, target);
    const scope = { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', offset: 0 };
    const file = readExplorerChildren(selected.childrenByNodeId, { ...scope, nodeId: 'file:payment.ts' });
    expect(file.total).toBe(1);
    expect(file.nodes[0]?.name).toBe('pay');
    const moduleSearch = readExplorerChildren(selected.childrenByNodeId, { ...scope, nodeId: '$search', query: 'Payments' });
    expect(moduleSearch.nodes.map((node) => node.kind)).toEqual(['module']);
    expect(selected.targets.get(target.id)?.module?.sourceFiles).toEqual(['payment.ts', 'receipt.ts']);
  });

  it('keeps historical revisions read-only', async () => {
    const data = entry();
    data.repository.activeRevision = 'new-revision';
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    expect(result.presentation.target.tree[0]!.targetId).toBeUndefined();
    expect(result.targets.size).toBe(0);
    const page = readExplorerChildren(result.childrenByNodeId, {
      repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', nodeId: '$search', query: 'pay', offset: 0,
    });
    expect(page.nodes.length).toBeGreaterThan(0);
    expect(page.nodes.every((node) => node.targetId === undefined)).toBe(true);
  });

  it('does not select a module before its analysis is ready', async () => {
    const data = entry();
    data.analysis!.state = 'failed';
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    expect(result.presentation.target.tree[0]!.targetId).toBeUndefined();
    expect([...result.targets.values()].some((target) => target.kind === 'module')).toBe(false);
  });
});
