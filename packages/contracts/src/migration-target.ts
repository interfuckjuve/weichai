import type { LanguageId } from './language-id';
import type { MigrationRouteSnapshotRef } from './migration-route';

export const migrationReferenceSchemaVersion = '2.0' as const;

/** Immutable repository evidence to which a target or candidate is bound. */
export interface MigrationRepositoryLineage {
  repositoryId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
  moduleCatalogId?: string;
  moduleCatalogHash?: string;
  moduleReviewId?: string;
  moduleReviewHash?: string;
}

/** Reviewed module boundary lineage required for a V2 target selection. */
export interface ReviewedMigrationRepositoryLineage extends MigrationRepositoryLineage {
  moduleCatalogId: string;
  moduleCatalogHash: string;
  moduleReviewId: string;
  moduleReviewHash: string;
}

/** Language-open entity identity; adapter-owned kinds do not widen a union. */
export interface MigrationEntityRef {
  entityId: string;
  fileId?: string;
  languageId: LanguageId;
  kind: string;
  name: string;
  qualifiedName?: string;
  path?: string;
  signature?: string;
}

/** Adapter-owned identity. Core verifies provenance/hash but never parses syntax. */
export interface MigrationCodeIdentity {
  kind: 'declaration' | 'body' | 'semantic-shape';
  contentHash: string;
  schemaVersion: string;
  providerId: string;
  providerVersion: string;
  configurationHash?: string;
}

/** Required target entity/file facts at the V2 execution boundary. */
export interface MigrationTargetEntityRef extends MigrationEntityRef {
  fileId: string;
  path: string;
  fileContentHash: string;
  declarationIdentity: MigrationCodeIdentity;
  bodyIdentity?: MigrationCodeIdentity;
  semanticIdentity?: MigrationCodeIdentity;
}

/** V2 migration destination selected from a reviewed target-repository view. */
export interface MigrationTargetRef {
  schemaVersion: typeof migrationReferenceSchemaVersion;
  id: string;
  workspaceId: string;
  targetWorkspaceSnapshotId: string;
  targetWorkspaceSnapshotHash: string;
  lineage: ReviewedMigrationRepositoryLineage;
  entity: MigrationTargetEntityRef;
  route: MigrationRouteSnapshotRef;
  allowedModificationPaths: string[];
  contentHash: string;
}

/** V2 historical implementation candidate; previews are not formal source. */
export interface ImplementationCandidateRef {
  schemaVersion: typeof migrationReferenceSchemaVersion;
  id: string;
  lineage: MigrationRepositoryLineage;
  entity: MigrationEntityRef;
  sourceBundleId?: string;
  sourceBundleHash?: string;
  license?: string;
  contentHash: string;
}
