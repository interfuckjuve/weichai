import {
  assertCanonicalLanguageId,
  migrationExecutionV2SchemaVersion,
  migrationReferenceSchemaVersion,
  migrationRouteSchemaVersion,
  migrationRuntimeCapabilitySchemaVersion,
  validationPolicySchemaVersion,
  type AdaptationRequestV2,
  type AdaptationResultV2,
  type AllowedModificationV2,
  type ImplementationCandidateRef,
  type ImplementationIndexGenerationRefV2,
  type IndexedImplementationDocumentV2,
  type LegacyMigrationExecutionCompatibilityRecordV2,
  type MaterializedMigrationRouteDescriptor,
  type MaterializedValidationPolicySnapshot,
  type MigrationCodeIdentity,
  type MigrationExecutionLineageV2,
  type MigrationExecutionOverlay,
  type MigrationProviderRefV2,
  type MigrationRouteDescriptor,
  type MigrationRouteSnapshotRef,
  type MigrationRouteStage,
  type MigrationRunManifestV2,
  type MigrationRuntimeCapabilitySnapshot,
  type MigrationTargetRef,
  type ModuleMappingProposal,
  type ModuleMappingReview,
  type RepositoryModuleCatalogRef,
  type SearchCandidateV2,
  type SearchRequestV2,
  type SourceImplementationBundleV2,
  type SourceImplementationFileV2,
  type TargetContextFactRoleV2,
  type TargetContextFactV2,
  type TargetContextSnapshotV2,
  type ValidationPhase,
  type ValidationPolicyCheck,
  type MigrationLocatedArtifactRefV2,
  type MigrationRepairIssueV2,
  type MigrationRepairRoundV2,
  type RepositoryIngestionJsonValue,
  type ValidationRecord,
} from '@forexplore/contracts';
import { canonicalJson, sha256Hex, sortedUnique } from './module-plan-utils';

