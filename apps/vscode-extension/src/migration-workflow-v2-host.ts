import type {
  AdaptationRequestV2,
  AdaptationResultV2,
  IndexedImplementationDocumentV2,
  MigrationRunManifestV2,
  MigrationRuntimeCapabilitySnapshot,
  MigrationTargetRef,
  SearchCandidateV2,
  SearchRequestV2,
  SourceImplementationBundleV2,
  TargetContextSnapshotV2,
} from '@forexplore/contracts';
import { migrationExecutionV2SchemaVersion } from '@forexplore/contracts';
import type { CodeAdaptationPortV2 } from '@forexplore/adaptation-http-adapter';
import {
  calculatePatchSubjectHashV2,
  materializeAdaptationRequestV2,
  materializeSearchRequestV2,
  validateAdaptationResultV2,
  validateIndexedImplementationDocumentV2,
  validateMigrationRuntimeCapabilitySnapshot,
  validateMigrationTargetRefV2,
  validateSearchCandidateV2,
  validateSourceImplementationBundleV2,
  type MigrationExecutionV2ValidationContext,
  type SearchPortV2,
  type SourceBundleResolverPortV2,
} from '@forexplore/workflow-core';
import type {
  ModuleMappingRunBinding,
  TargetWorkspaceMigrationSelection,
} from './protocol/messages';

export interface ActiveMigrationRunV2 {
  target: MigrationTargetRef;
  migrationSelection: TargetWorkspaceMigrationSelection;
  runtimeCapabilitySnapshotId: string;
  runtimeCapabilitySnapshotHash: string;
  requirement: string;
  searchRequest: SearchRequestV2 | null;
  candidates: SearchCandidateV2[];
  selectedCandidateId: string | null;
  indexedDocument: IndexedImplementationDocumentV2 | null;
  sourceBundle: SourceImplementationBundleV2 | null;
  targetContext: TargetContextSnapshotV2 | null;
  adaptationRequest: AdaptationRequestV2 | null;
  adaptation: AdaptationResultV2 | null;
  manifest: MigrationRunManifestV2 | null;
}

export interface StartSearchV2Input {
  requirement: string;
  topK: number;
  rerank?: boolean;
  createdAt?: string;
}

export function createActiveMigrationRunV2(
  migrationSelection: TargetWorkspaceMigrationSelection,
): ActiveMigrationRunV2 {
  const runtime = validateMigrationRuntimeCapabilitySnapshot(
    migrationSelection.moduleMapping.runtimeCapabilitySnapshot,
  );
  validateMigrationTargetRefV2(migrationSelection.target, runtime);
  assertRunBindingMatchesTarget(migrationSelection.moduleMapping, migrationSelection.target);
  return {
    target: migrationSelection.target,
    migrationSelection,
    runtimeCapabilitySnapshotId: runtime.id,
    runtimeCapabilitySnapshotHash: runtime.contentHash,
    requirement: '',
    searchRequest: null,
    candidates: [],
    selectedCandidateId: null,
    indexedDocument: null,
    sourceBundle: null,
    targetContext: null,
    adaptationRequest: null,
    adaptation: null,
    manifest: null,
  };
}

export async function startSearchV2(
  run: ActiveMigrationRunV2,
  port: SearchPortV2,
  input: StartSearchV2Input,
): Promise<SearchCandidateV2[]> {
  const runtime = currentRunRuntime(run);
  const route = exactRunRoute(run, runtime);
  const requirement = input.requirement.trim() || [
    run.target.entity.name,
    run.target.entity.qualifiedName,
    run.target.entity.signature,
    run.target.entity.kind,
  ].filter(Boolean).join(' ');
  if (!requirement.trim()) throw new Error('V2 search requires a non-empty target-derived requirement.');
  const request = materializeSearchRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    target: run.target,
    route: run.target.route,
    requirement,
    topK: input.topK,
    repositoryScopes: [run.migrationSelection.moduleMapping.sourceCatalog.repositoryId],
    candidateLanguageIds: [route.sourceLanguageId],
    rerank: input.rerank ?? false,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }, runtime);
  const candidates = await port.search(request);
  for (const candidate of candidates) {
    assertCandidateRequestAndCatalog(candidate, request, run.migrationSelection.moduleMapping);
  }
  run.requirement = requirement;
  run.searchRequest = request;
  run.candidates = [...candidates];
  // Ranking is never consent. Starting any search clears all downstream state.
  run.selectedCandidateId = null;
  run.indexedDocument = null;
  run.sourceBundle = null;
  run.targetContext = null;
  run.adaptationRequest = null;
  run.adaptation = null;
  run.manifest = null;
  return run.candidates;
}

