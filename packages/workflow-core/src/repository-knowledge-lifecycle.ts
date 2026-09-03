import type {
  ActivateRepositoryKnowledgePublicationResult,
  RepositoryArtifactProducer,
  RepositoryImportBatch,
  RepositoryImportBatchItem,
  RepositoryImportBatchItemStatus,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionJsonValue,
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleEvidenceItem,
  RepositoryModuleEvidenceOmission,
  RepositoryModuleIndexReceipt,
  RepositoryModuleIndexReceiptStatus,
  RepositoryModuleKnowledgePage,
  RepositoryModuleKnowledgeReview,
  RepositoryModuleKnowledgeReviewDecision,
  RepositoryModuleSummaryGeneration,
  RepositoryModuleSummaryRevisionContext,
  RepositoryModuleWikiDraft,
  RepositoryModuleWikiEvidenceBinding,
  RepositoryModuleWikiProposal,
  RepositoryModuleWikiRevisionLineage,
  RepositoryModuleWikiSection,
  RepositoryModuleBundle,
  SerializedRepositoryKnowledgeArtifact,
  UnifiedRepositoryIR,
  RepositoryModuleCatalog,
  WithdrawRepositoryKnowledgePublicationResult,
} from '@forexplore/contracts';
import {
  repositoryIngestionSchemaVersion,
  repositoryKnowledgePublicationSchemaVersion,
  repositoryModuleSummaryJsonSchemaId,
  repositoryModuleSummarySchemaVersion,
} from '@forexplore/contracts';
import { canonicalJson, sha256Hex, sortedUnique } from './module-plan-utils';
import {
  materializeRepositoryModuleKnowledgePage,
  repositoryModuleKnowledgeJsonSchemaPath,
  validateRepositoryModuleKnowledgePage,
} from './repository-knowledge';

