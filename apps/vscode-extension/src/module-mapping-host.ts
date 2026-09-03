import type {
  MigrationExecutionOverlay,
  MigrationRouteResolution,
  MigrationRouteSnapshotRef,
  MigrationRuntimeCapabilitySnapshot,
  ModuleMappingEntry,
  ModuleMappingProposal,
  ModuleMappingReview,
  ModuleMappingReviewDecision,
  RepositoryModuleCatalog,
  RepositoryStaticAnalysisAdapterDescriptor,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  classifyModuleMappingFreshness,
  createMigrationRouteSnapshotRef,
  materializeMigrationExecutionOverlay,
  materializeModuleMappingProposal,
  materializeModuleMappingReview,
  type MigrationExecutionGroupDraft,
  validateMigrationExecutionOverlay,
  validateMigrationRuntimeCapabilitySnapshot,
  validateModuleMappingProposal,
  type MigrationExecutionV2ValidationContext,
} from '@forexplore/workflow-core';
import type { ModuleMappingRunBinding } from './protocol/messages';

export const moduleMappingHostSchemaVersion = '1.0' as const;

export interface ReviewedModuleCatalogHead {
  workspaceId: string;
  ir: UnifiedRepositoryIR;
  catalog: RepositoryModuleCatalog;
  analysisSnapshotId: string;
  analysisContentHash: string;
  /** Immutable adapter evidence from the exact analysis snapshot behind this catalog. */
  analysisAdapters: RepositoryStaticAnalysisAdapterDescriptor[];
}

export interface ModuleMappingCatalogHeadProvider {
  load(
    side: 'source' | 'target',
    workspaceId: string,
  ): Promise<ReviewedModuleCatalogHead | null>;
}

export interface ModuleMappingRouteProvider {
  resolve(
    routeId: string,
    routeVersion: string,
    heads: { source: ReviewedModuleCatalogHead; target: ReviewedModuleCatalogHead },
  ): Promise<ResolvedModuleMappingRoute | undefined>;
  list?(
    heads: { source: ReviewedModuleCatalogHead; target: ReviewedModuleCatalogHead },
  ): Promise<ResolvedModuleMappingRoute[]>;
}

/** Runtime-owned, fully materialized capability selected before review acceptance. */
export interface ResolvedModuleMappingRoute {
  resolution: Extract<MigrationRouteResolution, { status: 'supported' }>;
  runtimeCapabilitySnapshot: MigrationRuntimeCapabilitySnapshot;
}

export type ModuleMappingHostStage =
  | 'awaiting-review'
  | 'revision-required'
  | 'rejected'
  | 'ready'
  | 'stale';

export interface ModuleMappingHostRecord {
  schemaVersion: typeof moduleMappingHostSchemaVersion;
  id: string;
  stage: ModuleMappingHostStage;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  proposal: ModuleMappingProposal;
  executionGroupDrafts: MigrationExecutionGroupDraft[];
  review?: ModuleMappingReview;
  overlay?: MigrationExecutionOverlay;
  routeResolution?: Extract<MigrationRouteResolution, { status: 'supported' }>;
  runtimeCapabilitySnapshot?: MigrationRuntimeCapabilitySnapshot;
  routeSnapshot?: MigrationRouteSnapshotRef;
  staleReasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ModuleMappingHostState {
  schemaVersion: typeof moduleMappingHostSchemaVersion;
  revision: number;
  records: ModuleMappingHostRecord[];
}

export interface ModuleMappingHostStore {
  load(): Promise<ModuleMappingHostState | null>;
  save(next: ModuleMappingHostState, expectedRevision: number | null): Promise<void>;
}

export interface ModuleMappingHostDependencies {
  store: ModuleMappingHostStore;
  catalogs: ModuleMappingCatalogHeadProvider;
  routes: ModuleMappingRouteProvider;
  now?: () => string;
}

export interface ProposeModuleMappingInput {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  objective: string;
  mappings: ModuleMappingEntry[];
  executionGroups: MigrationExecutionGroupDraft[];
  assumptions?: string[];
  risks?: string[];
}

export interface ReviewModuleMappingInput {
  recordId: string;
  expectedProposalId: string;
  expectedProposalHash: string;
  decision: ModuleMappingReviewDecision;
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
  /** Required only for acceptance; it must resolve to a supported runtime route. */
  routeId?: string;
  routeVersion?: string;
}

export interface BindModuleMappingTargetInput {
  targetWorkspaceId: string;
  targetModuleId: string;
  targetEntityId: string;
  allowedRouteIds: string[];
  /** Optional explicit 01A browser selection; when present it narrows, never creates, an accepted mapping. */
  sourceWorkspaceId?: string;
  sourceRepositoryId?: string;
  sourceCatalogId?: string;
  sourceCatalogHash?: string;
  sourceModuleId?: string;
}

export class ModuleMappingHost {
  readonly #now: () => string;

