import { describe, expect, it } from 'vitest';
import {
  moduleMigrationSchemaVersion,
  repositoryIngestionSchemaVersion,
  type FunctionalModule,
  type ModuleMappingEntry,
  type ModuleMigrationPlan,
  type RepositoryModuleCatalog,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { calculateModuleMigrationPlanHash } from './module-plan-utils';
import {
  classifyModuleMappingFreshness,
  convertLegacyModuleMigrationPlanToExecutionOverlay,
  materializeMigrationExecutionOverlay,
  materializeModuleMappingProposal,
  materializeModuleMappingReview,
  validateMigrationExecutionOverlay,
  validateModuleMappingProposal,
} from './module-mapping';

interface RepositorySide {
  ir: UnifiedRepositoryIR;
  catalog: RepositoryModuleCatalog;
}

function repositorySide(
  prefix: 'source' | 'target',
  moduleIds: string[],
  sharedModuleIds: string[] = [],
): RepositorySide {
  const languageId = prefix === 'source' ? 'gleam' : 'elixir';
  const sharedFileId = `${prefix}-file-shared`;
  const fileIdFor = (moduleId: string): string =>
    sharedModuleIds.includes(moduleId) ? sharedFileId : `${prefix}-file-${moduleId}`;
  const fileIds = [...new Set(moduleIds.map(fileIdFor))];
  const ir: UnifiedRepositoryIR = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${prefix}-ir`,
    repositoryId: `${prefix}-repository`,
    repositoryRevision: `${prefix}-revision-1`,
    profileId: `${prefix}-profile`,
    repositoryContentHash: (prefix === 'source' ? 'a' : 'b').repeat(64),
    sourceShardIds: [`${prefix}-shard`],
    capabilities: ['symbol-index'],
    files: fileIds.map((id) => ({
      id,
      path: `src/${id}.${prefix === 'source' ? 'gleam' : 'ex'}`,
      contentHash: (prefix === 'source' ? 'c' : 'd').repeat(64),
      role: 'source',
      languageId,
      projectIds: [],
    })),
    entities: moduleIds.map((moduleId) => ({
      id: `${prefix}-entity-${moduleId}`,
      kind: 'callable',
      name: `${moduleId}_entry`,
      languageId,
      fileId: fileIdFor(moduleId),
    })),
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: fileIds.length,
      analysedFileCount: fileIds.length,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: [languageId],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: (prefix === 'source' ? 'e' : 'f').repeat(64),
    producer: { kind: 'ingestion-host', id: `${prefix}-host` },
    createdAt: '2026-09-02T01:00:00.000Z',
  };
  const modules = moduleIds.map((moduleId) => ({
    id: moduleId,
    name: moduleId,
    kind: 'business-capability' as const,
    description: `${moduleId} capability`,
    responsibilities: [`${moduleId} responsibility`],
    businessCapabilities: [moduleId],
    fileIds: [fileIdFor(moduleId)],
    entityIds: [`${prefix}-entity-${moduleId}`],
    entryPointEntityIds: [`${prefix}-entity-${moduleId}`],
    publicApiEntityIds: [],
    boundaryRationale: `${moduleId} boundary`,
    evidenceRefs: [],
  }));
  const catalog: RepositoryModuleCatalog = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${prefix}-catalog-v1`,
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: `${prefix}-proposal`,
    sourceProposalHash: (prefix === 'source' ? '1' : '2').repeat(64),
    status: 'active',
    modules,
    assignments: fileIds.map((fileId) => {
      const assigned = moduleIds.filter((moduleId) => fileIdFor(moduleId) === fileId);
      return {
        fileId,
        moduleIds: assigned,
        kind: assigned.length > 1 ? 'shared' as const : 'owned' as const,
        rationale: 'Canonical reviewed assignment.',
        evidenceRefs: [],
      };
    }),
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: sharedModuleIds.length > 1 ? [sharedFileId] : [],
    reviewId: `${prefix}-review-v1`,
    reviewHash: (prefix === 'source' ? '3' : '4').repeat(64),
    contentHash: (prefix === 'source' ? '5' : '6').repeat(64),
    producer: { kind: 'human', id: `${prefix}-reviewer` },
    createdAt: '2026-09-02T01:00:00.000Z',
    updatedAt: '2026-09-02T01:00:00.000Z',
  };
  return { ir, catalog };
}

const source = repositorySide('source', ['s1', 's2', 's3', 's4'], ['s3', 's4']);
const target = repositorySide('target', ['t1', 't2', 't3', 't4'], ['t2', 't3']);