const sha256Pattern = /^[0-9a-f]{64}$/;
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface MaterializeRepositoryModuleEvidenceBundleInput {
  repositoryModuleBundle: RepositoryModuleBundle;
  moduleId: string;
  items: RepositoryModuleEvidenceItem[];
  omissions?: RepositoryModuleEvidenceOmission[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export interface MaterializeRepositoryModuleWikiProposalInput {
  evidenceBundle: RepositoryModuleEvidenceBundle;
  narrative: RepositoryModuleWikiDraft;
  evidenceBindings: RepositoryModuleWikiEvidenceBinding[];
  generation: RepositoryModuleSummaryGeneration;
  /** Both artifacts are required together when generating a successor proposal. */
  previousProposal?: RepositoryModuleWikiProposal;
  reviseReview?: RepositoryModuleKnowledgeReview;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export interface MaterializeRepositoryModuleKnowledgeReviewInput {
  decision: RepositoryModuleKnowledgeReviewDecision;
  reviewerId: string;
  comment?: string;
  reviewedAt: string;
}

export interface MaterializeReviewedRepositoryModuleKnowledgePageInput {
  catalog: RepositoryModuleCatalog;
  ir: UnifiedRepositoryIR;
  evidenceBundle: RepositoryModuleEvidenceBundle;
  wikiProposal: RepositoryModuleWikiProposal;
  knowledgeReview: RepositoryModuleKnowledgeReview;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export interface StageRepositoryKnowledgePublicationInput {
  scope: RepositoryKnowledgePublicationScope;
  repositoryScopes: string[];
  generation: number;
  repositoryModuleBundle: RepositoryModuleBundle;
  knowledgePages: RepositoryModuleKnowledgePage[];
  evidenceBundles: RepositoryModuleEvidenceBundle[];
  wikiProposals: RepositoryModuleWikiProposal[];
  knowledgeReviews: RepositoryModuleKnowledgeReview[];
  artifacts: RepositoryIngestionArtifactRef[];
  previousPublicationId?: string;
  producer: RepositoryArtifactProducer;
  stagedAt: string;
}

export interface MaterializeRepositoryModuleIndexReceiptInput {
  publication: RepositoryKnowledgePublication;
  status: 'staged' | 'validated';
  storeId: string;
  documentCount: number;
  moduleIds: string[];
  indexArtifactHash: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ActivateRepositoryKnowledgePublicationInput {
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  currentHead?: RepositoryKnowledgePublicationHead;
  expectedHeadHash?: string;
  activatedAt: string;
}

export interface WithdrawRepositoryKnowledgePublicationInput {
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  currentHead: RepositoryKnowledgePublicationHead;
  expectedHeadHash: string;
  withdrawnAt: string;
  restorePublication?: RepositoryKnowledgePublication;
}

export interface CreateRepositoryImportBatchInput {
  id: string;
  items: RepositoryImportBatchItem[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

/** Build the immutable, host-owned context that is the only Summary-Agent input. */
export function materializeRepositoryModuleEvidenceBundle(
  input: MaterializeRepositoryModuleEvidenceBundleInput,
): RepositoryModuleEvidenceBundle {
  validateRepositoryModuleBundleEnvelope(input.repositoryModuleBundle);
  if (input.producer.kind !== 'ingestion-host') {
    throw new Error('Repository module evidence bundles must be assembled by the ingestion host.');
  }
  assertTimestamp(input.createdAt, 'Repository module evidence bundle creation time');
  if (Date.parse(input.createdAt) < Date.parse(input.repositoryModuleBundle.createdAt)) {
    throw new Error('Repository module evidence bundle cannot precede its repository module bundle.');
  }
  const module = input.repositoryModuleBundle.modules.find((item) => item.id === input.moduleId);
  if (!module) throw new Error(`Unknown repository module for evidence bundle: ${input.moduleId}`);

  const moduleFileIds = new Set(module.fileIds);
  const moduleEntityIds = new Set(module.entityIds);
  const filesById = new Map(input.repositoryModuleBundle.files.map((file) => [file.id, file]));
  const moduleProjectIds = new Set(module.fileIds.flatMap((fileId) =>
    filesById.get(fileId)?.projectIds ?? [],
  ));
  const relatedIrDependencies = input.repositoryModuleBundle.irDependencies.filter((dependency) =>
    moduleFileIds.has(dependency.sourceFileId) ||
    (dependency.targetFileId !== undefined && moduleFileIds.has(dependency.targetFileId)) ||
    (dependency.sourceEntityId !== undefined && moduleEntityIds.has(dependency.sourceEntityId)) ||
    (dependency.targetEntityId !== undefined && moduleEntityIds.has(dependency.targetEntityId)),
  );
  const relatedModuleDependencies = input.repositoryModuleBundle.moduleDependencies.filter(
    (dependency) => dependency.sourceModuleId === module.id || dependency.targetModuleId === module.id,
  );
  const apiSurfaces = input.repositoryModuleBundle.apiSurfaces.filter((surface) =>
    moduleEntityIds.has(surface.entityId),
  );
  const dependencyFileIds = relatedIrDependencies.flatMap((dependency) => [
    dependency.sourceFileId,
    ...(dependency.targetFileId === undefined ? [] : [dependency.targetFileId]),
  ]);
  const projectContextFileIds = input.repositoryModuleBundle.files
    .filter((file) =>
      (file.role === 'documentation' || file.role === 'configuration') &&
      file.projectIds.some((projectId) => moduleProjectIds.has(projectId)),
    )
    .map((file) => file.id);
  const authorizedFileIds = sortedUnique([
    ...module.fileIds,
    ...dependencyFileIds,
    ...projectContextFileIds,
  ]);
  const evidenceIds = sortedUnique([
    ...module.evidenceRefs.map((ref) => ref.id),
    ...relatedIrDependencies.flatMap((dependency) => [
      dependency.id,
      ...dependency.evidenceRefs.map((ref) => ref.id),
    ]),
    ...relatedModuleDependencies.flatMap((dependency) =>
      dependency.evidenceRefs.map((ref) => ref.id),
    ),
    ...apiSurfaces.flatMap((surface) => [
      surface.id,
      surface.entityId,
      ...surface.evidenceRefs.map((ref) => ref.id),
    ]),
    ...authorizedFileIds,
    ...module.entityIds,
  ]);
  const evidenceSet = new Set(evidenceIds);
  const authorizedPaths = new Set(authorizedFileIds.flatMap((fileId) => {
    const file = filesById.get(fileId);
    return file === undefined ? [] : [file.path];
  }));
  const itemIds = new Set<string>();
  const items = input.items.map((item) => {
    const canonical = canonicalEvidenceItem(item);
    if (itemIds.has(canonical.id)) throw new Error(`Duplicate repository evidence item: ${canonical.id}`);
    itemIds.add(canonical.id);
    for (const evidenceId of canonical.evidenceRefIds) {
      if (!evidenceSet.has(evidenceId)) {
        throw new Error(`Repository evidence item cites evidence outside the module scope: ${evidenceId}`);
      }
    }
    if (canonical.path !== undefined && !authorizedPaths.has(canonical.path)) {
      throw new Error(`Repository evidence item path is outside the authorized module context: ${canonical.path}`);
    }
    if (canonical.range !== undefined && !authorizedPaths.has(canonical.range.path)) {
      throw new Error(`Repository evidence item range is outside the authorized module context: ${canonical.range.path}`);
    }
    return canonical;
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (items.length === 0) {
    throw new Error('Repository module evidence bundle requires at least one bounded evidence item.');
  }
  const omissions = (input.omissions ?? []).map(canonicalOmission)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId));
  assertUniqueBy(omissions, (item) => `${item.kind}:${item.sourceId}`, 'Repository evidence omission');

  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: input.repositoryModuleBundle.repositoryId,
    moduleId: module.id,
    ...(input.repositoryModuleBundle.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: input.repositoryModuleBundle.repositoryRevision }),
    repositoryContentHash: input.repositoryModuleBundle.repositoryContentHash,
    source: {
      repositoryModuleBundleId: input.repositoryModuleBundle.id,
      repositoryModuleBundleHash: input.repositoryModuleBundle.contentHash,
      unifiedRepositoryIrId: input.repositoryModuleBundle.source.unifiedRepositoryIrId,
      unifiedRepositoryIrHash: input.repositoryModuleBundle.source.unifiedRepositoryIrHash,
      moduleCatalogId: input.repositoryModuleBundle.source.moduleCatalogId,
      moduleCatalogHash: input.repositoryModuleBundle.source.moduleCatalogHash,
      moduleReviewId: input.repositoryModuleBundle.source.moduleReviewId,
      moduleReviewHash: input.repositoryModuleBundle.source.moduleReviewHash,
    },
    scope: {
      fileIds: authorizedFileIds,
      entityIds: sortedUnique(module.entityIds),
      dependencyIds: sortedUnique(relatedIrDependencies.map((dependency) => dependency.id)),
      apiSurfaceIds: sortedUnique(apiSurfaces.map((surface) => surface.id)),
      evidenceIds,
    },
    items,
    omissions,
    producer: canonicalProducer(input.producer),
    createdAt: input.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-evidence:${module.id}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function validateRepositoryModuleEvidenceBundle(
  bundle: RepositoryModuleEvidenceBundle,
  repositoryModuleBundle: RepositoryModuleBundle,
): void {
  const expected = materializeRepositoryModuleEvidenceBundle({
    repositoryModuleBundle,
    moduleId: bundle.moduleId,
    items: bundle.items,
    omissions: bundle.omissions,
    producer: bundle.producer,
    createdAt: bundle.createdAt,
  });
  if (canonicalJson(bundle) !== canonicalJson(expected)) {
    throw new Error('Repository module evidence bundle does not match its immutable source closure.');
  }
}

/** Materialize an Agent proposal only after validating claim-level evidence bindings. */
export function materializeRepositoryModuleWikiProposal(
  input: MaterializeRepositoryModuleWikiProposalInput,
): RepositoryModuleWikiProposal {
  validateEvidenceBundleEnvelope(input.evidenceBundle);
  if (input.producer.kind !== 'module-summary-agent') {
    throw new Error('Repository Wiki proposals must be produced by the module Summary Agent.');
  }
  assertTimestamp(input.createdAt, 'Repository Wiki proposal creation time');
  if (Date.parse(input.createdAt) < Date.parse(input.evidenceBundle.createdAt)) {
    throw new Error('Repository Wiki proposal cannot precede its evidence bundle.');
  }
  const narrative = canonicalWiki(input.narrative);
  const bindings = canonicalEvidenceBindings(input.evidenceBindings);
  validateClaimEvidenceClosure(narrative, bindings, input.evidenceBundle);
  const generation = canonicalGeneration(input.generation);
  const revision = materializeWikiRevisionLineage(
    input.evidenceBundle,
    input.previousProposal,
    input.reviseReview,
    input.createdAt,
  );
  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    summarySchemaVersion: repositoryModuleSummarySchemaVersion,
    repositoryId: input.evidenceBundle.repositoryId,
    moduleId: input.evidenceBundle.moduleId,
    evidenceBundleId: input.evidenceBundle.id,
    evidenceBundleHash: input.evidenceBundle.contentHash,
    narrative,
    evidenceBindings: bindings,
    ...(revision === undefined ? {} : { revision }),
    generation,
    producer: canonicalProducer(input.producer),
    createdAt: input.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-wiki-proposal:${input.evidenceBundle.moduleId}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function validateRepositoryModuleWikiProposal(
  proposal: RepositoryModuleWikiProposal,
  evidenceBundle: RepositoryModuleEvidenceBundle,
  revisionContext?: RepositoryModuleSummaryRevisionContext,
): void {
  if (revisionContext !== undefined || proposal.revision === undefined) {
    const expected = materializeRepositoryModuleWikiProposal({
      evidenceBundle,
      narrative: proposal.narrative,
      evidenceBindings: proposal.evidenceBindings,
      generation: proposal.generation,
      ...(revisionContext === undefined
        ? {}
        : {
            previousProposal: revisionContext.previousProposal,
            reviseReview: revisionContext.reviseReview,
          }),
      producer: proposal.producer,
      createdAt: proposal.createdAt,
    });
    if (canonicalJson(proposal) !== canonicalJson(expected)) {
      throw new Error('Repository Wiki proposal does not match its evidence bundle or content hash.');
    }
    return;
  }

  // Persisted successor proposals remain independently content-addressable.
  // Callers at the generation boundary must additionally supply the full
  // revision context above to prove the predecessor/review closure.
  validateEvidenceBundleEnvelope(evidenceBundle);
  if (proposal.producer.kind !== 'module-summary-agent') {
    throw new Error('Repository Wiki proposals must be produced by the module Summary Agent.');
  }
  assertTimestamp(proposal.createdAt, 'Repository Wiki proposal creation time');
  if (Date.parse(proposal.createdAt) < Date.parse(evidenceBundle.createdAt)) {
    throw new Error('Repository Wiki proposal cannot precede its evidence bundle.');
  }
  const narrative = canonicalWiki(proposal.narrative);
  const bindings = canonicalEvidenceBindings(proposal.evidenceBindings);
  validateClaimEvidenceClosure(narrative, bindings, evidenceBundle);
  const revision = canonicalWikiRevisionLineage(proposal.revision);
  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    summarySchemaVersion: repositoryModuleSummarySchemaVersion,
    repositoryId: evidenceBundle.repositoryId,
    moduleId: evidenceBundle.moduleId,
    evidenceBundleId: evidenceBundle.id,
    evidenceBundleHash: evidenceBundle.contentHash,
    narrative,
    evidenceBindings: bindings,
    revision,
    generation: canonicalGeneration(proposal.generation),
    producer: canonicalProducer(proposal.producer),
    createdAt: proposal.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  const expected = {
    ...payload,
    id: `repository-module-wiki-proposal:${evidenceBundle.moduleId}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
  if (canonicalJson(proposal) !== canonicalJson(expected)) {
    throw new Error('Repository Wiki proposal does not match its evidence bundle or content hash.');
  }
}

/** Validate a successor request before exposing the signed human revision to an Agent. */
export function validateRepositoryModuleSummaryRevisionContext(
  evidenceBundle: RepositoryModuleEvidenceBundle,
  context: RepositoryModuleSummaryRevisionContext,
): void {
  materializeWikiRevisionLineage(
    evidenceBundle,
    context.previousProposal,
    context.reviseReview,
    context.reviseReview.reviewedAt,
  );
}

export function materializeRepositoryModuleKnowledgeReview(
  proposal: RepositoryModuleWikiProposal,
  evidenceBundle: RepositoryModuleEvidenceBundle,
  input: MaterializeRepositoryModuleKnowledgeReviewInput,
): RepositoryModuleKnowledgeReview {
  validateRepositoryModuleWikiProposal(proposal, evidenceBundle);
  assertTimestamp(input.reviewedAt, 'Repository knowledge review time');
  if (Date.parse(input.reviewedAt) < Date.parse(proposal.createdAt)) {
    throw new Error('Repository knowledge review cannot precede its Wiki proposal.');
  }
  assertKnowledgeReviewDecision(input.decision);
  const comment = input.comment === undefined ? undefined : normalizeText(input.comment);
  if (input.decision === 'revise' && !comment?.trim()) {
    throw new Error('A revise repository knowledge review requires a non-empty actionable comment.');
  }
  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: proposal.repositoryId,
    moduleId: proposal.moduleId,
    evidenceBundleId: evidenceBundle.id,
    evidenceBundleHash: evidenceBundle.contentHash,
    wikiProposalId: proposal.id,
    wikiProposalHash: proposal.contentHash,
    decision: input.decision,
    reviewerId: normalizeRequired(input.reviewerId, 'Repository knowledge reviewer ID'),
    ...(comment === undefined ? {} : { comment }),
    replacementProposalRequired: input.decision === 'revise',
    reviewedAt: input.reviewedAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-knowledge-review:${proposal.moduleId}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function validateRepositoryModuleKnowledgeReview(
  review: RepositoryModuleKnowledgeReview,
  proposal: RepositoryModuleWikiProposal,
  evidenceBundle: RepositoryModuleEvidenceBundle,
): void {
  const expected = materializeRepositoryModuleKnowledgeReview(proposal, evidenceBundle, {
    decision: review.decision,
    reviewerId: review.reviewerId,
    ...(review.comment === undefined ? {} : { comment: review.comment }),
    reviewedAt: review.reviewedAt,
  });
  if (canonicalJson(review) !== canonicalJson(expected)) {
    throw new Error('Repository knowledge review does not match its Wiki proposal or content hash.');
  }
}

/** Publish reviewed prose without rewriting the host-derived `raw` facts. */
export function materializeReviewedRepositoryModuleKnowledgePage(
  input: MaterializeReviewedRepositoryModuleKnowledgePageInput,
): RepositoryModuleKnowledgePage {
  validateRepositoryModuleWikiProposal(input.wikiProposal, input.evidenceBundle);
  validateRepositoryModuleKnowledgeReview(
    input.knowledgeReview,
    input.wikiProposal,
    input.evidenceBundle,
  );
  if (input.knowledgeReview.decision !== 'accept') {
    throw new Error('A reviewed repository knowledge page requires an accepted summary review.');
  }
  if (input.catalog.status !== 'active') {
    throw new Error('A reviewed repository knowledge page requires a boundary-reviewed active catalog.');
  }
  if (input.producer.kind !== 'knowledge-publisher') {
    throw new Error('Reviewed repository knowledge pages must be materialized by the knowledge publisher.');
  }
  if (
    input.catalog.repositoryId !== input.evidenceBundle.repositoryId ||
    input.ir.repositoryId !== input.evidenceBundle.repositoryId ||
    input.evidenceBundle.moduleId !== input.wikiProposal.moduleId
  ) {
    throw new Error('Repository summary review artifacts do not bind to the supplied catalog and IR.');
  }
  if (
    input.evidenceBundle.source.moduleCatalogId !== input.catalog.id ||
    input.evidenceBundle.source.moduleCatalogHash !== input.catalog.contentHash ||
    input.evidenceBundle.source.unifiedRepositoryIrId !== input.ir.id ||
    input.evidenceBundle.source.unifiedRepositoryIrHash !== input.ir.contentHash
  ) {
    throw new Error('Repository summary evidence does not bind to the supplied immutable catalog and IR.');
  }
  assertTimestamp(input.createdAt, 'Reviewed repository knowledge page creation time');
  if (Date.parse(input.createdAt) < Date.parse(input.knowledgeReview.reviewedAt)) {
    throw new Error('Reviewed repository knowledge page cannot precede its summary review.');
  }
  const generated = materializeRepositoryModuleKnowledgePage({
    catalog: input.catalog,
    ir: input.ir,
    moduleId: input.wikiProposal.moduleId,
    wiki: input.wikiProposal.narrative,
    producer: input.wikiProposal.producer,
    createdAt: input.createdAt,
  });
  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    summarySchemaVersion: repositoryModuleSummarySchemaVersion,
    repositoryId: generated.repositoryId,
    moduleId: generated.moduleId,
    source: {
      ...generated.source,
      evidenceBundleId: input.evidenceBundle.id,
      evidenceBundleHash: input.evidenceBundle.contentHash,
      wikiProposalId: input.wikiProposal.id,
      wikiProposalHash: input.wikiProposal.contentHash,
      knowledgeReviewId: input.knowledgeReview.id,
      knowledgeReviewHash: input.knowledgeReview.contentHash,
    },
    boundaryStatus: 'reviewed' as const,
    narrativeStatus: 'reviewed' as const,
    verificationStatus: 'unverified' as const,
    trustTier: 'reviewed' as const,
    raw: generated.raw,
    wiki: generated.wiki,
    producer: canonicalProducer(input.producer),
    createdAt: input.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  const page: RepositoryModuleKnowledgePage = {
    ...payload,
    id: `repository-module-knowledge:${generated.moduleId}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
  validateRepositoryModuleKnowledgePage(page, input.catalog, input.ir);
  return page;
}

/** Create a staged publication only from accepted, unverified narrative pages. */
export function stageRepositoryKnowledgePublication(
  input: StageRepositoryKnowledgePublicationInput,
): RepositoryKnowledgePublication {
  validateRepositoryModuleBundleEnvelope(input.repositoryModuleBundle);
  const scope = canonicalScope(input.scope);
  const repositoryScopes = canonicalRepositoryScopes(input.repositoryScopes, scope.repositoryId);
  if (scope.repositoryId !== input.repositoryModuleBundle.repositoryId) {
    throw new Error('Knowledge publication scope does not match its repository module bundle.');
  }
  assertPositiveInteger(input.generation, 'Knowledge publication generation');
  assertTimestamp(input.stagedAt, 'Knowledge publication staging time');
  if (input.producer.kind !== 'knowledge-publisher') {
    throw new Error('Repository knowledge publications must be staged by the knowledge publisher.');
  }
  const modules = [...input.repositoryModuleBundle.modules].sort((a, b) => a.id.localeCompare(b.id));
  const pages = uniqueMap(input.knowledgePages, (item) => item.moduleId, 'knowledge page');
  const bundles = uniqueMap(input.evidenceBundles, (item) => item.moduleId, 'evidence bundle');
  const proposals = uniqueMap(input.wikiProposals, (item) => item.moduleId, 'Wiki proposal');
  const reviews = uniqueMap(input.knowledgeReviews, (item) => item.moduleId, 'knowledge review');
  const sourceModules = modules.map((module) => {
    const page = pages.get(module.id);
    const bundle = bundles.get(module.id);
    const proposal = proposals.get(module.id);
    const review = reviews.get(module.id);
    if (!page || !bundle || !proposal || !review) {
      throw new Error(`Knowledge publication lacks the complete reviewed module closure: ${module.id}`);
    }
    validateReviewedKnowledgePageEnvelope(page);
    validateRepositoryModuleWikiProposal(proposal, bundle);
    validateRepositoryModuleKnowledgeReview(review, proposal, bundle);
    if (
      review.decision !== 'accept' ||
      page.narrativeStatus !== 'reviewed' ||
      page.boundaryStatus !== 'reviewed' ||
      page.verificationStatus !== 'unverified' ||
      page.trustTier !== 'reviewed'
    ) {
      throw new Error(`Knowledge publication module is not independently reviewed: ${module.id}`);
    }
    if (
      page.source.evidenceBundleId !== bundle.id ||
      page.source.evidenceBundleHash !== bundle.contentHash ||
      page.source.wikiProposalId !== proposal.id ||
      page.source.wikiProposalHash !== proposal.contentHash ||
      page.source.knowledgeReviewId !== review.id ||
      page.source.knowledgeReviewHash !== review.contentHash
    ) {
      throw new Error(`Knowledge publication page has an incomplete source closure: ${module.id}`);
    }
    return {
      moduleId: module.id,
      evidenceBundleId: bundle.id,
      evidenceBundleHash: bundle.contentHash,
      wikiProposalId: proposal.id,
      wikiProposalHash: proposal.contentHash,
      knowledgeReviewId: review.id,
      knowledgeReviewHash: review.contentHash,
      knowledgePageId: page.id,
      knowledgePageHash: page.contentHash,
    };
  });
  if (
    pages.size !== modules.length || bundles.size !== modules.length ||
    proposals.size !== modules.length || reviews.size !== modules.length
  ) {
    throw new Error('Knowledge publication contains modules outside its repository module bundle.');
  }
  const artifacts = canonicalArtifactRefs(input.artifacts);
  assertPublicationArtifacts(artifacts, sourceModules.map((module) => module.knowledgePageId));
  const immutablePayload = {
    scope,
    repositoryScopes,
    generation: input.generation,
    source: {
      repositoryModuleBundleId: input.repositoryModuleBundle.id,
      repositoryModuleBundleHash: input.repositoryModuleBundle.contentHash,
      modules: sourceModules,
    },
    artifacts,
  };
  const payloadHash = sha256Hex(canonicalJson(immutablePayload));
  const payload = {
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: `repository-knowledge-publication:${payloadHash.slice(0, 24)}`,
    ...immutablePayload,
    status: 'staged' as const,
    payloadHash,
    ...(input.previousPublicationId === undefined
      ? {}
      : { previousPublicationId: normalizeRequired(input.previousPublicationId, 'Previous publication ID') }),
    stagedAt: input.stagedAt,
    producer: canonicalProducer(input.producer),
  };
  return contentAddressedPublication(payload);
}

export function validateRepositoryKnowledgePublication(
  publication: RepositoryKnowledgePublication,
): void {
  if (publication.schemaVersion !== repositoryKnowledgePublicationSchemaVersion) {
    throw new Error('Repository knowledge publication uses an unsupported schema version.');
  }
  canonicalScope(publication.scope);
  const repositoryScopes = canonicalRepositoryScopes(
    publication.repositoryScopes,
    publication.scope.repositoryId,
  );
  assertPositiveInteger(publication.generation, 'Knowledge publication generation');
  requireSha256(publication.payloadHash, 'Knowledge publication payload hash');
  requireSha256(publication.contentHash, 'Knowledge publication content hash');
  assertTimestamp(publication.stagedAt, 'Knowledge publication staging time');
  if (publication.producer.kind !== 'knowledge-publisher') {
    throw new Error('Repository knowledge publication has an invalid producer.');
  }
  if (
    publication.status !== 'staged' &&
    publication.status !== 'active' &&
    publication.status !== 'withdrawn'
  ) {
    throw new Error(`Repository knowledge publication has an unsupported status: ${String(publication.status)}`);
  }
  if (canonicalJson(canonicalScope(publication.scope)) !== canonicalJson(publication.scope)) {
    throw new Error('Repository knowledge publication scope must be canonical.');
  }
  if (canonicalJson(repositoryScopes) !== canonicalJson(publication.repositoryScopes)) {
    throw new Error('Repository knowledge publication ACL scopes must be canonical.');
  }
  const canonicalArtifacts = canonicalArtifactRefs(publication.artifacts);
  if (canonicalJson(canonicalArtifacts) !== canonicalJson(publication.artifacts)) {
    throw new Error('Repository knowledge publication artifacts must be canonical.');
  }
  if (publication.source.modules.length === 0) {
    throw new Error('Repository knowledge publication requires at least one module.');
  }
  const canonicalModules = [...publication.source.modules].sort((left, right) =>
    left.moduleId.localeCompare(right.moduleId),
  );
  if (canonicalJson(canonicalModules) !== canonicalJson(publication.source.modules)) {
    throw new Error('Repository knowledge publication modules must be sorted by module ID.');
  }
  assertUniqueBy(canonicalModules, (module) => module.moduleId, 'Knowledge publication module');
  requireSha256(publication.source.repositoryModuleBundleHash, 'Knowledge publication module bundle hash');
  for (const module of publication.source.modules) {
    requireSha256(module.evidenceBundleHash, `Knowledge publication ${module.moduleId} evidence hash`);
    requireSha256(module.wikiProposalHash, `Knowledge publication ${module.moduleId} proposal hash`);
    requireSha256(module.knowledgeReviewHash, `Knowledge publication ${module.moduleId} review hash`);
    requireSha256(module.knowledgePageHash, `Knowledge publication ${module.moduleId} page hash`);
  }
  if (publication.status === 'staged' && (publication.activatedAt || publication.withdrawnAt)) {
    throw new Error('A staged knowledge publication cannot contain activation or withdrawal time.');
  }
  if (publication.status === 'staged' && publication.previousStateHash !== undefined) {
    throw new Error('A staged knowledge publication cannot claim a previous state revision.');
  }
  if (publication.status === 'active') {
    if (!publication.activatedAt || publication.withdrawnAt || !publication.previousStateHash) {
      throw new Error('An active knowledge publication requires only an activation time.');
    }
    assertTimestamp(publication.activatedAt, 'Knowledge publication activation time');
    requireSha256(publication.previousStateHash, 'Active knowledge publication previous state hash');
    if (Date.parse(publication.activatedAt) < Date.parse(publication.stagedAt)) {
      throw new Error('Knowledge publication activation cannot precede staging.');
    }
  }
  if (publication.status === 'withdrawn') {
    if (!publication.activatedAt || !publication.withdrawnAt || !publication.previousStateHash) {
      throw new Error('A withdrawn knowledge publication requires activation and withdrawal times.');
    }
    assertTimestamp(publication.withdrawnAt, 'Knowledge publication withdrawal time');
    requireSha256(publication.previousStateHash, 'Withdrawn knowledge publication previous state hash');
    if (Date.parse(publication.withdrawnAt) < Date.parse(publication.activatedAt)) {
      throw new Error('Knowledge publication withdrawal cannot precede activation.');
    }
  }
  const immutablePayload = {
    scope: publication.scope,
    repositoryScopes: publication.repositoryScopes,
    generation: publication.generation,
    source: publication.source,
    artifacts: publication.artifacts,
  };
  if (sha256Hex(canonicalJson(immutablePayload)) !== publication.payloadHash ||
      publication.id !== `repository-knowledge-publication:${publication.payloadHash.slice(0, 24)}`) {
    throw new Error('Repository knowledge publication payload hash does not match its immutable projection.');
  }
  const { contentHash, ...payload } = publication;
  if (sha256Hex(canonicalJson(payload)) !== contentHash) {
    throw new Error('Repository knowledge publication content hash does not match its state.');
  }
}

export function materializeRepositoryModuleIndexReceipt(
  input: MaterializeRepositoryModuleIndexReceiptInput,
): RepositoryModuleIndexReceipt {
  validateRepositoryKnowledgePublication(input.publication);
  if (input.publication.status !== 'staged') {
    throw new Error('A module index receipt can only be created for a staged publication.');
  }
  if (input.status !== 'staged' && input.status !== 'validated') {
    throw new Error('Initial module index receipt status must be staged or validated.');
  }
  assertTimestamp(input.createdAt, 'Module index receipt creation time');
  const updatedAt = input.updatedAt ?? input.createdAt;
  assertTimestamp(updatedAt, 'Module index receipt update time');
  if (Date.parse(updatedAt) < Date.parse(input.createdAt)) {
    throw new Error('Module index receipt update time cannot precede its creation time.');
  }
  assertNonNegativeInteger(input.documentCount, 'Module index document count');
  const moduleIds = sortedUnique(input.moduleIds.map((id) => normalizeRequired(id, 'Indexed module ID')));
  const expectedIds = input.publication.source.modules.map((module) => module.moduleId).sort();
  if (canonicalJson(moduleIds) !== canonicalJson(expectedIds) || input.documentCount !== moduleIds.length) {
    throw new Error('Module index receipt must cover exactly one document per publication module.');
  }
  requireSha256(input.indexArtifactHash, 'Module index artifact hash');
  const payload = {
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: `repository-module-index-receipt:${input.publication.id}:${input.publication.generation}`,
    publicationId: input.publication.id,
    publicationPayloadHash: input.publication.payloadHash,
    scope: input.publication.scope,
    generation: input.publication.generation,
    status: input.status,
    storeId: normalizeRequired(input.storeId, 'Module index store ID'),
    documentCount: input.documentCount,
    moduleIds,
    indexArtifactHash: input.indexArtifactHash,
    createdAt: input.createdAt,
    updatedAt,
  };
  return contentAddressedIndexReceipt(payload);
}

export function validateRepositoryModuleIndexReceipt(receipt: RepositoryModuleIndexReceipt): void {
  if (receipt.schemaVersion !== repositoryKnowledgePublicationSchemaVersion) {
    throw new Error('Repository module index receipt uses an unsupported schema version.');
  }
  canonicalScope(receipt.scope);
  assertPositiveInteger(receipt.generation, 'Module index generation');
  assertNonNegativeInteger(receipt.documentCount, 'Module index document count');
  requireSha256(receipt.publicationPayloadHash, 'Module index publication payload hash');
  requireSha256(receipt.indexArtifactHash, 'Module index artifact hash');
  requireSha256(receipt.contentHash, 'Module index receipt content hash');
  assertTimestamp(receipt.createdAt, 'Module index receipt creation time');
  assertTimestamp(receipt.updatedAt, 'Module index receipt update time');
  if (
    receipt.status !== 'staged' &&
    receipt.status !== 'validated' &&
    receipt.status !== 'active' &&
    receipt.status !== 'withdrawn'
  ) {
    throw new Error(`Repository module index receipt has an unsupported status: ${String(receipt.status)}`);
  }
  if (receipt.documentCount !== receipt.moduleIds.length ||
      canonicalJson(receipt.moduleIds) !== canonicalJson(sortedUnique(receipt.moduleIds))) {
    throw new Error('Module index receipt document count or module ordering is invalid.');
  }
  if (receipt.id !== `repository-module-index-receipt:${receipt.publicationId}:${receipt.generation}`) {
    throw new Error('Repository module index receipt ID does not match its publication generation.');
  }
  if ((receipt.status === 'active' || receipt.status === 'withdrawn') && !receipt.previousStateHash) {
    throw new Error(`A ${receipt.status} module index receipt requires its previous state hash.`);
  }
  if ((receipt.status === 'staged' || receipt.status === 'validated') && receipt.previousStateHash !== undefined) {
    throw new Error(`An initial ${receipt.status} module index receipt cannot claim a previous state.`);
  }
  if (receipt.previousStateHash !== undefined) {
    requireSha256(receipt.previousStateHash, 'Module index receipt previous state hash');
  }
  const { contentHash, ...payload } = receipt;
  if (sha256Hex(canonicalJson(payload)) !== contentHash) {
    throw new Error('Repository module index receipt content hash does not match its state.');
  }
}

export function activateRepositoryKnowledgePublication(
  input: ActivateRepositoryKnowledgePublicationInput,
): ActivateRepositoryKnowledgePublicationResult {
  validateRepositoryKnowledgePublication(input.publication);
  validateRepositoryModuleIndexReceipt(input.indexReceipt);
  if (input.publication.status !== 'staged' || input.indexReceipt.status !== 'validated') {
    throw new Error('Knowledge activation requires staged publication and validated index receipt.');
  }
  assertReceiptMatchesPublication(input.indexReceipt, input.publication);
  assertTimestamp(input.activatedAt, 'Knowledge publication activation time');
  if (Date.parse(input.activatedAt) < Date.parse(input.publication.stagedAt) ||
      Date.parse(input.activatedAt) < Date.parse(input.indexReceipt.updatedAt)) {
    throw new Error('Knowledge publication activation cannot precede staging or index validation.');
  }
  assertHeadCas(input.currentHead, input.expectedHeadHash, input.publication.scope);
  if (input.currentHead && input.publication.generation <= input.currentHead.generation) {
    throw new Error('Knowledge publication generation must advance the active head.');
  }
  if (input.currentHead && input.publication.previousPublicationId !== input.currentHead.publicationId) {
    throw new Error('Knowledge publication previous ID does not match the active CAS head.');
  }
  if (!input.currentHead && input.publication.previousPublicationId !== undefined) {
    throw new Error('Initial knowledge publication cannot name a previous publication.');
  }
  const publication = contentAddressedPublication({
    ...withoutContentHash(input.publication),
    status: 'active' as const,
    previousStateHash: input.publication.contentHash,
    activatedAt: input.activatedAt,
  });
  const indexReceipt = contentAddressedIndexReceipt({
    ...withoutContentHash(input.indexReceipt),
    status: 'active' as const,
    previousStateHash: input.indexReceipt.contentHash,
    updatedAt: input.activatedAt,
  });
  const head = contentAddressedHead({
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    scope: publication.scope,
    publicationId: publication.id,
    publicationHash: publication.contentHash,
    generation: publication.generation,
    updatedAt: input.activatedAt,
  });
  return { publication, indexReceipt, head };
}

export function withdrawRepositoryKnowledgePublication(
  input: WithdrawRepositoryKnowledgePublicationInput,
): WithdrawRepositoryKnowledgePublicationResult {
  validateRepositoryKnowledgePublication(input.publication);
  validateRepositoryModuleIndexReceipt(input.indexReceipt);
  validateRepositoryKnowledgePublicationHead(input.currentHead);
  if (input.publication.status !== 'active' || input.indexReceipt.status !== 'active') {
    throw new Error('Only an active knowledge publication and index generation can be withdrawn.');
  }
  assertReceiptMatchesPublication(input.indexReceipt, input.publication);
  assertHeadCas(input.currentHead, input.expectedHeadHash, input.publication.scope);
  if (
    input.currentHead.publicationId !== input.publication.id ||
    input.currentHead.publicationHash !== input.publication.contentHash
  ) {
    throw new Error('Knowledge withdrawal can only target the active CAS head.');
  }
  assertTimestamp(input.withdrawnAt, 'Knowledge publication withdrawal time');
  if (Date.parse(input.withdrawnAt) < Date.parse(input.publication.activatedAt!)) {
    throw new Error('Knowledge publication withdrawal cannot precede activation.');
  }
  const publication = contentAddressedPublication({
    ...withoutContentHash(input.publication),
    status: 'withdrawn' as const,
    previousStateHash: input.publication.contentHash,
    withdrawnAt: input.withdrawnAt,
  });
  const indexReceipt = contentAddressedIndexReceipt({
    ...withoutContentHash(input.indexReceipt),
    status: 'withdrawn' as const,
    previousStateHash: input.indexReceipt.contentHash,
    updatedAt: input.withdrawnAt,
  });
  if (!input.restorePublication) return { publication, indexReceipt };
  validateRepositoryKnowledgePublication(input.restorePublication);
  if (
    input.restorePublication.status !== 'active' ||
    input.publication.previousPublicationId !== input.restorePublication.id ||
    canonicalJson(input.restorePublication.scope) !== canonicalJson(input.publication.scope) ||
    input.restorePublication.generation >= input.publication.generation
  ) {
    throw new Error('Knowledge withdrawal restore target is not the prior active publication.');
  }
  const head = contentAddressedHead({
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    scope: input.restorePublication.scope,
    publicationId: input.restorePublication.id,
    publicationHash: input.restorePublication.contentHash,
    generation: input.restorePublication.generation,
    updatedAt: input.withdrawnAt,
  });
  return { publication, indexReceipt, head };
}

export function validateRepositoryKnowledgePublicationHead(
  head: RepositoryKnowledgePublicationHead,
): void {
  if (head.schemaVersion !== repositoryKnowledgePublicationSchemaVersion) {
    throw new Error('Repository knowledge publication head uses an unsupported schema version.');
  }
  if (canonicalJson(canonicalScope(head.scope)) !== canonicalJson(head.scope)) {
    throw new Error('Repository knowledge publication head scope must be canonical.');
  }
  assertPositiveInteger(head.generation, 'Knowledge publication head generation');
  requireSha256(head.publicationHash, 'Knowledge publication head hash');
  requireSha256(head.contentHash, 'Knowledge publication head content hash');
  assertTimestamp(head.updatedAt, 'Knowledge publication head update time');
  const { contentHash, ...payload } = head;
  if (sha256Hex(canonicalJson(payload)) !== contentHash) {
    throw new Error('Repository knowledge publication head content hash is invalid.');
  }
}

export function createRepositoryImportBatch(input: CreateRepositoryImportBatchInput): RepositoryImportBatch {
  assertSafeIdentifier(input.id, 'Repository import batch ID');
  assertTimestamp(input.createdAt, 'Repository import batch creation time');
  if (input.producer.kind !== 'ingestion-host') {
    throw new Error('Repository import batches must be created by the ingestion host.');
  }
  if (input.items.length === 0) throw new Error('Repository import batch requires at least one item.');
  const items = input.items.map(canonicalBatchItem)
    .sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
  assertUniqueBy(items, (item) => item.id, 'Repository import batch item ID');
  assertUniqueBy(items, (item) => scopeKey(item.scope), 'Repository import batch scope');
  for (const item of items) {
    if (item.status !== 'pending' || item.publicationId || item.publicationHash || item.failure) {
      throw new Error('New repository import batch items must be pending without publication or failure state.');
    }
  }
  return contentAddressedBatch({
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: input.id,
    atomicity: 'per-repository' as const,
    status: 'open' as const,
    items,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    producer: canonicalProducer(input.producer),
  });
}

export function updateRepositoryImportBatchItem(
  batch: RepositoryImportBatch,
  itemId: string,
  update: {
    status: Exclude<RepositoryImportBatchItemStatus, 'pending'>;
    publication?: RepositoryKnowledgePublication;
    failure?: RepositoryImportBatchItem['failure'];
    updatedAt: string;
  },
): RepositoryImportBatch {
  validateRepositoryImportBatch(batch);
  if (batch.status !== 'open') throw new Error('A finalized repository import batch cannot be updated.');
  assertTimestamp(update.updatedAt, 'Repository import batch update time');
  if (Date.parse(update.updatedAt) < Date.parse(batch.updatedAt)) {
    throw new Error('Repository import batch update cannot move backwards in time.');
  }
  const index = batch.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error(`Unknown repository import batch item: ${itemId}`);
  const current = batch.items[index]!;
  const allowed: Record<RepositoryImportBatchItemStatus, RepositoryImportBatchItemStatus[]> = {
    pending: ['staged', 'failed'],
    staged: ['active', 'failed'],
    active: ['withdrawn'],
    failed: [],
    withdrawn: [],
  };
  if (!allowed[current.status].includes(update.status)) {
    throw new Error(`Repository import batch item cannot transition from ${current.status} to ${update.status}.`);
  }
  if (update.status === 'failed') {
    if (!update.failure || update.publication) {
      throw new Error('A failed repository import batch item requires failure evidence and no publication.');
    }
  } else {
    if (!update.publication || update.failure) {
      throw new Error('A staged, active, or withdrawn batch item requires a publication and no failure.');
    }
    validateRepositoryKnowledgePublication(update.publication);
    if (canonicalJson(update.publication.scope) !== canonicalJson(current.scope) ||
        update.publication.status !== update.status) {
      throw new Error('Repository import batch publication does not match the item scope or status.');
    }
  }
  const nextItem = canonicalBatchItem({
    ...current,
    status: update.status,
    ...(update.publication === undefined
      ? {}
      : { publicationId: update.publication.id, publicationHash: update.publication.contentHash }),
    ...(update.failure === undefined ? {} : { failure: update.failure }),
  });
  const items = [...batch.items];
  items[index] = nextItem;
  return contentAddressedBatch({
    ...withoutContentHash(batch),
    items,
    previousStateHash: batch.contentHash,
    updatedAt: update.updatedAt,
  });
}

export function finalizeRepositoryImportBatch(
  batch: RepositoryImportBatch,
  updatedAt: string,
): RepositoryImportBatch {
  validateRepositoryImportBatch(batch);
  if (batch.status !== 'open') throw new Error('Repository import batch is already finalized.');
  if (batch.items.some((item) => item.status === 'pending' || item.status === 'staged')) {
    throw new Error('Repository import batch cannot finalize while an item is pending or staged.');
  }
  assertTimestamp(updatedAt, 'Repository import batch finalization time');
  if (Date.parse(updatedAt) < Date.parse(batch.updatedAt)) {
    throw new Error('Repository import batch finalization cannot move backwards in time.');
  }
  return contentAddressedBatch({
    ...withoutContentHash(batch),
    status: batch.items.some((item) => item.status === 'failed')
      ? 'completed-with-errors' as const
      : 'completed' as const,
    previousStateHash: batch.contentHash,
    updatedAt,
  });
}

export function validateRepositoryImportBatch(batch: RepositoryImportBatch): void {
  if (batch.schemaVersion !== repositoryKnowledgePublicationSchemaVersion || batch.atomicity !== 'per-repository') {
    throw new Error('Repository import batch uses an unsupported schema or atomicity mode.');
  }
  assertSafeIdentifier(batch.id, 'Repository import batch ID');
  assertTimestamp(batch.createdAt, 'Repository import batch creation time');
  assertTimestamp(batch.updatedAt, 'Repository import batch update time');
  if (batch.items.length === 0) throw new Error('Repository import batch requires at least one item.');
  const canonicalItems = batch.items.map(canonicalBatchItem)
    .sort((left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)));
  if (canonicalJson(canonicalItems) !== canonicalJson(batch.items)) {
    throw new Error('Repository import batch items must be canonical and sorted by scope.');
  }
  assertUniqueBy(batch.items, (item) => item.id, 'Repository import batch item ID');
  assertUniqueBy(batch.items, (item) => scopeKey(item.scope), 'Repository import batch scope');
  const expectedStatus = batch.status === 'open'
    ? 'open'
    : batch.items.some((item) => item.status === 'failed')
      ? 'completed-with-errors'
      : 'completed';
  if (batch.status !== expectedStatus) {
    throw new Error('Repository import batch status does not match its per-repository item outcomes.');
  }
  const { contentHash, ...payload } = batch;
  if (sha256Hex(canonicalJson(payload)) !== contentHash) {
    throw new Error('Repository import batch content hash does not match its state.');
  }
}

/** Draft 2020-12 machine schema for `summary.json`; `schema.md` remains guidance. */
export function repositoryModuleSummaryJsonSchema(): RepositoryIngestionJsonValue {
  const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };
  const strings = { type: 'array', items: { type: 'string' }, uniqueItems: true };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: repositoryModuleSummaryJsonSchemaId,
    title: 'ForeXplore Repository Module Summary',
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'summarySchemaVersion', 'id', 'repositoryId', 'moduleId',
      'source', 'boundaryStatus', 'narrativeStatus', 'verificationStatus', 'trustTier',
      'raw', 'wiki', 'producer', 'createdAt', 'contentHash',
    ],
    properties: {
      schemaVersion: { const: repositoryIngestionSchemaVersion },
      summarySchemaVersion: { const: repositoryModuleSummarySchemaVersion },
      id: { type: 'string', minLength: 1 },
      repositoryId: { type: 'string', minLength: 1 },
      moduleId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
      source: {
        type: 'object',
        additionalProperties: false,
        required: ['unifiedRepositoryIrId', 'unifiedRepositoryIrHash', 'moduleCatalogId', 'moduleCatalogHash'],
        properties: {
          unifiedRepositoryIrId: { type: 'string', minLength: 1 },
          unifiedRepositoryIrHash: sha,
          moduleCatalogId: { type: 'string', minLength: 1 },
          moduleCatalogHash: sha,
          evidenceBundleId: { type: 'string', minLength: 1 },
          evidenceBundleHash: sha,
          wikiProposalId: { type: 'string', minLength: 1 },
          wikiProposalHash: sha,
          knowledgeReviewId: { type: 'string', minLength: 1 },
          knowledgeReviewHash: sha,
        },
      },
      boundaryStatus: { enum: ['proposed', 'reviewed'] },
      narrativeStatus: { enum: ['generated', 'reviewed'] },
      verificationStatus: { enum: ['unverified', 'partial', 'verified'] },
      trustTier: { enum: ['discovered', 'reviewed', 'verified'] },
      raw: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name', 'kind', 'description', 'responsibilities', 'businessCapabilities',
          'languageIds', 'fileIds', 'filePaths', 'entityIds', 'entryPointEntityIds',
          'publicApiEntityIds', 'apiSurfaceIds', 'publicApiSignatures', 'dependencies',
          'evidenceRefs',
        ],
        properties: {
          name: { type: 'string', minLength: 1 },
          kind: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          responsibilities: strings,
          businessCapabilities: strings,
          languageIds: strings,
          fileIds: strings,
          filePaths: strings,
          entityIds: strings,
          entryPointEntityIds: strings,
          publicApiEntityIds: strings,
          apiSurfaceIds: strings,
          publicApiSignatures: strings,
          dependencies: { type: 'array', items: { type: 'object' } },
          evidenceRefs: { type: 'array', items: { type: 'object' } },
        },
      },
      wiki: {
        type: 'object',
        additionalProperties: false,
        required: [
          'summary', 'architecture', 'publicInterfaces', 'dataFlow', 'operationalNotes',
          'reuseGuidance', 'limitations', 'risks', 'evidenceIds',
        ],
        properties: {
          summary: { type: 'string', minLength: 1 },
          architecture: { type: 'string' },
          publicInterfaces: { type: 'string' },
          dataFlow: { type: 'string' },
          operationalNotes: { type: 'string' },
          reuseGuidance: { type: 'string' },
          limitations: strings,
          risks: strings,
          evidenceIds: strings,
          tags: strings,
        },
      },
      producer: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'id'],
        properties: {
          kind: { enum: ['module-discovery-agent', 'module-summary-agent', 'knowledge-publisher', 'human'] },
          id: { type: 'string', minLength: 1 },
          version: { type: 'string' },
          configurationHash: { type: 'string' },
        },
      },
      createdAt: { type: 'string', format: 'date-time' },
      contentHash: sha,
    },
    allOf: [{
      if: { properties: { narrativeStatus: { const: 'reviewed' } }, required: ['narrativeStatus'] },
      then: {
        properties: {
          trustTier: { const: 'reviewed' },
          producer: { properties: { kind: { const: 'knowledge-publisher' } } },
          source: {
            required: [
              'evidenceBundleId', 'evidenceBundleHash', 'wikiProposalId', 'wikiProposalHash',
              'knowledgeReviewId', 'knowledgeReviewHash',
            ],
          },
        },
      },
    }, {
      if: { properties: { narrativeStatus: { const: 'generated' } }, required: ['narrativeStatus'] },
      then: { properties: { trustTier: { const: 'discovered' } } },
    }],
  };
}

export function serializeRepositoryModuleSummaryJsonSchema(): string {
  return `${canonicalJson(repositoryModuleSummaryJsonSchema())}\n`;
}

export function materializeRepositoryModuleSummaryJsonSchemaArtifact(
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  assertTimestamp(createdAt, 'Repository module summary JSON Schema creation time');
  const content = serializeRepositoryModuleSummaryJsonSchema();
  return {
    descriptor: {
      artifact: {
        id: `repository-module-summary-json-schema:${sha256Hex(content).slice(0, 24)}`,
        kind: 'repository-wiki',
        contentHash: sha256Hex(content),
        hashAlgorithm: 'sha256',
        schemaVersion: repositoryModuleSummarySchemaVersion,
        path: repositoryModuleKnowledgeJsonSchemaPath,
        mediaType: 'application/schema+json',
        createdAt,
      },
      format: 'json-schema',
      sourceArtifactIds: [],
      producer: canonicalProducer(producer),
    },
    content,
  };
}

function canonicalEvidenceItem(item: RepositoryModuleEvidenceItem): RepositoryModuleEvidenceItem {
  assertSafeIdentifier(item.id, 'Repository evidence item ID');
  const content = item.content.replace(/\r\n/g, '\n');
  if (!content) throw new Error(`Repository evidence item ${item.id} content is required.`);
  const contentHash = sha256Hex(content);
  if (item.contentHash !== contentHash) {
    throw new Error(`Repository evidence item ${item.id} content hash is invalid.`);
  }
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (item.byteLength !== byteLength) {
    throw new Error(`Repository evidence item ${item.id} byte length is invalid.`);
  }
  if (item.truncated && !item.truncationReason?.trim()) {
    throw new Error(`Truncated repository evidence item ${item.id} requires a reason.`);
  }
  if (!item.truncated && item.truncationReason !== undefined) {
    throw new Error(`Complete repository evidence item ${item.id} cannot declare a truncation reason.`);
  }
  if (item.path !== undefined && item.range !== undefined &&
      normalizeRepositoryPath(item.path) !== normalizeRepositoryPath(item.range.path)) {
    throw new Error(`Repository evidence item ${item.id} path and range disagree.`);
  }
  return {
    id: item.id,
    kind: item.kind,
    evidenceKind: item.evidenceKind,
    evidenceRefIds: sortedUnique(item.evidenceRefIds.map((id) => normalizeRequired(id, 'Evidence reference ID'))),
    ...(item.sourceArtifactId === undefined ? {} : { sourceArtifactId: normalizeRequired(item.sourceArtifactId, 'Evidence source artifact ID') }),
    ...(item.path === undefined ? {} : { path: normalizeRepositoryPath(item.path) }),
    ...(item.range === undefined ? {} : { range: canonicalRange(item.range) }),
    mediaType: normalizeRequired(item.mediaType, 'Repository evidence media type'),
    content,
    byteLength,
    contentHash,
    truncated: item.truncated,
    ...(item.truncationReason === undefined ? {} : { truncationReason: normalizeRequired(item.truncationReason, 'Evidence truncation reason') }),
  };
}

function canonicalOmission(item: RepositoryModuleEvidenceOmission): RepositoryModuleEvidenceOmission {
  return {
    kind: item.kind,
    sourceId: normalizeRequired(item.sourceId, 'Evidence omission source ID'),
    reason: normalizeRequired(item.reason, 'Evidence omission reason'),
  };
}

function validateEvidenceBundleEnvelope(bundle: RepositoryModuleEvidenceBundle): void {
  if (bundle.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error('Repository module evidence bundle uses an unsupported schema version.');
  }
  requireSha256(bundle.contentHash, 'Repository module evidence bundle content hash');
  requireSha256(bundle.repositoryContentHash, 'Repository module evidence repository hash');
  if (bundle.producer.kind !== 'ingestion-host') {
    throw new Error('Repository module evidence bundle is not host-owned.');
  }
  assertTimestamp(bundle.createdAt, 'Repository module evidence bundle creation time');
  requireSha256(bundle.source.repositoryModuleBundleHash, 'Evidence source module bundle hash');
  requireSha256(bundle.source.unifiedRepositoryIrHash, 'Evidence source IR hash');
  requireSha256(bundle.source.moduleCatalogHash, 'Evidence source module catalog hash');
  requireSha256(bundle.source.moduleReviewHash, 'Evidence source module review hash');
  const canonicalItems = bundle.items.map(canonicalEvidenceItem)
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonicalOmissions = bundle.omissions.map(canonicalOmission)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId));
  if (canonicalItems.length === 0 ||
      canonicalJson(canonicalItems) !== canonicalJson(bundle.items) ||
      canonicalJson(canonicalOmissions) !== canonicalJson(bundle.omissions)) {
    throw new Error('Repository module evidence bundle items and omissions must be canonical.');
  }
  assertUniqueBy(canonicalItems, (item) => item.id, 'Repository evidence item');
  assertUniqueBy(canonicalOmissions, (item) => `${item.kind}:${item.sourceId}`, 'Repository evidence omission');
  for (const [label, values] of Object.entries(bundle.scope)) {
    if (canonicalJson(values) !== canonicalJson(sortedUnique(values))) {
      throw new Error(`Repository module evidence scope ${label} must be sorted and unique.`);
    }
  }
  const { id, contentHash, ...payload } = bundle;
  const expectedHash = sha256Hex(canonicalJson(payload));
  if (contentHash !== expectedHash || id !== `repository-module-evidence:${bundle.moduleId}:${expectedHash.slice(0, 24)}`) {
    throw new Error('Repository module evidence bundle content hash is invalid.');
  }
}

