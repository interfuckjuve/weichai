import type {
  IndexedModuleKnowledgeDocument,
  RepositoryArtifactProducer,
  RepositoryEvidenceKind,
  RepositoryIngestionArtifactRef,
  RepositoryModuleKnowledgePage,
  RepositoryModuleWikiDraft,
  RepositorySourceRange,
} from './repository-ingestion';
import type { LanguageId } from './language-id';
import {
  repositoryIngestionSchemaVersion,
  repositoryModuleSummarySchemaVersion,
} from './repository-ingestion';

/** Independent schema for the knowledge publication control-plane records. */
export const repositoryKnowledgePublicationSchemaVersion = '1.1' as const;

export type RepositoryModuleEvidenceItemKind =
  | 'source-slice'
  | 'test'
  | 'documentation'
  | 'configuration'
  | 'dependency-neighborhood'
  | 'api-surface'
  | 'diagnostic'
  | 'other';

/** A bounded, immutable piece of content authorized for the Summary Agent. */
export interface RepositoryModuleEvidenceItem {
  id: string;
  kind: RepositoryModuleEvidenceItemKind;
  evidenceKind: RepositoryEvidenceKind;
  evidenceRefIds: string[];
  sourceArtifactId?: string;
  path?: string;
  range?: RepositorySourceRange;
  mediaType: string;
  content: string;
  byteLength: number;
  contentHash: string;
  truncated: boolean;
  truncationReason?: string;
}

export interface RepositoryModuleEvidenceScope {
  fileIds: string[];
  entityIds: string[];
  dependencyIds: string[];
  apiSurfaceIds: string[];
  evidenceIds: string[];
}

export interface RepositoryModuleEvidenceOmission {
  kind: RepositoryModuleEvidenceItemKind;
  sourceId: string;
  reason: string;
}

export interface RepositoryModuleEvidenceBundleSource {
  repositoryModuleBundleId: string;
  repositoryModuleBundleHash: string;
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
  moduleCatalogId: string;
  moduleCatalogHash: string;
  moduleReviewId: string;
  moduleReviewHash: string;
}

/**
 * Immutable Summary-Agent input. Boundary facts and supplied content are
 * content-addressed; omissions make a bounded context explicit rather than
 * silently presenting it as complete.
 */