export async function selectCandidateV2(
  run: ActiveMigrationRunV2,
  candidateId: string,
  resolver: SourceBundleResolverPortV2,
  context: MigrationExecutionV2ValidationContext,
): Promise<SourceImplementationBundleV2> {
  assertRunContextCurrent(run, context);
  const request = run.searchRequest;
  if (!request) throw new Error('No current V2 search request exists.');
  const candidate = run.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error('The candidate is not part of the current V2 search result.');
  assertCandidateRequestAndCatalog(candidate, request, run.migrationSelection.moduleMapping);
  const resolved = await resolver.resolveSourceBundle({ request, candidate });
  validateIndexedImplementationDocumentV2(resolved.indexedDocument);
  validateSearchCandidateV2(candidate, request, resolved.indexedDocument, context.runtimeCapabilities);
  validateSourceImplementationBundleV2(resolved.bundle);
  assertResolvedSourceLineage(run, candidate, resolved.indexedDocument, resolved.bundle, context);
  // Set consent only after the authoritative full bundle and active generation
  // have been resolved and revalidated.
  run.selectedCandidateId = candidate.id;
  run.indexedDocument = resolved.indexedDocument;
  run.sourceBundle = resolved.bundle;
  run.targetContext = null;
  run.adaptationRequest = null;
  run.adaptation = null;
  run.manifest = null;
  return resolved.bundle;
}

export async function adaptRunV2(
  run: ActiveMigrationRunV2,
  targetContext: TargetContextSnapshotV2,
  executionContext: MigrationExecutionV2ValidationContext,
  port: CodeAdaptationPortV2,
  decisionNotes: string[],
  createdAt?: string,
): Promise<AdaptationResultV2> {
  assertRunContextCurrent(run, executionContext);
  const candidate = selectedCandidateV2(run);
  const sourceBundle = run.sourceBundle;
  if (!sourceBundle) throw new Error('The selected candidate has no authoritative V2 source bundle.');
  const route = exactRunRoute(run, executionContext.runtimeCapabilities);
  const binding = run.migrationSelection.moduleMapping;
  const request = materializeAdaptationRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    route: binding.route,
    executionLineage: {
      sourceCatalog: { ...binding.sourceCatalog },
      targetCatalog: { ...binding.targetCatalog },
      mappingProposalId: binding.mappingProposalId,
      mappingProposalHash: binding.mappingProposalHash,
      mappingReviewId: binding.mappingReviewId,
      mappingReviewHash: binding.mappingReviewHash,
      executionOverlayId: binding.executionOverlayId,
      executionOverlayHash: binding.executionOverlayHash,
    },
    target: run.target,
    candidate: candidate.candidate,
    sourceBundle,
    targetContext,
    patchSubjectHash: calculatePatchSubjectHashV2(targetContext),
    validationPolicy: route.validationPolicy,
    requirement: run.requirement,
    strategy: route.strategy,
    decisionNotes,
    createdAt: createdAt ?? new Date().toISOString(),
  }, executionContext);
  const result = await port.adapt(request, executionContext);
  validateAdaptationResultV2(result, request, executionContext);
  run.targetContext = targetContext;
  run.adaptationRequest = request;
  run.adaptation = result;
  run.manifest = null;
  return result;
}