function canonicalEvidenceBindings(
  bindings: readonly RepositoryModuleWikiEvidenceBinding[],
): RepositoryModuleWikiEvidenceBinding[] {
  const result = bindings.map((binding) => ({
    section: binding.section,
    claim: normalizeRequired(binding.claim, 'Repository Wiki claim'),
    evidenceIds: sortedUnique(binding.evidenceIds.map((id) => normalizeRequired(id, 'Claim evidence ID'))),
  })).sort((left, right) => left.section.localeCompare(right.section) || left.claim.localeCompare(right.claim));
  assertUniqueBy(result, (binding) => `${binding.section}\u0000${binding.claim}`, 'Repository Wiki claim binding');
  for (const binding of result) {
    if (binding.evidenceIds.length === 0) {
      throw new Error(`Repository Wiki claim requires immutable evidence: ${binding.section}/${binding.claim}`);
    }
  }
  return result;
}

function validateClaimEvidenceClosure(
  narrative: RepositoryModuleWikiDraft,
  bindings: readonly RepositoryModuleWikiEvidenceBinding[],
  evidenceBundle: RepositoryModuleEvidenceBundle,
): void {
  const expectedClaims = wikiClaims(narrative);
  const actualClaims = bindings.map(({ section, claim }) => ({ section, claim }));
  if (canonicalJson(actualClaims) !== canonicalJson(expectedClaims)) {
    throw new Error('Repository Wiki proposal must bind every narrative claim exactly once.');
  }
  const knownEvidence = new Set(evidenceBundle.scope.evidenceIds);
  for (const binding of bindings) {
    for (const evidenceId of binding.evidenceIds) {
      if (!knownEvidence.has(evidenceId)) {
        throw new Error(`Repository Wiki claim cites evidence outside its bundle: ${evidenceId}`);
      }
    }
  }
  const cited = sortedUnique(bindings.flatMap((binding) => binding.evidenceIds));
  if (canonicalJson(cited) !== canonicalJson(narrative.evidenceIds)) {
    throw new Error('Repository Wiki narrative evidenceIds must equal its claim-level evidence closure.');
  }
}

