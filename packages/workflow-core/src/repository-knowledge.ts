import type {
  ApplyRepositoryModuleReviewResult,
  AnalysisCapability,
  IndexedModuleKnowledgeDocument,
  ModuleDiscoveryProposal,
  RepositoryApiSurface,
  RepositoryArtifactProducer,
  RepositoryDiagnostic,
  RepositoryDiscoveredModule,
  RepositoryEvidenceRef,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionEvent,
  RepositoryKnowledgeArtifact,
  RepositoryKnowledgePublication,
  RepositoryModuleCatalog,
  RepositoryModuleBundle,
  RepositoryModuleAssignment,
  RepositoryModuleDependency,
  RepositoryModuleKnowledgePage,
  RepositoryModuleKnowledgeRawFacts,
  RepositoryModuleReview,
  RepositoryModuleWikiDraft,
  RepositorySourceRange,
  SerializedRepositoryKnowledgeArtifact,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  repositoryIngestionSchemaVersion,
  repositoryModuleSummarySchemaVersion,
} from '@forexplore/contracts';
import { canonicalJson, sha256Hex, sortedUnique } from './module-plan-utils';

export const repositoryModuleKnowledgeRoot = '.forexplore/modules';
export const repositoryModuleKnowledgeIndexPath = `${repositoryModuleKnowledgeRoot}/index.md`;
export const repositoryModuleKnowledgeJsonlPath =
  `${repositoryModuleKnowledgeRoot}/module-search-index.jsonl`;
export const repositoryModuleKnowledgeLogPath = `${repositoryModuleKnowledgeRoot}/log.md`;
export const repositoryModuleKnowledgeSchemaPath = `${repositoryModuleKnowledgeRoot}/schema.md`;
export const repositoryModuleKnowledgeJsonSchemaPath =
  `${repositoryModuleKnowledgeRoot}/summary.schema.json`;