const sha256Pattern = /^[0-9a-f]{64}$/;
const routeStrategies = new Set(['translate', 'bridge', 'wrap', 'reuse']);
const routeStages = new Set<MigrationRouteStage>([
  'source-analysis',
  'target-analysis',
  'context-collection',
  'behavior-extraction',
  'migration-planning',
  'translation',
  'patch-generation',
  'compile-validation',
  'behavior-validation',
  'workspace-apply',
  'workspace-rollback',
]);
const validationPhases = new Set<ValidationPhase>([
  'syntax',
  'compile',
  'static-analysis',
  'unit-test',
  'integration-test',
  'behavior',
  'architecture',
  'dependency',
  'security',
  'license',
  'format',
  'custom',
]);

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must not be empty.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function requireSha256(value: string, label: string): string {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireTimestamp(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-compatible timestamp.`);
  }
  return value;
}

function canonicalTextList(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => requiredText(value, label));
  const result = sortedUnique(normalized);
  if (result.length !== values.length) throw new Error(`${label} values must be unique.`);
  return result;
}

function canonicalPath(value: string, label: string): string {
  const path = requiredText(value, label).replace(/\\/g, '/');
  if (
    path.startsWith('/') ||
    /^[a-zA-Z]:\//.test(path) ||
    path.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  return path;
}

function canonicalArtifactPath(value: string, label: string): string {
  const path = requiredText(value, label);
  if (path.includes('\\')) throw new Error(`${label} must be a safe repository-relative path.`);
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  return path;
}
function contentAddress<T extends object>(
  prefix: string,
  payload: T,
): T & { id: string; contentHash: string } {
  const contentHash = sha256Hex(canonicalJson(payload));
  return { ...payload, id: `${prefix}:${contentHash.slice(0, 24)}`, contentHash };
}

function assertContentHash(
  artifact: { contentHash: string },
  payload: object,
  label: string,
): void {
  const expected = sha256Hex(canonicalJson(payload));
  if (artifact.contentHash !== expected) throw new Error(`${label} content hash is invalid.`);
}

function assertContentAddress(
  artifact: { id: string; contentHash: string },
  prefix: string,
  payload: object,
): void {
  const expected = sha256Hex(canonicalJson(payload));
  if (artifact.contentHash !== expected || artifact.id !== `${prefix}:${expected.slice(0, 24)}`) {
    throw new Error(`${prefix} content address is invalid.`);
  }
}

function canonicalProvider(provider: MigrationProviderRefV2, label: string): MigrationProviderRefV2 {
  return {
    providerId: requiredText(provider.providerId, `${label} provider ID`),
    providerVersion: requiredText(provider.providerVersion, `${label} provider version`),
    ...(provider.configurationHash === undefined
      ? {}
      : { configurationHash: requireSha256(provider.configurationHash, `${label} configuration hash`) }),
  };
}

function canonicalPolicyCheck(check: ValidationPolicyCheck): ValidationPolicyCheck {
  if (!validationPhases.has(check.phase)) {
    throw new Error(`Validation policy check ${check.id} has an unsupported phase.`);
  }
  return {
    id: requiredText(check.id, 'Validation policy check ID'),
    label: requiredText(check.label, `Validation policy check ${check.id} label`),
    phase: check.phase,
    required: check.required,
    verifierId: requiredText(check.verifierId, `Validation policy check ${check.id} verifier ID`),
    ...(check.verifierVersion === undefined
      ? {}
      : { verifierVersion: requiredText(check.verifierVersion, `Validation policy check ${check.id} verifier version`) }),
    ...(check.reason === undefined ? {} : { reason: requiredText(check.reason, `Validation policy check ${check.id} reason`) }),
  };
}

function materializePolicy(
  routeId: string,
  routeVersion: string,
  policy: MigrationRouteDescriptor['validationPolicy'],
  defaultCreatedAt: string,
): MaterializedValidationPolicySnapshot {
  if (!policy) throw new Error(`Route ${routeId} requires a validation policy.`);
  if (policy.schemaVersion !== validationPolicySchemaVersion) {
    throw new Error(`Route ${routeId} validation policy schema is unsupported.`);
  }
  if (policy.routeId !== routeId || policy.routeVersion !== routeVersion) {
    throw new Error(`Route ${routeId} validation policy lineage is inconsistent.`);
  }
  const checks = policy.checks.map(canonicalPolicyCheck)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error(`Route ${routeId} validation policy repeats a check.`);
  }
  if (!checks.some((check) => check.required)) {
    throw new Error(`Route ${routeId} validation policy requires at least one required verifier.`);
  }
  const payload: Omit<MaterializedValidationPolicySnapshot, 'contentHash'> = {
    schemaVersion: validationPolicySchemaVersion,
    id: requiredText(policy.id, `Route ${routeId} validation policy ID`),
    routeId,
    routeVersion,
    checks,
    createdAt: requireTimestamp(policy.createdAt ?? defaultCreatedAt, 'Validation policy creation time'),
  };
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

function canonicalRoute(
  route: MigrationRouteDescriptor,
  snapshotCreatedAt: string,
): MaterializedMigrationRouteDescriptor {
  if (route.schemaVersion !== migrationRouteSchemaVersion) {
    throw new Error(`Migration route ${route.id} schema is unsupported.`);
  }
  assertCanonicalLanguageId(route.sourceLanguageId, `Migration route ${route.id} source language`);
  assertCanonicalLanguageId(route.targetLanguageId, `Migration route ${route.id} target language`);
  if (!routeStrategies.has(route.strategy)) {
    throw new Error(`Migration route ${route.id} strategy is unsupported.`);
  }
  const id = requiredText(route.id, 'Migration route ID');
  const version = requiredText(route.version, `Migration route ${id} version`);
  const stageIds = new Set<MigrationRouteStage>();
  const stages = route.stages.map((stage) => {
    if (!routeStages.has(stage.stage) || stageIds.has(stage.stage)) {
      throw new Error(`Migration route ${id} has an invalid or duplicate stage ${stage.stage}.`);
    }
    stageIds.add(stage.stage);
    if (
      stage.availability.status !== 'available' &&
      stage.availability.status !== 'degraded' &&
      stage.availability.status !== 'unavailable'
    ) {
      throw new Error(`Migration route ${id} stage ${stage.stage} availability is invalid.`);
    }
    const reasonCodes = canonicalTextList(
      stage.availability.reasonCodes,
      `Migration route ${id} stage ${stage.stage} reason code`,
    );
    if (stage.availability.status !== 'available' && reasonCodes.length === 0) {
      throw new Error(`Migration route ${id} stage ${stage.stage} must explain its availability.`);
    }
    return {
      stage: stage.stage,
      providerId: requiredText(stage.providerId, `Migration route ${id} stage provider ID`),
      providerVersion: requiredText(stage.providerVersion, `Migration route ${id} stage provider version`),
      capabilities: [...new Set(stage.capabilities)].sort(),
      availability: {
        status: stage.availability.status,
        reasonCodes,
        ...(stage.availability.summary === undefined
          ? {}
          : { summary: requiredText(stage.availability.summary, `Migration route ${id} stage summary`) }),
      },
      ...(stage.requirements === undefined
        ? {}
        : { requirements: canonicalTextList(stage.requirements, `Migration route ${id} stage requirement`) }),
    };
  }).sort((left, right) => left.stage.localeCompare(right.stage));
  if (stages.length === 0) throw new Error(`Migration route ${id} must have a provider-backed stage.`);
  const routeReasonCodes = canonicalTextList(route.availability.reasonCodes, `Migration route ${id} reason code`);
  if (route.availability.status !== 'available' && routeReasonCodes.length === 0) {
    throw new Error(`Migration route ${id} must explain degraded or unavailable status.`);
  }
  const validationPolicy = materializePolicy(id, version, route.validationPolicy, snapshotCreatedAt);
  if (
    route.availability.status !== 'available' &&
    route.availability.status !== 'degraded' &&
    route.availability.status !== 'unavailable'
  ) {
    throw new Error(`Migration route ${id} availability is invalid.`);
  }
  const payload: Omit<MaterializedMigrationRouteDescriptor, 'contentHash'> = {
    schemaVersion: migrationRouteSchemaVersion,
    id,
    name: requiredText(route.name, `Migration route ${id} name`),
    version,
    sourceLanguageId: route.sourceLanguageId,
    targetLanguageId: route.targetLanguageId,
    strategy: route.strategy,
    stages,
    availability: {
      status: route.availability.status,
      reasonCodes: routeReasonCodes,
      ...(route.availability.summary === undefined
        ? {}
        : { summary: requiredText(route.availability.summary, `Migration route ${id} summary`) }),
    },
    validationPolicy,
  };
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

export interface MaterializeMigrationRuntimeCapabilitySnapshotInput {
  routes: readonly MigrationRouteDescriptor[];
  createdAt: string;
}

export function materializeMigrationRuntimeCapabilitySnapshot(
  input: MaterializeMigrationRuntimeCapabilitySnapshotInput,
): MigrationRuntimeCapabilitySnapshot {
  const createdAt = requireTimestamp(input.createdAt, 'Runtime capability snapshot creation time');
  const routes = input.routes.map((route) => canonicalRoute(route, createdAt))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const route of routes) {
    const key = canonicalJson([route.sourceLanguageId, route.targetLanguageId, route.strategy]);
    if (ids.has(route.id) || keys.has(key)) {
      throw new Error('Runtime capability snapshot contains duplicate route identity.');
    }
    ids.add(route.id);
    keys.add(key);
  }
  return contentAddress('migration-runtime-capabilities', {
    schemaVersion: migrationRuntimeCapabilitySchemaVersion,
    routes,
    createdAt,
  });
}

export function validateMigrationRuntimeCapabilitySnapshot(
  snapshot: MigrationRuntimeCapabilitySnapshot,
): MigrationRuntimeCapabilitySnapshot {
  if (snapshot.schemaVersion !== migrationRuntimeCapabilitySchemaVersion) {
    throw new Error('Runtime capability snapshot schema is unsupported.');
  }
  const rebuilt = materializeMigrationRuntimeCapabilitySnapshot({
    routes: snapshot.routes,
    createdAt: snapshot.createdAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(snapshot)) {
    throw new Error('Runtime capability snapshot hash or canonical structure is invalid.');
  }
  return snapshot;
}

export function createMigrationRouteSnapshotRef(
  snapshot: MigrationRuntimeCapabilitySnapshot,
  routeId: string,
): MigrationRouteSnapshotRef {
  validateMigrationRuntimeCapabilitySnapshot(snapshot);
  const route = snapshot.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`Runtime capability snapshot has no route ${routeId}.`);
  if (route.availability.status === 'unavailable') {
    throw new Error(`Migration route ${routeId} is unavailable.`);
  }
  return {
    sourceLanguageId: route.sourceLanguageId,
    targetLanguageId: route.targetLanguageId,
    strategy: route.strategy,
    routeId: route.id,
    routeVersion: route.version,
    routeContentHash: route.contentHash,
    runtimeCapabilitySnapshotId: snapshot.id,
    runtimeCapabilitySnapshotHash: snapshot.contentHash,
    validationPolicyId: route.validationPolicy.id,
    validationPolicyHash: route.validationPolicy.contentHash,
  };
}

function routeForRef(
  ref: MigrationRouteSnapshotRef,
  snapshot: MigrationRuntimeCapabilitySnapshot,
): MaterializedMigrationRouteDescriptor {
  validateMigrationRuntimeCapabilitySnapshot(snapshot);
  if (
    ref.runtimeCapabilitySnapshotId !== snapshot.id ||
    ref.runtimeCapabilitySnapshotHash !== snapshot.contentHash
  ) {
    throw new Error('Migration route reference binds a different runtime capability snapshot.');
  }
  const route = snapshot.routes.find((candidate) => candidate.id === ref.routeId);
  if (!route || canonicalJson(createMigrationRouteSnapshotRef(snapshot, route.id)) !== canonicalJson(ref)) {
    throw new Error('Migration route reference hash or lineage does not match the runtime snapshot.');
  }
  return route;
}

export function validateMigrationRouteSnapshotRef(
  ref: MigrationRouteSnapshotRef,
  snapshot: MigrationRuntimeCapabilitySnapshot,
): MaterializedMigrationRouteDescriptor {
  return routeForRef(ref, snapshot);
}

function assertComposedRoute(
  combinedRoute: MaterializedMigrationRouteDescriptor,
  serviceRoute: MaterializedMigrationRouteDescriptor,
  allowedOverrideStages: ReadonlySet<MigrationRouteStage>,
): void {
  const assertAggregatedAvailability = (route: MaterializedMigrationRouteDescriptor): void => {
    const expectedStatus = route.stages.some((stage) => stage.availability.status === 'unavailable')
      ? 'unavailable'
      : route.stages.some((stage) => stage.availability.status === 'degraded')
        ? 'degraded'
        : 'available';
    const expectedReasonCodes = sortedUnique(route.stages.flatMap((stage) =>
      stage.availability.status === expectedStatus
        ? stage.availability.reasonCodes.map((reason) => `${stage.stage}:${reason}`)
        : [],
    ));
    const expectedAvailability = expectedStatus === 'available'
      ? { status: 'available' as const, reasonCodes: [] as string[] }
      : {
          status: expectedStatus,
          reasonCodes: expectedReasonCodes,
          summary: expectedStatus === 'unavailable'
            ? 'One or more required runtime stages are unavailable.'
            : 'All required stages are executable, with declared limitations.',
        };
    if (
      canonicalJson(route.availability) !== canonicalJson(expectedAvailability)
    ) {
      throw new Error(`Migration route ${route.id} availability is not the deterministic aggregate of its stages.`);
    }
  };
  assertAggregatedAvailability(combinedRoute);
  assertAggregatedAvailability(serviceRoute);
  const combinedBase = {
    schemaVersion: combinedRoute.schemaVersion,
    id: combinedRoute.id,
    name: combinedRoute.name,
    version: combinedRoute.version,
    sourceLanguageId: combinedRoute.sourceLanguageId,
    targetLanguageId: combinedRoute.targetLanguageId,
    strategy: combinedRoute.strategy,
    validationPolicy: combinedRoute.validationPolicy,
  };
  const serviceBase = {
    schemaVersion: serviceRoute.schemaVersion,
    id: serviceRoute.id,
    name: serviceRoute.name,
    version: serviceRoute.version,
    sourceLanguageId: serviceRoute.sourceLanguageId,
    targetLanguageId: serviceRoute.targetLanguageId,
    strategy: serviceRoute.strategy,
    validationPolicy: serviceRoute.validationPolicy,
  };
  if (canonicalJson(combinedBase) !== canonicalJson(serviceBase)) {
    throw new Error(`Composed migration route ${serviceRoute.id} changes its key, version, or policy.`);
  }
  const combinedStages = new Map(combinedRoute.stages.map((stage) => [stage.stage, stage]));
  const serviceStages = new Map(serviceRoute.stages.map((stage) => [stage.stage, stage]));
  if (
    combinedStages.size !== serviceStages.size ||
    [...serviceStages.keys()].some((stage) => !combinedStages.has(stage))
  ) {
    throw new Error(`Composed migration route ${serviceRoute.id} changes its stage set.`);
  }
  for (const [stageId, serviceStage] of serviceStages) {
    const combinedStage = combinedStages.get(stageId)!;
    if (!allowedOverrideStages.has(stageId)) {
      if (canonicalJson(combinedStage) !== canonicalJson(serviceStage)) {
        throw new Error(`Composed migration route ${serviceRoute.id} changes protected stage ${stageId}.`);
      }
      continue;
    }
    if (canonicalJson(combinedStage.capabilities) !== canonicalJson(serviceStage.capabilities)) {
      throw new Error(`Composed migration route ${serviceRoute.id} changes capabilities for override stage ${stageId}.`);
    }
  }
}

/**
 * Verifies that a host-composed snapshot is an authorized overlay of a
 * service-owned snapshot. Combined snapshots may contain additional routes;
 * every service route remains an immutable trust anchor.
 */
export function validateComposedMigrationRuntimeSnapshot(
  combined: MigrationRuntimeCapabilitySnapshot,
  service: MigrationRuntimeCapabilitySnapshot,
  allowedOverrideStages: readonly MigrationRouteStage[],
): MigrationRuntimeCapabilitySnapshot {
  validateMigrationRuntimeCapabilitySnapshot(combined);
  validateMigrationRuntimeCapabilitySnapshot(service);
  const allowed = new Set<MigrationRouteStage>(allowedOverrideStages);
  if (allowed.size !== allowedOverrideStages.length) {
    throw new Error('Composed runtime override stages must be unique.');
  }
  for (const stage of allowed) {
    if (!routeStages.has(stage)) throw new Error(`Composed runtime override stage is unsupported: ${stage}.`);
  }
  for (const serviceRoute of service.routes) {
    const combinedRoute = combined.routes.find((candidate) => candidate.id === serviceRoute.id);
    if (!combinedRoute) {
      throw new Error(`Composed runtime snapshot omits service route ${serviceRoute.id}.`);
    }
    assertComposedRoute(combinedRoute, serviceRoute, allowed);
  }
  return combined;
}

export function validateComposedMigrationRouteRef(
  ref: MigrationRouteSnapshotRef,
  combined: MigrationRuntimeCapabilitySnapshot,
  service: MigrationRuntimeCapabilitySnapshot,
  allowedOverrideStages: readonly MigrationRouteStage[],
): MaterializedMigrationRouteDescriptor {
  validateComposedMigrationRuntimeSnapshot(combined, service, allowedOverrideStages);
  const route = validateMigrationRouteSnapshotRef(ref, combined);
  const serviceRoute = service.routes.find((candidate) => candidate.id === route.id);
  if (!serviceRoute) throw new Error(`Service runtime does not authorize migration route ${route.id}.`);
  assertComposedRoute(route, serviceRoute, new Set(allowedOverrideStages));
  return route;
}

function canonicalRepositoryLineage(
  lineage: ImplementationCandidateRef['lineage'],
  label: string,
): ImplementationCandidateRef['lineage'] {
  const optionalCatalog = [
    lineage.moduleCatalogId,
    lineage.moduleCatalogHash,
    lineage.moduleReviewId,
    lineage.moduleReviewHash,
  ];
  if (optionalCatalog.some((value) => value !== undefined) && optionalCatalog.some((value) => value === undefined)) {
    throw new Error(`${label} reviewed catalog lineage must be complete or absent.`);
  }
  return {
    repositoryId: requiredText(lineage.repositoryId, `${label} repository ID`),
    ...(lineage.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: requiredText(lineage.repositoryRevision, `${label} repository revision`) }),
    repositoryContentHash: requireSha256(lineage.repositoryContentHash, `${label} repository content hash`),
    unifiedRepositoryIrId: requiredText(lineage.unifiedRepositoryIrId, `${label} unified IR ID`),
    unifiedRepositoryIrHash: requireSha256(lineage.unifiedRepositoryIrHash, `${label} unified IR hash`),
    ...(lineage.moduleCatalogId === undefined
      ? {}
      : {
          moduleCatalogId: requiredText(lineage.moduleCatalogId, `${label} module catalog ID`),
          moduleCatalogHash: requireSha256(lineage.moduleCatalogHash!, `${label} module catalog hash`),
          moduleReviewId: requiredText(lineage.moduleReviewId!, `${label} module review ID`),
          moduleReviewHash: requireSha256(lineage.moduleReviewHash!, `${label} module review hash`),
        }),
  };
}

function canonicalCatalogRef(ref: RepositoryModuleCatalogRef, label: string): RepositoryModuleCatalogRef {
  const lineage = canonicalRepositoryLineage({
    repositoryId: ref.repositoryId,
    ...(ref.repositoryRevision === undefined ? {} : { repositoryRevision: ref.repositoryRevision }),
    repositoryContentHash: ref.repositoryContentHash,
    unifiedRepositoryIrId: ref.unifiedRepositoryIrId,
    unifiedRepositoryIrHash: ref.unifiedRepositoryIrHash,
    moduleCatalogId: ref.moduleCatalogId,
    moduleCatalogHash: ref.moduleCatalogHash,
    moduleReviewId: ref.moduleReviewId,
    moduleReviewHash: ref.moduleReviewHash,
  }, label);
  return {
    repositoryId: lineage.repositoryId,
    ...(lineage.repositoryRevision === undefined ? {} : { repositoryRevision: lineage.repositoryRevision }),
    repositoryContentHash: lineage.repositoryContentHash,
    unifiedRepositoryIrId: lineage.unifiedRepositoryIrId,
    unifiedRepositoryIrHash: lineage.unifiedRepositoryIrHash,
    moduleCatalogId: lineage.moduleCatalogId!,
    moduleCatalogHash: lineage.moduleCatalogHash!,
    moduleReviewId: lineage.moduleReviewId!,
    moduleReviewHash: lineage.moduleReviewHash!,
  };
}

function canonicalReviewedRepositoryLineage(
  lineage: MigrationTargetRef['lineage'],
  label: string,
): MigrationTargetRef['lineage'] {
  const canonical = canonicalRepositoryLineage(lineage, label);
  if (
    canonical.moduleCatalogId === undefined ||
    canonical.moduleCatalogHash === undefined ||
    canonical.moduleReviewId === undefined ||
    canonical.moduleReviewHash === undefined
  ) {
    throw new Error(`${label} requires complete reviewed catalog lineage.`);
  }
  return canonical as MigrationTargetRef['lineage'];
}

function canonicalCodeIdentity(
  identity: MigrationCodeIdentity,
  expectedKind: MigrationCodeIdentity['kind'],
  label: string,
): MigrationCodeIdentity {
  if (identity.kind !== expectedKind) throw new Error(`${label} must be a ${expectedKind} identity.`);
  return {
    kind: identity.kind,
    contentHash: requireSha256(identity.contentHash, `${label} content hash`),
    schemaVersion: requiredText(identity.schemaVersion, `${label} schema version`),
    providerId: requiredText(identity.providerId, `${label} provider ID`),
    providerVersion: requiredText(identity.providerVersion, `${label} provider version`),
    ...(identity.configurationHash === undefined
      ? {}
      : { configurationHash: requireSha256(identity.configurationHash, `${label} configuration hash`) }),
  };
}

export type MaterializeMigrationTargetRefV2Input = Omit<MigrationTargetRef, 'id' | 'contentHash'>;

export function materializeMigrationTargetRefV2(
  input: MaterializeMigrationTargetRefV2Input,
  runtime: MigrationRuntimeCapabilitySnapshot,
): MigrationTargetRef {
  if (input.schemaVersion !== migrationReferenceSchemaVersion) {
    throw new Error('Migration target reference schema is unsupported.');
  }
  const route = routeForRef(input.route, runtime);
  assertCanonicalLanguageId(input.entity.languageId, 'Migration target language');
  if (input.entity.languageId !== route.targetLanguageId) {
    throw new Error('Migration target language does not match the exact route.');
  }
  const entityPath = canonicalPath(input.entity.path, 'Migration target file path');
  const allowedModificationPaths = canonicalTextList(
    input.allowedModificationPaths.map((path) => canonicalPath(path, 'Allowed modification path')),
    'Allowed modification path',
  );
  if (!allowedModificationPaths.includes(entityPath)) {
    throw new Error('Migration target file must be inside the allowed modification paths.');
  }
  return contentAddress('migration-target-v2', {
    schemaVersion: migrationReferenceSchemaVersion,
    workspaceId: requiredText(input.workspaceId, 'Migration target workspace ID'),
    targetWorkspaceSnapshotId: requiredText(input.targetWorkspaceSnapshotId, 'Target workspace snapshot ID'),
    targetWorkspaceSnapshotHash: requireSha256(input.targetWorkspaceSnapshotHash, 'Target workspace snapshot hash'),
    lineage: canonicalReviewedRepositoryLineage(input.lineage, 'Migration target lineage'),
    entity: {
      entityId: requiredText(input.entity.entityId, 'Migration target entity ID'),
      fileId: requiredText(input.entity.fileId, 'Migration target file ID'),
      languageId: input.entity.languageId,
      kind: requiredText(input.entity.kind, 'Migration target entity kind'),
      name: requiredText(input.entity.name, 'Migration target entity name'),
      ...(input.entity.qualifiedName === undefined
        ? {}
        : { qualifiedName: requiredText(input.entity.qualifiedName, 'Migration target qualified name') }),
      path: entityPath,
      ...(input.entity.signature === undefined ? {} : { signature: input.entity.signature }),
      fileContentHash: requireSha256(input.entity.fileContentHash, 'Migration target file content hash'),
      declarationIdentity: canonicalCodeIdentity(input.entity.declarationIdentity, 'declaration', 'Migration target declaration'),
      ...(input.entity.bodyIdentity === undefined
        ? {}
        : { bodyIdentity: canonicalCodeIdentity(input.entity.bodyIdentity, 'body', 'Migration target body') }),
      ...(input.entity.semanticIdentity === undefined
        ? {}
        : { semanticIdentity: canonicalCodeIdentity(input.entity.semanticIdentity, 'semantic-shape', 'Migration target semantic shape') }),
    },
    route: input.route,
    allowedModificationPaths,
  });
}

export function validateMigrationTargetRefV2(
  target: MigrationTargetRef,
  runtime: MigrationRuntimeCapabilitySnapshot,
): MigrationTargetRef {
  const { id, contentHash, ...input } = target;
  const rebuilt = materializeMigrationTargetRefV2(input, runtime);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(target)) {
    throw new Error('Migration target reference hash or canonical structure is invalid.');
  }
  return target;
}

export type MaterializeImplementationCandidateRefV2Input = Omit<ImplementationCandidateRef, 'contentHash'>;

export function materializeImplementationCandidateRefV2(
  input: MaterializeImplementationCandidateRefV2Input,
): ImplementationCandidateRef {
  if (input.schemaVersion !== migrationReferenceSchemaVersion) {
    throw new Error('Implementation candidate reference schema is unsupported.');
  }
  assertCanonicalLanguageId(input.entity.languageId, 'Implementation candidate language');
  if ((input.sourceBundleId === undefined) !== (input.sourceBundleHash === undefined)) {
    throw new Error('Implementation candidate source bundle ID/hash must be supplied together.');
  }
  const payload: Omit<ImplementationCandidateRef, 'contentHash'> = {
    schemaVersion: migrationReferenceSchemaVersion,
    id: requiredText(input.id, 'Implementation candidate ID'),
    lineage: canonicalRepositoryLineage(input.lineage, 'Implementation candidate lineage'),
    entity: {
      entityId: requiredText(input.entity.entityId, 'Implementation candidate entity ID'),
      ...(input.entity.fileId === undefined ? {} : { fileId: requiredText(input.entity.fileId, 'Implementation candidate file ID') }),
      languageId: input.entity.languageId,
      kind: requiredText(input.entity.kind, 'Implementation candidate entity kind'),
      name: requiredText(input.entity.name, 'Implementation candidate entity name'),
      ...(input.entity.qualifiedName === undefined ? {} : { qualifiedName: requiredText(input.entity.qualifiedName, 'Implementation candidate qualified name') }),
      ...(input.entity.path === undefined ? {} : { path: canonicalPath(input.entity.path, 'Implementation candidate path') }),
      ...(input.entity.signature === undefined ? {} : { signature: input.entity.signature }),
    },
    ...(input.sourceBundleId === undefined
      ? {}
      : {
          sourceBundleId: requiredText(input.sourceBundleId, 'Implementation candidate source bundle ID'),
          sourceBundleHash: requireSha256(input.sourceBundleHash!, 'Implementation candidate source bundle hash'),
        }),
    ...(input.license === undefined ? {} : { license: requiredText(input.license, 'Implementation candidate license') }),
  };
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

export function validateImplementationCandidateRefV2(
  candidate: ImplementationCandidateRef,
): ImplementationCandidateRef {
  const { contentHash, ...input } = candidate;
  const rebuilt = materializeImplementationCandidateRefV2(input);
  if (rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(candidate)) {
    throw new Error('Implementation candidate reference hash or canonical structure is invalid.');
  }
  return candidate;
}

function assertSameRoute(
  left: MigrationRouteSnapshotRef,
  right: MigrationRouteSnapshotRef,
  label: string,
): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} route lineage is inconsistent.`);
  }
}