function wikiClaims(narrative: RepositoryModuleWikiDraft): Array<{ section: RepositoryModuleWikiSection; claim: string }> {
  const result: Array<{ section: RepositoryModuleWikiSection; claim: string }> = [];
  for (const section of [
    'summary', 'architecture', 'publicInterfaces', 'dataFlow', 'operationalNotes', 'reuseGuidance',
  ] as const) {
    const claim = narrative[section].trim();
    if (claim) result.push({ section, claim });
  }
  for (const section of ['limitations', 'risks'] as const) {
    for (const claim of narrative[section]) result.push({ section, claim });
  }
  return result.sort((left, right) => left.section.localeCompare(right.section) || left.claim.localeCompare(right.claim));
}

function canonicalWiki(wiki: RepositoryModuleWikiDraft): RepositoryModuleWikiDraft {
  const evidenceIds = sortedUnique(wiki.evidenceIds.map((id) => normalizeRequired(id, 'Repository Wiki evidence ID')));
  return {
    summary: normalizeRequired(wiki.summary, 'Repository Wiki summary'),
    architecture: normalizeText(wiki.architecture),
    publicInterfaces: normalizeText(wiki.publicInterfaces),
    dataFlow: normalizeText(wiki.dataFlow),
    operationalNotes: normalizeText(wiki.operationalNotes),
    reuseGuidance: normalizeText(wiki.reuseGuidance),
    limitations: canonicalTextList(wiki.limitations),
    risks: canonicalTextList(wiki.risks),
    evidenceIds,
    ...(wiki.tags === undefined ? {} : { tags: canonicalTextList(wiki.tags) }),
  };
}

