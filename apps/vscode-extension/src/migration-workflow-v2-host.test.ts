import { createHash } from 'node:crypto';
import type {
  AdaptationResultV2,
  MigrationRouteDescriptor,
  RepositoryModuleCatalog,
  SearchCandidateV2,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  migrationRouteSchemaVersion,
  repositoryIngestionSchemaVersion,
  validationPolicySchemaVersion,
} from '@forexplore/contracts';
import {
  calculatePatchHashV2,
  createMigrationRouteSnapshotRef,
  materializeAdaptationResultV2,
  materializeImplementationCandidateRefV2,
  materializeIndexedImplementationDocumentV2,
  materializeMigrationRuntimeCapabilitySnapshot,
  materializeMigrationTargetRefV2,
  materializeSearchCandidateV2,
  materializeSourceImplementationBundleV2,
  type MigrationExecutionV2ValidationContext,
} from '@forexplore/workflow-core';
import { describe, expect, it } from 'vitest';
import {
  ModuleMappingHost,
  type ModuleMappingHostState,
  type ModuleMappingHostStore,
  type ReviewedModuleCatalogHead,
} from './module-mapping-host';
import {
  adaptRunV2,
  assertRunContextCurrent,
  createActiveMigrationRunV2,
  selectCandidateV2,
  startSearchV2,
} from './migration-workflow-v2-host';
import type { TargetWorkspaceMigrationSelection } from './protocol/messages';
import { collectTargetContextV2 } from './target-context-v2';
import type { TargetWorkspaceEntityContext } from './target-workspace-host';

const NOW = '2026-09-02T08:00:00.000Z';
const sourceCode = 'export function add(left: number, right: number): number { return left + right; }';
const targetCode = 'def add(left: int, right: int) -> int:\n    raise NotImplementedError()';

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function head(side: 'source' | 'target'): ReviewedModuleCatalogHead {
  const source = side === 'source';
  const languageId = source ? 'typescript' : 'python';
  const fileId = `${side}-file`;
  const entityId = `${side}-entity`;
  const content = source ? sourceCode : targetCode;
  const ir: UnifiedRepositoryIR = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-ir`,
    repositoryId: `${side}-repository`,
    repositoryRevision: 'revision-1',
    profileId: `${side}-profile`,
    repositoryContentHash: sha(`${side}-repository`),
    sourceShardIds: [`${side}-shard`],
    capabilities: ['symbol-index'],
    files: [{
      id: fileId,
      path: source ? 'src/add.ts' : 'src/add.py',
      contentHash: sha(content),
      role: 'source',
      languageId,
      projectIds: [],
    }],
    entities: [{
      id: entityId,
      kind: 'callable',
      name: 'add',
      qualifiedName: 'add',
      signature: source
        ? 'add(left: number, right: number): number'
        : 'add(left: int, right: int) -> int',
      fileId,
      languageId,
    }],
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: [languageId],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: sha(`${side}-ir`),
    producer: { kind: 'ingestion-host', id: `${side}-host` },
    createdAt: NOW,
  };
  const catalog: RepositoryModuleCatalog = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-catalog`,
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: `${side}-proposal`,
    sourceProposalHash: sha(`${side}-proposal`),
    status: 'active',
    modules: [{
      id: `${side}-module`,
      name: 'Arithmetic',
      kind: 'business-capability',
      description: 'Reviewed arithmetic capability.',
      responsibilities: ['Add two values.'],
      businessCapabilities: ['arithmetic'],
      fileIds: [fileId],
      entityIds: [entityId],
      entryPointEntityIds: [entityId],
      publicApiEntityIds: [entityId],
      boundaryRationale: 'One top-level function.',
      evidenceRefs: [],
    }],
    assignments: [{
      fileId,
      moduleIds: [`${side}-module`],
      kind: 'owned',
      rationale: 'Reviewed ownership.',
      evidenceRefs: [],
    }],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    reviewId: `${side}-review`,
    reviewHash: sha(`${side}-review`),
    contentHash: sha(`${side}-catalog`),
    producer: { kind: 'human', id: 'reviewer' },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    workspaceId: `${side}-workspace`,
    ir,
    catalog,
    analysisSnapshotId: `${side}-snapshot`,
    analysisContentHash: sha(`${side}-analysis`),
    analysisAdapters: [],
  };
}

