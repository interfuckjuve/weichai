import type { AdaptationStrategy } from './adaptation';
import type { FilePatch } from './backfill';
import type { LanguageId } from './language-id';
import type {
  ImplementationCandidateRef,
  MigrationRepositoryLineage,
  MigrationTargetRef,
} from './migration-target';
import type {
  MaterializedMigrationRouteDescriptor,
  MaterializedValidationPolicySnapshot,
  MigrationRouteSnapshotRef,
  MigrationRouteStage,
} from './migration-route';
import type { RepositoryModuleCatalogRef } from './module-mapping';
import type {
  RepositoryArtifactProducer,
  RepositoryIngestionJsonValue,
} from './repository-ingestion';
import type { ValidationRecord } from './validation';

export const migrationExecutionV2SchemaVersion = '2.0' as const;
export const migrationRuntimeCapabilitySchemaVersion = '2.0' as const;

/** Immutable runtime route set. Every route and policy is content-addressed. */
export interface MigrationRuntimeCapabilitySnapshot {
  schemaVersion: typeof migrationRuntimeCapabilitySchemaVersion;
  id: string;
  routes: MaterializedMigrationRouteDescriptor[];
  createdAt: string;
  contentHash: string;
}

export interface MigrationArtifactRefV2 {
  id: string;
  contentHash: string;
}

export interface MigrationProviderRefV2 {
  providerId: string;
  providerVersion: string;
  configurationHash?: string;
}

/** Language-open retrieval input bound to one exact target and route. */
export interface SearchRequestV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  target: MigrationTargetRef;
  route: MigrationRouteSnapshotRef;
  requirement: string;
  topK: number;
  repositoryScopes: string[];
  candidateLanguageIds: LanguageId[];
  rerank: boolean;
  createdAt: string;
  contentHash: string;
}

export interface SearchCandidateScoreV2 {
  overall: number;
  semantic: number;
  symbol: number;
  contract: number;
  hybrid?: number;
  rerank?: number;
}

/**
 * Retrieval index record with authoritative repository/catalog lineage. The
 * retrieval service may rank it but may not synthesize candidate identity.
 */
export interface IndexedImplementationDocumentV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  candidate: ImplementationCandidateRef;
  sourceCatalog: RepositoryModuleCatalogRef;
  moduleId: string;
  entityId: string;
  fileId: string;
  fileContentHash: string;
  sourceBundle: MigrationArtifactRefV2;
  title: string;
  summary: string;
  searchText: string;
  producer: MigrationProviderRefV2;
  createdAt: string;
  contentHash: string;
}

/** Candidate evidence for exactly one request/route; previews remain non-authoritative. */
export interface SearchCandidateV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  requestId: string;
  requestHash: string;
  targetId: string;
  targetHash: string;
  route: MigrationRouteSnapshotRef;
  indexedDocumentId: string;
  indexedDocumentHash: string;
  candidate: ImplementationCandidateRef;
  sourceBundle: MigrationArtifactRefV2;
  title: string;
  summary: string;
  score: SearchCandidateScoreV2;
  preview?: string;
  compatibility: string[];
  risks: string[];
  createdAt: string;
  contentHash: string;
}

export type SourceImplementationFileRoleV2 = 'primary' | 'helper' | 'test' | 'configuration';

export interface SourceImplementationFileV2 {
  fileId: string;
  path: string;
  languageId: LanguageId;
  role: SourceImplementationFileRoleV2;
  content: string;
  contentHash: string;
}

/** Full, content-addressed source input; a candidate preview cannot substitute for it. */
export interface SourceImplementationBundleV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  candidate: ImplementationCandidateRef;
  lineage: MigrationRepositoryLineage;
  primaryEntityId: string;
  helperEntityIds: string[];
  testEntityIds: string[];
  dependencyIds: string[];
  files: SourceImplementationFileV2[];
  producer: MigrationProviderRefV2;
  createdAt: string;
  contentHash: string;
}

export type TargetContextFactRoleV2 =
  | 'declaration'
  | 'container'
  | 'import'
  | 'dependency'
  | 'reference'
  | 'caller'
  | 'test'
  | 'build-fact';

/** Adapter-owned context fact. Central code does not interpret native syntax. */
export interface TargetContextFactV2 {
  id: string;
  role: TargetContextFactRoleV2;
  languageId?: LanguageId;
  entityId?: string;
  fileId?: string;
  path?: string;
  content?: string;
  contentHash: string;
  provider: MigrationProviderRefV2;
  attributes: Record<string, RepositoryIngestionJsonValue>;
}

export type AllowedModificationV2 =
  | {
      path: string;
      operation: 'modify';
      expectedContentHash: string;
    }
  | {
      path: string;
      operation: 'create';
      expectedAbsent: true;
    };