export type MaterializeSearchRequestV2Input = Omit<SearchRequestV2, 'id' | 'contentHash'>;

export function materializeSearchRequestV2(
  input: MaterializeSearchRequestV2Input,
  runtime: MigrationRuntimeCapabilitySnapshot,
): SearchRequestV2 {
  if (input.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('SearchRequestV2 schema is unsupported; legacy search requests are rejected.');
  }
  validateMigrationTargetRefV2(input.target, runtime);
  routeForRef(input.route, runtime);
  assertSameRoute(input.target.route, input.route, 'Search request target');
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100) {
    throw new Error('SearchRequestV2 topK must be an integer from 1 through 100.');
  }
  const candidateLanguageIds = canonicalTextList(
    input.candidateLanguageIds.map((languageId) => {
      assertCanonicalLanguageId(languageId, 'Search candidate language');
      return languageId;
    }),
    'Search candidate language',
  );
  if (
    candidateLanguageIds.length !== 1 ||
    candidateLanguageIds[0] !== input.route.sourceLanguageId
  ) {
    throw new Error('SearchRequestV2 candidate language must equal the exact route source language.');
  }
  return contentAddress('search-request-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    target: input.target,
    route: input.route,
    requirement: requiredText(input.requirement, 'Search requirement'),
    topK: input.topK,
    repositoryScopes: canonicalTextList(input.repositoryScopes, 'Search repository scope'),
    candidateLanguageIds,
    rerank: input.rerank,
    createdAt: requireTimestamp(input.createdAt, 'Search request creation time'),
  });
}

export function validateSearchRequestV2(
  request: SearchRequestV2,
  runtime: MigrationRuntimeCapabilitySnapshot,
): SearchRequestV2 {
  const { id, contentHash, ...input } = request;
  const rebuilt = materializeSearchRequestV2(input, runtime);
  if (canonicalJson(rebuilt) !== canonicalJson(request) || rebuilt.id !== id || rebuilt.contentHash !== contentHash) {
    throw new Error('SearchRequestV2 hash or canonical structure is invalid.');
  }
  return request;
}

function canonicalScore(score: SearchCandidateV2['score']): SearchCandidateV2['score'] {
  const fields = ['overall', 'semantic', 'symbol', 'contract', 'hybrid', 'rerank'] as const;
  for (const field of fields) {
    const value = score[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`Search candidate score ${field} must be between zero and one.`);
    }
  }
  return {
    overall: score.overall,
    semantic: score.semantic,
    symbol: score.symbol,
    contract: score.contract,
    ...(score.hybrid === undefined ? {} : { hybrid: score.hybrid }),
    ...(score.rerank === undefined ? {} : { rerank: score.rerank }),
  };
}

function canonicalIndexGenerationRef(
  ref: ImplementationIndexGenerationRefV2,
): ImplementationIndexGenerationRefV2 {
  if (!Number.isSafeInteger(ref.generation) || ref.generation < 1) {
    throw new Error('Implementation index generation number must be a positive integer.');
  }
  return {
    repositoryId: requiredText(ref.repositoryId, 'Implementation index repository ID'),
    id: requiredText(ref.id, 'Implementation index generation ID'),
    generation: ref.generation,
    contentHash: requireSha256(ref.contentHash, 'Implementation index generation hash'),
    sourceCatalogId: requiredText(ref.sourceCatalogId, 'Implementation index source catalog ID'),
    sourceCatalogHash: requireSha256(ref.sourceCatalogHash, 'Implementation index source catalog hash'),
  };
}

export type MaterializeIndexedImplementationDocumentV2Input = Omit<
  IndexedImplementationDocumentV2,
  'id' | 'contentHash'
>;

export function materializeIndexedImplementationDocumentV2(
  input: MaterializeIndexedImplementationDocumentV2Input,
): IndexedImplementationDocumentV2 {
  if (input.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('IndexedImplementationDocumentV2 schema is unsupported.');
  }
  if (!input.sourceBundle) {
    throw new Error('Indexed implementation document requires an authoritative source bundle reference.');
  }
  validateImplementationCandidateRefV2(input.candidate);
  const sourceCatalog = canonicalCatalogRef(input.sourceCatalog, 'Indexed source catalog');
  const candidateLineage = canonicalRepositoryLineage(input.candidate.lineage, 'Indexed candidate lineage');
  const reviewedLineage = {
    repositoryId: sourceCatalog.repositoryId,
    ...(sourceCatalog.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: sourceCatalog.repositoryRevision }),
    repositoryContentHash: sourceCatalog.repositoryContentHash,
    unifiedRepositoryIrId: sourceCatalog.unifiedRepositoryIrId,
    unifiedRepositoryIrHash: sourceCatalog.unifiedRepositoryIrHash,
    moduleCatalogId: sourceCatalog.moduleCatalogId,
    moduleCatalogHash: sourceCatalog.moduleCatalogHash,
    moduleReviewId: sourceCatalog.moduleReviewId,
    moduleReviewHash: sourceCatalog.moduleReviewHash,
  };
  if (canonicalJson(candidateLineage) !== canonicalJson(reviewedLineage)) {
    throw new Error('Indexed implementation candidate lacks exact reviewed catalog lineage.');
  }
  const entityId = requiredText(input.entityId, 'Indexed implementation entity ID');
  const fileId = requiredText(input.fileId, 'Indexed implementation file ID');
  if (entityId !== input.candidate.entity.entityId || fileId !== input.candidate.entity.fileId) {
    throw new Error('Indexed implementation entity/file identity does not match its candidate.');
  }
  const sourceBundle = {
    id: requiredText(input.sourceBundle.id, 'Indexed source bundle ID'),
    contentHash: requireSha256(input.sourceBundle.contentHash, 'Indexed source bundle hash'),
  };
  if (
    input.candidate.sourceBundleId !== undefined &&
    (input.candidate.sourceBundleId !== sourceBundle.id ||
      input.candidate.sourceBundleHash !== sourceBundle.contentHash)
  ) {
    throw new Error('Indexed candidate source bundle reference is inconsistent.');
  }
  return contentAddress('indexed-implementation-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    candidate: input.candidate,
    sourceCatalog,
    moduleId: requiredText(input.moduleId, 'Indexed source module ID'),
    entityId,
    fileId,
    fileContentHash: requireSha256(input.fileContentHash, 'Indexed implementation file hash'),
    sourceBundle,
    title: requiredText(input.title, 'Indexed implementation title'),
    summary: requiredText(input.summary, 'Indexed implementation summary'),
    searchText: requiredText(input.searchText, 'Indexed implementation search text'),
    producer: canonicalProvider(input.producer, 'Indexed implementation'),
    createdAt: requireTimestamp(input.createdAt, 'Indexed implementation creation time'),
  });
}

