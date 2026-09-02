import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  EntityImplementationAssessment,
  MigrationRouteDescriptor,
  ModuleTarget,
  SearchCandidate,
  TargetImplementationRollup,
  TargetWorkspaceModuleSnapshot,
} from '@forexplore/contracts';
import {
  migrationReferenceSchemaVersion,
  migrationRouteSchemaVersion,
  validationPolicySchemaVersion,
} from '@forexplore/contracts';
import {
  createMigrationRouteSnapshotRef,
  materializeMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostToWebviewMessage,
  PanelInitPayload,
  TargetWorkspaceSnapshot,
  TargetWorkspaceMigrationSelection,
  TargetWorkspaceTreeNode,
  WebviewToHostMessage,
} from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import App from './App';

const snapshotHash = 'a'.repeat(64);
const artifactHash = 'b'.repeat(64);

const javaToCsharpRouteDraft: MigrationRouteDescriptor = {
  schemaVersion: migrationRouteSchemaVersion,
  id: 'route:java-to-csharp',
  name: 'Java to C#',
  version: '1.0.0',
  sourceLanguageId: 'java',
  targetLanguageId: 'csharp',
  strategy: 'translate',
  stages: [{
    stage: 'translation',
    providerId: 'test-adapter',
    providerVersion: '1.0.0',
    capabilities: ['code-translation'],
    availability: { status: 'available', reasonCodes: [] },
  }],
  availability: { status: 'available', reasonCodes: [] },
  validationPolicy: {
    schemaVersion: validationPolicySchemaVersion,
    id: 'policy:java-to-csharp',
    routeId: 'route:java-to-csharp',
    routeVersion: '1.0.0',
    checks: [{
      id: 'compile',
      label: 'Compile target',
      phase: 'compile',
      required: true,
      verifierId: 'test-compiler',
      verifierVersion: '1.0.0',
    }],
  },
};
const runtimeCapabilitySnapshot = materializeMigrationRuntimeCapabilitySnapshot({
  routes: [javaToCsharpRouteDraft],
  createdAt: '2026-09-02T00:00:00.000Z',
});
const javaToCsharpRoute = runtimeCapabilitySnapshot.routes[0]!;
const javaToCsharpRouteRef = createMigrationRouteSnapshotRef(
  runtimeCapabilitySnapshot,
  javaToCsharpRoute.id,
);

const blockedEligibility = {
  status: 'blocked' as const,
  routeOptions: [],
  reasonCodes: ['aggregate-node'],
  summary: '请选择可调用实体。',
};

const target: ModuleTarget = {
  id: 'workspace://src/PaymentService.cs#L12',
  name: 'Pay',
  kind: 'function',
  path: 'src/PaymentService.cs',
  language: 'C#',
  signature: 'Task<Payment> Pay(Request request)',
  line: 12,
  implementationStatus: 'unimplemented',
};

function candidate(id: string, language: SearchCandidate['language']): SearchCandidate {
  return {
    id,
    title: `${language} payment candidate`,
    repository: 'history-repository',
    license: 'internal',
    language,
    kind: 'function',
    path: `src/${id}`,
    signature: 'pay(request)',
    summary: 'Historical payment implementation.',
    score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.7 },
    preview: 'pay(request)',
    dependencies: [],
    compatibility: [],
    risks: [],
  };
}

function assessment(
  entityId: string,
  state: EntityImplementationAssessment['state'],
  basis: EntityImplementationAssessment['basis'],
  reasonCodes: string[],
): EntityImplementationAssessment {
  return {
    schemaVersion: '1.0',
    id: `assessment:${entityId}`,
    entityId,
    fileId: 'file:payment',
    state,
    basis,
    reasonCodes,
    evidenceRefs: [{
      id: `evidence:${entityId}`,
      kind: 'syntactic-analysis',
      path: 'src/PaymentService.cs',
      summary: `Evidence for ${entityId}`,
    }],
    detector: { id: 'test-detector', version: '1.0.0', languageId: 'csharp' },
    lineage: {
      repositoryId: 'target-workspace',
      repositoryContentHash: artifactHash,
      unifiedRepositoryIrId: 'ir:target',
      unifiedRepositoryIrHash: artifactHash,
    },
    createdAt: '2026-09-02T00:00:00.000Z',
    contentHash: artifactHash,
  };
}

