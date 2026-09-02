import {
  repositoryIngestionSchemaVersion,
  type EntityImplementationAssessment,
  type EntityImplementationAssessmentDraft,
  type RepositoryIREntity,
  type RepositoryIRFile,
  type RepositoryModuleCatalog,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildTargetWorkspaceModuleSnapshot,
  classifyTargetWorkspaceSnapshotFreshness,
  createEntityImplementationAssessment,
  validateTargetWorkspaceModuleSnapshot,
} from './target-workspace';

const NOW = '2026-09-02T08:00:00.000Z';
const HASHES = {
  repository: '1'.repeat(64),
  ir: '2'.repeat(64),
  catalog: '3'.repeat(64),
  review: '4'.repeat(64),
  body: '5'.repeat(64),
};

const files: RepositoryIRFile[] = [
  { id: 'file-main', path: 'src/Main.cs', contentHash: 'a'.repeat(64), role: 'source', languageId: 'csharp', projectIds: [] },
  { id: 'file-shared', path: 'src/Shared.cs', contentHash: 'b'.repeat(64), role: 'source', languageId: 'csharp', projectIds: [] },
  { id: 'file-test', path: 'tests/MainTests.cs', contentHash: 'c'.repeat(64), role: 'test', languageId: 'csharp', projectIds: [] },
  { id: 'file-generated', path: 'obj/Generated.cs', contentHash: 'd'.repeat(64), role: 'generated', languageId: 'csharp', projectIds: [], generated: true },
  { id: 'file-excluded', path: 'vendor/Legacy.cs', contentHash: 'e'.repeat(64), role: 'source', languageId: 'csharp', projectIds: [] },
  { id: 'file-unassigned', path: 'scratch/Unknown.cs', contentHash: 'f'.repeat(64), role: 'source', languageId: 'csharp', projectIds: [] },
];

function typeEntity(id: string, name: string, fileId: string): RepositoryIREntity {
  return {
    id,
    kind: 'type',
    name,
    qualifiedName: `Example.${name}`,
    languageId: 'csharp',
    fileId,
    signature: `public class ${name}`,
    attributes: { staticSymbolKind: 'class' },
  };
}

function callable(
  id: string,
  name: string,
  fileId: string,
  containerEntityId: string,
): RepositoryIREntity {
  return {
    id,
    kind: 'callable',
    name,
    qualifiedName: `Example.${containerEntityId}.${name}`,
    languageId: 'csharp',
    fileId,
    containerEntityId,
    signature: `public void ${name}()`,
    attributes: { staticSymbolKind: 'method' },
  };
}

const entities: RepositoryIREntity[] = [
  typeEntity('type-main', 'Main', 'file-main'),
  callable('call-implemented', 'Ready', 'file-main', 'type-main'),
  callable('call-unknown', 'Uncertain', 'file-main', 'type-main'),
  callable('call-na', 'DeclarationOnly', 'file-main', 'type-main'),
  typeEntity('type-shared', 'Shared', 'file-shared'),
  callable('call-shared', 'SharedWork', 'file-shared', 'type-shared'),
  typeEntity('type-test', 'MainTests', 'file-test'),
  { ...callable('call-test', 'TestReady', 'file-test', 'type-test'), testOnly: true },
  typeEntity('type-generated', 'Generated', 'file-generated'),
  callable('call-generated', 'GeneratedWork', 'file-generated', 'type-generated'),
  typeEntity('type-excluded', 'Legacy', 'file-excluded'),
  callable('call-excluded', 'LegacyWork', 'file-excluded', 'type-excluded'),
  typeEntity('type-unassigned', 'Unknown', 'file-unassigned'),
  callable('call-unassigned', 'UnknownWork', 'file-unassigned', 'type-unassigned'),
];

function makeIr(overrides: Partial<UnifiedRepositoryIR> = {}): UnifiedRepositoryIR {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'unified-ir-1',
    repositoryId: 'target-repository',
    profileId: 'profile-1',
    repositoryRevision: 'commit-1',
    repositoryContentHash: HASHES.repository,
    sourceShardIds: ['shard-1'],
    capabilities: ['file-inventory', 'symbol-index'],
    files,
    entities,
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: files.length,
      analysedFileCount: files.length,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['csharp'],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: HASHES.ir,
    producer: { kind: 'ingestion-host', id: 'fixture', version: '1' },
    createdAt: NOW,
    ...overrides,
  };
}

