import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  EntityImplementationAssessment,
  MigrationRouteDescriptor,
  SearchCandidateV2,
  SourceImplementationBundleV2,
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
import { isHostToWebviewMessage, isWebviewToHostMessage } from '../../src/protocol/messages';
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

function unavailableRoute(
  id: string,
  sourceLanguageId: string,
  targetLanguageId: string,
): MigrationRouteDescriptor {
  const reason = 'behavior-verifier-execution-disabled';
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id,
    name: `${sourceLanguageId} to ${targetLanguageId}`,
    version: '2.0.0',
    sourceLanguageId,
    targetLanguageId,
    strategy: 'translate',
    stages: [{
      stage: 'behavior-validation',
      providerId: 'forexplore.translation-verifier.differential',
      providerVersion: '1.0.0',
      capabilities: ['migration-validation'],
      availability: { status: 'unavailable', reasonCodes: [reason] },
    }],
    availability: {
      status: 'unavailable',
      reasonCodes: [`behavior-validation:${reason}`],
    },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: `${id}.policy`,
      routeId: id,
      routeVersion: '2.0.0',
      checks: [{
        id: 'behavior',
        label: 'Independent behavior check',
        phase: 'behavior',
        required: true,
        verifierId: 'forexplore.translation-verifier.differential',
      }],
    },
  };
}

const unavailableRuntimeCapabilities = materializeMigrationRuntimeCapabilitySnapshot({
  routes: [
    unavailableRoute('route:java-to-csharp-unavailable', 'java', 'csharp'),
    unavailableRoute('route:typescript-to-python-unavailable', 'typescript', 'python'),
    unavailableRoute('route:python-to-typescript-unavailable', 'python', 'typescript'),
  ],
  createdAt: '2026-09-02T00:00:00.000Z',
});

const blockedEligibility = {
  status: 'blocked' as const,
  routeOptions: [],
  reasonCodes: ['aggregate-node'],
  summary: '请选择可调用实体。',
};

function candidate(id: string, languageId: string): SearchCandidateV2 {
  return {
    schemaVersion: '2.0',
    id,
    requestId: 'search-request:test',
    requestHash: artifactHash,
    targetId: 'migration-target:test',
    targetHash: artifactHash,
    route: javaToCsharpRouteRef,
    indexGeneration: {
      repositoryId: 'history-repository',
      id: 'index-generation:1',
      generation: 1,
      contentHash: artifactHash,
      sourceCatalogId: 'catalog:history',
      sourceCatalogHash: artifactHash,
    },
    indexedDocumentId: `document:${id}`,
    indexedDocumentHash: artifactHash,
    candidate: {
      schemaVersion: '2.0',
      id: `candidate-ref:${id}`,
      lineage: {
        repositoryId: 'history-repository',
        repositoryContentHash: artifactHash,
        unifiedRepositoryIrId: 'ir:history',
        unifiedRepositoryIrHash: artifactHash,
        moduleCatalogId: 'catalog:history',
        moduleCatalogHash: artifactHash,
        moduleReviewId: 'review:history',
        moduleReviewHash: artifactHash,
      },
      entity: {
        entityId: `history:${id}`,
        fileId: `file:${id}`,
        languageId,
        kind: 'function',
        name: id,
        path: `src/${id}`,
        signature: 'pay(request)',
      },
      sourceBundleId: `bundle:${id}`,
      sourceBundleHash: artifactHash,
      license: 'internal',
      contentHash: artifactHash,
    },
    sourceBundle: { id: `bundle:${id}`, contentHash: artifactHash },
    title: `${languageId} payment candidate`,
    summary: 'Historical payment implementation.',
    score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.7 },
    preview: 'pay(request)',
    compatibility: [],
    risks: [],
    createdAt: '2026-09-02T00:00:00.000Z',
    contentHash: artifactHash,
  };
}

