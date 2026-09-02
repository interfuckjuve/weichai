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

describe('ModuleWorkspace history configuration prompt', () => {
  it('prompts for repository paths when no history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('尚未配置历史仓');
    expect(markup).toContain('配置路径');
    expect(markup).toContain('保存后即可从左侧切换');
  });

  it('hides the prompt after a history repository is configured', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    });

    expect(markup).not.toContain('尚未配置历史仓');
  });

  it('lets the target workflow own the main area without a duplicate overview', () => {
    const markup = renderWorkspace({
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [],
    });

    expect(markup).toContain('Workflow');
    expect(markup).not.toContain('目标工作区模块划分');
  });

  it('keeps history analysis workflow collapsed by default', () => {
    const explorer: ModuleExplorerPresentation = {
      generatedAt: '2026-09-01T00:00:00.000Z',
      target: targetWorkspace,
      history: [historyWorkspace],
    };
    const markup = renderWorkspace(explorer, 'history');

    expect(markup).toContain('历史模块库');
    expect(markup).toContain('模块目录');
    expect(markup).toContain('支付模块');
    expect(markup).toContain('处理支付发起、确认与退款');
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
      .find((button) => button.textContent?.includes('处理支付发起、确认与退款'));
    expect(moduleCard).toBeDefined();
    act(() => moduleCard?.click());
    expect(onNodeSelect).toHaveBeenCalledWith(paymentModule);
    act(() => root.unmount());
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
      onTargetSelect={vi.fn()}
      onRefresh={vi.fn()}
      onOpenSettings={vi.fn()}
      settingsOpen={false}
    >
      <div>Workflow</div>
    </ModuleWorkspace>
  );
}