function mappings(): ModuleMappingEntry[] {
  return [
    {
      id: 'map-one',
      cardinality: 'one-to-one',
      sourceModuleIds: ['s1'],
      targetModuleIds: ['t1'],
      sourceEntityIds: ['source-entity-s1'],
      targetEntityIds: ['target-entity-t1'],
      rationale: 'Direct capability mapping.',
      evidenceIds: [],
    },
    {
      id: 'map-expand',
      cardinality: 'one-to-many',
      sourceModuleIds: ['s2'],
      targetModuleIds: ['t3', 't2'],
      sourceEntityIds: ['source-entity-s2'],
      targetEntityIds: ['target-entity-t3', 'target-entity-t2'],
      rationale: 'Split one source capability across two target modules.',
      evidenceIds: [],
    },
    {
      id: 'map-collapse',
      cardinality: 'many-to-one',
      sourceModuleIds: ['s4', 's3'],
      targetModuleIds: ['t4'],
      sourceEntityIds: ['source-entity-s4', 'source-entity-s3'],
      targetEntityIds: ['target-entity-t4'],
      rationale: 'Consolidate two source modules into one target module.',
      evidenceIds: [],
    },
  ];
}

function proposal(mappingValues = mappings()) {
  return materializeModuleMappingProposal({
    sourceIr: source.ir,
    sourceCatalog: source.catalog,
    targetIr: target.ir,
    targetCatalog: target.catalog,
    objective: 'Map reviewed historical modules onto reviewed target modules.',
    mappings: mappingValues,
    assumptions: ['Reviewed catalogs are authoritative.'],
    risks: ['Behavior validation remains required.'],
    createdAt: '2026-09-02T02:00:00.000Z',
  });
}

function acceptedReview(value = proposal()) {
  return materializeModuleMappingReview({
    proposal: value,
    sourceIr: source.ir,
    sourceCatalog: source.catalog,
    targetIr: target.ir,
    targetCatalog: target.catalog,
    decision: 'accept',
    reviewerId: 'mapping-reviewer',
    decidedAt: '2026-09-02T03:00:00.000Z',
  });
}

function overlay(value = proposal(), review = acceptedReview(value)) {
  return materializeMigrationExecutionOverlay({
    proposal: value,
    review,
    sourceIr: source.ir,
    sourceCatalog: source.catalog,
    targetIr: target.ir,
    targetCatalog: target.catalog,
    routeId: 'gleam-to-elixir-translate',
    routeVersion: '1.0.0',
    groups: [
      { id: 'group-a', mappingIds: ['map-expand', 'map-one'], dependsOnGroupIds: [] },
      { id: 'group-b', mappingIds: ['map-collapse'], dependsOnGroupIds: ['group-a'] },
    ],
    createdAt: '2026-09-02T04:00:00.000Z',
  });
}

describe('reviewed catalog module mapping', () => {
  it('materializes 1:1, 1:N and N:1 mappings deterministically', () => {
    const first = proposal();
    const second = materializeModuleMappingProposal({
      sourceIr: source.ir,
      sourceCatalog: source.catalog,
      targetIr: target.ir,
      targetCatalog: target.catalog,
      objective: first.objective,
      mappings: [...mappings()].reverse(),
      assumptions: [...first.assumptions].reverse(),
      risks: [...first.risks].reverse(),
      createdAt: first.createdAt,
    });
    expect(second).toEqual(first);
    expect(first.mappings.map((mapping) => mapping.cardinality)).toEqual([
      'many-to-one',
      'one-to-many',
      'one-to-one',
    ]);
  });

  it('rejects duplicate modules and entities outside the mapped canonical modules', () => {
    const duplicateSource = [mappings()[0]!, {
      ...mappings()[1]!,
      id: 'map-duplicate-source',
      sourceModuleIds: ['s1'],
      sourceEntityIds: ['source-entity-s1'],
    }];
    expect(() => proposal(duplicateSource)).toThrow(/Source module s1 appears in multiple mappings/);

    const outsideEntity = [{
      ...mappings()[0]!,
      sourceEntityIds: ['source-entity-s2'],
    }];
    expect(() => proposal(outsideEntity)).toThrow(/outside its mapped modules/);

    const unknownModule = [{
      ...mappings()[0]!,
      targetModuleIds: ['invented-target'],
    }];
    expect(() => proposal(unknownModule)).toThrow(/unknown target module/);
  });

  it('fails closed when either catalog head, IR, or review lineage changes', () => {
    const value = proposal();
    const changedTargetCatalog: RepositoryModuleCatalog = {
      ...target.catalog,
      id: 'target-catalog-v2',
      contentHash: '7'.repeat(64),
    };
    const freshness = classifyModuleMappingFreshness(
      value,
      source.ir,
      source.catalog,
      target.ir,
      changedTargetCatalog,
    );
    expect(freshness).toMatchObject({
      status: 'stale',
      target: { status: 'stale', reasonCodes: ['module-catalog-changed'] },
    });
    expect(() => validateModuleMappingProposal(
      value,
      source.ir,
      source.catalog,
      target.ir,
      changedTargetCatalog,
    )).toThrow(/target catalog reference is stale/);

    const changedReviewCatalog = {
      ...target.catalog,
      reviewId: 'target-review-v2',
      reviewHash: '8'.repeat(64),
    };
    expect(classifyModuleMappingFreshness(
      value,
      source.ir,
      source.catalog,
      target.ir,
      changedReviewCatalog,
    ).target.reasonCodes).toContain('module-review-changed');
  });

  it('derives overlay references from canonical mappings, including entities in shared files', () => {
    const value = proposal();
    const review = acceptedReview(value);
    const result = overlay(value, review);
    expect(result.groups[1]).toMatchObject({
      mappingIds: ['map-collapse'],
      sourceModuleIds: ['s3', 's4'],
      sourceEntityIds: ['source-entity-s3', 'source-entity-s4'],
      targetModuleIds: ['t4'],
    });
    expect(JSON.stringify(result)).not.toContain('sourceFiles');
    expect(validateMigrationExecutionOverlay(
      result,
      value,
      review,
      source.ir,
      source.catalog,
      target.ir,
      target.catalog,
    )).toBe(result);
  });

  it('rejects duplicated mapping execution and invented overlay entity references', () => {
    const value = proposal();
    const review = acceptedReview(value);
    expect(() => materializeMigrationExecutionOverlay({
      proposal: value,
      review,
      sourceIr: source.ir,
      sourceCatalog: source.catalog,
      targetIr: target.ir,
      targetCatalog: target.catalog,
      routeId: 'gleam-to-elixir-translate',
      routeVersion: '1.0.0',
      groups: [
        { id: 'a', mappingIds: ['map-one', 'map-expand'], dependsOnGroupIds: [] },
        { id: 'b', mappingIds: ['map-one', 'map-collapse'], dependsOnGroupIds: [] },
      ],
      createdAt: '2026-09-02T04:00:00.000Z',
    })).toThrow(/appears in multiple execution groups/);

    const valid = overlay(value, review);
    const tampered = {
      ...valid,
      groups: valid.groups.map((group, index) => index === 0
        ? { ...group, targetEntityIds: [...group.targetEntityIds, 'invented-entity'] }
        : group),
    };
    expect(() => validateMigrationExecutionOverlay(
      tampered,
      value,
      review,
      source.ir,
      source.catalog,
      target.ir,
      target.catalog,
    )).toThrow(/invented references/);
  });
});

