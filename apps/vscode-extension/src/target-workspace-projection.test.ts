import type {
  ImplementationState,
  MigrationRouteResolution,
  RepositoryModuleCatalog,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  migrationRouteSchemaVersion,
  validationPolicySchemaVersion,
} from '@forexplore/contracts';
import {
  buildTargetWorkspaceModuleSnapshot,
  createMigrationRouteSnapshotRef,
  createEntityImplementationAssessment,
  materializeMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';
import { describe, expect, it } from 'vitest';
import type {
  TargetWorkspaceEntityContext,
  TargetWorkspaceHostRecord,
} from './target-workspace-host';
import type {
  ModuleMappingRunBinding,
  TargetWorkspaceTreeNode,
} from './protocol/messages';
import {
  assertTargetWorkspaceSelection,
  findTargetWorkspaceTreeNode,
  migrationSelectionFromTargetWorkspaceContext,
  moduleTargetFromTargetWorkspaceContext,
  projectTargetWorkspace,
} from './target-workspace-projection';

const NOW = '2026-09-02T12:00:00.000Z';
const hash = (value: string) => value.repeat(64).slice(0, 64);

function fixture(
  targetLanguageId = 'csharp',
  pendingState: ImplementationState = 'unimplemented',
) {
  const extension = targetLanguageId === 'python' ? 'py' : targetLanguageId === 'go' ? 'go' : 'cs';
  const file = {
    id: 'file-service',
    path: `src/PaymentService.${extension}`,
    contentHash: hash('a'),
    role: 'source' as const,
    languageId: targetLanguageId,
    projectIds: [],
  };
  const type = {
    id: 'type-payment',
    kind: 'type' as const,
    name: 'PaymentService',
    qualifiedName: 'Target.PaymentService',
    languageId: targetLanguageId,
    fileId: file.id,
    signature: 'public class PaymentService',
    structureIdentity: {
      basis: 'declaration-shape' as const,
      contentHash: hash('0'),
      schemaVersion: 'fixture-structure/v1',
      adapterId: `fixture-${targetLanguageId}`,
      adapterVersion: '1.0.0',
    },
    range: { path: file.path, startLine: 1, startColumn: 1, endLine: 6, endColumn: 1 },
    attributes: { staticSymbolKind: 'class' },
  };
  const pending = {
    id: 'call-pay',
    kind: 'callable' as const,
    name: 'Pay',
    qualifiedName: 'Target.PaymentService.Pay',
    languageId: targetLanguageId,
    fileId: file.id,
    containerEntityId: type.id,
    signature: 'public void Pay()',
    structureIdentity: {
      basis: 'declaration-shape' as const,
      contentHash: hash('8'),
      schemaVersion: 'fixture-structure/v1',
      adapterId: `fixture-${targetLanguageId}`,
      adapterVersion: '1.0.0',
    },
    range: { path: file.path, startLine: 2, startColumn: 3, endLine: 2, endColumn: 53 },
    attributes: { staticSymbolKind: 'method' },
  };
  const ready = {
    ...pending,
    id: 'call-status',
    name: 'Status',
    qualifiedName: 'Target.PaymentService.Status',
    signature: 'public string Status()',
    structureIdentity: {
      ...pending.structureIdentity,
      contentHash: hash('9'),
    },
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
      languageIds: [targetLanguageId],
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
    {
      entity: pending,
      state: pendingState,
      basis: pendingState === 'unknown' ? 'unavailable' as const : 'explicit-stub' as const,
    },
    { entity: ready, state: 'implemented' as const, basis: 'syntactic-body' as const },
  ].map(({ entity, state, basis }) => createEntityImplementationAssessment({
    draft: {
      entityId: entity.id,
      fileId: file.id,
      bodyHash: hash(entity.id === pending.id ? '6' : '7'),
      state,
      basis,
      reasonCodes: [
        state === 'unimplemented'
          ? 'EXPLICIT_STUB'
          : state === 'unknown'
            ? 'DETECTOR_UNAVAILABLE'
            : 'BODY_PRESENT',
      ],
      evidenceRefs: [{ id: `evidence:${entity.id}`, kind: 'syntactic-analysis' }],
      detector: { id: `fixture-${targetLanguageId}`, version: '1.0.0', languageId: targetLanguageId },
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

function supportedRoute(
  sourceLanguageId: string,
  targetLanguageId: string,
): MigrationRouteResolution {
  const id = `route:${sourceLanguageId}-to-${targetLanguageId}`;
  const route = {
    schemaVersion: migrationRouteSchemaVersion,
    id,
    name: `${sourceLanguageId} to ${targetLanguageId}`,
    version: '1.0.0',
    sourceLanguageId,
    targetLanguageId,
    strategy: 'translate' as const,
    stages: [{
      stage: 'translation' as const,
      providerId: 'fixture-adapter',
      providerVersion: '1.0.0',
      capabilities: ['code-translation' as const],
      availability: { status: 'available' as const, reasonCodes: [] },
    }],
    availability: { status: 'available' as const, reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: `policy:${id}`,
      routeId: id,
      routeVersion: '1.0.0',
      checks: [{
        id: 'compile',
        label: 'Compile target',
        phase: 'compile' as const,
        required: true,
        verifierId: 'fixture-compiler',
        verifierVersion: '1.0.0',
      }],
    },
  };
  const runtime = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route], createdAt: NOW });
  const materializedRoute = runtime.routes[0]!;
  return {
    status: 'supported',
    key: { sourceLanguageId, targetLanguageId, strategy: 'translate' },
    route: materializedRoute,
    warnings: [],
  };
}

describe('target workspace UI projection', () => {
  it('projects reviewed module/file/type/callable nodes and marks shared aliases', () => {
    const { record, pending, ready } = fixture();
    const projection = projectTargetWorkspace({
      record,
      workspaceName: 'Target Payments',
      routeResolutions: [supportedRoute('java', 'csharp')],
    });
    expect(projection).toMatchObject({
      workspaceName: 'Target Payments',
      snapshotId: record.accepted!.snapshot!.id,
      freshness: 'current',
      languageIds: ['csharp'],
    });
    const pendingNodes = flatten(projection.root).filter((node) => node.entityId === pending.id);
    const readyNodes = flatten(projection.root).filter((node) => node.entityId === ready.id);
    expect(pendingNodes).toHaveLength(2);
    expect(pendingNodes[0]).toMatchObject({
      kindLabel: '方法',
      migrationEligibility: {
        status: 'eligible',
        targetLanguageId: 'csharp',
      },
    });
    expect(pendingNodes[1]?.aliasOfNodeId).toBe(pendingNodes[0]?.nodeId);
    expect(readyNodes.every((node) => node.migrationEligibility.status === 'blocked')).toBe(true);
  });

  it('rejects stale or forged selection identities before resolving a target', () => {
    const { record, pending } = fixture();
    const projection = projectTargetWorkspace({
      record,
      routeResolutions: [supportedRoute('java', 'csharp')],
    });
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

  it('converts a revalidated callable without forcing C# and retains full lineage', () => {
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
    const projection = projectTargetWorkspace({
      record,
      routeResolutions: [supportedRoute('java', 'csharp')],
    });
    const node = flatten(projection.root).find((item) =>
      item.entityId === pending.id && !item.aliasOfNodeId,
    )!;
    const selection = {
      snapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      nodeId: node.nodeId,
      entityId: node.entityId,
    };
    const route = node.migrationEligibility.routeOptions[0]!.route;
    const runtimeCapabilitySnapshot = materializeMigrationRuntimeCapabilitySnapshot({
      routes: [route],
      createdAt: NOW,
    });
    const routeRef = createMigrationRouteSnapshotRef(runtimeCapabilitySnapshot, route.id);
    const moduleMapping: ModuleMappingRunBinding = {
      mappingRunId: 'mapping-run',
      sourceCatalog: {
        repositoryId: 'source-repository',
        repositoryContentHash: hash('8'),
        unifiedRepositoryIrId: 'source-ir',
        unifiedRepositoryIrHash: hash('9'),
        moduleCatalogId: 'source-catalog',
        moduleCatalogHash: hash('a'),
        moduleReviewId: 'source-review',
        moduleReviewHash: hash('b'),
      },
      targetCatalog: {
        repositoryId: snapshot.lineage.repositoryId,
        ...(snapshot.lineage.repositoryRevision
          ? { repositoryRevision: snapshot.lineage.repositoryRevision }
          : {}),
        repositoryContentHash: snapshot.lineage.repositoryContentHash,
        unifiedRepositoryIrId: snapshot.lineage.unifiedRepositoryIrId,
        unifiedRepositoryIrHash: snapshot.lineage.unifiedRepositoryIrHash,
        moduleCatalogId: snapshot.lineage.moduleCatalogId,
        moduleCatalogHash: snapshot.lineage.moduleCatalogHash,
        moduleReviewId: snapshot.lineage.moduleReviewId,
        moduleReviewHash: snapshot.lineage.moduleReviewHash,
      },
      mappingProposalId: 'mapping-proposal',
      mappingProposalHash: hash('c'),
      mappingReviewId: 'mapping-review',
      mappingReviewHash: hash('d'),
      executionOverlayId: 'mapping-overlay',
      executionOverlayHash: hash('e'),
      runtimeCapabilitySnapshot,
      route: routeRef,
      groupIds: ['mapping-group'],
      mappingIds: ['mapping-entry'],
      sourceModuleIds: ['source-payments'],
      targetModuleIds: ['payments'],
      sourceEntityIds: ['source-pay'],
      targetEntityIds: [pending.id],
    };
    expect(migrationSelectionFromTargetWorkspaceContext(
      context,
      selection,
      node.migrationEligibility.routeOptions,
      moduleMapping,
      node.moduleId,
    )).toMatchObject({
      workspaceId: record.workspaceId,
      targetWorkspaceSnapshotId: snapshot.id,
      selection,
      target: {
        lineage: {
          repositoryId: ir.repositoryId,
          moduleCatalogId: catalog.id,
          moduleReviewId: catalog.reviewId,
        },
        entity: {
          entityId: pending.id,
          fileId: file.id,
          languageId: 'csharp',
          kind: 'method',
        },
      },
      module: { catalogId: catalog.id, moduleId: 'payments' },
      routeOptions: [{ route: { id: 'route:java-to-csharp' } }],
    });
  });

  it('enables a declared Java to Python route and keeps unknown status fail-closed', () => {
    const python = fixture('python');
    const projection = projectTargetWorkspace({
      record: python.record,
      routeResolutions: [supportedRoute('java', 'python')],
    });
    const node = flatten(projection.root).find((item) =>
      item.entityId === python.pending.id && !item.aliasOfNodeId,
    )!;
    expect(node).toMatchObject({
      languageId: 'python',
      migrationEligibility: {
        status: 'eligible',
        targetLanguageId: 'python',
        routeOptions: [{ route: { sourceLanguageId: 'java', targetLanguageId: 'python' } }],
      },
    });
    expect(moduleTargetFromTargetWorkspaceContext({
      role: 'target-workspace',
      workspaceId: python.record.workspaceId,
      snapshotId: python.snapshot.id,
      snapshot: python.snapshot,
      ir: python.ir,
      catalog: python.catalog,
      entity: python.pending,
      file: python.file,
      module: python.catalog.modules[0],
      assessment: python.snapshot.assessments.find((item) => item.entityId === python.pending.id),
    })).toMatchObject({ language: 'Python', path: 'src/PaymentService.py' });

    const unknown = fixture('python', 'unknown');
    const unknownProjection = projectTargetWorkspace({
      record: unknown.record,
      routeResolutions: [supportedRoute('java', 'python')],
    });
    const unknownNode = flatten(unknownProjection.root).find((item) =>
      item.entityId === unknown.pending.id && !item.aliasOfNodeId,
    )!;
    expect(unknownNode.migrationEligibility).toMatchObject({
      status: 'blocked',
      reasonCodes: ['implementation-state-unknown'],
    });
  });

  it('does not infer route support when no capability snapshot is supplied', () => {
    const { record, pending } = fixture('go');
    const projection = projectTargetWorkspace({ record });
    const node = flatten(projection.root).find((item) =>
      item.entityId === pending.id && !item.aliasOfNodeId,
    )!;
    expect(node.migrationEligibility).toMatchObject({
      status: 'blocked',
      targetLanguageId: 'go',
      reasonCodes: ['migration-route-unavailable'],
    });
  });
});

function flatten(root: TargetWorkspaceTreeNode): TargetWorkspaceTreeNode[] {
  return [root, ...root.children.flatMap(flatten)];
}
