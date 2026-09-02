import type {
  RepositoryIngestionArtifactRef,
  RepositoryIngestionManifest,
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
  RepositoryModuleIndexReceipt,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  canonicalJson,
  recordRepositoryIngestionEvent,
  selectCurrentRepositoryKnowledgePublicationArtifactRefs,
  serializeRepositoryIngestionManifest,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
  validateRepositoryKnowledgePublication,
  validateRepositoryKnowledgePublicationHead,
  validateRepositoryModuleIndexReceipt,
} from '@forexplore/workflow-core';
import type {
  ModuleKnowledgeIndexHead,
  ModuleKnowledgeIndexPublisher,
  ModuleKnowledgePublicationKey,
} from './module-knowledge-index-client';
import {
  persistRepositoryIngestionArtifacts,
  readRepositoryIngestionArtifactContent,
  readRepositoryIngestionManifest,
  repositoryIngestionManifestPath,
  verifyRepositoryIngestionStoredArtifacts,
  type PersistRepositoryIngestionArtifactsRequest,
  type RepositoryIngestionStoredArtifact,
} from './repository-ingestion-store';
import { RepositoryKnowledgePublicationStore } from './repository-knowledge-publication-store';

export const repositoryModuleKnowledgeWithdrawalVersion = '1.0.0';

export interface WithdrawRepositoryModuleKnowledgeInput {
  repositoryRoot: string;
  ingestionId: string;
  scope: RepositoryKnowledgePublicationScope;
  reason: string;
  actorId: string;
}

