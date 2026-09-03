export const moduleMappingSchemaVersion = '1.0' as const;

/** Immutable reference to one active, reviewed repository module catalog. */
export interface RepositoryModuleCatalogRef {
  repositoryId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
  moduleCatalogId: string;
  moduleCatalogHash: string;
  moduleReviewId: string;
  moduleReviewHash: string;
}

export type ModuleMappingCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one';

/**
 * A cross-catalog correspondence. IDs refer to facts in the two reviewed
 * catalogs/IRs; this entry never creates module ownership.
 */
export interface ModuleMappingEntry {
  id: string;
  cardinality: ModuleMappingCardinality;
  sourceModuleIds: string[];
  targetModuleIds: string[];
  sourceEntityIds: string[];
  targetEntityIds: string[];
  rationale: string;
  evidenceIds: string[];
}

export type ModuleMappingProposalStatus = 'awaiting-review' | 'superseded';

export interface ModuleMappingProposal {
  schemaVersion: typeof moduleMappingSchemaVersion;
  id: string;
  sourceCatalog: RepositoryModuleCatalogRef;
  targetCatalog: RepositoryModuleCatalogRef;
  objective: string;
  status: ModuleMappingProposalStatus;
  mappings: ModuleMappingEntry[];
  assumptions: string[];
  risks: string[];
  createdAt: string;
  contentHash: string;
}

export type ModuleMappingReviewDecision = 'accept' | 'revise' | 'reject';

/** Human decision bound to the exact proposal and both catalog heads. */
export interface ModuleMappingReview {
  schemaVersion: typeof moduleMappingSchemaVersion;
  id: string;
  proposalId: string;
  proposalHash: string;
  sourceCatalog: RepositoryModuleCatalogRef;
  targetCatalog: RepositoryModuleCatalogRef;
  decision: ModuleMappingReviewDecision;
  reviewerId: string;
  comment?: string;
  acceptedRiskIds: string[];
  replacementProposalRequired: boolean;
  decidedAt: string;
  contentHash: string;
}

/**
 * Execution grouping over approved mapping facts. Module/entity arrays are
 * references only; file ownership, module descriptions, and new boundaries are
 * deliberately absent.
 */
export interface MigrationExecutionGroup {
  id: string;
  mappingIds: string[];
  sourceModuleIds: string[];
  targetModuleIds: string[];
  sourceEntityIds: string[];
  targetEntityIds: string[];
  dependsOnGroupIds: string[];
  executionMode: 'serial';
  atomic: true;
}

export type MigrationExecutionOverlayStatus =
  | 'planned'
  | 'approved'
  | 'invalidated'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'rolled-back';

export interface MigrationExecutionOverlay {
  schemaVersion: typeof moduleMappingSchemaVersion;
  id: string;
  sourceCatalog: RepositoryModuleCatalogRef;
  targetCatalog: RepositoryModuleCatalogRef;
  mappingProposalId: string;
  mappingProposalHash: string;
  mappingReviewId: string;
  mappingReviewHash: string;
  routeId: string;
  routeVersion: string;
  status: MigrationExecutionOverlayStatus;
  groups: MigrationExecutionGroup[];
  createdAt: string;
  contentHash: string;
}

export type ModuleMappingFreshnessReason =
  | 'repository-changed'
  | 'repository-revision-changed'
  | 'repository-content-changed'
  | 'unified-ir-changed'
  | 'module-catalog-not-active'
  | 'module-catalog-changed'
  | 'module-review-changed';

export interface CatalogRefFreshnessResult {
  status: 'current' | 'stale';
  reasonCodes: ModuleMappingFreshnessReason[];
}

export interface ModuleMappingFreshnessResult {
  status: 'current' | 'stale';
  source: CatalogRefFreshnessResult;
  target: CatalogRefFreshnessResult;
}

/** Explicit V1-to-V2 binding; legacy module facts never enter an overlay. */
export interface LegacyFunctionalModuleMappingBinding {
  legacyModuleId: string;
  mappingIds: string[];
}

/** Audit artifact kept beside, never embedded in, the canonical overlay. */
export interface LegacyModuleMigrationCompatibilityRecord {
  schemaVersion: typeof moduleMappingSchemaVersion;
  id: string;
  legacyPlanId: string;
  legacyPlanHash: string;
  overlayId: string;
  overlayHash: string;
  bindings: LegacyFunctionalModuleMappingBinding[];
  warnings: string[];
  createdAt: string;
  contentHash: string;
}