export function validateIndexedImplementationDocumentV2(
  document: IndexedImplementationDocumentV2,
): IndexedImplementationDocumentV2 {
  const { id, contentHash, ...input } = document;
  const rebuilt = materializeIndexedImplementationDocumentV2(input);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(document)) {
    throw new Error('IndexedImplementationDocumentV2 hash or canonical structure is invalid.');
  }
  return document;
}

export interface MaterializeSearchCandidateV2Input {
  request: SearchRequestV2;
  indexedDocument: IndexedImplementationDocumentV2;
  indexGeneration: ImplementationIndexGenerationRefV2;
  score: SearchCandidateV2['score'];
  preview?: string;
  compatibility?: string[];
  risks?: string[];
  createdAt: string;
}

export function materializeSearchCandidateV2(
  input: MaterializeSearchCandidateV2Input,
  runtime: MigrationRuntimeCapabilitySnapshot,
): SearchCandidateV2 {
  validateSearchRequestV2(input.request, runtime);
  validateIndexedImplementationDocumentV2(input.indexedDocument);
  if (input.indexedDocument.candidate.entity.languageId !== input.request.route.sourceLanguageId) {
    throw new Error('SearchCandidateV2 language does not match the exact route source language.');
  }
  const indexGeneration = canonicalIndexGenerationRef(input.indexGeneration);
  if (
    indexGeneration.repositoryId !== input.indexedDocument.sourceCatalog.repositoryId ||
    indexGeneration.sourceCatalogId !== input.indexedDocument.sourceCatalog.moduleCatalogId ||
    indexGeneration.sourceCatalogHash !== input.indexedDocument.sourceCatalog.moduleCatalogHash
  ) {
    throw new Error('SearchCandidateV2 index generation does not match its reviewed source catalog.');
  }
  return contentAddress('search-candidate-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    requestId: input.request.id,
    requestHash: input.request.contentHash,
    targetId: input.request.target.id,
    targetHash: input.request.target.contentHash,
    route: input.request.route,
    indexGeneration,
    indexedDocumentId: input.indexedDocument.id,
    indexedDocumentHash: input.indexedDocument.contentHash,
    candidate: input.indexedDocument.candidate,
    sourceBundle: input.indexedDocument.sourceBundle,
    title: input.indexedDocument.title,
    summary: input.indexedDocument.summary,
    score: canonicalScore(input.score),
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    compatibility: canonicalTextList(input.compatibility ?? [], 'Search candidate compatibility fact'),
    risks: canonicalTextList(input.risks ?? [], 'Search candidate risk'),
    createdAt: requireTimestamp(input.createdAt, 'Search candidate creation time'),
  });
}

export function validateSearchCandidateV2(
  candidate: SearchCandidateV2,
  request: SearchRequestV2,
  indexedDocument: IndexedImplementationDocumentV2,
  runtime: MigrationRuntimeCapabilitySnapshot,
): SearchCandidateV2 {
  if (candidate.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('SearchCandidateV2 schema is unsupported; legacy candidates are rejected.');
  }
  const {
    id: _id,
    contentHash: _hash,
    requestId,
    requestHash,
    targetId,
    targetHash,
    route,
    indexGeneration,
    indexedDocumentId,
    indexedDocumentHash,
    candidate: candidateRef,
    sourceBundle,
    title,
    summary,
    ...input
  } = candidate;
  if (
    requestId !== request.id ||
    requestHash !== request.contentHash ||
    targetId !== request.target.id ||
    targetHash !== request.target.contentHash
  ) {
    throw new Error('SearchCandidateV2 does not bind to the exact search request and target.');
  }
  assertSameRoute(route, request.route, 'Search candidate');
  validateIndexedImplementationDocumentV2(indexedDocument);
  if (
    indexedDocumentId !== indexedDocument.id ||
    indexedDocumentHash !== indexedDocument.contentHash ||
    canonicalJson(candidateRef) !== canonicalJson(indexedDocument.candidate) ||
    canonicalJson(sourceBundle) !== canonicalJson(indexedDocument.sourceBundle) ||
    title !== indexedDocument.title ||
    summary !== indexedDocument.summary
  ) {
    throw new Error('SearchCandidateV2 does not bind to the indexed implementation document.');
  }
  const rebuilt = materializeSearchCandidateV2({
    request,
    indexedDocument,
    indexGeneration,
    ...input,
  }, runtime);
  if (canonicalJson(rebuilt) !== canonicalJson(candidate)) {
    throw new Error('SearchCandidateV2 hash or canonical structure is invalid.');
  }
  return candidate;
}

function canonicalSourceFile(file: SourceImplementationFileV2): SourceImplementationFileV2 {
  assertCanonicalLanguageId(file.languageId, `Source implementation file ${file.fileId} language`);
  if (file.role !== 'primary' && file.role !== 'helper' && file.role !== 'test' && file.role !== 'configuration') {
    throw new Error(`Source implementation file ${file.fileId} role is unsupported.`);
  }
  const contentHash = sha256Hex(file.content);
  if (file.contentHash !== contentHash) {
    throw new Error(`Source implementation file ${file.fileId} content hash is invalid.`);
  }
  return {
    fileId: requiredText(file.fileId, 'Source implementation file ID'),
    path: canonicalPath(file.path, `Source implementation file ${file.fileId} path`),
    languageId: file.languageId,
    role: file.role,
    content: file.content,
    contentHash,
  };
}

export interface MaterializeSourceImplementationBundleV2Input {
  candidate: ImplementationCandidateRef;
  primaryEntityId: string;
  helperEntityIds?: string[];
  testEntityIds?: string[];
  dependencyIds?: string[];
  files: SourceImplementationFileV2[];
  producer: MigrationProviderRefV2;
  createdAt: string;
}

export function materializeSourceImplementationBundleV2(
  input: MaterializeSourceImplementationBundleV2Input,
): SourceImplementationBundleV2 {
  validateImplementationCandidateRefV2(input.candidate);
  const files = input.files.map(canonicalSourceFile)
    .sort((left, right) => left.fileId.localeCompare(right.fileId));
  if (files.length === 0 || new Set(files.map((file) => file.fileId)).size !== files.length) {
    throw new Error('SourceImplementationBundleV2 requires unique source files.');
  }
  const primaryFiles = files.filter((file) => file.role === 'primary');
  if (primaryFiles.length !== 1) {
    throw new Error('SourceImplementationBundleV2 requires exactly one primary file.');
  }
  if (
    input.candidate.entity.fileId !== undefined &&
    primaryFiles[0]!.fileId !== input.candidate.entity.fileId
  ) {
    throw new Error('Source implementation primary file does not match the candidate entity.');
  }
  if (files.some((file) => file.role !== 'configuration' && file.languageId !== input.candidate.entity.languageId)) {
    throw new Error('Source implementation code files must match the candidate language.');
  }
  const primaryEntityId = requiredText(input.primaryEntityId, 'Source implementation primary entity ID');
  if (primaryEntityId !== input.candidate.entity.entityId) {
    throw new Error('Source implementation primary entity does not match the candidate.');
  }
  const helperEntityIds = canonicalTextList(input.helperEntityIds ?? [], 'Source helper entity ID');
  const testEntityIds = canonicalTextList(input.testEntityIds ?? [], 'Source test entity ID');
  if (helperEntityIds.includes(primaryEntityId) || testEntityIds.includes(primaryEntityId)) {
    throw new Error('Source implementation primary entity cannot also be a helper or test entity.');
  }
  return contentAddress('source-implementation-bundle-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    candidate: input.candidate,
    lineage: canonicalRepositoryLineage(input.candidate.lineage, 'Source implementation lineage'),
    primaryEntityId,
    helperEntityIds,
    testEntityIds,
    dependencyIds: canonicalTextList(input.dependencyIds ?? [], 'Source dependency ID'),
    files,
    producer: canonicalProvider(input.producer, 'Source bundle'),
    createdAt: requireTimestamp(input.createdAt, 'Source implementation bundle creation time'),
  });
}

export function validateSourceImplementationBundleV2(
  bundle: SourceImplementationBundleV2,
): SourceImplementationBundleV2 {
  if (bundle.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('SourceImplementationBundleV2 schema is unsupported.');
  }
  const { id, contentHash, lineage, ...input } = bundle;
  if (canonicalJson(lineage) !== canonicalJson(bundle.candidate.lineage)) {
    throw new Error('Source implementation bundle lineage does not match its candidate.');
  }
  const rebuilt = materializeSourceImplementationBundleV2(input);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(bundle)) {
    throw new Error('SourceImplementationBundleV2 hash or canonical structure is invalid.');
  }
  return bundle;
}

function assertProviderMatchesRouteStage(
  provider: MigrationProviderRefV2,
  route: MaterializedMigrationRouteDescriptor,
  stages: readonly MigrationRouteStage[],
  label: string,
): void {
  const matches = route.stages.some((stage) =>
    stages.includes(stage.stage) &&
    stage.providerId === provider.providerId &&
    stage.providerVersion === provider.providerVersion &&
    stage.availability.status !== 'unavailable',
  );
  if (!matches) throw new Error(`${label} provider is not declared by the exact migration route.`);
}

function canonicalContextFact(
  fact: TargetContextFactV2,
  role: TargetContextFactRoleV2,
): TargetContextFactV2 {
  if (fact.role !== role) throw new Error(`Target context fact ${fact.id} has the wrong role.`);
  if (fact.languageId !== undefined) {
    assertCanonicalLanguageId(fact.languageId, `Target context fact ${fact.id} language`);
  }
  if (fact.content !== undefined && sha256Hex(fact.content) !== fact.contentHash) {
    throw new Error(`Target context fact ${fact.id} content hash is invalid.`);
  }
  return {
    id: requiredText(fact.id, 'Target context fact ID'),
    role,
    ...(fact.languageId === undefined ? {} : { languageId: fact.languageId }),
    ...(fact.entityId === undefined ? {} : { entityId: requiredText(fact.entityId, `Target context fact ${fact.id} entity ID`) }),
    ...(fact.fileId === undefined ? {} : { fileId: requiredText(fact.fileId, `Target context fact ${fact.id} file ID`) }),
    ...(fact.path === undefined ? {} : { path: canonicalPath(fact.path, `Target context fact ${fact.id} path`) }),
    ...(fact.content === undefined ? {} : { content: fact.content }),
    contentHash: requireSha256(fact.contentHash, `Target context fact ${fact.id} content hash`),
    provider: canonicalProvider(fact.provider, `Target context fact ${fact.id}`),
    attributes: { ...fact.attributes },
  };
}

function canonicalContextFacts(
  facts: readonly TargetContextFactV2[],
  role: TargetContextFactRoleV2,
): TargetContextFactV2[] {
  const result = facts.map((fact) => canonicalContextFact(fact, role))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(result.map((fact) => fact.id)).size !== result.length) {
    throw new Error(`Target context repeats a ${role} fact ID.`);
  }
  return result;
}