const payAssessment = assessment('callable:pay', 'unimplemented', 'explicit-stub', ['explicit-not-implemented']);
const refundAssessment = assessment('callable:refund', 'implemented', 'syntactic-body', ['body-present']);
const contractAssessment = assessment('callable:contract', 'not-applicable', 'declaration-only', ['interface-contract']);

function rollup(
  id: string,
  scope: TargetImplementationRollup['scope'],
  state: TargetImplementationRollup['state'],
): TargetImplementationRollup {
  return {
    schemaVersion: '1.0',
    id: `rollup:${id}`,
    scope,
    scopeId: id,
    state,
    counts: {
      eligible: 2,
      implemented: 1,
      unimplemented: 1,
      partial: 0,
      unknown: 0,
      notApplicable: 1,
    },
    eligibleEntityIds: ['callable:pay', 'callable:refund'],
    excludedEntityIds: ['callable:contract'],
    contentHash: artifactHash,
  };
}

function callableNode(
  entityId: string,
  name: string,
  implementation: EntityImplementationAssessment,
  eligibleForMigration: boolean,
): TargetWorkspaceTreeNode {
  return {
    nodeId: `node:${entityId}`,
    entityId,
    moduleId: 'payments',
    kind: 'callable',
    nativeKind: 'method',
    kindLabel: '方法',
    name,
    qualifiedName: `PaymentService.${name}`,
    path: 'src/PaymentService.cs',
    languageId: 'csharp',
    signature: `Task ${name}()`,
    range: { startLine: name === 'Pay' ? 12 : 20 },
    assessment: implementation,
    migrationEligibility: eligibleForMigration
      ? {
          status: 'eligible',
          targetLanguageId: 'csharp',
          routeOptions: [{ route: javaToCsharpRoute, warnings: [] }],
          reasonCodes: [],
        }
      : {
          status: 'blocked',
          targetLanguageId: 'csharp',
          routeOptions: [],
          reasonCodes: ['implementation-not-applicable'],
          summary: '声明节点不包含可迁移实现体。',
        },
    children: [],
  };
}