export interface WithdrawRepositoryModuleKnowledgeDependencies {
  publicationStore: RepositoryKnowledgePublicationStore;
  indexPublisher: ModuleKnowledgeIndexPublisher;
  loadManifest?: (
    repositoryRoot: string,
    ingestionId: string,
  ) => Promise<RepositoryIngestionManifest | null>;
  readArtifact?: typeof readRepositoryIngestionArtifactContent;
  verifyStoredArtifacts?: typeof verifyRepositoryIngestionStoredArtifacts;
  persist?: (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>;
  now?: () => string;
}

export interface WithdrawRepositoryModuleKnowledgeResult {
  outcome: 'withdrawn' | 'reused';
  manifest: RepositoryIngestionManifest;
  manifestPath: string;
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  restoredHead: RepositoryKnowledgePublicationHead | undefined;
  remoteHead: ModuleKnowledgeIndexHead | null;
}

/**
 * Logically revokes one ready module-knowledge publication. Remote visibility
 * is removed first; a crash after that point can be safely replayed to finish
 * the local registry and immutable manifest ledger.
 */
export async function withdrawRepositoryModuleKnowledgePublication(
  input: WithdrawRepositoryModuleKnowledgeInput,
  dependencies: WithdrawRepositoryModuleKnowledgeDependencies,
): Promise<WithdrawRepositoryModuleKnowledgeResult> {
  validateInput(input);
  const loadManifest = dependencies.loadManifest ?? readRepositoryIngestionManifest;
  const readArtifact = dependencies.readArtifact ?? readRepositoryIngestionArtifactContent;
  const verifyStored = dependencies.verifyStoredArtifacts ?? verifyRepositoryIngestionStoredArtifacts;
  const persist = dependencies.persist ?? persistRepositoryIngestionArtifacts;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const manifest = await loadManifest(input.repositoryRoot, input.ingestionId);
  if (manifest === null) throw new Error(`Repository ingestion does not exist: ${input.ingestionId}`);
  validateRepositoryIngestionManifest(manifest);
  if (manifest.repositoryId !== input.scope.repositoryId) {
    throw new Error('Knowledge withdrawal scope does not match the repository ingestion.');
  }
  await verifyStored(input.repositoryRoot, manifest);
  const manifestPath = repositoryIngestionManifestPath(manifest.id);
  if (manifest.status === 'superseded') {
    return readCompletedWithdrawal(
      input,
      manifest,
      manifestPath,
      readArtifact,
      dependencies.publicationStore,
      dependencies.indexPublisher,
    );
  }
  if (manifest.status !== 'ready') {
    throw new Error(`Only a ready repository knowledge ingestion can be withdrawn: ${manifest.status}`);
  }

  const current = selectCurrentRepositoryKnowledgePublicationArtifactRefs(manifest);
  if (
    current.publications.length !== 1 ||
    current.indexReceipts.length !== 1 ||
    current.publicationHeads.length !== 1
  ) {
    throw new Error('Ready ingestion lacks one exact active publication closure.');
  }
  const [activePublication, activeReceipt, activeHead] = await Promise.all([
    readJson<RepositoryKnowledgePublication>(input, current.publications[0]!, readArtifact),
    readJson<RepositoryModuleIndexReceipt>(input, current.indexReceipts[0]!, readArtifact),
    readJson<RepositoryKnowledgePublicationHead>(input, current.publicationHeads[0]!, readArtifact),
  ]);
  validateActiveClosure(input.scope, activePublication, activeReceipt, activeHead);

  const snapshot = await dependencies.publicationStore.read(input.repositoryRoot, input.scope);
  const localTarget = snapshot.publications.find((candidate) => candidate.id === activePublication.id);
  if (localTarget === undefined) {
    throw new Error('The active manifest publication is absent from the local SQLite registry.');
  }
  const predecessor = activePublication.previousPublicationId === undefined
    ? undefined
    : snapshot.publications.find((candidate) => candidate.id === activePublication.previousPublicationId);
  if (activePublication.previousPublicationId !== undefined && predecessor === undefined) {
    throw new Error('The local SQLite registry lacks the publication predecessor required for withdrawal.');
  }

  const key = publicationKey(activePublication);
  let remoteHead = await dependencies.indexPublisher.readHead(input.scope);
  if (remoteMatchesPublication(remoteHead, activePublication)) {
    remoteHead = await dependencies.indexPublisher.withdraw(key, activePublication.generation);
  } else if (!remoteMatchesRestored(remoteHead, predecessor)) {
    throw new Error('The remote module-index head has drifted; refusing to withdraw a different publication.');
  }

  const localWithdrawal = await dependencies.publicationStore.withdraw({
    repositoryRoot: input.repositoryRoot,
    scope: input.scope,
    publicationId: activePublication.id,
    indexReceipt: activeReceipt,
    expectedHead: activeHead,
    reason: input.reason.trim(),
    withdrawnAt: latestTimestamp(now(), activePublication.activatedAt!),
  });
  if (!localWithdrawal.currentProjectionSynchronized) {
    const reconciled = await dependencies.publicationStore.reconcileCurrentProjection(
      input.repositoryRoot,
      input.scope,
    );
    if (!reconciled) {
      throw new Error('Withdrawal committed locally, but the rebuildable current projection is not synchronized.');
    }
  }
  assertRestoredHeadsAgree(remoteHead, localWithdrawal.head, localWithdrawal.restoredPublication);

  const occurredAt = latestTimestamp(
    manifest.updatedAt,
    localWithdrawal.publication.withdrawnAt!,
    now(),
  );
  const runRoot = `.forexplore/ingestion/${manifest.id}`;
  const publicationArtifact = immutableJsonArtifact(
    `${localWithdrawal.publication.id}:withdrawn:${localWithdrawal.publication.contentHash.slice(0, 16)}`,
    'repository-knowledge-publication',
    `${runRoot}/knowledge-publications/${safeName(`${localWithdrawal.publication.id}:${localWithdrawal.publication.contentHash}`)}.json`,
    localWithdrawal.publication,
    occurredAt,
  );
  const receiptArtifact = immutableJsonArtifact(
    `${localWithdrawal.indexReceipt.id}:withdrawn:${localWithdrawal.indexReceipt.contentHash.slice(0, 16)}`,
    'repository-module-index-receipt',
    `${runRoot}/module-index-receipts/${safeName(`${localWithdrawal.indexReceipt.id}:${localWithdrawal.indexReceipt.contentHash}`)}.json`,
    localWithdrawal.indexReceipt,
    occurredAt,
  );
  const headArtifact = localWithdrawal.head === undefined
    ? undefined
    : immutableJsonArtifact(
      `repository-knowledge-publication-head:${localWithdrawal.head.contentHash.slice(0, 16)}`,
      'repository-knowledge-publication-head',
      `${runRoot}/publication-heads/${safeName(localWithdrawal.head.contentHash)}.json`,
      localWithdrawal.head,
      occurredAt,
    );
  // `ready` requires an active publication closure, so the terminal lifecycle
  // transition must be appended before the withdrawal event removes that
  // closure from the ledger projection. The two events share one timestamp and
  // are persisted atomically in the same manifest CAS.
  let withdrawnManifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'ingestion-superseded',
    occurredAt,
    actor: { kind: 'human', id: input.actorId.trim() },
    idempotencyKey: `${manifest.id}:manual-knowledge-withdrawal-completed:${localWithdrawal.publication.contentHash}`,
    toStatus: 'superseded',
    message: `Module-knowledge publication withdrawn: ${input.reason.trim()}`,
  });
  withdrawnManifest = recordRepositoryIngestionEvent(withdrawnManifest, {
    type: 'knowledge-publication-withdrawn',
    occurredAt,
    actor: { kind: 'human', id: input.actorId.trim() },
    idempotencyKey: `${manifest.id}:manual-knowledge-withdrawal:${localWithdrawal.publication.contentHash}`,
    artifacts: {
      knowledgePublications: [publicationArtifact.ref],
      moduleIndexReceipts: [receiptArtifact.ref],
      ...(headArtifact === undefined ? {} : { publicationHeads: [headArtifact.ref] }),
    },
    details: {
      reason: input.reason.trim(),
      remoteHead: remoteHead === null ? null : {
        publicationId: remoteHead.publicationId,
        publicationPayloadHash: remoteHead.publicationPayloadHash,
        generation: remoteHead.generation,
        revision: remoteHead.revision,
      },
      restoredPublicationId: localWithdrawal.restoredPublication?.id ?? null,
    },
    message: 'Logically withdrew the active reviewed module-knowledge publication.',
  });
  await persist({
    repositoryRoot: input.repositoryRoot,
    ingestionId: input.ingestionId,
    artifacts: [
      publicationArtifact.stored,
      receiptArtifact.stored,
      ...(headArtifact === undefined ? [] : [headArtifact.stored]),
      {
        path: manifestPath,
        content: serializeRepositoryIngestionManifest(withdrawnManifest),
        mode: 'manifest',
        expectedContentHash: sha256Hex(serializeRepositoryIngestionManifest(manifest)),
      },
    ],
  });
  return {
    outcome: 'withdrawn',
    manifest: withdrawnManifest,
    manifestPath,
    publication: localWithdrawal.publication,
    indexReceipt: localWithdrawal.indexReceipt,
    restoredHead: localWithdrawal.head,
    remoteHead,
  };
}

