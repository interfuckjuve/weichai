import type {
  ModuleDiscoveryConstraint,
  ModuleDiscoveryProposal,
  RepositoryArtifactProducer,
  RepositoryEvidenceRef,
  RepositoryModuleCatalog,
  RepositoryModuleReview,
  RepositoryStaticAnalysis,
  TargetWorkspaceModuleSnapshot,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  analyzeRepository,
  bridgeRepositoryStaticAnalysis,
  type AnalyzeRepositoryRequest,
  type RepositoryStaticAnalysisBridgeArtifacts,
} from '@forexplore/code-indexer';
import {
  applyRepositoryModuleReview,
  calculateTargetWorkspaceStructureHash,
  canonicalJson,
  classifyTargetWorkspaceSnapshotFreshness,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleReview,
  sha256Hex,
  validateTargetWorkspaceModuleSnapshot,
} from '@forexplore/workflow-core';
import {
  assessRepositoryModuleDiscoveryReadiness,
  type RepositoryModuleDiscoveryReadiness,
} from './repository-module-readiness';

export const targetWorkspaceHostVersion = '1.0.0';

const targetWorkspaceProducer: RepositoryArtifactProducer = {
  kind: 'ingestion-host',
  id: 'forexplore-vscode/target-workspace-host',
  version: targetWorkspaceHostVersion,
};

export type TargetWorkspaceHostStage =
  | 'analysis-partial'
  | 'awaiting-module-review'
  | 'revision-required'
  | 'rejected'
  | 'status-inventory-failed'
  | 'reviewed'
  | 'body-only-compatible'
  | 'stale';

export type TargetWorkspaceFreshness = ReturnType<
  typeof classifyTargetWorkspaceSnapshotFreshness
>;

export interface TargetWorkspaceAnalysisState {
  analysis: RepositoryStaticAnalysis;
  ir: UnifiedRepositoryIR;
}

export interface TargetWorkspaceDiscoveryState {
  proposal: ModuleDiscoveryProposal;
  draftCatalog: RepositoryModuleCatalog;
}

export interface TargetWorkspaceAcceptedState {
  analysis: RepositoryStaticAnalysis;
  ir: UnifiedRepositoryIR;
  proposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
  snapshot?: TargetWorkspaceModuleSnapshot;
}

/**
 * Host-owned 01B state. It intentionally contains no summary, knowledge
 * publication, registry, or search-index handle. Target workspaces stop after
 * the reviewed catalog and their snapshot-bound implementation inventory.
 */
export interface TargetWorkspaceHostRecord {
  role: 'target-workspace';
  workspaceId: string;
  repositoryRoot: string;
  stage: TargetWorkspaceHostStage;
  latest: TargetWorkspaceAnalysisState;
  readiness: RepositoryModuleDiscoveryReadiness;
  constraints: ModuleDiscoveryConstraint[];
  discovery?: TargetWorkspaceDiscoveryState;
  gate1Review?: RepositoryModuleReview;
  accepted?: TargetWorkspaceAcceptedState;
  freshness?: TargetWorkspaceFreshness;
  failure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetWorkspaceHostStore {
  load(workspaceId: string): Promise<TargetWorkspaceHostRecord | null>;
  /**
   * When `expectedRecord` is supplied, replace only that exact prior value;
   * `null` means the record must not exist. Trusted Host mutations always use
   * this compare-and-swap form so multiple extension windows cannot overwrite
   * one another silently.
   */
  save(
    record: TargetWorkspaceHostRecord,
    expectedRecord?: TargetWorkspaceHostRecord | null,
  ): Promise<void>;
}

export interface TargetWorkspaceModuleDiscoveryRequest {
  snapshotId: string;
  constraints?: Array<Pick<ModuleDiscoveryConstraint, 'id' | 'description' | 'required'>>;
}

export interface TargetWorkspaceImplementationInventoryRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  ir: UnifiedRepositoryIR;
  proposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
  producer: RepositoryArtifactProducer;
  createdAt: string;
}

/**
 * Language detectors remain replaceable. The returned canonical snapshot is
 * revalidated by the Host before it can make the target workspace current.
 */