export function selectedCandidateV2(run: ActiveMigrationRunV2): SearchCandidateV2 {
  if (!run.selectedCandidateId) throw new Error('请先明确点击并选择一个候选实现。');
  const candidate = run.candidates.find((item) => item.id === run.selectedCandidateId);
  if (!candidate) throw new Error('当前候选已失效；请重新检索并明确选择。');
  return candidate;
}

export function assertRunContextCurrent(
  run: ActiveMigrationRunV2,
  context: MigrationExecutionV2ValidationContext,
): void {
  const runtime = validateMigrationRuntimeCapabilitySnapshot(context.runtimeCapabilities);
  if (
    runtime.id !== run.runtimeCapabilitySnapshotId ||
    runtime.contentHash !== run.runtimeCapabilitySnapshotHash ||
    JSON.stringify(runtime) !== JSON.stringify(run.migrationSelection.moduleMapping.runtimeCapabilitySnapshot)
  ) {
    throw new Error('The active V2 run runtime capability snapshot is stale.');
  }
  const binding = run.migrationSelection.moduleMapping;
  if (
    context.currentSourceCatalog.moduleCatalogId !== binding.sourceCatalog.moduleCatalogId ||
    context.currentSourceCatalog.moduleCatalogHash !== binding.sourceCatalog.moduleCatalogHash ||
    context.currentTargetCatalog.moduleCatalogId !== binding.targetCatalog.moduleCatalogId ||
    context.currentTargetCatalog.moduleCatalogHash !== binding.targetCatalog.moduleCatalogHash ||
    context.mappingProposal.id !== binding.mappingProposalId ||
    context.mappingProposal.contentHash !== binding.mappingProposalHash ||
    context.mappingReview.id !== binding.mappingReviewId ||
    context.mappingReview.contentHash !== binding.mappingReviewHash ||
    context.executionOverlay.id !== binding.executionOverlayId ||
    context.executionOverlay.contentHash !== binding.executionOverlayHash
  ) {
    throw new Error('The active V2 run catalog/mapping/review/overlay lineage is stale.');
  }
  validateMigrationTargetRefV2(run.target, runtime);
}

function currentRunRuntime(run: ActiveMigrationRunV2): MigrationRuntimeCapabilitySnapshot {
  const runtime = validateMigrationRuntimeCapabilitySnapshot(
    run.migrationSelection.moduleMapping.runtimeCapabilitySnapshot,
  );
  if (
    runtime.id !== run.runtimeCapabilitySnapshotId ||
    runtime.contentHash !== run.runtimeCapabilitySnapshotHash
  ) {
    throw new Error('The active V2 run runtime capability snapshot is stale.');
  }
  return runtime;
}

function exactRunRoute(
  run: ActiveMigrationRunV2,
  runtime: MigrationRuntimeCapabilitySnapshot,
) {
  const ref = run.migrationSelection.moduleMapping.route;
  const route = runtime.routes.find((candidate) =>
    candidate.id === ref.routeId &&
    candidate.version === ref.routeVersion &&
    candidate.contentHash === ref.routeContentHash,
  );
  if (!route || route.availability.status === 'unavailable') {
    throw new Error('The active V2 run has no executable exact migration route.');
  }
  if (
    route.sourceLanguageId !== ref.sourceLanguageId ||
    route.targetLanguageId !== ref.targetLanguageId ||
    route.strategy !== ref.strategy ||
    route.validationPolicy.id !== ref.validationPolicyId ||
    route.validationPolicy.contentHash !== ref.validationPolicyHash
  ) {
    throw new Error('The active V2 route/policy lineage is inconsistent.');
  }
  return route;
}