function canonicalAllowedModifications(
  modifications: readonly AllowedModificationV2[],
): AllowedModificationV2[] {
  const result = modifications.map((modification) => {
    const path = canonicalPath(modification.path, 'Allowed modification path');
    if (modification.operation === 'modify') {
      return {
        path,
        operation: 'modify' as const,
        expectedContentHash: requireSha256(
          modification.expectedContentHash,
          `Allowed modification ${path} expected content hash`,
        ),
      };
    }
    if (modification.operation === 'create' && modification.expectedAbsent === true) {
      return { path, operation: 'create' as const, expectedAbsent: true as const };
    }
    throw new Error(`Allowed modification ${path} operation is unsupported.`);
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (result.length === 0 || new Set(result.map((item) => item.path)).size !== result.length) {
    throw new Error('Target context requires unique allowed modification paths.');
  }
  return result;
}

export type MaterializeTargetContextSnapshotV2Input = Omit<
  TargetContextSnapshotV2,
  'id' | 'contentHash'
>;

export function materializeTargetContextSnapshotV2(
  input: MaterializeTargetContextSnapshotV2Input,
  runtime: MigrationRuntimeCapabilitySnapshot,
): TargetContextSnapshotV2 {
  if (input.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('TargetContextSnapshotV2 schema is unsupported; legacy target contexts are rejected.');
  }
  validateMigrationTargetRefV2(input.target, runtime);
  const route = routeForRef(input.route, runtime);
  assertSameRoute(input.target.route, input.route, 'Target context');
  const producer = canonicalProvider(input.producer, 'Target context');
  assertProviderMatchesRouteStage(producer, route, ['context-collection', 'target-analysis'], 'Target context');
  const declarations = canonicalContextFacts(input.declarations, 'declaration');
  if (!declarations.some((fact) => fact.entityId === input.target.entity.entityId)) {
    throw new Error('Target context lacks a declaration fact for the selected target entity.');
  }
  const allowedModifications = canonicalAllowedModifications(input.allowedModifications);
  if (
    canonicalJson(allowedModifications.map((item) => item.path)) !==
    canonicalJson(input.target.allowedModificationPaths)
  ) {
    throw new Error('Target context allowed modifications do not match the target authorization.');
  }
  const targetModification = allowedModifications.find((item) => item.path === input.target.entity.path)!;
  if (
    targetModification.operation !== 'modify' ||
    targetModification.expectedContentHash !== input.target.entity.fileContentHash
  ) {
    throw new Error('Target file modification does not bind its current file hash.');
  }
  const sourceFiles = canonicalContextFacts(input.sourceFiles, 'source-file');
  for (const sourceFile of sourceFiles) {
    if (
      sourceFile.fileId === undefined ||
      sourceFile.path === undefined ||
      sourceFile.content === undefined
    ) {
      throw new Error(`Target context source file ${sourceFile.id} requires file ID, path, and full content.`);
    }
  }
  if (
    new Set(sourceFiles.map((fact) => fact.fileId)).size !== sourceFiles.length ||
    new Set(sourceFiles.map((fact) => fact.path)).size !== sourceFiles.length
  ) {
    throw new Error('Target context source files must have unique file IDs and paths.');
  }
  const selectedSourceFiles = sourceFiles.filter((fact) =>
    fact.fileId === input.target.entity.fileId &&
    fact.path === input.target.entity.path &&
    fact.contentHash === input.target.entity.fileContentHash);
  if (selectedSourceFiles.length !== 1) {
    throw new Error('Target context requires exactly one full source file matching the selected target file identity.');
  }
  return contentAddress('target-context-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    target: input.target,
    route: input.route,
    sourceFiles,
    declarations,
    containers: canonicalContextFacts(input.containers, 'container'),
    imports: canonicalContextFacts(input.imports, 'import'),
    dependencies: canonicalContextFacts(input.dependencies, 'dependency'),
    references: canonicalContextFacts(input.references, 'reference'),
    callers: canonicalContextFacts(input.callers, 'caller'),
    tests: canonicalContextFacts(input.tests, 'test'),
    buildFacts: canonicalContextFacts(input.buildFacts, 'build-fact'),
    allowedModifications,
    constraints: canonicalTextList(input.constraints, 'Target context constraint'),
    producer,
    createdAt: requireTimestamp(input.createdAt, 'Target context creation time'),
  });
}

export function validateTargetContextSnapshotV2(
  snapshot: TargetContextSnapshotV2,
  runtime: MigrationRuntimeCapabilitySnapshot,
): TargetContextSnapshotV2 {
  const { id, contentHash, ...input } = snapshot;
  const rebuilt = materializeTargetContextSnapshotV2(input, runtime);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(snapshot)) {
    throw new Error('TargetContextSnapshotV2 hash or canonical structure is invalid.');
  }
  return snapshot;
}

export interface MigrationExecutionV2ValidationContext {
  runtimeCapabilities: MigrationRuntimeCapabilitySnapshot;
  currentSourceCatalog: RepositoryModuleCatalogRef;
  currentTargetCatalog: RepositoryModuleCatalogRef;
  mappingProposal: ModuleMappingProposal;
  mappingReview: ModuleMappingReview;
  executionOverlay: MigrationExecutionOverlay;
}

function assertModuleMappingArtifactHash(
  artifact: { id: string; contentHash: string },
  prefix: string,
  payload: object,
): void {
  assertContentAddress(artifact, prefix, payload);
}

function canonicalExecutionLineage(
  lineage: MigrationExecutionLineageV2,
): MigrationExecutionLineageV2 {
  return {
    sourceCatalog: canonicalCatalogRef(lineage.sourceCatalog, 'Execution source catalog'),
    targetCatalog: canonicalCatalogRef(lineage.targetCatalog, 'Execution target catalog'),
    mappingProposalId: requiredText(lineage.mappingProposalId, 'Mapping proposal ID'),
    mappingProposalHash: requireSha256(lineage.mappingProposalHash, 'Mapping proposal hash'),
    mappingReviewId: requiredText(lineage.mappingReviewId, 'Mapping review ID'),
    mappingReviewHash: requireSha256(lineage.mappingReviewHash, 'Mapping review hash'),
    executionOverlayId: requiredText(lineage.executionOverlayId, 'Execution overlay ID'),
    executionOverlayHash: requireSha256(lineage.executionOverlayHash, 'Execution overlay hash'),
  };
}

function assertExecutionLineage(
  lineage: MigrationExecutionLineageV2,
  routeRef: MigrationRouteSnapshotRef,
  context: MigrationExecutionV2ValidationContext,
): void {
  routeForRef(routeRef, context.runtimeCapabilities);
  const canonical = canonicalExecutionLineage(lineage);
  const sourceCatalog = canonicalCatalogRef(context.currentSourceCatalog, 'Current source catalog');
  const targetCatalog = canonicalCatalogRef(context.currentTargetCatalog, 'Current target catalog');
  if (
    canonicalJson(canonical.sourceCatalog) !== canonicalJson(sourceCatalog) ||
    canonicalJson(canonical.targetCatalog) !== canonicalJson(targetCatalog)
  ) {
    throw new Error('V2 execution catalog lineage is stale or mismatched.');
  }

  const { id: proposalId, contentHash: proposalHash, ...proposalPayload } = context.mappingProposal;
  assertModuleMappingArtifactHash(
    { id: proposalId, contentHash: proposalHash },
    'module-mapping-proposal',
    proposalPayload,
  );
  const { id: reviewId, contentHash: reviewHash, ...reviewPayload } = context.mappingReview;
  assertModuleMappingArtifactHash(
    { id: reviewId, contentHash: reviewHash },
    'module-mapping-review',
    reviewPayload,
  );
  const { id: overlayId, contentHash: overlayHash, ...overlayPayload } = context.executionOverlay;
  assertModuleMappingArtifactHash(
    { id: overlayId, contentHash: overlayHash },
    'migration-execution-overlay',
    overlayPayload,
  );
  if (
    context.mappingReview.decision !== 'accept' ||
    context.mappingReview.proposalId !== context.mappingProposal.id ||
    context.mappingReview.proposalHash !== context.mappingProposal.contentHash ||
    context.executionOverlay.mappingProposalId !== context.mappingProposal.id ||
    context.executionOverlay.mappingProposalHash !== context.mappingProposal.contentHash ||
    context.executionOverlay.mappingReviewId !== context.mappingReview.id ||
    context.executionOverlay.mappingReviewHash !== context.mappingReview.contentHash ||
    context.executionOverlay.routeId !== routeRef.routeId ||
    context.executionOverlay.routeVersion !== routeRef.routeVersion ||
    canonicalJson(context.mappingProposal.sourceCatalog) !== canonicalJson(sourceCatalog) ||
    canonicalJson(context.mappingProposal.targetCatalog) !== canonicalJson(targetCatalog) ||
    canonicalJson(context.mappingReview.sourceCatalog) !== canonicalJson(sourceCatalog) ||
    canonicalJson(context.mappingReview.targetCatalog) !== canonicalJson(targetCatalog) ||
    canonicalJson(context.executionOverlay.sourceCatalog) !== canonicalJson(sourceCatalog) ||
    canonicalJson(context.executionOverlay.targetCatalog) !== canonicalJson(targetCatalog)
  ) {
    throw new Error('V2 execution mapping/review/overlay lineage is inconsistent.');
  }
  if (
    canonical.mappingProposalId !== context.mappingProposal.id ||
    canonical.mappingProposalHash !== context.mappingProposal.contentHash ||
    canonical.mappingReviewId !== context.mappingReview.id ||
    canonical.mappingReviewHash !== context.mappingReview.contentHash ||
    canonical.executionOverlayId !== context.executionOverlay.id ||
    canonical.executionOverlayHash !== context.executionOverlay.contentHash
  ) {
    throw new Error('V2 execution lineage does not bind the exact mapping artifacts.');
  }
}

function routePolicy(
  routeRef: MigrationRouteSnapshotRef,
  runtime: MigrationRuntimeCapabilitySnapshot,
): MaterializedValidationPolicySnapshot {
  return routeForRef(routeRef, runtime).validationPolicy;
}

function assertPolicyBinding(
  policy: MaterializedValidationPolicySnapshot,
  routeRef: MigrationRouteSnapshotRef,
  runtime: MigrationRuntimeCapabilitySnapshot,
): void {
  const expected = routePolicy(routeRef, runtime);
  if (canonicalJson(policy) !== canonicalJson(expected)) {
    throw new Error('Validation policy does not match the exact route snapshot.');
  }
}

function catalogAsRepositoryLineage(ref: RepositoryModuleCatalogRef): ImplementationCandidateRef['lineage'] {
  return {
    repositoryId: ref.repositoryId,
    ...(ref.repositoryRevision === undefined ? {} : { repositoryRevision: ref.repositoryRevision }),
    repositoryContentHash: ref.repositoryContentHash,
    unifiedRepositoryIrId: ref.unifiedRepositoryIrId,
    unifiedRepositoryIrHash: ref.unifiedRepositoryIrHash,
    moduleCatalogId: ref.moduleCatalogId,
    moduleCatalogHash: ref.moduleCatalogHash,
    moduleReviewId: ref.moduleReviewId,
    moduleReviewHash: ref.moduleReviewHash,
  };
}

export function calculatePatchSubjectHashV2(context: TargetContextSnapshotV2): string {
  return sha256Hex(canonicalJson({
    targetId: context.target.id,
    targetHash: context.target.contentHash,
    targetContextId: context.id,
    targetContextHash: context.contentHash,
    allowedModifications: context.allowedModifications,
  }));
}

export type MaterializeAdaptationRequestV2Input = Omit<AdaptationRequestV2, 'id' | 'contentHash'>;