  constructor(private readonly dependencies: ModuleMappingHostDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async propose(input: ProposeModuleMappingInput): Promise<ModuleMappingHostRecord> {
    const sourceWorkspaceId = requiredText(input.sourceWorkspaceId, 'Source workspace ID');
    const targetWorkspaceId = requiredText(input.targetWorkspaceId, 'Target workspace ID');
    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new Error('Source and target module catalogs must come from distinct workspace identities.');
    }
    const { source, target } = await this.#loadHeads(sourceWorkspaceId, targetWorkspaceId);
    const createdAt = this.#now();
    const proposal = materializeModuleMappingProposal({
      sourceIr: source.ir,
      sourceCatalog: source.catalog,
      targetIr: target.ir,
      targetCatalog: target.catalog,
      objective: input.objective,
      mappings: input.mappings,
      assumptions: input.assumptions,
      risks: input.risks,
      createdAt,
    });
    const record: ModuleMappingHostRecord = {
      schemaVersion: moduleMappingHostSchemaVersion,
      id: `module-mapping-run:${proposal.contentHash.slice(0, 24)}`,
      stage: 'awaiting-review',
      sourceWorkspaceId,
      targetWorkspaceId,
      proposal,
      executionGroupDrafts: input.executionGroups.map(copyGroupDraft),
      staleReasons: [],
      createdAt,
      updatedAt: createdAt,
    };
    await this.#append(record);
    return cloneRecord(record);
  }