export interface RepositoryModuleEvidenceBundle {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  moduleId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  source: RepositoryModuleEvidenceBundleSource;
  scope: RepositoryModuleEvidenceScope;
  items: RepositoryModuleEvidenceItem[];
  omissions: RepositoryModuleEvidenceOmission[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
  contentHash: string;
}

export type RepositoryModuleWikiSection =
  | 'summary'
  | 'architecture'
  | 'publicInterfaces'
  | 'dataFlow'
  | 'operationalNotes'
  | 'reuseGuidance'
  | 'limitations'
  | 'risks';

/** Every narrative claim is bound to one or more immutable evidence IDs. */
export interface RepositoryModuleWikiEvidenceBinding {
  section: RepositoryModuleWikiSection;
  claim: string;
  evidenceIds: string[];
}

export interface RepositoryModuleSummaryGeneration {
  modelId: string;
  promptTemplateId: string;
  promptTemplateVersion: string;
  toolVersion?: string;
}

/** Immutable links proving that a generated proposal supersedes a reviewed predecessor. */
export interface RepositoryModuleWikiRevisionLineage {
  previousProposalId: string;
  previousProposalHash: string;
  reviseReviewId: string;
  reviseReviewHash: string;
}

/** Immutable output of the independent module Summary Agent. */
export interface RepositoryModuleWikiProposal {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  summarySchemaVersion: typeof repositoryModuleSummarySchemaVersion;
  id: string;
  repositoryId: string;
  moduleId: string;
  evidenceBundleId: string;
  evidenceBundleHash: string;
  narrative: RepositoryModuleWikiDraft;
  evidenceBindings: RepositoryModuleWikiEvidenceBinding[];
  /** Absent for the first proposal; present only after an explicit `revise` review. */
  revision?: RepositoryModuleWikiRevisionLineage;
  generation: RepositoryModuleSummaryGeneration;
  producer: RepositoryArtifactProducer;
  createdAt: string;
  contentHash: string;
}

export type RepositoryModuleKnowledgeReviewDecision = 'accept' | 'revise' | 'reject';

/** Independent human decision over generated Wiki prose, not module boundaries. */
export interface RepositoryModuleKnowledgeReview {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  moduleId: string;
  evidenceBundleId: string;
  evidenceBundleHash: string;
  wikiProposalId: string;
  wikiProposalHash: string;
  decision: RepositoryModuleKnowledgeReviewDecision;
  reviewerId: string;
  comment?: string;
  replacementProposalRequired: boolean;
  reviewedAt: string;
  contentHash: string;
}

/** Full immutable input needed to generate and verify a successor proposal. */
export interface RepositoryModuleSummaryRevisionContext {
  previousProposal: RepositoryModuleWikiProposal;
  reviseReview: RepositoryModuleKnowledgeReview;
}

/** Stable activation key selected by AAAAA: repository plus branch/channel. */
export interface RepositoryKnowledgePublicationScope {
  repositoryId: string;
  channel: string;
}

export type RepositoryKnowledgePublicationStatus = 'staged' | 'active' | 'withdrawn';

export interface RepositoryKnowledgePublicationModuleSource {
  moduleId: string;
  evidenceBundleId: string;
  evidenceBundleHash: string;
  wikiProposalId: string;
  wikiProposalHash: string;
  knowledgeReviewId: string;
  knowledgeReviewHash: string;
  knowledgePageId: string;
  knowledgePageHash: string;
}

export interface RepositoryKnowledgePublicationSource {
  repositoryModuleBundleId: string;
  repositoryModuleBundleHash: string;
  modules: RepositoryKnowledgePublicationModuleSource[];
}

/**
 * Immutable publication state revision. `payloadHash` identifies the stable
 * projection while `contentHash` changes at staged/active/withdrawn transitions.
 */
export interface RepositoryKnowledgePublication {
  schemaVersion: typeof repositoryKnowledgePublicationSchemaVersion;
  id: string;
  scope: RepositoryKnowledgePublicationScope;
  /** Canonical ACL closure used by every derived index document. */
  repositoryScopes: string[];
  generation: number;
  status: RepositoryKnowledgePublicationStatus;
  payloadHash: string;
  source: RepositoryKnowledgePublicationSource;
  artifacts: RepositoryIngestionArtifactRef[];
  previousPublicationId?: string;
  previousStateHash?: string;
  stagedAt: string;
  activatedAt?: string;
  withdrawnAt?: string;
  producer: RepositoryArtifactProducer;
  contentHash: string;
}

export type RepositoryModuleIndexReceiptStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'withdrawn';

/** Receipt from the separate module index; never aliases the symbol table. */
export interface RepositoryModuleIndexReceipt {
  schemaVersion: typeof repositoryKnowledgePublicationSchemaVersion;
  id: string;
  publicationId: string;
  publicationPayloadHash: string;
  scope: RepositoryKnowledgePublicationScope;
  generation: number;
  status: RepositoryModuleIndexReceiptStatus;
  storeId: string;
  documentCount: number;
  moduleIds: string[];
  indexArtifactHash: string;
  previousStateHash?: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

/** Content-addressed CAS pointer. Storage must compare `contentHash`. */
export interface RepositoryKnowledgePublicationHead {
  schemaVersion: typeof repositoryKnowledgePublicationSchemaVersion;
  scope: RepositoryKnowledgePublicationScope;
  publicationId: string;
  publicationHash: string;
  generation: number;
  updatedAt: string;
  contentHash: string;
}

export type RepositoryImportBatchItemStatus =
  | 'pending'
  | 'staged'
  | 'active'
  | 'failed'
  | 'withdrawn';

export interface RepositoryImportBatchItemFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RepositoryImportBatchItem {
  id: string;
  scope: RepositoryKnowledgePublicationScope;
  ingestionManifestId: string;
  ingestionManifestHash: string;
  status: RepositoryImportBatchItemStatus;
  publicationId?: string;
  publicationHash?: string;
  failure?: RepositoryImportBatchItemFailure;
}

export type RepositoryImportBatchStatus =
  | 'open'
  | 'completed'
  | 'completed-with-errors';

/** A batch is a reporting aggregate; each repository item commits atomically. */
export interface RepositoryImportBatch {
  schemaVersion: typeof repositoryKnowledgePublicationSchemaVersion;
  id: string;
  atomicity: 'per-repository';
  status: RepositoryImportBatchStatus;
  items: RepositoryImportBatchItem[];
  previousStateHash?: string;
  createdAt: string;
  updatedAt: string;
  producer: RepositoryArtifactProducer;
  contentHash: string;
}

export interface ActivateRepositoryKnowledgePublicationResult {
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  head: RepositoryKnowledgePublicationHead;
}

export interface WithdrawRepositoryKnowledgePublicationResult {
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  /** Restored head; absent when no prior publication is selected. */
  head?: RepositoryKnowledgePublicationHead;
}

/** Useful at typed JSON boundaries without coupling contracts to an AJV runtime. */
export interface RepositoryModuleSummaryDocument extends RepositoryModuleKnowledgePage {
  summarySchemaVersion: typeof repositoryModuleSummarySchemaVersion;
}

/** Stable next-layer request; implementations must resolve only the active head. */
export interface RepositoryModuleKnowledgeSearchRequest {
  repositoryId: string;
  channel: string;
  /** Caller-authorized ACL scopes; never inferred from indexed content. */
  repositoryScopes: string[];
  query: string;
  topK: number;
  languageIds?: LanguageId[];
  capabilities?: string[];
}

export interface RepositoryModuleKnowledgeRankingComponents {
  semantic?: number;
  text?: number;
  hybrid?: number;
}

export interface RepositoryModuleKnowledgeSearchHit {
  document: IndexedModuleKnowledgeDocument;
  /** Ranking score only; never a calibrated correctness probability. */
  score: number;
  ranking?: RepositoryModuleKnowledgeRankingComponents;
}

export interface RepositoryModuleKnowledgeSearchResult {
  scope: RepositoryKnowledgePublicationScope;
  activePublicationId: string;
  activePublicationPayloadHash: string;
  activeGeneration: number;
  hits: RepositoryModuleKnowledgeSearchHit[];
}
