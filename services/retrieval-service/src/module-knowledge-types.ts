import type {
  IndexedModuleKnowledgeDocument,
  LanguageId,
  RepositoryKnowledgePublication,
  RepositoryModuleKnowledgeSearchRequest,
  RepositoryModuleKnowledgeSearchResult,
  RepositoryModuleIndexReceipt,
} from '@forexplore/contracts';

/**
 * A publication generation is addressed independently from the symbol index.
 * `channel` is the deployment-selected branch/channel key (for example
 * `branch:main` or `release:2026.09`).
 */
export interface ModuleKnowledgePublicationKey {
  repositoryId: string;
  channel: string;
  publicationId: string;
  generation: number;
}

export type ModuleKnowledgeGenerationState =
  | 'staged'
  | 'active'
  | 'withdrawn'
  | 'tombstoned';

export interface ModuleKnowledgeStageRequest {
  /** The immutable staged publication whose reviewed pages are projected. */
  publication: RepositoryKnowledgePublication;
  /** Exact ACL scopes copied from the reviewed publication. */
  repositoryScopes: string[];
  documents: IndexedModuleKnowledgeDocument[];
}

export interface EmbeddedModuleKnowledgeDocument {
  document: IndexedModuleKnowledgeDocument;
  embedding: number[];
  projectionHash: string;
}

/** Non-secret identity needed to explain and reproduce an index projection. */
export interface ModuleKnowledgeIndexerMetadata {
  projectionVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  /** Hash of provider options such as endpoint/capability flags; never includes credentials. */
  configurationHash: string;
}

export interface EmbeddedModuleKnowledgeGeneration
  extends Omit<ModuleKnowledgeStageRequest, 'documents'> {
  repositoryId: string;
  channel: string;
  publicationId: string;
  publicationPayloadHash: string;
  generation: number;
  indexer: ModuleKnowledgeIndexerMetadata;
  documents: EmbeddedModuleKnowledgeDocument[];
  generationContentHash: string;
}

/** A persistence-backed receipt. Absence of a receipt is not validation. */
export type ModuleKnowledgeIndexReceipt = RepositoryModuleIndexReceipt;

export interface ModuleKnowledgeHead {
  repositoryId: string;
  channel: string;
  publicationId: string | null;
  publicationPayloadHash: string | null;
  generation: number | null;
  revision: number;
}

export interface ModuleKnowledgeActivationRequest extends ModuleKnowledgePublicationKey {
  /** Required compare-and-swap value. `null` means no active generation. */
  expectedActiveGeneration: number | null;
}

export interface ModuleKnowledgeWithdrawRequest extends ModuleKnowledgePublicationKey {
  /** Must identify the generation currently at the head. */
  expectedActiveGeneration: number;
}

export interface ModuleKnowledgeTombstoneRequest extends ModuleKnowledgePublicationKey {}

export type ModuleKnowledgeQuery = RepositoryModuleKnowledgeSearchRequest;

export interface RetrievedModuleKnowledgeDocument
  extends IndexedModuleKnowledgeDocument {
  semanticScore?: number;
  textScore?: number;
  hybridScore?: number;
}

export type ModuleKnowledgeSearchResult = RepositoryModuleKnowledgeSearchResult;

export interface ModuleKnowledgeSearchStore {
  ping(): Promise<void>;
  initialize(): Promise<void>;
  stage(generation: EmbeddedModuleKnowledgeGeneration): Promise<ModuleKnowledgeIndexReceipt>;
  validate(key: ModuleKnowledgePublicationKey): Promise<ModuleKnowledgeIndexReceipt>;
  activate(request: ModuleKnowledgeActivationRequest): Promise<ModuleKnowledgeHead>;
  /**
   * Logically withdraws the active generation and restores the generation it
   * superseded when one exists. It never deletes indexed rows.
   */
  withdraw(request: ModuleKnowledgeWithdrawRequest): Promise<ModuleKnowledgeHead>;
  /** Marks an already-inactive generation unavailable for future activation. */
  tombstone(request: ModuleKnowledgeTombstoneRequest): Promise<void>;
  activeHead(repositoryId: string, channel: string): Promise<ModuleKnowledgeHead | null>;
  semanticSearch(
    embedding: number[],
    query: ModuleKnowledgeQuery,
    limit: number,
  ): Promise<RetrievedModuleKnowledgeDocument[]>;
  textSearch(
    queryText: string,
    query: ModuleKnowledgeQuery,
    limit: number,
  ): Promise<RetrievedModuleKnowledgeDocument[]>;
  close(): Promise<void>;
}

export interface ModuleKnowledgeSearchEngine {
  search(request: ModuleKnowledgeQuery): Promise<ModuleKnowledgeSearchResult>;
}

export interface ModuleKnowledgeIndexService {
  stage(request: ModuleKnowledgeStageRequest): Promise<ModuleKnowledgeIndexReceipt>;
  validate(key: ModuleKnowledgePublicationKey): Promise<ModuleKnowledgeIndexReceipt>;
  activate(request: ModuleKnowledgeActivationRequest): Promise<ModuleKnowledgeHead>;
  withdraw(request: ModuleKnowledgeWithdrawRequest): Promise<ModuleKnowledgeHead>;
  tombstone(request: ModuleKnowledgeTombstoneRequest): Promise<void>;
}