  async review(input: ReviewModuleMappingInput): Promise<ModuleMappingHostRecord> {
    const current = await this.#requiredRecord(input.recordId);
    if (current.stage !== 'awaiting-review') {
      throw new Error(`Module mapping run is not awaiting review: ${current.stage}.`);
    }
    if (
      current.proposal.id !== input.expectedProposalId ||
      current.proposal.contentHash !== input.expectedProposalHash
    ) {
      throw new Error('Module mapping review is based on a stale proposal.');
    }
    const { source, target } = await this.#loadHeads(
      current.sourceWorkspaceId,
      current.targetWorkspaceId,
    );
    validateModuleMappingProposal(
      current.proposal,
      source.ir,
      source.catalog,
      target.ir,
      target.catalog,
    );
    const decidedAt = this.#now();
    const review = materializeModuleMappingReview({
      proposal: current.proposal,
      sourceIr: source.ir,
      sourceCatalog: source.catalog,
      targetIr: target.ir,
      targetCatalog: target.catalog,
      decision: input.decision,
      reviewerId: input.reviewerId,
      comment: input.comment,
      acceptedRiskIds: input.acceptedRiskIds,
      decidedAt,
    });
    let next: ModuleMappingHostRecord;
    if (review.decision !== 'accept') {
      next = {
        ...current,
        stage: review.decision === 'revise' ? 'revision-required' : 'rejected',
        review,
        staleReasons: [],
        updatedAt: decidedAt,
      };
    } else {
      const routeId = requiredText(input.routeId ?? '', 'Migration route ID');
      const routeVersion = requiredText(input.routeVersion ?? '', 'Migration route version');
      const resolvedRoute = await this.dependencies.routes.resolve(
        routeId,
        routeVersion,
        { source, target },
      );
      if (!resolvedRoute) {
        throw new Error(`Migration route ${routeId}@${routeVersion} is not supported.`);
      }
      const routeResolution = resolvedRoute.resolution;
      const runtimeCapabilitySnapshot = validateMigrationRuntimeCapabilitySnapshot(
        resolvedRoute.runtimeCapabilitySnapshot,
      );
      const routeSnapshot = createMigrationRouteSnapshotRef(runtimeCapabilitySnapshot, routeId);
      if (
        routeResolution.route.id !== routeId ||
        routeResolution.route.version !== routeVersion ||
        routeSnapshot.routeId !== routeId ||
        routeSnapshot.routeVersion !== routeVersion ||
        routeSnapshot.sourceLanguageId !== routeResolution.route.sourceLanguageId ||
        routeSnapshot.targetLanguageId !== routeResolution.route.targetLanguageId ||
        routeSnapshot.strategy !== routeResolution.route.strategy ||
        routeSnapshot.routeContentHash !== routeResolution.route.contentHash
      ) {
        throw new Error(`Migration route ${routeId}@${routeVersion} is not supported.`);
      }
      const overlay = materializeMigrationExecutionOverlay({
        proposal: current.proposal,
        review,
        sourceIr: source.ir,
        sourceCatalog: source.catalog,
        targetIr: target.ir,
        targetCatalog: target.catalog,
        routeId,
        routeVersion,
        groups: current.executionGroupDrafts,
        createdAt: decidedAt,
      });
      next = {
        ...current,
        stage: 'ready',
        review,
        overlay,
        routeResolution,
        runtimeCapabilitySnapshot,
        routeSnapshot,
        staleReasons: [],
        updatedAt: decidedAt,
      };
    }
    await this.#replace(next, current);
    return cloneRecord(next);
  }

  async get(recordId: string, refresh = true): Promise<ModuleMappingHostRecord | null> {
    const state = await this.#state();
    const record = state.records.find((candidate) => candidate.id === recordId);
    if (!record) return null;
    return refresh ? this.#refresh(record) : cloneRecord(record);
  }