function canonicalGeneration(generation: RepositoryModuleSummaryGeneration): RepositoryModuleSummaryGeneration {
  return {
    modelId: normalizeRequired(generation.modelId, 'Summary model ID'),
    promptTemplateId: normalizeRequired(generation.promptTemplateId, 'Summary prompt template ID'),
    promptTemplateVersion: normalizeRequired(generation.promptTemplateVersion, 'Summary prompt template version'),
    ...(generation.toolVersion === undefined ? {} : { toolVersion: normalizeRequired(generation.toolVersion, 'Summary tool version') }),
  };
}

function materializeWikiRevisionLineage(
  evidenceBundle: RepositoryModuleEvidenceBundle,
  previousProposal: RepositoryModuleWikiProposal | undefined,
  reviseReview: RepositoryModuleKnowledgeReview | undefined,
  successorCreatedAt: string,
): RepositoryModuleWikiRevisionLineage | undefined {
  if ((previousProposal === undefined) !== (reviseReview === undefined)) {
    throw new Error('Repository Wiki revision requires both the previous proposal and its revise review.');
  }
  if (previousProposal === undefined || reviseReview === undefined) return undefined;
  validateRepositoryModuleWikiProposal(previousProposal, evidenceBundle);
  validateRepositoryModuleKnowledgeReview(reviseReview, previousProposal, evidenceBundle);
  if (reviseReview.decision !== 'revise' || !reviseReview.replacementProposalRequired) {
    throw new Error('Repository Wiki successor requires an explicit revise review.');
  }
  assertTimestamp(successorCreatedAt, 'Repository Wiki successor creation time');
  if (Date.parse(successorCreatedAt) < Date.parse(reviseReview.reviewedAt)) {
    throw new Error('Repository Wiki successor cannot precede its revise review.');
  }
  return canonicalWikiRevisionLineage({
    previousProposalId: previousProposal.id,
    previousProposalHash: previousProposal.contentHash,
    reviseReviewId: reviseReview.id,
    reviseReviewHash: reviseReview.contentHash,
  });
}