function route(): MigrationRouteDescriptor {
  const stages = [
    ['source-analysis', 'fixture.typescript-analysis'],
    ['target-analysis', 'fixture.python-analysis'],
    ['translation', 'fixture.translator'],
    ['patch-generation', 'fixture.translator'],
    ['behavior-validation', 'fixture.behavior-verifier'],
  ] as const;
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'route:typescript-to-python',
    name: 'TypeScript to Python top-level function',
    version: '2.0.0',
    sourceLanguageId: 'typescript',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: stages.map(([stage, providerId]) => ({
      stage,
      providerId,
      providerVersion: '1.0.0',
      capabilities: stage === 'translation' ? ['code-translation'] : [],
      availability: { status: 'available', reasonCodes: [] },
    })),
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'policy:typescript-to-python',
      routeId: 'route:typescript-to-python',
      routeVersion: '2.0.0',
      checks: [{
        id: 'behavior',
        label: 'Independent behavior validation',
        phase: 'behavior',
        required: true,
        verifierId: 'fixture.behavior-verifier',
        verifierVersion: '1.0.0',
      }],
    },
  };
}

class MemoryStore implements ModuleMappingHostStore {
  state: ModuleMappingHostState | null = null;
  async load(): Promise<ModuleMappingHostState | null> { return structuredClone(this.state); }
  async save(next: ModuleMappingHostState): Promise<void> { this.state = structuredClone(next); }
}

async function fixture() {
  const source = head('source');
  const target = head('target');
  const runtime = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
  const materializedRoute = runtime.routes[0]!;
  const host = new ModuleMappingHost({
    store: new MemoryStore(),
    catalogs: {
      async load(_side, workspaceId) {
        if (workspaceId === source.workspaceId) return structuredClone(source);
        if (workspaceId === target.workspaceId) return structuredClone(target);
        return null;
      },
    },
    routes: {
      async resolve(routeId, version) {
        if (routeId !== materializedRoute.id || version !== materializedRoute.version) return undefined;
        return {
          resolution: {
            status: 'supported',
            key: {
              sourceLanguageId: 'typescript',
              targetLanguageId: 'python',
              strategy: 'translate',
            },
            route: materializedRoute,
            warnings: [],
          },
          runtimeCapabilitySnapshot: runtime,
        };
      },
    },
    now: () => NOW,
  });
  const proposal = await host.propose({
    sourceWorkspaceId: source.workspaceId,
    targetWorkspaceId: target.workspaceId,
    objective: 'Migrate the reviewed top-level add function.',
    mappings: [{
      id: 'mapping-add',
      cardinality: 'one-to-one',
      sourceModuleIds: ['source-module'],
      targetModuleIds: ['target-module'],
      sourceEntityIds: ['source-entity'],
      targetEntityIds: ['target-entity'],
      rationale: 'The reviewed functions implement the same arithmetic capability.',
      evidenceIds: [],
    }],
    executionGroups: [{ id: 'group-add', mappingIds: ['mapping-add'], dependsOnGroupIds: [] }],
  });
  await host.review({
    recordId: proposal.id,
    expectedProposalId: proposal.proposal.id,
    expectedProposalHash: proposal.proposal.contentHash,
    decision: 'accept',
    reviewerId: 'reviewer',
    routeId: materializedRoute.id,
    routeVersion: materializedRoute.version,
  });
  const binding = await host.bindTarget({
    targetWorkspaceId: target.workspaceId,
    targetModuleId: 'target-module',
    targetEntityId: 'target-entity',
    allowedRouteIds: [materializedRoute.id],
  });
  const targetRef = materializeMigrationTargetRefV2({
    schemaVersion: '2.0',
    workspaceId: target.workspaceId,
    targetWorkspaceSnapshotId: 'target-workspace-snapshot',
    targetWorkspaceSnapshotHash: sha('target-workspace-snapshot'),
    lineage: {
      repositoryId: binding.targetCatalog.repositoryId,
      repositoryRevision: binding.targetCatalog.repositoryRevision,
      repositoryContentHash: binding.targetCatalog.repositoryContentHash,
      unifiedRepositoryIrId: binding.targetCatalog.unifiedRepositoryIrId,
      unifiedRepositoryIrHash: binding.targetCatalog.unifiedRepositoryIrHash,
      moduleCatalogId: binding.targetCatalog.moduleCatalogId,
      moduleCatalogHash: binding.targetCatalog.moduleCatalogHash,
      moduleReviewId: binding.targetCatalog.moduleReviewId,
      moduleReviewHash: binding.targetCatalog.moduleReviewHash,
    },
    entity: {
      entityId: 'target-entity',
      fileId: 'target-file',
      languageId: 'python',
      kind: 'function',
      name: 'add',
      qualifiedName: 'add',
      path: 'src/add.py',
      signature: 'add(left: int, right: int) -> int',
      fileContentHash: sha(targetCode),
      declarationIdentity: {
        kind: 'declaration',
        contentHash: sha('def add(left: int, right: int) -> int:'),
        schemaVersion: 'python.ast.function-declaration.v1',
        providerId: 'fixture.python-analysis',
        providerVersion: '1.0.0',
      },
    },
    route: createMigrationRouteSnapshotRef(runtime, materializedRoute.id),
    allowedModificationPaths: ['src/add.py'],
  }, runtime);
  const selection: TargetWorkspaceMigrationSelection = {
    workspaceId: target.workspaceId,
    targetWorkspaceSnapshotId: targetRef.targetWorkspaceSnapshotId,
    targetWorkspaceSnapshotHash: targetRef.targetWorkspaceSnapshotHash,
    selection: {
      snapshotId: targetRef.targetWorkspaceSnapshotId,
      contentHash: targetRef.targetWorkspaceSnapshotHash,
      nodeId: 'node:target-entity',
      entityId: 'target-entity',
    },
    target: targetRef,
    module: {
      catalogId: binding.targetCatalog.moduleCatalogId,
      catalogHash: binding.targetCatalog.moduleCatalogHash,
      moduleId: 'target-module',
      moduleName: 'Arithmetic',
    },
    moduleMapping: binding,
    routeOptions: [{ route: materializedRoute, warnings: [] }],
  };
  return { host, source, target, runtime, materializedRoute, selection };
}