export interface TargetWorkspaceImplementationInventoryPort {
  build(
    request: TargetWorkspaceImplementationInventoryRequest,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceModuleSnapshot>;
}

export interface TargetWorkspaceHostDependencies {
  store: TargetWorkspaceHostStore;
  discoverModules(
    request: TargetWorkspaceModuleDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<ModuleDiscoveryProposal>;
  implementationInventory: TargetWorkspaceImplementationInventoryPort;
  analyze?: (request: AnalyzeRepositoryRequest) => Promise<RepositoryStaticAnalysis>;
  /** Defaults to `analyze`; split only so deterministic tests can model a Gate-time re-read. */
  verifyCurrentAnalysis?: (request: AnalyzeRepositoryRequest) => Promise<RepositoryStaticAnalysis>;
  bridge?: (analysis: RepositoryStaticAnalysis) => RepositoryStaticAnalysisBridgeArtifacts;
  now?: () => string;
  producer?: RepositoryArtifactProducer;
}

export interface InitializeTargetWorkspaceRequest {
  workspaceId: string;
  repositoryRoot: string;
  repositoryId?: string;
  constraints?: Array<Pick<ModuleDiscoveryConstraint, 'id' | 'description' | 'required'>>;
  signal?: AbortSignal;
}

export interface SubmitTargetWorkspaceGate1Request {
  workspaceId: string;
  expectedProposalId: string;
  expectedProposalHash: string;
  expectedIrId: string;
  expectedIrHash: string;
  decision: RepositoryModuleReview['decision'];
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
  signal?: AbortSignal;
}

export interface SubmitTargetWorkspaceRevisionRequest {
  workspaceId: string;
  replacementProposal: ModuleDiscoveryProposal;
}

export interface RebaseTargetWorkspaceBodyOnlyRequest {
  workspaceId: string;
  expectedModuleSnapshotId: string;
  expectedModuleSnapshotHash: string;
  expectedCatalogId: string;
  expectedCatalogHash: string;
  expectedLatestAnalysisSnapshotId: string;
  expectedLatestIrId: string;
  expectedLatestIrHash: string;
}

export interface TargetWorkspaceContextRequest {
  workspaceId: string;
  snapshotId: string;
  snapshotHash: string;
  entityId: string;
}

export interface TargetWorkspaceEntityContext {
  role: 'target-workspace';
  workspaceId: string;
  snapshotId: string;
  snapshot: TargetWorkspaceModuleSnapshot;
  ir: UnifiedRepositoryIR;
  catalog: RepositoryModuleCatalog;
  entity: UnifiedRepositoryIR['entities'][number];
  file?: UnifiedRepositoryIR['files'][number];
  module?: RepositoryModuleCatalog['modules'][number];
  assessment?: TargetWorkspaceModuleSnapshot['assessments'][number];
  classRollup?: TargetWorkspaceModuleSnapshot['classRollups'][number];
  fileRollup?: TargetWorkspaceModuleSnapshot['fileRollups'][number];
  moduleRollup?: TargetWorkspaceModuleSnapshot['moduleRollups'][number];
}

function normalizeWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error('Target workspace ID must be non-empty and at most 512 characters.');
  }
  return normalized;
}

function normalizeConstraints(
  constraints:
    | readonly Pick<ModuleDiscoveryConstraint, 'id' | 'description' | 'required'>[]
    | undefined,
): ModuleDiscoveryConstraint[] {
  const normalized = [...(constraints ?? [])]
    .map((constraint) => ({
      id: constraint.id.trim(),
      description: constraint.description.trim(),
      required: constraint.required,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const constraint of normalized) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(constraint.id) ||
      ids.has(constraint.id) ||
      !constraint.description ||
      constraint.description.length > 2_000 ||
      typeof constraint.required !== 'boolean'
    ) {
      throw new Error('Target workspace module-discovery constraints are invalid.');
    }
    ids.add(constraint.id);
  }
  if (normalized.length > 64) {
    throw new Error('Target workspace module-discovery constraints cannot exceed 64 entries.');
  }
  return normalized;
}

function discoveryClientConstraints(
  constraints: readonly ModuleDiscoveryConstraint[],
): TargetWorkspaceModuleDiscoveryRequest['constraints'] {
  return constraints.map(({ id, description, required }) => ({ id, description, required }));
}

function canonicalConstraintProjection(
  constraints: readonly ModuleDiscoveryConstraint[],
): string {
  return JSON.stringify(normalizeConstraints(constraints).map((constraint) => ({
    id: constraint.id,
    description: constraint.description,
    required: constraint.required,
    evidenceRefs: constraint.evidenceRefs,
  })));
}

function assertDiscoveryResponseBinding(
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  constraints: readonly ModuleDiscoveryConstraint[],
): void {
  if (
    proposal.repositoryId !== ir.repositoryId ||
    proposal.sourceIrId !== ir.id ||
    proposal.sourceIrHash !== ir.contentHash
  ) {
    throw new Error('Target module proposal does not bind to the current Unified Repository IR.');
  }
  if (proposal.status !== 'awaiting-review') {
    throw new Error('Target module discovery service cannot pre-approve or close Gate1.');
  }
  if (canonicalConstraintProjection(proposal.constraints) !== canonicalConstraintProjection(constraints)) {
    throw new Error('Target module proposal changed the Host-owned discovery constraints.');
  }
}

function assertExpectedGate1Binding(
  record: TargetWorkspaceHostRecord,
  request: SubmitTargetWorkspaceGate1Request,
): TargetWorkspaceDiscoveryState {
  if (record.stage !== 'awaiting-module-review' || !record.discovery) {
    throw new Error(`Target workspace is not awaiting Gate1 review: ${record.stage}.`);
  }
  const { proposal } = record.discovery;
  if (
    proposal.id !== request.expectedProposalId ||
    proposal.contentHash !== request.expectedProposalHash ||
    record.latest.ir.id !== request.expectedIrId ||
    record.latest.ir.contentHash !== request.expectedIrHash
  ) {
    throw new Error('Gate1 decision is stale and does not bind to the current target proposal and IR.');
  }
  return record.discovery;
}

type RepositoryIrFile = UnifiedRepositoryIR['files'][number];
type RepositoryIrEntity = UnifiedRepositoryIR['entities'][number];