function sourceBundle(item: SearchCandidateV2): SourceImplementationBundleV2 {
  return {
    schemaVersion: '2.0',
    id: item.sourceBundle.id,
    candidate: item.candidate,
    lineage: item.candidate.lineage,
    primaryEntityId: item.candidate.entity.entityId,
    helperEntityIds: [],
    testEntityIds: [],
    dependencyIds: [],
    files: [{
      fileId: item.candidate.entity.fileId!,
      path: item.candidate.entity.path!,
      languageId: item.candidate.entity.languageId,
      role: 'primary',
      content: 'pay(request)',
      contentHash: artifactHash,
    }],
    producer: { providerId: 'test-retrieval', providerVersion: '1.0.0' },
    createdAt: '2026-09-02T00:00:00.000Z',
    contentHash: item.sourceBundle.contentHash,
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
  const targetWorkspace = input.targetWorkspace;
  return {
    workspaceRoot: 'E:/target-workspace',
    settings: { repositoryPaths: [], topK: 4 },
    moduleExplorer: {
      generatedAt: '2026-09-02T00:00:00.000Z',
      target: {
        id: 'target-workspace',
        mode: 'target',
        name: 'Target Workspace',
        rootLabel: 'E:/target-workspace',
        lifecycle: {
          stage: 'reviewed',
          label: '已审目标目录',
          message: 'ready',
          ready: true,
          publicationActive: false,
        },
        ...(targetWorkspace
          ? {
              id: targetWorkspace.workspaceId,
              name: targetWorkspace.workspaceName,
              snapshotId: targetWorkspace.snapshotId,
              stats: {
                modules: targetWorkspace.root.children.filter((node) => node.kind === 'module').length,
                files: 1,
                types: 1,
                methods: targetWorkspace.moduleSnapshot.workspaceCounts.eligible,
                implemented: targetWorkspace.moduleSnapshot.workspaceCounts.implemented,
                unimplemented: targetWorkspace.moduleSnapshot.workspaceCounts.unimplemented,
                partial: targetWorkspace.moduleSnapshot.workspaceCounts.partial,
                unknown: targetWorkspace.moduleSnapshot.workspaceCounts.unknown,
                notApplicable: targetWorkspace.moduleSnapshot.workspaceCounts.notApplicable,
                dependencies: 0,
              },
              tree: targetWorkspace.root.children.map(testExplorerNode),
            }
          : {
              stats: {
                modules: 0,
                files: 0,
                types: 0,
                methods: 0,
                implemented: 0,
                unimplemented: 0,
                partial: 0,
                unknown: 0,
                notApplicable: 0,
                dependencies: 0,
              },
              tree: [],
            }),
        summary: { exists: false, path: '.forexplore/target-workspaces' },
      },
      history: [],
    },
    repositoryStatuses: [],
    serviceStatus: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB',
    adaptationProvider: 'DeepSeek',
    ...input,
  };
}

function testExplorerNode(node: TargetWorkspaceTreeNode): import('../../src/ui-types').ModuleExplorerNode {
  const state = node.assessment?.state ?? node.rollup?.state;
  return {
    id: node.nodeId,
    name: node.name,
    kind: node.kind === 'module' || node.kind === 'file'
      ? node.kind
      : node.kind === 'callable' ? 'method' : 'class',
    ...(node.path ? { path: node.path } : {}),
    ...(node.languageId ? { language: node.languageId } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
    ...(node.kind === 'callable'
      ? {
          targetId: node.nodeId,
          implementationStatus: state === 'implemented' || state === 'unimplemented'
            ? state
            : 'unknown',
        }
      : {}),
    children: node.children.map(testExplorerNode),
  };
}

function historyWorkspace(id: string, name: string): import('../../src/ui-types').ModuleWorkspacePresentation {
  const catalogId = `catalog:${id}`;
  return {
    id,
    mode: 'history',
    name,
    rootLabel: `E:/history/${name}`,
    lifecycle: {
      stage: 'ready',
      label: '模块知识已发布',
      message: 'ready',
      ready: true,
      publicationActive: true,
      nextAction: 'withdraw-history-publication',
      nextActionLabel: '撤回检索发布',
    },
    catalog: { id: catalogId, contentHash: artifactHash, status: 'active' },
    stats: {
      modules: 1,
      files: 0,
      types: 0,
      methods: 0,
      implemented: 0,
      unimplemented: 0,
      partial: 0,
      unknown: 0,
      notApplicable: 0,
      dependencies: 0,
    },
    summary: { exists: true, path: '.forexplore/ingestion', approvalsCurrent: true, moduleCount: 1 },
    tree: [{
      id: `${catalogId}:module:payments`,
      name: `${name} Payments`,
      kind: 'module',
      historyModule: {
        repositoryRegistrationId: id,
        repositoryId: `repository:${id}`,
        catalogId,
        catalogHash: artifactHash,
        moduleId: 'payments',
      },
      children: [],
    }],
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

  it('rejects a V1 target and accepts only a V2 reviewed target', async () => {
    expect(isHostToWebviewMessage({
      type: 'INIT',
      payload: initPayload({
        target: {
          id: 'legacy-target',
          name: 'Pay',
          kind: 'function',
          path: 'src/PaymentService.cs',
          language: 'C#',
          signature: 'Pay()',
        } as never,
      }),
    })).toBe(false);
    const snapshot = targetWorkspaceSnapshot();
    await send({
      type: 'INIT',
      payload: initPayload({ target: migrationSelection(snapshot).target }),
    });
    expect(container.textContent).toContain('迁移目标');
    expect(container.textContent).toContain('Pay');
    expect(container.textContent).toContain('java → csharp');
  });

  it('renders a reviewed module tree, five-state counts, evidence, and bounded intents', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });

    expect(container.textContent).toContain('01B 目标工作区模块划分');
    expect(container.textContent).toContain('支付模块');
    expect(container.querySelector('.status-mark.is-unimplemented')).not.toBeNull();
    expect(container.querySelector('[data-node-id="node:module:payments"]')).not.toBeNull();

    await click(container.querySelector('[aria-label="展开 PaymentService"]'));
    const beforeSelection = posted.length;
    await click(container.querySelector('[data-node-id="node:callable:pay"] .tree-select'));

    expect(posted.slice(beforeSelection).filter((message) => message.type === 'SELECT_TARGET_ENTITY'))
      .toHaveLength(1);
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

    await click(container.querySelector('[aria-label="刷新 Host 模块状态"]'));
    expect(posted.at(-1)).toEqual({
      type: 'REFRESH_TARGET_WORKSPACE',
      expectedSnapshotId: snapshot.snapshotId,
      expectedContentHash: snapshot.contentHash,
    });
  });

  it('shows all unavailable exact routes and the service-owned verifier reason', async () => {
    const snapshot = targetWorkspaceSnapshot();
    snapshot.runtimeCapabilitySnapshot = unavailableRuntimeCapabilities;
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });

    const capabilities = container.querySelector('[aria-label="运行时迁移能力"]');
    expect(capabilities?.textContent).toContain('java → csharp');
    expect(capabilities?.textContent).toContain('typescript → python');
    expect(capabilities?.textContent).toContain('python → typescript');
    expect(capabilities?.textContent?.match(/behavior-verifier-execution-disabled/g))
      .toHaveLength(3);
  });

  it('does not emit selection/start intents for an ineligible node or a stale snapshot', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });
    await click(container.querySelector('[aria-label="展开 PaymentService"]'));

    const beforeIneligible = posted.length;
    await click(container.querySelector('[data-node-id="node:callable:contract"] .tree-select'));
    expect(posted).toHaveLength(beforeIneligible);
    expect((container.querySelector('.target-start-action') as HTMLButtonElement).disabled).toBe(true);

    await click(container.querySelector('[data-node-id="node:callable:pay"] .tree-select'));
    await send({
      type: 'TARGET_WORKSPACE_REFRESHING',
      previousSnapshotId: snapshot.snapshotId,
      previousContentHash: snapshot.contentHash,
    });
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
    const refreshButton = container.querySelector('[aria-label="刷新 Host 模块状态"]') as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(false);
    await click(refreshButton);
    expect(posted.at(-1)).toEqual({ type: 'REFRESH_MODULE_EXPLORER' });
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
      target: migrationSelection(snapshot).target,
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

    const beforeReselect = posted.length;
    await click(container.querySelector('[aria-label="展开 PaymentService"]'));
    await click(container.querySelector('[data-node-id="node:callable:refund"] .tree-select'));
    expect(posted).toHaveLength(beforeReselect);
    expect(container.textContent).toContain('当前迁移已经绑定目标实体');
  });

  it('keeps a picked repository path in the settings draft until explicit save', async () => {
    await send({ type: 'INIT', payload: initPayload() });
    await click([...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('设置')) ?? null);
    await click([...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('添加第一个路径')) ?? null);
    expect(posted.at(-1)).toEqual({ type: 'PICK_REPOSITORY_PATH' });

    await send({ type: 'REPOSITORY_PATH_PICKED', path: 'E:/history/orders' });
    expect((container.querySelector('.repository-path-row input') as HTMLInputElement).value)
      .toBe('E:/history/orders');
    expect(posted.some((message) => message.type === 'SAVE_SETTINGS')).toBe(false);

    await click([...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('保存设置')) ?? null);
    expect(posted.at(-1)).toEqual({
      type: 'SAVE_SETTINGS',
      settings: { repositoryPaths: ['E:/history/orders'], topK: 4 },
    });
  });

  it('wires history repository, module, and lifecycle actions to Host intents', async () => {
    const payload = initPayload();
    payload.moduleExplorer.history = [
      historyWorkspace('history:orders', 'Orders'),
      historyWorkspace('history:billing', 'Billing'),
    ];
    await send({ type: 'INIT', payload });
    await click(container.querySelector('.workspace-switch button:nth-child(2)'));

    const picker = container.querySelector('.history-picker select') as HTMLSelectElement;
    picker.value = 'history:billing';
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
    expect(posted.at(-1)).toEqual({
      type: 'SELECT_HISTORY_REPOSITORY',
      repositoryRegistrationId: 'history:billing',
    });
    await send({
      type: 'HISTORY_REPOSITORY_SELECTED',
      repositoryRegistrationId: 'history:billing',
    });

    await click(container.querySelector('.history-module-card'));
    expect(posted.at(-1)).toMatchObject({
      type: 'SELECT_HISTORY_MODULE',
      repositoryRegistrationId: 'history:billing',
      moduleId: 'payments',
    });

    await click([...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('撤回检索发布')) ?? null);
    expect(posted.at(-1)).toEqual({
      type: 'RUN_MODULE_WORKSPACE_ACTION',
      workspaceId: 'history:billing',
      action: 'withdraw-history-publication',
    });
  });

  it('shows the exact candidate route and blocks an undeclared source language', async () => {
    const snapshot = targetWorkspaceSnapshot();
    await send({ type: 'INIT', payload: initPayload({ targetWorkspace: snapshot }) });
    await send({
      type: 'TARGET_ENTITY_SELECTED',
      selection: migrationSelection(snapshot).selection,
      target: migrationSelection(snapshot).target,
      migrationSelection: migrationSelection(snapshot),
      activateWorkflow: true,
    });
    await click(container.querySelector('.primary-action'));
    await send({
      type: 'SEARCH_RESULT',
      candidates: [candidate('go-pay', 'go'), candidate('java-pay', 'java')],
    });

    await click(container.querySelectorAll('.candidate-item')[0] ?? null);
    expect(container.textContent).toContain('go → csharp');
    expect(container.textContent).toContain('没有与当前源/目标语言精确匹配的可执行路线');
    expect((container.querySelector('.decision-card .primary-action') as HTMLButtonElement).disabled)
      .toBe(true);

    await click(container.querySelectorAll('.candidate-item')[1] ?? null);
    expect(container.textContent).toContain('java → csharp');
    expect(container.textContent).toContain('route:java-to-csharp@1.0.0');
    let adapt = container.querySelector('.decision-card .primary-action') as HTMLButtonElement;
    expect(adapt.disabled).toBe(true);
    const javaCandidate = candidate('java-pay', 'java');
    await send({
      type: 'CANDIDATE_SELECTED',
      candidateId: javaCandidate.id,
      sourceBundle: sourceBundle(javaCandidate),
    });
    adapt = container.querySelector('.decision-card .primary-action') as HTMLButtonElement;
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
