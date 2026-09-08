import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ModuleExplorerNode,
  ModuleExplorerPresentation,
  ModuleWorkspacePresentation,
} from '../../../src/ui-types';
import { ModuleWorkspace } from './ModuleWorkspace';
import type { ModuleChildrenProvider } from '../module-children-provider';

const targetWorkspace: ModuleWorkspacePresentation = {
  id: 'target:snapshot',
  mode: 'target',
  name: 'Target',
  rootLabel: 'target',
  snapshotId: 'snapshot',
  stats: {
    modules: 0,
    files: 0,
    types: 0,
    methods: 0,
    implemented: 0,
    unimplemented: 0,
    unknown: 0,
    dependencies: 0,
  },
  summary: { exists: false, path: '.forexplore/module-summary.json' },
  tree: [],
};

const paymentModule: ModuleExplorerNode = {
  id: 'module:payments',
  name: '支付模块',
  kind: 'module',
  description: '处理支付发起、确认与退款',
  purpose: '负责支付发起、确认与退款复用入口',
  coreApis: ['PaymentService.Pay', 'PaymentService.Refund'],
  language: 'C#',
  domain: '支付',
  children: [{
    id: 'file:payment-service',
    name: 'PaymentService.cs',
    kind: 'file',
    path: 'src/Payments/PaymentService.cs',
    language: 'C#',
    children: [{
      id: 'type:payment-service',
      name: 'PaymentService',
      kind: 'class',
      path: 'src/Payments/PaymentService.cs',
      language: 'C#',
      children: [{
        id: 'method:pay',
        name: 'Pay',
        kind: 'method',
        path: 'src/Payments/PaymentService.cs',
        language: 'C#',
        signature: 'public void Pay()',
        children: [],
      }],
    }],
  }],
};

const historyWorkspace: ModuleWorkspacePresentation = {
  ...targetWorkspace,
  id: 'history:one',
  mode: 'history',
  name: 'History',
  rootLabel: 'D:/code/history',
  snapshotId: 'history-snapshot',
  stats: { ...targetWorkspace.stats, modules: 1, files: 1, types: 1, methods: 1 },
  tree: [paymentModule],
};

