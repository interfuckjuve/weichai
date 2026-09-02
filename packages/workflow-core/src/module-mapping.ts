import {
  isValidModuleId,
  moduleMappingSchemaVersion,
  type CatalogRefFreshnessResult,
  type FunctionalModule,
  type LegacyFunctionalModuleMappingBinding,
  type LegacyModuleMigrationCompatibilityRecord,
  type MigrationExecutionGroup,
  type MigrationExecutionOverlay,
  type ModuleMappingCardinality,
  type ModuleMappingEntry,
  type ModuleMappingFreshnessReason,
  type ModuleMappingFreshnessResult,
  type ModuleMappingProposal,
  type ModuleMappingReview,
  type ModuleMappingReviewDecision,
  type ModuleMigrationPlan,
  type RepositoryModuleCatalog,
  type RepositoryModuleCatalogRef,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  calculateModuleMigrationPlanHash,
  canonicalJson,
  sha256Hex,
  sortedUnique,
} from './module-plan-utils';

const sha256Pattern = /^[0-9a-f]{64}$/;

interface CatalogIndexes {
  moduleIds: Set<string>;
  entityIds: Set<string>;
  entityOwner: Map<string, string>;
  evidenceIds: Set<string>;
}

export interface MaterializeModuleMappingProposalInput {
  sourceIr: UnifiedRepositoryIR;
  sourceCatalog: RepositoryModuleCatalog;
  targetIr: UnifiedRepositoryIR;
  targetCatalog: RepositoryModuleCatalog;
  objective: string;
  mappings: ModuleMappingEntry[];
  assumptions?: string[];
  risks?: string[];
  createdAt: string;
}

export interface MaterializeModuleMappingReviewInput {
  proposal: ModuleMappingProposal;
  sourceIr: UnifiedRepositoryIR;
  sourceCatalog: RepositoryModuleCatalog;
  targetIr: UnifiedRepositoryIR;
  targetCatalog: RepositoryModuleCatalog;
  decision: ModuleMappingReviewDecision;
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
  decidedAt: string;
}

export interface MigrationExecutionGroupDraft {
  id: string;
  mappingIds: string[];
  dependsOnGroupIds: string[];
}

export interface MaterializeMigrationExecutionOverlayInput {
  proposal: ModuleMappingProposal;
  review: ModuleMappingReview;
  sourceIr: UnifiedRepositoryIR;
  sourceCatalog: RepositoryModuleCatalog;
  targetIr: UnifiedRepositoryIR;
  targetCatalog: RepositoryModuleCatalog;
  routeId: string;
  routeVersion: string;
  groups: MigrationExecutionGroupDraft[];
  createdAt: string;
}

export interface ConvertLegacyModuleMigrationPlanInput
  extends Omit<MaterializeMigrationExecutionOverlayInput, 'groups'> {
  legacyPlan: ModuleMigrationPlan;
  bindings: LegacyFunctionalModuleMappingBinding[];
}