export function materializeAdaptationRequestV2(
  input: MaterializeAdaptationRequestV2Input,
  context: MigrationExecutionV2ValidationContext,
): AdaptationRequestV2 {
  if (input.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('AdaptationRequestV2 schema is unsupported; legacy adaptation requests are rejected.');
  }
  const route = routeForRef(input.route, context.runtimeCapabilities);
  assertExecutionLineage(input.executionLineage, input.route, context);
  validateMigrationTargetRefV2(input.target, context.runtimeCapabilities);
  validateImplementationCandidateRefV2(input.candidate);
  validateSourceImplementationBundleV2(input.sourceBundle);
  validateTargetContextSnapshotV2(input.targetContext, context.runtimeCapabilities);
  assertSameRoute(input.target.route, input.route, 'Adaptation target');
  assertSameRoute(input.targetContext.route, input.route, 'Adaptation target context');
  if (input.strategy !== route.strategy) {
    throw new Error('AdaptationRequestV2 strategy does not match the exact route.');
  }
  if (
    canonicalJson(input.targetContext.target) !== canonicalJson(input.target) ||
    canonicalJson(input.sourceBundle.candidate) !== canonicalJson(input.candidate)
  ) {
    throw new Error('AdaptationRequestV2 source or target artifacts are inconsistent.');
  }
  const executionLineage = canonicalExecutionLineage(input.executionLineage);
  if (
    canonicalJson(input.candidate.lineage) !==
      canonicalJson(catalogAsRepositoryLineage(executionLineage.sourceCatalog)) ||
    canonicalJson(input.target.lineage) !==
      canonicalJson(catalogAsRepositoryLineage(executionLineage.targetCatalog))
  ) {
    throw new Error('AdaptationRequestV2 candidate/target catalog lineage is inconsistent.');
  }
  const mappedSourceEntities = new Set(
    context.executionOverlay.groups.flatMap((group) => group.sourceEntityIds),
  );
  const mappedTargetEntities = new Set(
    context.executionOverlay.groups.flatMap((group) => group.targetEntityIds),
  );
  if (
    !mappedSourceEntities.has(input.candidate.entity.entityId) ||
    !mappedTargetEntities.has(input.target.entity.entityId)
  ) {
    throw new Error('AdaptationRequestV2 entities are outside the approved execution overlay.');
  }
  const patchSubjectHash = requireSha256(input.patchSubjectHash, 'Patch subject hash');
  if (patchSubjectHash !== calculatePatchSubjectHashV2(input.targetContext)) {
    throw new Error('AdaptationRequestV2 patch subject hash does not match the target context.');
  }
  assertPolicyBinding(input.validationPolicy, input.route, context.runtimeCapabilities);
  return contentAddress('adaptation-request-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    route: input.route,
    executionLineage,
    target: input.target,
    candidate: input.candidate,
    sourceBundle: input.sourceBundle,
    targetContext: input.targetContext,
    patchSubjectHash,
    validationPolicy: input.validationPolicy,
    requirement: requiredText(input.requirement, 'Adaptation requirement'),
    strategy: input.strategy,
    decisionNotes: canonicalTextList(input.decisionNotes, 'Adaptation decision note'),
    createdAt: requireTimestamp(input.createdAt, 'Adaptation request creation time'),
  });
}

export function validateAdaptationRequestV2(
  request: AdaptationRequestV2,
  context: MigrationExecutionV2ValidationContext,
): AdaptationRequestV2 {
  const { id, contentHash, ...input } = request;
  const rebuilt = materializeAdaptationRequestV2(input, context);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(request)) {
    throw new Error('AdaptationRequestV2 hash or canonical structure is invalid.');
  }
  return request;
}

