import type {
  RepositoryModuleCatalog,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  buildTargetWorkspaceModuleSnapshot,
  createEntityImplementationAssessment,
} from '@forexplore/workflow-core';
import { describe, expect, it } from 'vitest';
import type {
  TargetWorkspaceEntityContext,
  TargetWorkspaceHostRecord,
} from './target-workspace-host';
import type { TargetWorkspaceTreeNode } from './protocol/messages';
import {
  assertTargetWorkspaceSelection,
  findTargetWorkspaceTreeNode,
  moduleTargetFromTargetWorkspaceContext,
  projectTargetWorkspace,
} from './target-workspace-projection';

const NOW = '2026-09-02T12:00:00.000Z';
const hash = (value: string) => value.repeat(64).slice(0, 64);

function fixture() {
  const file = {
    id: 'file-service',
    path: 'src/PaymentService.cs',
    contentHash: hash('a'),
    role: 'source' as const,
    languageId: 'csharp',
    projectIds: [],
  };
  const type = {
    id: 'type-payment',
    kind: 'type' as const,
    name: 'PaymentService',
    qualifiedName: 'Target.PaymentService',
    languageId: 'csharp',
    fileId: file.id,
    signature: 'public class PaymentService',
    range: { path: file.path, startLine: 1, startColumn: 1, endLine: 6, endColumn: 1 },
    attributes: { staticSymbolKind: 'class' },
  };
  const pending = {
    id: 'call-pay',
    kind: 'callable' as const,
    name: 'Pay',
    qualifiedName: 'Target.PaymentService.Pay',
    languageId: 'csharp',
    fileId: file.id,
    containerEntityId: type.id,
    signature: 'public void Pay()',
    range: { path: file.path, startLine: 2, startColumn: 3, endLine: 2, endColumn: 53 },
    attributes: { staticSymbolKind: 'method' },
  };
  const ready = {
    ...pending,
    id: 'call-status',
    name: 'Status',
    qualifiedName: 'Target.PaymentService.Status',
    signature: 'public string Status()',
    range: { path: file.path, startLine: 3, startColumn: 3, endLine: 3, endColumn: 40 },
  };
  const ir: UnifiedRepositoryIR = {
    schemaVersion: '1.1',
    id: 'target-ir',
    repositoryId: 'target-repository',
    profileId: 'target-profile',
    repositoryContentHash: hash('1'),
    sourceShardIds: ['target-shard'],
    capabilities: ['file-inventory', 'symbol-index', 'api-surface'],
    files: [file],
    entities: [type, pending, ready],
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['csharp'],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: hash('2'),
    producer: { kind: 'ingestion-host', id: 'fixture' },
    createdAt: NOW,
  };
  const module = (id: string, name: string, entityIds: string[]) => ({
    id,
    name,
    kind: 'application-service' as const,
    description: name,
    responsibilities: ['payments'],
    businessCapabilities: ['payments'],
    fileIds: [file.id],
    entityIds,
    entryPointEntityIds: entityIds.filter((entityId) => entityId.startsWith('call-')),
    publicApiEntityIds: entityIds.filter((entityId) => entityId.startsWith('call-')),
    boundaryRationale: 'fixture',
    evidenceRefs: [],
  });
  const catalog: RepositoryModuleCatalog = {
    schemaVersion: '1.1',
    id: 'target-catalog',
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: 'target-proposal',
    sourceProposalHash: hash('3'),
    status: 'active',
    modules: [
      module('payments', 'Payments', [type.id, pending.id, ready.id]),
      module('shared-view', 'Shared view', []),
    ],
    assignments: [{
      fileId: file.id,
      moduleIds: ['payments', 'shared-view'],
      kind: 'shared',
      rationale: 'shared fixture',
      evidenceRefs: [],
    }],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [file.id],
    reviewId: 'target-review',
    reviewHash: hash('4'),
    contentHash: hash('5'),
    producer: { kind: 'ingestion-host', id: 'fixture' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const lineage = {
    repositoryId: ir.repositoryId,
    repositoryContentHash: ir.repositoryContentHash,
    unifiedRepositoryIrId: ir.id,
    unifiedRepositoryIrHash: ir.contentHash,
  };
  const assessments = [
    { entity: pending, state: 'unimplemented' as const, basis: 'explicit-stub' as const },
    { entity: ready, state: 'implemented' as const, basis: 'syntactic-body' as const },
  ].map(({ entity, state, basis }) => createEntityImplementationAssessment({
    draft: {
      entityId: entity.id,
      fileId: file.id,
      bodyHash: hash(entity.id === pending.id ? '6' : '7'),
      state,
      basis,
      reasonCodes: [state === 'unimplemented' ? 'EXPLICIT_STUB' : 'BODY_PRESENT'],
      evidenceRefs: [{ id: `evidence:${entity.id}`, kind: 'syntactic-analysis' }],
      detector: { id: 'fixture-csharp', version: '1.0.0', languageId: 'csharp' },
    },
    lineage,
    createdAt: NOW,
  }));
  const snapshot = buildTargetWorkspaceModuleSnapshot({
    ir,
    catalog,
    assessments,
    producer: { kind: 'ingestion-host', id: 'target-host' },
    createdAt: NOW,
  });
  const record = {
    role: 'target-workspace' as const,
    workspaceId: 'workspace-id',
    repositoryRoot: 'C:\\target',
    stage: 'reviewed' as const,
    latest: { analysis: { snapshotId: 'static-snapshot' }, ir } as TargetWorkspaceHostRecord['latest'],
    readiness: { ready: true, requiredCapabilities: [], blockingIssues: [], missingOptionalCapabilities: [] },
    constraints: [],
    accepted: {
      analysis: { snapshotId: 'static-snapshot' } as TargetWorkspaceHostRecord['accepted'] extends infer _T
        ? TargetWorkspaceHostRecord['latest']['analysis']
        : never,
      ir,
      proposal: {} as NonNullable<TargetWorkspaceHostRecord['accepted']>['proposal'],
      review: {} as NonNullable<TargetWorkspaceHostRecord['accepted']>['review'],
      catalog,
      snapshot,
    },
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies TargetWorkspaceHostRecord;
  return { record, ir, catalog, snapshot, file, pending, ready };
}

describe('target workspace UI projection', () => {
  it('projects reviewed module/file/type/callable nodes and marks shared aliases', () => {
    const { record, pending, ready } = fixture();
    const projection = projectTargetWorkspace({ record, workspaceName: 'Target Payments' });
    expect(projection).toMatchObject({
      workspaceName: 'Target Payments',
      snapshotId: record.accepted!.snapshot!.id,
      freshness: 'current',
      languageIds: ['csharp'],
    });
    const pendingNodes = flatten(projection.root).filter((node) => node.entityId === pending.id);
    const readyNodes = flatten(projection.root).filter((node) => node.entityId === ready.id);
    expect(pendingNodes).toHaveLength(2);
    expect(pendingNodes[0]).toMatchObject({ eligibleForTranslation: true });
    expect(pendingNodes[1]?.aliasOfNodeId).toBe(pendingNodes[0]?.nodeId);
    expect(readyNodes.every((node) => !node.eligibleForTranslation)).toBe(true);
  });

  it('rejects stale or forged selection identities before resolving a target', () => {
    const { record, pending } = fixture();
    const projection = projectTargetWorkspace({ record });
    const node = flatten(projection.root).find((candidate) =>
      candidate.entityId === pending.id && !candidate.aliasOfNodeId,
    )!;
    expect(assertTargetWorkspaceSelection(projection, {
      snapshotId: projection.snapshotId,
      contentHash: projection.contentHash,
      nodeId: node.nodeId,
      entityId: pending.id,
    })).toBe(node);
    expect(() => assertTargetWorkspaceSelection(projection, {
      snapshotId: projection.snapshotId,
      contentHash: projection.contentHash,
      nodeId: node.nodeId,
      entityId: 'forged-entity',
    })).toThrow(/Host-owned tree/);
    expect(() => assertTargetWorkspaceSelection(projection, {
      snapshotId: projection.snapshotId,
      contentHash: hash('f'),
      nodeId: node.nodeId,
      entityId: pending.id,
    })).toThrow(/stale/);
    expect(findTargetWorkspaceTreeNode(projection.root, node.nodeId)).toBe(node);
  });

  it('converts only a revalidated C# callable to the legacy symbol target', () => {
    const { record, ir, catalog, snapshot, file, pending } = fixture();
    const assessment = snapshot.assessments.find((item) => item.entityId === pending.id)!;
    const context: TargetWorkspaceEntityContext = {
      role: 'target-workspace',
      workspaceId: record.workspaceId,
      snapshotId: snapshot.id,
      snapshot,
      ir,
      catalog,
      entity: pending,
      file,
      module: catalog.modules[0],
      assessment,
    };
    expect(moduleTargetFromTargetWorkspaceContext(context)).toEqual({
      id: pending.id,
      name: 'Pay',
      kind: 'function',
      path: file.path,
      language: 'C#',
      signature: pending.signature,
      line: 2,
      implementationStatus: 'unimplemented',
    });
  });
});

function flatten(root: TargetWorkspaceTreeNode): TargetWorkspaceTreeNode[] {
  return [root, ...root.children.flatMap(flatten)];
}