describe('V2 Host workflow (TypeScript to Python)', () => {
  it('uses exact V2 artifacts, requires explicit selection, and rejects V1 results', async () => {
    const setup = await fixture();
    const context = await setup.host.executionContext(setup.selection.moduleMapping);
    const run = createActiveMigrationRunV2(setup.selection);
    let indexedDocument!: ReturnType<typeof materializeIndexedImplementationDocumentV2>;
    let candidate!: SearchCandidateV2;
    let bundle!: ReturnType<typeof materializeSourceImplementationBundleV2>;
    await startSearchV2(run, {
      async search(request) {
        expect(request.rerank).toBe(false);
        expect(request.repositoryScopes).toEqual(['source-repository']);
        const candidateRef = materializeImplementationCandidateRefV2({
          schemaVersion: '2.0',
          id: 'candidate:add-typescript',
          lineage: {
            repositoryId: setup.selection.moduleMapping.sourceCatalog.repositoryId,
            repositoryRevision: setup.selection.moduleMapping.sourceCatalog.repositoryRevision,
            repositoryContentHash: setup.selection.moduleMapping.sourceCatalog.repositoryContentHash,
            unifiedRepositoryIrId: setup.selection.moduleMapping.sourceCatalog.unifiedRepositoryIrId,
            unifiedRepositoryIrHash: setup.selection.moduleMapping.sourceCatalog.unifiedRepositoryIrHash,
            moduleCatalogId: setup.selection.moduleMapping.sourceCatalog.moduleCatalogId,
            moduleCatalogHash: setup.selection.moduleMapping.sourceCatalog.moduleCatalogHash,
            moduleReviewId: setup.selection.moduleMapping.sourceCatalog.moduleReviewId,
            moduleReviewHash: setup.selection.moduleMapping.sourceCatalog.moduleReviewHash,
          },
          entity: {
            entityId: 'source-entity',
            fileId: 'source-file',
            languageId: 'typescript',
            kind: 'function',
            name: 'add',
            path: 'src/add.ts',
            signature: 'add(left: number, right: number): number',
          },
        });
        bundle = materializeSourceImplementationBundleV2({
          candidate: candidateRef,
          primaryEntityId: 'source-entity',
          files: [{
            fileId: 'source-file',
            path: 'src/add.ts',
            languageId: 'typescript',
            role: 'primary',
            content: sourceCode,
            contentHash: sha(sourceCode),
          }],
          producer: { providerId: 'fixture.retrieval', providerVersion: '1.0.0' },
          createdAt: NOW,
        });
        indexedDocument = materializeIndexedImplementationDocumentV2({
          schemaVersion: '2.0',
          candidate: candidateRef,
          sourceCatalog: setup.selection.moduleMapping.sourceCatalog,
          moduleId: 'source-module',
          entityId: 'source-entity',
          fileId: 'source-file',
          fileContentHash: sha(sourceCode),
          sourceBundle: { id: bundle.id, contentHash: bundle.contentHash },
          title: 'TypeScript add',
          summary: 'Reviewed top-level add implementation.',
          searchText: 'add two numbers',
          producer: { providerId: 'fixture.retrieval', providerVersion: '1.0.0' },
          createdAt: NOW,
        });
        candidate = materializeSearchCandidateV2({
          request,
          indexedDocument,
          indexGeneration: {
            repositoryId: setup.selection.moduleMapping.sourceCatalog.repositoryId,
            id: 'generation:source:1',
            generation: 1,
            contentHash: sha('generation:source:1'),
            sourceCatalogId: setup.selection.moduleMapping.sourceCatalog.moduleCatalogId,
            sourceCatalogHash: setup.selection.moduleMapping.sourceCatalog.moduleCatalogHash,
          },
          score: { overall: 0.9, semantic: 0.9, symbol: 0.9, contract: 0.9 },
          preview: 'export function add(...)',
          createdAt: NOW,
        }, setup.runtime);
        return [candidate];
      },
    }, { requirement: 'Add two integers', topK: 5, createdAt: NOW });
    expect(run.selectedCandidateId).toBeNull();
    await expect(adaptRunV2(
      run,
      {} as never,
      context,
      { async adapt() { return {} as AdaptationResultV2; } },
      [],
    )).rejects.toThrow(/明确点击/);

    await selectCandidateV2(run, candidate.id, {
      async resolveSourceBundle() { return { indexedDocument, bundle }; },
    }, context);
    expect(run.sourceBundle?.files[0]?.content).toContain('export function add');

    const targetContext = collectTargetContextV2({
      target: run.target,
      runtimeCapabilities: setup.runtime,
      targetFileContent: targetCode,
      context: {
        role: 'target-workspace',
        workspaceId: setup.target.workspaceId,
        snapshotId: run.target.targetWorkspaceSnapshotId,
        snapshot: {} as TargetWorkspaceEntityContext['snapshot'],
        ir: setup.target.ir,
        catalog: setup.target.catalog,
        entity: setup.target.ir.entities[0]!,
        file: setup.target.ir.files[0]!,
        module: setup.target.catalog.modules[0]!,
      },
      createdAt: NOW,
    });
    expect(targetContext.sourceFiles).toHaveLength(1);
    expect(targetContext.sourceFiles[0]).toMatchObject({
      role: 'source-file',
      path: 'src/add.py',
      content: targetCode,
      contentHash: sha(targetCode),
    });
    const result = await adaptRunV2(run, targetContext, context, {
      async adapt(request, validationContext) {
        const files: AdaptationResultV2['files'] = [{
          path: 'src/add.py',
          status: 'modified',
          expectedOriginalSha256: sha(targetCode),
          additions: 1,
          deletions: 1,
          hunks: [{
            header: '@@ -1,2 +1,2 @@',
            lines: [
              { type: 'context', content: 'def add(left: int, right: int) -> int:' },
              { type: 'remove', content: '    raise NotImplementedError()' },
              { type: 'add', content: '    return left + right' },
            ],
          }],
        }];
        const patchHash = calculatePatchHashV2(files);
        return materializeAdaptationResultV2({
          request,
          files,
          validation: [{
            id: 'validation:behavior',
            policyCheckId: 'behavior',
            label: 'Independent behavior validation',
            status: 'pass',
            required: true,
            routeId: request.route.routeId,
            routeVersion: request.route.routeVersion,
            phase: 'behavior',
            verifierId: 'fixture.behavior-verifier',
            verifierVersion: '1.0.0',
            subjectHash: patchHash,
            summary: 'Reference vectors passed.',
          }],
          producer: { providerId: 'fixture.translator', providerVersion: '1.0.0' },
          createdAt: NOW,
        }, validationContext);
      },
    }, ['Keep a top-level function.'], NOW);
    expect(result.route.sourceLanguageId).toBe('typescript');
    expect(result.route.targetLanguageId).toBe('python');
    expect(result.files[0]?.path).toBe('src/add.py');

    await expect(adaptRunV2(run, targetContext, context, {
      async adapt() {
        return { strategy: 'translate', files: [], validation: [] } as never;
      },
    }, [], NOW)).rejects.toThrow(/schema|invalid|unsupported/i);
  });

  it('stales a run when the exact combined runtime snapshot changes', async () => {
    const setup = await fixture();
    const run = createActiveMigrationRunV2(setup.selection);
    const context = await setup.host.executionContext(setup.selection.moduleMapping);
    const rotated = materializeMigrationRuntimeCapabilitySnapshot({
      routes: setup.runtime.routes,
      createdAt: '2026-09-02T09:00:00.000Z',
    });
    expect(() => assertRunContextCurrent(run, {
      ...context,
      runtimeCapabilities: rotated,
    })).toThrow(/runtime capability snapshot is stale/);
  });
});