function canonicalWikiRevisionLineage(
  revision: RepositoryModuleWikiRevisionLineage,
): RepositoryModuleWikiRevisionLineage {
  requireSha256(revision.previousProposalHash, 'Previous Wiki proposal hash');
  requireSha256(revision.reviseReviewHash, 'Revise review hash');
  return {
    previousProposalId: normalizeRequired(revision.previousProposalId, 'Previous Wiki proposal ID'),
    previousProposalHash: revision.previousProposalHash,
    reviseReviewId: normalizeRequired(revision.reviseReviewId, 'Revise review ID'),
    reviseReviewHash: revision.reviseReviewHash,
  };
}

function assertKnowledgeReviewDecision(decision: string): asserts decision is RepositoryModuleKnowledgeReviewDecision {
  if (decision !== 'accept' && decision !== 'revise' && decision !== 'reject') {
    throw new Error(`Unsupported repository knowledge review decision: ${decision}`);
  }
}

export function validateRepositoryModuleBundleEnvelope(bundle: RepositoryModuleBundle): void {
  if (bundle.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error('Repository module bundle uses an unsupported schema version.');
  }
  if (bundle.producer.kind !== 'ingestion-host') {
    throw new Error('Repository module bundle must be produced by the ingestion host.');
  }
  requireSha256(bundle.contentHash, 'Repository module bundle content hash');
  requireSha256(bundle.repositoryContentHash, 'Repository module bundle repository hash');
  const { id, contentHash, ...payload } = bundle;
  const expectedHash = sha256Hex(canonicalJson(payload));
  if (contentHash !== expectedHash || id !== `repository-module-bundle:${expectedHash.slice(0, 24)}`) {
    throw new Error('Repository module bundle ID or content hash does not match its payload.');
  }
}