export interface ConvertLegacyModuleMigrationPlanResult {
  overlay: MigrationExecutionOverlay;
  compatibility: LegacyModuleMigrationCompatibilityRecord;
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
  if (!value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-compatible timestamp.`);
  }
  return value;
}

function canonicalTextList(values: readonly string[], label: string): string[] {
  return sortedUnique(values.map((value) => requiredText(value, label)));
}

function requireUniqueIds(values: readonly string[], label: string): string[] {
  const canonical = canonicalTextList(values, label);
  if (canonical.length !== values.length) throw new Error(`${label} must be unique.`);
  return canonical;
}

function assertCatalogStructure(ir: UnifiedRepositoryIR, catalog: RepositoryModuleCatalog): CatalogIndexes {
  requireSha256(ir.repositoryContentHash, 'Repository content hash');
  requireSha256(ir.contentHash, 'Unified repository IR hash');
  requireSha256(catalog.contentHash, 'Repository module catalog hash');
  if (catalog.status !== 'active') throw new Error('Repository module catalog must be active.');
  if (
    catalog.repositoryId !== ir.repositoryId ||
    catalog.sourceIrId !== ir.id ||
    catalog.sourceIrHash !== ir.contentHash
  ) {
    throw new Error('Repository module catalog does not bind to the supplied unified IR.');
  }
  if (!catalog.reviewId || !catalog.reviewHash) {
    throw new Error('Repository module catalog must carry accepted review lineage.');
  }
  requireSha256(catalog.reviewHash, 'Repository module review hash');

  const files = new Set(ir.files.map((file) => file.id));
  const irEntities = new Set(ir.entities.map((entity) => entity.id));
  const moduleIds = new Set<string>();
  const entityIds = new Set<string>();
  const entityOwner = new Map<string, string>();
  const evidenceIds = new Set<string>([
    ...ir.entities.map((entity) => entity.id),
    ...ir.apiSurfaces.flatMap((surface) => [surface.id, ...surface.evidenceRefs.map((ref) => ref.id)]),
    ...ir.dependencies.flatMap((dependency) => [
      dependency.id,
      ...dependency.evidenceRefs.map((ref) => ref.id),
    ]),
    ...ir.diagnostics.map((diagnostic) => diagnostic.id),
  ]);
  for (const module of catalog.modules) {
    if (moduleIds.has(module.id)) throw new Error(`Duplicate canonical module ID: ${module.id}`);
    moduleIds.add(module.id);
    for (const fileId of module.fileIds) {
      if (!files.has(fileId)) throw new Error(`Canonical module ${module.id} references unknown file ${fileId}.`);
    }
    for (const entityId of module.entityIds) {
      if (!irEntities.has(entityId)) {
        throw new Error(`Canonical module ${module.id} references unknown entity ${entityId}.`);
      }
      const previous = entityOwner.get(entityId);
      if (previous !== undefined) {
        throw new Error(`Canonical entity ${entityId} belongs to both ${previous} and ${module.id}.`);
      }
      entityOwner.set(entityId, module.id);
      entityIds.add(entityId);
    }
    for (const evidence of module.evidenceRefs) evidenceIds.add(evidence.id);
  }
  const assignments = new Set<string>();
  for (const assignment of catalog.assignments) {
    if (!files.has(assignment.fileId)) {
      throw new Error(`Canonical catalog assignment references unknown file ${assignment.fileId}.`);
    }
    if (assignments.has(assignment.fileId)) {
      throw new Error(`Canonical catalog repeats assignment for file ${assignment.fileId}.`);
    }
    assignments.add(assignment.fileId);
    const assignedModules = requireUniqueIds(
      assignment.moduleIds,
      `Canonical assignment ${assignment.fileId} module IDs`,
    );
    for (const moduleId of assignedModules) {
      if (!moduleIds.has(moduleId)) {
        throw new Error(`Canonical assignment ${assignment.fileId} references unknown module ${moduleId}.`);
      }
    }
    if (assignment.kind === 'owned' && assignedModules.length !== 1) {
      throw new Error(`Owned canonical assignment ${assignment.fileId} must name one module.`);
    }
    if (assignment.kind === 'shared' && assignedModules.length < 2) {
      throw new Error(`Shared canonical assignment ${assignment.fileId} must name at least two modules.`);
    }
    for (const evidence of assignment.evidenceRefs) evidenceIds.add(evidence.id);
  }
  for (const dependency of catalog.dependencies) {
    if (!moduleIds.has(dependency.sourceModuleId) || !moduleIds.has(dependency.targetModuleId)) {
      throw new Error('Canonical catalog dependency references an unknown module.');
    }
    for (const evidence of dependency.evidenceRefs) evidenceIds.add(evidence.id);
  }
  return { moduleIds, entityIds, entityOwner, evidenceIds };
}

export function createRepositoryModuleCatalogRef(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): RepositoryModuleCatalogRef {
  assertCatalogStructure(ir, catalog);
  return {
    repositoryId: ir.repositoryId,
    ...(ir.repositoryRevision === undefined ? {} : { repositoryRevision: ir.repositoryRevision }),
    repositoryContentHash: ir.repositoryContentHash,
    unifiedRepositoryIrId: ir.id,
    unifiedRepositoryIrHash: ir.contentHash,
    moduleCatalogId: catalog.id,
    moduleCatalogHash: catalog.contentHash,
    moduleReviewId: catalog.reviewId!,
    moduleReviewHash: catalog.reviewHash!,
  };
}

export function classifyRepositoryModuleCatalogRefFreshness(
  ref: RepositoryModuleCatalogRef,
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): CatalogRefFreshnessResult {
  const reasons = new Set<ModuleMappingFreshnessReason>();
  if (ref.repositoryId !== ir.repositoryId || catalog.repositoryId !== ir.repositoryId) {
    reasons.add('repository-changed');
  }
  if (ref.repositoryRevision !== ir.repositoryRevision) reasons.add('repository-revision-changed');
  if (ref.repositoryContentHash !== ir.repositoryContentHash) reasons.add('repository-content-changed');
  if (
    ref.unifiedRepositoryIrId !== ir.id ||
    ref.unifiedRepositoryIrHash !== ir.contentHash ||
    catalog.sourceIrId !== ir.id ||
    catalog.sourceIrHash !== ir.contentHash
  ) {
    reasons.add('unified-ir-changed');
  }
  if (catalog.status !== 'active') reasons.add('module-catalog-not-active');
  if (ref.moduleCatalogId !== catalog.id || ref.moduleCatalogHash !== catalog.contentHash) {
    reasons.add('module-catalog-changed');
  }
  if (ref.moduleReviewId !== catalog.reviewId || ref.moduleReviewHash !== catalog.reviewHash) {
    reasons.add('module-review-changed');
  }
  const reasonCodes = [...reasons].sort();
  return { status: reasonCodes.length === 0 ? 'current' : 'stale', reasonCodes };
}

export function classifyModuleMappingFreshness(
  artifact: Pick<ModuleMappingProposal | MigrationExecutionOverlay, 'sourceCatalog' | 'targetCatalog'>,
  sourceIr: UnifiedRepositoryIR,
  sourceCatalog: RepositoryModuleCatalog,
  targetIr: UnifiedRepositoryIR,
  targetCatalog: RepositoryModuleCatalog,
): ModuleMappingFreshnessResult {
  const source = classifyRepositoryModuleCatalogRefFreshness(
    artifact.sourceCatalog,
    sourceIr,
    sourceCatalog,
  );
  const target = classifyRepositoryModuleCatalogRefFreshness(
    artifact.targetCatalog,
    targetIr,
    targetCatalog,
  );
  return {
    status: source.status === 'current' && target.status === 'current' ? 'current' : 'stale',
    source,
    target,
  };
}

function assertCurrentCatalogRef(
  side: 'source' | 'target',
  ref: RepositoryModuleCatalogRef,
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
): CatalogIndexes {
  const indexes = assertCatalogStructure(ir, catalog);
  const freshness = classifyRepositoryModuleCatalogRefFreshness(ref, ir, catalog);
  if (freshness.status !== 'current') {
    throw new Error(`${side} catalog reference is stale: ${freshness.reasonCodes.join(', ')}.`);
  }
  return indexes;
}

function cardinality(sourceCount: number, targetCount: number): ModuleMappingCardinality {
  if (sourceCount === 1 && targetCount === 1) return 'one-to-one';
  if (sourceCount === 1 && targetCount > 1) return 'one-to-many';
  if (sourceCount > 1 && targetCount === 1) return 'many-to-one';
  throw new Error('Module mapping must be 1:1, 1:N, or N:1; empty and N:N mappings are invalid.');
}

function canonicalMapping(
  value: ModuleMappingEntry,
  source: CatalogIndexes,
  target: CatalogIndexes,
): ModuleMappingEntry {
  if (!isValidModuleId(value.id)) throw new Error(`Invalid module mapping ID: ${value.id}`);
  const sourceModuleIds = requireUniqueIds(value.sourceModuleIds, `Mapping ${value.id} source modules`);
  const targetModuleIds = requireUniqueIds(value.targetModuleIds, `Mapping ${value.id} target modules`);
  const expectedCardinality = cardinality(sourceModuleIds.length, targetModuleIds.length);
  if (value.cardinality !== expectedCardinality) {
    throw new Error(`Mapping ${value.id} cardinality must be ${expectedCardinality}.`);
  }
  for (const moduleId of sourceModuleIds) {
    if (!source.moduleIds.has(moduleId)) throw new Error(`Mapping ${value.id} cites unknown source module ${moduleId}.`);
  }
  for (const moduleId of targetModuleIds) {
    if (!target.moduleIds.has(moduleId)) throw new Error(`Mapping ${value.id} cites unknown target module ${moduleId}.`);
  }
  const sourceEntityIds = requireUniqueIds(value.sourceEntityIds, `Mapping ${value.id} source entities`);
  const targetEntityIds = requireUniqueIds(value.targetEntityIds, `Mapping ${value.id} target entities`);
  for (const entityId of sourceEntityIds) {
    if (!source.entityIds.has(entityId)) throw new Error(`Mapping ${value.id} cites unknown source entity ${entityId}.`);
    if (!sourceModuleIds.includes(source.entityOwner.get(entityId)!)) {
      throw new Error(`Mapping ${value.id} source entity ${entityId} is outside its mapped modules.`);
    }
  }
  for (const entityId of targetEntityIds) {
    if (!target.entityIds.has(entityId)) throw new Error(`Mapping ${value.id} cites unknown target entity ${entityId}.`);
    if (!targetModuleIds.includes(target.entityOwner.get(entityId)!)) {
      throw new Error(`Mapping ${value.id} target entity ${entityId} is outside its mapped modules.`);
    }
  }
  const evidenceIds = requireUniqueIds(value.evidenceIds, `Mapping ${value.id} evidence IDs`);
  for (const evidenceId of evidenceIds) {
    if (!source.evidenceIds.has(evidenceId) && !target.evidenceIds.has(evidenceId)) {
      throw new Error(`Mapping ${value.id} cites unknown evidence ${evidenceId}.`);
    }
  }
  return {
    id: value.id,
    cardinality: expectedCardinality,
    sourceModuleIds,
    targetModuleIds,
    sourceEntityIds,
    targetEntityIds,
    rationale: requiredText(value.rationale, `Mapping ${value.id} rationale`),
    evidenceIds,
  };
}

function canonicalMappings(
  values: readonly ModuleMappingEntry[],
  source: CatalogIndexes,
  target: CatalogIndexes,
): ModuleMappingEntry[] {
  if (values.length === 0) throw new Error('Module mapping proposal requires at least one mapping.');
  const ids = new Set<string>();
  const sourceModules = new Set<string>();
  const targetModules = new Set<string>();
  const sourceEntities = new Set<string>();
  const targetEntities = new Set<string>();
  const result = values.map((value) => {
    const mapping = canonicalMapping(value, source, target);
    if (ids.has(mapping.id)) throw new Error(`Duplicate module mapping ID: ${mapping.id}`);
    ids.add(mapping.id);
    for (const moduleId of mapping.sourceModuleIds) {
      if (sourceModules.has(moduleId)) throw new Error(`Source module ${moduleId} appears in multiple mappings.`);
      sourceModules.add(moduleId);
    }
    for (const moduleId of mapping.targetModuleIds) {
      if (targetModules.has(moduleId)) throw new Error(`Target module ${moduleId} appears in multiple mappings.`);
      targetModules.add(moduleId);
    }
    for (const entityId of mapping.sourceEntityIds) {
      if (sourceEntities.has(entityId)) throw new Error(`Source entity ${entityId} appears in multiple mappings.`);
      sourceEntities.add(entityId);
    }
    for (const entityId of mapping.targetEntityIds) {
      if (targetEntities.has(entityId)) throw new Error(`Target entity ${entityId} appears in multiple mappings.`);
      targetEntities.add(entityId);
    }
    return mapping;
  });
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function contentAddress<T extends object>(prefix: string, payload: T): T & { id: string; contentHash: string } {
  const contentHash = sha256Hex(canonicalJson(payload));
  return { ...payload, id: `${prefix}:${contentHash.slice(0, 24)}`, contentHash };
}

function assertContentAddress(
  artifact: { id: string; contentHash: string },
  prefix: string,
  payload: object,
): void {
  const contentHash = sha256Hex(canonicalJson(payload));
  if (artifact.contentHash !== contentHash || artifact.id !== `${prefix}:${contentHash.slice(0, 24)}`) {
    throw new Error(`${prefix} content hash is invalid.`);
  }
}

export function materializeModuleMappingProposal(
  input: MaterializeModuleMappingProposalInput,
): ModuleMappingProposal {
  const sourceCatalog = createRepositoryModuleCatalogRef(input.sourceIr, input.sourceCatalog);
  const targetCatalog = createRepositoryModuleCatalogRef(input.targetIr, input.targetCatalog);
  const source = assertCatalogStructure(input.sourceIr, input.sourceCatalog);
  const target = assertCatalogStructure(input.targetIr, input.targetCatalog);
  const payload: Omit<ModuleMappingProposal, 'id' | 'contentHash'> = {
    schemaVersion: moduleMappingSchemaVersion,
    sourceCatalog,
    targetCatalog,
    objective: requiredText(input.objective, 'Module mapping objective'),
    status: 'awaiting-review',
    mappings: canonicalMappings(input.mappings, source, target),
    assumptions: canonicalTextList(input.assumptions ?? [], 'Module mapping assumption'),
    risks: canonicalTextList(input.risks ?? [], 'Module mapping risk'),
    createdAt: requireTimestamp(input.createdAt, 'Module mapping proposal creation time'),
  };
  return contentAddress('module-mapping-proposal', payload);
}

export function validateModuleMappingProposal(
  proposal: ModuleMappingProposal,
  sourceIr: UnifiedRepositoryIR,
  sourceCatalog: RepositoryModuleCatalog,
  targetIr: UnifiedRepositoryIR,
  targetCatalog: RepositoryModuleCatalog,
): ModuleMappingProposal {
  if (proposal.schemaVersion !== moduleMappingSchemaVersion) {
    throw new Error('Unsupported module mapping proposal schema version.');
  }
  if (proposal.status !== 'awaiting-review' && proposal.status !== 'superseded') {
    throw new Error(`Unsupported module mapping proposal status: ${String(proposal.status)}.`);
  }
  requiredText(proposal.objective, 'Module mapping objective');
  requireTimestamp(proposal.createdAt, 'Module mapping proposal creation time');
  if (
    canonicalJson(canonicalTextList(proposal.assumptions, 'Module mapping assumption')) !==
      canonicalJson(proposal.assumptions) ||
    canonicalJson(canonicalTextList(proposal.risks, 'Module mapping risk')) !==
      canonicalJson(proposal.risks)
  ) {
    throw new Error('Module mapping proposal assumptions or risks are not canonical.');
  }
  const source = assertCurrentCatalogRef('source', proposal.sourceCatalog, sourceIr, sourceCatalog);
  const target = assertCurrentCatalogRef('target', proposal.targetCatalog, targetIr, targetCatalog);
  const canonical = canonicalMappings(proposal.mappings, source, target);
  if (canonicalJson(canonical) !== canonicalJson(proposal.mappings)) {
    throw new Error('Module mapping proposal mappings are not canonical.');
  }
  const { id, contentHash, ...payload } = proposal;
  assertContentAddress({ id, contentHash }, 'module-mapping-proposal', payload);
  return proposal;
}

export function materializeModuleMappingReview(
  input: MaterializeModuleMappingReviewInput,
): ModuleMappingReview {
  validateModuleMappingProposal(
    input.proposal,
    input.sourceIr,
    input.sourceCatalog,
    input.targetIr,
    input.targetCatalog,
  );
  if (input.proposal.status !== 'awaiting-review') {
    throw new Error('Only an awaiting-review module mapping proposal can be reviewed.');
  }
  if (input.decision !== 'accept' && input.decision !== 'revise' && input.decision !== 'reject') {
    throw new Error(`Unsupported module mapping review decision: ${String(input.decision)}.`);
  }
  const payload: Omit<ModuleMappingReview, 'id' | 'contentHash'> = {
    schemaVersion: moduleMappingSchemaVersion,
    proposalId: input.proposal.id,
    proposalHash: input.proposal.contentHash,
    sourceCatalog: input.proposal.sourceCatalog,
    targetCatalog: input.proposal.targetCatalog,
    decision: input.decision,
    reviewerId: requiredText(input.reviewerId, 'Module mapping reviewer ID'),
    ...(input.comment === undefined ? {} : { comment: requiredText(input.comment, 'Module mapping review comment') }),
    acceptedRiskIds: canonicalTextList(input.acceptedRiskIds ?? [], 'Accepted module mapping risk ID'),
    replacementProposalRequired: input.decision !== 'accept',
    decidedAt: requireTimestamp(input.decidedAt, 'Module mapping review decision time'),
  };
  return contentAddress('module-mapping-review', payload);
}

export function validateModuleMappingReview(
  review: ModuleMappingReview,
  proposal: ModuleMappingProposal,
  sourceIr: UnifiedRepositoryIR,
  sourceCatalog: RepositoryModuleCatalog,
  targetIr: UnifiedRepositoryIR,
  targetCatalog: RepositoryModuleCatalog,
): ModuleMappingReview {
  validateModuleMappingProposal(proposal, sourceIr, sourceCatalog, targetIr, targetCatalog);
  if (review.decision !== 'accept' && review.decision !== 'revise' && review.decision !== 'reject') {
    throw new Error(`Unsupported module mapping review decision: ${String(review.decision)}.`);
  }
  if (
    review.schemaVersion !== moduleMappingSchemaVersion ||
    review.proposalId !== proposal.id ||
    review.proposalHash !== proposal.contentHash ||
    canonicalJson(review.sourceCatalog) !== canonicalJson(proposal.sourceCatalog) ||
    canonicalJson(review.targetCatalog) !== canonicalJson(proposal.targetCatalog)
  ) {
    throw new Error('Module mapping review does not bind to the current proposal and catalogs.');
  }
  if (review.replacementProposalRequired !== (review.decision !== 'accept')) {
    throw new Error('Module mapping review replacement flag is inconsistent with its decision.');
  }
  requiredText(review.reviewerId, 'Module mapping reviewer ID');
  requireTimestamp(review.decidedAt, 'Module mapping review decision time');
  if (
    canonicalJson(canonicalTextList(review.acceptedRiskIds, 'Accepted module mapping risk ID')) !==
    canonicalJson(review.acceptedRiskIds)
  ) {
    throw new Error('Module mapping review accepted risk IDs are not canonical.');
  }
  const { id, contentHash, ...payload } = review;
  assertContentAddress({ id, contentHash }, 'module-mapping-review', payload);
  return review;
}

function mappingRefs(mappings: readonly ModuleMappingEntry[]): Omit<MigrationExecutionGroup,
  'id' | 'mappingIds' | 'dependsOnGroupIds' | 'executionMode' | 'atomic'> {
  return {
    sourceModuleIds: sortedUnique(mappings.flatMap((mapping) => mapping.sourceModuleIds)),
    targetModuleIds: sortedUnique(mappings.flatMap((mapping) => mapping.targetModuleIds)),
    sourceEntityIds: sortedUnique(mappings.flatMap((mapping) => mapping.sourceEntityIds)),
    targetEntityIds: sortedUnique(mappings.flatMap((mapping) => mapping.targetEntityIds)),
  };
}

function canonicalExecutionGroups(
  drafts: readonly MigrationExecutionGroupDraft[],
  proposal: ModuleMappingProposal,
): MigrationExecutionGroup[] {
  if (drafts.length === 0) throw new Error('Migration execution overlay requires at least one group.');
  const mappings = new Map(proposal.mappings.map((mapping) => [mapping.id, mapping]));
  const groupIds = new Set<string>();
  const usedMappings = new Set<string>();
  const groups = drafts.map((draft) => {
    const id = requiredText(draft.id, 'Migration execution group ID');
    if (groupIds.has(id)) throw new Error(`Duplicate migration execution group ID: ${id}`);
    groupIds.add(id);
    const mappingIds = requireUniqueIds(draft.mappingIds, `Execution group ${id} mapping IDs`);
    if (mappingIds.length === 0) throw new Error(`Execution group ${id} must reference a mapping.`);
    const selected = mappingIds.map((mappingId) => {
      const mapping = mappings.get(mappingId);
      if (!mapping) throw new Error(`Execution group ${id} references unknown mapping ${mappingId}.`);
      if (usedMappings.has(mappingId)) {
        throw new Error(`Mapping ${mappingId} appears in multiple execution groups.`);
      }
      usedMappings.add(mappingId);
      return mapping;
    });
    return {
      id,
      mappingIds,
      ...mappingRefs(selected),
      dependsOnGroupIds: requireUniqueIds(
        draft.dependsOnGroupIds,
        `Execution group ${id} dependency IDs`,
      ),
      executionMode: 'serial' as const,
      atomic: true as const,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (usedMappings.size !== mappings.size) {
    const missing = [...mappings.keys()].filter((id) => !usedMappings.has(id)).sort();
    throw new Error(`Migration execution overlay omits mappings: ${missing.join(', ')}.`);
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    for (const dependencyId of group.dependsOnGroupIds) {
      if (!byId.has(dependencyId)) {
        throw new Error(`Execution group ${group.id} depends on unknown group ${dependencyId}.`);
      }
      if (dependencyId === group.id) throw new Error(`Execution group ${group.id} cannot depend on itself.`);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Migration execution overlay dependency graph contains a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id)!.dependsOnGroupIds) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return groups;
}

export function materializeMigrationExecutionOverlay(
  input: MaterializeMigrationExecutionOverlayInput,
): MigrationExecutionOverlay {
  validateModuleMappingReview(
    input.review,
    input.proposal,
    input.sourceIr,
    input.sourceCatalog,
    input.targetIr,
    input.targetCatalog,
  );
  if (input.review.decision !== 'accept') {
    throw new Error('Migration execution overlay requires an accepted module mapping review.');
  }
  const payload: Omit<MigrationExecutionOverlay, 'id' | 'contentHash'> = {
    schemaVersion: moduleMappingSchemaVersion,
    sourceCatalog: input.proposal.sourceCatalog,
    targetCatalog: input.proposal.targetCatalog,
    mappingProposalId: input.proposal.id,
    mappingProposalHash: input.proposal.contentHash,
    mappingReviewId: input.review.id,
    mappingReviewHash: input.review.contentHash,
    routeId: requiredText(input.routeId, 'Migration route ID'),
    routeVersion: requiredText(input.routeVersion, 'Migration route version'),
    status: 'planned',
    groups: canonicalExecutionGroups(input.groups, input.proposal),
    createdAt: requireTimestamp(input.createdAt, 'Migration execution overlay creation time'),
  };
  return contentAddress('migration-execution-overlay', payload);
}

export function validateMigrationExecutionOverlay(
  overlay: MigrationExecutionOverlay,
  proposal: ModuleMappingProposal,
  review: ModuleMappingReview,
  sourceIr: UnifiedRepositoryIR,
  sourceCatalog: RepositoryModuleCatalog,
  targetIr: UnifiedRepositoryIR,
  targetCatalog: RepositoryModuleCatalog,
): MigrationExecutionOverlay {
  validateModuleMappingReview(review, proposal, sourceIr, sourceCatalog, targetIr, targetCatalog);
  if (
    review.decision !== 'accept' ||
    overlay.schemaVersion !== moduleMappingSchemaVersion ||
    overlay.mappingProposalId !== proposal.id ||
    overlay.mappingProposalHash !== proposal.contentHash ||
    overlay.mappingReviewId !== review.id ||
    overlay.mappingReviewHash !== review.contentHash ||
    canonicalJson(overlay.sourceCatalog) !== canonicalJson(proposal.sourceCatalog) ||
    canonicalJson(overlay.targetCatalog) !== canonicalJson(proposal.targetCatalog)
  ) {
    throw new Error('Migration execution overlay does not bind to the accepted current mapping.');
  }
  requiredText(overlay.routeId, 'Migration route ID');
  requiredText(overlay.routeVersion, 'Migration route version');
  requireTimestamp(overlay.createdAt, 'Migration execution overlay creation time');
  const canonicalGroups = canonicalExecutionGroups(
    overlay.groups.map((group) => ({
      id: group.id,
      mappingIds: group.mappingIds,
      dependsOnGroupIds: group.dependsOnGroupIds,
    })),
    proposal,
  );
  if (canonicalJson(canonicalGroups) !== canonicalJson(overlay.groups)) {
    throw new Error('Migration execution overlay contains non-canonical or invented references.');
  }
  const { id, contentHash, ...payload } = overlay;
  assertContentAddress({ id, contentHash }, 'migration-execution-overlay', payload);
  return overlay;
}

export function validateLegacyFunctionalModuleBindings(
  modules: readonly FunctionalModule[],
  bindings: readonly LegacyFunctionalModuleMappingBinding[],
  proposal: ModuleMappingProposal,
): LegacyFunctionalModuleMappingBinding[] {
  const legacyModuleIds = new Set(modules.map((module) => module.id));
  if (legacyModuleIds.size !== modules.length) throw new Error('Legacy functional modules contain duplicate IDs.');
  const mappingIds = new Set(proposal.mappings.map((mapping) => mapping.id));
  const boundLegacyModules = new Set<string>();
  const canonical = bindings.map((binding) => {
    if (!legacyModuleIds.has(binding.legacyModuleId)) {
      throw new Error(`Compatibility binding references unknown legacy module ${binding.legacyModuleId}.`);
    }
    if (boundLegacyModules.has(binding.legacyModuleId)) {
      throw new Error(`Legacy module ${binding.legacyModuleId} has multiple compatibility bindings.`);
    }
    boundLegacyModules.add(binding.legacyModuleId);
    const ids = requireUniqueIds(
      binding.mappingIds,
      `Legacy module ${binding.legacyModuleId} mapping IDs`,
    );
    if (ids.length === 0) throw new Error(`Legacy module ${binding.legacyModuleId} has no canonical mapping.`);
    for (const id of ids) {
      if (!mappingIds.has(id)) throw new Error(`Legacy module ${binding.legacyModuleId} cites unknown mapping ${id}.`);
    }
    return { legacyModuleId: binding.legacyModuleId, mappingIds: ids };
  }).sort((left, right) => left.legacyModuleId.localeCompare(right.legacyModuleId));
  const missing = [...legacyModuleIds].filter((id) => !boundLegacyModules.has(id)).sort();
  if (missing.length > 0) throw new Error(`Compatibility bindings omit legacy modules: ${missing.join(', ')}.`);
  return canonical;
}

export function convertLegacyModuleMigrationPlanToExecutionOverlay(
  input: ConvertLegacyModuleMigrationPlanInput,
): ConvertLegacyModuleMigrationPlanResult {
  if (input.legacyPlan.planHash !== calculateModuleMigrationPlanHash(input.legacyPlan)) {
    throw new Error('Legacy module migration plan hash is invalid.');
  }
  const bindings = validateLegacyFunctionalModuleBindings(
    input.legacyPlan.modules,
    input.bindings,
    input.proposal,
  );
  const bindingByModule = new Map(bindings.map((binding) => [binding.legacyModuleId, binding]));
  const newGroupIdByLegacy = new Map(
    input.legacyPlan.executionGroups.map((group) => [
      group.id,
      `compat-group:${sha256Hex(group.id).slice(0, 20)}`,
    ]),
  );
  const groups = input.legacyPlan.executionGroups.map((group) => ({
    id: newGroupIdByLegacy.get(group.id)!,
    mappingIds: sortedUnique(group.moduleIds.flatMap((moduleId) => {
      const binding = bindingByModule.get(moduleId);
      if (!binding) throw new Error(`Legacy execution group references unbound module ${moduleId}.`);
      return binding.mappingIds;
    })),
    dependsOnGroupIds: group.dependsOnGroupIds.map((id) => {
      const mapped = newGroupIdByLegacy.get(id);
      if (!mapped) throw new Error(`Legacy execution group references unknown dependency ${id}.`);
      return mapped;
    }),
  }));
  const overlay = materializeMigrationExecutionOverlay({
    ...input,
    groups,
  });
  const compatibilityPayload: Omit<LegacyModuleMigrationCompatibilityRecord, 'id' | 'contentHash'> = {
    schemaVersion: moduleMappingSchemaVersion,
    legacyPlanId: input.legacyPlan.id,
    legacyPlanHash: input.legacyPlan.planHash,
    overlayId: overlay.id,
    overlayHash: overlay.contentHash,
    bindings,
    warnings: [
      'legacy-file-ownership-not-imported',
      'legacy-module-boundaries-not-imported',
      'legacy-schedule-used-as-grouping-hint-only',
    ],
    createdAt: overlay.createdAt,
  };
  return {
    overlay,
    compatibility: contentAddress('legacy-module-migration-compatibility', compatibilityPayload),
  };
}
