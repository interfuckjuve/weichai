import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import { initialWorkflowState } from '@forexplore/workflow-core';
import { CandidatesStage } from './CandidatesStage';

const target: ModuleTarget = {
  id: 'function:pay',
  name: 'Pay',
  kind: 'function',
  path: 'src/Payments/PaymentService.cs',
  language: 'C#',
  signature: 'public void Pay(Payment request)',
};

function candidate(id: string, title: string, path: string): SearchCandidate {
  return {
    id,
    title,
    repository: 'fixture/payments',
    license: 'MIT',
    language: 'Java',
    kind: 'function',
    path,
    signature: `void ${title}()`,
    summary: `${title} summary`,
    score: { overall: 0.92, semantic: 0.9, symbol: 0.88, contract: 0.86 },
    preview: `void ${title}() {}`,
    dependencies: [],
    compatibility: ['接口可映射'],
    risks: [],
  };
}

const candidates = [
  candidate('pay', 'submitPayment', 'src/payments/PaymentService.java'),
  candidate('refund', 'refundPayment', 'src/payments/RefundService.java'),
  candidate('order', 'createOrder', 'src/orders/OrderService.java'),
];

const state = {
  ...initialWorkflowState,
  stage: 'candidates' as const,
  target,
  candidates,
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CandidatesStage', () => {
  it('groups concrete candidates by repository module path', () => {
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={state}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('02 · 检索结果');
    expect(markup).toContain('<strong>2</strong> 模块');
    expect(markup).toContain('src/payments');
    expect(markup).toContain('src/orders');
    expect(markup).toContain('2 个实现');
    expect(markup).toContain('任意候选语言 → C#');
    expect(markup).toContain('请选择一个具体实现');
  });

  it('selects a concrete implementation inside a module group', () => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectCandidate = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <CandidatesStage
          state={state}
          dispatch={vi.fn()}
          adaptationProvider="DeepSeek"
          onSelectCandidate={onSelectCandidate}
          onAdapt={vi.fn()}
        />,
      );
    });

    const item = [...container.querySelectorAll<HTMLButtonElement>('.candidate-item')]
      .find((button) => button.textContent?.includes('refundPayment'));
    act(() => item?.click());
    expect(onSelectCandidate).toHaveBeenCalledWith('refund');

    act(() => root.unmount());
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('shows an actionable empty state', () => {
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={{ ...state, candidates: [] }}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('没有找到可复用实现');
    expect(markup).toContain('返回“定义任务”调整目标或需求后重新检索');
  });
});