const statusWorkspace: ModuleWorkspacePresentation = {
  ...targetWorkspace,
  name: 'Status Target',
  tree: [{
    id: 'module:test',
    name: '测试模块',
    kind: 'module',
    children: [
      {
        id: 'file:pom',
        name: 'pom.xml',
        kind: 'file',
        path: 'pom.xml',
        children: [],
      },
      {
        id: 'file:done',
        name: 'Done.java',
        kind: 'file',
        path: 'src/Done.java',
        children: [{
          id: 'method:done',
          name: 'done',
          kind: 'method',
          implementationStatus: 'implemented',
          targetId: 'target:done',
          children: [],
        }],
      },
      {
        id: 'file:todo',
        name: 'Todo.java',
        kind: 'file',
        path: 'src/Todo.java',
        children: [{
          id: 'method:todo',
          name: 'todo',
          kind: 'method',
          implementationStatus: 'unimplemented',
          targetId: 'target:todo',
          children: [],
        }],
      },
    ],
  }],
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('ModuleWorkspace history configuration prompt', () => {
  it('keeps a lazily loaded module selected after the host confirms its target and clears the node id', async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const selected: ModuleExplorerNode = { ...paymentModule, children: [], childrenTotal: 0,
      targetId: 'target:payments', refinement: { state: 'deferred', reason: 'Waiting for boundary evidence', decisionSource: 'structural' } };
    const load = vi.fn<ModuleChildrenProvider>(async () => ({ nodes: [selected], total: 1 }));
    const explorer: ModuleExplorerPresentation = { generatedAt: '', history: [], target: { ...targetWorkspace,
      repositoryId: 'target', projectId: 'project', revision: 'revision',
      tree: [{ id: 'module:root', name: 'Root', kind: 'module', children: [], childrenTotal: 1 }] } };
    const container = document.createElement('div'); const root = createRoot(container);
    const render = (currentTargetId: string, data = explorer) => <ModuleWorkspace explorer={data} mode="target" historyId={null}
      currentTargetId={currentTargetId} selectedNodeId={null} refreshing={false} onModeChange={vi.fn()} onHistoryChange={vi.fn()}
      onNodeSelect={vi.fn()} onLoadChildren={load} onTargetSelect={vi.fn()} onRefresh={vi.fn()} onOpenSettings={vi.fn()}
      settingsOpen={false}><div>Workflow</div></ModuleWorkspace>;
    await act(async () => root.render(render('')));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 Root"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-node-id="module:payments"] > .tree-row > .tree-select')!.click());
    await act(async () => root.render(render('target:payments')));
    expect(container.querySelector('[aria-label="当前选择"]')?.textContent).toContain('Waiting for boundary evidence');
    expect(container.querySelector('[data-node-id="module:payments"] > .tree-row')?.classList.contains('is-selected')).toBe(true);
    await act(async () => root.render(render('target:payments', { ...explorer, target: { ...explorer.target, revision: 'other' } })));
    expect(container.querySelector('[aria-label="当前选择"]')).toBeNull();
    await act(async () => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('separates root catalog counts from descendant modules and explains deferred refinement', () => {
    const deferred: ModuleExplorerNode = { ...paymentModule, id: 'module:deferred', name: '审计模块',
      refinement: { state: 'deferred', reason: '本轮模型预算已用尽，保留当前范围。', decisionSource: 'budget' },
      contents: { files: 1, types: 1, methods: 1, languages: ['C#'] } };
    const workspace: ModuleWorkspacePresentation = { ...historyWorkspace, projectId: 'project', rootTotal: 1,
      stats: { ...historyWorkspace.stats, modules: 3, files: 2 },
      analysis: { repositoryId: 'history', analysisRevision: 'revision', projectId: 'project', analysisProfile: 'test',
        state: 'ready', projection: 'ready', updatedAt: '',
        hierarchy: { nodeCount: 3, rootCount: 1, moduleCount: 2, subsystemCount: 1,
          leafCount: 1, splitCount: 1, deferredCount: 1, unknownCount: 0, maxDepth: 1 } },
      tree: [{ ...paymentModule, id: 'module:commerce', name: '交易子系统', nodeKind: 'subsystem',
        contents: { files: 2, types: 2, methods: 2, languages: ['C#'] }, children: [paymentModule, deferred] }] };
    const markup = renderWorkspace({ generatedAt: '', target: targetWorkspace, history: [workspace] }, 'history', deferred.id);
    expect(markup).toContain('1 个顶层范围 · 3 个节点');
    expect(markup).not.toContain('更多顶层范围');
    expect(markup).toContain('is-subsystem');
    expect(markup).toContain('待细化');
    expect(markup).toContain('预算限制');
    expect(markup).toContain('本轮模型预算已用尽，保留当前范围。');
    expect(markup).toContain('叶模块 1');
  });

  it('loads root modules from both the catalog and sidebar while reporting the full module count', async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const modules: ModuleExplorerNode[] = Array.from({ length: 205 }, (_, index) => ({
      id: `module:${index}`, kind: 'module', name: `Module ${index}`, children: [], childrenTotal: 0,
      contents: { files: 1, types: 1, methods: 1, languages: ['TypeScript'] },
    }));
    const load = vi.fn<ModuleChildrenProvider>(async (request) => ({ nodes: modules.slice(request.offset, request.offset + 80), total: modules.length }));
    const explorer = { generatedAt: '', target: targetWorkspace, history: [{ ...historyWorkspace,
      repositoryId: 'history', projectId: 'project', revision: 'revision', rootTotal: modules.length,
      stats: { ...historyWorkspace.stats, modules: modules.length }, tree: modules.slice(0, 80) }] };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(workspaceElement(explorer, 'history', null, vi.fn(), load)));
    expect(container.querySelector('.history-section-heading')?.textContent).toContain('205 个模块');
    expect(container.querySelectorAll('.module-tree [role="treeitem"]')).toHaveLength(80);
    expect(container.querySelectorAll('.history-module-card')).toHaveLength(24);
    for (let page = 0; page < 3; page++) await act(async () => container.querySelector<HTMLButtonElement>('.history-catalog > .tree-more')!.click());
    expect(load.mock.calls[0]?.[0]).toMatchObject({ nodeId: '$root', offset: 80 });
    expect(container.querySelectorAll('.history-module-card')).toHaveLength(96);
    await act(async () => container.querySelector<HTMLButtonElement>('.module-tree > .tree-more')!.click());
    expect(container.querySelectorAll('.module-tree [role="treeitem"]')).toHaveLength(160);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>('.module-tree > .tree-more')!.click());
    expect(container.querySelectorAll('.module-tree [role="treeitem"]')).toHaveLength(205);
    expect(load.mock.calls[1]?.[0]).toMatchObject({ nodeId: '$root', offset: 160 });
    expect(container.querySelector('.module-tree > .tree-more')).toBeNull();
    expect(container.querySelector('.history-section-heading')?.textContent).toContain('205 个模块');
    await act(async () => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('loads all child pages on demand without expanding a large module initially', async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const files: ModuleExplorerNode[] = Array.from({ length: 205 }, (_, i) => ({
      id: `file:${i}`, kind: 'file', name: `File${i}.ts`, children: [], childrenTotal: 0,
    }));
    const load = vi.fn<ModuleChildrenProvider>(async (request) => ({ nodes: files.slice(request.offset, request.offset + 80), total: files.length }));
    const explorer = { generatedAt: '', target: { ...targetWorkspace, repositoryId: 'target', projectId: 'project', revision: 'revision',
      tree: [{ ...paymentModule, children: [], childrenTotal: files.length }] }, history: [] };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(workspaceElement(explorer, 'target', null, vi.fn(), load)));
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 支付模块"]')!.click());
    expect(load.mock.calls[0]?.[0]).toMatchObject({ repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', nodeId: 'module:payments', offset: 0 });
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(81);
    expect(container.textContent).toContain('80 / 205');
    await act(async () => container.querySelector<HTMLButtonElement>('.tree-more')!.click());
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(161);
    await act(async () => container.querySelector<HTMLButtonElement>('.tree-more')!.click());
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(206);
    expect(container.textContent).toContain('File204.ts');
    expect(container.querySelector('.tree-more')).toBeNull();
    await act(async () => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('searches the complete host index for a symbol that has never been expanded', async () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const match: ModuleExplorerNode = { id: 'symbol:hidden', kind: 'function', name: 'HiddenFunction',
      path: 'src/hidden.ts', line: 42, children: [], childrenTotal: 0 };
    const load = vi.fn<ModuleChildrenProvider>(async () => ({ nodes: [match], total: 1 }));
    const explorer = { generatedAt: '', target: { ...targetWorkspace, repositoryId: 'target', projectId: 'project', revision: 'revision',
      tree: [{ ...paymentModule, children: [], childrenTotal: 5000 }] }, history: [] };
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(workspaceElement(explorer, 'target', null, vi.fn(), load)));
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('.module-search input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'HiddenFunction');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toMatchObject({ nodeId: '$search', query: 'HiddenFunction', offset: 0 });
    expect(container.querySelector('.module-tree')?.textContent).toContain('HiddenFunction');
    expect(container.querySelector('.tree-location')?.textContent).toBe('src/hidden.ts:42');
    expect(container.querySelector('.tree-location')?.getAttribute('title')).toBe('src/hidden.ts:42');
    await act(async () => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('prompts for repository paths when no history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('尚未配置参考工程');
    expect(markup).toContain('配置路径');
    expect(markup).toContain('保存后即可从左侧切换');
  });

  it('hides the prompt after a history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    });

    expect(markup).not.toContain('尚未配置参考工程');
  });

  it('lets the target workflow own the main area without a duplicate overview', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('Workflow');
    expect(markup).not.toContain('目标工程模块划分');
  });

  it('keeps history analysis workflow collapsed by default', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    };
    const markup = renderWorkspace(explorer, 'history');

    expect(markup).toContain('参考模块库');
    expect(markup).toContain('模块目录');
    expect(markup).toContain('支付模块');
    expect(markup).toContain('负责支付发起、确认与退款复用入口');
    expect(markup).toContain('支付');
    expect(markup).toContain('1 文件');
    expect(markup).toContain('1 类型');
    expect(markup).toContain('1 方法');
    expect(markup).toContain('查看分析信息');
    expect(markup).not.toContain('静态索引');
    expect(markup).not.toContain('模块知识摘要');
  });

  it('highlights the containing module and previews a selection from the tree', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    };
    const markup = renderWorkspace(explorer, 'history', 'method:pay');

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('当前选择');
    expect(markup).toContain('public void Pay()');
    expect(markup).toContain('src/Payments/PaymentService.cs');
  });

  it('previews committed module summary metadata for a selected module', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    };
    const markup = renderWorkspace(explorer, 'history', 'module:payments');

    expect(markup).toContain('负责支付发起、确认与退款复用入口');
    expect(markup).toContain('PaymentService.Pay');
    expect(markup).toContain('PaymentService.Refund');
    expect(markup).toContain('C#');
  });

  it('selects a module from the module catalog', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    };
    const onNodeSelect = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(workspaceElement(explorer, 'history', null, onNodeSelect));
    });
    const moduleCard = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('负责支付发起、确认与退款复用入口'));
    expect(moduleCard).toBeDefined();
    act(() => moduleCard?.click());
    expect(onNodeSelect).toHaveBeenCalledWith(paymentModule);
    act(() => root.unmount());
  });

  it('keeps status-less configuration files available under pending confirmation', () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-03T00:00:00.000Z',
      target: statusWorkspace,
      history: [],
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(workspaceElement(explorer, 'target', null, vi.fn()));
    });

    const pendingButton = [...container.querySelectorAll<HTMLButtonElement>('.status-filter button')]
      .find((button) => button.textContent === '待确认');
    act(() => pendingButton?.click());

    const tree = container.querySelector('.module-tree');
    expect(tree?.textContent).toContain('pom.xml');
    expect(tree?.textContent).not.toContain('Done.java');
    expect(tree?.textContent).not.toContain('Todo.java');
    expect(tree?.querySelector('.status-mark.is-unknown')).not.toBeNull();

    act(() => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });
});

function renderWorkspace(
  explorer: ModuleExplorerPresentation,
  mode: 'target' | 'history' = 'target',
  selectedNodeId: string | null = null,
): string {
  return renderToStaticMarkup(workspaceElement(explorer, mode, selectedNodeId, vi.fn()));
}

function workspaceElement(
  explorer: ModuleExplorerPresentation,
  mode: 'target' | 'history',
  selectedNodeId: string | null,
  onNodeSelect: (node: ModuleExplorerNode) => void,
  onLoadChildren?: ModuleChildrenProvider,
) {
  return (
    <ModuleWorkspace
      explorer={explorer}
      mode={mode}
      historyId={null}
      currentTargetId="target"
      selectedNodeId={selectedNodeId}
      refreshing={false}
      onModeChange={vi.fn()}
      onHistoryChange={vi.fn()}
      onNodeSelect={onNodeSelect}
      onLoadChildren={onLoadChildren}
      onTargetSelect={vi.fn()}
      onRefresh={vi.fn()}
      onOpenSettings={vi.fn()}
      settingsOpen={false}
    >
      <div>Workflow</div>
    </ModuleWorkspace>
  );
}
