import {
  targetWorkspaceSchemaVersion,
  type EntityImplementationAssessment,
  type EntityImplementationAssessmentDraft,
  type ImplementationAssessmentBasis,
  type ImplementationRollupCounts,
  type ImplementationState,
  type RepositoryEvidenceRef,
  type RepositoryIREntity,
  type RepositoryIRFile,
  type RepositoryModuleAssignment,
  type RepositoryModuleCatalog,
  type TargetImplementationRollup,
  type TargetImplementationRollupScope,
  type TargetWorkspaceAnalysisLineage,
  type TargetWorkspaceExcludedEntity,
  type TargetWorkspaceExclusionReason,
  type TargetWorkspaceModuleLineage,
  type TargetWorkspaceModuleSnapshot,
  type TargetWorkspaceSnapshotFreshnessReason,
  type TargetWorkspaceSnapshotFreshnessResult,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { canonicalJson, sha256Hex } from './module-plan-utils';

const sha256Pattern = /^[0-9a-f]{64}$/;
const implementationStates = new Set<ImplementationState>([
  'implemented',
  'unimplemented',
  'partial',
  'unknown',
  'not-applicable',
]);
const assessmentBases = new Set<ImplementationAssessmentBasis>([
  'explicit-stub',
  'syntactic-body',
  'validation-backed',
  'declaration-only',
  'heuristic',
  'unavailable',
]);

export interface CreateEntityImplementationAssessmentInput {
  draft: EntityImplementationAssessmentDraft;
  lineage: TargetWorkspaceAnalysisLineage;
  createdAt: string;
}

export interface BuildTargetWorkspaceModuleSnapshotInput {
  ir: UnifiedRepositoryIR;
  catalog: RepositoryModuleCatalog;
  assessments: readonly EntityImplementationAssessment[];
  producer: TargetWorkspaceModuleSnapshot['producer'];
  createdAt: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function requireSha256(value: string, label: string): string {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireTimestamp(value: string, label: string): string {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-compatible timestamp.`);
  }
  return value;
}

function canonicalEvidenceRefs(refs: readonly RepositoryEvidenceRef[]): RepositoryEvidenceRef[] {
  if (refs.length === 0) throw new Error('Implementation assessment must cite evidence.');
  const ids = new Set<string>();
  const result = refs.map((ref) => {
    const id = requiredText(ref.id, 'Implementation evidence ID');
    if (ids.has(id)) throw new Error(`Duplicate implementation evidence ID: ${id}`);
    ids.add(id);
    return {
      id,
      kind: ref.kind,
      ...(ref.sourceArtifactId
        ? { sourceArtifactId: requiredText(ref.sourceArtifactId, 'Evidence source artifact ID') }
        : {}),
      ...(ref.path ? { path: ref.path } : {}),
      ...(ref.range ? { range: { ...ref.range } } : {}),
      ...(ref.summary ? { summary: ref.summary } : {}),
    };
  });
  return result.sort((left, right) => compareText(left.id, right.id));
}

function canonicalAnalysisLineage(
  lineage: TargetWorkspaceAnalysisLineage,
): TargetWorkspaceAnalysisLineage {
  return {
    repositoryId: requiredText(lineage.repositoryId, 'Target repository ID'),
    ...(lineage.repositoryRevision
      ? { repositoryRevision: requiredText(lineage.repositoryRevision, 'Target repository revision') }
      : {}),
    repositoryContentHash: requireSha256(
      lineage.repositoryContentHash,
      'Target repository content hash',
    ),
    unifiedRepositoryIrId: requiredText(lineage.unifiedRepositoryIrId, 'Unified IR ID'),
    unifiedRepositoryIrHash: requireSha256(lineage.unifiedRepositoryIrHash, 'Unified IR hash'),
  };
}

function analysisLineage(ir: UnifiedRepositoryIR): TargetWorkspaceAnalysisLineage {
  return canonicalAnalysisLineage({
    repositoryId: ir.repositoryId,
    ...(ir.repositoryRevision ? { repositoryRevision: ir.repositoryRevision } : {}),
    repositoryContentHash: ir.repositoryContentHash,
    unifiedRepositoryIrId: ir.id,
    unifiedRepositoryIrHash: ir.contentHash,
  });
}

function moduleLineage(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): TargetWorkspaceModuleLineage {
  if (!catalog.reviewId || !catalog.reviewHash) {
    throw new Error('Target workspace module catalog must be bound to an accepted review.');
  }
  return {
    ...analysisLineage(ir),
    moduleCatalogId: requiredText(catalog.id, 'Module catalog ID'),
    moduleCatalogHash: requireSha256(catalog.contentHash, 'Module catalog hash'),
    moduleReviewId: requiredText(catalog.reviewId, 'Module review ID'),
    moduleReviewHash: requireSha256(catalog.reviewHash, 'Module review hash'),
  };
}

/** Bind an adapter finding to one immutable UnifiedRepositoryIR. */
export function createEntityImplementationAssessment(
  input: CreateEntityImplementationAssessmentInput,
): EntityImplementationAssessment {
  const { draft } = input;
  if (!implementationStates.has(draft.state)) {
    throw new Error(`Unsupported implementation state: ${String(draft.state)}`);
  }
  if (!assessmentBases.has(draft.basis)) {
    throw new Error(`Unsupported implementation assessment basis: ${String(draft.basis)}`);
  }
  const reasonCodes = sortedUnique(
    draft.reasonCodes.map((reason) => requiredText(reason, 'Implementation reason code')),
  );
  if (reasonCodes.length === 0) {
    throw new Error('Implementation assessment must include at least one reason code.');
  }
  const detector = {
    id: requiredText(draft.detector.id, 'Implementation detector ID'),
    version: requiredText(draft.detector.version, 'Implementation detector version'),
    ...(draft.detector.languageId
      ? { languageId: requiredText(draft.detector.languageId, 'Implementation detector language') }
      : {}),
    ...(draft.detector.configurationHash
      ? {
          configurationHash: requireSha256(
            draft.detector.configurationHash,
            'Implementation detector configuration hash',
          ),
        }
      : {}),
  };
  const payload: Omit<EntityImplementationAssessment, 'id' | 'contentHash'> = {
    schemaVersion: targetWorkspaceSchemaVersion,
    entityId: requiredText(draft.entityId, 'Implementation entity ID'),
    fileId: requiredText(draft.fileId, 'Implementation file ID'),
    ...(draft.bodyHash
      ? { bodyHash: requireSha256(draft.bodyHash, 'Implementation body hash') }
      : {}),
    state: draft.state,
    basis: draft.basis,
    reasonCodes,
    evidenceRefs: canonicalEvidenceRefs(draft.evidenceRefs),
    detector,
    lineage: canonicalAnalysisLineage(input.lineage),
    createdAt: requireTimestamp(input.createdAt, 'Implementation assessment creation time'),
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `target-implementation-assessment:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

function entityStructureKey(
  entity: RepositoryIREntity,
  fileById: ReadonlyMap<string, RepositoryIRFile>,
  entityById: ReadonlyMap<string, RepositoryIREntity>,
): string {
  const filePath = entity.fileId ? fileById.get(entity.fileId)?.path ?? '' : '';
  const container = entity.containerEntityId
    ? entityById.get(entity.containerEntityId)
    : undefined;
  const staticKind = entity.attributes?.staticSymbolKind;
  return canonicalJson({
    filePath,
    kind: entity.kind,
    name: entity.name,
    qualifiedName: entity.qualifiedName,
    languageId: entity.languageId,
    signature: declarationSignature(entity.signature),
    visibility: entity.visibility,
    testOnly: entity.testOnly,
    staticSymbolKind: typeof staticKind === 'string' ? staticKind : undefined,
    container: container
      ? {
          kind: container.kind,
          qualifiedName: container.qualifiedName,
          name: container.name,
          filePath: container.fileId ? fileById.get(container.fileId)?.path ?? '' : '',
        }
      : undefined,
  });
}

function declarationSignature(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const bodyOffsets = [value.indexOf('{'), value.indexOf('=>')]
    .filter((offset) => offset >= 0);
  const bodyOffset = bodyOffsets.length > 0 ? Math.min(...bodyOffsets) : value.length;
  return value.slice(0, bodyOffset).replace(/\s+/g, ' ').trim();
}

/**
 * Hash only declaration-oriented facts. A match means that an explicit module
 * boundary rebase may be attempted; it does not prove that only bodies changed.
 */
export function calculateTargetWorkspaceStructureHash(ir: UnifiedRepositoryIR): string {
  const fileById = new Map(ir.files.map((file) => [file.id, file]));
  const entityById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const entityKeyById = new Map(
    ir.entities.map((entity) => [entity.id, entityStructureKey(entity, fileById, entityById)]),
  );
  const projection = {
    repositoryId: ir.repositoryId,
    files: ir.files.map((file) => ({
      path: file.path,
      role: file.role,
      languageId: file.languageId,
      projectIds: sortedUnique(file.projectIds),
      generated: file.generated,
    })).sort((left, right) => compareText(left.path, right.path)),
    entities: ir.entities.map((entity) => entityKeyById.get(entity.id)!)
      .sort(compareText),
    apiSurfaces: ir.apiSurfaces.map((surface) => ({
      entity: entityKeyById.get(surface.entityId) ?? `missing:${surface.entityId}`,
      languageId: surface.languageId,
      kind: surface.kind,
      name: surface.name,
      qualifiedName: surface.qualifiedName,
      signature: declarationSignature(surface.signature) ?? '',
      visibility: surface.visibility,
      exposure: surface.exposure,
      parameters: surface.parameters?.map((parameter) => ({
        name: parameter.name,
        position: parameter.position,
        type: parameter.type,
        required: parameter.required,
        variadic: parameter.variadic,
      })),
      returnShape: surface.returnShape
        ? {
            type: surface.returnShape.type,
            nullable: surface.returnShape.nullable,
            asynchronous: surface.returnShape.asynchronous,
          }
        : undefined,
      completeness: surface.completeness,
      missingFeatures: sortedUnique(surface.missingFeatures),
    })).sort((left, right) => compareText(left.entity, right.entity)),
    // A callable body may change the dependency graph without changing its
    // declaration. Reusing the old module dependency proposal in that case is
    // unsafe, so dependency identities are part of rebase compatibility.
    dependencies: ir.dependencies.map((dependency) => ({
      sourceFilePath: fileById.get(dependency.sourceFileId)?.path ??
        `missing:${dependency.sourceFileId}`,
      targetFilePath: dependency.targetFileId === undefined
        ? undefined
        : fileById.get(dependency.targetFileId)?.path ?? `missing:${dependency.targetFileId}`,
      sourceEntity: dependency.sourceEntityId === undefined
        ? undefined
        : entityKeyById.get(dependency.sourceEntityId) ?? `missing:${dependency.sourceEntityId}`,
      targetEntity: dependency.targetEntityId === undefined
        ? undefined
        : entityKeyById.get(dependency.targetEntityId) ?? `missing:${dependency.targetEntityId}`,
      kind: dependency.kind,
      internal: dependency.internal,
      resolution: dependency.resolution,
      evidenceLevel: dependency.evidenceLevel,
      targetReference: dependency.targetReference,
    })).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right))),
  };
  return sha256Hex(canonicalJson(projection));
}

/** Project reviewed module ownership onto path/declaration identities, not IR IDs. */
export function calculateTargetWorkspaceModuleBoundaryHash(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): string {
  const fileById = new Map(ir.files.map((file) => [file.id, file]));
  const entityById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const entityKeyById = new Map(
    ir.entities.map((entity) => [entity.id, entityStructureKey(entity, fileById, entityById)]),
  );
  const pathFor = (fileId: string): string => {
    const file = fileById.get(fileId);
    if (!file) throw new Error(`Module catalog references unknown IR file: ${fileId}`);
    return file.path;
  };
  const entityKeyFor = (entityId: string): string => {
    const key = entityKeyById.get(entityId);
    if (!key) throw new Error(`Module catalog references unknown IR entity: ${entityId}`);
    return key;
  };
  const projection = {
    repositoryId: catalog.repositoryId,
    modules: catalog.modules.map((module) => ({
      id: module.id,
      name: module.name,
      kind: module.kind,
      filePaths: module.fileIds.map(pathFor).sort(compareText),
      entities: module.entityIds.map(entityKeyFor).sort(compareText),
      entryPoints: module.entryPointEntityIds.map(entityKeyFor).sort(compareText),
      publicApis: module.publicApiEntityIds.map(entityKeyFor).sort(compareText),
    })).sort((left, right) => compareText(left.id, right.id)),
    assignments: catalog.assignments.map((assignment) => ({
      path: pathFor(assignment.fileId),
      kind: assignment.kind,
      moduleIds: sortedUnique(assignment.moduleIds),
    })).sort((left, right) => compareText(left.path, right.path)),
    dependencies: catalog.dependencies.map((dependency) => ({
      sourceModuleId: dependency.sourceModuleId,
      targetModuleId: dependency.targetModuleId,
      kind: dependency.kind,
    })).sort((left, right) => compareText(
      `${left.sourceModuleId}\u0000${left.targetModuleId}\u0000${left.kind}`,
      `${right.sourceModuleId}\u0000${right.targetModuleId}\u0000${right.kind}`,
    )),
    unassignedPaths: catalog.unassignedFileIds.map(pathFor).sort(compareText),
    overlappingPaths: catalog.overlappingFileIds.map(pathFor).sort(compareText),
  };
  return sha256Hex(canonicalJson(projection));
}

function assertCatalogLineage(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): void {
  requireSha256(ir.repositoryContentHash, 'Unified IR repository content hash');
  requireSha256(ir.contentHash, 'Unified IR content hash');
  requireSha256(catalog.contentHash, 'Module catalog content hash');
  if (catalog.status !== 'active') {
    throw new Error('Target workspace requires an active, reviewed module catalog.');
  }
  if (
    catalog.repositoryId !== ir.repositoryId ||
    catalog.sourceIrId !== ir.id ||
    catalog.sourceIrHash !== ir.contentHash
  ) {
    throw new Error('Target workspace module catalog lineage does not match UnifiedRepositoryIR.');
  }
  if (!catalog.reviewId || !catalog.reviewHash) {
    throw new Error('Target workspace module catalog must contain review lineage.');
  }
  requireSha256(catalog.reviewHash, 'Module review hash');

  const files = new Map(ir.files.map((file) => [file.id, file]));
  const fileIds = new Set(files.keys());
  const entities = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const modules = new Map<string, RepositoryModuleCatalog['modules'][number]>();
  for (const module of catalog.modules) {
    if (modules.has(module.id)) throw new Error(`Duplicate target module ID: ${module.id}`);
    modules.set(module.id, module);
  }
  const assignmentIds = new Set<string>();
  const assignedFilesByModule = new Map(
    catalog.modules.map((module) => [module.id, new Set<string>()]),
  );
  for (const assignment of catalog.assignments) {
    if (!fileIds.has(assignment.fileId)) {
      throw new Error(`Module assignment references unknown IR file: ${assignment.fileId}`);
    }
    if (assignmentIds.has(assignment.fileId)) {
      throw new Error(`Duplicate module assignment for IR file: ${assignment.fileId}`);
    }
    assignmentIds.add(assignment.fileId);
    if (assignment.kind === 'owned' && assignment.moduleIds.length !== 1) {
      throw new Error(`Owned module assignment must name exactly one module: ${assignment.fileId}`);
    }
    if (assignment.kind === 'shared' && assignment.moduleIds.length < 2) {
      throw new Error(`Shared module assignment must name at least two modules: ${assignment.fileId}`);
    }
    if (
      (assignment.kind === 'excluded' || assignment.kind === 'unassigned') &&
      assignment.moduleIds.length !== 0
    ) {
      throw new Error(`${assignment.kind} module assignment cannot name a module: ${assignment.fileId}`);
    }
    if (assignment.kind === 'test' && files.get(assignment.fileId)?.role !== 'test') {
      throw new Error(`Test assignment must reference an IR test file: ${assignment.fileId}`);
    }
    if (assignment.kind === 'generated' && files.get(assignment.fileId)?.role !== 'generated') {
      throw new Error(`Generated assignment must reference an IR generated file: ${assignment.fileId}`);
    }
    for (const moduleId of assignment.moduleIds) {
      const assigned = assignedFilesByModule.get(moduleId);
      if (!assigned) throw new Error(`Module assignment references unknown module: ${moduleId}`);
      assigned.add(assignment.fileId);
    }
  }
  for (const fileId of fileIds) {
    if (!assignmentIds.has(fileId)) {
      throw new Error(`Target workspace module catalog does not account for IR file: ${fileId}`);
    }
  }

  const entityOwner = new Map<string, string>();
  for (const module of catalog.modules) {
    const expectedFiles = sortedUnique(assignedFilesByModule.get(module.id) ?? []);
    if (canonicalJson(sortedUnique(module.fileIds)) !== canonicalJson(expectedFiles)) {
      throw new Error(`Target module file IDs do not match catalog assignments: ${module.id}`);
    }
    const ownedEntities = new Set(module.entityIds);
    if (ownedEntities.size !== module.entityIds.length) {
      throw new Error(`Target module contains duplicate entity IDs: ${module.id}`);
    }
    for (const entityId of module.entityIds) {
      const entity = entities.get(entityId);
      if (!entity) throw new Error(`Target module references unknown IR entity: ${entityId}`);
      if (entity.fileId && !module.fileIds.includes(entity.fileId)) {
        throw new Error(`Target module entity is outside its file assignments: ${entityId}`);
      }
      const previous = entityOwner.get(entityId);
      if (previous) throw new Error(`IR entity belongs to both ${previous} and ${module.id}: ${entityId}`);
      entityOwner.set(entityId, module.id);
    }
    for (const entityId of [...module.entryPointEntityIds, ...module.publicApiEntityIds]) {
      if (!ownedEntities.has(entityId)) {
        throw new Error(`Target module interface is outside entity ownership: ${entityId}`);
      }
    }
  }
  const expectedUnassigned = catalog.assignments
    .filter((assignment) => assignment.kind === 'unassigned')
    .map((assignment) => assignment.fileId);
  const expectedOverlapping = catalog.assignments
    .filter((assignment) => assignment.moduleIds.length > 1)
    .map((assignment) => assignment.fileId);
  if (canonicalJson(sortedUnique(catalog.unassignedFileIds)) !== canonicalJson(sortedUnique(expectedUnassigned))) {
    throw new Error('Target catalog unassigned file projection is inconsistent.');
  }
  if (canonicalJson(sortedUnique(catalog.overlappingFileIds)) !== canonicalJson(sortedUnique(expectedOverlapping))) {
    throw new Error('Target catalog overlapping file projection is inconsistent.');
  }
}

function verifiedAssessments(
  ir: UnifiedRepositoryIR,
  assessments: readonly EntityImplementationAssessment[],
): EntityImplementationAssessment[] {
  const expectedLineage = analysisLineage(ir);
  const entities = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const callableIds = new Set(
    ir.entities.filter((entity) => entity.kind === 'callable').map((entity) => entity.id),
  );
  const byEntity = new Map<string, EntityImplementationAssessment>();
  for (const assessment of assessments) {
    if (byEntity.has(assessment.entityId)) {
      throw new Error(`Duplicate implementation assessment for entity: ${assessment.entityId}`);
    }
    const entity = entities.get(assessment.entityId);
    if (!entity || entity.kind !== 'callable') {
      throw new Error(`Implementation assessment references a non-callable entity: ${assessment.entityId}`);
    }
    if (!entity.fileId || entity.fileId !== assessment.fileId) {
      throw new Error(`Implementation assessment file does not match entity: ${assessment.entityId}`);
    }
    if (canonicalJson(assessment.lineage) !== canonicalJson(expectedLineage)) {
      throw new Error(`Implementation assessment has stale IR lineage: ${assessment.entityId}`);
    }
    const rebuilt = createEntityImplementationAssessment({
      draft: {
        entityId: assessment.entityId,
        fileId: assessment.fileId,
        ...(assessment.bodyHash ? { bodyHash: assessment.bodyHash } : {}),
        state: assessment.state,
        basis: assessment.basis,
        reasonCodes: assessment.reasonCodes,
        evidenceRefs: assessment.evidenceRefs,
        detector: assessment.detector,
      },
      lineage: assessment.lineage,
      createdAt: assessment.createdAt,
    });
    if (
      assessment.schemaVersion !== targetWorkspaceSchemaVersion ||
      assessment.id !== rebuilt.id ||
      assessment.contentHash !== rebuilt.contentHash ||
      canonicalJson(assessment) !== canonicalJson(rebuilt)
    ) {
      throw new Error(`Implementation assessment content hash is invalid: ${assessment.entityId}`);
    }
    byEntity.set(assessment.entityId, rebuilt);
  }
  for (const entityId of callableIds) {
    if (!byEntity.has(entityId)) {
      throw new Error(`Callable has no explicit implementation assessment: ${entityId}`);
    }
  }
  return [...byEntity.values()].sort((left, right) => compareText(left.entityId, right.entityId));
}

function exclusionReason(
  entity: RepositoryIREntity,
  file: RepositoryIRFile,
  assignment: RepositoryModuleAssignment,
  assessment: EntityImplementationAssessment,
): TargetWorkspaceExclusionReason | undefined {
  if (entity.testOnly || file.role === 'test' || assignment.kind === 'test') return 'test';
  if (file.generated || file.role === 'generated' || assignment.kind === 'generated') {
    return 'generated';
  }
  if (assignment.kind === 'excluded') return 'excluded-file';
  if (assignment.kind === 'unassigned') return 'unassigned-file';
  if (file.role !== 'source') return 'non-source-file';
  if (assessment.state === 'not-applicable') return 'not-applicable';
  return undefined;
}

interface CallableOutcome {
  assessment: EntityImplementationAssessment;
  entity: RepositoryIREntity;
  file: RepositoryIRFile;
  exclusion?: TargetWorkspaceExclusionReason;
  moduleId?: string;
}

function rollupState(counts: ImplementationRollupCounts): ImplementationState {
  if (counts.eligible === 0) return 'not-applicable';
  if (counts.unknown > 0) return 'unknown';
  if (counts.partial > 0) return 'partial';
  if (counts.implemented === counts.eligible) return 'implemented';
  if (counts.unimplemented === counts.eligible) return 'unimplemented';
  return 'partial';
}

function countsForOutcomes(
  eligible: readonly CallableOutcome[],
  excludedCount: number,
): ImplementationRollupCounts {
  const counts: ImplementationRollupCounts = {
    eligible: eligible.length,
    implemented: 0,
    unimplemented: 0,
    partial: 0,
    unknown: 0,
    notApplicable: excludedCount,
  };
  for (const outcome of eligible) {
    if (outcome.assessment.state === 'not-applicable') {
      throw new Error(`Not-applicable callable leaked into the denominator: ${outcome.entity.id}`);
    }
    counts[outcome.assessment.state] += 1;
  }
  return counts;
}

function createRollup(
  scope: TargetImplementationRollupScope,
  scopeId: string,
  outcomes: readonly CallableOutcome[],
): TargetImplementationRollup {
  const eligible = outcomes.filter((outcome) => outcome.exclusion === undefined);
  const excluded = outcomes.filter((outcome) => outcome.exclusion !== undefined);
  const eligibleEntityIds = sortedUnique(eligible.map((outcome) => outcome.entity.id));
  const excludedEntityIds = sortedUnique(excluded.map((outcome) => outcome.entity.id));
  if (eligibleEntityIds.length !== eligible.length || excludedEntityIds.length !== excluded.length) {
    throw new Error(`Duplicate callable in ${scope} rollup: ${scopeId}`);
  }
  const counts = countsForOutcomes(eligible, excluded.length);
  const payload: Omit<TargetImplementationRollup, 'id' | 'contentHash'> = {
    schemaVersion: targetWorkspaceSchemaVersion,
    scope,
    scopeId,
    state: rollupState(counts),
    counts,
    eligibleEntityIds,
    excludedEntityIds,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `target-implementation-rollup:${scope}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

function callableOutcomes(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
  assessments: readonly EntityImplementationAssessment[],
): CallableOutcome[] {
  const files = new Map(ir.files.map((file) => [file.id, file]));
  const assignments = new Map(catalog.assignments.map((assignment) => [assignment.fileId, assignment]));
  const modules = new Set(catalog.modules.map((module) => module.id));
  const explicitOwner = new Map<string, string>();
  for (const module of catalog.modules) {
    for (const entityId of module.entityIds) {
      const previous = explicitOwner.get(entityId);
      if (previous && previous !== module.id) {
        throw new Error(`Module catalog assigns entity to multiple modules: ${entityId}`);
      }
      explicitOwner.set(entityId, module.id);
    }
  }

  const entities = new Map(ir.entities.map((entity) => [entity.id, entity]));
  return assessments.map((assessment) => {
    const entity = entities.get(assessment.entityId)!;
    const file = files.get(assessment.fileId);
    const assignment = assignments.get(assessment.fileId);
    if (!file || !assignment) {
      throw new Error(`Implementation assessment is outside catalog file ownership: ${assessment.entityId}`);
    }
    for (const moduleId of assignment.moduleIds) {
      if (!modules.has(moduleId)) {
        throw new Error(`Module assignment references unknown module: ${moduleId}`);
      }
    }
    let moduleId = explicitOwner.get(entity.id);
    if (assignment.kind === 'owned') {
      const assignedModuleId = assignment.moduleIds[0]!;
      if (moduleId && moduleId !== assignedModuleId) {
        throw new Error(`Callable owner conflicts with owned file assignment: ${entity.id}`);
      }
      moduleId = assignedModuleId;
    } else if (assignment.kind === 'shared') {
      if (!moduleId || !assignment.moduleIds.includes(moduleId)) {
        throw new Error(
          `Callable in a shared file needs one explicit module owner for unique counting: ${entity.id}`,
        );
      }
    } else if (moduleId && assignment.moduleIds.length > 0 && !assignment.moduleIds.includes(moduleId)) {
      throw new Error(`Callable owner is outside its file assignment: ${entity.id}`);
    }
    return {
      assessment,
      entity,
      file,
      ...(exclusionReason(entity, file, assignment, assessment)
        ? { exclusion: exclusionReason(entity, file, assignment, assessment)! }
        : {}),
      ...(moduleId ? { moduleId } : {}),
    };
  }).sort((left, right) => compareText(left.entity.id, right.entity.id));
}

/** Build deterministic class/file/module aggregates from a reviewed 01A catalog. */
export function buildTargetWorkspaceModuleSnapshot(
  input: BuildTargetWorkspaceModuleSnapshotInput,
): TargetWorkspaceModuleSnapshot {
  assertCatalogLineage(input.ir, input.catalog);
  const assessments = verifiedAssessments(input.ir, input.assessments);
  const outcomes = callableOutcomes(input.ir, input.catalog, assessments);
  const outcomesByFile = new Map<string, CallableOutcome[]>();
  const outcomesByClass = new Map<string, CallableOutcome[]>();
  const outcomesByModule = new Map<string, CallableOutcome[]>();
  for (const outcome of outcomes) {
    const fileOutcomes = outcomesByFile.get(outcome.file.id) ?? [];
    fileOutcomes.push(outcome);
    outcomesByFile.set(outcome.file.id, fileOutcomes);
    if (outcome.entity.containerEntityId) {
      const classOutcomes = outcomesByClass.get(outcome.entity.containerEntityId) ?? [];
      classOutcomes.push(outcome);
      outcomesByClass.set(outcome.entity.containerEntityId, classOutcomes);
    }
    if (outcome.moduleId) {
      const moduleOutcomes = outcomesByModule.get(outcome.moduleId) ?? [];
      moduleOutcomes.push(outcome);
      outcomesByModule.set(outcome.moduleId, moduleOutcomes);
    }
  }

  const classRollups = input.ir.entities
    .filter((entity) => entity.kind === 'type')
    .map((entity) => createRollup('class', entity.id, outcomesByClass.get(entity.id) ?? []))
    .sort((left, right) => compareText(left.scopeId, right.scopeId));
  const fileRollups = input.ir.files
    .map((file) => createRollup('file', file.id, outcomesByFile.get(file.id) ?? []))
    .sort((left, right) => compareText(left.scopeId, right.scopeId));
  const moduleRollups = input.catalog.modules
    .map((module) => createRollup('module', module.id, outcomesByModule.get(module.id) ?? []))
    .sort((left, right) => compareText(left.scopeId, right.scopeId));
  const eligible = outcomes.filter((outcome) => outcome.exclusion === undefined);
  const excluded = outcomes.filter((outcome) => outcome.exclusion !== undefined);
  const workspaceCounts = countsForOutcomes(eligible, excluded.length);
  const excludedEntities: TargetWorkspaceExcludedEntity[] = excluded.map((outcome) => ({
    entityId: outcome.entity.id,
    fileId: outcome.file.id,
    reason: outcome.exclusion!,
  })).sort((left, right) => compareText(left.entityId, right.entityId));
  const lineage = moduleLineage(input.ir, input.catalog);
  const payload: Omit<TargetWorkspaceModuleSnapshot, 'id' | 'contentHash'> = {
    schemaVersion: targetWorkspaceSchemaVersion,
    lineage,
    structureHash: calculateTargetWorkspaceStructureHash(input.ir),
    moduleBoundaryHash: calculateTargetWorkspaceModuleBoundaryHash(input.ir, input.catalog),
    assessments,
    classRollups,
    fileRollups,
    moduleRollups,
    workspaceCounts,
    excludedEntities,
    producer: {
      kind: input.producer.kind,
      id: requiredText(input.producer.id, 'Target snapshot producer ID'),
      ...(input.producer.version ? { version: input.producer.version } : {}),
      ...(input.producer.configurationHash
        ? {
            configurationHash: requireSha256(
              input.producer.configurationHash,
              'Target snapshot producer configuration hash',
            ),
          }
        : {}),
    },
    createdAt: requireTimestamp(input.createdAt, 'Target snapshot creation time'),
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `target-workspace-module-snapshot:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

/** Verify hash, lineage, denominator policy and every deterministic rollup. */
export function validateTargetWorkspaceModuleSnapshot(
  snapshot: TargetWorkspaceModuleSnapshot,
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): TargetWorkspaceModuleSnapshot {
  const rebuilt = buildTargetWorkspaceModuleSnapshot({
    ir,
    catalog,
    assessments: snapshot.assessments,
    producer: snapshot.producer,
    createdAt: snapshot.createdAt,
  });
  if (
    snapshot.schemaVersion !== targetWorkspaceSchemaVersion ||
    snapshot.id !== rebuilt.id ||
    snapshot.contentHash !== rebuilt.contentHash ||
    canonicalJson(snapshot) !== canonicalJson(rebuilt)
  ) {
    throw new Error('Target workspace module snapshot hash or deterministic projection is invalid.');
  }
  return snapshot;
}

function snapshotEnvelopeIsValid(snapshot: TargetWorkspaceModuleSnapshot): boolean {
  const { id, contentHash, ...payload } = snapshot;
  const expectedHash = sha256Hex(canonicalJson(payload));
  return contentHash === expectedHash &&
    id === `target-workspace-module-snapshot:${expectedHash.slice(0, 24)}`;
}

/**
 * Compare immutable lineage with a later IR. `body-only-compatible` means only
 * that the declaration projection is unchanged and a reviewed rebase may be
 * attempted. All old assessments remain stale until rebuilt for the new IR.
 */
export function classifyTargetWorkspaceSnapshotFreshness(
  snapshot: TargetWorkspaceModuleSnapshot,
  currentIr: UnifiedRepositoryIR,
  currentCatalog?: RepositoryModuleCatalog,
): TargetWorkspaceSnapshotFreshnessResult {
  if (!snapshotEnvelopeIsValid(snapshot)) {
    throw new Error('Cannot classify a target workspace snapshot with an invalid content hash.');
  }
  const reasons = new Set<TargetWorkspaceSnapshotFreshnessReason>();
  const currentStructureHash = calculateTargetWorkspaceStructureHash(currentIr);
  if (snapshot.lineage.repositoryId !== currentIr.repositoryId) reasons.add('repository-changed');
  if (snapshot.lineage.repositoryContentHash !== currentIr.repositoryContentHash) {
    reasons.add('repository-content-changed');
  }
  const exactIr = snapshot.lineage.unifiedRepositoryIrId === currentIr.id &&
    snapshot.lineage.unifiedRepositoryIrHash === currentIr.contentHash;
  if (!exactIr) reasons.add('unified-ir-changed');
  if (snapshot.structureHash !== currentStructureHash) reasons.add('structure-changed');

  let currentModuleBoundaryHash: string | undefined;
  let exactCatalog = false;
  if (!currentCatalog) {
    reasons.add('module-catalog-unavailable');
  } else {
    if (currentCatalog.status !== 'active') reasons.add('module-catalog-not-active');
    const catalogMatchesCurrentIr = currentCatalog.repositoryId === currentIr.repositoryId &&
      currentCatalog.sourceIrId === currentIr.id &&
      currentCatalog.sourceIrHash === currentIr.contentHash;
    if (!catalogMatchesCurrentIr) {
      reasons.add('module-catalog-lineage-changed');
    } else {
      currentModuleBoundaryHash = calculateTargetWorkspaceModuleBoundaryHash(currentIr, currentCatalog);
      if (currentModuleBoundaryHash !== snapshot.moduleBoundaryHash) {
        reasons.add('module-boundary-changed');
      }
      exactCatalog = currentCatalog.id === snapshot.lineage.moduleCatalogId &&
        currentCatalog.contentHash === snapshot.lineage.moduleCatalogHash &&
        currentCatalog.reviewId === snapshot.lineage.moduleReviewId &&
        currentCatalog.reviewHash === snapshot.lineage.moduleReviewHash;
      if (!exactCatalog) reasons.add('module-catalog-lineage-changed');
    }
  }

  const reasonCodes = [...reasons].sort(compareText);
  const common = {
    reasonCodes,
    currentStructureHash,
    ...(currentModuleBoundaryHash ? { currentModuleBoundaryHash } : {}),
  };
  if (
    reasonCodes.length === 0 && exactIr && exactCatalog &&
    currentCatalog?.status === 'active'
  ) {
    return { status: 'current', ...common };
  }
  if (
    snapshot.lineage.repositoryId === currentIr.repositoryId &&
    snapshot.structureHash === currentStructureHash &&
    !exactIr &&
    !reasons.has('module-boundary-changed') &&
    !reasons.has('module-catalog-not-active')
  ) {
    return { status: 'body-only-compatible', ...common };
  }
  return { status: 'stale', ...common };
}