function assertCandidateRequestAndCatalog(
  candidate: SearchCandidateV2,
  request: SearchRequestV2,
  binding: ModuleMappingRunBinding,
): void {
  if (
    candidate.schemaVersion !== migrationExecutionV2SchemaVersion ||
    candidate.requestId !== request.id ||
    candidate.requestHash !== request.contentHash ||
    candidate.targetId !== request.target.id ||
    candidate.targetHash !== request.target.contentHash ||
    JSON.stringify(candidate.route) !== JSON.stringify(request.route) ||
    candidate.candidate.entity.languageId !== request.route.sourceLanguageId ||
    candidate.indexGeneration.repositoryId !== binding.sourceCatalog.repositoryId ||
    candidate.indexGeneration.sourceCatalogId !== binding.sourceCatalog.moduleCatalogId ||
    candidate.indexGeneration.sourceCatalogHash !== binding.sourceCatalog.moduleCatalogHash ||
    !candidate.indexGeneration.id ||
    candidate.indexGeneration.generation < 1 ||
    !isSha256(candidate.indexGeneration.contentHash)
  ) {
    throw new Error('Search candidate does not bind the active request/route/index/catalog lineage.');
  }
}

function assertResolvedSourceLineage(
  run: ActiveMigrationRunV2,
  searchCandidate: SearchCandidateV2,
  indexedDocument: IndexedImplementationDocumentV2,
  bundle: SourceImplementationBundleV2,
  context: MigrationExecutionV2ValidationContext,
): void {
  const source = run.migrationSelection.moduleMapping.sourceCatalog;
  const reviewedLineage = {
    repositoryId: source.repositoryId,
    ...(source.repositoryRevision === undefined ? {} : { repositoryRevision: source.repositoryRevision }),
    repositoryContentHash: source.repositoryContentHash,
    unifiedRepositoryIrId: source.unifiedRepositoryIrId,
    unifiedRepositoryIrHash: source.unifiedRepositoryIrHash,
    moduleCatalogId: source.moduleCatalogId,
    moduleCatalogHash: source.moduleCatalogHash,
    moduleReviewId: source.moduleReviewId,
    moduleReviewHash: source.moduleReviewHash,
  };
  const targetEntityId = run.target.entity.entityId;
  const coveringGroups = context.executionOverlay.groups.filter((group) =>
    group.targetEntityIds.includes(targetEntityId) ||
    (group.targetEntityIds.length === 0 &&
      group.targetModuleIds.some((id) => run.migrationSelection.moduleMapping.targetModuleIds.includes(id))),
  );
  if (
    JSON.stringify(indexedDocument.sourceCatalog) !== JSON.stringify(source) ||
    JSON.stringify(searchCandidate.candidate.lineage) !== JSON.stringify(reviewedLineage) ||
    JSON.stringify(bundle.lineage) !== JSON.stringify(reviewedLineage) ||
    bundle.id !== searchCandidate.sourceBundle.id ||
    bundle.contentHash !== searchCandidate.sourceBundle.contentHash ||
    bundle.candidate.id !== searchCandidate.candidate.id ||
    bundle.candidate.contentHash !== searchCandidate.candidate.contentHash ||
    !coveringGroups.some((group) =>
      group.sourceEntityIds.includes(searchCandidate.candidate.entity.entityId) &&
      group.sourceModuleIds.includes(indexedDocument.moduleId),
    )
  ) {
    throw new Error('Resolved source bundle is outside the reviewed source catalog/mapping lineage.');
  }
}

function assertRunBindingMatchesTarget(
  binding: ModuleMappingRunBinding,
  target: MigrationTargetRef,
): void {
  if (
    JSON.stringify(binding.route) !== JSON.stringify(target.route) ||
    binding.targetCatalog.repositoryId !== target.lineage.repositoryId ||
    binding.targetCatalog.moduleCatalogId !== target.lineage.moduleCatalogId ||
    binding.targetCatalog.moduleCatalogHash !== target.lineage.moduleCatalogHash ||
    binding.targetCatalog.moduleReviewId !== target.lineage.moduleReviewId ||
    binding.targetCatalog.moduleReviewHash !== target.lineage.moduleReviewHash ||
    (binding.targetEntityIds.length > 0 && !binding.targetEntityIds.includes(target.entity.entityId))
  ) {
    throw new Error('The V2 target does not bind the reviewed module mapping and exact route.');
  }
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}