function legacyModule(id: string): FunctionalModule {
  return {
    id,
    name: id,
    kind: 'feature',
    description: 'Legacy compatibility input only.',
    sourceFiles: [`legacy/${id}.java`],
    symbolIds: [`legacy-symbol-${id}`],
    dependsOn: [],
    writeSet: [`legacy/${id}.java`],
    resourceLocks: [],
    evidenceIds: [],
  };
}

function legacyPlan(): ModuleMigrationPlan {
  const modules = ['legacy-a', 'legacy-b', 'legacy-c'].map(legacyModule);
  const plan: ModuleMigrationPlan = {
    schemaVersion: moduleMigrationSchemaVersion,
    id: 'legacy-plan',
    snapshotId: 'legacy-snapshot',
    analysisHash: 'legacy-analysis-hash',
    objective: 'Legacy schedule compatibility only.',
    modules,
    fileAssignments: modules.map((module) => ({
      path: module.sourceFiles[0]!,
      kind: 'module',
      moduleId: module.id,
    })),
    dependencies: [],
    risks: [],
    status: 'validated',
    planHash: '',
    executionGroups: modules.map((module) => ({
      id: `legacy-group-${module.id}`,
      kind: 'module',
      moduleIds: [module.id],
      dependsOnGroupIds: [],
      executionMode: 'serial',
      atomic: true,
      writeSet: module.writeSet,
      resourceLocks: [],
      reasons: [],
    })),
    executionWaves: [],
    decisions: [],
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };
  plan.planHash = calculateModuleMigrationPlanHash(plan);
  return plan;
}

describe('legacy module compatibility boundary', () => {
  it('uses legacy scheduling only as an explicit binding and never imports old ownership', () => {
    const value = proposal();
    const review = acceptedReview(value);
    const result = convertLegacyModuleMigrationPlanToExecutionOverlay({
      legacyPlan: legacyPlan(),
      bindings: [
        { legacyModuleId: 'legacy-a', mappingIds: ['map-one'] },
        { legacyModuleId: 'legacy-b', mappingIds: ['map-expand'] },
        { legacyModuleId: 'legacy-c', mappingIds: ['map-collapse'] },
      ],
      proposal: value,
      review,
      sourceIr: source.ir,
      sourceCatalog: source.catalog,
      targetIr: target.ir,
      targetCatalog: target.catalog,
      routeId: 'gleam-to-elixir-translate',
      routeVersion: '1.0.0',
      createdAt: '2026-09-02T05:00:00.000Z',
    });
    expect(result.overlay.groups.flatMap((group) => group.sourceModuleIds).sort()).toEqual([
      's1', 's2', 's3', 's4',
    ]);
    expect(JSON.stringify(result.overlay)).not.toContain('legacy/');
    expect(result.compatibility.warnings).toContain('legacy-module-boundaries-not-imported');
  });
});