/** Language-neutral, immutable target context collected by a target adapter. */
export interface TargetContextSnapshotV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  target: MigrationTargetRef;
  route: MigrationRouteSnapshotRef;
  declarations: TargetContextFactV2[];
  containers: TargetContextFactV2[];
  imports: TargetContextFactV2[];
  dependencies: TargetContextFactV2[];
  references: TargetContextFactV2[];
  callers: TargetContextFactV2[];
  tests: TargetContextFactV2[];
  buildFacts: TargetContextFactV2[];
  allowedModifications: AllowedModificationV2[];
  constraints: string[];
  producer: MigrationProviderRefV2;
  createdAt: string;
  contentHash: string;
}

/** Reviewed source/target mapping lineage shared by execution artifacts. */
export interface MigrationExecutionLineageV2 {
  sourceCatalog: RepositoryModuleCatalogRef;
  targetCatalog: RepositoryModuleCatalogRef;
  mappingProposalId: string;
  mappingProposalHash: string;
  mappingReviewId: string;
  mappingReviewHash: string;
  executionOverlayId: string;
  executionOverlayHash: string;
}

export interface AdaptationRequestV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  route: MigrationRouteSnapshotRef;
  executionLineage: MigrationExecutionLineageV2;
  target: MigrationTargetRef;
  candidate: ImplementationCandidateRef;
  sourceBundle: SourceImplementationBundleV2;
  targetContext: TargetContextSnapshotV2;
  patchSubjectHash: string;
  validationPolicy: MaterializedValidationPolicySnapshot;
  requirement: string;
  strategy: AdaptationStrategy;
  decisionNotes: string[];
  createdAt: string;
  contentHash: string;
}

export interface AdaptationResultV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  requestId: string;
  requestHash: string;
  route: MigrationRouteSnapshotRef;
  executionLineage: MigrationExecutionLineageV2;
  targetId: string;
  targetHash: string;
  sourceBundleId: string;
  sourceBundleHash: string;
  targetContextId: string;
  targetContextHash: string;
  patchSubjectHash: string;
  patchHash: string;
  files: FilePatch[];
  validationPolicy: MaterializedValidationPolicySnapshot;
  validation: ValidationRecord[];
  producer: MigrationProviderRefV2;
  createdAt: string;
  contentHash: string;
}

export type MigrationRunStatusV2 =
  | 'planned'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled-back';

export interface MigrationProviderExecutionV2 extends MigrationProviderRefV2 {
  stage: MigrationRouteStage;
  status: 'completed' | 'failed' | 'unverified';
  startedAt: string;
  completedAt?: string;
  artifactRefs: MigrationArtifactRefV2[];
}

export interface MigrationValidatorExecutionV2 extends MigrationProviderRefV2 {
  policyCheckId: string;
  validationRecordId: string;
  subjectHash: string;
  status: ValidationRecord['status'];
  artifactRefs: MigrationArtifactRefV2[];
}

export interface MigrationPatchRecordV2 {
  patchHash: string;
  subjectHash: string;
  paths: string[];
  createdAt: string;
}

export interface MigrationRepairRoundV2 {
  round: number;
  inputPatchHash: string;
  outputPatchHash: string;
  triggerValidationRecordIds: string[];
  provider: MigrationProviderRefV2;
  createdAt: string;
}

export interface MigrationCheckpointRefV2 {
  id: string;
  contentHash: string;
  recoverable: boolean;
  createdAt: string;
}

export interface MigrationRecoveryRecordV2 {
  status: 'available' | 'completed' | 'failed' | 'not-required';
  checkpointId: string;
  provider: MigrationProviderRefV2;
  artifactRefs: MigrationArtifactRefV2[];
  updatedAt: string;
  failureReason?: string;
}

/** Complete V2 audit artifact. It never embeds a V1 plan/target/request. */
export interface MigrationRunManifestV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  status: MigrationRunStatusV2;
  route: MigrationRouteSnapshotRef;
  executionLineage: MigrationExecutionLineageV2;
  request: MigrationArtifactRefV2;
  result: MigrationArtifactRefV2;
  target: MigrationArtifactRefV2;
  candidate: MigrationArtifactRefV2;
  sourceBundle: MigrationArtifactRefV2;
  targetContext: MigrationArtifactRefV2;
  validationPolicy: MaterializedValidationPolicySnapshot;
  providers: MigrationProviderExecutionV2[];
  validators: MigrationValidatorExecutionV2[];
  patch: MigrationPatchRecordV2;
  repairRounds: MigrationRepairRoundV2[];
  checkpoint?: MigrationCheckpointRefV2;
  recovery?: MigrationRecoveryRecordV2;
  artifactPaths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

/**
 * Hash-only audit bridge for explicitly imported V1 artifacts. Legacy facts
 * remain outside all V2 artifacts and cannot satisfy V2 lineage requirements.
 */
export interface LegacyMigrationExecutionCompatibilityRecordV2 {
  schemaVersion: typeof migrationExecutionV2SchemaVersion;
  id: string;
  legacyKind: 'search-request' | 'search-candidate' | 'adaptation-request' | 'adaptation-result' | 'run-manifest';
  legacyArtifactHash: string;
  v2Artifact: MigrationArtifactRefV2;
  bridgeProducer: RepositoryArtifactProducer;
  warnings: string[];
  createdAt: string;
  contentHash: string;
}