function sortedText(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function declarationIdentity(
  entity: RepositoryIrEntity,
  ir: UnifiedRepositoryIR,
): string {
  const fileById = new Map(ir.files.map((file) => [file.id, file]));
  const entityById = new Map(ir.entities.map((candidate) => [candidate.id, candidate]));
  const container = entity.containerEntityId
    ? entityById.get(entity.containerEntityId)
    : undefined;
  return canonicalJson({
    filePath: entity.fileId ? fileById.get(entity.fileId)?.path ?? '' : '',
    kind: entity.kind,
    name: entity.name,
    qualifiedName: entity.qualifiedName,
    languageId: entity.languageId,
    signature: entity.signature,
    visibility: entity.visibility,
    testOnly: entity.testOnly,
    staticSymbolKind: typeof entity.attributes?.staticSymbolKind === 'string'
      ? entity.attributes.staticSymbolKind
      : undefined,
    container: container
      ? {
          kind: container.kind,
          qualifiedName: container.qualifiedName,
          name: container.name,
          filePath: container.fileId ? fileById.get(container.fileId)?.path ?? '' : '',
        }
      : undefined,
  });
}

function uniqueIdentityMatch<T>(
  values: readonly T[],
  label: string,
): T {
  if (values.length !== 1) {
    throw new Error(
      values.length === 0
        ? `Body-only rebase cannot map ${label}.`
        : `Body-only rebase has an ambiguous mapping for ${label}.`,
    );
  }
  return values[0]!;
}

function dependencyIdentity(
  dependency: UnifiedRepositoryIR['dependencies'][number],
  ir: UnifiedRepositoryIR,
): string {
  const fileById = new Map(ir.files.map((file) => [file.id, file]));
  const entityById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const sourceEntity = dependency.sourceEntityId
    ? entityById.get(dependency.sourceEntityId)
    : undefined;
  const targetEntity = dependency.targetEntityId
    ? entityById.get(dependency.targetEntityId)
    : undefined;
  return canonicalJson({
    sourcePath: fileById.get(dependency.sourceFileId)?.path,
    targetPath: dependency.targetFileId
      ? fileById.get(dependency.targetFileId)?.path
      : undefined,
    sourceEntity: sourceEntity ? declarationIdentity(sourceEntity, ir) : undefined,
    targetEntity: targetEntity ? declarationIdentity(targetEntity, ir) : undefined,
    kind: dependency.kind,
    internal: dependency.internal,
    resolution: dependency.resolution,
    evidenceLevel: dependency.evidenceLevel,
    targetReference: dependency.targetReference,
  });
}

function diagnosticIdentity(
  diagnostic: UnifiedRepositoryIR['diagnostics'][number],
): string {
  return canonicalJson({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    adapterId: diagnostic.adapterId,
    languageId: diagnostic.languageId,
    path: diagnostic.path,
  });
}

interface BodyOnlyBoundaryMapper {
  fileId(id: string): string;
  entityId(id: string): string;
  evidence(refs: readonly RepositoryEvidenceRef[]): RepositoryEvidenceRef[];
}

function bodyOnlyBoundaryMapper(
  sourceIr: UnifiedRepositoryIR,
  targetIr: UnifiedRepositoryIR,
): BodyOnlyBoundaryMapper {
  const sourceFileById = new Map(sourceIr.files.map((file) => [file.id, file]));
  const targetFilesByPath = new Map<string, RepositoryIrFile[]>();
  for (const file of targetIr.files) {
    const matches = targetFilesByPath.get(file.path) ?? [];
    matches.push(file);
    targetFilesByPath.set(file.path, matches);
  }
  const sourceEntityById = new Map(sourceIr.entities.map((entity) => [entity.id, entity]));
  const targetEntitiesByIdentity = new Map<string, RepositoryIrEntity[]>();
  for (const entity of targetIr.entities) {
    const identity = declarationIdentity(entity, targetIr);
    const matches = targetEntitiesByIdentity.get(identity) ?? [];
    matches.push(entity);
    targetEntitiesByIdentity.set(identity, matches);
  }
  const fileId = (id: string): string => {
    const source = sourceFileById.get(id);
    if (!source) throw new Error(`Body-only rebase references an unknown source file: ${id}.`);
    return uniqueIdentityMatch(
      targetFilesByPath.get(source.path) ?? [],
      `file path ${source.path}`,
    ).id;
  };
  const entityId = (id: string): string => {
    const source = sourceEntityById.get(id);
    if (!source) throw new Error(`Body-only rebase references an unknown source entity: ${id}.`);
    return uniqueIdentityMatch(
      targetEntitiesByIdentity.get(declarationIdentity(source, sourceIr)) ?? [],
      `declaration ${source.qualifiedName ?? source.name}`,
    ).id;
  };

  const sourceApiById = new Map(sourceIr.apiSurfaces.map((surface) => [surface.id, surface]));
  const sourceDependencyById = new Map(
    sourceIr.dependencies.map((dependency) => [dependency.id, dependency]),
  );
  const targetDependenciesByIdentity = new Map<
    string,
    UnifiedRepositoryIR['dependencies'][number][]
  >();
  for (const dependency of targetIr.dependencies) {
    const identity = dependencyIdentity(dependency, targetIr);
    const matches = targetDependenciesByIdentity.get(identity) ?? [];
    matches.push(dependency);
    targetDependenciesByIdentity.set(identity, matches);
  }
  const sourceDiagnosticById = new Map(
    sourceIr.diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]),
  );
  const targetDiagnosticsByIdentity = new Map<
    string,
    UnifiedRepositoryIR['diagnostics'][number][]
  >();
  for (const diagnostic of targetIr.diagnostics) {
    const identity = diagnosticIdentity(diagnostic);
    const matches = targetDiagnosticsByIdentity.get(identity) ?? [];
    matches.push(diagnostic);
    targetDiagnosticsByIdentity.set(identity, matches);
  }
  const mapEvidenceId = (id: string): string => {
    if (sourceFileById.has(id)) return fileId(id);
    if (sourceEntityById.has(id)) return entityId(id);
    const sourceApi = sourceApiById.get(id);
    if (sourceApi) {
      const mappedEntityId = entityId(sourceApi.entityId);
      return uniqueIdentityMatch(
        targetIr.apiSurfaces.filter((surface) => surface.entityId === mappedEntityId),
        `API surface for ${sourceApi.qualifiedName}`,
      ).id;
    }
    const sourceDependency = sourceDependencyById.get(id);
    if (sourceDependency) {
      return uniqueIdentityMatch(
        targetDependenciesByIdentity.get(dependencyIdentity(sourceDependency, sourceIr)) ?? [],
        `dependency ${sourceDependency.kind}:${sourceDependency.id}`,
      ).id;
    }
    const sourceDiagnostic = sourceDiagnosticById.get(id);
    if (sourceDiagnostic) {
      return uniqueIdentityMatch(
        targetDiagnosticsByIdentity.get(diagnosticIdentity(sourceDiagnostic)) ?? [],
        `diagnostic ${sourceDiagnostic.code}:${sourceDiagnostic.id}`,
      ).id;
    }
    throw new Error(`Body-only rebase cannot map evidence reference: ${id}.`);
  };
  return {
    fileId,
    entityId,
    evidence(refs) {
      return refs.map((ref) => ({
        id: mapEvidenceId(ref.id),
        kind: ref.kind,
        ...(ref.sourceArtifactId === undefined ? {} : { sourceArtifactId: targetIr.id }),
        ...(ref.summary === undefined ? {} : { summary: ref.summary }),
      })).sort((left, right) => left.id.localeCompare(right.id));
    },
  };
}

