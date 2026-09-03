import type { LanguageId } from './language-id';

/**
 * Contracts for language-independent repository ingestion and module discovery.
 *
 * These artifacts describe what is present in a repository. They are deliberately
 * separate from `ModuleMigrationPlan`, which describes an approved migration of
 * already-discovered modules. In particular, analysis support for a language does
 * not imply that ForeXplore can migrate to or from that language.
 */
export const repositoryIngestionSchemaVersion = '1.1' as const;

/**
 * Schema version for the materialized per-module `summary.json` document.
 * It evolves independently from the wider ingestion manifest contract.
 */
export const repositoryModuleSummarySchemaVersion = '1.0' as const;

export const repositoryModuleSummaryJsonSchemaId =
  'https://schemas.forexplore.dev/repository-module-summary/1.0/schema.json' as const;

export type RepositoryIngestionJsonValue =
  | null
  | boolean
  | number
  | string
  | RepositoryIngestionJsonValue[]
  | { [key: string]: RepositoryIngestionJsonValue };

export interface RepositorySourceRange {
  /** Repository-relative, POSIX-normalized path. */
  path: string;
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export type RepositoryDiagnosticSeverity = 'info' | 'warn' | 'error';

export interface RepositoryDiagnostic {
  id: string;
  severity: RepositoryDiagnosticSeverity;
  code: string;
  message: string;
  adapterId?: string;
  languageId?: LanguageId;
  path?: string;
  range?: RepositorySourceRange;
  details?: RepositoryIngestionJsonValue;
}

export type RepositoryEvidenceKind =
  | 'manifest'
  | 'source'
  | 'test'
  | 'configuration'
  | 'documentation'
  | 'semantic-analysis'
  | 'syntactic-analysis'
  | 'declared-dependency'
  | 'heuristic'
  | 'human-decision'
  | 'other';

/** A small pointer to evidence; it must not embed an unbounded source file. */
export interface RepositoryEvidenceRef {
  id: string;
  kind: RepositoryEvidenceKind;
  sourceArtifactId?: string;
  path?: string;
  range?: RepositorySourceRange;
  summary?: string;
}

export type RepositoryArtifactProducerKind =
  | 'ingestion-host'
  | 'analysis-adapter'
  | 'module-discovery-agent'
  | 'module-summary-agent'
  | 'knowledge-publisher'
  | 'module-index-publisher'
  | 'human'
  | 'import';

export interface RepositoryArtifactProducer {
  kind: RepositoryArtifactProducerKind;
  id: string;
  version?: string;
  configurationHash?: string;
}

export type RepositoryIngestionArtifactKind =
  | 'repository-profile'
  | 'analysis-shard'
  | 'unified-repository-ir'
  | 'module-discovery-proposal'
  | 'module-review'
  | 'module-catalog'
  | 'repository-module-bundle'
  | 'repository-module-evidence-bundle'
  | 'repository-module-wiki-proposal'
  | 'repository-module-knowledge-review'
  | 'repository-knowledge-publication'
  | 'repository-knowledge-publication-head'
  | 'repository-module-index-receipt'
  | 'repository-import-batch'
  | 'incremental-impact-set'
  | 'repository-wiki'
  | 'repository-search-index'
  | 'analysis-log'
  | 'other';

/**
 * Immutable reference recorded in a manifest. `contentHash` is the lowercase
 * SHA-256 of the canonical artifact payload; `hashAlgorithm` can make that
 * convention explicit at serialization boundaries.
 */
export interface RepositoryIngestionArtifactRef {
  id: string;
  kind: RepositoryIngestionArtifactKind;
  contentHash: string;
  hashAlgorithm?: 'sha256';
  schemaVersion?: string;
  path?: string;
  mediaType?: string;
  byteLength?: number;
  createdAt?: string;
}

export type RepositoryKnowledgeArtifactFormat =
  | 'json'
  | 'jsonl'
  | 'json-schema'
  | 'markdown'
  | 'search-index'
  | 'log';

/**
 * A derived, replayable view for humans or tools. Knowledge artifacts point back
 * to their authoritative source artifacts and are never migration plans.
 */
export interface RepositoryKnowledgeArtifact {
  artifact: RepositoryIngestionArtifactRef;
  format: RepositoryKnowledgeArtifactFormat;
  sourceArtifactIds: string[];
  producer: RepositoryArtifactProducer;
}

export type RepositoryFileRole =
  | 'source'
  | 'test'
  | 'generated'
  | 'configuration'
  | 'documentation'
  | 'asset'
  | 'other';

export interface RepositoryFileInventory {
  total: number;
  source: number;
  test: number;
  generated: number;
  configuration: number;
  documentation: number;
  asset: number;
  other: number;
}

export interface RepositoryLanguageProfile {
  languageId: LanguageId;
  fileExtensions: string[];
  fileCount: number;
  sourceFileCount: number;
  testFileCount: number;
  byteCount?: number;
  projectIds: string[];
}

export interface RepositoryProjectProfile {
  id: string;
  name: string;
  /** Repository-relative, POSIX-normalized project root. */
  rootPath: string;
  languageIds: LanguageId[];
  buildSystem?: string;
  manifestPaths: string[];
  dependencyProjectIds: string[];
}

/** Immutable profile of one repository snapshot. */
export interface RepositoryProfile {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  displayName?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  /** Commit, changeset, or other source-control revision when available. */
  revision?: string;
  /** Snapshot hash, including relevant uncommitted content when applicable. */
  contentHash: string;
  rootPath?: string;
  languages: RepositoryLanguageProfile[];
  projects: RepositoryProjectProfile[];
  fileInventory: RepositoryFileInventory;
  analysisAdapterIds: string[];
  diagnostics: RepositoryDiagnostic[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

/** Capabilities that read and describe repositories. */
export type AnalysisCapability =
  | 'repository-profile'
  | 'file-inventory'
  | 'project-model'
  | 'symbol-index'
  | 'api-surface'
  | 'dependency-graph'
  | 'semantic-binding'
  | 'test-association'
  | 'documentation-extraction'
  | 'incremental-analysis'
  | 'module-discovery-evidence';

/**
 * Capabilities that change or validate a migration. This union is intentionally
 * not accepted by `AnalysisAdapterDescriptor`; analysis and migration support
 * must be registered and authorized independently.
 */
export type MigrationCapability =
  | 'behavior-extraction'
  | 'migration-planning'
  | 'code-translation'
  | 'patch-generation'
  | 'migration-validation'
  | 'workspace-apply'
  | 'workspace-rollback';

export type RepositoryAnalysisMode = 'full' | 'incremental';

export type AnalysisShardStrategy =
  | 'repository'
  | 'project'
  | 'language'
  | 'path-prefix'
  | 'custom';

export type AnalysisOutputKind =
  | 'files'
  | 'projects'
  | 'entities'
  | 'api-surface'
  | 'dependencies'
  | 'diagnostics'
  | 'module-evidence';

/** Registration record for a read-only repository analyser. */
export interface AnalysisAdapterDescriptor {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  name: string;
  version: string;
  /** Empty means language-neutral rather than "supports every migration". */
  languageIds: LanguageId[];
  capabilities: AnalysisCapability[];
  modes: RepositoryAnalysisMode[];
  shardStrategy: AnalysisShardStrategy;
  outputs: AnalysisOutputKind[];
  /** Same snapshot and configuration should yield the same canonical payload. */
  deterministic: boolean;
  requirements?: string[];
}

/**
 * @deprecated Source/target arrays cannot describe exact supported pairs. Use
 * `MigrationRouteDescriptor` for capability routing. Kept for V1 consumers.
 */
export interface MigrationCapabilityDescriptor {
  id: string;
  name: string;
  version: string;
  capabilities: MigrationCapability[];
  sourceLanguageIds: LanguageId[];
  targetLanguageIds: LanguageId[];
}

export interface RepositoryIRFile {
  id: string;
  /** Repository-relative, POSIX-normalized path. */
  path: string;
  contentHash: string;
  role: RepositoryFileRole;
  languageId?: LanguageId;
  projectIds: string[];
  sizeBytes?: number;
  generated?: boolean;
  attributes?: Record<string, RepositoryIngestionJsonValue>;
}

export type RepositoryIREntityKind =
  | 'repository'
  | 'project'
  | 'package'
  | 'namespace'
  | 'module'
  | 'type'
  | 'callable'
  | 'member'
  | 'file'
  | 'external'
  | 'unknown';

/**
 * Adapter-issued, source-syntax-independent identity for a declaration or a
 * compiler/semantic shape. The adapter owns the canonicalization scheme;
 * workflow-core only verifies provenance and the content hash.
 */
export interface RepositoryStructureIdentity {
  basis: 'declaration-shape' | 'semantic-shape';
  contentHash: string;
  schemaVersion: string;
  adapterId: string;
  adapterVersion: string;
  configurationHash?: string;
}

/**
 * Explicit adapter fact for entities which can contain callable entities.
 * Actual child membership remains expressed by `containerEntityId`.
 */
export interface RepositoryContainerCapability {
  canContainCallables: true;
  /** Open adapter-native role such as module, trait, impl, object or namespace. */
  nativeKind: string;
  adapterId: string;
  adapterVersion: string;
}

export interface RepositoryIREntity {
  id: string;
  kind: RepositoryIREntityKind;
  name: string;
  qualifiedName?: string;
  languageId?: LanguageId;
  fileId?: string;
  projectId?: string;
  containerEntityId?: string;
  range?: RepositorySourceRange;
  signature?: string;
  visibility?: string;
  testOnly?: boolean;
  structureIdentity?: RepositoryStructureIdentity;
  containerCapability?: RepositoryContainerCapability;
  attributes?: Record<string, RepositoryIngestionJsonValue>;
}

/** Canonical, language-open exposure classification derived by an analysis adapter. */
export type RepositoryApiExposure =
  | 'public'
  | 'protected'
  | 'internal'
  | 'package'
  | 'private'
  | 'exported'
  | 'not-exported'
  | 'unknown';

export type RepositoryApiSurfaceCompleteness = 'complete' | 'partial' | 'unknown';

/** Optional, adapter-neutral parameter shape. Adapter-specific details belong in `attributes`. */
export interface RepositoryApiParameterShape {
  name: string;
  position: number;
  type?: string;
  required?: boolean;
  variadic?: boolean;
  attributes?: Record<string, RepositoryIngestionJsonValue>;
}

/** Optional, adapter-neutral return shape. */
export interface RepositoryApiReturnShape {
  type?: string;
  nullable?: boolean;
  asynchronous?: boolean;
  attributes?: Record<string, RepositoryIngestionJsonValue>;
}

/**
 * Host-verifiable public/API evidence for one IR entity. `kind` and
 * `visibility` remain adapter-owned strings so registering a new language does
 * not require widening a central enum; `exposure` is the common policy axis.
 */
export interface RepositoryApiSurface {
  id: string;
  entityId: string;
  languageId: LanguageId;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  visibility: string;
  exposure: RepositoryApiExposure;
  parameters?: RepositoryApiParameterShape[];
  returnShape?: RepositoryApiReturnShape;
  completeness: RepositoryApiSurfaceCompleteness;
  missingFeatures: string[];
  /** Optional API-specific identity; the owning entity identity is the fallback. */
  structureIdentity?: RepositoryStructureIdentity;
  evidenceRefs: RepositoryEvidenceRef[];
}

export type RepositoryDependencyResolution =
  | 'resolved'
  | 'ambiguous'
  | 'unresolved'
  | 'external';

export type RepositoryDependencyEvidenceLevel =
  | 'semantic'
  | 'syntactic'
  | 'declared'
  | 'heuristic'
  | 'ambiguous'
  | 'unresolved';

export interface RepositoryIRDependency {
  id: string;
  sourceEntityId?: string;
  targetEntityId?: string;
  sourceFileId: string;
  targetFileId?: string;
  /** Adapter-owned stable edge kind such as `invocation` or `project-reference`. */
  kind: string;
  internal: boolean;
  resolution: RepositoryDependencyResolution;
  evidenceLevel: RepositoryDependencyEvidenceLevel;
  /** Original target text when no unique internal entity can be resolved. */
  targetReference?: string;
  evidenceRefs: RepositoryEvidenceRef[];
}

export type AnalysisShardStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** Independently produced analysis for a bounded portion of a snapshot. */
export interface AnalysisShard {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  profileId: string;
  adapterId: string;
  adapterVersion: string;
  mode: RepositoryAnalysisMode;
  baseShardId?: string;
  languageIds: LanguageId[];
  projectIds: string[];
  pathPrefixes: string[];
  inputRevision?: string;
  inputContentHash: string;
  capabilities: AnalysisCapability[];
  status: AnalysisShardStatus;
  files: RepositoryIRFile[];
  entities: RepositoryIREntity[];
  apiSurfaces: RepositoryApiSurface[];
  dependencies: RepositoryIRDependency[];
  diagnostics: RepositoryDiagnostic[];
  /** Hash of the canonical analysis payload; absent before any payload exists. */
  contentHash?: string;
  producer: RepositoryArtifactProducer;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

/** Per-shard/per-language coverage prevents one deep adapter masking a weaker segment. */
export interface UnifiedRepositoryIRCoverageSegment {
  id: string;
  shardId: string;
  languageId?: LanguageId;
  discoveredFileCount: number;
  analysedFileCount: number;
  failedFileCount: number;
  skippedFileCount: number;
  capabilities: AnalysisCapability[];
  missingCapabilities: AnalysisCapability[];
  diagnosticIds: string[];
}

export interface UnifiedRepositoryIRCoverage {
  discoveredFileCount: number;
  analysedFileCount: number;
  failedFileCount: number;
  skippedFileCount: number;
  languageIds: LanguageId[];
  missingCapabilities: AnalysisCapability[];
  segments: UnifiedRepositoryIRCoverageSegment[];
}

/** Canonical, adapter-neutral graph merged from immutable analysis shards. */
export interface UnifiedRepositoryIR {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  profileId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  sourceShardIds: string[];
  capabilities: AnalysisCapability[];
  files: RepositoryIRFile[];
  entities: RepositoryIREntity[];
  apiSurfaces: RepositoryApiSurface[];
  dependencies: RepositoryIRDependency[];
  coverage: UnifiedRepositoryIRCoverage;
  diagnostics: RepositoryDiagnostic[];
  contentHash: string;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export type RepositoryModuleKind =
  | 'business-capability'
  | 'application-service'
  | 'domain'
  | 'infrastructure'
  | 'integration'
  | 'shared-kernel'
  | 'test-support'
  | 'technical-layer'
  | 'unknown';

export interface RepositoryDiscoveredModule {
  id: string;
  name: string;
  kind: RepositoryModuleKind;
  description: string;
  responsibilities: string[];
  businessCapabilities: string[];
  fileIds: string[];
  entityIds: string[];
  entryPointEntityIds: string[];
  publicApiEntityIds: string[];
  boundaryRationale: string;
  evidenceRefs: RepositoryEvidenceRef[];
  /** Ranking aid only; never a calibrated correctness probability. */
  confidence?: number;
  tags?: string[];
}

export type RepositoryModuleAssignmentKind =
  | 'owned'
  | 'shared'
  | 'test'
  | 'generated'
  | 'excluded'
  | 'unassigned';

export interface RepositoryModuleAssignment {
  fileId: string;
  moduleIds: string[];
  kind: RepositoryModuleAssignmentKind;
  rationale: string;
  evidenceRefs: RepositoryEvidenceRef[];
}

export interface RepositoryModuleDependency {
  sourceModuleId: string;
  targetModuleId: string;
  kind: string;
  evidenceRefs: RepositoryEvidenceRef[];
}

export type ModuleDiscoveryProposalStatus =
  | 'proposed'
  | 'awaiting-review'
  | 'accepted'
  | 'rejected'
  | 'superseded';

export interface ModuleDiscoveryConstraint {
  id: string;
  description: string;
  required: boolean;
  evidenceRefs?: RepositoryEvidenceRef[];
}

/** Candidate module boundaries; acceptance requires a separate catalog/review record. */
export interface ModuleDiscoveryProposal {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  sourceIrId: string;
  sourceIrHash: string;
  objective?: string;
  constraints: ModuleDiscoveryConstraint[];
  status: ModuleDiscoveryProposalStatus;
  modules: RepositoryDiscoveredModule[];
  assignments: RepositoryModuleAssignment[];
  dependencies: RepositoryModuleDependency[];
  assumptions: string[];
  risks: string[];
  unresolvedQuestions: string[];
  producer: RepositoryArtifactProducer;
  contentHash: string;
  createdAt: string;
}

export type RepositoryModuleReviewDecision = 'accept' | 'revise' | 'reject';

export interface RepositoryModuleReview {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  proposalId: string;
  proposalHash: string;
  sourceIrId: string;
  sourceIrHash: string;
  decision: RepositoryModuleReviewDecision;
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
  replacementProposalRequired: boolean;
  decidedAt: string;
  contentHash: string;
}

export interface ApplyRepositoryModuleReviewResult {
  review: RepositoryModuleReview;
  /** Present only for an accepted review. */
  catalog?: RepositoryModuleCatalog;
  replacementProposalRequired: boolean;
}

export type RepositoryModuleCatalogStatus =
  | 'draft'
  | 'active'
  | 'stale'
  | 'superseded';

/** Draft or reviewed module inventory for a repository snapshot; never a migration plan. */
export interface RepositoryModuleCatalog {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  sourceIrId: string;
  sourceIrHash: string;
  sourceProposalId: string;
  sourceProposalHash: string;
  status: RepositoryModuleCatalogStatus;
  modules: RepositoryDiscoveredModule[];
  assignments: RepositoryModuleAssignment[];
  dependencies: RepositoryModuleDependency[];
  unassignedFileIds: string[];
  overlappingFileIds: string[];
  reviewId?: string;
  reviewHash?: string;
  contentHash: string;
  producer: RepositoryArtifactProducer;
  createdAt: string;
  updatedAt: string;
}

/**
 * Agent-maintained prose for one module. It is deliberately separated from
 * `RepositoryModuleKnowledgeRawFacts`: an agent may revise the synthesis, but
 * it cannot rewrite repository evidence, ownership, or dependency identities.
 */
export interface RepositoryModuleWikiDraft {
  summary: string;
  architecture: string;
  publicInterfaces: string;
  dataFlow: string;
  operationalNotes: string;
  reuseGuidance: string;
  limitations: string[];
  risks: string[];
  /** Evidence IDs cited by the generated prose. */
  evidenceIds: string[];
  tags?: string[];
}

/** Deterministic facts reconstructed from a reviewed catalog and unified IR. */
export interface RepositoryModuleKnowledgeRawFacts {
  name: string;
  kind: RepositoryModuleKind;
  description: string;
  responsibilities: string[];
  businessCapabilities: string[];
  /** Deterministically derived from the module's bound IR files/entities. */
  languageIds: LanguageId[];
  fileIds: string[];
  /** Human-readable repository-relative paths paired with `fileIds` through the IR. */
  filePaths: string[];
  entityIds: string[];
  entryPointEntityIds: string[];
  publicApiEntityIds: string[];
  /** API-surface records bound to entities owned by this module. */
  apiSurfaceIds: string[];
  /** Stable signatures/names copied from the bound public API entities. */
  publicApiSignatures: string[];
  dependencies: RepositoryModuleDependency[];
  evidenceRefs: RepositoryEvidenceRef[];
}

export interface RepositoryModuleKnowledgeSource {
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
  moduleCatalogId: string;
  moduleCatalogHash: string;
  /** Present when the narrative was produced through the independent summary gate. */
  evidenceBundleId?: string;
  evidenceBundleHash?: string;
  wikiProposalId?: string;
  wikiProposalHash?: string;
  knowledgeReviewId?: string;
  knowledgeReviewHash?: string;
}

/** Human decision over module ownership/boundaries, independent of prose review. */
export type RepositoryModuleBoundaryStatus = 'proposed' | 'reviewed';

/** Lifecycle of Agent-maintained narrative, independent of boundary review. */
export type RepositoryModuleNarrativeStatus = 'generated' | 'reviewed';

/** `verified` is reserved for separately supplied validation evidence. */
export type RepositoryKnowledgeVerificationStatus =
  | 'unverified'
  | 'partial'
  | 'verified';

/**
 * @deprecated Compatibility projection only. New code must inspect the
 * independent boundary, narrative, verification, and publication lifecycles.
 */
export type RepositoryKnowledgeTrustTier =
  | 'discovered'
  | 'reviewed'
  | 'verified';

/**
 * Content-addressed page stored beneath the repository wiki. `raw` is
 * host-derived and authoritative; `wiki` is the LLM-maintained synthesis.
 */
export interface RepositoryModuleKnowledgePage {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  summarySchemaVersion: typeof repositoryModuleSummarySchemaVersion;
  id: string;
  repositoryId: string;
  moduleId: string;
  source: RepositoryModuleKnowledgeSource;
  boundaryStatus: RepositoryModuleBoundaryStatus;
  narrativeStatus: RepositoryModuleNarrativeStatus;
  verificationStatus: RepositoryKnowledgeVerificationStatus;
  /** @deprecated Compatibility projection of narrative/verification trust. */
  trustTier: RepositoryKnowledgeTrustTier;
  raw: RepositoryModuleKnowledgeRawFacts;
  wiki: RepositoryModuleWikiDraft;
  producer: RepositoryArtifactProducer;
  createdAt: string;
  contentHash: string;
}

/** A materialized file ready for an external, transactional artifact store. */
export interface SerializedRepositoryKnowledgeArtifact {
  descriptor: RepositoryKnowledgeArtifact;
  content: string;
}

/**
 * Search projection for module knowledge. It intentionally has a distinct
 * document kind instead of pretending that a functional module is a class or
 * function in the existing symbol index.
 */
export interface IndexedModuleKnowledgeDocument {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  documentKind: 'functional-module';
  artifactId: string;
  artifactHash: string;
  repositoryId: string;
  moduleId: string;
  moduleCatalogId: string;
  publicationId: string;
  publicationPayloadHash: string;
  publicationGeneration: number;
  channel: string;
  title: string;
  summary: string;
  languageIds: LanguageId[];
  capabilities: string[];
  domainTerms: string[];
  publicApiSignatures: string[];
  dependencyModuleIds: string[];
  tags: string[];
  risks: string[];
  boundaryStatus: RepositoryModuleBoundaryStatus;
  narrativeStatus: RepositoryModuleNarrativeStatus;
  verificationStatus: RepositoryKnowledgeVerificationStatus;
  trustTier: RepositoryKnowledgeTrustTier;
  repositoryScopes: string[];
  searchableContent: string;
}

export interface RepositoryModuleBundleSourceRefs {
  unifiedRepositoryIrId: string;
  unifiedRepositoryIrHash: string;
  moduleProposalId: string;
  moduleProposalHash: string;
  moduleReviewId: string;
  moduleReviewHash: string;
  moduleCatalogId: string;
  moduleCatalogHash: string;
}

/**
 * Task-neutral, immutable repository module inventory. It is intentionally not
 * a migration input or implementation bundle: it packages only reviewed
 * repository facts and their complete provenance closure.
 */
export interface RepositoryModuleBundle {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  source: RepositoryModuleBundleSourceRefs;
  capabilities: AnalysisCapability[];
  coverage: UnifiedRepositoryIRCoverage;
  diagnostics: RepositoryDiagnostic[];
  modules: RepositoryDiscoveredModule[];
  assignments: RepositoryModuleAssignment[];
  moduleDependencies: RepositoryModuleDependency[];
  files: RepositoryIRFile[];
  entities: RepositoryIREntity[];
  irDependencies: RepositoryIRDependency[];
  apiSurfaces: RepositoryApiSurface[];
  knowledgePages: RepositoryModuleKnowledgePage[];
  producer: RepositoryArtifactProducer;
  createdAt: string;
  contentHash: string;
}

export type RepositoryFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed';

export interface RepositoryFileChange {
  kind: RepositoryFileChangeKind;
  path: string;
  previousPath?: string;
  previousContentHash?: string;
  contentHash?: string;
  languageId?: LanguageId;
}

export type RepositoryIncrementalImpactReasonKind =
  | 'file-change'
  | 'project-change'
  | 'language-change'
  | 'dependency-change'
  | 'adapter-change'
  | 'configuration-change'
  | 'unknown';

export interface RepositoryIncrementalImpactReason {
  kind: RepositoryIncrementalImpactReasonKind;
  sourceId?: string;
  description: string;
}

/** Explicit invalidation result used to bound, or reject, incremental analysis. */
export interface RepositoryIncrementalImpactSet {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  baseManifestId?: string;
  baseIrId?: string;
  baseCatalogId?: string;
  changes: RepositoryFileChange[];
  affectedFileIds: string[];
  affectedProjectIds: string[];
  affectedEntityIds: string[];
  affectedDependencyIds: string[];
  affectedShardIds: string[];
  affectedModuleIds: string[];
  invalidatedArtifactIds: string[];
  reasons: RepositoryIncrementalImpactReason[];
  requiresFullAnalysis: boolean;
  requiresModuleRediscovery: boolean;
  contentHash: string;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

export type RepositoryIngestionMode = 'full' | 'incremental';

export type RepositoryIngestionStatus =
  | 'queued'
  | 'profiling'
  | 'analyzing'
  | 'merging'
  | 'discovering-modules'
  | 'awaiting-module-review'
  | 'summarizing-modules'
  | 'awaiting-summary-review'
  | 'publishing-knowledge'
  | 'ready'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export type RepositoryIngestionEventType =
  | 'ingestion-requested'
  | 'ingestion-started'
  | 'status-changed'
  | 'profile-produced'
  | 'adapter-selected'
  | 'shard-started'
  | 'shard-produced'
  | 'shard-failed'
  | 'unified-ir-produced'
  | 'incremental-impact-produced'
  | 'module-proposal-produced'
  | 'module-review-recorded'
  | 'module-catalog-produced'
  | 'module-bundle-produced'
  | 'module-evidence-bundle-produced'
  | 'module-wiki-proposal-produced'
  | 'module-knowledge-review-recorded'
  | 'knowledge-artifact-produced'
  | 'knowledge-publication-staged'
  | 'module-index-receipt-produced'
  | 'knowledge-publication-activated'
  | 'knowledge-publication-withdrawn'
  | 'ingestion-completed'
  | 'ingestion-failed'
  | 'ingestion-cancelled'
  | 'ingestion-superseded';

export type RepositoryIngestionEventActorKind =
  | 'system'
  | 'adapter'
  | 'agent'
  | 'human';

export interface RepositoryIngestionEventActor {
  kind: RepositoryIngestionEventActorKind;
  id: string;
}

/** Append-only, idempotent lifecycle event retained by the run manifest. */
export interface RepositoryIngestionEvent {
  id: string;
  ingestionId: string;
  sequence: number;
  type: RepositoryIngestionEventType;
  occurredAt: string;
  actor: RepositoryIngestionEventActor;
  idempotencyKey?: string;
  fromStatus?: RepositoryIngestionStatus;
  toStatus?: RepositoryIngestionStatus;
  artifactRefs?: RepositoryIngestionArtifactRef[];
  message?: string;
  details?: RepositoryIngestionJsonValue;
}

export interface RepositoryIngestionArtifacts {
  profile?: RepositoryIngestionArtifactRef;
  shards: RepositoryIngestionArtifactRef[];
  unifiedRepositoryIr?: RepositoryIngestionArtifactRef;
  moduleDiscoveryProposal?: RepositoryIngestionArtifactRef;
  /** Immutable draft emitted before human review. */
  moduleCatalog?: RepositoryIngestionArtifactRef;
  moduleReview?: RepositoryIngestionArtifactRef;
  /** Accepted, immutable catalog published after review; `moduleCatalog` remains the draft. */
  activeModuleCatalog?: RepositoryIngestionArtifactRef;
  moduleBundle?: RepositoryIngestionArtifactRef;
  moduleEvidenceBundles: RepositoryIngestionArtifactRef[];
  moduleWikiProposals: RepositoryIngestionArtifactRef[];
  moduleKnowledgeReviews: RepositoryIngestionArtifactRef[];
  /** Immutable staged/active/withdrawn state revisions, retained in order by ID. */
  knowledgePublications: RepositoryIngestionArtifactRef[];
  moduleIndexReceipts: RepositoryIngestionArtifactRef[];
  publicationHeads: RepositoryIngestionArtifactRef[];
  incrementalImpactSet?: RepositoryIngestionArtifactRef;
  knowledge: RepositoryKnowledgeArtifact[];
}

export interface RepositoryIngestionFailure {
  code: string;
  message: string;
  retryable: boolean;
  failedStage?: RepositoryIngestionStatus;
  diagnosticIds?: string[];
}

/**
 * Replayable run ledger. It records ingestion/discovery artifacts by hash and
 * intentionally has no `ModuleMigrationPlan` field.
 */
export interface RepositoryIngestionManifest {
  schemaVersion: typeof repositoryIngestionSchemaVersion;
  id: string;
  repositoryId: string;
  mode: RepositoryIngestionMode;
  status: RepositoryIngestionStatus;
  baseManifestId?: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  configurationHash?: string;
  requestedCapabilities: AnalysisCapability[];
  completedCapabilities: AnalysisCapability[];
  analysisAdapters: AnalysisAdapterDescriptor[];
  artifacts: RepositoryIngestionArtifacts;
  events: RepositoryIngestionEvent[];
  diagnostics: RepositoryDiagnostic[];
  failure?: RepositoryIngestionFailure;
  requestedAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}