function validateReviewedKnowledgePageEnvelope(page: RepositoryModuleKnowledgePage): void {
  if (
    page.schemaVersion !== repositoryIngestionSchemaVersion ||
    page.summarySchemaVersion !== repositoryModuleSummarySchemaVersion ||
    page.boundaryStatus !== 'reviewed' ||
    page.narrativeStatus !== 'reviewed' ||
    page.verificationStatus !== 'unverified' ||
    page.trustTier !== 'reviewed' ||
    page.producer.kind !== 'knowledge-publisher'
  ) {
    throw new Error(`Repository publication page has an invalid reviewed lifecycle: ${page.moduleId}`);
  }
  assertTimestamp(page.createdAt, 'Repository knowledge page creation time');
  requireSha256(page.source.unifiedRepositoryIrHash, 'Knowledge page source IR hash');
  requireSha256(page.source.moduleCatalogHash, 'Knowledge page source catalog hash');
  requireSha256(page.contentHash, 'Knowledge page content hash');
  const { id, contentHash, ...payload } = page;
  const expectedHash = sha256Hex(canonicalJson(payload));
  if (contentHash !== expectedHash ||
      id !== `repository-module-knowledge:${page.moduleId}:${expectedHash.slice(0, 24)}`) {
    throw new Error(`Repository publication page content hash is invalid: ${page.moduleId}`);
  }
}

