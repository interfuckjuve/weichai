import type { LanguageId } from './language-id';
import type {
  RepositoryArtifactProducer,
  RepositoryEvidenceRef,
} from './repository-ingestion';

/** Independent schema for the target-workspace inventory and its rollups. */
export const targetWorkspaceSchemaVersion = '1.0' as const;

/**
 * Static implementation evidence is deliberately not binary. `implemented`
 * means that the detector observed implementation evidence; it is not a claim
 * that the business behaviour is correct.
 */
export type ImplementationState =
  | 'implemented'
  | 'unimplemented'
  | 'partial'
  | 'unknown'
  | 'not-applicable';

export type ImplementationAssessmentBasis =
  | 'explicit-stub'
  | 'syntactic-body'
  | 'validation-backed'
  | 'declaration-only'
  | 'heuristic'
  | 'unavailable';

/** Versioned identity of the language-specific detector which emitted a fact. */
export interface ImplementationDetector {
  id: string;
  version: string;
  languageId?: LanguageId;
  configurationHash?: string;
}

/** Immutable analysis identity shared by every assessment in one inventory. */
export interface TargetWorkspaceAnalysisLineage {
  repositoryId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
}

/** Boundary-review identity required before module rollups can be trusted. */
export interface TargetWorkspaceModuleLineage extends TargetWorkspaceAnalysisLineage {
  moduleCatalogId: string;
  moduleCatalogHash: string;
  moduleReviewId: string;
  moduleReviewHash: string;
}

/**
 * Adapter output before the trusted workflow binds it to an immutable IR.
 * Code indexers should return an explicit `unknown` rather than omit a callable.
 */
export interface EntityImplementationAssessmentDraft {
  entityId: string;
  fileId: string;
  /** Hash of the exact callable body when the adapter can isolate one. */
  bodyHash?: string;
  state: ImplementationState;
  basis: ImplementationAssessmentBasis;
  reasonCodes: string[];
  evidenceRefs: RepositoryEvidenceRef[];
  detector: ImplementationDetector;
}

/** Content-addressed, snapshot-bound implementation fact for one callable. */
export interface EntityImplementationAssessment
  extends EntityImplementationAssessmentDraft {
  schemaVersion: typeof targetWorkspaceSchemaVersion;
  id: string;
  lineage: TargetWorkspaceAnalysisLineage;
  createdAt: string;
  contentHash: string;
}

export interface ImplementationRollupCounts {
  /** States which participate in completion percentages. */
  eligible: number;
  implemented: number;
  unimplemented: number;
  partial: number;
  unknown: number;
  /** Explicitly outside the denominator, including test/generated exclusions. */
  notApplicable: number;
}

export type TargetImplementationRollupScope =
  | 'container'
  /** @deprecated V1 read compatibility. Use `container`. */
  | 'class'
  | 'file'
  | 'module';

/** Deterministic aggregation over unique callable entity IDs. */
export interface TargetImplementationRollup {
  schemaVersion: typeof targetWorkspaceSchemaVersion;
  id: string;
  scope: TargetImplementationRollupScope;
  scopeId: string;
  state: ImplementationState;
  counts: ImplementationRollupCounts;
  eligibleEntityIds: string[];
  excludedEntityIds: string[];
  contentHash: string;
}

export type TargetWorkspaceExclusionReason =
  | 'test'
  | 'generated'
  | 'excluded-file'
  | 'unassigned-file'
  | 'non-source-file'
  | 'not-applicable';

/** Why a callable was deliberately kept out of workspace/module percentages. */
export interface TargetWorkspaceExcludedEntity {
  entityId: string;
  fileId: string;
  reason: TargetWorkspaceExclusionReason;
}

/**
 * Immutable 01B view over a reviewed 01A module catalog. It contains no source
 * text and is not a migration plan or a module-knowledge publication.
 */
export interface TargetWorkspaceModuleSnapshot {
  schemaVersion: typeof targetWorkspaceSchemaVersion;
  id: string;
  lineage: TargetWorkspaceModuleLineage;
  /** Declaration-oriented IR projection; body hashes and source ranges excluded. */
  structureHash: string;
  /** Reviewed module topology projected onto stable file/entity identities. */
  moduleBoundaryHash: string;
  assessments: EntityImplementationAssessment[];
  /**
   * Formal rollup over IR container relationships and adapter container facts.
   * Optional only so persisted V1 snapshots can still be decoded; newly
   * materialized snapshots must use `CurrentTargetWorkspaceModuleSnapshot`.
   */
  containerRollups?: TargetImplementationRollup[];
  /** @deprecated V1 compatibility projection for consumers which still read classes. */
  classRollups: TargetImplementationRollup[];
  fileRollups: TargetImplementationRollup[];
  moduleRollups: TargetImplementationRollup[];
  /** Unique workspace-wide callable denominator; shared files are counted once. */
  workspaceCounts: ImplementationRollupCounts;
  excludedEntities: TargetWorkspaceExcludedEntity[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
  contentHash: string;
}

/** Current materialized form; the optional base field is legacy-read only. */
export interface CurrentTargetWorkspaceModuleSnapshot
  extends TargetWorkspaceModuleSnapshot {
  containerRollups: TargetImplementationRollup[];
}

export type TargetWorkspaceSnapshotFreshness =
  | 'current'
  | 'body-only-compatible'
  | 'stale';

export type TargetWorkspaceSnapshotFreshnessReason =
  | 'repository-changed'
  | 'repository-content-changed'
  | 'unified-ir-changed'
  | 'structure-changed'
  | 'structure-identity-unverified'
  | 'module-catalog-unavailable'
  | 'module-catalog-not-active'
  | 'module-catalog-lineage-changed'
  | 'module-boundary-changed';

/**
 * `body-only-compatible` is a re-analysis/rebase hint, never permission to use
 * old assessments as current evidence.
 */
export interface TargetWorkspaceSnapshotFreshnessResult {
  status: TargetWorkspaceSnapshotFreshness;
  reasonCodes: TargetWorkspaceSnapshotFreshnessReason[];
  currentStructureHash: string;
  currentModuleBoundaryHash?: string;
}
