import type {
  AnalysisAdapterDescriptor,
  AnalysisCapability,
  RepositoryDiagnostic,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionArtifacts,
  RepositoryIngestionEvent,
  RepositoryIngestionEventActor,
  RepositoryIngestionEventType,
  RepositoryIngestionFailure,
  RepositoryIngestionJsonValue,
  RepositoryIngestionManifest,
  RepositoryIngestionMode,
  RepositoryIngestionStatus,
  RepositoryKnowledgeArtifact,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import { canonicalJson, sha256Hex, sortedUnique } from './module-plan-utils';

export interface CreateRepositoryIngestionManifestInput {
  id: string;
  repositoryId: string;
  mode: RepositoryIngestionMode;
  baseManifestId?: string;
  repositoryRevision?: string;
  repositoryContentHash: string;
  configurationHash?: string;
  requestedCapabilities: AnalysisCapability[];
  analysisAdapters: AnalysisAdapterDescriptor[];
  requestedAt: string;
  actor: RepositoryIngestionEventActor;
  idempotencyKey?: string;
}

export interface RepositoryIngestionArtifactPatch {
  profile?: RepositoryIngestionArtifactRef;
  shards?: RepositoryIngestionArtifactRef[];
  unifiedRepositoryIr?: RepositoryIngestionArtifactRef;
  moduleDiscoveryProposal?: RepositoryIngestionArtifactRef;
  /** Immutable draft emitted before human review. */
  moduleCatalog?: RepositoryIngestionArtifactRef;
  moduleReview?: RepositoryIngestionArtifactRef;
  /** Accepted catalog published after review; never replaces `moduleCatalog`. */
  activeModuleCatalog?: RepositoryIngestionArtifactRef;
  moduleBundle?: RepositoryIngestionArtifactRef;
  moduleEvidenceBundles?: RepositoryIngestionArtifactRef[];
  moduleWikiProposals?: RepositoryIngestionArtifactRef[];
  moduleKnowledgeReviews?: RepositoryIngestionArtifactRef[];
  knowledgePublications?: RepositoryIngestionArtifactRef[];
  moduleIndexReceipts?: RepositoryIngestionArtifactRef[];
  publicationHeads?: RepositoryIngestionArtifactRef[];
  incrementalImpactSet?: RepositoryIngestionArtifactRef;
  knowledge?: RepositoryKnowledgeArtifact[];
}

export interface CurrentRepositoryModuleSummaryArtifactRefs {
  evidenceBundles: RepositoryIngestionArtifactRef[];
  wikiProposals: RepositoryIngestionArtifactRef[];
  knowledgeReviews: RepositoryIngestionArtifactRef[];
}

export interface RepositoryModuleSummaryRevisionArtifactRefs {
  previousWikiProposals: RepositoryIngestionArtifactRef[];
  priorKnowledgeReviews: RepositoryIngestionArtifactRef[];
}

export interface CurrentRepositoryKnowledgePublicationArtifactRefs {
  publications: RepositoryIngestionArtifactRef[];
  indexReceipts: RepositoryIngestionArtifactRef[];
  publicationHeads: RepositoryIngestionArtifactRef[];
}

export interface RecordRepositoryIngestionEventInput {
  type: RepositoryIngestionEventType;
  occurredAt: string;
  actor: RepositoryIngestionEventActor;
  idempotencyKey: string;
  toStatus?: RepositoryIngestionStatus;
  message?: string;
  details?: RepositoryIngestionJsonValue;
  artifacts?: RepositoryIngestionArtifactPatch;
  completedCapabilities?: AnalysisCapability[];
  diagnostics?: RepositoryDiagnostic[];
  failure?: RepositoryIngestionFailure;
}

const sha256Pattern = /^[0-9a-f]{64}$/;
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const transitions: Record<RepositoryIngestionStatus, readonly RepositoryIngestionStatus[]> = {
  queued: ['profiling', 'failed', 'cancelled', 'superseded'],
  profiling: ['analyzing', 'partial', 'failed', 'cancelled', 'superseded'],
  analyzing: ['merging', 'partial', 'failed', 'cancelled', 'superseded'],
  merging: ['discovering-modules', 'partial', 'failed', 'cancelled', 'superseded'],
  'discovering-modules': ['awaiting-module-review', 'partial', 'failed', 'cancelled', 'superseded'],
  'awaiting-module-review': ['summarizing-modules', 'partial', 'failed', 'cancelled', 'superseded'],
  'summarizing-modules': ['awaiting-summary-review', 'partial', 'failed', 'cancelled', 'superseded'],
  'awaiting-summary-review': ['summarizing-modules', 'publishing-knowledge', 'partial', 'failed', 'cancelled', 'superseded'],
  'publishing-knowledge': ['ready', 'partial', 'failed', 'cancelled', 'superseded'],
  partial: [
    'profiling',
    'analyzing',
    'merging',
    'discovering-modules',
    'awaiting-module-review',
    'summarizing-modules',
    'awaiting-summary-review',
    'publishing-knowledge',
    'ready',
    'failed',
    'cancelled',
    'superseded',
  ],
  ready: ['superseded'],
  failed: [],
  cancelled: [],
  superseded: [],
};

export function canTransitionRepositoryIngestionStatus(
  from: RepositoryIngestionStatus,
  to: RepositoryIngestionStatus,
): boolean {
  return transitions[from].includes(to);
}

/**
 * Select the active Summary round from the append-only ledger. Historical
 * proposals/reviews remain in `manifest.artifacts`, but cannot satisfy a later
 * review or publication gate.
 */
export function selectCurrentRepositoryModuleSummaryArtifactRefs(
  manifest: RepositoryIngestionManifest,
): CurrentRepositoryModuleSummaryArtifactRefs {
  return selectCurrentRepositoryModuleSummaryArtifactRefsFromLedger(
    manifest.status,
    manifest.events,
  );
}

function selectCurrentRepositoryModuleSummaryArtifactRefsFromLedger(
  status: RepositoryIngestionStatus,
  events: readonly RepositoryIngestionEvent[],
): CurrentRepositoryModuleSummaryArtifactRefs {
  const evidenceEvent = findLatestEvent(events, (event) =>
    event.type === 'module-evidence-bundle-produced',
  );
  const evidenceBundles = eventArtifactsOfKind(evidenceEvent, 'repository-module-evidence-bundle');
  if (status === 'awaiting-summary-review') {
    const proposalEvent = findLatestEvent(events, (event) =>
      event.type === 'module-wiki-proposal-produced' &&
      event.toStatus === 'awaiting-summary-review',
    );
    return {
      evidenceBundles,
      wikiProposals: eventArtifactsOfKind(proposalEvent, 'repository-module-wiki-proposal'),
      // A partial revision round may carry already-accepted module reviews in
      // the proposal event. Revised modules remain absent until re-reviewed.
      knowledgeReviews: eventArtifactsOfKind(proposalEvent, 'repository-module-knowledge-review'),
    };
  }
  if (status === 'publishing-knowledge' || status === 'ready') {
    const reviewEvent = findLatestEvent(events, (event) =>
      event.type === 'module-knowledge-review-recorded' &&
      event.toStatus === 'publishing-knowledge',
    );
    const proposalEvent = reviewEvent === undefined
      ? undefined
      : findLatestEvent(events, (event) =>
          event.sequence < reviewEvent.sequence &&
          event.type === 'module-wiki-proposal-produced' &&
          event.toStatus === 'awaiting-summary-review',
        );
    return {
      evidenceBundles,
      wikiProposals: eventArtifactsOfKind(proposalEvent, 'repository-module-wiki-proposal'),
      knowledgeReviews: eventArtifactsOfKind(reviewEvent, 'repository-module-knowledge-review'),
    };
  }
  return { evidenceBundles, wikiProposals: [], knowledgeReviews: [] };
}

/** Return the signed predecessor closure only while a revise decision is open. */
export function selectRepositoryModuleSummaryRevisionArtifactRefs(
  manifest: RepositoryIngestionManifest,
): RepositoryModuleSummaryRevisionArtifactRefs {
  if (manifest.status !== 'summarizing-modules') {
    return { previousWikiProposals: [], priorKnowledgeReviews: [] };
  }
  const reviewEvent = findLatestEvent(manifest.events, (event) =>
    event.type === 'module-knowledge-review-recorded' &&
    event.toStatus === 'summarizing-modules',
  );
  if (reviewEvent === undefined) {
    return { previousWikiProposals: [], priorKnowledgeReviews: [] };
  }
  const proposalEvent = findLatestEvent(manifest.events, (event) =>
    event.sequence < reviewEvent.sequence &&
    event.type === 'module-wiki-proposal-produced' &&
    event.toStatus === 'awaiting-summary-review',
  );
  return {
    previousWikiProposals: eventArtifactsOfKind(proposalEvent, 'repository-module-wiki-proposal'),
    priorKnowledgeReviews: eventArtifactsOfKind(reviewEvent, 'repository-module-knowledge-review'),
  };
}

/** Select only the latest successful activation; compensated attempts stay historical. */
export function selectCurrentRepositoryKnowledgePublicationArtifactRefs(
  manifest: RepositoryIngestionManifest,
): CurrentRepositoryKnowledgePublicationArtifactRefs {
  return selectCurrentRepositoryKnowledgePublicationArtifactRefsFromLedger(manifest.events);
}

function selectCurrentRepositoryKnowledgePublicationArtifactRefsFromLedger(
  events: readonly RepositoryIngestionEvent[],
): CurrentRepositoryKnowledgePublicationArtifactRefs {
  const activation = findLatestEvent(events, (event) =>
    event.type === 'knowledge-publication-activated',
  );
  const withdrawal = findLatestEvent(events, (event) =>
    event.type === 'knowledge-publication-withdrawn',
  );
  if (
    activation === undefined ||
    (withdrawal !== undefined && withdrawal.sequence > activation.sequence)
  ) {
    // A compensated activation cannot satisfy `ready`, even when the store
    // restored an older external head. A later successful activation must
    // append a new activation event for this ingestion.
    return { publications: [], indexReceipts: [], publicationHeads: [] };
  }
  return {
    publications: eventArtifactsOfKind(activation, 'repository-knowledge-publication'),
    indexReceipts: eventArtifactsOfKind(activation, 'repository-module-index-receipt'),
    publicationHeads: eventArtifactsOfKind(activation, 'repository-knowledge-publication-head'),
  };
}

export function createRepositoryIngestionManifest(
  input: CreateRepositoryIngestionManifestInput,
): RepositoryIngestionManifest {
  assertSafeIdentifier(input.id, 'Repository ingestion ID');
  assertSafeIdentifier(input.repositoryId, 'Repository ID');
  assertTimestamp(input.requestedAt, 'Repository ingestion request time');
  assertHash(input.repositoryContentHash, 'Repository content hash');
  if (input.mode === 'incremental' && !input.baseManifestId) {
    throw new Error('Incremental repository ingestion requires a base manifest ID.');
  }
  if (input.baseManifestId !== undefined) {
    assertSafeIdentifier(input.baseManifestId, 'Base ingestion manifest ID');
  }
  const requestedCapabilities = uniqueCapabilities(input.requestedCapabilities);
  if (requestedCapabilities.length === 0) {
    throw new Error('Repository ingestion must request at least one analysis capability.');
  }
  const analysisAdapters = canonicalAdapters(input.analysisAdapters);
  const idempotencyKey = input.idempotencyKey?.trim() || `ingestion-requested:${input.id}`;
  const event: RepositoryIngestionEvent = {
    id: eventId(input.id, idempotencyKey),
    ingestionId: input.id,
    sequence: 1,
    type: 'ingestion-requested',
    occurredAt: input.requestedAt,
    actor: canonicalActor(input.actor),
    idempotencyKey,
    toStatus: 'queued',
    details: {
      mode: input.mode,
      requestedCapabilities,
    },
  };
  const manifest: RepositoryIngestionManifest = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: input.id,
    repositoryId: input.repositoryId,
    mode: input.mode,
    status: 'queued',
    ...(input.baseManifestId === undefined ? {} : { baseManifestId: input.baseManifestId }),
    ...(input.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: input.repositoryRevision.trim() }),
    repositoryContentHash: input.repositoryContentHash,
    ...(input.configurationHash === undefined
      ? {}
      : { configurationHash: input.configurationHash }),
    requestedCapabilities,
    completedCapabilities: [],
    analysisAdapters,
    artifacts: emptyArtifacts(),
    events: [event],
    diagnostics: [],
    requestedAt: input.requestedAt,
    updatedAt: input.requestedAt,
  };
  validateRepositoryIngestionManifest(manifest);
  return manifest;
}

