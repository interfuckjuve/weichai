import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SearchCandidateV2 } from '@forexplore/contracts';
import {
  initialWorkflowStateV2,
  type WorkflowStateV2,
} from '../v2-workflow';
import { CandidatesStage } from './CandidatesStage';

const artifactHash = `sha256:${'a'.repeat(64)}`;

function candidate(id: string, title: string, path: string): SearchCandidateV2 {
  return {
    schemaVersion: '2.0',
    id,
    requestId: 'search:payments',
    requestHash: artifactHash,
    targetId: 'target:pay',
    targetHash: artifactHash,
    route: {
      sourceLanguageId: 'java',
      targetLanguageId: 'csharp',
      strategy: 'translate',
      routeId: 'route:java-csharp',
      routeVersion: '1',
      routeContentHash: artifactHash,
      runtimeCapabilitySnapshotId: 'runtime:one',
      runtimeCapabilitySnapshotHash: artifactHash,
      validationPolicyId: 'policy:one',
      validationPolicyHash: artifactHash,
    },
    indexGeneration: {
      repositoryId: 'fixture/payments',
      id: 'generation:one',
      generation: 1,
      contentHash: artifactHash,
      sourceCatalogId: 'catalog:payments',
      sourceCatalogHash: artifactHash,
    },
    indexedDocumentId: `document:${id}`,
    indexedDocumentHash: artifactHash,
    candidate: {
      schemaVersion: '2.0',
      id: `implementation:${id}`,
      lineage: {
        repositoryId: 'fixture/payments',
        repositoryContentHash: artifactHash,
        unifiedRepositoryIrId: 'ir:payments',
        unifiedRepositoryIrHash: artifactHash,
      },
      entity: {
        entityId: `entity:${id}`,
        languageId: 'java',
        kind: 'function',
        name: title,
        path,
        signature: `void ${title}()`,
      },
      sourceBundleId: `bundle:${id}`,
      sourceBundleHash: artifactHash,
      license: 'MIT',
      contentHash: artifactHash,
    },
    sourceBundle: { id: `bundle:${id}`, contentHash: artifactHash },
    title,
    summary: `${title} summary`,
    score: { overall: 0.92, semantic: 0.9, symbol: 0.88, contract: 0.86 },
    preview: `void ${title}() {}`,
    compatibility: ['接口可映射'],
    risks: [],
    createdAt: '2026-09-03T00:00:00.000Z',
    contentHash: artifactHash,
  };
}

const candidates = [
  candidate('pay', 'submitPayment', 'src/payments/PaymentService.java'),
  candidate('refund', 'refundPayment', 'src/payments/RefundService.java'),
  candidate('order', 'createOrder', 'src/orders/OrderService.java'),
];

const state: WorkflowStateV2 = {
  ...initialWorkflowStateV2,
  stage: 'candidates',
  candidates,
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CandidatesStage', () => {
  it('groups V2 candidates by repository module path', () => {
    const markup = renderToStaticMarkup(
      <CandidatesStage
        state={state}
        dispatch={vi.fn()}
        adaptationProvider="DeepSeek"
        migrationSelection={null}
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('02 · 检索结果');
    expect(markup).toContain('<strong>2</strong> 模块');
    expect(markup).toContain('src/payments');
    expect(markup).toContain('src/orders');
    expect(markup).toContain('2 个实现');
    expect(markup).toContain('请选择一个具体实现');
  });

  it('asks the Host to resolve the selected implementation', () => {
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
          migrationSelection={null}
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
        migrationSelection={null}
        onSelectCandidate={vi.fn()}
        onAdapt={vi.fn()}
      />,
    );

    expect(markup).toContain('没有找到可复用实现');
    expect(markup).toContain('返回“定义任务”调整目标或需求后重新检索');
  });
});