  async list(refresh = false): Promise<ModuleMappingHostRecord[]> {
    const state = await this.#state();
    if (!refresh) return state.records.map(cloneRecord);
    // Refresh sequentially because each stale transition is a revisioned CAS
    // write to the same persisted Host state.
    const records: ModuleMappingHostRecord[] = [];
    for (const record of state.records) records.push(await this.#refresh(record));
    return records;
  }

  async listRoutes(recordId: string): Promise<ResolvedModuleMappingRoute[]> {
    const record = await this.#requiredRecord(recordId);
    const heads = await this.#loadHeads(record.sourceWorkspaceId, record.targetWorkspaceId);
    if (this.dependencies.routes.list) return this.dependencies.routes.list(heads);
    return [];
  }

  /** Supported routes from current accepted mappings for one target catalog. */
  async listTargetRouteResolutions(targetWorkspaceId: string): Promise<MigrationRouteResolution[]> {
    const resolutions = new Map<string, MigrationRouteResolution>();
    for (const stored of (await this.#state()).records) {
      if (stored.targetWorkspaceId !== targetWorkspaceId || stored.stage !== 'ready') continue;
      const record = await this.#refresh(stored);
      if (record.stage !== 'ready' || !record.routeResolution) continue;
      const route = record.routeResolution.route;
      resolutions.set(`${route.sourceLanguageId}\0${route.targetLanguageId}\0${route.strategy}`,
        JSON.parse(JSON.stringify(record.routeResolution)) as MigrationRouteResolution);
    }
    return [...resolutions.values()];
  }

  async bindTarget(input: BindModuleMappingTargetInput): Promise<ModuleMappingRunBinding> {
    const allowedRouteIds = new Set(input.allowedRouteIds);
    const candidates: Array<{ record: ModuleMappingHostRecord; groupIndexes: number[] }> = [];
    for (const stored of (await this.#state()).records) {
      if (stored.targetWorkspaceId !== input.targetWorkspaceId || stored.stage !== 'ready') continue;
      if (input.sourceWorkspaceId && stored.sourceWorkspaceId !== input.sourceWorkspaceId) continue;
      const record = await this.#refresh(stored);
      if (
        record.stage !== 'ready' || !record.overlay || !record.review ||
        !record.routeResolution || !record.runtimeCapabilitySnapshot || !record.routeSnapshot
      ) continue;
      if (!allowedRouteIds.has(record.overlay.routeId)) continue;
      if (
        (input.sourceRepositoryId && record.overlay.sourceCatalog.repositoryId !== input.sourceRepositoryId) ||
        (input.sourceCatalogId && record.overlay.sourceCatalog.moduleCatalogId !== input.sourceCatalogId) ||
        (input.sourceCatalogHash && record.overlay.sourceCatalog.moduleCatalogHash !== input.sourceCatalogHash)
      ) continue;
      const groupIndexes = record.overlay.groups
        .map((group, index) => ({ group, index }))
        .filter(({ group }) =>
          group.targetModuleIds.includes(input.targetModuleId) &&
          (group.targetEntityIds.length === 0 || group.targetEntityIds.includes(input.targetEntityId)) &&
          (!input.sourceModuleId || group.sourceModuleIds.includes(input.sourceModuleId)),
        )
        .map(({ index }) => index);
      if (groupIndexes.length > 0) candidates.push({ record, groupIndexes });
    }
    if (candidates.length === 0) {
      throw new Error('No current accepted module mapping covers the selected target entity and route.');
    }
    if (candidates.length > 1) {
      throw new Error('Multiple accepted module mappings cover the selected target entity; selection is ambiguous.');
    }
    return bindingFromRecord(candidates[0]!.record, candidates[0]!.groupIndexes);
  }

  async assertBindingCurrent(binding: ModuleMappingRunBinding): Promise<void> {
    const record = await this.get(binding.mappingRunId, true);
    if (
      !record || record.stage !== 'ready' || !record.overlay || !record.review ||
      !record.routeResolution || !record.runtimeCapabilitySnapshot || !record.routeSnapshot
    ) {
      throw new Error('Module mapping binding is unavailable or stale.');
    }
    const expected = bindingFromRecord(record, record.overlay.groups
      .map((group, index) => binding.groupIds.includes(group.id) ? index : -1)
      .filter((index) => index >= 0));
    if (JSON.stringify(expected) !== JSON.stringify(binding)) {
      throw new Error('Module mapping proposal/review/overlay or route lineage has changed.');
    }
  }

  /**
   * Returns the complete reviewed execution truth for V2 materializers. The
   * record is refreshed first, so catalog, IR, review, overlay, and exact
   * runtime changes make the binding stale instead of being inferred by the
   * caller from the compact protocol DTO.
   */
  async executionContext(
    binding: ModuleMappingRunBinding,
  ): Promise<MigrationExecutionV2ValidationContext> {
    await this.assertBindingCurrent(binding);
    const record = await this.get(binding.mappingRunId, true);
    if (
      !record || record.stage !== 'ready' || !record.review || !record.overlay ||
      !record.runtimeCapabilitySnapshot
    ) {
      throw new Error('Module mapping execution context is unavailable or stale.');
    }
    return {
      runtimeCapabilities: JSON.parse(
        JSON.stringify(record.runtimeCapabilitySnapshot),
      ) as MigrationRuntimeCapabilitySnapshot,
      currentSourceCatalog: { ...record.overlay.sourceCatalog },
      currentTargetCatalog: { ...record.overlay.targetCatalog },
      mappingProposal: JSON.parse(JSON.stringify(record.proposal)) as ModuleMappingProposal,
      mappingReview: JSON.parse(JSON.stringify(record.review)) as ModuleMappingReview,
      executionOverlay: JSON.parse(JSON.stringify(record.overlay)) as MigrationExecutionOverlay,
    };
  }

  async #refresh(record: ModuleMappingHostRecord): Promise<ModuleMappingHostRecord> {
    let staleReasons: string[] = [];
    let source: ReviewedModuleCatalogHead | null = null;
    let target: ReviewedModuleCatalogHead | null = null;
    try {
      [source, target] = await Promise.all([
        this.dependencies.catalogs.load('source', record.sourceWorkspaceId),
        this.dependencies.catalogs.load('target', record.targetWorkspaceId),
      ]);
      if (!source) staleReasons.push('source-catalog-unavailable');
      if (!target) staleReasons.push('target-catalog-unavailable');
      if (source && target) {
        const freshness = classifyModuleMappingFreshness(
          record.proposal,
          source.ir,
          source.catalog,
          target.ir,
          target.catalog,
        );
        staleReasons = [
          ...freshness.source.reasonCodes.map((reason) => `source:${reason}`),
          ...freshness.target.reasonCodes.map((reason) => `target:${reason}`),
        ];
        if (staleReasons.length === 0) {
          validateModuleMappingProposal(
            record.proposal,
            source.ir,
            source.catalog,
            target.ir,
            target.catalog,
          );
          if (record.stage === 'ready' && record.review && record.overlay) {
            validateMigrationExecutionOverlay(
              record.overlay,
              record.proposal,
              record.review,
              source.ir,
              source.catalog,
              target.ir,
              target.catalog,
            );
            const currentRoute = await this.dependencies.routes.resolve(
              record.overlay.routeId,
              record.overlay.routeVersion,
              { source, target },
            );
            if (!currentRoute) {
              staleReasons.push('route-resolution-unavailable');
            } else if (
              !record.routeResolution || !record.runtimeCapabilitySnapshot || !record.routeSnapshot ||
              JSON.stringify(currentRoute.resolution.route) !== JSON.stringify(record.routeResolution.route) ||
              JSON.stringify(currentRoute.runtimeCapabilitySnapshot) !==
                JSON.stringify(record.runtimeCapabilitySnapshot) ||
              JSON.stringify(
                createMigrationRouteSnapshotRef(currentRoute.runtimeCapabilitySnapshot, record.overlay.routeId),
              ) !== JSON.stringify(record.routeSnapshot)
            ) {
              staleReasons.push('route-resolution-changed');
            }
          }
        }
      }
    } catch (error) {
      staleReasons.push(`validation:${error instanceof Error ? error.message : String(error)}`);
    }
    staleReasons = [...new Set(staleReasons)].sort();
    if (staleReasons.length === 0) {
      return cloneRecord(record);
    }
    if (
      record.stage === 'stale' &&
      JSON.stringify(record.staleReasons) === JSON.stringify(staleReasons)
    ) {
      return cloneRecord(record);
    }
    const stale: ModuleMappingHostRecord = {
      ...record,
      stage: 'stale',
      staleReasons,
      updatedAt: this.#now(),
    };
    await this.#replace(stale, record);
    return cloneRecord(stale);
  }

  async #loadHeads(
    sourceWorkspaceId: string,
    targetWorkspaceId: string,
  ): Promise<{ source: ReviewedModuleCatalogHead; target: ReviewedModuleCatalogHead }> {
    const [source, target] = await Promise.all([
      this.dependencies.catalogs.load('source', sourceWorkspaceId),
      this.dependencies.catalogs.load('target', targetWorkspaceId),
    ]);
    if (!source) throw new Error('Source workspace has no active reviewed RepositoryModuleCatalog.');
    if (!target) throw new Error('Target workspace has no active reviewed RepositoryModuleCatalog.');
    if (source.workspaceId !== sourceWorkspaceId || target.workspaceId !== targetWorkspaceId) {
      throw new Error('Catalog provider returned a head for a different workspace identity.');
    }
    return { source, target };
  }

  async #requiredRecord(recordId: string): Promise<ModuleMappingHostRecord> {
    const record = await this.get(recordId, false);
    if (!record) throw new Error(`Unknown module mapping run: ${recordId}.`);
    return record;
  }