function targetWorkspaceSnapshot(): TargetWorkspaceSnapshot {
  const classRollup = rollup('type:payment-service', 'class', 'partial');
  const fileRollup = rollup('file:payment', 'file', 'partial');
  const moduleRollup = rollup('payments', 'module', 'partial');
  const moduleSnapshot: TargetWorkspaceModuleSnapshot = {
    schemaVersion: '1.0',
    id: 'target-snapshot-1',
    lineage: {
      repositoryId: 'target-workspace',
      repositoryContentHash: artifactHash,
      unifiedRepositoryIrId: 'ir:target',
      unifiedRepositoryIrHash: artifactHash,
      moduleCatalogId: 'catalog:target',
      moduleCatalogHash: artifactHash,
      moduleReviewId: 'review:target',
      moduleReviewHash: artifactHash,
    },
    structureHash: artifactHash,
    moduleBoundaryHash: artifactHash,
    assessments: [payAssessment, refundAssessment, contractAssessment],
    classRollups: [classRollup],
    fileRollups: [fileRollup],
    moduleRollups: [moduleRollup],
    workspaceCounts: moduleRollup.counts,
    excludedEntities: [{
      entityId: contractAssessment.entityId,
      fileId: contractAssessment.fileId,
      reason: 'not-applicable',
    }],
    producer: { kind: 'ingestion-host', id: 'target-workspace-host', version: '1.0.0' },
    createdAt: '2026-09-02T00:00:00.000Z',
    contentHash: snapshotHash,
  };
  const root: TargetWorkspaceTreeNode = {
    nodeId: 'node:workspace',
    entityId: 'target-workspace',
    kind: 'workspace',
    name: 'Target Workspace',
    migrationEligibility: blockedEligibility,
    children: [{
      nodeId: 'node:module:payments',
      entityId: 'payments',
      moduleId: 'payments',
      kind: 'module',
      name: '支付模块',
      rollup: moduleRollup,
      migrationEligibility: blockedEligibility,
      children: [{
        nodeId: 'node:file:payment',
        entityId: 'file:payment',
        moduleId: 'payments',
        kind: 'file',
        name: 'PaymentService.cs',
        path: 'src/PaymentService.cs',
        languageId: 'csharp',
        rollup: fileRollup,
        migrationEligibility: blockedEligibility,
        children: [{
          nodeId: 'node:type:payment-service',
          entityId: 'type:payment-service',
          moduleId: 'payments',
          kind: 'type',
          name: 'PaymentService',
          qualifiedName: 'Target.PaymentService',
          path: 'src/PaymentService.cs',
          languageId: 'csharp',
          rollup: classRollup,
          migrationEligibility: blockedEligibility,
          children: [
            callableNode('callable:pay', 'Pay', payAssessment, true),
            callableNode('callable:refund', 'Refund', refundAssessment, true),
            callableNode('callable:contract', 'IPaymentContract', contractAssessment, false),
          ],
        }],
      }],
    }],
  };
  return {
    schemaVersion: '1.0',
    workspaceId: 'target-workspace',
    workspaceName: 'Target Workspace',
    snapshotId: moduleSnapshot.id,
    contentHash: moduleSnapshot.contentHash,
    moduleSnapshot,
    languageIds: ['csharp'],
    freshness: 'current',
    root,
    diagnostics: [],
  };
}

function migrationSelection(snapshot: TargetWorkspaceSnapshot): TargetWorkspaceMigrationSelection {
  const selection = {
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    nodeId: 'node:callable:pay',
    entityId: 'callable:pay',
  };
  return {
    workspaceId: snapshot.workspaceId,
    targetWorkspaceSnapshotId: snapshot.snapshotId,
    targetWorkspaceSnapshotHash: snapshot.contentHash,
    selection,
    target: {
      schemaVersion: migrationReferenceSchemaVersion,
      id: `migration-target:${snapshot.snapshotId}:callable:pay`,
      workspaceId: snapshot.workspaceId,
      targetWorkspaceSnapshotId: snapshot.snapshotId,
      targetWorkspaceSnapshotHash: snapshot.contentHash,
      lineage: { ...snapshot.moduleSnapshot.lineage },
      entity: {
        entityId: 'callable:pay',
        fileId: 'file:payment',
        languageId: 'csharp',
        kind: 'method',
        name: 'Pay',
        qualifiedName: 'PaymentService.Pay',
        path: 'src/PaymentService.cs',
        signature: 'Task Pay()',
        fileContentHash: artifactHash,
        declarationIdentity: {
          kind: 'declaration',
          contentHash: artifactHash,
          schemaVersion: 'test-declaration/v1',
          providerId: 'test-csharp-adapter',
          providerVersion: '1.0.0',
        },
      },
      route: javaToCsharpRouteRef,
      allowedModificationPaths: ['src/PaymentService.cs'],
      contentHash: artifactHash,
    },
    module: {
      catalogId: 'catalog:target',
      catalogHash: artifactHash,
      moduleId: 'payments',
      moduleName: '支付模块',
    },
    moduleMapping: {
      mappingRunId: 'mapping-run:payments',
      sourceCatalog: {
        repositoryId: 'history-repository',
        repositoryContentHash: artifactHash,
        unifiedRepositoryIrId: 'ir:history',
        unifiedRepositoryIrHash: artifactHash,
        moduleCatalogId: 'catalog:history',
        moduleCatalogHash: artifactHash,
        moduleReviewId: 'review:history',
        moduleReviewHash: artifactHash,
      },
      targetCatalog: { ...snapshot.moduleSnapshot.lineage },
      mappingProposalId: 'mapping-proposal:payments',
      mappingProposalHash: artifactHash,
      mappingReviewId: 'mapping-review:payments',
      mappingReviewHash: artifactHash,
      executionOverlayId: 'mapping-overlay:payments',
      executionOverlayHash: artifactHash,
      runtimeCapabilitySnapshot,
      route: javaToCsharpRouteRef,
      groupIds: ['group:payments'],
      mappingIds: ['mapping:payments'],
      sourceModuleIds: ['history-payments'],
      targetModuleIds: ['payments'],
      sourceEntityIds: ['history:pay'],
      targetEntityIds: ['callable:pay'],
    },
    routeOptions: [{ route: javaToCsharpRoute, warnings: [] }],
  };
}