function canonicalScope(scope: RepositoryKnowledgePublicationScope): RepositoryKnowledgePublicationScope {
  return {
    repositoryId: normalizeRequired(scope.repositoryId, 'Knowledge publication repository ID'),
    channel: normalizeRequired(scope.channel, 'Knowledge publication channel'),
  };
}

function canonicalRepositoryScopes(values: readonly string[], repositoryId: string): string[] {
  const scopes = sortedUnique(values.map((value) =>
    normalizeRequired(value, 'Knowledge publication repository ACL scope'),
  ));
  if (!scopes.includes(repositoryId)) {
    throw new Error('Knowledge publication ACL scopes must include its repository ID.');
  }
  return scopes;
}

function canonicalArtifactRefs(refs: readonly RepositoryIngestionArtifactRef[]): RepositoryIngestionArtifactRef[] {
  const result = refs.map((ref) => {
    requireSha256(ref.contentHash, `Knowledge publication artifact ${ref.id} hash`);
    if (ref.path === undefined) throw new Error(`Knowledge publication artifact requires an immutable path: ${ref.id}`);
    normalizeRepositoryPath(ref.path);
    return {
      ...ref,
      hashAlgorithm: ref.hashAlgorithm ?? 'sha256' as const,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assertUniqueBy(result, (ref) => ref.id, 'Knowledge publication artifact ID');
  assertUniqueBy(result, (ref) => ref.path!, 'Knowledge publication artifact path');
  return result;
}

function assertPublicationArtifacts(
  artifacts: readonly RepositoryIngestionArtifactRef[],
  knowledgePageIds: readonly string[],
): void {
  const formats = new Set(artifacts.map((artifact) => artifact.mediaType));
  if (!formats.has('application/schema+json') || !formats.has('application/x-ndjson')) {
    throw new Error('Knowledge publication requires machine JSON Schema and reviewed JSONL artifacts.');
  }
  for (const pageId of knowledgePageIds) {
    if (!artifacts.some((artifact) => artifact.id === `${pageId}:json`) ||
        !artifacts.some((artifact) => artifact.id === `${pageId}:markdown`)) {
      throw new Error(`Knowledge publication lacks reviewed JSON/Markdown artifacts for ${pageId}.`);
    }
  }
}

function contentAddressedPublication(
  payload: Omit<RepositoryKnowledgePublication, 'contentHash'>,
): RepositoryKnowledgePublication {
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

function contentAddressedIndexReceipt(
  payload: Omit<RepositoryModuleIndexReceipt, 'contentHash'>,
): RepositoryModuleIndexReceipt {
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

function contentAddressedHead(
  payload: Omit<RepositoryKnowledgePublicationHead, 'contentHash'>,
): RepositoryKnowledgePublicationHead {
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

function contentAddressedBatch(payload: Omit<RepositoryImportBatch, 'contentHash'>): RepositoryImportBatch {
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

function assertReceiptMatchesPublication(
  receipt: RepositoryModuleIndexReceipt,
  publication: RepositoryKnowledgePublication,
): void {
  if (
    receipt.publicationId !== publication.id ||
    receipt.publicationPayloadHash !== publication.payloadHash ||
    receipt.generation !== publication.generation ||
    canonicalJson(receipt.scope) !== canonicalJson(publication.scope)
  ) {
    throw new Error('Module index receipt does not match its knowledge publication.');
  }
  const expectedModuleIds = publication.source.modules.map((module) => module.moduleId).sort();
  if (receipt.documentCount !== expectedModuleIds.length ||
      canonicalJson(receipt.moduleIds) !== canonicalJson(expectedModuleIds)) {
    throw new Error('Module index receipt does not cover the publication module set.');
  }
}

function assertHeadCas(
  currentHead: RepositoryKnowledgePublicationHead | undefined,
  expectedHeadHash: string | undefined,
  scope: RepositoryKnowledgePublicationScope,
): void {
  if (!currentHead) {
    if (expectedHeadHash !== undefined) {
      throw new Error('Knowledge publication CAS expected a head that does not exist.');
    }
    return;
  }
  validateRepositoryKnowledgePublicationHead(currentHead);
  if (canonicalJson(currentHead.scope) !== canonicalJson(scope)) {
    throw new Error('Knowledge publication CAS head scope does not match.');
  }
  if (expectedHeadHash !== currentHead.contentHash) {
    throw new Error('Knowledge publication CAS head is stale.');
  }
}

function canonicalBatchItem(item: RepositoryImportBatchItem): RepositoryImportBatchItem {
  assertSafeIdentifier(item.id, 'Repository import batch item ID');
  requireSha256(item.ingestionManifestHash, 'Repository import manifest hash');
  const scope = canonicalScope(item.scope);
  if (item.status === 'failed') {
    if (!item.failure || item.publicationId || item.publicationHash) {
      throw new Error('Failed repository import batch item has invalid outcome fields.');
    }
  } else if (item.status === 'pending') {
    if (item.failure || item.publicationId || item.publicationHash) {
      throw new Error('Pending repository import batch item cannot contain an outcome.');
    }
  } else {
    if (!item.publicationId || !item.publicationHash || item.failure) {
      throw new Error('Successful repository import batch item requires a publication reference.');
    }
    requireSha256(item.publicationHash, 'Repository import publication hash');
  }
  return {
    id: item.id,
    scope,
    ingestionManifestId: normalizeRequired(item.ingestionManifestId, 'Repository ingestion manifest ID'),
    ingestionManifestHash: item.ingestionManifestHash,
    status: item.status,
    ...(item.publicationId === undefined ? {} : { publicationId: normalizeRequired(item.publicationId, 'Repository publication ID') }),
    ...(item.publicationHash === undefined ? {} : { publicationHash: item.publicationHash }),
    ...(item.failure === undefined ? {} : {
      failure: {
        code: normalizeRequired(item.failure.code, 'Repository import failure code'),
        message: normalizeRequired(item.failure.message, 'Repository import failure message'),
        retryable: item.failure.retryable,
      },
    }),
  };
}

function canonicalProducer(producer: RepositoryArtifactProducer): RepositoryArtifactProducer {
  return {
    kind: producer.kind,
    id: normalizeRequired(producer.id, 'Artifact producer ID'),
    ...(producer.version === undefined ? {} : { version: normalizeRequired(producer.version, 'Artifact producer version') }),
    ...(producer.configurationHash === undefined
      ? {}
      : { configurationHash: normalizeRequired(producer.configurationHash, 'Artifact producer configuration hash') }),
  };
}

function canonicalRange(range: RepositoryModuleEvidenceItem['range']): NonNullable<RepositoryModuleEvidenceItem['range']> {
  if (!range) throw new Error('Repository evidence source range is required.');
  if (!Number.isInteger(range.startLine) || range.startLine < 1 ||
      (range.endLine !== undefined && (!Number.isInteger(range.endLine) || range.endLine < range.startLine))) {
    throw new Error('Repository evidence source range is invalid.');
  }
  return {
    path: normalizeRepositoryPath(range.path),
    startLine: range.startLine,
    ...(range.startColumn === undefined ? {} : { startColumn: range.startColumn }),
    ...(range.endLine === undefined ? {} : { endLine: range.endLine }),
    ...(range.endColumn === undefined ? {} : { endColumn: range.endColumn }),
  };
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Repository path must be normalized and relative: ${value}`);
  }
  return normalized;
}

function canonicalTextList(values: readonly string[]): string[] {
  return sortedUnique(values.map((value) => normalizeRequired(value, 'Text list item')));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function assertTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function requireSha256(value: string, label: string): void {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be lowercase SHA-256.`);
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!safeIdentifier.test(value)) throw new Error(`${label} is invalid.`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function assertUniqueBy<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`${label} is duplicated: ${value}`);
    seen.add(value);
  }
}

function uniqueMap<T>(items: readonly T[], key: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    result.set(id, item);
  }
  return result;
}

function withoutContentHash<T extends { contentHash: string }>(value: T): Omit<T, 'contentHash'> {
  const { contentHash: _contentHash, ...rest } = value;
  return rest;
}

function scopeKey(scope: RepositoryKnowledgePublicationScope): string {
  return `${scope.repositoryId}\u0000${scope.channel}`;
}
