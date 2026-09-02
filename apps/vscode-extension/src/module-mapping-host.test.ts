import type {
  MigrationRouteResolution,
  ModuleMappingEntry,
  RepositoryModuleCatalog,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  migrationRouteSchemaVersion,
  repositoryIngestionSchemaVersion,
  validationPolicySchemaVersion,
} from '@forexplore/contracts';
import { materializeMigrationRuntimeCapabilitySnapshot } from '@forexplore/workflow-core';
import { describe, expect, it } from 'vitest';
import {
  ModuleMappingHost,
  type ModuleMappingHostState,
  type ModuleMappingHostStore,
  type ReviewedModuleCatalogHead,
  type ResolvedModuleMappingRoute,
} from './module-mapping-host';

const NOW = '2026-09-02T08:00:00.000Z';

function head(side: 'source' | 'target', moduleIds: string[]): ReviewedModuleCatalogHead {
  const marker = side === 'source' ? 'a' : 'b';
  const languageId = side === 'source' ? 'python' : 'rust';
  const files = moduleIds.map((moduleId) => ({
    id: `${side}-file-${moduleId}`,
    path: `src/${moduleId}.${side === 'source' ? 'py' : 'rs'}`,
    contentHash: marker.repeat(64),
    role: 'source' as const,
    languageId,
    projectIds: [],
  }));
  const entities = moduleIds.map((moduleId) => ({
    id: `${side}-entity-${moduleId}`,
    kind: 'callable' as const,
    name: `${moduleId}_entry`,
    fileId: `${side}-file-${moduleId}`,
    languageId,
  }));
  const ir: UnifiedRepositoryIR = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-ir-v1`,
    repositoryId: `${side}-repository`,
    repositoryRevision: `${side}-revision-v1`,
    profileId: `${side}-profile`,
    repositoryContentHash: marker.repeat(64),
    sourceShardIds: [`${side}-shard`],
    capabilities: ['symbol-index'],
    files,
    entities,
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: files.length,
      analysedFileCount: files.length,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: [languageId],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: (side === 'source' ? 'c' : 'd').repeat(64),
    producer: { kind: 'ingestion-host', id: `${side}-host` },
    createdAt: NOW,
  };
  const catalog: RepositoryModuleCatalog = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-catalog-v1`,
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: `${side}-proposal-v1`,
    sourceProposalHash: (side === 'source' ? 'e' : 'f').repeat(64),
    status: 'active',
    modules: moduleIds.map((moduleId) => ({
      id: moduleId,
      name: moduleId,
      kind: 'business-capability',
      description: `${moduleId} capability`,
      responsibilities: [`${moduleId} responsibility`],
      businessCapabilities: [moduleId],
      fileIds: [`${side}-file-${moduleId}`],
      entityIds: [`${side}-entity-${moduleId}`],
      entryPointEntityIds: [`${side}-entity-${moduleId}`],
      publicApiEntityIds: [],
      boundaryRationale: 'Reviewed canonical boundary.',
      evidenceRefs: [],
    })),
    assignments: moduleIds.map((moduleId) => ({
      fileId: `${side}-file-${moduleId}`,
      moduleIds: [moduleId],
      kind: 'owned',
      rationale: 'Reviewed ownership.',
      evidenceRefs: [],
    })),
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    reviewId: `${side}-review-v1`,
    reviewHash: (side === 'source' ? '1' : '2').repeat(64),
    contentHash: (side === 'source' ? '3' : '4').repeat(64),
    producer: { kind: 'human', id: `${side}-reviewer` },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    workspaceId: `${side}-workspace`,
    ir,
    catalog,
    analysisSnapshotId: `${side}-snapshot-v1`,
    analysisContentHash: marker.repeat(64),
    analysisAdapters: [],
  };
}

const source = head('source', ['s1', 's2', 's3']);
const target = head('target', ['t1', 't2', 't3']);

function mappings(): ModuleMappingEntry[] {
  return [{
    id: 'map-expand',
    cardinality: 'one-to-many',
    sourceModuleIds: ['s1'],
    targetModuleIds: ['t1', 't2'],
    sourceEntityIds: ['source-entity-s1'],
    targetEntityIds: ['target-entity-t1', 'target-entity-t2'],
    rationale: 'One source capability is split in the target.',
    evidenceIds: [],
  }, {
    id: 'map-collapse',
    cardinality: 'many-to-one',
    sourceModuleIds: ['s2', 's3'],
    targetModuleIds: ['t3'],
    sourceEntityIds: ['source-entity-s2', 'source-entity-s3'],
    targetEntityIds: ['target-entity-t3'],
    rationale: 'Two source capabilities converge in the target.',
    evidenceIds: [],
  }];
}