async function readCompletedWithdrawal(
  input: WithdrawRepositoryModuleKnowledgeInput,
  manifest: RepositoryIngestionManifest,
  manifestPath: string,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
  publicationStore: RepositoryKnowledgePublicationStore,
  indexPublisher: ModuleKnowledgeIndexPublisher,
): Promise<WithdrawRepositoryModuleKnowledgeResult> {
  const event = [...manifest.events].reverse().find((candidate) =>
    candidate.type === 'knowledge-publication-withdrawn' &&
    candidate.actor.kind === 'human'
  );
  if (event === undefined) {
    throw new Error('Superseded ingestion was not closed by a manual module-knowledge withdrawal.');
  }
  const update = isRecord(event.details) && isRecord(event.details.update)
    ? event.details.update
    : undefined;
  if (
    event.actor.id !== input.actorId.trim() ||
    update?.reason !== input.reason.trim()
  ) {
    throw new Error('Manual withdrawal replay conflicts with the recorded actor or reason.');
  }
  const publicationRef = exactEventArtifact(event.artifactRefs, 'repository-knowledge-publication');
  const receiptRef = exactEventArtifact(event.artifactRefs, 'repository-module-index-receipt');
  const headRef = optionalEventArtifact(event.artifactRefs, 'repository-knowledge-publication-head');
  const [publication, indexReceipt, restoredHead, remoteHead] = await Promise.all([
    readJson<RepositoryKnowledgePublication>(input, publicationRef, readArtifact),
    readJson<RepositoryModuleIndexReceipt>(input, receiptRef, readArtifact),
    headRef === undefined
      ? Promise.resolve(undefined)
      : readJson<RepositoryKnowledgePublicationHead>(input, headRef, readArtifact),
    indexPublisher.readHead(input.scope),
  ]);
  validateRepositoryKnowledgePublication(publication);
  validateRepositoryModuleIndexReceipt(indexReceipt);
  if (restoredHead !== undefined) validateRepositoryKnowledgePublicationHead(restoredHead);
  if (
    publication.status !== 'withdrawn' ||
    indexReceipt.status !== 'withdrawn' ||
    canonicalJson(publication.scope) !== canonicalJson(input.scope) ||
    canonicalJson(indexReceipt.scope) !== canonicalJson(input.scope) ||
    indexReceipt.publicationId !== publication.id ||
    indexReceipt.publicationPayloadHash !== publication.payloadHash ||
    indexReceipt.generation !== publication.generation ||
    (restoredHead !== undefined && canonicalJson(restoredHead.scope) !== canonicalJson(input.scope))
  ) {
    throw new Error('Manual withdrawal ledger does not reference withdrawn states.');
  }
  const snapshot = await publicationStore.read(input.repositoryRoot, input.scope);
  const localWithdrawal = snapshot.publications.find((candidate) => candidate.id === publication.id);
  if (
    localWithdrawal?.status !== 'withdrawn' ||
    localWithdrawal.contentHash !== publication.contentHash
  ) {
    throw new Error('Completed withdrawal has drifted from the local SQLite publication state.');
  }
  if (restoredHead === undefined) {
    if (snapshot.head !== undefined || remoteHead !== null) {
      throw new Error('Completed withdrawal expected an empty local and remote active head.');
    }
  } else {
    const restoredPublication = snapshot.publications.find((candidate) =>
      candidate.id === restoredHead.publicationId
    );
    if (
      snapshot.head?.contentHash !== restoredHead.contentHash ||
      restoredPublication?.status !== 'active' ||
      remoteHead === null ||
      remoteHead.publicationId !== restoredHead.publicationId ||
      remoteHead.generation !== restoredHead.generation ||
      remoteHead.publicationPayloadHash !== restoredPublication.payloadHash
    ) {
      throw new Error('Completed withdrawal has drifted from the restored local or remote head.');
    }
  }
  return {
    outcome: 'reused',
    manifest,
    manifestPath,
    publication,
    indexReceipt,
    restoredHead,
    remoteHead,
  };
}