export interface MaterializeRepositoryModuleKnowledgeInput {
  catalog: RepositoryModuleCatalog;
  ir: UnifiedRepositoryIR;
  moduleId: string;
  wiki: RepositoryModuleWikiDraft;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export interface MaterializeRepositoryModuleCatalogOptions {
  producer: RepositoryArtifactProducer;
  createdAt: string;
  updatedAt?: string;
  /** @deprecated Reviews are applied with `applyRepositoryModuleReview`. */
  review?: RepositoryModuleReview;
}

export interface MaterializeRepositoryModuleReviewInput {
  decision: RepositoryModuleReview['decision'];
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
  decidedAt: string;
}

export interface MaterializeRepositoryModuleBundleInput {
  proposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
  ir: UnifiedRepositoryIR;
  knowledgePages: RepositoryModuleKnowledgePage[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

const safeModuleId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

/**
 * Turns a read-only Agent proposal into a host-owned draft catalog. Human
 * decisions are immutable artifacts of their own and must be applied through
 * `applyRepositoryModuleReview`; this function can never activate a catalog.
 */
export function materializeRepositoryModuleCatalog(
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  options: MaterializeRepositoryModuleCatalogOptions,
): RepositoryModuleCatalog {
  validateModuleDiscoveryProposalBindings(proposal, ir);
  assertTimestamp(options.createdAt, 'Module catalog creation time');
  if (options.review !== undefined) {
    throw new Error('Repository module catalogs are drafted before review; use applyRepositoryModuleReview.');
  }
  const updatedAt = options.updatedAt ?? options.createdAt;
  assertTimestamp(updatedAt, 'Module catalog update time');
  if (Date.parse(options.createdAt) < Date.parse(proposal.createdAt)) {
    throw new Error('Module catalog creation time cannot precede its discovery proposal.');
  }
  if (Date.parse(updatedAt) < Date.parse(options.createdAt)) {
    throw new Error('Module catalog update time cannot precede its creation time.');
  }

  const payload = catalogPayload(proposal, ir, {
    producer: options.producer,
    createdAt: options.createdAt,
    updatedAt,
    status: 'draft',
  });
  return contentAddressedCatalog(payload);
}

/** Materialize one immutable, content-addressed human decision. */
export function materializeRepositoryModuleReview(
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  input: MaterializeRepositoryModuleReviewInput,
): RepositoryModuleReview {
  validateModuleDiscoveryProposalBindings(proposal, ir);
  assertTimestamp(input.decidedAt, 'Module review decision time');
  if (Date.parse(input.decidedAt) < Date.parse(proposal.createdAt)) {
    throw new Error('Module review cannot precede its discovery proposal.');
  }
  assertReviewDecision(input.decision);
  const acceptedRiskIds = input.acceptedRiskIds === undefined
    ? undefined
    : sortedUnique(input.acceptedRiskIds.map((id) => normalizeRequiredText(id, 'Accepted risk ID')));
  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    proposalId: proposal.id,
    proposalHash: proposal.contentHash,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    decision: input.decision,
    reviewerId: normalizeRequiredText(input.reviewerId, 'Module reviewer ID'),
    ...(input.comment === undefined ? {} : { comment: normalizeText(input.comment) }),
    ...(acceptedRiskIds === undefined ? {} : { acceptedRiskIds }),
    replacementProposalRequired: input.decision === 'revise',
    decidedAt: input.decidedAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-review:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

/**
 * Apply an immutable review. Only acceptance creates a new active catalog;
 * revise/reject preserve the review result without creating a catalog.
 */
export function applyRepositoryModuleReview(
  draft: RepositoryModuleCatalog,
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  review: RepositoryModuleReview,
): ApplyRepositoryModuleReviewResult {
  validateModuleDiscoveryProposalBindings(proposal, ir);
  validateRepositoryModuleReview(review, proposal, ir);
  const expectedDraft = materializeRepositoryModuleCatalog(proposal, ir, {
    producer: draft.producer,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
  if (canonicalJson(draft) !== canonicalJson(expectedDraft) || draft.status !== 'draft') {
    throw new Error('Module review can only be applied to the deterministic draft catalog.');
  }
  if (Date.parse(review.decidedAt) < Date.parse(draft.updatedAt)) {
    throw new Error('Module review cannot be applied before the draft catalog exists.');
  }
  if (review.decision !== 'accept') {
    return {
      review,
      replacementProposalRequired: review.replacementProposalRequired,
    };
  }
  const payload = catalogPayload(proposal, ir, {
    producer: draft.producer,
    createdAt: draft.createdAt,
    updatedAt: review.decidedAt,
    status: 'active',
    review,
  });
  return {
    review,
    catalog: contentAddressedCatalog(payload),
    replacementProposalRequired: false,
  };
}

export function validateRepositoryModuleReview(
  review: RepositoryModuleReview,
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
): void {
  if (review.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error('Repository module review uses an unsupported schema version.');
  }
  const expected = materializeRepositoryModuleReview(proposal, ir, {
    decision: review.decision,
    reviewerId: review.reviewerId,
    ...(review.comment === undefined ? {} : { comment: review.comment }),
    ...(review.acceptedRiskIds === undefined ? {} : { acceptedRiskIds: review.acceptedRiskIds }),
    decidedAt: review.decidedAt,
  });
  if (canonicalJson(review) !== canonicalJson(expected)) {
    throw new Error('Repository module review does not match its immutable proposal and IR sources.');
  }
}

interface CatalogPayloadOptions {
  producer: RepositoryArtifactProducer;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'active';
  review?: Pick<RepositoryModuleReview, 'id' | 'contentHash' | 'decision'>;
}

function catalogPayload(
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  options: CatalogPayloadOptions,
): Omit<RepositoryModuleCatalog, 'id' | 'contentHash'> {
  if (options.status === 'active' && options.review?.decision !== 'accept') {
    throw new Error('An active repository module catalog requires an accepted review.');
  }
  if (options.status === 'draft' && options.review !== undefined) {
    throw new Error('A draft repository module catalog cannot bind a review.');
  }
  const modules = proposal.modules
    .map(canonicalDiscoveredModule)
    .sort((left, right) => left.id.localeCompare(right.id));
  const assignments = proposal.assignments
    .map(canonicalModuleAssignment)
    .sort((left, right) => left.fileId.localeCompare(right.fileId));
  const dependencies = proposal.dependencies
    .map(canonicalModuleDependency)
    .sort(compareModuleDependencies);
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    sourceProposalId: proposal.id,
    sourceProposalHash: proposal.contentHash,
    status: options.status,
    modules,
    assignments,
    dependencies,
    unassignedFileIds: assignments
      .filter((assignment) => assignment.kind === 'unassigned')
      .map((assignment) => assignment.fileId),
    overlappingFileIds: assignments
      .filter((assignment) => assignment.moduleIds.length > 1)
      .map((assignment) => assignment.fileId),
    ...(options.review === undefined
      ? {}
      : { reviewId: options.review.id, reviewHash: options.review.contentHash }),
    producer: canonicalProducer(options.producer),
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}

function contentAddressedCatalog(
  payload: Omit<RepositoryModuleCatalog, 'id' | 'contentHash'>,
): RepositoryModuleCatalog {
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-catalog:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

function assertCatalogProjectionMatchesProposal(
  catalog: RepositoryModuleCatalog,
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
): void {
  assertCatalogMatchesIr(catalog, ir);
  if (catalog.sourceProposalId !== proposal.id || catalog.sourceProposalHash !== proposal.contentHash) {
    throw new Error('Repository module catalog does not bind to the supplied proposal hash.');
  }
  if (catalog.status !== 'draft' && catalog.status !== 'active') {
    throw new Error(`Repository module catalog is not current: ${catalog.status}.`);
  }
  const review = catalog.status === 'active'
    ? {
        id: normalizeRequiredText(catalog.reviewId ?? '', 'Catalog review ID'),
        contentHash: requireSha256(catalog.reviewHash, 'Catalog review hash'),
        decision: 'accept' as const,
      }
    : undefined;
  const expected = contentAddressedCatalog(catalogPayload(proposal, ir, {
    producer: catalog.producer,
    createdAt: catalog.createdAt,
    updatedAt: catalog.updatedAt,
    status: catalog.status,
    ...(review === undefined ? {} : { review }),
  }));
  if (canonicalJson(catalog) !== canonicalJson(expected)) {
    throw new Error('Repository module catalog differs from its deterministic proposal projection.');
  }
}

/**
 * Deterministic first wiki draft. This is a constrained projection of the
 * discovery proposal and IR, not a second model call or a new source of facts.
 */
export function deriveInitialRepositoryModuleWikiDraft(
  proposal: ModuleDiscoveryProposal,
  catalog: RepositoryModuleCatalog,
  ir: UnifiedRepositoryIR,
  moduleId: string,
): RepositoryModuleWikiDraft {
  validateModuleDiscoveryProposalBindings(proposal, ir);
  assertCatalogMatchesIr(catalog, ir);
  if (catalog.sourceProposalId !== proposal.id) {
    throw new Error('Repository module catalog does not bind to the supplied discovery proposal.');
  }
  assertCatalogProjectionMatchesProposal(catalog, proposal, ir);
  const module = catalog.modules.find((candidate) => candidate.id === moduleId);
  const proposedModule = proposal.modules.find((candidate) => candidate.id === moduleId);
  if (!module || !proposedModule) throw new Error(`Unknown repository module: ${moduleId}`);
  if (canonicalJson(canonicalDiscoveredModule(module)) !==
      canonicalJson(canonicalDiscoveredModule(proposedModule))) {
    throw new Error(`Repository module ${moduleId} differs from its discovery proposal.`);
  }
  assertModuleReferences(module, catalog, ir);

  const publicApiIds = new Set(module.publicApiEntityIds);
  const publicInterfaces = ir.apiSurfaces
    .filter((surface) => publicApiIds.has(surface.entityId))
    .map((surface) => normalizeRequiredText(surface.signature, 'Public interface signature'))
    .sort((left, right) => left.localeCompare(right));
  const dependencies = catalog.dependencies
    .filter((dependency) =>
      dependency.sourceModuleId === module.id || dependency.targetModuleId === module.id,
    )
    .map(canonicalModuleDependency)
    .sort(compareModuleDependencies);
  const evidenceIds = sortedUnique([
    ...module.evidenceRefs.map((evidence) => evidence.id),
    ...module.publicApiEntityIds,
    ...ir.apiSurfaces
      .filter((surface) => module.entityIds.includes(surface.entityId))
      .map((surface) => surface.id),
    ...dependencies.flatMap((dependency) =>
      dependency.evidenceRefs.map((evidence) => evidence.id),
    ),
  ]);

  return canonicalWiki({
    summary: module.description,
    architecture: module.boundaryRationale,
    publicInterfaces: publicInterfaces.join('\n'),
    dataFlow: dependencies.map((dependency) =>
      `${dependency.sourceModuleId} -> ${dependency.targetModuleId} (${dependency.kind})`,
    ).join('\n'),
    operationalNotes: '',
    reuseGuidance: [
      ...(module.businessCapabilities.length === 0
        ? []
        : [`Business capabilities: ${canonicalTextList(module.businessCapabilities).join('; ')}`]),
      ...(module.responsibilities.length === 0
        ? []
        : [`Responsibilities: ${canonicalTextList(module.responsibilities).join('; ')}`]),
    ].join('\n'),
    limitations: [
      ...proposal.assumptions.map((value) => `Assumption: ${value}`),
      ...proposal.unresolvedQuestions.map((value) => `Unresolved: ${value}`),
    ],
    // RepositoryDiscoveredModule currently has no module-local risk field, so
    // the proposal's evidence-bounded risks are the complete contractual input.
    risks: proposal.risks,
    evidenceIds,
    tags: module.tags,
  });
}

export function repositoryModuleKnowledgeJsonPath(moduleId: string): string {
  assertSafeModuleId(moduleId);
  return `${repositoryModuleKnowledgeRoot}/${moduleId}/summary.json`;
}

export function repositoryModuleKnowledgeMarkdownPath(moduleId: string): string {
  assertSafeModuleId(moduleId);
  return `${repositoryModuleKnowledgeRoot}/${moduleId}/summary.md`;
}

export function materializeRepositoryModuleKnowledgePage(
  input: MaterializeRepositoryModuleKnowledgeInput,
): RepositoryModuleKnowledgePage {
  assertCatalogMatchesIr(input.catalog, input.ir);
  assertTimestamp(input.createdAt, 'Knowledge page creation time');
  if (Date.parse(input.createdAt) < Date.parse(input.catalog.updatedAt)) {
    throw new Error('Repository module knowledge cannot precede its source catalog.');
  }
  if (
    input.producer.kind !== 'module-discovery-agent' &&
    input.producer.kind !== 'module-summary-agent' &&
    input.producer.kind !== 'human'
  ) {
    throw new Error('Repository wiki narrative must be maintained by a module Summary Agent or human.');
  }
  const module = input.catalog.modules.find((item) => item.id === input.moduleId);
  if (!module) throw new Error(`Unknown repository module: ${input.moduleId}`);
  assertSafeModuleId(module.id);
  assertModuleReferences(module, input.catalog, input.ir);

  const raw = canonicalRawFacts(module, input.catalog.dependencies, input.ir);
  const wiki = canonicalWiki(input.wiki);
  const knownEvidenceIds = collectKnownEvidenceIds(module, raw.dependencies, input.ir);
  for (const evidenceId of wiki.evidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      throw new Error(`Repository wiki cites unknown immutable evidence: ${evidenceId}`);
    }
  }

  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    summarySchemaVersion: repositoryModuleSummarySchemaVersion,
    repositoryId: input.catalog.repositoryId,
    moduleId: module.id,
    source: {
      unifiedRepositoryIrId: input.ir.id,
      unifiedRepositoryIrHash: input.ir.contentHash,
      moduleCatalogId: input.catalog.id,
      moduleCatalogHash: input.catalog.contentHash,
    },
    boundaryStatus: input.catalog.status === 'active' ? 'reviewed' as const : 'proposed' as const,
    narrativeStatus: 'generated' as const,
    verificationStatus: 'unverified' as const,
    // Legacy projection follows narrative trust, never boundary acceptance.
    trustTier: 'discovered' as const,
    raw,
    wiki,
    producer: canonicalProducer(input.producer),
    createdAt: input.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-knowledge:${module.id}:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function validateRepositoryModuleKnowledgePage(
  page: RepositoryModuleKnowledgePage,
  catalog: RepositoryModuleCatalog,
  ir: UnifiedRepositoryIR,
): void {
  assertCatalogMatchesIr(catalog, ir);
  if (
    page.schemaVersion !== repositoryIngestionSchemaVersion ||
    page.summarySchemaVersion !== repositoryModuleSummarySchemaVersion
  ) {
    throw new Error('Repository module knowledge page uses an unsupported schema version.');
  }
  assertTimestamp(page.createdAt, 'Knowledge page creation time');
  if (Date.parse(page.createdAt) < Date.parse(catalog.updatedAt)) {
    throw new Error('Repository module knowledge cannot precede its source catalog.');
  }
  const module = catalog.modules.find((item) => item.id === page.moduleId);
  if (!module) throw new Error(`Unknown repository module: ${page.moduleId}`);
  assertModuleReferences(module, catalog, ir);
  const expectedRaw = canonicalRawFacts(module, catalog.dependencies, ir);
  const expectedWiki = canonicalWiki(page.wiki);
  if (canonicalJson(page.raw) !== canonicalJson(expectedRaw) ||
      canonicalJson(page.wiki) !== canonicalJson(expectedWiki)) {
    throw new Error('Repository module knowledge page does not match its immutable sources or content hash.');
  }
  if (
    page.repositoryId !== catalog.repositoryId ||
    page.source.unifiedRepositoryIrId !== ir.id ||
    page.source.unifiedRepositoryIrHash !== ir.contentHash ||
    page.source.moduleCatalogId !== catalog.id ||
    page.source.moduleCatalogHash !== catalog.contentHash
  ) {
    throw new Error('Repository module knowledge page does not match its immutable sources or content hash.');
  }
  const knownEvidenceIds = collectKnownEvidenceIds(module, expectedRaw.dependencies, ir);
  for (const evidenceId of page.wiki.evidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      throw new Error(`Repository wiki cites unknown immutable evidence: ${evidenceId}`);
    }
  }
  if (page.verificationStatus !== 'unverified') {
    throw new Error('Repository knowledge verification cannot advance without an independent verification artifact.');
  }
  if (page.narrativeStatus === 'generated') {
    if (page.trustTier !== 'discovered') {
      throw new Error('Generated repository narrative cannot be projected as reviewed or verified.');
    }
    if (
      page.source.evidenceBundleId !== undefined ||
      page.source.evidenceBundleHash !== undefined ||
      page.source.wikiProposalId !== undefined ||
      page.source.wikiProposalHash !== undefined ||
      page.source.knowledgeReviewId !== undefined ||
      page.source.knowledgeReviewHash !== undefined
    ) {
      throw new Error('Generated repository narrative cannot claim a completed summary review gate.');
    }
    if (
      page.producer.kind !== 'module-discovery-agent' &&
      page.producer.kind !== 'module-summary-agent' &&
      page.producer.kind !== 'human'
    ) {
      throw new Error('Generated repository narrative has an invalid producer.');
    }
  } else {
    if (
      page.boundaryStatus !== 'reviewed' ||
      catalog.status !== 'active' ||
      page.trustTier !== 'reviewed' ||
      page.producer.kind !== 'knowledge-publisher' ||
      page.source.evidenceBundleId === undefined ||
      page.source.evidenceBundleHash === undefined ||
      page.source.wikiProposalId === undefined ||
      page.source.wikiProposalHash === undefined ||
      page.source.knowledgeReviewId === undefined ||
      page.source.knowledgeReviewHash === undefined
    ) {
      throw new Error('Reviewed repository narrative requires the complete independent summary review closure.');
    }
  }
  const expectedBoundaryStatus = catalog.status === 'active' ? 'reviewed' : 'proposed';
  if (page.boundaryStatus !== expectedBoundaryStatus) {
    throw new Error('Repository knowledge boundary status does not match its source catalog.');
  }
  const { id, contentHash, ...payload } = page;
  const expectedHash = sha256Hex(canonicalJson(payload));
  if (
    contentHash !== expectedHash ||
    id !== `repository-module-knowledge:${page.moduleId}:${expectedHash.slice(0, 24)}`
  ) {
    throw new Error('Repository module knowledge page does not match its immutable sources or content hash.');
  }
}

/** Materialize the reviewed, task-neutral root artifact for one repository snapshot. */
export function materializeRepositoryModuleBundle(
  input: MaterializeRepositoryModuleBundleInput,
): RepositoryModuleBundle {
  validateModuleDiscoveryProposalBindings(input.proposal, input.ir);
  validateRepositoryModuleReview(input.review, input.proposal, input.ir);
  if (input.review.decision !== 'accept') {
    throw new Error('Repository module bundle requires an accepted module review.');
  }
  assertCatalogProjectionMatchesProposal(input.catalog, input.proposal, input.ir);
  if (
    input.catalog.status !== 'active' ||
    input.catalog.reviewId !== input.review.id ||
    input.catalog.reviewHash !== input.review.contentHash
  ) {
    throw new Error('Repository module bundle requires the active catalog produced by its accepted review.');
  }
  assertTimestamp(input.createdAt, 'Repository module bundle creation time');
  if (Date.parse(input.createdAt) < Date.parse(input.review.decidedAt)) {
    throw new Error('Repository module bundle cannot precede its accepted review.');
  }

  assertKnowledgePageSet(input.knowledgePages);
  const pages = input.knowledgePages
    .map((page) => {
      validateRepositoryModuleKnowledgePage(page, input.catalog, input.ir);
      if (page.boundaryStatus !== 'reviewed') {
        throw new Error(`Repository module bundle page boundary is not reviewed: ${page.moduleId}`);
      }
      if (Date.parse(page.createdAt) > Date.parse(input.createdAt)) {
        throw new Error(`Repository module bundle cannot precede knowledge page: ${page.moduleId}`);
      }
      return canonicalClone(page);
    })
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  const catalogModuleIds = input.catalog.modules.map((module) => module.id).sort();
  const pageModuleIds = pages.map((page) => page.moduleId).sort();
  if (canonicalJson(catalogModuleIds) !== canonicalJson(pageModuleIds)) {
    throw new Error('Repository module bundle requires exactly one reviewed knowledge page per catalog module.');
  }

  const payload = {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: input.ir.repositoryId,
    ...(input.ir.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: input.ir.repositoryRevision }),
    repositoryContentHash: input.ir.repositoryContentHash,
    source: {
      unifiedRepositoryIrId: input.ir.id,
      unifiedRepositoryIrHash: input.ir.contentHash,
      moduleProposalId: input.proposal.id,
      moduleProposalHash: input.proposal.contentHash,
      moduleReviewId: input.review.id,
      moduleReviewHash: input.review.contentHash,
      moduleCatalogId: input.catalog.id,
      moduleCatalogHash: input.catalog.contentHash,
    },
    capabilities: canonicalCapabilities(input.ir.capabilities),
    coverage: canonicalCoverage(input.ir.coverage),
    diagnostics: canonicalRepositoryDiagnostics(input.ir.diagnostics),
    modules: input.catalog.modules.map(canonicalDiscoveredModule)
      .sort((left, right) => left.id.localeCompare(right.id)),
    assignments: input.catalog.assignments.map(canonicalModuleAssignment)
      .sort((left, right) => left.fileId.localeCompare(right.fileId)),
    moduleDependencies: input.catalog.dependencies.map(canonicalModuleDependency)
      .sort(compareModuleDependencies),
    files: canonicalIrFiles(input.ir.files),
    entities: canonicalIrEntities(input.ir.entities),
    irDependencies: canonicalIrDependencies(input.ir.dependencies),
    apiSurfaces: canonicalApiSurfaces(input.ir.apiSurfaces),
    knowledgePages: pages,
    producer: canonicalProducer(input.producer),
    createdAt: input.createdAt,
  };
  const contentHash = sha256Hex(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-bundle:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function validateRepositoryModuleBundle(
  bundle: RepositoryModuleBundle,
  sources: Omit<MaterializeRepositoryModuleBundleInput, 'producer' | 'createdAt'>,
): void {
  if (bundle.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error('Repository module bundle uses an unsupported schema version.');
  }
  const expected = materializeRepositoryModuleBundle({
    ...sources,
    producer: bundle.producer,
    createdAt: bundle.createdAt,
  });
  if (canonicalJson(bundle) !== canonicalJson(expected)) {
    throw new Error('Repository module bundle does not match its immutable source closure or content hash.');
  }
}

export function serializeRepositoryModuleKnowledgeJson(
  page: RepositoryModuleKnowledgePage,
): string {
  if (!sha256Pattern.test(page.contentHash)) {
    throw new Error('Repository module knowledge content hash must be lowercase SHA-256.');
  }
  return `${canonicalJson(page)}\n`;
}

export function serializeRepositoryModuleKnowledgeMarkdown(
  page: RepositoryModuleKnowledgePage,
): string {
  const lines = [
    `# ${markdownText(page.raw.name)}`,
    '',
    `> Module \`${page.moduleId}\` · ${page.raw.kind} · knowledge \`${page.contentHash}\``,
    '',
    '## Summary',
    '',
    page.wiki.summary,
    '',
    '## Responsibilities',
    '',
    ...markdownList(page.raw.responsibilities),
    '',
    '## Business capabilities',
    '',
    ...markdownList(page.raw.businessCapabilities),
    '',
    '## Languages',
    '',
    ...markdownList(page.raw.languageIds),
    '',
    '## Files',
    '',
    ...markdownList(page.raw.filePaths.map((filePath) => `\`${filePath}\``)),
    '',
    '## Architecture',
    '',
    page.wiki.architecture || '_None recorded._',
    '',
    '## Public interfaces',
    '',
    ...markdownList(page.raw.publicApiSignatures.map((signature) => `\`${signature}\``)),
    '',
    page.wiki.publicInterfaces || '_None recorded._',
    '',
    '## Data flow',
    '',
    page.wiki.dataFlow || '_None recorded._',
    '',
    '## Dependencies',
    '',
    ...markdownList(page.raw.dependencies.map((dependency) =>
      `${dependency.sourceModuleId} → ${dependency.targetModuleId} (${dependency.kind})`,
    )),
    '',
    '## Operational notes',
    '',
    page.wiki.operationalNotes || '_None recorded._',
    '',
    '## Reuse guidance',
    '',
    page.wiki.reuseGuidance || '_None recorded._',
    '',
    '## Limitations',
    '',
    ...markdownList(page.wiki.limitations),
    '',
    '## Risks',
    '',
    ...markdownList(page.wiki.risks),
    '',
    '## Immutable sources',
    '',
    `- Unified IR: \`${page.source.unifiedRepositoryIrId}\` (` +
      `\`${page.source.unifiedRepositoryIrHash}\`)`,
    `- Module catalog: \`${page.source.moduleCatalogId}\` (` +
      `\`${page.source.moduleCatalogHash}\`)`,
    `- Evidence IDs: ${page.wiki.evidenceIds.length === 0
      ? '_none_'
      : page.wiki.evidenceIds.map((id) => `\`${id}\``).join(', ')}`,
    '',
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function materializeRepositoryModuleKnowledgeArtifacts(
  page: RepositoryModuleKnowledgePage,
): SerializedRepositoryKnowledgeArtifact[] {
  const sourceArtifactIds = sortedUnique([
    page.source.unifiedRepositoryIrId,
    page.source.moduleCatalogId,
    ...optionalSourceId(page.source.evidenceBundleId),
    ...optionalSourceId(page.source.wikiProposalId),
    ...optionalSourceId(page.source.knowledgeReviewId),
  ]);
  const json = serializeRepositoryModuleKnowledgeJson(page);
  const markdown = serializeRepositoryModuleKnowledgeMarkdown(page);
  return [
    serializedArtifact(
      `${page.id}:json`,
      'repository-wiki',
      repositoryModuleKnowledgeJsonPath(page.moduleId),
      'application/json',
      'json',
      json,
      sourceArtifactIds,
      page.producer,
      page.createdAt,
    ),
    serializedArtifact(
      `${page.id}:markdown`,
      'repository-wiki',
      repositoryModuleKnowledgeMarkdownPath(page.moduleId),
      'text/markdown',
      'markdown',
      markdown,
      sourceArtifactIds,
      page.producer,
      page.createdAt,
    ),
  ];
}

function optionalSourceId(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}

export function serializeRepositoryModuleKnowledgeIndex(
  pages: readonly RepositoryModuleKnowledgePage[],
): string {
  assertKnowledgePageSet(pages);
  const sorted = [...pages].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  const repositoryId = sorted[0]?.repositoryId ?? '(empty)';
  const lines = [
    '# Repository Module Knowledge Index',
    '',
    `Repository: \`${repositoryId}\``,
    '',
    '| Module | Kind | Summary | Knowledge | Hash |',
    '| --- | --- | --- | --- | --- |',
    ...sorted.map((page) => [
      `| \`${escapeTable(page.moduleId)}\``,
      escapeTable(page.raw.kind),
      escapeTable(page.wiki.summary),
      `[Markdown](./${page.moduleId}/summary.md) · [JSON](./${page.moduleId}/summary.json)`,
      `\`${page.contentHash}\` |`,
    ].join(' | ')),
    '',
  ];
  return lines.join('\n');
}

export function materializeRepositoryModuleKnowledgeIndexArtifact(
  pages: readonly RepositoryModuleKnowledgePage[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  assertTimestamp(createdAt, 'Knowledge index creation time');
  const content = serializeRepositoryModuleKnowledgeIndex(pages);
  return serializedArtifact(
    `repository-module-knowledge-index:${sha256Hex(content).slice(0, 24)}`,
    'repository-search-index',
    repositoryModuleKnowledgeIndexPath,
    'text/markdown',
    'search-index',
    content,
    sortedUnique(pages.flatMap((page) => [
      page.source.unifiedRepositoryIrId,
      page.source.moduleCatalogId,
      `${page.id}:json`,
      `${page.id}:markdown`,
    ])),
    producer,
    createdAt,
  );
}

/**
 * Canonical reviewed-Wiki projection. Each line is one complete summary page;
 * publication/generation fields are deliberately added later when a staged
 * publication is projected into the module index.
 */
export function serializeRepositoryModuleKnowledgeJsonl(
  pages: readonly RepositoryModuleKnowledgePage[],
): string {
  assertKnowledgePageSet(pages);
  const sorted = [...pages].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  for (const page of sorted) {
    if (
      page.boundaryStatus !== 'reviewed' ||
      page.narrativeStatus !== 'reviewed' ||
      page.verificationStatus !== 'unverified' ||
      page.trustTier !== 'reviewed' ||
      page.source.knowledgeReviewId === undefined ||
      page.source.knowledgeReviewHash === undefined
    ) {
      throw new Error(`Repository module JSONL requires independently reviewed narrative: ${page.moduleId}`);
    }
    const { id, contentHash, ...payload } = page;
    const expectedHash = sha256Hex(canonicalJson(payload));
    if (contentHash !== expectedHash ||
        id !== `repository-module-knowledge:${page.moduleId}:${expectedHash.slice(0, 24)}`) {
      throw new Error(`Repository module JSONL page hash is invalid: ${page.moduleId}`);
    }
  }
  return `${sorted.map((page) => canonicalJson(page)).join('\n')}\n`;
}

export function materializeRepositoryModuleKnowledgeJsonlArtifact(
  pages: readonly RepositoryModuleKnowledgePage[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  assertTimestamp(createdAt, 'Repository module knowledge JSONL creation time');
  if (producer.kind !== 'knowledge-publisher') {
    throw new Error('Reviewed repository module JSONL must be produced by the knowledge publisher.');
  }
  for (const page of pages) {
    if (Date.parse(createdAt) < Date.parse(page.createdAt)) {
      throw new Error('Repository module knowledge JSONL cannot precede a reviewed page.');
    }
  }
  const content = serializeRepositoryModuleKnowledgeJsonl(pages);
  return serializedArtifact(
    `repository-module-knowledge-jsonl:${sha256Hex(content).slice(0, 24)}`,
    'repository-search-index',
    repositoryModuleKnowledgeJsonlPath,
    'application/x-ndjson',
    'jsonl',
    content,
    sortedUnique(pages.flatMap((page) => [
      page.source.knowledgeReviewId!,
      page.source.moduleCatalogId,
    ])),
    producer,
    createdAt,
  );
}

/**
 * Versioned maintenance rules for the generated wiki. This is the schema/
 * instruction layer: it explains which fields are immutable facts and which
 * prose an Agent or reviewer may revise.
 */
export function serializeRepositoryModuleKnowledgeSchema(): string {
  return [
    '# Repository Module Knowledge Schema',
    '',
    `Schema version: \`${repositoryIngestionSchemaVersion}\``,
    '',
    '## Authority',
    '',
    '- The repository revision, UnifiedRepositoryIR, module catalog, hashes, IDs, assignments, and evidence references are immutable source facts.',
    '- The `raw` object in each `summary.json` is reconstructed by the trusted host and must not be edited by an Agent.',
    '- The `wiki` object and the corresponding narrative sections in `summary.md` are maintained synthesis, not repository evidence.',
    '- Every synthesis claim must cite an evidence ID already present in the bound IR or catalog.',
    '',
    '## Lifecycle',
    '',
    '- `boundaryStatus` records module ownership review independently: `proposed` or `reviewed`.',
    '- `narrativeStatus` is `generated` until a separate human Summary review accepts the Wiki proposal.',
    '- Accepting a module boundary never changes generated narrative to `reviewed`.',
    '- `verificationStatus` remains `unverified` until separate validation evidence exists; it is never inferred from model confidence or compilation alone.',
    '- The legacy `trustTier` is only a compatibility projection of narrative/verification trust.',
    '- Only reviewed narrative in the active `(repositoryId, channel)` publication may enter formal search.',
    '- A new repository revision produces new immutable ingestion artifacts; current wiki views may be regenerated from them.',
    '',
    '## Navigation and history',
    '',
    '- `index.md` is the content-oriented module catalog.',
    '- `log.md` is append-only ingestion and knowledge history.',
    '- `<moduleId>/summary.json` is the machine-readable page; `<moduleId>/summary.md` is its human-readable view.',
    '',
  ].join('\n');
}

export function materializeRepositoryModuleKnowledgeSchemaArtifact(
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  assertTimestamp(createdAt, 'Knowledge schema artifact time');
  const content = serializeRepositoryModuleKnowledgeSchema();
  return serializedArtifact(
    `repository-module-knowledge-schema:${sha256Hex(content).slice(0, 24)}`,
    'repository-wiki',
    repositoryModuleKnowledgeSchemaPath,
    'text/markdown',
    'markdown',
    content,
    [],
    producer,
    createdAt,
  );
}

/** Search projection kept distinct from the existing class/function index. */
export function materializeIndexedModuleKnowledgeDocument(
  page: RepositoryModuleKnowledgePage,
  catalog: RepositoryModuleCatalog,
  ir: UnifiedRepositoryIR,
  repositoryScopes: readonly string[],
  publication: Pick<
    RepositoryKnowledgePublication,
    'id' | 'payloadHash' | 'scope' | 'repositoryScopes' | 'generation' | 'status' | 'source'
  >,
): IndexedModuleKnowledgeDocument {
  validateRepositoryModuleKnowledgePage(page, catalog, ir);
  if (
    page.boundaryStatus !== 'reviewed' ||
    page.narrativeStatus !== 'reviewed' ||
    page.trustTier !== 'reviewed'
  ) {
    throw new Error('Only independently reviewed module knowledge can enter the formal search projection.');
  }
  if (
    (publication.status !== 'staged' && publication.status !== 'active') ||
    publication.scope.repositoryId !== page.repositoryId ||
    !Number.isInteger(publication.generation) || publication.generation < 1
  ) {
    throw new Error('Module knowledge search projection requires a staged or active repository publication.');
  }
  const publicationModule = publication.source.modules.find((module) => module.moduleId === page.moduleId);
  if (
    publicationModule?.knowledgePageId !== page.id ||
    publicationModule.knowledgePageHash !== page.contentHash
  ) {
    throw new Error('Repository publication does not bind to the module knowledge page.');
  }
  const scopes = sortedUnique(repositoryScopes.map((scope) =>
    normalizeRequiredText(scope, 'Repository knowledge scope'),
  ));
  if (scopes.length === 0) {
    throw new Error('Repository module knowledge cannot be indexed without an explicit repository scope.');
  }
  const publicationScopes = sortedUnique(publication.repositoryScopes.map((scope) =>
    normalizeRequiredText(scope, 'Repository publication ACL scope'),
  ));
  if (
    !publicationScopes.includes(publication.scope.repositoryId) ||
    canonicalJson(publicationScopes) !== canonicalJson(publication.repositoryScopes) ||
    canonicalJson(scopes) !== canonicalJson(publicationScopes)
  ) {
    throw new Error('Repository module knowledge scopes must exactly match the immutable publication ACL.');
  }
  const languageIds = [...page.raw.languageIds];
  const publicApiSignatures = [...page.raw.publicApiSignatures];
  const dependencyModuleIds = sortedUnique(page.raw.dependencies.flatMap((dependency) =>
    dependency.sourceModuleId === page.moduleId
      ? [dependency.targetModuleId]
      : [dependency.sourceModuleId],
  ));
  const tags = canonicalTextList(page.wiki.tags ?? []);
  const domainTerms = sortedUnique([
    ...page.raw.businessCapabilities,
    ...tags,
  ]);
  const searchableContent = [
    page.raw.name,
    page.raw.description,
    page.wiki.summary,
    ...page.raw.responsibilities,
    ...page.raw.businessCapabilities,
    page.wiki.architecture,
    page.wiki.publicInterfaces,
    page.wiki.dataFlow,
    page.wiki.operationalNotes,
    page.wiki.reuseGuidance,
    ...page.wiki.limitations,
    ...page.wiki.risks,
    ...publicApiSignatures,
    ...dependencyModuleIds,
    ...tags,
  ].filter(Boolean).join('\n');
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `indexed-module-knowledge:${page.contentHash}`,
    documentKind: 'functional-module',
    artifactId: page.id,
    artifactHash: page.contentHash,
    repositoryId: page.repositoryId,
    moduleId: page.moduleId,
    moduleCatalogId: page.source.moduleCatalogId,
    publicationId: publication.id,
    publicationPayloadHash: publication.payloadHash,
    publicationGeneration: publication.generation,
    channel: publication.scope.channel,
    title: page.raw.name,
    summary: page.wiki.summary,
    languageIds,
    capabilities: [...page.raw.businessCapabilities],
    domainTerms,
    publicApiSignatures,
    dependencyModuleIds,
    tags,
    risks: [...page.wiki.risks],
    boundaryStatus: page.boundaryStatus,
    narrativeStatus: page.narrativeStatus,
    verificationStatus: page.verificationStatus,
    trustTier: page.trustTier,
    repositoryScopes: scopes,
    searchableContent,
  };
}

/**
 * Append one event without rewriting existing bytes. Replaying the same event
 * ID/idempotency key is a no-op; a conflicting reuse is rejected.
 */
export function appendRepositoryModuleKnowledgeLog(
  current: string,
  event: RepositoryIngestionEvent,
): string {
  assertTimestamp(event.occurredAt, 'Knowledge log event time');
  const eventMarker = `<!-- forexplore-event:${markerValue(event.id)} -->`;
  const keyMarker = event.idempotencyKey === undefined
    ? undefined
    : `<!-- forexplore-idempotency:${markerValue(event.idempotencyKey)} -->`;
  const entry = renderKnowledgeLogEntry(event, eventMarker, keyMarker);
  if (current.includes(eventMarker)) {
    if (!current.includes(entry)) {
      throw new Error(`Knowledge log event ID was reused with different content: ${event.id}`);
    }
    return current;
  }
  if (keyMarker !== undefined && current.includes(keyMarker)) {
    throw new Error(`Knowledge log idempotency key was reused by another event: ${event.idempotencyKey}`);
  }
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  return `${current}${separator}${entry}`;
}

function renderKnowledgeLogEntry(
  event: RepositoryIngestionEvent,
  eventMarker: string,
  keyMarker: string | undefined,
): string {
  return [
    eventMarker,
    ...(keyMarker === undefined ? [] : [keyMarker]),
    `## ${event.occurredAt} — ${event.type}`,
    '',
    `- Event: \`${event.id}\``,
    `- Ingestion: \`${event.ingestionId}\``,
    `- Actor: ${event.actor.kind}/\`${event.actor.id}\``,
    ...(event.fromStatus === undefined ? [] : [`- From: \`${event.fromStatus}\``]),
    ...(event.toStatus === undefined ? [] : [`- To: \`${event.toStatus}\``]),
    ...(event.artifactRefs === undefined || event.artifactRefs.length === 0
      ? []
      : [`- Artifacts: ${event.artifactRefs
        .map((artifact) => `\`${artifact.id}@${artifact.contentHash}\``)
        .join(', ')}`]),
    ...(event.message === undefined ? [] : ['', normalizeText(event.message)]),
    '',
  ].join('\n');
}

export function materializeRepositoryModuleKnowledgeLogArtifact(
  content: string,
  sourceArtifactIds: readonly string[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  assertTimestamp(createdAt, 'Knowledge log artifact time');
  return serializedArtifact(
    `repository-module-knowledge-log:${sha256Hex(content).slice(0, 24)}`,
    'analysis-log',
    repositoryModuleKnowledgeLogPath,
    'text/markdown',
    'log',
    content,
    sortedUnique(sourceArtifactIds),
    producer,
    createdAt,
  );
}

function canonicalRawFacts(
  module: RepositoryDiscoveredModule,
  dependencies: readonly RepositoryModuleDependency[],
  ir: UnifiedRepositoryIR,
): RepositoryModuleKnowledgeRawFacts {
  const filesById = new Map(ir.files.map((file) => [file.id, file]));
  const entitiesById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const apiSurfacesByEntityId = new Map(ir.apiSurfaces.map((surface) => [surface.entityId, surface]));
  const files = module.fileIds.map((id) => {
    const file = filesById.get(id);
    if (!file) throw new Error(`Repository module ${module.id} references unknown IR file: ${id}`);
    return file;
  });
  const entities = module.entityIds.map((id) => {
    const entity = entitiesById.get(id);
    if (!entity) throw new Error(`Repository module ${module.id} references unknown IR entity: ${id}`);
    return entity;
  });
  const publicApis = module.publicApiEntityIds.map((id) => {
    const surface = apiSurfacesByEntityId.get(id);
    if (!surface) throw new Error(`Repository module ${module.id} references unknown public API surface: ${id}`);
    return surface;
  });
  const moduleEntityIds = new Set(module.entityIds);
  const apiSurfaceIds = ir.apiSurfaces
    .filter((surface) => moduleEntityIds.has(surface.entityId))
    .map((surface) => surface.id);
  return {
    name: normalizeRequiredText(module.name, 'Module name'),
    kind: module.kind,
    description: normalizeRequiredText(module.description, 'Module description'),
    responsibilities: canonicalTextList(module.responsibilities),
    businessCapabilities: canonicalTextList(module.businessCapabilities),
    languageIds: sortedUnique([
      ...files.flatMap((file) => file.languageId === undefined ? [] : [file.languageId]),
      ...entities.flatMap((entity) => entity.languageId === undefined ? [] : [entity.languageId]),
    ]),
    fileIds: sortedUnique(module.fileIds),
    filePaths: sortedUnique(files.map((file) => file.path)),
    entityIds: sortedUnique(module.entityIds),
    entryPointEntityIds: sortedUnique(module.entryPointEntityIds),
    publicApiEntityIds: sortedUnique(module.publicApiEntityIds),
    apiSurfaceIds: sortedUnique(apiSurfaceIds),
    publicApiSignatures: canonicalTextList(publicApis.map((surface) => surface.signature)),
    dependencies: dependencies
      .filter((dependency) =>
        dependency.sourceModuleId === module.id || dependency.targetModuleId === module.id,
      )
      .map((dependency) => ({
        ...dependency,
        evidenceRefs: canonicalEvidenceRefs(dependency.evidenceRefs),
      }))
      .sort((left, right) =>
        left.sourceModuleId.localeCompare(right.sourceModuleId) ||
        left.targetModuleId.localeCompare(right.targetModuleId) ||
        left.kind.localeCompare(right.kind),
      ),
    evidenceRefs: canonicalEvidenceRefs(module.evidenceRefs),
  };
}

function validateModuleDiscoveryProposalBindings(
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
): void {
  if (proposal.schemaVersion !== repositoryIngestionSchemaVersion ||
      ir.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error(`Repository ingestion schema must be ${repositoryIngestionSchemaVersion}.`);
  }
  if (proposal.repositoryId !== ir.repositoryId ||
      proposal.sourceIrId !== ir.id ||
      proposal.sourceIrHash !== ir.contentHash) {
    throw new Error('Module discovery proposal does not bind to the supplied unified IR.');
  }
  if (!sha256Pattern.test(proposal.contentHash) || !sha256Pattern.test(ir.contentHash)) {
    throw new Error('Module discovery proposal and IR hashes must be lowercase SHA-256.');
  }
  requireSha256(ir.repositoryContentHash, 'Unified IR repository content hash');
  const { contentHash: suppliedProposalHash, ...proposalHashInput } = proposal;
  if (sha256Hex(canonicalJson(proposalHashInput)) !== suppliedProposalHash) {
    throw new Error('Module discovery proposal content hash does not match its payload.');
  }
  if (proposal.status === 'rejected' || proposal.status === 'superseded') {
    throw new Error(`Cannot materialize a ${proposal.status} module discovery proposal.`);
  }
  assertTimestamp(proposal.createdAt, 'Module discovery proposal creation time');

  const files = uniqueById(ir.files, 'Unified IR file');
  const entities = uniqueById(ir.entities, 'Unified IR entity');
  const apiSurfaces = uniqueById(ir.apiSurfaces, 'Unified IR API surface');
  uniqueById(ir.dependencies, 'Unified IR dependency');
  uniqueById(ir.diagnostics, 'Unified IR diagnostic');
  const filePaths = new Set<string>();
  for (const file of files.values()) {
    if (!isNormalizedRepositoryPath(file.path)) {
      throw new Error(`Unified IR file path is not normalized and repository-relative: ${file.path}`);
    }
    if (filePaths.has(file.path)) throw new Error(`Unified IR file path is duplicated: ${file.path}`);
    filePaths.add(file.path);
    requireSha256(file.contentHash, `Unified IR file ${file.id} content hash`);
    assertUniqueNonEmpty(file.projectIds, `Unified IR file ${file.id} project IDs`);
  }
  for (const entity of ir.entities) {
    if (entity.fileId !== undefined && !files.has(entity.fileId)) {
      throw new Error(`Unified IR entity references unknown file: ${entity.fileId}`);
    }
    if (entity.containerEntityId !== undefined && !entities.has(entity.containerEntityId)) {
      throw new Error(`Unified IR entity references unknown container: ${entity.containerEntityId}`);
    }
    if (entity.range !== undefined) {
      assertSourceRange(entity.range, `Unified IR entity ${entity.id}`);
      const entityFile = entity.fileId === undefined ? undefined : files.get(entity.fileId);
      if (!filePaths.has(entity.range.path) ||
          (entityFile !== undefined && entity.range.path !== entityFile.path)) {
        throw new Error(`Unified IR entity ${entity.id} range is outside its bound file.`);
      }
    }
  }
  for (const dependency of ir.dependencies) {
    if (!files.has(dependency.sourceFileId) ||
        (dependency.targetFileId !== undefined && !files.has(dependency.targetFileId)) ||
        (dependency.sourceEntityId !== undefined && !entities.has(dependency.sourceEntityId)) ||
        (dependency.targetEntityId !== undefined && !entities.has(dependency.targetEntityId))) {
      throw new Error(`Unified IR dependency ${dependency.id} has an invalid file or entity binding.`);
    }
  }
  const apiSurfaceByEntityId = new Map<string, RepositoryApiSurface>();
  for (const surface of apiSurfaces.values()) {
    const entity = entities.get(surface.entityId);
    if (!entity) throw new Error(`Repository API surface references unknown entity: ${surface.entityId}`);
    if (apiSurfaceByEntityId.has(surface.entityId)) {
      throw new Error(`Repository API entity has more than one surface: ${surface.entityId}`);
    }
    apiSurfaceByEntityId.set(surface.entityId, surface);
    normalizeRequiredText(surface.languageId, `API surface ${surface.id} language`);
    normalizeRequiredText(surface.kind, `API surface ${surface.id} kind`);
    normalizeRequiredText(surface.name, `API surface ${surface.id} name`);
    normalizeRequiredText(surface.qualifiedName, `API surface ${surface.id} qualified name`);
    normalizeRequiredText(surface.signature, `API surface ${surface.id} signature`);
    normalizeRequiredText(surface.visibility, `API surface ${surface.id} visibility`);
    assertApiExposure(surface.exposure);
    assertApiCompleteness(surface.completeness);
    assertUniqueNonEmpty(surface.missingFeatures, `API surface ${surface.id} missing features`);
    if (surface.completeness === 'complete' && surface.missingFeatures.length > 0) {
      throw new Error(`Complete API surface ${surface.id} cannot declare missing features.`);
    }
    if (entity.languageId !== undefined && entity.languageId !== surface.languageId) {
      throw new Error(`Repository API surface ${surface.id} language does not match its entity.`);
    }
    if (surface.parameters !== undefined) {
      const positions = new Set<number>();
      for (const parameter of surface.parameters) {
        normalizeRequiredText(parameter.name, `API surface ${surface.id} parameter name`);
        if (!Number.isInteger(parameter.position) || parameter.position < 0 || positions.has(parameter.position)) {
          throw new Error(`API surface ${surface.id} has an invalid or duplicate parameter position.`);
        }
        positions.add(parameter.position);
      }
    }
  }

  validateCoverageSegments(ir);

  // API-surface evidence must close over facts that pre-exist the surface. Do
  // not admit evidence-ref IDs themselves: that would let an adapter invent a
  // ref and use the same ref to prove that it exists.
  const baseEvidenceIds = new Set([
    ...files.keys(),
    ...entities.keys(),
    ...ir.dependencies.map((dependency) => dependency.id),
    ...ir.diagnostics.map((diagnostic) => diagnostic.id),
  ]);
  // Proposals may cite the validated surface fact itself.
  const proposalEvidenceIds = new Set([...baseEvidenceIds, ...apiSurfaces.keys()]);
  const knownPaths = new Set(ir.files.map((file) => file.path));
  for (const diagnostic of ir.diagnostics) {
    if (diagnostic.path !== undefined && !knownPaths.has(diagnostic.path)) {
      throw new Error(`Unified IR diagnostic ${diagnostic.id} cites an unknown path.`);
    }
    if (diagnostic.range !== undefined) {
      assertSourceRange(diagnostic.range, `Unified IR diagnostic ${diagnostic.id}`);
      if (!knownPaths.has(diagnostic.range.path) ||
          (diagnostic.path !== undefined && diagnostic.path !== diagnostic.range.path)) {
        throw new Error(`Unified IR diagnostic ${diagnostic.id} has an invalid range path.`);
      }
    }
  }
  // A surface lives inside the unified IR, so allowing it to cite ir.id would
  // create a provenance cycle. Proposals are downstream of the IR and may cite it.
  const surfaceArtifactIds = new Set([ir.profileId, ...ir.sourceShardIds]);
  const proposalArtifactIds = new Set([ir.id, ...surfaceArtifactIds]);
  const validateEvidence = (
    values: readonly RepositoryEvidenceRef[],
    label: string,
    allowedEvidenceIds: ReadonlySet<string>,
    allowedArtifactIds: ReadonlySet<string>,
  ): void => {
    const ids = new Set<string>();
    for (const evidence of values) {
      const id = normalizeRequiredText(evidence.id, `${label} evidence ID`);
      if (ids.has(id)) throw new Error(`${label} contains duplicate evidence ID: ${id}`);
      ids.add(id);
      if (!allowedEvidenceIds.has(id)) {
        throw new Error(`${label} cites invented or absent IR evidence: ${id}`);
      }
      if (evidence.path !== undefined && !knownPaths.has(evidence.path)) {
        throw new Error(`${label} cites an unknown IR path: ${evidence.path}`);
      }
      if (evidence.range !== undefined && !knownPaths.has(evidence.range.path)) {
        throw new Error(`${label} cites an unknown IR range path: ${evidence.range.path}`);
      }
      if (evidence.range !== undefined) assertSourceRange(evidence.range, `${label} evidence`);
      if (evidence.path !== undefined && evidence.range !== undefined &&
          evidence.path !== evidence.range.path) {
        throw new Error(`${label} evidence path does not match its source range path.`);
      }
      if (evidence.sourceArtifactId !== undefined &&
          !allowedArtifactIds.has(evidence.sourceArtifactId)) {
        throw new Error(`${label} cites an unknown IR artifact: ${evidence.sourceArtifactId}`);
      }
    }
  };
  for (const surface of ir.apiSurfaces) {
    if (surface.evidenceRefs.length === 0) {
      throw new Error(`API surface ${surface.id} must cite repository evidence.`);
    }
    validateEvidence(
      surface.evidenceRefs,
      `API surface ${surface.id}`,
      baseEvidenceIds,
      surfaceArtifactIds,
    );
  }
  for (const constraint of proposal.constraints) {
    if (constraint.evidenceRefs !== undefined) {
      validateEvidence(
        constraint.evidenceRefs,
        `Constraint ${constraint.id}`,
        proposalEvidenceIds,
        proposalArtifactIds,
      );
    }
  }

  const modules = new Map<string, RepositoryDiscoveredModule>();
  const entityOwners = new Map<string, string>();
  for (const module of proposal.modules) {
    assertSafeModuleId(module.id);
    if (modules.has(module.id)) throw new Error(`Duplicate repository module ID: ${module.id}`);
    normalizeRequiredText(module.name, `Module ${module.id} name`);
    normalizeRequiredText(module.description, `Module ${module.id} description`);
    normalizeRequiredText(module.boundaryRationale, `Module ${module.id} boundary rationale`);
    assertUniqueNonEmpty(module.responsibilities, `Module ${module.id} responsibilities`);
    if (module.responsibilities.length === 0) {
      throw new Error(`Module ${module.id} must declare at least one responsibility.`);
    }
    assertUniqueNonEmpty(module.businessCapabilities, `Module ${module.id} capabilities`);
    assertUniqueNonEmpty(module.fileIds, `Module ${module.id} file IDs`);
    if (module.fileIds.length === 0) {
      throw new Error(`Module ${module.id} must own or share at least one file.`);
    }
    assertUniqueNonEmpty(module.entityIds, `Module ${module.id} entity IDs`);
    assertUniqueNonEmpty(module.entryPointEntityIds, `Module ${module.id} entry points`);
    assertUniqueNonEmpty(module.publicApiEntityIds, `Module ${module.id} public APIs`);
    if (module.tags !== undefined) assertUniqueNonEmpty(module.tags, `Module ${module.id} tags`);
    if (module.confidence !== undefined && (!Number.isFinite(module.confidence) ||
        module.confidence < 0 || module.confidence > 1)) {
      throw new Error(`Module ${module.id} confidence must be between 0 and 1.`);
    }
    for (const fileId of module.fileIds) {
      if (!files.has(fileId)) throw new Error(`Module ${module.id} cites invented file ID: ${fileId}`);
    }
    const ownedEntities = new Set(module.entityIds);
    for (const entityId of module.entityIds) {
      const entity = entities.get(entityId);
      if (!entity) throw new Error(`Module ${module.id} cites invented entity ID: ${entityId}`);
      if (entity.fileId !== undefined && !module.fileIds.includes(entity.fileId)) {
        throw new Error(`Module ${module.id} entity ${entityId} is outside its assigned files.`);
      }
      const currentOwner = entityOwners.get(entityId);
      if (currentOwner !== undefined) {
        throw new Error(`IR entity ${entityId} is assigned to both ${currentOwner} and ${module.id}.`);
      }
      entityOwners.set(entityId, module.id);
    }
    for (const entityId of [...module.entryPointEntityIds, ...module.publicApiEntityIds]) {
      if (!ownedEntities.has(entityId)) {
        throw new Error(`Module ${module.id} interface is outside its entity ownership: ${entityId}`);
      }
    }
    for (const entityId of module.publicApiEntityIds) {
      const entity = entities.get(entityId)!;
      const surface = apiSurfaceByEntityId.get(entityId);
      if (!surface) {
        throw new Error(`Module ${module.id} public API lacks a host-derived API surface: ${entityId}`);
      }
      if (!isPublishableApiExposure(surface.exposure)) {
        throw new Error(
          `Module ${module.id} public API ${entityId} has non-public or unknown exposure: ${surface.exposure}`,
        );
      }
      if (entity.testOnly) {
        throw new Error(`Module ${module.id} public API cannot be test-only: ${entityId}`);
      }
    }
    if (module.evidenceRefs.length === 0) {
      throw new Error(`Module ${module.id} must cite repository evidence.`);
    }
    validateEvidence(
      module.evidenceRefs,
      `Module ${module.id}`,
      proposalEvidenceIds,
      proposalArtifactIds,
    );
    modules.set(module.id, module);
  }
  if (ir.files.length > 0 && modules.size === 0) {
    throw new Error('A non-empty repository must have at least one proposed module.');
  }

  const assignments = new Map<string, RepositoryModuleAssignment>();
  const filesByModule = new Map([...modules.keys()].map((id) => [id, new Set<string>()]));
  for (const assignment of proposal.assignments) {
    if (assignments.has(assignment.fileId)) {
      throw new Error(`Module proposal has a duplicate assignment for file: ${assignment.fileId}`);
    }
    const file = files.get(assignment.fileId);
    if (!file) throw new Error(`Module assignment cites invented file ID: ${assignment.fileId}`);
    assertUniqueNonEmpty(assignment.moduleIds, `Assignment ${assignment.fileId} module IDs`);
    for (const moduleId of assignment.moduleIds) {
      if (!modules.has(moduleId)) {
        throw new Error(`Assignment ${assignment.fileId} cites unknown module: ${moduleId}`);
      }
      filesByModule.get(moduleId)!.add(assignment.fileId);
    }
    if (assignment.kind === 'owned' && assignment.moduleIds.length !== 1) {
      throw new Error(`Owned assignment ${assignment.fileId} must name exactly one module.`);
    }
    if (assignment.kind === 'shared' && assignment.moduleIds.length < 2) {
      throw new Error(`Shared assignment ${assignment.fileId} must name at least two modules.`);
    }
    if ((assignment.kind === 'excluded' || assignment.kind === 'unassigned') &&
        assignment.moduleIds.length !== 0) {
      throw new Error(`${assignment.kind} assignment ${assignment.fileId} cannot name a module.`);
    }
    if (assignment.kind === 'test' && file.role !== 'test') {
      throw new Error(`Test assignment ${assignment.fileId} must reference an IR test file.`);
    }
    if (assignment.kind === 'generated' && file.role !== 'generated') {
      throw new Error(`Generated assignment ${assignment.fileId} must reference an IR generated file.`);
    }
    normalizeRequiredText(assignment.rationale, `Assignment ${assignment.fileId} rationale`);
    validateEvidence(
      assignment.evidenceRefs,
      `Assignment ${assignment.fileId}`,
      proposalEvidenceIds,
      proposalArtifactIds,
    );
    assignments.set(assignment.fileId, assignment);
  }
  for (const fileId of files.keys()) {
    if (!assignments.has(fileId)) {
      throw new Error(`Module proposal assignments do not account for IR file: ${fileId}`);
    }
  }
  for (const [moduleId, module] of modules) {
    const assigned = sortedUnique([...(filesByModule.get(moduleId) ?? [])]);
    if (canonicalJson(assigned) !== canonicalJson(sortedUnique(module.fileIds))) {
      throw new Error(`Module ${moduleId} file IDs do not exactly match its assignments.`);
    }
  }

  const dependencyPairs = new Set<string>();
  for (const dependency of proposal.dependencies) {
    const source = modules.get(dependency.sourceModuleId);
    const target = modules.get(dependency.targetModuleId);
    if (!source || !target) {
      throw new Error('Module dependency cites an unknown source or target module.');
    }
    if (source.id === target.id) throw new Error(`Module ${source.id} cannot depend on itself.`);
    const pair = `${source.id}\u0000${target.id}`;
    if (dependencyPairs.has(pair)) {
      throw new Error(`Duplicate module dependency: ${source.id} -> ${target.id}`);
    }
    dependencyPairs.add(pair);
    normalizeRequiredText(dependency.kind, 'Module dependency kind');
    if (dependency.evidenceRefs.length === 0) {
      throw new Error(`Module dependency ${source.id} -> ${target.id} must cite IR evidence.`);
    }
    validateEvidence(
      dependency.evidenceRefs,
      `Module dependency ${source.id} -> ${target.id}`,
      proposalEvidenceIds,
      proposalArtifactIds,
    );
    const sourceFiles = new Set(source.fileIds);
    const targetFiles = new Set(target.fileIds);
    const supportingIds = new Set(ir.dependencies
      .filter((edge) => sourceFiles.has(edge.sourceFileId) &&
        edge.targetFileId !== undefined && targetFiles.has(edge.targetFileId))
      .flatMap((edge) => [edge.id, ...edge.evidenceRefs.map((evidence) => evidence.id)]));
    if (!dependency.evidenceRefs.some((evidence) => supportingIds.has(evidence.id))) {
      throw new Error(
        `Module dependency ${source.id} -> ${target.id} has no supporting IR dependency.`,
      );
    }
  }
}

function canonicalDiscoveredModule(module: RepositoryDiscoveredModule): RepositoryDiscoveredModule {
  return {
    id: normalizeRequiredText(module.id, 'Module ID'),
    name: normalizeRequiredText(module.name, 'Module name'),
    kind: module.kind,
    description: normalizeRequiredText(module.description, 'Module description'),
    responsibilities: canonicalTextList(module.responsibilities),
    businessCapabilities: canonicalTextList(module.businessCapabilities),
    fileIds: sortedUnique(module.fileIds),
    entityIds: sortedUnique(module.entityIds),
    entryPointEntityIds: sortedUnique(module.entryPointEntityIds),
    publicApiEntityIds: sortedUnique(module.publicApiEntityIds),
    boundaryRationale: normalizeRequiredText(module.boundaryRationale, 'Module boundary rationale'),
    evidenceRefs: canonicalEvidenceRefs(module.evidenceRefs),
    ...(module.confidence === undefined ? {} : { confidence: module.confidence }),
    ...(module.tags === undefined ? {} : { tags: canonicalTextList(module.tags) }),
  };
}

function canonicalModuleAssignment(
  assignment: RepositoryModuleAssignment,
): RepositoryModuleAssignment {
  return {
    fileId: normalizeRequiredText(assignment.fileId, 'Module assignment file ID'),
    moduleIds: sortedUnique(assignment.moduleIds),
    kind: assignment.kind,
    rationale: normalizeRequiredText(assignment.rationale, 'Module assignment rationale'),
    evidenceRefs: canonicalEvidenceRefs(assignment.evidenceRefs),
  };
}

function canonicalModuleDependency(
  dependency: RepositoryModuleDependency,
): RepositoryModuleDependency {
  return {
    sourceModuleId: normalizeRequiredText(dependency.sourceModuleId, 'Source module ID'),
    targetModuleId: normalizeRequiredText(dependency.targetModuleId, 'Target module ID'),
    kind: normalizeRequiredText(dependency.kind, 'Module dependency kind'),
    evidenceRefs: canonicalEvidenceRefs(dependency.evidenceRefs),
  };
}

function compareModuleDependencies(
  left: RepositoryModuleDependency,
  right: RepositoryModuleDependency,
): number {
  return left.sourceModuleId.localeCompare(right.sourceModuleId) ||
    left.targetModuleId.localeCompare(right.targetModuleId) ||
    left.kind.localeCompare(right.kind);
}

function uniqueById<T extends { id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    normalizeRequiredText(value.id, `${label} ID`);
    if (result.has(value.id)) throw new Error(`${label} ID is duplicated: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  const normalized = values.map((value) => normalizeRequiredText(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicate values.`);
  }
}

function canonicalWiki(wiki: RepositoryModuleWikiDraft): RepositoryModuleWikiDraft {
  return {
    summary: normalizeRequiredText(wiki.summary, 'Repository wiki summary'),
    architecture: normalizeText(wiki.architecture),
    publicInterfaces: normalizeText(wiki.publicInterfaces),
    dataFlow: normalizeText(wiki.dataFlow),
    operationalNotes: normalizeText(wiki.operationalNotes),
    reuseGuidance: normalizeText(wiki.reuseGuidance),
    limitations: canonicalTextList(wiki.limitations),
    risks: canonicalTextList(wiki.risks),
    evidenceIds: sortedUnique(wiki.evidenceIds.map((id) => normalizeRequiredText(id, 'Evidence ID'))),
    tags: canonicalTextList(wiki.tags ?? []),
  };
}

function canonicalEvidenceRefs(values: readonly RepositoryEvidenceRef[]): RepositoryEvidenceRef[] {
  return [...values]
    .map((value) => ({
      ...value,
      summary: value.summary === undefined ? undefined : normalizeText(value.summary),
      range: value.range === undefined ? undefined : { ...value.range },
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function collectKnownEvidenceIds(
  module: RepositoryDiscoveredModule,
  dependencies: readonly RepositoryModuleDependency[],
  ir: UnifiedRepositoryIR,
): Set<string> {
  return new Set([
    ir.id,
    ...module.fileIds,
    ...module.entityIds,
    ...module.entryPointEntityIds,
    ...module.publicApiEntityIds,
    ...ir.apiSurfaces
      .filter((surface) => module.entityIds.includes(surface.entityId))
      .map((surface) => surface.id),
    ...module.evidenceRefs.map((evidence) => evidence.id),
    ...dependencies.flatMap((dependency) => dependency.evidenceRefs.map((evidence) => evidence.id)),
  ]);
}

function canonicalProducer(producer: RepositoryArtifactProducer): RepositoryArtifactProducer {
  if (!producer.id.trim()) throw new Error('Repository artifact producer ID is required.');
  return {
    kind: producer.kind,
    id: producer.id.trim(),
    ...(producer.version === undefined ? {} : { version: producer.version.trim() }),
    ...(producer.configurationHash === undefined
      ? {}
      : { configurationHash: producer.configurationHash }),
  };
}

function serializedArtifact(
  id: string,
  kind: RepositoryIngestionArtifactRef['kind'],
  path: string,
  mediaType: string,
  format: RepositoryKnowledgeArtifact['format'],
  content: string,
  sourceArtifactIds: string[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  return {
    descriptor: {
      artifact: {
        id,
        kind,
        contentHash: sha256Hex(content),
        hashAlgorithm: 'sha256',
        schemaVersion: repositoryIngestionSchemaVersion,
        path,
        mediaType,
        createdAt,
      },
      format,
      sourceArtifactIds,
      producer: canonicalProducer(producer),
    },
    content,
  };
}

function assertCatalogMatchesIr(catalog: RepositoryModuleCatalog, ir: UnifiedRepositoryIR): void {
  if (
    catalog.repositoryId !== ir.repositoryId ||
    catalog.sourceIrId !== ir.id ||
    catalog.sourceIrHash !== ir.contentHash
  ) {
    throw new Error('Repository module catalog does not bind to the supplied unified IR.');
  }
  if (!sha256Pattern.test(catalog.contentHash) || !sha256Pattern.test(ir.contentHash)) {
    throw new Error('Repository catalog and IR hashes must be lowercase SHA-256.');
  }
}

function assertKnowledgePageSet(pages: readonly RepositoryModuleKnowledgePage[]): void {
  if (pages.length === 0) throw new Error('A repository wiki index requires at least one module page.');
  const ids = new Set<string>();
  const modules = new Set<string>();
  const repositories = new Set(pages.map((page) => page.repositoryId));
  const catalogs = new Set(pages.map((page) => page.source.moduleCatalogId));
  if (repositories.size > 1 || catalogs.size > 1) {
    throw new Error('A repository wiki index must contain one repository and one module catalog.');
  }
  for (const page of pages) {
    assertSafeModuleId(page.moduleId);
    if (ids.has(page.id) || modules.has(page.moduleId)) {
      throw new Error(`Repository wiki contains duplicate module knowledge: ${page.moduleId}`);
    }
    ids.add(page.id);
    modules.add(page.moduleId);
  }
}

function assertModuleReferences(
  module: RepositoryDiscoveredModule,
  catalog: RepositoryModuleCatalog,
  ir: UnifiedRepositoryIR,
): void {
  const fileIds = new Set(ir.files.map((file) => file.id));
  const entityIds = new Set(ir.entities.map((entity) => entity.id));
  const apiSurfacesByEntityId = new Map(ir.apiSurfaces.map((surface) => [surface.entityId, surface]));
  const moduleIds = new Set(catalog.modules.map((item) => item.id));
  for (const fileId of module.fileIds) {
    if (!fileIds.has(fileId)) throw new Error(`Repository module references unknown IR file: ${fileId}`);
  }
  for (const entityId of [
    ...module.entityIds,
    ...module.entryPointEntityIds,
    ...module.publicApiEntityIds,
  ]) {
    if (!entityIds.has(entityId)) {
      throw new Error(`Repository module references unknown IR entity: ${entityId}`);
    }
  }
  const ownedEntities = new Set(module.entityIds);
  for (const entityId of [...module.entryPointEntityIds, ...module.publicApiEntityIds]) {
    if (!ownedEntities.has(entityId)) {
      throw new Error(`Repository module interface is outside its entity ownership: ${entityId}`);
    }
  }
  for (const entityId of module.publicApiEntityIds) {
    const surface = apiSurfacesByEntityId.get(entityId);
    if (!surface || !isPublishableApiExposure(surface.exposure)) {
      throw new Error(`Repository module public API lacks a publishable API surface: ${entityId}`);
    }
  }
  for (const dependency of catalog.dependencies) {
    if (!moduleIds.has(dependency.sourceModuleId) || !moduleIds.has(dependency.targetModuleId)) {
      throw new Error('Repository module catalog dependency references an unknown module.');
    }
  }
}

function validateCoverageSegments(ir: UnifiedRepositoryIR): void {
  const coverage = ir.coverage;
  const irCapabilities = canonicalCapabilities(ir.capabilities);
  const globalMissingCapabilities = canonicalCapabilities(coverage.missingCapabilities);
  if (canonicalJson(irCapabilities) !== canonicalJson(ir.capabilities) ||
      canonicalJson(globalMissingCapabilities) !== canonicalJson(coverage.missingCapabilities)) {
    throw new Error('Unified IR capabilities and missing capabilities must be sorted and unique.');
  }
  // Repository profiling is a snapshot-global step, not a shard output.
  const capabilityUniverse = new Set<AnalysisCapability>([
    ...irCapabilities,
    ...globalMissingCapabilities,
  ].filter((capability) => capability !== 'repository-profile'));
  for (const capability of irCapabilities) {
    if (globalMissingCapabilities.includes(capability)) {
      throw new Error(`Unified IR both completes and globally misses ${capability}.`);
    }
  }
  const shardIds = new Set(ir.sourceShardIds);
  const diagnosticIds = new Set(ir.diagnostics.map((diagnostic) => diagnostic.id));
  const ids = new Set<string>();
  const keys = new Set<string>();
  const representedShards = new Set<string>();
  const representedLanguages = new Set<string>();
  const segmentMissing = new Set<AnalysisCapability>();
  let discovered = 0;
  let analysed = 0;
  let failed = 0;
  let skipped = 0;
  for (const segment of coverage.segments) {
    normalizeRequiredText(segment.id, 'Coverage segment ID');
    normalizeRequiredText(segment.shardId, `Coverage segment ${segment.id} shard ID`);
    if (ids.has(segment.id)) throw new Error(`Duplicate coverage segment ID: ${segment.id}`);
    ids.add(segment.id);
    if (!shardIds.has(segment.shardId)) {
      throw new Error(`Coverage segment ${segment.id} references unknown shard: ${segment.shardId}`);
    }
    representedShards.add(segment.shardId);
    if (segment.languageId !== undefined) representedLanguages.add(segment.languageId);
    const key = `${segment.shardId}\u0000${segment.languageId ?? ''}`;
    if (keys.has(key)) {
      throw new Error(`Coverage contains duplicate shard/language segment: ${segment.shardId}.`);
    }
    keys.add(key);
    for (const [label, value] of [
      ['discovered', segment.discoveredFileCount],
      ['analysed', segment.analysedFileCount],
      ['failed', segment.failedFileCount],
      ['skipped', segment.skippedFileCount],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Coverage segment ${segment.id} ${label} file count is invalid.`);
      }
    }
    if (segment.analysedFileCount + segment.failedFileCount + segment.skippedFileCount !==
        segment.discoveredFileCount) {
      throw new Error(`Coverage segment ${segment.id} file counts do not close.`);
    }
    const capabilities = canonicalCapabilities(segment.capabilities);
    const missingCapabilities = canonicalCapabilities(segment.missingCapabilities);
    if (canonicalJson(capabilities) !== canonicalJson(segment.capabilities) ||
        canonicalJson(missingCapabilities) !== canonicalJson(segment.missingCapabilities)) {
      throw new Error(`Coverage segment ${segment.id} capabilities must be sorted and unique.`);
    }
    for (const capability of missingCapabilities) {
      if (capabilities.includes(capability)) {
        throw new Error(`Coverage segment ${segment.id} both completes and misses ${capability}.`);
      }
      segmentMissing.add(capability);
    }
    for (const capability of capabilityUniverse) {
      if (!capabilities.includes(capability) && !missingCapabilities.includes(capability)) {
        throw new Error(
          `Coverage segment ${segment.id} does not account for capability ${capability}.`,
        );
      }
    }
    if (canonicalJson(sortedUnique(segment.diagnosticIds)) !== canonicalJson(segment.diagnosticIds)) {
      throw new Error(`Coverage segment ${segment.id} diagnostic IDs must be sorted and unique.`);
    }
    for (const diagnosticId of segment.diagnosticIds) {
      if (!diagnosticIds.has(diagnosticId)) {
        throw new Error(`Coverage segment ${segment.id} references unknown diagnostic: ${diagnosticId}`);
      }
    }
    discovered += segment.discoveredFileCount;
    analysed += segment.analysedFileCount;
    failed += segment.failedFileCount;
    skipped += segment.skippedFileCount;
  }
  for (const shardId of shardIds) {
    if (!representedShards.has(shardId)) throw new Error(`Unified IR coverage omits shard: ${shardId}`);
  }
  const coverageLanguages = sortedUnique(coverage.languageIds);
  if (canonicalJson(coverageLanguages) !== canonicalJson(coverage.languageIds) ||
      canonicalJson(coverageLanguages) !== canonicalJson([...representedLanguages].sort())) {
    throw new Error('Unified IR coverage languages do not match its shard/language segments.');
  }
  if (
    discovered !== coverage.discoveredFileCount ||
    analysed !== coverage.analysedFileCount ||
    failed !== coverage.failedFileCount ||
    skipped !== coverage.skippedFileCount
  ) {
    throw new Error('Unified IR coverage totals do not match its shard/language segments.');
  }
  const segmentScopedGlobalMissing = globalMissingCapabilities
    .filter((capability) => capability !== 'repository-profile');
  if (canonicalJson([...segmentMissing].sort()) !== canonicalJson(segmentScopedGlobalMissing)) {
    throw new Error('Unified IR global missing capabilities do not equal the segment-level union.');
  }
}

function canonicalCoverage(
  coverage: UnifiedRepositoryIR['coverage'],
): UnifiedRepositoryIR['coverage'] {
  return {
    discoveredFileCount: coverage.discoveredFileCount,
    analysedFileCount: coverage.analysedFileCount,
    failedFileCount: coverage.failedFileCount,
    skippedFileCount: coverage.skippedFileCount,
    languageIds: sortedUnique(coverage.languageIds),
    missingCapabilities: canonicalCapabilities(coverage.missingCapabilities),
    segments: coverage.segments.map((segment) => ({
      ...canonicalClone(segment),
      capabilities: canonicalCapabilities(segment.capabilities),
      missingCapabilities: canonicalCapabilities(segment.missingCapabilities),
      diagnosticIds: sortedUnique(segment.diagnosticIds),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function canonicalCapabilities(values: readonly AnalysisCapability[]): AnalysisCapability[] {
  return [...new Set(values)].sort();
}

function canonicalIrFiles(values: UnifiedRepositoryIR['files']): UnifiedRepositoryIR['files'] {
  return values.map((file) => ({
    ...canonicalClone(file),
    projectIds: sortedUnique(file.projectIds),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalIrEntities(values: UnifiedRepositoryIR['entities']): UnifiedRepositoryIR['entities'] {
  return values.map((entity) => canonicalClone(entity))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalIrDependencies(
  values: UnifiedRepositoryIR['dependencies'],
): UnifiedRepositoryIR['dependencies'] {
  return values.map((dependency) => ({
    ...canonicalClone(dependency),
    evidenceRefs: canonicalEvidenceRefs(dependency.evidenceRefs),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalApiSurfaces(values: readonly RepositoryApiSurface[]): RepositoryApiSurface[] {
  return values.map((surface) => ({
    ...canonicalClone(surface),
    ...(surface.parameters === undefined
      ? {}
      : {
          parameters: surface.parameters
            .map((parameter) => canonicalClone(parameter))
            .sort((left, right) => left.position - right.position),
        }),
    missingFeatures: sortedUnique(surface.missingFeatures),
    evidenceRefs: canonicalEvidenceRefs(surface.evidenceRefs),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalRepositoryDiagnostics(values: readonly RepositoryDiagnostic[]): RepositoryDiagnostic[] {
  return values.map((diagnostic) => canonicalClone(diagnostic))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function assertReviewDecision(value: string): asserts value is RepositoryModuleReview['decision'] {
  if (value !== 'accept' && value !== 'revise' && value !== 'reject') {
    throw new Error(`Unknown repository module review decision: ${value}.`);
  }
}

function assertApiExposure(value: string): void {
  if (![
    'public',
    'protected',
    'internal',
    'package',
    'private',
    'exported',
    'not-exported',
    'unknown',
  ].includes(value)) {
    throw new Error(`Unknown repository API exposure: ${value}.`);
  }
}

function assertApiCompleteness(value: string): void {
  if (value !== 'complete' && value !== 'partial' && value !== 'unknown') {
    throw new Error(`Unknown repository API surface completeness: ${value}.`);
  }
}

function isPublishableApiExposure(value: RepositoryApiSurface['exposure']): boolean {
  return value === 'public' || value === 'protected' || value === 'exported';
}

function requireSha256(value: string | undefined, label: string): string {
  if (value === undefined || !sha256Pattern.test(value)) throw new Error(`${label} must be lowercase SHA-256.`);
  return value;
}

function isNormalizedRepositoryPath(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function assertSourceRange(range: RepositorySourceRange, label: string): void {
  if (!isNormalizedRepositoryPath(range.path) ||
      !Number.isInteger(range.startLine) || range.startLine < 1 ||
      (range.startColumn !== undefined &&
        (!Number.isInteger(range.startColumn) || range.startColumn < 1)) ||
      (range.endLine !== undefined && (!Number.isInteger(range.endLine) || range.endLine < range.startLine)) ||
      (range.endColumn !== undefined &&
        (!Number.isInteger(range.endColumn) || range.endColumn < 1))) {
    throw new Error(`${label} source range is invalid.`);
  }
  if (range.endColumn !== undefined && range.endLine === undefined) {
    throw new Error(`${label} source range cannot declare endColumn without endLine.`);
  }
  if (range.endLine === range.startLine && range.startColumn !== undefined &&
      range.endColumn !== undefined && range.endColumn < range.startColumn) {
    throw new Error(`${label} source range ends before it starts.`);
  }
}

function canonicalTextList(values: readonly string[]): string[] {
  return sortedUnique(values.map((value) => normalizeRequiredText(value, 'Wiki list item')));
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function assertSafeModuleId(moduleId: string): void {
  if (!safeModuleId.test(moduleId)) {
    throw new Error(`Unsafe repository module ID: ${JSON.stringify(moduleId)}`);
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

function markdownText(value: string): string {
  return normalizeText(value).replace(/[\r\n]+/g, ' ');
}

function markdownList(values: readonly string[]): string[] {
  return values.length === 0
    ? ['_None recorded._']
    : values.map((value) => `- ${normalizeText(value).replace(/\n/g, '\n  ')}`);
}

function escapeTable(value: string): string {
  return markdownText(value).replace(/\|/g, '\\|');
}

function markerValue(value: string): string {
  if (!value.trim()) throw new Error('Knowledge log marker value is required.');
  return encodeURIComponent(value.trim());
}
