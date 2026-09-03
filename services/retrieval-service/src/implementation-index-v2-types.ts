import type {
  IndexedImplementationDocumentV2,
  ImplementationIndexGenerationRefV2,
  MigrationRuntimeCapabilitySnapshot,
  RepositoryModuleCatalogRef,
  SearchCandidateV2,
  SearchRequestV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';
import type { ResolveSourceBundleV2Request, ResolvedSourceBundleV2 } from '@forexplore/workflow-core';

export const implementationIndexGenerationSchemaVersion = '2.0' as const;

export interface ImplementationIndexGenerationV2 {
  schemaVersion: typeof implementationIndexGenerationSchemaVersion;
  id: string;
  repositoryId: string;
  generation: number;
  sourceCatalog: RepositoryModuleCatalogRef;
  repositoryScopes: string[];
  documents: IndexedImplementationDocumentV2[];
  sourceBundles: SourceImplementationBundleV2[];
  createdAt: string;
  contentHash: string;
}

export interface EmbeddedImplementationDocumentV2 {
  document: IndexedImplementationDocumentV2;
  embedding: number[];
}

export interface EmbeddedImplementationIndexGenerationV2
  extends Omit<ImplementationIndexGenerationV2, 'documents'> {
  documents: EmbeddedImplementationDocumentV2[];
}

export interface ImplementationIndexGenerationKeyV2 {
  repositoryId: string;
  generationId: string;
  generation: number;
  generationContentHash: string;
}

export interface ImplementationIndexActivationRequestV2
  extends ImplementationIndexGenerationKeyV2 {
  expectedActiveGenerationId: string | null;
}

export interface ImplementationIndexHeadV2 {
  repositoryId: string;
  generationId: string | null;
  generation: number | null;
  generationContentHash: string | null;
  sourceCatalogId: string | null;
  sourceCatalogHash: string | null;
  revision: number;
}

export interface RetrievedImplementationDocumentV2 {
  document: IndexedImplementationDocumentV2;
  indexGeneration: ImplementationIndexGenerationRefV2;
  semanticScore?: number;
  textScore?: number;
  hybridScore?: number;
}

export interface ImplementationSearchFiltersV2 {
  repositoryScopes: string[];
  candidateLanguageIds: string[];
}

export interface ImplementationIndexStoreV2 {
  ping(): Promise<void>;
  initialize(): Promise<void>;
  stage(generation: EmbeddedImplementationIndexGenerationV2): Promise<void>;
  validate(key: ImplementationIndexGenerationKeyV2): Promise<ImplementationIndexGenerationV2>;
  activate(request: ImplementationIndexActivationRequestV2): Promise<ImplementationIndexHeadV2>;
  activeHead(repositoryId: string): Promise<ImplementationIndexHeadV2 | null>;
  resolveSourceBundle(request: ResolveSourceBundleV2Request): Promise<ResolvedSourceBundleV2>;
  semanticSearch(
    embedding: number[],
    filters: ImplementationSearchFiltersV2,
    limit: number,
  ): Promise<RetrievedImplementationDocumentV2[]>;
  textSearch(
    query: string,
    filters: ImplementationSearchFiltersV2,
    limit: number,
  ): Promise<RetrievedImplementationDocumentV2[]>;
  close(): Promise<void>;
}

export interface ImplementationIndexServiceV2 {
  stage(generation: ImplementationIndexGenerationV2): Promise<void>;
  validate(key: ImplementationIndexGenerationKeyV2): Promise<ImplementationIndexGenerationV2>;
  activate(request: ImplementationIndexActivationRequestV2): Promise<ImplementationIndexHeadV2>;
}

export interface SearchEngineV2 {
  readonly runtimeCapabilities: MigrationRuntimeCapabilitySnapshot;
  validateRequest(
    request: SearchRequestV2,
    combinedRuntimeCapabilities: MigrationRuntimeCapabilitySnapshot,
  ): void;
  search(
    request: SearchRequestV2,
    combinedRuntimeCapabilities?: MigrationRuntimeCapabilitySnapshot,
  ): Promise<ImplementationSearchResultV2>;
}

export interface ImplementationSearchResultV2 {
  candidates: SearchCandidateV2[];
  /** Authoritative records needed by remote clients to validate every candidate. */
  indexedDocuments: IndexedImplementationDocumentV2[];
}