function validateInput(input: WithdrawRepositoryModuleKnowledgeInput): void {
  if (!input.repositoryRoot.trim() || !input.ingestionId.trim()) {
    throw new Error('Repository root and ingestion ID are required for withdrawal.');
  }
  if (!input.scope.repositoryId.trim() || !input.scope.channel.trim()) {
    throw new Error('Repository knowledge withdrawal scope is required.');
  }
  if (!input.reason.trim() || !input.actorId.trim()) {
    throw new Error('Manual knowledge withdrawal requires an actor and reason.');
  }
}

function validateActiveClosure(
  scope: RepositoryKnowledgePublicationScope,
  publication: RepositoryKnowledgePublication,
  receipt: RepositoryModuleIndexReceipt,
  head: RepositoryKnowledgePublicationHead,
): void {
  validateRepositoryKnowledgePublication(publication);
  validateRepositoryModuleIndexReceipt(receipt);
  validateRepositoryKnowledgePublicationHead(head);
  if (
    publication.status !== 'active' ||
    receipt.status !== 'active' ||
    canonicalJson(publication.scope) !== canonicalJson(scope) ||
    canonicalJson(receipt.scope) !== canonicalJson(scope) ||
    receipt.publicationId !== publication.id ||
    receipt.publicationPayloadHash !== publication.payloadHash ||
    receipt.generation !== publication.generation ||
    head.publicationId !== publication.id ||
    head.publicationHash !== publication.contentHash ||
    head.generation !== publication.generation
  ) {
    throw new Error('Ready manifest publication, index receipt, and CAS head do not form one active closure.');
  }
}