function route(): MigrationRouteResolution {
  const descriptor = {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'route:python-to-rust',
    name: 'Python to Rust',
    version: '1.0.0',
    sourceLanguageId: 'python',
    targetLanguageId: 'rust',
    strategy: 'translate' as const,
    stages: [{
      stage: 'translation' as const,
      providerId: 'fixture-translator',
      providerVersion: '1.0.0',
      capabilities: ['code-translation' as const],
      availability: { status: 'available' as const, reasonCodes: [] },
    }],
    availability: { status: 'available' as const, reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'policy:python-to-rust',
      routeId: 'route:python-to-rust',
      routeVersion: '1.0.0',
      checks: [{
        id: 'compile',
        label: 'Compile',
        phase: 'compile' as const,
        required: true,
        verifierId: 'fixture-compiler',
        verifierVersion: '1.0.0',
      }],
    },
    contentHash: '9'.repeat(64),
  };
  return {
    status: 'supported',
    key: {
      sourceLanguageId: 'python',
      targetLanguageId: 'rust',
      strategy: 'translate',
    },
    route: descriptor,
    warnings: [],
  };
}

function resolvedRoute(): ResolvedModuleMappingRoute {
  const resolution = route();
  if (resolution.status !== 'supported') throw new Error('fixture route must be supported');
  const runtimeCapabilitySnapshot = materializeMigrationRuntimeCapabilitySnapshot({
    routes: [resolution.route],
    createdAt: NOW,
  });
  const materializedRoute = runtimeCapabilitySnapshot.routes[0]!;
  return {
    resolution: {
      ...resolution,
      route: materializedRoute,
    },
    runtimeCapabilitySnapshot,
  };
}

class MemoryStore implements ModuleMappingHostStore {
  value: ModuleMappingHostState | null = null;

  async load(): Promise<ModuleMappingHostState | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(next: ModuleMappingHostState, expectedRevision: number | null): Promise<void> {
    expect(this.value?.revision ?? 0).toBe(expectedRevision ?? 0);
    this.value = structuredClone(next);
  }
}

function harness(input: { omitSource?: boolean; omitTarget?: boolean } = {}) {
  const store = new MemoryStore();
  const heads = new Map<string, ReviewedModuleCatalogHead>([
    [source.workspaceId, structuredClone(source)],
    [target.workspaceId, structuredClone(target)],
  ]);
  if (input.omitSource) heads.delete(source.workspaceId);
  if (input.omitTarget) heads.delete(target.workspaceId);
  let currentRoute = resolvedRoute();
  const host = new ModuleMappingHost({
    store,
    catalogs: {
      async load(_side, workspaceId) {
        const value = heads.get(workspaceId);
        return value ? structuredClone(value) : null;
      },
    },
    routes: {
      async resolve(id, version) {
        const value = structuredClone(currentRoute);
        return value.resolution.route.id === id && value.resolution.route.version === version
          ? value
          : undefined;
      },
    },
    now: () => NOW,
  });
  return {
    host,
    store,
    heads,
    replaceRuntimeSnapshot(snapshot: ResolvedModuleMappingRoute['runtimeCapabilitySnapshot']) {
      currentRoute = { ...currentRoute, runtimeCapabilitySnapshot: structuredClone(snapshot) };
    },
  };
}

async function readyHost() {
  const result = harness();
  const proposal = await result.host.propose({
    sourceWorkspaceId: source.workspaceId,
    targetWorkspaceId: target.workspaceId,
    objective: 'Map reviewed source capabilities to reviewed target capabilities.',
    mappings: mappings(),
    executionGroups: [
      { id: 'group-expand', mappingIds: ['map-expand'], dependsOnGroupIds: [] },
      { id: 'group-collapse', mappingIds: ['map-collapse'], dependsOnGroupIds: ['group-expand'] },
    ],
  });
  const record = await result.host.review({
    recordId: proposal.id,
    expectedProposalId: proposal.proposal.id,
    expectedProposalHash: proposal.proposal.contentHash,
    decision: 'accept',
    reviewerId: 'mapping-reviewer',
    routeId: 'route:python-to-rust',
    routeVersion: '1.0.0',
  });
  return { ...result, record };
}