function createBodyOnlyRebaseProposal(
  accepted: TargetWorkspaceAcceptedState & { snapshot: TargetWorkspaceModuleSnapshot },
  targetIr: UnifiedRepositoryIR,
  constraints: readonly ModuleDiscoveryConstraint[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): ModuleDiscoveryProposal {
  const mapper = bodyOnlyBoundaryMapper(accepted.ir, targetIr);
  const seedHash = sha256Hex(canonicalJson({
    kind: 'target-workspace-body-only-rebase',
    sourceCatalogId: accepted.catalog.id,
    sourceCatalogHash: accepted.catalog.contentHash,
    sourceSnapshotId: accepted.snapshot.id,
    sourceSnapshotHash: accepted.snapshot.contentHash,
    targetIrId: targetIr.id,
    targetIrHash: targetIr.contentHash,
  }));
  const payload: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: accepted.proposal.schemaVersion,
    id: `target-module-rebase:${seedHash.slice(0, 24)}`,
    repositoryId: targetIr.repositoryId,
    sourceIrId: targetIr.id,
    sourceIrHash: targetIr.contentHash,
    ...(accepted.proposal.objective === undefined
      ? {}
      : { objective: accepted.proposal.objective }),
    constraints: constraints.map((constraint) => ({
      id: constraint.id,
      description: constraint.description,
      required: constraint.required,
      ...(constraint.evidenceRefs === undefined
        ? {}
        : { evidenceRefs: mapper.evidence(constraint.evidenceRefs) }),
    })),
    status: 'awaiting-review',
    modules: accepted.catalog.modules.map((module) => ({
      ...module,
      fileIds: sortedText(module.fileIds.map(mapper.fileId)),
      entityIds: sortedText(module.entityIds.map(mapper.entityId)),
      entryPointEntityIds: sortedText(module.entryPointEntityIds.map(mapper.entityId)),
      publicApiEntityIds: sortedText(module.publicApiEntityIds.map(mapper.entityId)),
      evidenceRefs: mapper.evidence(module.evidenceRefs),
    })),
    assignments: accepted.catalog.assignments.map((assignment) => ({
      ...assignment,
      fileId: mapper.fileId(assignment.fileId),
      moduleIds: sortedText(assignment.moduleIds),
      evidenceRefs: mapper.evidence(assignment.evidenceRefs),
    })),
    dependencies: accepted.catalog.dependencies.map((dependency) => ({
      ...dependency,
      evidenceRefs: mapper.evidence(dependency.evidenceRefs),
    })),
    assumptions: [...accepted.proposal.assumptions],
    risks: [...accepted.proposal.risks],
    unresolvedQuestions: [...accepted.proposal.unresolvedQuestions],
    producer,
    createdAt,
  };
  return {
    ...payload,
    contentHash: sha256Hex(canonicalJson(payload)),
  };
}

function cloneRecord(record: TargetWorkspaceHostRecord): TargetWorkspaceHostRecord {
  return structuredClone(record);
}

export class InMemoryTargetWorkspaceHostStore implements TargetWorkspaceHostStore {
  readonly #records = new Map<string, TargetWorkspaceHostRecord>();

  async load(workspaceId: string): Promise<TargetWorkspaceHostRecord | null> {
    const record = this.#records.get(workspaceId);
    return record === undefined ? null : cloneRecord(record);
  }

  async save(
    record: TargetWorkspaceHostRecord,
    expectedRecord?: TargetWorkspaceHostRecord | null,
  ): Promise<void> {
    if (expectedRecord !== undefined) {
      const current = this.#records.get(record.workspaceId) ?? null;
      if (
        (expectedRecord === null && current !== null) ||
        (expectedRecord !== null && (
          current === null || canonicalJson(current) !== canonicalJson(expectedRecord)
        ))
      ) {
        throw new Error('Target workspace store compare-and-swap conflict.');
      }
    }
    this.#records.set(record.workspaceId, cloneRecord(record));
  }
}