/**
 * Append one lifecycle event and update the manifest projection. Event IDs and
 * idempotency keys are immutable: replaying the same update is a no-op, while
 * reusing a key for different content fails closed.
 */
export function recordRepositoryIngestionEvent(
  manifest: RepositoryIngestionManifest,
  input: RecordRepositoryIngestionEventInput,
): RepositoryIngestionManifest {
  validateRepositoryIngestionManifest(manifest);
  const key = input.idempotencyKey.trim();
  if (!key) throw new Error('Repository ingestion event idempotency key is required.');
  assertTimestamp(input.occurredAt, 'Repository ingestion event time');
  if (input.occurredAt.localeCompare(manifest.updatedAt) < 0) {
    throw new Error('Repository ingestion events must not move the manifest clock backwards.');
  }
  const actor = canonicalActor(input.actor);
  const artifactRefs = artifactRefsFromPatch(input.artifacts);
  const completedCapabilities = uniqueCapabilities(input.completedCapabilities ?? []);
  assertRequestedCapabilities(manifest.requestedCapabilities, completedCapabilities);
  const diagnostics = canonicalDiagnostics(input.diagnostics ?? []);
  const details = eventDetails(
    input.details,
    completedCapabilities,
    diagnostics,
    input.failure,
    input.artifacts,
  );
  const desired = {
    type: input.type,
    occurredAt: input.occurredAt,
    actor,
    idempotencyKey: key,
    ...(input.toStatus === undefined ? {} : { toStatus: input.toStatus }),
    ...(artifactRefs.length === 0 ? {} : { artifactRefs }),
    ...(input.message === undefined ? {} : { message: normalizeRequired(input.message, 'Event message') }),
    ...(details === undefined ? {} : { details }),
  };
  const existing = manifest.events.find((event) => event.idempotencyKey === key);
  if (existing) {
    const existingComparable = {
      type: existing.type,
      occurredAt: existing.occurredAt,
      actor: existing.actor,
      idempotencyKey: existing.idempotencyKey,
      ...(existing.toStatus === undefined ? {} : { toStatus: existing.toStatus }),
      ...(existing.artifactRefs === undefined ? {} : { artifactRefs: existing.artifactRefs }),
      ...(existing.message === undefined ? {} : { message: existing.message }),
      ...(existing.details === undefined ? {} : { details: existing.details }),
    };
    if (canonicalJson(existingComparable) !== canonicalJson(desired)) {
      throw new Error(`Repository ingestion idempotency key was reused with different content: ${key}`);
    }
    return manifest;
  }

  const toStatus = input.toStatus;
  assertEventStatusBinding(toStatus, input.type);
  if (toStatus !== undefined) {
    if (!canTransitionRepositoryIngestionStatus(manifest.status, toStatus)) {
      throw new Error(`Repository ingestion cannot transition from ${manifest.status} to ${toStatus}.`);
    }
  }
  const artifacts = mergeArtifacts(manifest.artifacts, input.artifacts);
  const nextCompleted = uniqueCapabilities([
    ...manifest.completedCapabilities,
    ...completedCapabilities,
  ]);
  const nextDiagnostics = mergeDiagnostics(manifest.diagnostics, diagnostics);
  const nextStatus = toStatus ?? manifest.status;
  const failure = nextStatus === 'failed'
    ? requireFailure(input.failure)
    : undefined;
  if (input.failure !== undefined && nextStatus !== 'failed') {
    throw new Error('Repository ingestion failure evidence is only valid for failed status.');
  }
  assertReadyState(
    nextStatus,
    artifacts,
    manifest.requestedCapabilities,
    nextCompleted,
    failure,
    manifest.events,
  );

  const event: RepositoryIngestionEvent = {
    id: eventId(manifest.id, key),
    ingestionId: manifest.id,
    sequence: manifest.events.length + 1,
    ...desired,
    ...(toStatus === undefined ? {} : { fromStatus: manifest.status }),
  };
  const completedAt = isTerminalStatus(nextStatus) ? input.occurredAt : undefined;
  const result: RepositoryIngestionManifest = {
    ...manifest,
    status: nextStatus,
    completedCapabilities: nextCompleted,
    artifacts,
    events: [...manifest.events, event],
    diagnostics: nextDiagnostics,
    ...(failure === undefined ? { failure: undefined } : { failure }),
    ...(manifest.startedAt === undefined && manifest.status === 'queued' && nextStatus !== 'queued'
      ? { startedAt: input.occurredAt }
      : {}),
    updatedAt: input.occurredAt,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
  validateRepositoryIngestionManifest(result);
  return result;
}

export function transitionRepositoryIngestionManifest(
  manifest: RepositoryIngestionManifest,
  input: RecordRepositoryIngestionEventInput & { toStatus: RepositoryIngestionStatus },
): RepositoryIngestionManifest {
  return recordRepositoryIngestionEvent(manifest, input);
}

export function serializeRepositoryIngestionManifest(
  manifest: RepositoryIngestionManifest,
): string {
  validateRepositoryIngestionManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function validateRepositoryIngestionManifest(
  manifest: RepositoryIngestionManifest,
): void {
  if (manifest.schemaVersion !== repositoryIngestionSchemaVersion) {
    throw new Error('Unsupported repository ingestion manifest schema version.');
  }
  assertSafeIdentifier(manifest.id, 'Repository ingestion ID');
  assertSafeIdentifier(manifest.repositoryId, 'Repository ID');
  assertHash(manifest.repositoryContentHash, 'Repository content hash');
  assertTimestamp(manifest.requestedAt, 'Repository ingestion request time');
  assertTimestamp(manifest.updatedAt, 'Repository ingestion update time');
  if (manifest.mode === 'incremental' && !manifest.baseManifestId) {
    throw new Error('Incremental repository ingestion requires a base manifest ID.');
  }
  const requested = uniqueCapabilities(manifest.requestedCapabilities);
  const completed = uniqueCapabilities(manifest.completedCapabilities);
  if (canonicalJson(requested) !== canonicalJson(manifest.requestedCapabilities)) {
    throw new Error('Repository ingestion requested capabilities must be sorted and unique.');
  }
  if (canonicalJson(completed) !== canonicalJson(manifest.completedCapabilities)) {
    throw new Error('Repository ingestion completed capabilities must be sorted and unique.');
  }
  assertRequestedCapabilities(requested, completed);
  if (canonicalJson(canonicalAdapters(manifest.analysisAdapters)) !== canonicalJson(manifest.analysisAdapters)) {
    throw new Error('Repository ingestion analysis adapters must be canonical and unique.');
  }
  validateArtifacts(manifest.artifacts);
  canonicalDiagnostics(manifest.diagnostics);
  replayEvents(manifest);
  assertReadyState(
    manifest.status,
    manifest.artifacts,
    requested,
    completed,
    manifest.failure,
    manifest.events,
  );
  if (manifest.status === 'failed' && manifest.failure === undefined) {
    throw new Error('Failed repository ingestion requires failure evidence.');
  }
  if (manifest.status !== 'failed' && manifest.failure !== undefined) {
    throw new Error('Only failed repository ingestion may retain failure evidence.');
  }
  if (isTerminalStatus(manifest.status) && manifest.completedAt === undefined) {
    throw new Error(`Repository ingestion ${manifest.status} status requires completedAt.`);
  }
}

function emptyArtifacts(): RepositoryIngestionArtifacts {
  return {
    shards: [],
    moduleEvidenceBundles: [],
    moduleWikiProposals: [],
    moduleKnowledgeReviews: [],
    knowledgePublications: [],
    moduleIndexReceipts: [],
    publicationHeads: [],
    knowledge: [],
  };
}

function mergeArtifacts(
  current: RepositoryIngestionArtifacts,
  patch: RepositoryIngestionArtifactPatch | undefined,
): RepositoryIngestionArtifacts {
  if (patch === undefined) return current;
  return {
    profile: immutableArtifact(current.profile, patch.profile, 'repository profile'),
    shards: mergeArtifactRefs(current.shards, patch.shards ?? []),
    unifiedRepositoryIr: immutableArtifact(
      current.unifiedRepositoryIr,
      patch.unifiedRepositoryIr,
      'unified repository IR',
    ),
    moduleDiscoveryProposal: immutableArtifact(
      current.moduleDiscoveryProposal,
      patch.moduleDiscoveryProposal,
      'module discovery proposal',
    ),
    moduleCatalog: immutableArtifact(current.moduleCatalog, patch.moduleCatalog, 'module catalog'),
    moduleReview: immutableArtifact(current.moduleReview, patch.moduleReview, 'module review'),
    activeModuleCatalog: immutableArtifact(
      current.activeModuleCatalog,
      patch.activeModuleCatalog,
      'active module catalog',
    ),
    moduleBundle: immutableArtifact(current.moduleBundle, patch.moduleBundle, 'module bundle'),
    moduleEvidenceBundles: mergeArtifactRefs(
      current.moduleEvidenceBundles,
      patch.moduleEvidenceBundles ?? [],
    ),
    moduleWikiProposals: mergeArtifactRefs(
      current.moduleWikiProposals,
      patch.moduleWikiProposals ?? [],
    ),
    moduleKnowledgeReviews: mergeArtifactRefs(
      current.moduleKnowledgeReviews,
      patch.moduleKnowledgeReviews ?? [],
    ),
    knowledgePublications: mergeArtifactRefs(
      current.knowledgePublications,
      patch.knowledgePublications ?? [],
    ),
    moduleIndexReceipts: mergeArtifactRefs(
      current.moduleIndexReceipts,
      patch.moduleIndexReceipts ?? [],
    ),
    publicationHeads: mergeArtifactRefs(
      current.publicationHeads,
      patch.publicationHeads ?? [],
    ),
    incrementalImpactSet: immutableArtifact(
      current.incrementalImpactSet,
      patch.incrementalImpactSet,
      'incremental impact set',
    ),
    knowledge: mergeKnowledge(current.knowledge, patch.knowledge ?? []),
  };
}

function immutableArtifact(
  current: RepositoryIngestionArtifactRef | undefined,
  next: RepositoryIngestionArtifactRef | undefined,
  label: string,
): RepositoryIngestionArtifactRef | undefined {
  if (next === undefined) return current;
  validateArtifactRef(next);
  if (current === undefined) return canonicalArtifactRef(next);
  if (canonicalJson(current) !== canonicalJson(next)) {
    throw new Error(`Repository ingestion ${label} is immutable within one run.`);
  }
  return current;
}

function mergeArtifactRefs(
  current: readonly RepositoryIngestionArtifactRef[],
  added: readonly RepositoryIngestionArtifactRef[],
): RepositoryIngestionArtifactRef[] {
  const result = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const artifact of added) {
    validateArtifactRef(artifact);
    const existing = result.get(artifact.id);
    if (existing && canonicalJson(existing) !== canonicalJson(artifact)) {
      throw new Error(`Repository ingestion artifact ID has conflicting immutable content: ${artifact.id}`);
    }
    result.set(artifact.id, canonicalArtifactRef(artifact));
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeKnowledge(
  current: readonly RepositoryKnowledgeArtifact[],
  added: readonly RepositoryKnowledgeArtifact[],
): RepositoryKnowledgeArtifact[] {
  const result = new Map(current.map((knowledge) => [knowledge.artifact.id, knowledge]));
  for (const knowledge of added) {
    validateKnowledgeArtifact(knowledge);
    const existing = result.get(knowledge.artifact.id);
    if (existing && canonicalJson(existing) !== canonicalJson(knowledge)) {
      throw new Error(`Repository knowledge artifact ID has conflicting content: ${knowledge.artifact.id}`);
    }
    result.set(knowledge.artifact.id, {
      ...knowledge,
      artifact: canonicalArtifactRef(knowledge.artifact),
      sourceArtifactIds: sortedUnique(knowledge.sourceArtifactIds),
      producer: { ...knowledge.producer },
    });
  }
  return [...result.values()].sort((left, right) => left.artifact.id.localeCompare(right.artifact.id));
}

function artifactRefsFromPatch(
  patch: RepositoryIngestionArtifactPatch | undefined,
): RepositoryIngestionArtifactRef[] {
  if (patch === undefined) return [];
  return mergeArtifactRefs([], [
    ...optionalRef(patch.profile),
    ...(patch.shards ?? []),
    ...optionalRef(patch.unifiedRepositoryIr),
    ...optionalRef(patch.moduleDiscoveryProposal),
    ...optionalRef(patch.moduleCatalog),
    ...optionalRef(patch.moduleReview),
    ...optionalRef(patch.activeModuleCatalog),
    ...optionalRef(patch.moduleBundle),
    ...(patch.moduleEvidenceBundles ?? []),
    ...(patch.moduleWikiProposals ?? []),
    ...(patch.moduleKnowledgeReviews ?? []),
    ...(patch.knowledgePublications ?? []),
    ...(patch.moduleIndexReceipts ?? []),
    ...(patch.publicationHeads ?? []),
    ...optionalRef(patch.incrementalImpactSet),
    ...(patch.knowledge ?? []).map((knowledge) => knowledge.artifact),
  ]);
}

function optionalRef(
  artifact: RepositoryIngestionArtifactRef | undefined,
): RepositoryIngestionArtifactRef[] {
  return artifact === undefined ? [] : [artifact];
}

function validateArtifacts(artifacts: RepositoryIngestionArtifacts): void {
  const immutableArtifacts = [
    ...optionalRef(artifacts.profile),
    ...artifacts.shards,
    ...optionalRef(artifacts.unifiedRepositoryIr),
    ...optionalRef(artifacts.moduleDiscoveryProposal),
    ...optionalRef(artifacts.moduleCatalog),
    ...optionalRef(artifacts.moduleReview),
    ...optionalRef(artifacts.activeModuleCatalog),
    ...optionalRef(artifacts.moduleBundle),
    ...artifacts.moduleEvidenceBundles,
    ...artifacts.moduleWikiProposals,
    ...artifacts.moduleKnowledgeReviews,
    ...artifacts.knowledgePublications,
    ...artifacts.moduleIndexReceipts,
    ...artifacts.publicationHeads,
    ...optionalRef(artifacts.incrementalImpactSet),
  ];
  for (const artifact of immutableArtifacts) validateArtifactRef(artifact);
  assertArtifactKind(artifacts.profile, 'repository-profile', 'profile');
  for (const shard of artifacts.shards) assertArtifactKind(shard, 'analysis-shard', 'analysis shard');
  assertArtifactKind(artifacts.unifiedRepositoryIr, 'unified-repository-ir', 'unified repository IR');
  assertArtifactKind(
    artifacts.moduleDiscoveryProposal,
    'module-discovery-proposal',
    'module discovery proposal',
  );
  assertArtifactKind(artifacts.moduleCatalog, 'module-catalog', 'draft module catalog');
  assertArtifactKind(artifacts.moduleReview, 'module-review', 'module review');
  assertArtifactKind(artifacts.activeModuleCatalog, 'module-catalog', 'active module catalog');
  assertArtifactKind(artifacts.moduleBundle, 'repository-module-bundle', 'module bundle');
  for (const artifact of artifacts.moduleEvidenceBundles) {
    assertArtifactKind(artifact, 'repository-module-evidence-bundle', 'module evidence bundle');
  }
  for (const artifact of artifacts.moduleWikiProposals) {
    assertArtifactKind(artifact, 'repository-module-wiki-proposal', 'module Wiki proposal');
  }
  for (const artifact of artifacts.moduleKnowledgeReviews) {
    assertArtifactKind(artifact, 'repository-module-knowledge-review', 'module knowledge review');
  }
  for (const artifact of artifacts.knowledgePublications) {
    assertArtifactKind(artifact, 'repository-knowledge-publication', 'knowledge publication');
  }
  for (const artifact of artifacts.moduleIndexReceipts) {
    assertArtifactKind(artifact, 'repository-module-index-receipt', 'module index receipt');
  }
  for (const artifact of artifacts.publicationHeads) {
    assertArtifactKind(artifact, 'repository-knowledge-publication-head', 'knowledge publication head');
  }
  assertArtifactKind(artifacts.incrementalImpactSet, 'incremental-impact-set', 'incremental impact set');
  for (const knowledge of artifacts.knowledge) validateKnowledgeArtifact(knowledge);
  const allArtifacts = [
    ...immutableArtifacts,
    ...artifacts.knowledge.map((knowledge) => knowledge.artifact),
  ];
  assertUniqueIds(allArtifacts);
  const artifactIds = new Set(allArtifacts.map((artifact) => artifact.id));
  for (const knowledge of artifacts.knowledge) {
    for (const sourceArtifactId of knowledge.sourceArtifactIds) {
      if (!artifactIds.has(sourceArtifactId)) {
        throw new Error(
          `Repository knowledge artifact ${knowledge.artifact.id} cites an absent source artifact: ${sourceArtifactId}`,
        );
      }
    }
  }
}

function validateKnowledgeArtifact(knowledge: RepositoryKnowledgeArtifact): void {
  validateArtifactRef(knowledge.artifact);
  if (knowledge.sourceArtifactIds.length === 0) {
    throw new Error(`Repository knowledge artifact ${knowledge.artifact.id} lacks immutable sources.`);
  }
  if (canonicalJson(sortedUnique(knowledge.sourceArtifactIds)) !== canonicalJson(knowledge.sourceArtifactIds)) {
    throw new Error(`Repository knowledge sources must be sorted and unique: ${knowledge.artifact.id}`);
  }
  if (!knowledge.producer.id.trim()) {
    throw new Error(`Repository knowledge producer is required: ${knowledge.artifact.id}`);
  }
}

function canonicalArtifactRef(
  artifact: RepositoryIngestionArtifactRef,
): RepositoryIngestionArtifactRef {
  return {
    ...artifact,
    hashAlgorithm: artifact.hashAlgorithm ?? 'sha256',
  };
}

function validateArtifactRef(artifact: RepositoryIngestionArtifactRef): void {
  if (!artifact.id.trim()) throw new Error('Repository ingestion artifact ID is required.');
  assertHash(artifact.contentHash, `Artifact ${artifact.id} content hash`);
  if (artifact.hashAlgorithm !== undefined && artifact.hashAlgorithm !== 'sha256') {
    throw new Error(`Artifact ${artifact.id} uses an unsupported hash algorithm.`);
  }
  if (artifact.path !== undefined && !isNormalizedRelativePath(artifact.path)) {
    throw new Error(`Artifact ${artifact.id} path must be normalized and repository-relative.`);
  }
}

function assertArtifactKind(
  artifact: RepositoryIngestionArtifactRef | undefined,
  expected: RepositoryIngestionArtifactRef['kind'],
  label: string,
): void {
  if (artifact !== undefined && artifact.kind !== expected) {
    throw new Error(`Repository ingestion ${label} artifact must have kind ${expected}.`);
  }
}

function assertReadyState(
  status: RepositoryIngestionStatus,
  artifacts: RepositoryIngestionArtifacts,
  requested: readonly AnalysisCapability[],
  completed: readonly AnalysisCapability[],
  failure: RepositoryIngestionFailure | undefined,
  events: readonly RepositoryIngestionEvent[],
): void {
  if (status !== 'ready') return;
  const currentSummary = selectCurrentRepositoryModuleSummaryArtifactRefsFromLedger(status, events);
  const currentPublication = selectCurrentRepositoryKnowledgePublicationArtifactRefsFromLedger(events);
  if (
    !artifacts.profile ||
    !artifacts.unifiedRepositoryIr ||
    !artifacts.moduleCatalog ||
    !artifacts.moduleReview ||
    !artifacts.activeModuleCatalog ||
    !artifacts.moduleBundle ||
    currentSummary.evidenceBundles.length === 0 ||
    currentSummary.wikiProposals.length === 0 ||
    currentSummary.knowledgeReviews.length === 0 ||
    currentPublication.publications.length === 0 ||
    currentPublication.indexReceipts.length === 0 ||
    currentPublication.publicationHeads.length === 0
  ) {
    throw new Error(
      'Ready repository ingestion requires the complete boundary, summary-review, publication, index, and active-head closure.',
    );
  }
  if (
    currentSummary.evidenceBundles.length !== currentSummary.wikiProposals.length ||
    currentSummary.evidenceBundles.length !== currentSummary.knowledgeReviews.length
  ) {
    throw new Error('Ready repository ingestion requires one current summary proposal and review per evidence bundle.');
  }
  assertModulePublicationEvents(artifacts, currentSummary, currentPublication, events);
  const reviewedSourceIds = new Set([
    ...artifacts.knowledgePublications.map((artifact) => artifact.id),
    ...currentSummary.knowledgeReviews.map((artifact) => artifact.id),
  ]);
  for (const format of ['json', 'markdown', 'jsonl', 'json-schema', 'log'] as const) {
    const hasReviewedArtifact = artifacts.knowledge.some((knowledge) => {
      if (knowledge.format !== format) return false;
      // The log is append-only lifecycle evidence and may have started from
      // the draft publication. Content pages must bind to the reviewed output.
      return format === 'log' ||
        knowledge.sourceArtifactIds.some((sourceId) => reviewedSourceIds.has(sourceId));
    });
    if (!hasReviewedArtifact) {
      throw new Error(`Ready repository ingestion lacks required knowledge format: ${format}`);
    }
  }
  assertRequestedCapabilities(requested, completed);
  if (completed.length !== requested.length) {
    throw new Error('Ready repository ingestion must complete every requested analysis capability.');
  }
  if (failure !== undefined) throw new Error('Ready repository ingestion cannot retain failure evidence.');
}

function assertModulePublicationEvents(
  artifacts: RepositoryIngestionArtifacts,
  currentSummary: CurrentRepositoryModuleSummaryArtifactRefs,
  currentPublication: CurrentRepositoryKnowledgePublicationArtifactRefs,
  events: readonly RepositoryIngestionEvent[],
): void {
  const review = artifacts.moduleReview;
  const activeCatalog = artifacts.activeModuleCatalog;
  const bundle = artifacts.moduleBundle;
  if (
    !review || !activeCatalog || !bundle ||
    currentPublication.publications.length === 0 ||
    currentPublication.indexReceipts.length === 0 ||
    currentPublication.publicationHeads.length === 0
  ) {
    throw new Error('Ready repository ingestion lacks reviewed knowledge publication artifacts.');
  }
  const boundaryReviewIndex = findArtifactEvent(events, 'module-review-recorded', review);
  const catalogIndex = findArtifactEvent(events, 'module-catalog-produced', activeCatalog);
  const bundleIndex = findArtifactEvent(events, 'module-bundle-produced', bundle);
  const evidenceIndexes = currentSummary.evidenceBundles.map((artifact) =>
    findArtifactEvent(events, 'module-evidence-bundle-produced', artifact),
  );
  const proposalRoundEvent = findLatestEvent(events, (event) =>
    event.type === 'module-wiki-proposal-produced' &&
    event.toStatus === 'awaiting-summary-review',
  );
  const knowledgeReviewRoundEvent = findLatestEvent(events, (event) =>
    event.type === 'module-knowledge-review-recorded' &&
    event.toStatus === 'publishing-knowledge',
  );
  const proposalRoundIndex = proposalRoundEvent === undefined ? -1 : proposalRoundEvent.sequence - 1;
  const knowledgeReviewRoundIndex = knowledgeReviewRoundEvent === undefined
    ? -1
    : knowledgeReviewRoundEvent.sequence - 1;
  const headIndexes = currentPublication.publicationHeads.map((artifact) =>
    findArtifactEvent(events, 'knowledge-publication-activated', artifact),
  );
  const firstHead = Math.min(...headIndexes);
  const receiptEvent = findLatestEvent(events, (event) =>
    event.sequence <= firstHead + 1 && event.type === 'module-index-receipt-produced',
  );
  const receiptIndex = receiptEvent === undefined ? -1 : receiptEvent.sequence - 1;
  const publicationEvent = findLatestEvent(events, (event) =>
    event.sequence <= receiptIndex + 1 && event.type === 'knowledge-publication-staged',
  );
  const publicationIndex = publicationEvent === undefined ? -1 : publicationEvent.sequence - 1;
  if (
    boundaryReviewIndex < 0 || catalogIndex < 0 || bundleIndex < 0 ||
    evidenceIndexes.some((index) => index < 0) ||
    proposalRoundIndex < 0 || knowledgeReviewRoundIndex < 0 ||
    publicationIndex < 0 || receiptIndex < 0 || headIndexes.some((index) => index < 0)
  ) {
    throw new Error(
      'Ready repository ingestion requires boundary, summary review, staged index, and activation events bound to immutable artifacts.',
    );
  }
  const firstEvidence = Math.min(...evidenceIndexes);
  const lastEvidence = Math.max(...evidenceIndexes);
  if (!(boundaryReviewIndex < catalogIndex && catalogIndex < bundleIndex &&
        bundleIndex < firstEvidence && lastEvidence < proposalRoundIndex &&
        proposalRoundIndex < knowledgeReviewRoundIndex && knowledgeReviewRoundIndex < publicationIndex &&
        publicationIndex < receiptIndex && receiptIndex < firstHead)) {
    throw new Error(
      'Repository knowledge publication events must preserve boundary, evidence, summary review, staging, index, then activation order.',
    );
  }
}

function findArtifactEvent(
  events: readonly RepositoryIngestionEvent[],
  type: RepositoryIngestionEventType,
  artifact: RepositoryIngestionArtifactRef,
): number {
  return events.findIndex((event) =>
    event.type === type &&
    (event.artifactRefs ?? []).some((candidate) =>
      candidate.id === artifact.id &&
      candidate.kind === artifact.kind &&
      candidate.contentHash === artifact.contentHash,
    ),
  );
}

function findLatestEvent(
  events: readonly RepositoryIngestionEvent[],
  predicate: (event: RepositoryIngestionEvent) => boolean,
): RepositoryIngestionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && predicate(event)) return event;
  }
  return undefined;
}