function canonicalPatches(
  files: AdaptationResultV2['files'],
  request: AdaptationRequestV2,
): AdaptationResultV2['files'] {
  const authorization = new Map(
    request.targetContext.allowedModifications.map((item) => [item.path, item]),
  );
  const seen = new Set<string>();
  return files.map((file) => {
    const path = canonicalPath(file.path, 'Patch path');
    if (seen.has(path)) throw new Error(`AdaptationResultV2 repeats patch path ${path}.`);
    seen.add(path);
    const allowed = authorization.get(path);
    if (!allowed) throw new Error(`AdaptationResultV2 patch path is not allowed: ${path}.`);
    if (!Number.isInteger(file.additions) || file.additions < 0 || !Number.isInteger(file.deletions) || file.deletions < 0) {
      throw new Error(`AdaptationResultV2 patch counts are invalid for ${path}.`);
    }
    const base = {
      path,
      additions: file.additions,
      deletions: file.deletions,
      hunks: file.hunks.map((hunk) => ({
        header: requiredText(hunk.header, `Patch ${path} hunk header`),
        lines: hunk.lines.map((line) => {
          if (line.type !== 'context' && line.type !== 'add' && line.type !== 'remove') {
            throw new Error(`Patch ${path} has an unsupported hunk line type.`);
          }
          return { type: line.type, content: line.content };
        }),
      })),
    };
    if (file.status === 'modified') {
      if (
        allowed.operation !== 'modify' ||
        file.expectedOriginalSha256 !== allowed.expectedContentHash
      ) {
        throw new Error(`Modified patch ${path} does not bind its authorized original hash.`);
      }
      return {
        ...base,
        status: 'modified' as const,
        expectedOriginalSha256: requireSha256(file.expectedOriginalSha256, `Patch ${path} original hash`),
      };
    }
    if (file.status === 'created' && file.expectedAbsent === true && allowed.operation === 'create') {
      return { ...base, status: 'created' as const, expectedAbsent: true as const };
    }
    throw new Error(`Created patch ${path} is not authorized as an absent file.`);
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function calculatePatchHashV2(files: AdaptationResultV2['files']): string {
  return sha256Hex(canonicalJson(files));
}

function canonicalValidationRecords(
  records: readonly ValidationRecord[],
  policy: MaterializedValidationPolicySnapshot,
  routeRef: MigrationRouteSnapshotRef,
  subjectHash: string,
): ValidationRecord[] {
  const checks = new Map(policy.checks.map((check) => [check.id, check]));
  const seen = new Set<string>();
  const covered = new Set<string>();
  const result = records.map((record) => {
    const id = requiredText(record.id, 'Validation record ID');
    if (seen.has(id)) throw new Error(`AdaptationResultV2 repeats validation record ${id}.`);
    seen.add(id);
    if (!record.policyCheckId) throw new Error(`Validation record ${id} lacks a policy check ID.`);
    const check = checks.get(record.policyCheckId);
    if (!check) throw new Error(`Validation record ${id} cites an unknown policy check.`);
    if (covered.has(check.id)) throw new Error(`Validation policy check ${check.id} has duplicate records.`);
    covered.add(check.id);
    if (
      record.routeId !== routeRef.routeId ||
      record.routeVersion !== routeRef.routeVersion ||
      record.verifierId !== check.verifierId ||
      record.verifierVersion !== check.verifierVersion ||
      record.required !== check.required ||
      record.phase !== check.phase ||
      record.subjectHash !== subjectHash
    ) {
      throw new Error(`Validation record ${id} does not match its route policy or patch subject.`);
    }
    if (
      record.status !== 'pass' &&
      record.status !== 'warn' &&
      record.status !== 'fail' &&
      record.status !== 'unverified'
    ) {
      throw new Error(`Validation record ${id} status is unsupported.`);
    }
    requiredText(record.summary, `Validation record ${id} summary`);
    const artifact = record.artifact === undefined
      ? undefined
      : {
          id: requiredText(record.artifact.id, `Validation record ${id} artifact ID`),
          kind: requiredText(record.artifact.kind, `Validation record ${id} artifact kind`),
          path: canonicalArtifactPath(record.artifact.path, `Validation record ${id} artifact path`),
          contentHash: requireSha256(record.artifact.contentHash, `Validation record ${id} artifact hash`),
          mediaType: requiredText(record.artifact.mediaType, `Validation record ${id} artifact media type`),
        };
    const artifactPath = record.artifactPath === undefined
      ? undefined
      : canonicalArtifactPath(record.artifactPath, `Validation record ${id} artifact path`);
    if (artifact && artifactPath !== undefined && artifactPath !== artifact.path) {
      throw new Error(`Validation record ${id} legacy artifact path does not match its artifact.`);
    }
    return { ...record, ...(artifactPath === undefined ? {} : { artifactPath }), ...(artifact === undefined ? {} : { artifact }) };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const missing = policy.checks.filter((check) => check.required && !covered.has(check.id));
  if (missing.length > 0) {
    throw new Error(`AdaptationResultV2 lacks required verifier records: ${missing.map((check) => check.id).join(', ')}.`);
  }
  return result;
}

function canonicalRepositoryIngestionJsonValue(
  value: RepositoryIngestionJsonValue,
  label: string,
): RepositoryIngestionJsonValue {
  const serialized = canonicalJson(value);
  if (serialized === undefined) throw new Error(`${label} must be JSON-compatible.`);
  return JSON.parse(serialized) as RepositoryIngestionJsonValue;
}

function canonicalLocatedArtifactRefs(
  refs: readonly MigrationLocatedArtifactRefV2[],
  label: string,
): MigrationLocatedArtifactRefV2[] {
  const seen = new Set<string>();
  return refs.map((ref) => {
    const id = requiredText(ref.id, `${label} artifact ID`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate artifact references.`);
    seen.add(id);
    return {
      id,
      path: canonicalPath(ref.path, `${label} artifact ${id} path`),
      contentHash: requireSha256(ref.contentHash, `${label} artifact ${id} hash`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalUniqueTextList(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => requiredText(value, label));
  const result = sortedUnique(normalized);
  if (result.length !== normalized.length) {
    throw new Error(`${label} contains duplicate entries.`);
  }
  return result;
}

function canonicalRepairIssues(
  issues: readonly MigrationRepairIssueV2[],
  label: string,
  verifierArtifacts: readonly MigrationLocatedArtifactRefV2[],
): MigrationRepairIssueV2[] {
  if (issues.length === 0) throw new Error(`${label} must include at least one repair issue.`);
  const artifactIds = new Set(verifierArtifacts.map((artifact) => artifact.id));
  const seen = new Set<string>();
  return issues.map((issue) => {
    const id = requiredText(issue.id, `${label} issue ID`);
    if (seen.has(id)) throw new Error(`${label} repeats issue ID ${id}.`);
    seen.add(id);
    const evidenceArtifactIds = canonicalUniqueTextList(
      issue.evidenceArtifactIds,
      `${label} issue ${id} evidence artifact ID`,
    );
    if (evidenceArtifactIds.length === 0 && issue.kind !== "compile-failure") {
      throw new Error(`${label} issue ${id} must reference at least one evidence artifact.`);
    }
    if (evidenceArtifactIds.some((artifactId) => !artifactIds.has(artifactId))) {
      throw new Error(`${label} issue ${id} cites an unknown evidence artifact.`);
    }
    return {
      id,
      kind: requiredText(issue.kind, `${label} issue ${id} kind`),
      message: requiredText(issue.message, `${label} issue ${id} message`),
      ...(issue.caseId === undefined ? {} : { caseId: requiredText(issue.caseId, `${label} issue ${id} case ID`) }),
      ...(issue.sourceObservation === undefined
        ? {}
        : { sourceObservation: canonicalRepositoryIngestionJsonValue(issue.sourceObservation, `${label} issue ${id} source observation`) }),
      ...(issue.targetObservation === undefined
        ? {}
        : { targetObservation: canonicalRepositoryIngestionJsonValue(issue.targetObservation, `${label} issue ${id} target observation`) }),
      evidenceArtifactIds,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalRepairRounds(
  rounds: readonly MigrationRepairRoundV2[],
  finalPatchHash: string,
  policy: MaterializedValidationPolicySnapshot,
  routeRef: MigrationRouteSnapshotRef,
  route: MaterializedMigrationRouteDescriptor,
): MigrationRepairRoundV2[] {
  if (rounds.length > 2) throw new Error('Repair history may contain at most two rounds.');
  const sorted = [...rounds].sort((left, right) => left.round - right.round);
  let previousOutputPatchHash: string | undefined;
  const canonicalRounds = sorted.map((round, index) => {
    if (round.round !== index + 1) throw new Error('Repair rounds must be contiguous from one.');
    const inputPatchHash = requireSha256(round.inputPatchHash, `Repair round ${round.round} input patch hash`);
    const outputPatchHash = requireSha256(round.outputPatchHash, `Repair round ${round.round} output patch hash`);
    if (inputPatchHash === outputPatchHash) {
      throw new Error(`Repair round ${round.round} must produce a new patch hash.`);
    }
    if (index > 0 && inputPatchHash !== previousOutputPatchHash) {
      throw new Error(`Repair round ${round.round} does not chain from the previous patch.`);
    }
    const provider = canonicalProvider(round.provider, `Repair round ${round.round}`);
    assertProviderMatchesRouteStage(provider, route, ['translation', 'patch-generation'], `Repair round ${round.round}`);
    const triggerValidationRecords = canonicalValidationRecords(
      round.triggerValidationRecords,
      policy,
      routeRef,
      inputPatchHash,
    );
    const expectedTriggerPolicyCheckIds = policy.checks.map((check) => check.id).sort((left, right) => left.localeCompare(right));
    const actualTriggerPolicyCheckIds = triggerValidationRecords
      .map((record): string => record.policyCheckId!)
      .sort((left, right) => left.localeCompare(right));
    if (canonicalJson(actualTriggerPolicyCheckIds) !== canonicalJson(expectedTriggerPolicyCheckIds)) {
      throw new Error(`Repair round ${round.round} trigger validation snapshot must include exactly one record for every policy check.`);
    }
    const triggerValidationRecordIds = canonicalUniqueTextList(
      round.triggerValidationRecordIds,
      `Repair round ${round.round} trigger validation record ID`,
    );
    const requiredFailedRecordIds = canonicalUniqueTextList(
      triggerValidationRecords
        .filter((record) => record.required && record.status === 'fail')
        .map((record) => record.id),
      `Repair round ${round.round} required failed trigger validation record ID`,
    );
    if (requiredFailedRecordIds.length === 0) {
      throw new Error(`Repair round ${round.round} must include at least one required failed trigger validation record.`);
    }
    if (canonicalJson(triggerValidationRecordIds) !== canonicalJson(requiredFailedRecordIds)) {
      throw new Error(`Repair round ${round.round} trigger validation record IDs do not match the required failed records.`);
    }
    const verifierArtifacts = canonicalLocatedArtifactRefs(round.verifierArtifacts, `Repair round ${round.round}`);
    const issues = canonicalRepairIssues(round.issues, `Repair round ${round.round}`, verifierArtifacts);
    const verificationResultHash = round.verificationResultHash === undefined
      ? undefined
      : requireSha256(round.verificationResultHash, `Repair round ${round.round} verification result hash`);
    previousOutputPatchHash = outputPatchHash;
    return {
      round: round.round,
      inputPatchHash,
      outputPatchHash,
      triggerValidationRecordIds,
      triggerValidationRecords,
      issues,
      ...(verificationResultHash === undefined ? {} : { verificationResultHash }),
      verifierArtifacts,
      provider,
      createdAt: requireTimestamp(round.createdAt, `Repair round ${round.round} creation time`),
    };
  });
  if (canonicalRounds.length > 0 && canonicalRounds.at(-1)!.outputPatchHash !== finalPatchHash) {
    throw new Error('Final repair round output does not match the adaptation patch.');
  }
  return canonicalRounds;
}

export interface MaterializeAdaptationResultV2Input {
  request: AdaptationRequestV2;
  files: AdaptationResultV2['files'];
  validation: ValidationRecord[];
  repairRounds?: MigrationRepairRoundV2[];
  producer: MigrationProviderRefV2;
  createdAt: string;
}

export function materializeAdaptationResultV2(
  input: MaterializeAdaptationResultV2Input,
  context: MigrationExecutionV2ValidationContext,
): AdaptationResultV2 {
  validateAdaptationRequestV2(input.request, context);
  const route = routeForRef(input.request.route, context.runtimeCapabilities);
  const producer = canonicalProvider(input.producer, 'Adaptation result');
  assertProviderMatchesRouteStage(producer, route, ['translation', 'patch-generation'], 'Adaptation result');
  const files = canonicalPatches(input.files, input.request);
  if (files.length === 0) throw new Error('AdaptationResultV2 requires at least one patch.');
  const patchHash = calculatePatchHashV2(files);
  const validation = canonicalValidationRecords(
    input.validation,
    input.request.validationPolicy,
    input.request.route,
    patchHash,
  );
  const repairRounds = canonicalRepairRounds(
    input.repairRounds ?? [],
    patchHash,
    input.request.validationPolicy,
    input.request.route,
    route,
  );
  return contentAddress('adaptation-result-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    requestId: input.request.id,
    requestHash: input.request.contentHash,
    route: input.request.route,
    executionLineage: input.request.executionLineage,
    targetId: input.request.target.id,
    targetHash: input.request.target.contentHash,
    sourceBundleId: input.request.sourceBundle.id,
    sourceBundleHash: input.request.sourceBundle.contentHash,
    targetContextId: input.request.targetContext.id,
    targetContextHash: input.request.targetContext.contentHash,
    patchSubjectHash: input.request.patchSubjectHash,
    patchHash,
    files,
    validationPolicy: input.request.validationPolicy,
    validation,
    repairRounds,
    producer,
    createdAt: requireTimestamp(input.createdAt, 'Adaptation result creation time'),
  });
}

export function validateAdaptationResultV2(
  result: AdaptationResultV2,
  request: AdaptationRequestV2,
  context: MigrationExecutionV2ValidationContext,
): AdaptationResultV2 {
  if (result.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('AdaptationResultV2 schema is unsupported; legacy adaptation results are rejected.');
  }
  const { id, contentHash, requestId, requestHash, route, executionLineage, targetId, targetHash,
    sourceBundleId, sourceBundleHash, targetContextId, targetContextHash, patchSubjectHash,
    patchHash, validationPolicy, ...input } = result;
  if (
    requestId !== request.id ||
    requestHash !== request.contentHash ||
    targetId !== request.target.id ||
    targetHash !== request.target.contentHash ||
    sourceBundleId !== request.sourceBundle.id ||
    sourceBundleHash !== request.sourceBundle.contentHash ||
    targetContextId !== request.targetContext.id ||
    targetContextHash !== request.targetContext.contentHash ||
    patchSubjectHash !== request.patchSubjectHash ||
    canonicalJson(route) !== canonicalJson(request.route) ||
    canonicalJson(executionLineage) !== canonicalJson(request.executionLineage) ||
    canonicalJson(validationPolicy) !== canonicalJson(request.validationPolicy)
  ) {
    throw new Error('AdaptationResultV2 lineage is inconsistent with its request.');
  }
  const rebuilt = materializeAdaptationResultV2({ request, ...input }, context);
  if (
    rebuilt.id !== id ||
    rebuilt.contentHash !== contentHash ||
    rebuilt.patchHash !== patchHash ||
    canonicalJson(rebuilt) !== canonicalJson(result)
  ) {
    throw new Error('AdaptationResultV2 hash or canonical structure is invalid.');
  }
  return result;
}

function canonicalArtifactRefs(
  refs: readonly { id: string; contentHash: string }[],
  label: string,
): Array<{ id: string; contentHash: string }> {
  const result = refs.map((ref) => ({
    id: requiredText(ref.id, `${label} artifact ID`),
    contentHash: requireSha256(ref.contentHash, `${label} artifact hash`),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(result.map((ref) => ref.id)).size !== result.length) {
    throw new Error(`${label} contains duplicate artifact references.`);
  }
  return result;
}

function canonicalProviderExecutions(
  providers: MigrationRunManifestV2['providers'],
  route: MaterializedMigrationRouteDescriptor,
): MigrationRunManifestV2['providers'] {
  const byStage = new Map(route.stages.map((stage) => [stage.stage, stage]));
  const seen = new Set<MigrationRouteStage>();
  const result = providers.map((record) => {
    const stage = byStage.get(record.stage);
    if (!stage || stage.availability.status === 'unavailable') {
      throw new Error(`Manifest provider record cites unavailable route stage ${record.stage}.`);
    }
    if (seen.has(record.stage)) throw new Error(`Manifest repeats provider stage ${record.stage}.`);
    seen.add(record.stage);
    if (record.providerId !== stage.providerId || record.providerVersion !== stage.providerVersion) {
      throw new Error(`Manifest provider for ${record.stage} does not match the route snapshot.`);
    }
    if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'unverified') {
      throw new Error(`Manifest provider status for ${record.stage} is unsupported.`);
    }
    const provider = canonicalProvider(record, `Manifest ${record.stage}`);
    return {
      ...provider,
      stage: record.stage,
      status: record.status,
      startedAt: requireTimestamp(record.startedAt, `Manifest ${record.stage} start time`),
      ...(record.completedAt === undefined
        ? {}
        : { completedAt: requireTimestamp(record.completedAt, `Manifest ${record.stage} completion time`) }),
      artifactRefs: canonicalArtifactRefs(record.artifactRefs, `Manifest ${record.stage}`),
    };
  }).sort((left, right) => left.stage.localeCompare(right.stage));
  const missing = route.stages.filter((stage) =>
    stage.availability.status !== 'unavailable' && !seen.has(stage.stage),
  );
  if (missing.length > 0) {
    throw new Error(`Manifest lacks route provider stages: ${missing.map((stage) => stage.stage).join(', ')}.`);
  }
  return result;
}

function canonicalValidatorExecutions(
  validators: MigrationRunManifestV2['validators'],
  result: AdaptationResultV2,
): MigrationRunManifestV2['validators'] {
  const checks = new Map(result.validationPolicy.checks.map((check) => [check.id, check]));
  const records = new Map(result.validation.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const canonical = validators.map((entry) => {
    if (seen.has(entry.policyCheckId)) {
      throw new Error(`Manifest repeats validator for policy check ${entry.policyCheckId}.`);
    }
    seen.add(entry.policyCheckId);
    const check = checks.get(entry.policyCheckId);
    const record = records.get(entry.validationRecordId);
    if (!check || !record || record.policyCheckId !== check.id) {
      throw new Error(`Manifest validator ${entry.policyCheckId} lacks an exact validation record.`);
    }
    if (
      entry.providerId !== check.verifierId ||
      entry.providerVersion !== check.verifierVersion ||
      entry.subjectHash !== result.patchHash ||
      entry.status !== record.status
    ) {
      throw new Error(`Manifest validator ${entry.policyCheckId} does not match policy/provider/patch evidence.`);
    }
    const expectedArtifactRefs = record.artifact === undefined ? [] : [{ id: record.artifact.id, contentHash: record.artifact.contentHash }];
    if (canonicalJson(entry.artifactRefs) !== canonicalJson(expectedArtifactRefs)) {
      throw new Error(`Manifest validator ${entry.policyCheckId} artifact references do not match its validation record.`);
    }
    return {
      ...canonicalProvider(entry, `Manifest validator ${entry.policyCheckId}`),
      policyCheckId: entry.policyCheckId,
      validationRecordId: entry.validationRecordId,
      subjectHash: requireSha256(entry.subjectHash, `Manifest validator ${entry.policyCheckId} subject hash`),
      status: entry.status,
      artifactRefs: canonicalArtifactRefs(entry.artifactRefs, `Manifest validator ${entry.policyCheckId}`),
    };
  }).sort((left, right) => left.policyCheckId.localeCompare(right.policyCheckId));
  const missing = result.validationPolicy.checks.filter((check) => check.required && !seen.has(check.id));
  if (missing.length > 0) {
    throw new Error(`Manifest lacks required verifier executions: ${missing.map((check) => check.id).join(', ')}.`);
  }
  return canonical;
}

function canonicalCheckpoint(
  checkpoint: NonNullable<MigrationRunManifestV2['checkpoint']>,
): NonNullable<MigrationRunManifestV2['checkpoint']> {
  return {
    id: requiredText(checkpoint.id, 'Migration checkpoint ID'),
    contentHash: requireSha256(checkpoint.contentHash, 'Migration checkpoint hash'),
    recoverable: checkpoint.recoverable,
    createdAt: requireTimestamp(checkpoint.createdAt, 'Migration checkpoint creation time'),
  };
}

function canonicalRecovery(
  recovery: NonNullable<MigrationRunManifestV2['recovery']>,
  checkpoint: NonNullable<MigrationRunManifestV2['checkpoint']>,
): NonNullable<MigrationRunManifestV2['recovery']> {
  if (
    recovery.status !== 'available' &&
    recovery.status !== 'completed' &&
    recovery.status !== 'failed' &&
    recovery.status !== 'not-required'
  ) {
    throw new Error('Migration recovery status is unsupported.');
  }
  if (recovery.checkpointId !== checkpoint.id) {
    throw new Error('Migration recovery record does not bind the exact checkpoint.');
  }
  if (recovery.status === 'failed' && !recovery.failureReason) {
    throw new Error('Failed migration recovery must provide a reason.');
  }
  return {
    status: recovery.status,
    checkpointId: checkpoint.id,
    provider: canonicalProvider(recovery.provider, 'Migration recovery'),
    artifactRefs: canonicalArtifactRefs(recovery.artifactRefs, 'Migration recovery'),
    updatedAt: requireTimestamp(recovery.updatedAt, 'Migration recovery update time'),
    ...(recovery.failureReason === undefined
      ? {}
      : { failureReason: requiredText(recovery.failureReason, 'Migration recovery failure reason') }),
  };
}

export interface MaterializeMigrationRunManifestV2Input {
  status: MigrationRunManifestV2['status'];
  request: AdaptationRequestV2;
  result: AdaptationResultV2;
  providers: MigrationRunManifestV2['providers'];
  validators: MigrationRunManifestV2['validators'];
  repairRounds?: MigrationRunManifestV2['repairRounds'];
  checkpoint?: MigrationRunManifestV2['checkpoint'];
  recovery?: MigrationRunManifestV2['recovery'];
  artifactPaths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export function materializeMigrationRunManifestV2(
  input: MaterializeMigrationRunManifestV2Input,
  context: MigrationExecutionV2ValidationContext,
): MigrationRunManifestV2 {
  validateAdaptationResultV2(input.result, input.request, context);
  const route = routeForRef(input.request.route, context.runtimeCapabilities);
  if (
    input.status !== 'planned' &&
    input.status !== 'approved' &&
    input.status !== 'executing' &&
    input.status !== 'completed' &&
    input.status !== 'failed' &&
    input.status !== 'rolled-back'
  ) {
    throw new Error('MigrationRunManifestV2 status is unsupported.');
  }
  const providers = canonicalProviderExecutions(input.providers, route);
  const validators = canonicalValidatorExecutions(input.validators, input.result);
  if (
    (input.status === 'approved' || input.status === 'executing' || input.status === 'completed') &&
    input.result.validation.some((record) => record.required && (record.status === 'fail' || record.status === 'unverified'))
  ) {
    throw new Error('MigrationRunManifestV2 cannot approve or execute a patch with blocked validation.');
  }
  const requiresCheckpoint = input.status === 'executing' ||
    input.status === 'completed' || input.status === 'failed' || input.status === 'rolled-back';
  if (requiresCheckpoint && (!input.checkpoint || !input.recovery)) {
    throw new Error('MigrationRunManifestV2 execution status requires checkpoint and recovery evidence.');
  }
  if ((input.checkpoint === undefined) !== (input.recovery === undefined)) {
    throw new Error('MigrationRunManifestV2 checkpoint and recovery must be supplied together.');
  }
  const checkpoint = input.checkpoint === undefined ? undefined : canonicalCheckpoint(input.checkpoint);
  const recovery = input.recovery === undefined
    ? undefined
    : canonicalRecovery(input.recovery, checkpoint!);
  if (input.status === 'rolled-back' && recovery?.status !== 'completed') {
    throw new Error('Rolled-back migration manifest requires completed recovery evidence.');
  }
  const resultRepairRounds = canonicalRepairRounds(
    input.result.repairRounds,
    input.result.patchHash,
    input.result.validationPolicy,
    input.request.route,
    route,
  );
  if (input.repairRounds !== undefined) {
    const manifestRepairRounds = canonicalRepairRounds(
      input.repairRounds,
      input.result.patchHash,
      input.result.validationPolicy,
      input.request.route,
      route,
    );
    if (canonicalJson(manifestRepairRounds) !== canonicalJson(resultRepairRounds)) {
      throw new Error('Migration manifest repair history must match its adaptation result.');
    }
  }
  const referencedArtifacts = [
    ...input.result.validation.flatMap((record) => record.artifact === undefined ? [] : [record.artifact]),
    ...resultRepairRounds.flatMap((round) => round.verifierArtifacts),
  ];
  const artifactHashes = new Map<string, string>();
  for (const artifact of referencedArtifacts) {
    if (!Object.hasOwn(input.artifactPaths, artifact.id) || input.artifactPaths[artifact.id] !== artifact.path) {
      throw new Error(`Manifest artifact path ${artifact.id} does not match its validation or repair artifact.`);
    }
    const previousHash = artifactHashes.get(artifact.id);
    if (previousHash !== undefined && previousHash !== artifact.contentHash) {
      throw new Error(`Manifest artifact ${artifact.id} has conflicting content hashes.`);
    }
    artifactHashes.set(artifact.id, artifact.contentHash);
  }
  const artifactPaths = Object.fromEntries(
    Object.entries(input.artifactPaths)
      .map(([key, value]) => [requiredText(key, 'Manifest artifact path key'), canonicalPath(value, 'Manifest artifact path')])
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
  );
  if (Object.keys(artifactPaths).length === 0) {
    throw new Error('MigrationRunManifestV2 requires durable artifact paths.');
  }
  return contentAddress('migration-run-manifest-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    status: input.status,
    route: input.request.route,
    executionLineage: input.request.executionLineage,
    request: { id: input.request.id, contentHash: input.request.contentHash },
    result: { id: input.result.id, contentHash: input.result.contentHash },
    target: { id: input.request.target.id, contentHash: input.request.target.contentHash },
    candidate: { id: input.request.candidate.id, contentHash: input.request.candidate.contentHash },
    sourceBundle: { id: input.request.sourceBundle.id, contentHash: input.request.sourceBundle.contentHash },
    targetContext: { id: input.request.targetContext.id, contentHash: input.request.targetContext.contentHash },
    validationPolicy: input.request.validationPolicy,
    providers,
    validators,
    patch: {
      patchHash: input.result.patchHash,
      subjectHash: input.result.patchSubjectHash,
      paths: input.result.files.map((file) => file.path).sort(),
      createdAt: input.result.createdAt,
    },
    repairRounds: resultRepairRounds,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(recovery === undefined ? {} : { recovery }),
    artifactPaths,
    createdAt: requireTimestamp(input.createdAt, 'Migration manifest creation time'),
    updatedAt: requireTimestamp(input.updatedAt, 'Migration manifest update time'),
  });
}

export function validateMigrationRunManifestV2(
  manifest: MigrationRunManifestV2,
  request: AdaptationRequestV2,
  result: AdaptationResultV2,
  context: MigrationExecutionV2ValidationContext,
): MigrationRunManifestV2 {
  if (manifest.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('MigrationRunManifestV2 schema is unsupported; legacy manifests are rejected.');
  }
  const { id, contentHash, route, executionLineage, request: requestRef, result: resultRef,
    target, candidate, sourceBundle, targetContext, validationPolicy, patch, ...input } = manifest;
  if (
    requestRef.id !== request.id || requestRef.contentHash !== request.contentHash ||
    resultRef.id !== result.id || resultRef.contentHash !== result.contentHash ||
    target.id !== request.target.id || target.contentHash !== request.target.contentHash ||
    candidate.id !== request.candidate.id || candidate.contentHash !== request.candidate.contentHash ||
    sourceBundle.id !== request.sourceBundle.id || sourceBundle.contentHash !== request.sourceBundle.contentHash ||
    targetContext.id !== request.targetContext.id || targetContext.contentHash !== request.targetContext.contentHash ||
    canonicalJson(route) !== canonicalJson(request.route) ||
    canonicalJson(executionLineage) !== canonicalJson(request.executionLineage) ||
    canonicalJson(validationPolicy) !== canonicalJson(request.validationPolicy) ||
    patch.patchHash !== result.patchHash || patch.subjectHash !== result.patchSubjectHash
  ) {
    throw new Error('MigrationRunManifestV2 artifact lineage is inconsistent.');
  }
  const rebuilt = materializeMigrationRunManifestV2({ request, result, ...input }, context);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(manifest)) {
    throw new Error('MigrationRunManifestV2 hash or canonical structure is invalid.');
  }
  return manifest;
}

export interface MaterializeLegacyMigrationExecutionCompatibilityRecordV2Input {
  legacyKind: LegacyMigrationExecutionCompatibilityRecordV2['legacyKind'];
  legacyArtifactHash: string;
  v2Artifact: LegacyMigrationExecutionCompatibilityRecordV2['v2Artifact'];
  bridgeProducer: LegacyMigrationExecutionCompatibilityRecordV2['bridgeProducer'];
  warnings: string[];
  createdAt: string;
}

export function materializeLegacyMigrationExecutionCompatibilityRecordV2(
  input: MaterializeLegacyMigrationExecutionCompatibilityRecordV2Input,
): LegacyMigrationExecutionCompatibilityRecordV2 {
  const allowedKinds = new Set<LegacyMigrationExecutionCompatibilityRecordV2['legacyKind']>([
    'search-request',
    'search-candidate',
    'adaptation-request',
    'adaptation-result',
    'run-manifest',
  ]);
  if (!allowedKinds.has(input.legacyKind)) throw new Error('Legacy compatibility kind is unsupported.');
  if (input.bridgeProducer.kind !== 'import') {
    throw new Error('Legacy compatibility records require an explicit import bridge producer.');
  }
  const warnings = canonicalTextList(input.warnings, 'Legacy compatibility warning');
  if (warnings.length === 0) throw new Error('Legacy compatibility record must explain its lossy boundary.');
  const bridgeProducer = {
    kind: input.bridgeProducer.kind,
    id: requiredText(input.bridgeProducer.id, 'Legacy bridge producer ID'),
    ...(input.bridgeProducer.version === undefined
      ? {}
      : { version: requiredText(input.bridgeProducer.version, 'Legacy bridge producer version') }),
    ...(input.bridgeProducer.configurationHash === undefined
      ? {}
      : { configurationHash: requireSha256(input.bridgeProducer.configurationHash, 'Legacy bridge configuration hash') }),
  };
  return contentAddress('legacy-migration-execution-compatibility-v2', {
    schemaVersion: migrationExecutionV2SchemaVersion,
    legacyKind: input.legacyKind,
    legacyArtifactHash: requireSha256(input.legacyArtifactHash, 'Legacy artifact hash'),
    v2Artifact: {
      id: requiredText(input.v2Artifact.id, 'V2 artifact ID'),
      contentHash: requireSha256(input.v2Artifact.contentHash, 'V2 artifact hash'),
    },
    bridgeProducer,
    warnings,
    createdAt: requireTimestamp(input.createdAt, 'Legacy compatibility creation time'),
  });
}

export function validateLegacyMigrationExecutionCompatibilityRecordV2(
  record: LegacyMigrationExecutionCompatibilityRecordV2,
): LegacyMigrationExecutionCompatibilityRecordV2 {
  if (record.schemaVersion !== migrationExecutionV2SchemaVersion) {
    throw new Error('Legacy compatibility record schema is unsupported.');
  }
  const { id, contentHash, ...input } = record;
  const rebuilt = materializeLegacyMigrationExecutionCompatibilityRecordV2(input);
  if (rebuilt.id !== id || rebuilt.contentHash !== contentHash || canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error('Legacy compatibility record hash or canonical structure is invalid.');
  }
  return record;
}