export class TargetWorkspaceHost {
  readonly #analyze: (request: AnalyzeRepositoryRequest) => Promise<RepositoryStaticAnalysis>;
  readonly #verifyCurrentAnalysis: (
    request: AnalyzeRepositoryRequest,
  ) => Promise<RepositoryStaticAnalysis>;
  readonly #bridge: (analysis: RepositoryStaticAnalysis) => RepositoryStaticAnalysisBridgeArtifacts;
  readonly #now: () => string;
  readonly #producer: RepositoryArtifactProducer;
  readonly #workspaceMutationTails = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: TargetWorkspaceHostDependencies) {
    this.#analyze = dependencies.analyze ?? analyzeRepository;
    this.#verifyCurrentAnalysis = dependencies.verifyCurrentAnalysis ?? this.#analyze;
    this.#bridge = dependencies.bridge ?? bridgeRepositoryStaticAnalysis;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#producer = dependencies.producer ?? targetWorkspaceProducer;
  }

  async initialize(
    request: InitializeTargetWorkspaceRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(request.workspaceId);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#initializeLocked(workspaceId, request));
  }

  async #initializeLocked(
    workspaceId: string,
    request: InitializeTargetWorkspaceRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    request.signal?.throwIfAborted();
    const constraints = normalizeConstraints(request.constraints);
    const analysis = await this.#analyze({
      root: request.repositoryRoot,
      semanticEnrichment: true,
      allowDirtyWorktreeForPlanning: true,
      ...(request.repositoryId === undefined ? {} : { repositoryId: request.repositoryId }),
    });
    request.signal?.throwIfAborted();
    const { shards, unifiedIr: ir } = this.#bridge(analysis);
    if (ir.repositoryContentHash !== analysis.contentHash) {
      throw new Error('Target workspace IR does not bind to the analysed repository snapshot.');
    }
    const readiness = assessRepositoryModuleDiscoveryReadiness(shards, ir);
    const occurredAt = this.#now();
    const existing = await this.dependencies.store.load(workspaceId);
    if (
      existing &&
      existing.repositoryRoot === request.repositoryRoot &&
      existing.latest.analysis.snapshotId === analysis.snapshotId &&
      existing.latest.analysis.contentHash === analysis.contentHash &&
      existing.latest.ir.id === ir.id &&
      existing.latest.ir.contentHash === ir.contentHash &&
      JSON.stringify(existing.constraints) === JSON.stringify(constraints) &&
      existing.stage !== 'revision-required' &&
      existing.stage !== 'rejected' &&
      existing.stage !== 'stale' &&
      existing.stage !== 'body-only-compatible'
    ) {
      return existing;
    }

    if (!readiness.ready) {
      const record: TargetWorkspaceHostRecord = {
        role: 'target-workspace',
        workspaceId,
        repositoryRoot: request.repositoryRoot,
        stage: 'analysis-partial',
        latest: { analysis, ir },
        readiness,
        constraints,
        createdAt: existing?.createdAt ?? occurredAt,
        updatedAt: occurredAt,
      };
      await this.dependencies.store.save(record, existing);
      return cloneRecord(record);
    }

    const proposal = await this.dependencies.discoverModules(
      {
        snapshotId: analysis.snapshotId,
        ...(constraints.length === 0
          ? {}
          : { constraints: discoveryClientConstraints(constraints) }),
      },
      request.signal,
    );
    request.signal?.throwIfAborted();
    assertDiscoveryResponseBinding(proposal, ir, constraints);
    const draftCatalog = materializeRepositoryModuleCatalog(proposal, ir, {
      producer: this.#producer,
      createdAt: occurredAt,
    });
    const record: TargetWorkspaceHostRecord = {
      role: 'target-workspace',
      workspaceId,
      repositoryRoot: request.repositoryRoot,
      stage: 'awaiting-module-review',
      latest: { analysis, ir },
      readiness,
      constraints,
      discovery: { proposal, draftCatalog },
      ...(existing?.accepted === undefined ? {} : { accepted: existing.accepted }),
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    };
    await this.dependencies.store.save(record, existing);
    return cloneRecord(record);
  }

  async submitGate1(
    request: SubmitTargetWorkspaceGate1Request,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(request.workspaceId);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#submitGate1Locked(workspaceId, request));
  }

  async #submitGate1Locked(
    workspaceId: string,
    request: SubmitTargetWorkspaceGate1Request,
  ): Promise<TargetWorkspaceHostRecord> {
    const persistedRecord = await this.#requireRecord(workspaceId);
    let record = persistedRecord;
    request.signal?.throwIfAborted();
    const currentAnalysis = await this.#verifyCurrentAnalysis({
      root: record.repositoryRoot,
      semanticEnrichment: true,
      allowDirtyWorktreeForPlanning: true,
      ...(record.latest.analysis.repository.id === undefined
        ? {}
        : { repositoryId: record.latest.analysis.repository.id }),
    });
    request.signal?.throwIfAborted();
    const { shards, unifiedIr: currentIr } = this.#bridge(currentAnalysis);
    const currentReadiness = assessRepositoryModuleDiscoveryReadiness(shards, currentIr);
    if (
      !currentReadiness.ready ||
      currentAnalysis.snapshotId !== record.latest.analysis.snapshotId ||
      currentAnalysis.contentHash !== record.latest.analysis.contentHash ||
      currentIr.id !== record.latest.ir.id ||
      currentIr.contentHash !== record.latest.ir.contentHash
    ) {
      const stale: TargetWorkspaceHostRecord = {
        ...record,
        stage: 'stale',
        latest: { analysis: currentAnalysis, ir: currentIr },
        readiness: currentReadiness,
        failure: 'Target workspace changed before Gate1 was recorded; the proposal must be regenerated.',
        updatedAt: this.#now(),
      };
      await this.dependencies.store.save(stale, persistedRecord);
      throw new Error(stale.failure);
    }
    // Keep all subsequent checks bound to the freshly re-read identities.
    record = { ...record, latest: { analysis: currentAnalysis, ir: currentIr } };
    const discovery = assertExpectedGate1Binding(record, request);
    const decidedAt = this.#now();
    const review = materializeRepositoryModuleReview(discovery.proposal, record.latest.ir, {
      decision: request.decision,
      reviewerId: request.reviewerId,
      ...(request.comment === undefined ? {} : { comment: request.comment }),
      ...(request.acceptedRiskIds === undefined ? {} : { acceptedRiskIds: request.acceptedRiskIds }),
      decidedAt,
    });
    const applied = applyRepositoryModuleReview(
      discovery.draftCatalog,
      discovery.proposal,
      record.latest.ir,
      review,
    );

    if (request.decision !== 'accept' || !applied.catalog) {
      const closed: TargetWorkspaceHostRecord = {
        ...record,
        stage: request.decision === 'revise' ? 'revision-required' : 'rejected',
        gate1Review: review,
        updatedAt: decidedAt,
      };
      await this.dependencies.store.save(closed, persistedRecord);
      return cloneRecord(closed);
    }

    const accepted: TargetWorkspaceAcceptedState = {
      ...record.latest,
      proposal: discovery.proposal,
      review,
      catalog: applied.catalog,
    };
    const inventoryPending: TargetWorkspaceHostRecord = {
      ...record,
      stage: 'status-inventory-failed',
      gate1Review: review,
      accepted,
      failure: 'Target implementation inventory has not completed.',
      updatedAt: decidedAt,
    };
    // Persist the immutable Gate1 decision before detector work. A detector
    // failure must never erase or fabricate the human boundary decision.
    await this.dependencies.store.save(inventoryPending, persistedRecord);

    try {
      const snapshot = await this.dependencies.implementationInventory.build({
        repositoryRoot: record.repositoryRoot,
        analysis: record.latest.analysis,
        ir: record.latest.ir,
        proposal: discovery.proposal,
        review,
        catalog: applied.catalog,
        producer: this.#producer,
        createdAt: review.decidedAt,
      }, request.signal);
      request.signal?.throwIfAborted();
      validateTargetWorkspaceModuleSnapshot(snapshot, record.latest.ir, applied.catalog);
      const reviewed: TargetWorkspaceHostRecord = {
        ...inventoryPending,
        stage: 'reviewed',
        accepted: { ...accepted, snapshot },
        failure: undefined,
        updatedAt: this.#now(),
      };
      await this.dependencies.store.save(reviewed, inventoryPending);
      return cloneRecord(reviewed);
    } catch (error) {
      const failed: TargetWorkspaceHostRecord = {
        ...inventoryPending,
        failure: error instanceof Error ? error.message : String(error),
        updatedAt: this.#now(),
      };
      await this.dependencies.store.save(failed, inventoryPending);
      throw error;
    }
  }

  async submitRevision(
    request: SubmitTargetWorkspaceRevisionRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(request.workspaceId);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#submitRevisionLocked(workspaceId, request));
  }

  async #submitRevisionLocked(
    workspaceId: string,
    request: SubmitTargetWorkspaceRevisionRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    const record = await this.#requireRecord(workspaceId);
    if (record.stage !== 'revision-required' || record.gate1Review?.decision !== 'revise') {
      throw new Error(`Target workspace does not require a Gate1 replacement proposal: ${record.stage}.`);
    }
    if (
      record.discovery &&
      request.replacementProposal.id === record.discovery.proposal.id &&
      request.replacementProposal.contentHash === record.discovery.proposal.contentHash
    ) {
      throw new Error('Gate1 revision must submit a distinct replacement proposal.');
    }
    assertDiscoveryResponseBinding(
      request.replacementProposal,
      record.latest.ir,
      record.constraints,
    );
    const occurredAt = this.#now();
    const draftCatalog = materializeRepositoryModuleCatalog(
      request.replacementProposal,
      record.latest.ir,
      { producer: this.#producer, createdAt: occurredAt },
    );
    const revised: TargetWorkspaceHostRecord = {
      ...record,
      stage: 'awaiting-module-review',
      discovery: {
        proposal: request.replacementProposal,
        draftCatalog,
      },
      gate1Review: undefined,
      failure: undefined,
      updatedAt: occurredAt,
    };
    await this.dependencies.store.save(revised, record);
    return cloneRecord(revised);
  }

  async rebaseBodyOnly(
    request: RebaseTargetWorkspaceBodyOnlyRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(request.workspaceId);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#rebaseBodyOnlyLocked(workspaceId, request));
  }

  async #rebaseBodyOnlyLocked(
    workspaceId: string,
    request: RebaseTargetWorkspaceBodyOnlyRequest,
  ): Promise<TargetWorkspaceHostRecord> {
    const record = await this.#requireRecord(workspaceId);
    const accepted = record.accepted;
    if (
      record.stage !== 'body-only-compatible' ||
      !accepted?.snapshot ||
      record.freshness?.status !== 'body-only-compatible'
    ) {
      throw new Error(`Target workspace is not eligible for a body-only rebase: ${record.stage}.`);
    }
    if (
      accepted.snapshot.id !== request.expectedModuleSnapshotId ||
      accepted.snapshot.contentHash !== request.expectedModuleSnapshotHash ||
      accepted.catalog.id !== request.expectedCatalogId ||
      accepted.catalog.contentHash !== request.expectedCatalogHash ||
      record.latest.analysis.snapshotId !== request.expectedLatestAnalysisSnapshotId ||
      record.latest.ir.id !== request.expectedLatestIrId ||
      record.latest.ir.contentHash !== request.expectedLatestIrHash
    ) {
      throw new Error('Body-only rebase request is stale and does not bind to both source and target snapshots.');
    }
    validateTargetWorkspaceModuleSnapshot(accepted.snapshot, accepted.ir, accepted.catalog);
    const freshness = classifyTargetWorkspaceSnapshotFreshness(
      accepted.snapshot,
      record.latest.ir,
    );
    const structureCompatible =
      accepted.snapshot.structureHash === calculateTargetWorkspaceStructureHash(record.latest.ir);
    if (freshness.status !== 'body-only-compatible' || !structureCompatible) {
      const stale: TargetWorkspaceHostRecord = {
        ...record,
        stage: 'stale',
        freshness,
        failure: 'Body-only rebase was refused because the current declaration structure is stale.',
        updatedAt: this.#now(),
      };
      await this.dependencies.store.save(stale, record);
      throw new Error(stale.failure);
    }

    try {
      const occurredAt = this.#now();
      const proposal = createBodyOnlyRebaseProposal(
        accepted as TargetWorkspaceAcceptedState & { snapshot: TargetWorkspaceModuleSnapshot },
        record.latest.ir,
        record.constraints,
        this.#producer,
        occurredAt,
      );
      assertDiscoveryResponseBinding(proposal, record.latest.ir, record.constraints);
      const draftCatalog = materializeRepositoryModuleCatalog(proposal, record.latest.ir, {
        producer: this.#producer,
        createdAt: occurredAt,
      });
      const awaitingReview: TargetWorkspaceHostRecord = {
        ...record,
        stage: 'awaiting-module-review',
        discovery: { proposal, draftCatalog },
        gate1Review: undefined,
        freshness: undefined,
        failure: undefined,
        updatedAt: occurredAt,
      };
      await this.dependencies.store.save(awaitingReview, record);
      return cloneRecord(awaitingReview);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const stale: TargetWorkspaceHostRecord = {
        ...record,
        stage: 'stale',
        freshness: undefined,
        failure: `Body-only module-boundary rebase failed closed: ${reason}`,
        updatedAt: this.#now(),
      };
      await this.dependencies.store.save(stale, record);
      throw new Error(stale.failure);
    }
  }

  async rebuildImplementationInventory(
    workspaceIdInput: string,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#rebuildImplementationInventoryLocked(workspaceId, signal));
  }

  async #rebuildImplementationInventoryLocked(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceHostRecord> {
    const record = await this.#requireRecord(workspaceId);
    const accepted = record.accepted;
    if (!accepted || record.stage !== 'status-inventory-failed') {
      throw new Error(`Target workspace has no retryable implementation inventory: ${record.stage}.`);
    }
    const snapshot = await this.dependencies.implementationInventory.build({
      repositoryRoot: record.repositoryRoot,
      analysis: accepted.analysis,
      ir: accepted.ir,
      proposal: accepted.proposal,
      review: accepted.review,
      catalog: accepted.catalog,
      producer: this.#producer,
      createdAt: accepted.review.decidedAt,
    }, signal);
    signal?.throwIfAborted();
    validateTargetWorkspaceModuleSnapshot(snapshot, accepted.ir, accepted.catalog);
    const reviewed: TargetWorkspaceHostRecord = {
      ...record,
      stage: 'reviewed',
      accepted: { ...accepted, snapshot },
      failure: undefined,
      updatedAt: this.#now(),
    };
    await this.dependencies.store.save(reviewed, record);
    return cloneRecord(reviewed);
  }

  async refresh(
    workspaceIdInput: string,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceHostRecord> {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput);
    return this.#withWorkspaceMutation(workspaceId, () =>
      this.#refreshLocked(workspaceId, signal));
  }

  async #refreshLocked(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceHostRecord> {
    const record = await this.#requireRecord(workspaceId);
    signal?.throwIfAborted();
    const analysis = await this.#analyze({
      root: record.repositoryRoot,
      semanticEnrichment: true,
      allowDirtyWorktreeForPlanning: true,
      ...(record.latest.analysis.repository.id === undefined
        ? {}
        : { repositoryId: record.latest.analysis.repository.id }),
    });
    signal?.throwIfAborted();
    const { shards, unifiedIr: ir } = this.#bridge(analysis);
    const readiness = assessRepositoryModuleDiscoveryReadiness(shards, ir);
    const updatedAt = this.#now();

    if (!readiness.ready) {
      const partial: TargetWorkspaceHostRecord = {
        ...record,
        stage: 'analysis-partial',
        latest: { analysis, ir },
        readiness,
        failure: 'Current target analysis is partial; reviewed target context is unavailable.',
        updatedAt,
      };
      await this.dependencies.store.save(partial, record);
      return cloneRecord(partial);
    }

    if (
      record.stage === 'awaiting-module-review' ||
      record.stage === 'revision-required' ||
      record.stage === 'rejected'
    ) {
      const exactLatest =
        record.latest.analysis.snapshotId === analysis.snapshotId &&
        record.latest.analysis.contentHash === analysis.contentHash &&
        record.latest.ir.id === ir.id &&
        record.latest.ir.contentHash === ir.contentHash;
      const proposalCurrent = record.stage !== 'awaiting-module-review' || (
        record.discovery?.proposal.sourceIrId === ir.id &&
        record.discovery.proposal.sourceIrHash === ir.contentHash
      );
      const guarded: TargetWorkspaceHostRecord = exactLatest && proposalCurrent
        ? {
            ...record,
            latest: { analysis, ir },
            readiness,
            updatedAt,
          }
        : {
            ...record,
            stage: 'stale',
            latest: { analysis, ir },
            readiness,
            failure: 'Target workspace changed while a Gate1 decision was pending or closed.',
            updatedAt,
          };
      await this.dependencies.store.save(guarded, record);
      return cloneRecord(guarded);
    }

    if (!record.accepted?.snapshot) {
      const unchanged =
        record.latest.analysis.snapshotId === analysis.snapshotId &&
        record.latest.analysis.contentHash === analysis.contentHash;
      const refreshed: TargetWorkspaceHostRecord = unchanged
        ? { ...record, latest: { analysis, ir }, readiness, updatedAt }
        : {
            ...record,
            stage: 'stale',
            latest: { analysis, ir },
            readiness,
            failure: 'Target workspace changed before a current reviewed status inventory existed.',
            updatedAt,
          };
      await this.dependencies.store.save(refreshed, record);
      return cloneRecord(refreshed);
    }

    const accepted = record.accepted;
    const acceptedSnapshot = accepted.snapshot!;
    const freshness = classifyTargetWorkspaceSnapshotFreshness(
      acceptedSnapshot,
      ir,
      accepted.catalog.sourceIrId === ir.id && accepted.catalog.sourceIrHash === ir.contentHash
        ? accepted.catalog
        : undefined,
    );
    const stage: TargetWorkspaceHostStage = freshness.status === 'current'
      ? 'reviewed'
      : freshness.status === 'body-only-compatible'
        ? 'body-only-compatible'
        : 'stale';
    const refreshed: TargetWorkspaceHostRecord = {
      ...record,
      stage,
      latest: { analysis, ir },
      readiness,
      freshness,
      failure: stage === 'reviewed'
        ? undefined
        : stage === 'body-only-compatible'
          ? 'Body-only compatibility requires an explicit boundary rebase and a newly detected status inventory.'
          : 'Target workspace structure is stale and requires fresh module discovery and Gate1 review.',
      updatedAt,
    };
    await this.dependencies.store.save(refreshed, record);
    return cloneRecord(refreshed);
  }

  async getTargetContext(
    request: TargetWorkspaceContextRequest,
  ): Promise<TargetWorkspaceEntityContext> {
    const workspaceId = normalizeWorkspaceId(request.workspaceId);
    const record = await this.#requireRecord(workspaceId);
    if (record.stage !== 'reviewed' || !record.accepted?.snapshot) {
      throw new Error(`Target context is unavailable while workspace stage is ${record.stage}.`);
    }
    const { accepted } = record;
    const snapshot = accepted.snapshot!;
    if (
      snapshot.id !== request.snapshotId ||
      snapshot.contentHash !== request.snapshotHash ||
      accepted.ir.id !== record.latest.ir.id ||
      accepted.ir.contentHash !== record.latest.ir.contentHash
    ) {
      throw new Error('Target context request is stale and does not bind to the current reviewed snapshot.');
    }
    validateTargetWorkspaceModuleSnapshot(snapshot, accepted.ir, accepted.catalog);
    const entity = accepted.ir.entities.find((candidate) => candidate.id === request.entityId);
    if (!entity) throw new Error(`Unknown target workspace entity: ${request.entityId}.`);
    const file = entity.fileId === undefined
      ? undefined
      : accepted.ir.files.find((candidate) => candidate.id === entity.fileId);
    const explicitModule = accepted.catalog.modules.find((candidate) =>
      candidate.entityIds.includes(entity.id),
    );
    const assignment = file === undefined
      ? undefined
      : accepted.catalog.assignments.find((candidate) => candidate.fileId === file.id);
    const module = explicitModule ?? (
      assignment?.kind === 'owned' && assignment.moduleIds.length === 1
        ? accepted.catalog.modules.find((candidate) => candidate.id === assignment.moduleIds[0])
        : undefined
    );
    const assessment = snapshot.assessments.find((item) => item.entityId === entity.id);
    const classScopeId = entity.kind === 'type' ? entity.id : entity.containerEntityId;
    const classRollup = classScopeId === undefined
      ? undefined
      : snapshot.classRollups.find((item) => item.scopeId === classScopeId);
    const fileRollup = file === undefined
      ? undefined
      : snapshot.fileRollups.find((item) => item.scopeId === file.id);
    const moduleRollup = module === undefined
      ? undefined
      : snapshot.moduleRollups.find((item) => item.scopeId === module.id);
    return {
      role: 'target-workspace',
      workspaceId,
      snapshotId: snapshot.id,
      snapshot,
      ir: accepted.ir,
      catalog: accepted.catalog,
      entity,
      ...(file === undefined ? {} : { file }),
      ...(module === undefined ? {} : { module }),
      ...(assessment === undefined ? {} : { assessment }),
      ...(classRollup === undefined ? {} : { classRollup }),
      ...(fileRollup === undefined ? {} : { fileRollup }),
      ...(moduleRollup === undefined ? {} : { moduleRollup }),
    };
  }

  async get(workspaceIdInput: string): Promise<TargetWorkspaceHostRecord | null> {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput);
    return this.dependencies.store.load(workspaceId);
  }

  async #requireRecord(workspaceId: string): Promise<TargetWorkspaceHostRecord> {
    const record = await this.dependencies.store.load(workspaceId);
    if (!record || record.role !== 'target-workspace') {
      throw new Error(`Target workspace is not initialized: ${workspaceId}.`);
    }
    return record;
  }

  async #withWorkspaceMutation<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#workspaceMutationTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#workspaceMutationTails.set(workspaceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#workspaceMutationTails.get(workspaceId) === tail) {
        this.#workspaceMutationTails.delete(workspaceId);
      }
    }
  }
}