function eventArtifactsOfKind(
  event: RepositoryIngestionEvent | undefined,
  kind: RepositoryIngestionArtifactRef['kind'],
): RepositoryIngestionArtifactRef[] {
  return (event?.artifactRefs ?? [])
    .filter((artifact) => artifact.kind === kind)
    .map(canonicalArtifactRef)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function replayEvents(manifest: RepositoryIngestionManifest): void {
  if (manifest.events.length === 0) throw new Error('Repository ingestion manifest requires events.');
  const ids = new Set<string>();
  const keys = new Set<string>();
  let status: RepositoryIngestionStatus | undefined;
  let previousTime: string | undefined;
  manifest.events.forEach((event, index) => {
    if (event.ingestionId !== manifest.id) throw new Error('Repository ingestion event belongs to another run.');
    if (event.sequence !== index + 1) throw new Error('Repository ingestion event sequence is not contiguous.');
    if (ids.has(event.id)) throw new Error(`Duplicate repository ingestion event ID: ${event.id}`);
    ids.add(event.id);
    if (event.idempotencyKey !== undefined) {
      if (keys.has(event.idempotencyKey)) {
        throw new Error(`Duplicate repository ingestion idempotency key: ${event.idempotencyKey}`);
      }
      keys.add(event.idempotencyKey);
      if (event.id !== eventId(manifest.id, event.idempotencyKey)) {
        throw new Error(`Repository ingestion event ID is not bound to its idempotency key: ${event.id}`);
      }
    }
    assertTimestamp(event.occurredAt, 'Repository ingestion event time');
    if (previousTime !== undefined && event.occurredAt.localeCompare(previousTime) < 0) {
      throw new Error('Repository ingestion event timeline is not monotonic.');
    }
    previousTime = event.occurredAt;
    if (index === 0) {
      if (event.type !== 'ingestion-requested' || event.toStatus !== 'queued') {
        throw new Error('Repository ingestion event log must begin with an ingestion request.');
      }
      status = 'queued';
      return;
    }
    assertEventStatusBinding(event.toStatus, event.type);
    if (event.toStatus !== undefined) {
      if (status === undefined || event.fromStatus !== status) {
        throw new Error('Repository ingestion event transition does not match replayed status.');
      }
      if (!canTransitionRepositoryIngestionStatus(status, event.toStatus)) {
        throw new Error(`Invalid replayed repository ingestion transition: ${status} -> ${event.toStatus}`);
      }
      status = event.toStatus;
    }
  });
  if (status !== manifest.status) {
    throw new Error('Repository ingestion manifest status does not match its append-only events.');
  }
  const eventArtifacts = mergeArtifactRefs(
    [],
    manifest.events.flatMap((event) => event.artifactRefs ?? []),
  );
  const projectedArtifacts = artifactRefsFromPatch(manifest.artifacts);
  if (canonicalJson(eventArtifacts) !== canonicalJson(projectedArtifacts)) {
    throw new Error('Repository ingestion artifact projection does not match its append-only events.');
  }
  if (manifest.events.at(-1)?.occurredAt !== manifest.updatedAt) {
    throw new Error('Repository ingestion updatedAt must match the latest append-only event.');
  }
}

function eventDetails(
  details: RepositoryIngestionJsonValue | undefined,
  capabilities: readonly AnalysisCapability[],
  diagnostics: readonly RepositoryDiagnostic[],
  failure: RepositoryIngestionFailure | undefined,
  artifacts: RepositoryIngestionArtifactPatch | undefined,
): RepositoryIngestionJsonValue | undefined {
  if (
    details === undefined &&
    capabilities.length === 0 &&
    diagnostics.length === 0 &&
    failure === undefined &&
    artifacts === undefined
  ) {
    return undefined;
  }
  return {
    update: details ?? null,
    completedCapabilities: [...capabilities],
    diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
    failure: failure === undefined ? null : { ...failure },
    updateHash: sha256Hex(canonicalJson({
      details: details ?? null,
      completedCapabilities: [...capabilities],
      diagnostics,
      failure: failure ?? null,
      artifacts: artifacts ?? null,
    })),
  };
}

function assertEventStatusBinding(
  status: RepositoryIngestionStatus | undefined,
  type: RepositoryIngestionEventType,
): void {
  const expected: Partial<Record<RepositoryIngestionStatus, RepositoryIngestionEventType>> = {
    'awaiting-summary-review': 'module-wiki-proposal-produced',
    'publishing-knowledge': 'module-knowledge-review-recorded',
    ready: 'ingestion-completed',
    failed: 'ingestion-failed',
    cancelled: 'ingestion-cancelled',
    superseded: 'ingestion-superseded',
  };
  if (status !== undefined && expected[status] !== undefined && expected[status] !== type) {
    throw new Error(`Repository ingestion ${status} transition requires ${expected[status]} event.`);
  }
  const reverse: Partial<Record<RepositoryIngestionEventType, RepositoryIngestionStatus>> = {
    'ingestion-completed': 'ready',
    'ingestion-failed': 'failed',
    'ingestion-cancelled': 'cancelled',
    'ingestion-superseded': 'superseded',
  };
  if (reverse[type] !== undefined && reverse[type] !== status) {
    throw new Error(`Repository ingestion ${type} event requires ${reverse[type]} status.`);
  }
}

function requireFailure(failure: RepositoryIngestionFailure | undefined): RepositoryIngestionFailure {
  if (failure === undefined || !failure.code.trim() || !failure.message.trim()) {
    throw new Error('Failed repository ingestion requires structured failure evidence.');
  }
  return { ...failure, code: failure.code.trim(), message: failure.message.trim() };
}

function canonicalAdapters(values: readonly AnalysisAdapterDescriptor[]): AnalysisAdapterDescriptor[] {
  const ids = new Set<string>();
  const result = [...values]
    .map((adapter) => {
      if (adapter.schemaVersion !== repositoryIngestionSchemaVersion) {
        throw new Error(`Analysis adapter ${adapter.id} has an unsupported schema version.`);
      }
      assertSafeIdentifier(adapter.id, 'Analysis adapter ID');
      if (ids.has(adapter.id)) throw new Error(`Duplicate analysis adapter ID: ${adapter.id}`);
      ids.add(adapter.id);
      return {
        ...adapter,
        languageIds: sortedUnique(adapter.languageIds),
        capabilities: uniqueCapabilities(adapter.capabilities),
        modes: [...new Set(adapter.modes)].sort(),
        outputs: [...new Set(adapter.outputs)].sort(),
        requirements: adapter.requirements === undefined
          ? undefined
          : sortedUnique(adapter.requirements),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonicalJson(values) !== canonicalJson(result)) {
    // Creation canonicalizes adapters; persisted manifests must already be canonical.
    return result;
  }
  return result;
}

function canonicalDiagnostics(values: readonly RepositoryDiagnostic[]): RepositoryDiagnostic[] {
  const ids = new Set<string>();
  return [...values]
    .map((diagnostic) => {
      if (!diagnostic.id.trim() || !diagnostic.code.trim() || !diagnostic.message.trim()) {
        throw new Error('Repository ingestion diagnostic requires id, code, and message.');
      }
      if (ids.has(diagnostic.id)) throw new Error(`Duplicate repository diagnostic ID: ${diagnostic.id}`);
      ids.add(diagnostic.id);
      return { ...diagnostic };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function mergeDiagnostics(
  current: readonly RepositoryDiagnostic[],
  added: readonly RepositoryDiagnostic[],
): RepositoryDiagnostic[] {
  const result = new Map(current.map((diagnostic) => [diagnostic.id, diagnostic]));
  for (const diagnostic of added) {
    const existing = result.get(diagnostic.id);
    if (existing && canonicalJson(existing) !== canonicalJson(diagnostic)) {
      throw new Error(`Repository diagnostic ID has conflicting content: ${diagnostic.id}`);
    }
    result.set(diagnostic.id, diagnostic);
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueCapabilities(values: readonly AnalysisCapability[]): AnalysisCapability[] {
  return [...new Set(values)].sort();
}

function assertRequestedCapabilities(
  requested: readonly AnalysisCapability[],
  completed: readonly AnalysisCapability[],
): void {
  const allowed = new Set(requested);
  for (const capability of completed) {
    if (!allowed.has(capability)) {
      throw new Error(`Completed analysis capability was not requested: ${capability}`);
    }
  }
}

function canonicalActor(actor: RepositoryIngestionEventActor): RepositoryIngestionEventActor {
  if (!actor.id.trim()) throw new Error('Repository ingestion event actor ID is required.');
  return { kind: actor.kind, id: actor.id.trim() };
}

function eventId(ingestionId: string, key: string): string {
  return `repository-ingestion-event:${sha256Hex(`${ingestionId}\u0000${key}`).slice(0, 24)}`;
}

function assertUniqueIds(values: readonly RepositoryIngestionArtifactRef[]): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate repository ingestion artifact ID: ${value.id}`);
    ids.add(value.id);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!safeIdentifier.test(value)) throw new Error(`${label} is unsafe.`);
}

function assertHash(value: string, label: string): void {
  if (!sha256Pattern.test(value)) throw new Error(`${label} must be lowercase SHA-256.`);
}

function assertTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isTerminalStatus(status: RepositoryIngestionStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'cancelled' || status === 'superseded';
}

function isNormalizedRelativePath(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