  async #state(): Promise<ModuleMappingHostState> {
    const state = await this.dependencies.store.load();
    if (!state) {
      return { schemaVersion: moduleMappingHostSchemaVersion, revision: 0, records: [] };
    }
    if (state.schemaVersion !== moduleMappingHostSchemaVersion || !Number.isInteger(state.revision)) {
      throw new Error('Stored module mapping Host state has an unsupported schema.');
    }
    return cloneState(state);
  }

  async #append(record: ModuleMappingHostRecord): Promise<void> {
    const state = await this.#state();
    if (state.records.some((candidate) => candidate.id === record.id)) {
      throw new Error(`Module mapping run already exists: ${record.id}.`);
    }
    await this.dependencies.store.save({
      ...state,
      revision: state.revision + 1,
      records: [...state.records, cloneRecord(record)],
    }, state.revision);
  }

  async #replace(next: ModuleMappingHostRecord, expected: ModuleMappingHostRecord): Promise<void> {
    const state = await this.#state();
    const index = state.records.findIndex((candidate) => candidate.id === expected.id);
    if (index < 0 || state.records[index]!.updatedAt !== expected.updatedAt) {
      throw new Error('Module mapping Host state changed concurrently.');
    }
    const records = [...state.records];
    records[index] = cloneRecord(next);
    await this.dependencies.store.save({ ...state, revision: state.revision + 1, records }, state.revision);
  }
}