describe('ModuleMappingHost canonical mainline', () => {
  it('persists reviewed 1:N/N:1 mappings and binds an execution overlay to a run', async () => {
    const { host, store, record } = await readyHost();
    expect(record).toMatchObject({
      stage: 'ready',
      proposal: { mappings: [
        { id: 'map-collapse', cardinality: 'many-to-one' },
        { id: 'map-expand', cardinality: 'one-to-many' },
      ] },
      overlay: {
        mappingProposalHash: record.proposal.contentHash,
        mappingReviewHash: record.review!.contentHash,
        routeId: 'route:python-to-rust',
      },
    });
    const binding = await host.bindTarget({
      targetWorkspaceId: target.workspaceId,
      targetModuleId: 't3',
      targetEntityId: 'target-entity-t3',
      allowedRouteIds: ['route:python-to-rust'],
    });
    const executionContext = await host.executionContext(binding);
    expect(executionContext).toMatchObject({
      runtimeCapabilities: { id: binding.runtimeCapabilitySnapshot.id },
      currentSourceCatalog: { moduleCatalogId: binding.sourceCatalog.moduleCatalogId },
      currentTargetCatalog: { moduleCatalogId: binding.targetCatalog.moduleCatalogId },
      mappingProposal: { id: binding.mappingProposalId },
      mappingReview: { id: binding.mappingReviewId },
      executionOverlay: { id: binding.executionOverlayId },
    });
    expect(binding).toMatchObject({
      mappingProposalHash: record.proposal.contentHash,
      mappingReviewHash: record.review!.contentHash,
      executionOverlayHash: record.overlay!.contentHash,
      route: {
        routeId: 'route:python-to-rust',
        sourceLanguageId: 'python',
        targetLanguageId: 'rust',
      },
      sourceModuleIds: ['s2', 's3'],
      targetModuleIds: ['t3'],
    });
    await host.assertBindingCurrent(binding);
    expect(store.value?.records[0]?.overlay?.contentHash).toBe(binding.executionOverlayHash);
  });

  it('requires active reviewed catalogs on both sides', async () => {
    const missingSource = harness({ omitSource: true });
    await expect(missingSource.host.propose({
      sourceWorkspaceId: source.workspaceId,
      targetWorkspaceId: target.workspaceId,
      objective: 'Missing source catalog must fail.',
      mappings: mappings(),
      executionGroups: [],
    })).rejects.toThrow(/Source workspace has no active reviewed/);
    const missingTarget = harness({ omitTarget: true });
    await expect(missingTarget.host.propose({
      sourceWorkspaceId: source.workspaceId,
      targetWorkspaceId: target.workspaceId,
      objective: 'Missing target catalog must fail.',
      mappings: mappings(),
      executionGroups: [],
    })).rejects.toThrow(/Target workspace has no active reviewed/);
  });

  it('marks the mapping stale as soon as a catalog/IR/review head changes', async () => {
    const { host, heads, record } = await readyHost();
    const changed = structuredClone(target);
    changed.catalog = {
      ...changed.catalog,
      reviewId: 'target-review-v2',
      reviewHash: '8'.repeat(64),
      contentHash: '7'.repeat(64),
    };
    heads.set(target.workspaceId, changed);
    const refreshed = await host.get(record.id, true);
    expect(refreshed).toMatchObject({ stage: 'stale' });
    expect(refreshed?.staleReasons).toEqual(expect.arrayContaining([
      'target:module-catalog-changed',
      'target:module-review-changed',
    ]));
    await expect(host.bindTarget({
      targetWorkspaceId: target.workspaceId,
      targetModuleId: 't3',
      targetEntityId: 'target-entity-t3',
      allowedRouteIds: ['route:python-to-rust'],
    })).rejects.toThrow(/No current accepted module mapping/);
  });

  it('invalidates an accepted overlay when the source unified IR head changes', async () => {
    const { host, heads, record } = await readyHost();
    const changed = structuredClone(source);
    changed.ir = {
      ...changed.ir,
      id: 'source-ir-v2',
      contentHash: '6'.repeat(64),
    };
    heads.set(source.workspaceId, changed);

    const refreshed = await host.get(record.id, true);
    expect(refreshed).toMatchObject({ stage: 'stale' });
    expect(refreshed?.staleReasons).toContain('source:unified-ir-changed');
  });

  it('invalidates mapping and active-run bindings when the service snapshot changes', async () => {
    const ready = await readyHost();
    const binding = await ready.host.bindTarget({
      targetWorkspaceId: target.workspaceId,
      targetModuleId: 't3',
      targetEntityId: 'target-entity-t3',
      allowedRouteIds: ['route:python-to-rust'],
    });
    const changed = materializeMigrationRuntimeCapabilitySnapshot({
      routes: ready.record.runtimeCapabilitySnapshot!.routes,
      createdAt: '2026-09-02T09:00:00.000Z',
    });
    ready.replaceRuntimeSnapshot(changed);

    const refreshed = await ready.host.get(ready.record.id, true);
    expect(refreshed).toMatchObject({ stage: 'stale' });
    expect(refreshed?.staleReasons).toContain('route-resolution-changed');
    await expect(ready.host.assertBindingCurrent(binding)).rejects.toThrow(/unavailable or stale/);
  });

  it('rejects invented module/entity ownership and never persists FunctionalModule facts', async () => {
    const { host, store } = harness();
    await expect(host.propose({
      sourceWorkspaceId: source.workspaceId,
      targetWorkspaceId: target.workspaceId,
      objective: 'Invented facts are forbidden.',
      mappings: [{
        ...mappings()[0]!,
        sourceModuleIds: ['invented-module'],
        sourceEntityIds: ['invented-entity'],
      }],
      executionGroups: [{ id: 'group', mappingIds: ['map-expand'], dependsOnGroupIds: [] }],
    })).rejects.toThrow(/unknown source module/);
    expect(store.value).toBeNull();

    const ready = await readyHost();
    const serialized = JSON.stringify(ready.store.value);
    expect(serialized).not.toContain('sourceFiles');
    expect(serialized).not.toContain('fileAssignments');
    expect(serialized).not.toContain('FunctionalModule');
    expect(ready.record.overlay?.sourceCatalog.moduleCatalogId).toBe(source.catalog.id);
    expect(ready.record.overlay?.targetCatalog.moduleCatalogId).toBe(target.catalog.id);
  });
});
