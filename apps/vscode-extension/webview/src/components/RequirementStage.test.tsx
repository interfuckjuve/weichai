import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleTarget } from '@forexplore/contracts';
import { initialWorkflowState } from '@forexplore/workflow-core';
import { RequirementStage } from './RequirementStage';

const target: ModuleTarget = {
  id: 'function:pay',
  name: 'Pay',
  kind: 'function',
  path: 'src/Payments/PaymentService.cs',
  line: 42,
  language: 'C#',
  signature: 'public void Pay(Payment request)',
  documentation: '提交一笔支付请求。',
  implementationStatus: 'unimplemented',
};

const state = {
  ...initialWorkflowState,
  stage: 'requirement' as const,
  target,
  topK: 4,
  requirement: '保留现有接口',
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('RequirementStage', () => {
  it('combines target selection context and optional requirement in one task composer', () => {
    const markup = renderToStaticMarkup(
      <RequirementStage
        state={state}
        target={target}
        dispatch={vi.fn()}
        onSearch={vi.fn()}
        onCopyTargetPath={vi.fn()}
        onRevealTarget={vi.fn()}
      />,
    );

    expect(markup).toContain('01 · 定义任务');
    expect(markup).toContain('已选目标');
    expect(markup).toContain('需求补充');
    expect(markup).toContain('可选');
    expect(markup).toContain('保留现有接口');
    expect(markup).toContain('查找 4 个候选方案');
    expect(markup).toContain('复制目标路径');
    expect(markup).toContain('在左侧资源管理器中定位');
    expect(markup).not.toContain(target.signature);
  });

  it('expands, copies, reveals and submits the combined target', () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const onSearch = vi.fn();
    const onCopyTargetPath = vi.fn();
    const onRevealTarget = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <RequirementStage
          state={state}
          target={target}
          dispatch={vi.fn()}
          onSearch={onSearch}
          onCopyTargetPath={onCopyTargetPath}
          onRevealTarget={onRevealTarget}
        />,
      );
    });

    const pathSection = container.querySelector('.task-target-path');
    const pathExpandButton = pathSection?.querySelector<HTMLButtonElement>('[aria-expanded="false"]');
    act(() => pathExpandButton?.click());
    expect(pathSection?.classList.contains('is-expanded')).toBe(true);

    const copyButton = container.querySelector<HTMLButtonElement>('[aria-label="复制目标路径"]');
    act(() => copyButton?.click());
    expect(onCopyTargetPath).toHaveBeenCalledOnce();

    const revealButton = container.querySelector<HTMLButtonElement>('[title="在左侧资源管理器中定位"]');
    act(() => revealButton?.click());
    expect(onRevealTarget).toHaveBeenCalledOnce();

    const detailButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('展开详情'));
    act(() => detailButton?.click());
    expect(container.textContent).toContain(target.signature);

    const form = container.querySelector('form');
    act(() => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onSearch).toHaveBeenCalledOnce();

    act(() => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });
});