function bindingFromRecord(
  record: ModuleMappingHostRecord,
  groupIndexes: number[],
): ModuleMappingRunBinding {
  if (
    !record.overlay || !record.review || !record.routeResolution ||
    !record.runtimeCapabilitySnapshot || !record.routeSnapshot
  ) {
    throw new Error('Module mapping record has no accepted execution overlay.');
  }
  const groups = groupIndexes.map((index) => record.overlay!.groups[index]!).filter(Boolean);
  return {
    mappingRunId: record.id,
    sourceCatalog: { ...record.overlay.sourceCatalog },
    targetCatalog: { ...record.overlay.targetCatalog },
    mappingProposalId: record.proposal.id,
    mappingProposalHash: record.proposal.contentHash,
    mappingReviewId: record.review.id,
    mappingReviewHash: record.review.contentHash,
    executionOverlayId: record.overlay.id,
    executionOverlayHash: record.overlay.contentHash,
    runtimeCapabilitySnapshot: JSON.parse(
      JSON.stringify(record.runtimeCapabilitySnapshot),
    ) as MigrationRuntimeCapabilitySnapshot,
    route: { ...record.routeSnapshot },
    groupIds: groups.map((group) => group.id).sort(),
    mappingIds: unique(groups.flatMap((group) => group.mappingIds)),
    sourceModuleIds: unique(groups.flatMap((group) => group.sourceModuleIds)),
    targetModuleIds: unique(groups.flatMap((group) => group.targetModuleIds)),
    sourceEntityIds: unique(groups.flatMap((group) => group.sourceEntityIds)),
    targetEntityIds: unique(groups.flatMap((group) => group.targetEntityIds)),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function copyGroupDraft(group: MigrationExecutionGroupDraft): MigrationExecutionGroupDraft {
  return {
    id: group.id,
    mappingIds: [...group.mappingIds],
    dependsOnGroupIds: [...group.dependsOnGroupIds],
  };
}

function cloneRecord(record: ModuleMappingHostRecord): ModuleMappingHostRecord {
  return JSON.parse(JSON.stringify(record)) as ModuleMappingHostRecord;
}

function cloneState(state: ModuleMappingHostState): ModuleMappingHostState {
  return JSON.parse(JSON.stringify(state)) as ModuleMappingHostState;
}