function makeCatalog(overrides: Partial<RepositoryModuleCatalog> = {}): RepositoryModuleCatalog {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'catalog-1',
    repositoryId: 'target-repository',
    sourceIrId: 'unified-ir-1',
    sourceIrHash: HASHES.ir,
    sourceProposalId: 'proposal-1',
    sourceProposalHash: '6'.repeat(64),
    status: 'active',
    modules: [
      {
        id: 'module-main',
        name: 'Main module',
        kind: 'application-service',
        description: 'Main target module',
        responsibilities: ['Run main work'],
        businessCapabilities: [],
        fileIds: ['file-main', 'file-shared', 'file-test'],
        entityIds: [
          'type-main',
          'call-implemented',
          'call-unknown',
          'call-na',
          'type-test',
          'call-test',
        ],
        entryPointEntityIds: ['call-implemented'],
        publicApiEntityIds: ['call-implemented'],
        boundaryRationale: 'Fixture ownership',
        evidenceRefs: [],
      },
      {
        id: 'module-shared',
        name: 'Shared module',
        kind: 'shared-kernel',
        description: 'Shared target module',
        responsibilities: ['Share work'],
        businessCapabilities: [],
        fileIds: ['file-shared', 'file-generated'],
        entityIds: ['type-shared', 'call-shared', 'type-generated', 'call-generated'],
        entryPointEntityIds: ['call-shared'],
        publicApiEntityIds: ['call-shared'],
        boundaryRationale: 'Fixture shared ownership',
        evidenceRefs: [],
      },
    ],
    assignments: [
      { fileId: 'file-main', moduleIds: ['module-main'], kind: 'owned', rationale: 'main', evidenceRefs: [] },
      { fileId: 'file-shared', moduleIds: ['module-main', 'module-shared'], kind: 'shared', rationale: 'shared', evidenceRefs: [] },
      { fileId: 'file-test', moduleIds: ['module-main'], kind: 'test', rationale: 'test', evidenceRefs: [] },
      { fileId: 'file-generated', moduleIds: ['module-shared'], kind: 'generated', rationale: 'generated', evidenceRefs: [] },
      { fileId: 'file-excluded', moduleIds: [], kind: 'excluded', rationale: 'vendor', evidenceRefs: [] },
      { fileId: 'file-unassigned', moduleIds: [], kind: 'unassigned', rationale: 'unknown', evidenceRefs: [] },
    ],
    dependencies: [],
    unassignedFileIds: ['file-unassigned'],
    overlappingFileIds: ['file-shared'],
    reviewId: 'review-1',
    reviewHash: HASHES.review,
    contentHash: HASHES.catalog,
    producer: { kind: 'ingestion-host', id: 'fixture', version: '1' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const stateByEntity: Record<string, EntityImplementationAssessmentDraft['state']> = {
  'call-implemented': 'implemented',
  'call-unknown': 'unknown',
  'call-na': 'not-applicable',
  'call-shared': 'partial',
  'call-test': 'implemented',
  'call-generated': 'implemented',
  'call-excluded': 'unimplemented',
  'call-unassigned': 'unknown',
};

function makeAssessments(ir = makeIr()): EntityImplementationAssessment[] {
  const lineage = {
    repositoryId: ir.repositoryId,
    ...(ir.repositoryRevision ? { repositoryRevision: ir.repositoryRevision } : {}),
    repositoryContentHash: ir.repositoryContentHash,
    unifiedRepositoryIrId: ir.id,
    unifiedRepositoryIrHash: ir.contentHash,
  };
  return ir.entities.filter((entity) => entity.kind === 'callable').map((entity) => {
    const state = stateByEntity[entity.id] ?? 'unknown';
    return createEntityImplementationAssessment({
      draft: {
        entityId: entity.id,
        fileId: entity.fileId!,
        bodyHash: HASHES.body,
        state,
        basis: state === 'unimplemented'
          ? 'explicit-stub'
          : state === 'not-applicable'
            ? 'declaration-only'
            : state === 'unknown'
              ? 'unavailable'
              : 'syntactic-body',
        reasonCodes: [`fixture-${state}`],
        evidenceRefs: [{ id: `evidence-${entity.id}`, kind: 'syntactic-analysis' }],
        detector: { id: 'fixture-detector', version: '1.0.0', languageId: 'csharp' },
      },
      lineage,
      createdAt: NOW,
    });
  });
}

describe('target workspace implementation inventory', () => {
  it('preserves five states and deterministically aggregates unique production callables', () => {
    const ir = makeIr();
    const catalog = makeCatalog();
    const assessments = makeAssessments(ir);
    const first = buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog,
      assessments,
      producer: { kind: 'ingestion-host', id: 'target-host', version: '1.0.0' },
      createdAt: NOW,
    });
    const reordered = buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog,
      assessments: [...assessments].reverse(),
      producer: { kind: 'ingestion-host', id: 'target-host', version: '1.0.0' },
      createdAt: NOW,
    });

    expect(reordered).toEqual(first);
    expect(first.workspaceCounts).toEqual({
      eligible: 3,
      implemented: 1,
      unimplemented: 0,
      partial: 1,
      unknown: 1,
      notApplicable: 5,
    });
    expect(first.excludedEntities.map(({ entityId, reason }) => [entityId, reason])).toEqual([
      ['call-excluded', 'excluded-file'],
      ['call-generated', 'generated'],
      ['call-na', 'not-applicable'],
      ['call-test', 'test'],
      ['call-unassigned', 'unassigned-file'],
    ]);
    expect(first.classRollups.find((rollup) => rollup.scopeId === 'type-main')).toMatchObject({
      state: 'unknown',
      counts: { eligible: 2, implemented: 1, unknown: 1, notApplicable: 1 },
    });
    expect(first.moduleRollups.find((rollup) => rollup.scopeId === 'module-main')).toMatchObject({
      state: 'unknown',
      counts: { eligible: 2, implemented: 1, unknown: 1, notApplicable: 2 },
    });
    expect(first.moduleRollups.find((rollup) => rollup.scopeId === 'module-shared')).toMatchObject({
      state: 'partial',
      eligibleEntityIds: ['call-shared'],
    });
    expect(first.workspaceCounts.eligible).toBe(
      first.workspaceCounts.implemented +
      first.workspaceCounts.unimplemented +
      first.workspaceCounts.partial +
      first.workspaceCounts.unknown,
    );
    expect(validateTargetWorkspaceModuleSnapshot(first, ir, catalog)).toBe(first);
  });

  it('rejects omitted callable facts and ambiguous ownership in shared files', () => {
    const ir = makeIr();
    const assessments = makeAssessments(ir);
    expect(() => buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog: makeCatalog(),
      assessments: assessments.slice(1),
      producer: { kind: 'ingestion-host', id: 'target-host' },
      createdAt: NOW,
    })).toThrow('no explicit implementation assessment');

    const ambiguous = makeCatalog({
      modules: makeCatalog().modules.map((module) => ({
        ...module,
        entityIds: module.entityIds.filter((id) => id !== 'call-shared'),
        entryPointEntityIds: module.entryPointEntityIds.filter((id) => id !== 'call-shared'),
        publicApiEntityIds: module.publicApiEntityIds.filter((id) => id !== 'call-shared'),
      })),
    });
    expect(() => buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog: ambiguous,
      assessments,
      producer: { kind: 'ingestion-host', id: 'target-host' },
      createdAt: NOW,
    })).toThrow('shared file needs one explicit module owner');

    const staleAssessment = {
      ...assessments[0]!,
      lineage: { ...assessments[0]!.lineage, unifiedRepositoryIrHash: '0'.repeat(64) },
    };
    expect(() => buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog: makeCatalog(),
      assessments: [staleAssessment, ...assessments.slice(1)],
      producer: { kind: 'ingestion-host', id: 'target-host' },
      createdAt: NOW,
    })).toThrow('stale IR lineage');
  });

  it('rejects a tampered aggregate even when leaf assessments are intact', () => {
    const ir = makeIr();
    const catalog = makeCatalog();
    const snapshot = buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog,
      assessments: makeAssessments(ir),
      producer: { kind: 'ingestion-host', id: 'target-host' },
      createdAt: NOW,
    });
    const tampered = {
      ...snapshot,
      workspaceCounts: { ...snapshot.workspaceCounts, implemented: 99 },
    };
    expect(() => validateTargetWorkspaceModuleSnapshot(tampered, ir, catalog))
      .toThrow('hash or deterministic projection is invalid');
  });

  it('distinguishes exact lineage, declaration-compatible changes and structural staleness', () => {
    const ir = makeIr();
    const catalog = makeCatalog();
    const snapshot = buildTargetWorkspaceModuleSnapshot({
      ir,
      catalog,
      assessments: makeAssessments(ir),
      producer: { kind: 'ingestion-host', id: 'target-host' },
      createdAt: NOW,
    });
    expect(classifyTargetWorkspaceSnapshotFreshness(snapshot, ir, catalog)).toEqual({
      status: 'current',
      reasonCodes: [],
      currentStructureHash: snapshot.structureHash,
      currentModuleBoundaryHash: snapshot.moduleBoundaryHash,
    });

    const bodyChanged = makeIr({
      id: 'unified-ir-2',
      repositoryRevision: 'commit-2',
      repositoryContentHash: '7'.repeat(64),
      contentHash: '8'.repeat(64),
      files: files.map((file) => file.id === 'file-main'
        ? { ...file, contentHash: '9'.repeat(64) }
        : file),
    });
    expect(classifyTargetWorkspaceSnapshotFreshness(snapshot, bodyChanged)).toMatchObject({
      status: 'body-only-compatible',
      reasonCodes: expect.arrayContaining([
        'repository-content-changed',
        'unified-ir-changed',
        'module-catalog-unavailable',
      ]),
    });

    const dependencyChanged = makeIr({
      id: 'unified-ir-dependency-change',
      repositoryContentHash: 'd'.repeat(64),
      contentHash: 'e'.repeat(64),
      dependencies: [{
        id: 'dependency:new-call',
        sourceEntityId: 'call-implemented',
        targetEntityId: 'call-shared',
        sourceFileId: 'file-main',
        targetFileId: 'file-shared',
        kind: 'invocation',
        internal: true,
        resolution: 'resolved',
        evidenceLevel: 'syntactic',
        evidenceRefs: [],
      }],
    });
    expect(classifyTargetWorkspaceSnapshotFreshness(snapshot, dependencyChanged)).toMatchObject({
      status: 'stale',
      reasonCodes: expect.arrayContaining(['structure-changed']),
    });

    const signatureChanged = makeIr({
      id: 'unified-ir-3',
      repositoryContentHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      entities: entities.map((entity) => entity.id === 'call-implemented'
        ? { ...entity, signature: 'public int Ready(string input)' }
        : entity),
    });
    expect(classifyTargetWorkspaceSnapshotFreshness(snapshot, signatureChanged)).toMatchObject({
      status: 'stale',
      reasonCodes: expect.arrayContaining(['structure-changed']),
    });

    const boundaryChangedBase = makeCatalog();
    const boundaryChanged = makeCatalog({
      id: 'catalog-2',
      contentHash: 'c'.repeat(64),
      modules: boundaryChangedBase.modules.map((module) => module.id === 'module-main'
        ? { ...module, entityIds: [...module.entityIds, 'call-shared'] }
        : {
            ...module,
            entityIds: module.entityIds.filter((id) => id !== 'call-shared'),
            entryPointEntityIds: module.entryPointEntityIds.filter((id) => id !== 'call-shared'),
            publicApiEntityIds: module.publicApiEntityIds.filter((id) => id !== 'call-shared'),
          }),
    });
    expect(classifyTargetWorkspaceSnapshotFreshness(snapshot, ir, boundaryChanged)).toMatchObject({
      status: 'stale',
      reasonCodes: expect.arrayContaining(['module-boundary-changed']),
    });
  });
});