function publicationKey(publication: RepositoryKnowledgePublication): ModuleKnowledgePublicationKey {
  return {
    repositoryId: publication.scope.repositoryId,
    channel: publication.scope.channel,
    publicationId: publication.id,
    generation: publication.generation,
  };
}

function remoteMatchesPublication(
  head: ModuleKnowledgeIndexHead | null,
  publication: RepositoryKnowledgePublication,
): boolean {
  return head !== null &&
    head.publicationId === publication.id &&
    head.publicationPayloadHash === publication.payloadHash &&
    head.generation === publication.generation;
}

function remoteMatchesRestored(
  head: ModuleKnowledgeIndexHead | null,
  publication: RepositoryKnowledgePublication | undefined,
): boolean {
  if (head === null) return publication === undefined;
  return head.publicationId === (publication?.id ?? null) &&
    head.publicationPayloadHash === (publication?.payloadHash ?? null) &&
    head.generation === (publication?.generation ?? null);
}

function assertRestoredHeadsAgree(
  remote: ModuleKnowledgeIndexHead | null,
  local: RepositoryKnowledgePublicationHead | undefined,
  restoredPublication: RepositoryKnowledgePublication | undefined,
): void {
  if (remote === null) {
    if (local === undefined && restoredPublication === undefined) return;
    throw new Error('Local and remote withdrawal restored different publication heads.');
  }
  if (
    remote.publicationId !== (local?.publicationId ?? null) ||
    remote.generation !== (local?.generation ?? null) ||
    remote.publicationPayloadHash !== (restoredPublication?.payloadHash ?? null)
  ) {
    throw new Error('Local and remote withdrawal restored different publication heads.');
  }
}

async function readJson<T>(
  input: Pick<WithdrawRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  artifact: RepositoryIngestionArtifactRef,
  reader: typeof readRepositoryIngestionArtifactContent,
): Promise<T> {
  const content = await reader(input.repositoryRoot, input.ingestionId, artifact);
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Repository ingestion artifact is invalid JSON: ${artifact.id}`);
  }
}

function immutableJsonArtifact(
  id: string,
  kind: RepositoryIngestionArtifactRef['kind'],
  artifactPath: string,
  value: unknown,
  createdAt: string,
): { ref: RepositoryIngestionArtifactRef; stored: RepositoryIngestionStoredArtifact } {
  const content = `${canonicalJson(value)}\n`;
  const ref: RepositoryIngestionArtifactRef = {
    id,
    kind,
    contentHash: sha256Hex(content),
    hashAlgorithm: 'sha256',
    schemaVersion: repositoryIngestionSchemaVersion,
    path: artifactPath,
    mediaType: 'application/json',
    byteLength: Buffer.byteLength(content, 'utf8'),
    createdAt,
  };
  return { ref, stored: { path: artifactPath, content, mode: 'immutable' } };
}

function exactEventArtifact(
  refs: RepositoryIngestionArtifactRef[] | undefined,
  kind: RepositoryIngestionArtifactRef['kind'],
): RepositoryIngestionArtifactRef {
  const matches = (refs ?? []).filter((ref) => ref.kind === kind);
  if (matches.length !== 1) throw new Error(`Withdrawal event lacks one exact ${kind} artifact.`);
  return matches[0]!;
}

function optionalEventArtifact(
  refs: RepositoryIngestionArtifactRef[] | undefined,
  kind: RepositoryIngestionArtifactRef['kind'],
): RepositoryIngestionArtifactRef | undefined {
  const matches = (refs ?? []).filter((ref) => ref.kind === kind);
  if (matches.length > 1) throw new Error(`Withdrawal event has duplicate ${kind} artifacts.`);
  return matches[0];
}

function safeName(value: string): string {
  return `${value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}-${sha256Hex(value).slice(0, 12)}`;
}

function latestTimestamp(...timestamps: string[]): string {
  for (const timestamp of timestamps) {
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      throw new Error('Repository knowledge withdrawal timestamp is invalid.');
    }
  }
  return [...timestamps].sort().at(-1)!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