function initPayload(input: Partial<PanelInitPayload> = {}): PanelInitPayload {
  return {
    workspaceRoot: 'E:/target-workspace',
    repositoryStatuses: [],
    serviceStatus: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB',
    adaptationProvider: 'DeepSeek',
    ...input,
  };
}

describe('01B target workspace Webview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let posted: WebviewToHostMessage[];

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    posted = [];
    window.acquireVsCodeApi = () => ({
      postMessage(message: unknown) {
        posted.push(message as WebviewToHostMessage);
      },
      getState: () => undefined,
      setState: () => undefined,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function send(message: HostToWebviewMessage): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: message }));
    });
  }

  async function click(element: Element | null): Promise<void> {
    expect(element).not.toBeNull();
    await act(async () => {
      (element as HTMLElement).click();
    });
  }

  it('keeps the legacy single-target INIT flow compatible', async () => {
    await send({ type: 'INIT', payload: initPayload({ target }) });

    expect(container.textContent).toContain('迁移目标');
    expect(container.textContent).toContain('Pay');
    expect(container.textContent).toContain('检索相似实现');
    expect(posted[0]).toEqual({ type: 'READY' });
  });

  it('renders a reviewed module tree, five-state counts, evidence, and bounded intents', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });

    expect(container.textContent).toContain('01B 目标工作区模块划分');
    expect(container.textContent).toContain('支付模块');
    expect(container.textContent).toContain('待实现 1');
    expect(container.querySelector('[data-node-id="node:module:payments"]')?.textContent)
      .toContain('1/2');
    expect(container.textContent).toContain('不适用 1');

    await click(container.querySelector('[aria-label="展开 PaymentService.cs"]'));
    await click(container.querySelector('[aria-label="展开 PaymentService"]'));
    await click(container.querySelector('[data-node-id="node:callable:pay"] .target-workspace-tree-main'));

    expect(posted.at(-1)).toEqual({
      type: 'SELECT_TARGET_ENTITY',
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      nodeId: 'node:callable:pay',
      entityId: 'callable:pay',
    });
    expect(container.textContent).toContain('explicit-not-implemented');
    expect(container.textContent).toContain('Evidence for callable:pay');
    expect(container.textContent).toContain('不证明业务行为');

    await click(container.querySelector('.target-start-action'));
    expect(posted.at(-1)).toMatchObject({
      type: 'START_TARGET_TRANSLATION',
      entityId: 'callable:pay',
      contentHash: snapshot.contentHash,
    });

    await click(container.querySelector('.target-refresh-action'));
    expect(posted.at(-1)).toEqual({
      type: 'REFRESH_TARGET_WORKSPACE',
      expectedSnapshotId: snapshot.snapshotId,
      expectedContentHash: snapshot.contentHash,
    });
  });

  it('does not emit selection/start intents for an ineligible node or a stale snapshot', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });
    await click(container.querySelector('[aria-label="展开 PaymentService.cs"]'));
    await click(container.querySelector('[aria-label="展开 PaymentService"]'));

    const beforeIneligible = posted.length;
    await click(container.querySelector('[data-node-id="node:callable:contract"] .target-workspace-tree-main'));
    expect(posted).toHaveLength(beforeIneligible);
    expect((container.querySelector('.target-start-action') as HTMLButtonElement).disabled).toBe(true);

    await click(container.querySelector('[data-node-id="node:callable:pay"] .target-workspace-tree-main'));
    await send({
      type: 'TARGET_WORKSPACE_INVALIDATED',
      invalidation: {
        snapshotId: snapshot.snapshotId,
        contentHash: snapshot.contentHash,
        reason: '工作区文件已经变化。',
        detectedAt: '2026-09-02T01:00:00.000Z',
      },
    });
    const beforeStaleStart = posted.length;
    expect(container.textContent).toContain('目标工作区快照已失效');
    expect((container.querySelector('.target-start-action') as HTMLButtonElement).disabled).toBe(true);
    await click(container.querySelector('.target-start-action'));
    expect(posted).toHaveLength(beforeStaleStart);
  });

  it('accepts a host-resolved eligible target only for the current snapshot', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });
    const selectedMessage = {
      type: 'TARGET_ENTITY_SELECTED' as const,
      selection: {
        snapshotId: snapshot.snapshotId,
        contentHash: snapshot.contentHash,
        nodeId: 'node:callable:pay',
        entityId: 'callable:pay',
      },
      target,
      migrationSelection: migrationSelection(snapshot),
    };
    await send({
      ...selectedMessage,
      activateWorkflow: false,
    });

    expect(container.textContent).toContain('目标工作区模块划分');
    expect(container.textContent).not.toContain('检索相似实现');

    await send({ ...selectedMessage, activateWorkflow: true });

    expect(container.textContent).toContain('检索相似实现');
    expect(container.textContent).not.toContain('目标工作区模块划分');
  });

  it('shows the exact candidate route and blocks an undeclared source language', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });
    await send({
      type: 'TARGET_ENTITY_SELECTED',
      selection: migrationSelection(snapshot).selection,
      target,
      migrationSelection: migrationSelection(snapshot),
      activateWorkflow: true,
    });
    await click(container.querySelector('.primary-action'));
    await send({
      type: 'SEARCH_RESULT',
      candidates: [candidate('go-pay', 'Go'), candidate('java-pay', 'Java')],
    });

    await click(container.querySelectorAll('.candidate-item')[0] ?? null);
    expect(container.textContent).toContain('Go → csharp');
    expect(container.textContent).toContain('当前语言对无可执行路线');
    expect((container.querySelector('.decision-card .primary-action') as HTMLButtonElement).disabled)
      .toBe(true);

    await click(container.querySelectorAll('.candidate-item')[1] ?? null);
    expect(container.textContent).toContain('Java → csharp');
    expect(container.textContent).toContain('route:java-to-csharp@1.0.0');
    const adapt = container.querySelector('.decision-card .primary-action') as HTMLButtonElement;
    expect(adapt.disabled).toBe(false);
    await click(adapt);
    expect(posted.at(-1)).toEqual({ type: 'START_ADAPT', decisionNotes: '' });
  });

  it('validates snapshot-bound intents and rejects Webview-supplied paths', () => {
    expect(isWebviewToHostMessage({
      type: 'SELECT_TARGET_ENTITY',
      snapshotId: 'target-snapshot-1',
      contentHash: snapshotHash,
      nodeId: 'node:callable:pay',
      entityId: 'callable:pay',
    })).toBe(true);
    expect(isWebviewToHostMessage({
      type: 'SELECT_TARGET_ENTITY',
      snapshotId: 'target-snapshot-1',
      contentHash: snapshotHash,
      nodeId: 'node:callable:pay',
      entityId: 'callable:pay',
      path: '../../outside.cs',
    })).toBe(false);
    expect(isWebviewToHostMessage({
      type: 'START_TARGET_TRANSLATION',
      snapshotId: 'target-snapshot-1',
      contentHash: 'not-a-content-hash',
      nodeId: 'node:callable:pay',
      entityId: 'callable:pay',
    })).toBe(false);
  });
});
