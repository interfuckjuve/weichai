import type {
  IndexedModuleKnowledgeDocument,
  ModuleDiscoveryProposal,
  RepositoryArtifactProducer,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionManifest,
  RepositoryKnowledgeArtifact,
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
  RepositoryModuleBundle,
  RepositoryModuleCatalog,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleIndexReceipt,
  RepositoryModuleKnowledgePage,
  RepositoryModuleKnowledgeReview,
  RepositoryModuleKnowledgeReviewDecision,
  RepositoryModuleReview,
  RepositoryModuleWikiProposal,
  SerializedRepositoryKnowledgeArtifact,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  canonicalJson,
  materializeIndexedModuleKnowledgeDocument,
  materializeRepositoryModuleKnowledgeArtifacts,
  materializeRepositoryModuleKnowledgeIndexArtifact,
  materializeRepositoryModuleKnowledgeJsonlArtifact,
  materializeRepositoryModuleKnowledgeReview,
  materializeRepositoryModuleKnowledgeSchemaArtifact,
  materializeRepositoryModuleSummaryJsonSchemaArtifact,
  materializeReviewedRepositoryModuleKnowledgePage,
  recordRepositoryIngestionEvent,
  selectCurrentRepositoryKnowledgePublicationArtifactRefs,
  selectCurrentRepositoryModuleSummaryArtifactRefs,
  selectRepositoryModuleSummaryRevisionArtifactRefs,
  serializeRepositoryIngestionManifest,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
  validateRepositoryKnowledgePublication,
  validateRepositoryKnowledgePublicationHead,
  validateRepositoryModuleBundle,
  validateRepositoryModuleEvidenceBundle,
  validateRepositoryModuleIndexReceipt,
  validateRepositoryModuleKnowledgeReview,
  validateRepositoryModuleWikiProposal,
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

export const repositoryModuleKnowledgePublicationVersion = '1.1.0';

const knowledgePublisher: RepositoryArtifactProducer = {
  kind: 'knowledge-publisher',
  id: 'forexplore-vscode/repository-module-knowledge-publication',
  version: repositoryModuleKnowledgePublicationVersion,
};

export interface RepositoryModuleKnowledgeReviewSubmission {
  moduleId: string;
  decision: RepositoryModuleKnowledgeReviewDecision;
  reviewerId: string;
  comment?: string;
  reviewedAt?: string;
}

export interface ReviewAndPublishRepositoryModuleKnowledgeInput {
  repositoryRoot: string;
  ingestionId: string;
  scope: RepositoryKnowledgePublicationScope;
  /** Explicit ACL scopes copied to every independent module-index document. */
  repositoryScopes: string[];
  /** Exactly one decision per current module. Replays may provide the same set again. */
  reviews: RepositoryModuleKnowledgeReviewSubmission[];
}

export interface ReviewAndPublishRepositoryModuleKnowledgeDependencies {
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

export interface ReviewAndPublishRepositoryModuleKnowledgeResult {
  outcome: 'ready' | 'revision-required' | 'rejected' | 'reused';
  manifest: RepositoryIngestionManifest;
  manifestPath: string;
  reviews: RepositoryModuleKnowledgeReview[];
  pages: RepositoryModuleKnowledgePage[];
  publication?: RepositoryKnowledgePublication;
  indexReceipt?: RepositoryModuleIndexReceipt;
  publicationHead?: RepositoryKnowledgePublicationHead;
}

interface RepositoryModuleKnowledgeClosure {
  ir: UnifiedRepositoryIR;
  discoveryProposal: ModuleDiscoveryProposal;
  moduleReview: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
  bundle: RepositoryModuleBundle;
  evidenceBundles: RepositoryModuleEvidenceBundle[];
  wikiProposals: RepositoryModuleWikiProposal[];
}

/**
 * Owns the second, independent human gate and the publication transaction.
 * Boundary acceptance is only an input to this function: no Wiki bytes enter
 * the formal module index until every current proposal is explicitly accepted.
 */
export async function reviewAndPublishRepositoryModuleKnowledge(
  input: ReviewAndPublishRepositoryModuleKnowledgeInput,
  dependencies: ReviewAndPublishRepositoryModuleKnowledgeDependencies,
): Promise<ReviewAndPublishRepositoryModuleKnowledgeResult> {
  validatePublicationInput(input);
  const loadManifest = dependencies.loadManifest ?? readRepositoryIngestionManifest;
  const readArtifact = dependencies.readArtifact ?? readRepositoryIngestionArtifactContent;
  const verifyStored = dependencies.verifyStoredArtifacts ?? verifyRepositoryIngestionStoredArtifacts;
  const persist = dependencies.persist ?? persistRepositoryIngestionArtifacts;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let manifest = await loadManifest(input.repositoryRoot, input.ingestionId);
  if (manifest === null) throw new Error(`Repository ingestion does not exist: ${input.ingestionId}`);
  validateRepositoryIngestionManifest(manifest);
  if (manifest.repositoryId !== input.scope.repositoryId) {
    throw new Error('Knowledge publication scope does not match the repository ingestion.');
  }
  await verifyStored(input.repositoryRoot, manifest);
  const manifestPath = repositoryIngestionManifestPath(manifest.id);

  if (manifest.status === 'ready') {
    return reuseReadyPublication(
      input,
      manifest,
      manifestPath,
      dependencies,
      readArtifact,
    );
  }
  if (manifest.status === 'summarizing-modules' && manifest.artifacts.moduleKnowledgeReviews.length > 0) {
    return {
      outcome: 'revision-required',
      manifest,
      manifestPath,
      reviews: await readReviewRefs(
        input,
        selectRepositoryModuleSummaryRevisionArtifactRefs(manifest).priorKnowledgeReviews,
        readArtifact,
      ),
      pages: [],
    };
  }
  if (manifest.status === 'superseded' && manifest.artifacts.moduleKnowledgeReviews.length > 0) {
    return {
      outcome: 'rejected',
      manifest,
      manifestPath,
      reviews: await readLatestRecordedReviews(input, manifest, readArtifact),
      pages: [],
    };
  }
  if (manifest.status !== 'awaiting-summary-review' && manifest.status !== 'publishing-knowledge') {
    throw new Error(`Repository ingestion is not in the summary-review publication lifecycle: ${manifest.status}`);
  }

  const closure = await readAndValidateClosure(input, manifest, readArtifact);
  let reviews: RepositoryModuleKnowledgeReview[];
  let publicationCreatedAt: string;

  if (manifest.status === 'awaiting-summary-review') {
    const reviewedAt = now();
    const retainedReviews = await readCurrentReviews(input, manifest, readArtifact);
    reviews = materializeReviewSet(input.reviews, closure, reviewedAt, retainedReviews);
    const reviewEventAt = latestTimestamp(
      manifest.updatedAt,
      ...reviews.map((review) => review.reviewedAt),
    );
    const runRoot = `.forexplore/ingestion/${manifest.id}`;
    const reviewArtifacts = reviews.map((review) => immutableJsonArtifact(
      review.id,
      'repository-module-knowledge-review',
      `${runRoot}/summary-reviews/${safeArtifactName(review.id)}.json`,
      review,
      review.reviewedAt,
    ));
    const decision = aggregateDecision(reviews);
    let reviewedManifest = recordRepositoryIngestionEvent(manifest, {
      type: 'module-knowledge-review-recorded',
      occurredAt: reviewEventAt,
      actor: reviewEventActor(reviews),
      idempotencyKey: `${manifest.id}:module-knowledge-reviews:${sha256Hex(canonicalJson(
        reviews.map((review) => review.contentHash),
      ))}`,
      ...(decision === 'accept' || decision === 'revise'
        ? { toStatus: decision === 'accept' ? 'publishing-knowledge' as const : 'summarizing-modules' as const }
        : {}),
      artifacts: { moduleKnowledgeReviews: reviewArtifacts.map((artifact) => artifact.ref) },
      details: {
        decisions: reviews.map((review) => ({ moduleId: review.moduleId, decision: review.decision })),
        publicationContext: {
          scope: {
            repositoryId: input.scope.repositoryId,
            channel: input.scope.channel,
          },
          repositoryScopes: canonicalRepositoryScopes(input.repositoryScopes),
        },
      },
      message: decision === 'accept'
        ? 'Recorded an explicit accepted summary review for every module and opened knowledge publication.'
        : decision === 'revise'
          ? 'Recorded module summary reviews; at least one module requires a replacement proposal.'
          : 'Recorded module summary reviews; at least one module was rejected.',
    });
    if (decision === 'reject') {
      reviewedManifest = transitionRepositoryIngestionManifest(reviewedManifest, {
        type: 'ingestion-superseded',
        occurredAt: reviewEventAt,
        actor: reviewEventActor(reviews),
        idempotencyKey: `${manifest.id}:summary-review-rejected:${sha256Hex(canonicalJson(
          reviews.map((review) => review.contentHash),
        ))}`,
        toStatus: 'superseded',
        message: 'A rejected module summary closed this ingestion without staging or activating knowledge.',
      });
    }
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId: manifest.id,
      artifacts: [
        ...reviewArtifacts.map((artifact) => artifact.stored),
        manifestCommitMarker(
          reviewedManifest,
          manifestPath,
          sha256Hex(serializeRepositoryIngestionManifest(manifest)),
        ),
      ],
    });
    manifest = reviewedManifest;
    publicationCreatedAt = reviewEventAt;
    if (decision !== 'accept') {
      return {
        outcome: decision === 'revise' ? 'revision-required' : 'rejected',
        manifest,
        manifestPath,
        reviews,
        pages: [],
      };
    }
  } else {
    reviews = await readCurrentReviews(input, manifest, readArtifact);
    validateAcceptedReviewSet(closure, reviews);
    assertReplaySubmissions(input.reviews, reviews);
    const reviewEvent = [...manifest.events].reverse().find((event) =>
      event.type === 'module-knowledge-review-recorded' && event.toStatus === 'publishing-knowledge'
    );
    if (reviewEvent === undefined) {
      throw new Error('Publishing knowledge manifest has no accepted summary-review transition.');
    }
    publicationCreatedAt = reviewEvent.occurredAt;
  }

  const pages = materializeReviewedPages(closure, reviews, publicationCreatedAt);
  const serialized = materializePublicationArtifacts(pages, publicationCreatedAt);
  const source = publicationSource(closure.bundle, pages, closure.evidenceBundles, closure.wikiProposals, reviews);
  const repositoryScopes = canonicalRepositoryScopes(input.repositoryScopes);
  assertPersistedPublicationContext(manifest, input.scope, repositoryScopes);
  const previous = await dependencies.publicationStore.read(input.repositoryRoot, input.scope);
  const stagedPublication = await dependencies.publicationStore.stage({
    repositoryRoot: input.repositoryRoot,
    scope: input.scope,
    repositoryScopes,
    source,
    artifacts: serialized.map(publicationArtifactInput),
    producer: knowledgePublisher,
    stagedAt: publicationCreatedAt,
  });
  const documents = pages.map((page) => materializeIndexedModuleKnowledgeDocument(
    page,
    closure.catalog,
    closure.ir,
    repositoryScopes,
    stagedPublication,
  ));
  assertIndependentModuleDocuments(documents, pages, input);

  const key = publicationKey(stagedPublication);
  let stagedStateForManifest = stagedPublication;
  let validatedReceipt: RepositoryModuleIndexReceipt;
  if (stagedPublication.status === 'active') {
    stagedStateForManifest = await readPublicationRevision(
      input,
      manifest,
      stagedPublication.id,
      'staged',
      readArtifact,
    );
    validatedReceipt = await readIndexReceiptRevision(
      input,
      manifest,
      stagedPublication.id,
      'validated',
      readArtifact,
    );
    assertReceiptMatches(validatedReceipt, stagedPublication, pages, ['validated']);
  } else {
    const stagedReceipt = await dependencies.indexPublisher.stage({
      publication: stagedPublication,
      repositoryScopes,
      documents,
    });
    assertReceiptMatches(stagedReceipt, stagedPublication, pages, ['staged', 'validated']);
    validatedReceipt = await dependencies.indexPublisher.validate(key);
    assertReceiptMatches(validatedReceipt, stagedPublication, pages, ['validated']);
  }

  const runRoot = `.forexplore/ingestion/${manifest.id}`;
  const stagedPublicationArtifact = publicationStateArtifact(runRoot, stagedStateForManifest);
  const validatedReceiptArtifact = indexReceiptStateArtifact(runRoot, validatedReceipt);
  const reviewedKnowledge = serialized.map((artifact) => relocateReviewedKnowledgeArtifact(
    artifact,
    runRoot,
    stagedPublication.payloadHash,
    stagedPublicationArtifact.ref.id,
    reviews.map((review) => review.id),
  ));
  const publicationEventKey = `${manifest.id}:knowledge-publication-staged:${stagedStateForManifest.contentHash}`;
  let stagedManifest = hasEvent(manifest, publicationEventKey)
    ? manifest
    : recordRepositoryIngestionEvent(manifest, {
      type: 'knowledge-publication-staged',
      occurredAt: stagedStateForManifest.stagedAt,
      actor: { kind: 'system', id: knowledgePublisher.id },
      idempotencyKey: publicationEventKey,
      details: {
        scope: {
          repositoryId: input.scope.repositoryId,
          channel: input.scope.channel,
        },
        repositoryScopes,
      },
      artifacts: {
        knowledgePublications: [stagedPublicationArtifact.ref],
        knowledge: reviewedKnowledge.map((artifact) => artifact.descriptor),
      },
      message: 'Persisted immutable reviewed JSON, Markdown, JSON Schema, and JSONL publication bytes.',
    });
  const receiptEventKey = `${manifest.id}:module-index-receipt:${validatedReceipt.contentHash}`;
  stagedManifest = hasEvent(stagedManifest, receiptEventKey)
    ? stagedManifest
    : recordRepositoryIngestionEvent(stagedManifest, {
      type: 'module-index-receipt-produced',
      occurredAt: latestTimestamp(stagedManifest.updatedAt, validatedReceipt.updatedAt),
      actor: { kind: 'adapter', id: validatedReceipt.storeId },
      idempotencyKey: receiptEventKey,
      artifacts: { moduleIndexReceipts: [validatedReceiptArtifact.ref] },
      message: 'The separate module index staged and validated one document per reviewed module.',
    });
  if (canonicalJson(stagedManifest) !== canonicalJson(manifest)) {
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId: manifest.id,
      artifacts: [
        ...reviewedKnowledge.map((artifact) => artifact.stored),
        stagedPublicationArtifact.stored,
        validatedReceiptArtifact.stored,
        manifestCommitMarker(
          stagedManifest,
          manifestPath,
          sha256Hex(serializeRepositoryIngestionManifest(manifest)),
        ),
      ],
    });
  }

  let localActivation:
    | Awaited<ReturnType<RepositoryKnowledgePublicationStore['activate']>>
    | undefined;
  let remoteHead: ModuleKnowledgeIndexHead | undefined;
  try {
    const activatedAt = latestTimestamp(now(), validatedReceipt.updatedAt, stagedManifest.updatedAt);
    localActivation = await dependencies.publicationStore.activate({
      repositoryRoot: input.repositoryRoot,
      scope: input.scope,
      publicationId: stagedPublication.id,
      indexReceipt: validatedReceipt,
      expectedHead: previous.head ?? null,
      activatedAt,
    });
    if (!localActivation.currentProjectionSynchronized) {
      const reconciled = await dependencies.publicationStore.reconcileCurrentProjection(
        input.repositoryRoot,
        input.scope,
      );
      if (!reconciled) throw new Error('Local knowledge head activated but its current projection is not synchronized.');
    }
    remoteHead = await dependencies.indexPublisher.activate(
      key,
      expectedRemoteGeneration(previous, stagedPublication),
    );
    assertRemoteHead(remoteHead, stagedPublication);

    const activePublicationArtifact = publicationStateArtifact(runRoot, localActivation.publication);
    const activeReceiptArtifact = indexReceiptStateArtifact(runRoot, localActivation.indexReceipt);
    const headArtifact = publicationHeadArtifact(runRoot, localActivation.head!);
    let readyManifest = recordRepositoryIngestionEvent(stagedManifest, {
      type: 'knowledge-publication-activated',
      occurredAt: activatedAt,
      actor: { kind: 'system', id: knowledgePublisher.id },
      idempotencyKey: `${manifest.id}:knowledge-publication-activated:${localActivation.head!.contentHash}`,
      artifacts: {
        knowledgePublications: [activePublicationArtifact.ref],
        moduleIndexReceipts: [activeReceiptArtifact.ref],
        publicationHeads: [headArtifact.ref],
      },
      message: 'Activated matching local and remote CAS heads for the reviewed module publication.',
    });
    readyManifest = transitionRepositoryIngestionManifest(readyManifest, {
      type: 'ingestion-completed',
      occurredAt: activatedAt,
      actor: { kind: 'system', id: knowledgePublisher.id },
      idempotencyKey: `${manifest.id}:knowledge-publication-ready:${localActivation.head!.contentHash}`,
      toStatus: 'ready',
      message: 'Completed ingestion only after review, immutable staging, index validation, and dual CAS activation.',
    });
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId: manifest.id,
      artifacts: [
        activePublicationArtifact.stored,
        activeReceiptArtifact.stored,
        headArtifact.stored,
        manifestCommitMarker(
          readyManifest,
          manifestPath,
          sha256Hex(serializeRepositoryIngestionManifest(stagedManifest)),
        ),
      ],
    });
    return {
      outcome: 'ready',
      manifest: readyManifest,
      manifestPath,
      reviews,
      pages,
      publication: localActivation.publication,
      indexReceipt: localActivation.indexReceipt,
      publicationHead: localActivation.head,
    };
  } catch (error) {
    if (localActivation?.head !== undefined) {
      const latestManifest = await loadManifest(input.repositoryRoot, input.ingestionId);
      if (
        latestManifest !== null &&
        await isReadyAtHead(input, latestManifest, localActivation.head, readArtifact)
      ) {
        return {
          outcome: 'reused',
          manifest: latestManifest,
          manifestPath,
          reviews,
          pages,
          publication: localActivation.publication,
          indexReceipt: localActivation.indexReceipt,
          publicationHead: localActivation.head,
        };
      }
      const compensationErrors: string[] = [];
      let withdrawal:
        | Awaited<ReturnType<RepositoryKnowledgePublicationStore['withdraw']>>
        | undefined;
      try {
        await dependencies.indexPublisher.withdraw(key, stagedPublication.generation);
      } catch (compensationError) {
        compensationErrors.push(`remote: ${errorMessage(compensationError)}`);
      }
      try {
        withdrawal = await dependencies.publicationStore.withdraw({
          repositoryRoot: input.repositoryRoot,
          scope: input.scope,
          publicationId: localActivation.publication.id,
          indexReceipt: localActivation.indexReceipt,
          expectedHead: localActivation.head,
          reason: `Compensating failed dual activation: ${errorMessage(error)}`,
          withdrawnAt: latestTimestamp(now(), localActivation.publication.activatedAt!),
        });
      } catch (compensationError) {
        compensationErrors.push(`local: ${errorMessage(compensationError)}`);
      }
      if (withdrawal !== undefined && latestManifest?.status === 'publishing-knowledge') {
        try {
          await persistCompensationLedger({
            input,
            manifest: latestManifest,
            manifestPath,
            withdrawal,
            cause: error,
            compensationErrors,
            persist,
            now,
          });
        } catch (compensationError) {
          compensationErrors.push(`ledger: ${errorMessage(compensationError)}`);
        }
      }
      const suffix = compensationErrors.length === 0
        ? ' Both activation heads were compensated.'
        : ` Compensation requires recovery (${compensationErrors.join('; ')}).`;
      throw new Error(`Knowledge publication activation failed: ${errorMessage(error)}.${suffix}`);
    }
    throw error;
  }
}

async function reuseReadyPublication(
  input: ReviewAndPublishRepositoryModuleKnowledgeInput,
  manifest: RepositoryIngestionManifest,
  manifestPath: string,
  dependencies: Pick<
    ReviewAndPublishRepositoryModuleKnowledgeDependencies,
    'publicationStore' | 'indexPublisher'
  >,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<ReviewAndPublishRepositoryModuleKnowledgeResult> {
  const current = selectCurrentRepositoryKnowledgePublicationArtifactRefs(manifest);
  if (
    current.publications.length !== 1 ||
    current.indexReceipts.length !== 1 ||
    current.publicationHeads.length !== 1
  ) {
    throw new Error('Ready repository ingestion lacks one exact active publication closure.');
  }
  const [publication, indexReceipt, publicationHead] = await Promise.all([
    readJsonArtifact<RepositoryKnowledgePublication>(input, current.publications[0]!, readArtifact),
    readJsonArtifact<RepositoryModuleIndexReceipt>(input, current.indexReceipts[0]!, readArtifact),
    readJsonArtifact<RepositoryKnowledgePublicationHead>(input, current.publicationHeads[0]!, readArtifact),
  ]);
  validateRepositoryKnowledgePublication(publication);
  validateRepositoryModuleIndexReceipt(indexReceipt);
  validateRepositoryKnowledgePublicationHead(publicationHead);
  const repositoryScopes = canonicalRepositoryScopes(input.repositoryScopes);
  if (
    publication.status !== 'active' ||
    indexReceipt.status !== 'active' ||
    canonicalJson(publication.scope) !== canonicalJson(input.scope) ||
    canonicalJson(publication.repositoryScopes) !== canonicalJson(repositoryScopes) ||
    publicationHead.publicationId !== publication.id ||
    publicationHead.publicationHash !== publication.contentHash ||
    publicationHead.generation !== publication.generation
  ) {
    throw new Error('Ready publication artifacts do not match the requested scope, ACL, or active state.');
  }
  const expectedModuleIds = publication.source.modules.map(({ moduleId }) => moduleId).sort();
  if (
    indexReceipt.publicationId !== publication.id ||
    indexReceipt.publicationPayloadHash !== publication.payloadHash ||
    indexReceipt.generation !== publication.generation ||
    canonicalJson(indexReceipt.scope) !== canonicalJson(publication.scope) ||
    indexReceipt.documentCount !== expectedModuleIds.length ||
    canonicalJson(indexReceipt.moduleIds) !== canonicalJson(expectedModuleIds)
  ) {
    throw new Error('Ready module-index receipt does not match the active publication.');
  }
  const local = await dependencies.publicationStore.read(input.repositoryRoot, input.scope);
  const localPublication = local.publications.find((candidate) => candidate.id === publication.id);
  if (
    localPublication === undefined ||
    localPublication.contentHash !== publication.contentHash ||
    local.head?.contentHash !== publicationHead.contentHash
  ) {
    throw new Error('Ready manifest has drifted from the local SQLite publication head.');
  }
  if (local.currentProjectionDirty && !await dependencies.publicationStore.reconcileCurrentProjection(
    input.repositoryRoot,
    input.scope,
  )) {
    throw new Error('Ready local publication head exists, but its current projection cannot be reconciled.');
  }
  const remoteHead = await dependencies.indexPublisher.readHead(input.scope);
  if (
    remoteHead === null ||
    remoteHead.publicationId !== publication.id ||
    remoteHead.publicationPayloadHash !== publication.payloadHash ||
    remoteHead.generation !== publication.generation
  ) {
    throw new Error('Ready manifest has drifted from the active module-index head.');
  }
  const reviews = await readCurrentReviews(input, manifest, readArtifact);
  assertReplaySubmissions(input.reviews, reviews);
  return {
    outcome: 'reused',
    manifest,
    manifestPath,
    reviews,
    pages: [],
    publication,
    indexReceipt,
    publicationHead,
  };
}

async function isReadyAtHead(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  head: RepositoryKnowledgePublicationHead,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<boolean> {
  if (manifest.status !== 'ready') return false;
  const current = selectCurrentRepositoryKnowledgePublicationArtifactRefs(manifest);
  for (const ref of current.publicationHeads) {
    const candidate = await readJsonArtifact<RepositoryKnowledgePublicationHead>(input, ref, readArtifact);
    if (
      candidate.contentHash === head.contentHash &&
      candidate.publicationId === head.publicationId &&
      candidate.generation === head.generation
    ) return true;
  }
  return false;
}

async function persistCompensationLedger(args: {
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>;
  manifest: RepositoryIngestionManifest;
  manifestPath: string;
  withdrawal: Awaited<ReturnType<RepositoryKnowledgePublicationStore['withdraw']>>;
  cause: unknown;
  compensationErrors: readonly string[];
  persist: (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>;
  now: () => string;
}): Promise<RepositoryIngestionManifest> {
  const runRoot = `.forexplore/ingestion/${args.manifest.id}`;
  const publicationArtifact = publicationStateArtifact(runRoot, args.withdrawal.publication);
  const receiptArtifact = indexReceiptStateArtifact(runRoot, args.withdrawal.indexReceipt);
  const headArtifact = args.withdrawal.head === undefined
    ? undefined
    : publicationHeadArtifact(runRoot, args.withdrawal.head);
  const occurredAt = latestTimestamp(
    args.manifest.updatedAt,
    args.withdrawal.publication.withdrawnAt!,
    args.now(),
  );
  const next = recordRepositoryIngestionEvent(args.manifest, {
    type: 'knowledge-publication-withdrawn',
    occurredAt,
    actor: { kind: 'system', id: knowledgePublisher.id },
    idempotencyKey: `${args.manifest.id}:knowledge-publication-withdrawn:${args.withdrawal.publication.contentHash}`,
    artifacts: {
      knowledgePublications: [publicationArtifact.ref],
      moduleIndexReceipts: [receiptArtifact.ref],
      ...(headArtifact === undefined ? {} : { publicationHeads: [headArtifact.ref] }),
    },
    details: {
      failure: errorMessage(args.cause),
      compensationErrors: [...args.compensationErrors],
      restoredPublicationId: args.withdrawal.restoredPublication?.id ?? null,
      restoredHeadHash: args.withdrawal.head?.contentHash ?? null,
    },
    message: 'Recorded compensating withdrawal after dual knowledge activation did not commit.',
  });
  await args.persist({
    repositoryRoot: args.input.repositoryRoot,
    ingestionId: args.input.ingestionId,
    artifacts: [
      publicationArtifact.stored,
      receiptArtifact.stored,
      ...(headArtifact === undefined ? [] : [headArtifact.stored]),
      manifestCommitMarker(
        next,
        args.manifestPath,
        sha256Hex(serializeRepositoryIngestionManifest(args.manifest)),
      ),
    ],
  });
  return next;
}

function validatePublicationInput(input: ReviewAndPublishRepositoryModuleKnowledgeInput): void {
  if (!input.repositoryRoot.trim()) throw new Error('Repository root is required.');
  if (!input.ingestionId.trim()) throw new Error('Repository ingestion ID is required.');
  if (!input.scope.repositoryId.trim() || !input.scope.channel.trim()) {
    throw new Error('Knowledge publication repository ID and channel are required.');
  }
  const scopes = input.repositoryScopes.map((scope) => scope.trim());
  if (scopes.some((scope) => !scope) || new Set(scopes).size !== scopes.length) {
    throw new Error('Repository scopes must be explicit, non-empty, and unique.');
  }
  if (!scopes.includes(input.scope.repositoryId)) {
    throw new Error('Repository scopes must explicitly contain the publication repository ID.');
  }
}

function canonicalRepositoryScopes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function assertPersistedPublicationContext(
  manifest: RepositoryIngestionManifest,
  scope: RepositoryKnowledgePublicationScope,
  repositoryScopes: string[],
): void {
  const event = [...manifest.events].reverse().find((candidate) =>
    candidate.type === 'knowledge-publication-staged' ||
    (candidate.type === 'module-knowledge-review-recorded' && candidate.toStatus === 'publishing-knowledge')
  );
  if (event === undefined) return;
  const update = isRecord(event.details) && isRecord(event.details.update)
    ? event.details.update
    : undefined;
  const context = update !== undefined && isRecord(update.publicationContext)
    ? update.publicationContext
    : update;
  if (
    context === undefined ||
    canonicalJson(context.scope) !== canonicalJson(scope) ||
    canonicalJson(context.repositoryScopes) !== canonicalJson(repositoryScopes)
  ) {
    throw new Error('Publishing replay scope or repository ACL conflicts with the persisted staged publication.');
  }
}

async function readAndValidateClosure(
  input: ReviewAndPublishRepositoryModuleKnowledgeInput,
  manifest: RepositoryIngestionManifest,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleKnowledgeClosure> {
  const irRef = requiredArtifact(manifest.artifacts.unifiedRepositoryIr, 'unified repository IR');
  const discoveryRef = requiredArtifact(manifest.artifacts.moduleDiscoveryProposal, 'module discovery proposal');
  const moduleReviewRef = requiredArtifact(manifest.artifacts.moduleReview, 'module boundary review');
  const catalogRef = requiredArtifact(manifest.artifacts.activeModuleCatalog, 'active module catalog');
  const bundleRef = requiredArtifact(manifest.artifacts.moduleBundle, 'repository module bundle');
  const currentSummary = selectCurrentRepositoryModuleSummaryArtifactRefs(manifest);
  const [ir, discoveryProposal, moduleReview, catalog, bundle, evidenceBundles, wikiProposals] = await Promise.all([
    readJsonArtifact<UnifiedRepositoryIR>(input, irRef, readArtifact),
    readJsonArtifact<ModuleDiscoveryProposal>(input, discoveryRef, readArtifact),
    readJsonArtifact<RepositoryModuleReview>(input, moduleReviewRef, readArtifact),
    readJsonArtifact<RepositoryModuleCatalog>(input, catalogRef, readArtifact),
    readJsonArtifact<RepositoryModuleBundle>(input, bundleRef, readArtifact),
    Promise.all(currentSummary.evidenceBundles.map((ref) =>
      readJsonArtifact<RepositoryModuleEvidenceBundle>(input, ref, readArtifact),
    )),
    Promise.all(currentSummary.wikiProposals.map((ref) =>
      readJsonArtifact<RepositoryModuleWikiProposal>(input, ref, readArtifact),
    )),
  ]);
  if (catalog.status !== 'active' || catalog.repositoryId !== manifest.repositoryId) {
    throw new Error('Summary review requires the active boundary-reviewed module catalog.');
  }
  validateRepositoryModuleBundle(bundle, {
    proposal: discoveryProposal,
    review: moduleReview,
    catalog,
    ir,
    knowledgePages: bundle.knowledgePages,
  });
  assertCompleteModuleSet(bundle.modules.map((module) => module.id), evidenceBundles.map((item) => item.moduleId), 'evidence bundle');
  assertCompleteModuleSet(bundle.modules.map((module) => module.id), wikiProposals.map((item) => item.moduleId), 'Wiki proposal');
  const evidenceByModule = new Map(evidenceBundles.map((bundleItem) => [bundleItem.moduleId, bundleItem]));
  for (const evidenceBundle of evidenceBundles) validateRepositoryModuleEvidenceBundle(evidenceBundle, bundle);
  const historicalProposals = await Promise.all(manifest.artifacts.moduleWikiProposals.map((ref) =>
    readJsonArtifact<RepositoryModuleWikiProposal>(input, ref, readArtifact),
  ));
  const historicalReviews = await Promise.all(manifest.artifacts.moduleKnowledgeReviews.map((ref) =>
    readJsonArtifact<RepositoryModuleKnowledgeReview>(input, ref, readArtifact),
  ));
  for (const proposal of wikiProposals) {
    if (proposal.revision === undefined) {
      validateRepositoryModuleWikiProposal(proposal, evidenceByModule.get(proposal.moduleId)!);
      continue;
    }
    const previousProposal = historicalProposals.find((candidate) =>
      candidate.id === proposal.revision!.previousProposalId &&
      candidate.contentHash === proposal.revision!.previousProposalHash
    );
    const reviseReview = historicalReviews.find((candidate) =>
      candidate.id === proposal.revision!.reviseReviewId &&
      candidate.contentHash === proposal.revision!.reviseReviewHash
    );
    if (previousProposal === undefined || reviseReview === undefined) {
      throw new Error(`Revised Wiki proposal lacks its immutable predecessor closure: ${proposal.moduleId}`);
    }
    validateRepositoryModuleWikiProposal(
      proposal,
      evidenceByModule.get(proposal.moduleId)!,
      { previousProposal, reviseReview },
    );
  }
  return { ir, discoveryProposal, moduleReview, catalog, bundle, evidenceBundles, wikiProposals };
}

function materializeReviewSet(
  submissions: readonly RepositoryModuleKnowledgeReviewSubmission[],
  closure: RepositoryModuleKnowledgeClosure,
  defaultReviewedAt: string,
  retainedReviews: readonly RepositoryModuleKnowledgeReview[],
): RepositoryModuleKnowledgeReview[] {
  const proposalByModule = new Map(closure.wikiProposals.map((proposal) => [proposal.moduleId, proposal]));
  const evidenceByModule = new Map(closure.evidenceBundles.map((bundle) => [bundle.moduleId, bundle]));
  const retained = retainedReviews.filter((review) => {
    const proposal = proposalByModule.get(review.moduleId);
    const evidence = evidenceByModule.get(review.moduleId);
    if (
      review.decision !== 'accept' || proposal === undefined || evidence === undefined ||
      review.wikiProposalId !== proposal.id || review.wikiProposalHash !== proposal.contentHash
    ) return false;
    validateRepositoryModuleKnowledgeReview(review, proposal, evidence);
    return true;
  });
  assertCompleteModuleSet(
    retained.map((review) => review.moduleId),
    retainedReviews.map((review) => review.moduleId),
    'carried accepted knowledge review',
  );
  const retainedModuleIds = new Set(retained.map((review) => review.moduleId));
  const pendingModuleIds = closure.bundle.modules
    .map((module) => module.id)
    .filter((moduleId) => !retainedModuleIds.has(moduleId));
  assertCompleteModuleSet(
    pendingModuleIds,
    submissions.map((submission) => submission.moduleId),
    'pending summary-review decision',
  );
  return [...retained, ...[...submissions]
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId))
    .map((submission) => materializeRepositoryModuleKnowledgeReview(
      proposalByModule.get(submission.moduleId)!,
      evidenceByModule.get(submission.moduleId)!,
      {
        decision: submission.decision,
        reviewerId: submission.reviewerId,
        ...(submission.comment === undefined ? {} : { comment: submission.comment }),
        reviewedAt: submission.reviewedAt ?? defaultReviewedAt,
      },
    ))].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function validateAcceptedReviewSet(
  closure: RepositoryModuleKnowledgeClosure,
  reviews: RepositoryModuleKnowledgeReview[],
): void {
  assertCompleteModuleSet(closure.bundle.modules.map((module) => module.id), reviews.map((review) => review.moduleId), 'knowledge review');
  const evidenceByModule = new Map(closure.evidenceBundles.map((bundle) => [bundle.moduleId, bundle]));
  const proposalByModule = new Map(closure.wikiProposals.map((proposal) => [proposal.moduleId, proposal]));
  for (const review of reviews) {
    validateRepositoryModuleKnowledgeReview(
      review,
      proposalByModule.get(review.moduleId)!,
      evidenceByModule.get(review.moduleId)!,
    );
    if (review.decision !== 'accept') {
      throw new Error('Publishing knowledge requires an accepted review for every current module.');
    }
  }
}

function materializeReviewedPages(
  closure: RepositoryModuleKnowledgeClosure,
  reviews: RepositoryModuleKnowledgeReview[],
  createdAt: string,
): RepositoryModuleKnowledgePage[] {
  validateAcceptedReviewSet(closure, reviews);
  const evidenceByModule = new Map(closure.evidenceBundles.map((bundle) => [bundle.moduleId, bundle]));
  const proposalByModule = new Map(closure.wikiProposals.map((proposal) => [proposal.moduleId, proposal]));
  const reviewByModule = new Map(reviews.map((review) => [review.moduleId, review]));
  return closure.bundle.modules.map((module) => materializeReviewedRepositoryModuleKnowledgePage({
    catalog: closure.catalog,
    ir: closure.ir,
    evidenceBundle: evidenceByModule.get(module.id)!,
    wikiProposal: proposalByModule.get(module.id)!,
    knowledgeReview: reviewByModule.get(module.id)!,
    producer: knowledgePublisher,
    createdAt,
  }));
}

function materializePublicationArtifacts(
  pages: RepositoryModuleKnowledgePage[],
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact[] {
  return [
    ...pages.flatMap(materializeRepositoryModuleKnowledgeArtifacts),
    materializeRepositoryModuleKnowledgeIndexArtifact(pages, knowledgePublisher, createdAt),
    materializeRepositoryModuleKnowledgeSchemaArtifact(knowledgePublisher, createdAt),
    materializeRepositoryModuleSummaryJsonSchemaArtifact(knowledgePublisher, createdAt),
    materializeRepositoryModuleKnowledgeJsonlArtifact(pages, knowledgePublisher, createdAt),
  ];
}

function publicationSource(
  bundle: RepositoryModuleBundle,
  pages: RepositoryModuleKnowledgePage[],
  evidenceBundles: RepositoryModuleEvidenceBundle[],
  proposals: RepositoryModuleWikiProposal[],
  reviews: RepositoryModuleKnowledgeReview[],
): RepositoryKnowledgePublication['source'] {
  const pageByModule = new Map(pages.map((page) => [page.moduleId, page]));
  const evidenceByModule = new Map(evidenceBundles.map((item) => [item.moduleId, item]));
  const proposalByModule = new Map(proposals.map((item) => [item.moduleId, item]));
  const reviewByModule = new Map(reviews.map((item) => [item.moduleId, item]));
  return {
    repositoryModuleBundleId: bundle.id,
    repositoryModuleBundleHash: bundle.contentHash,
    modules: bundle.modules.map((module) => {
      const evidence = evidenceByModule.get(module.id)!;
      const proposal = proposalByModule.get(module.id)!;
      const review = reviewByModule.get(module.id)!;
      const page = pageByModule.get(module.id)!;
      return {
        moduleId: module.id,
        evidenceBundleId: evidence.id,
        evidenceBundleHash: evidence.contentHash,
        wikiProposalId: proposal.id,
        wikiProposalHash: proposal.contentHash,
        knowledgeReviewId: review.id,
        knowledgeReviewHash: review.contentHash,
        knowledgePageId: page.id,
        knowledgePageHash: page.contentHash,
      };
    }),
  };
}

function publicationArtifactInput(artifact: SerializedRepositoryKnowledgeArtifact) {
  const artifactPath = artifact.descriptor.artifact.path;
  const prefix = '.forexplore/modules/';
  if (artifactPath === undefined || !artifactPath.startsWith(prefix)) {
    throw new Error(`Reviewed knowledge artifact has an unexpected path: ${artifact.descriptor.artifact.id}`);
  }
  return {
    id: artifact.descriptor.artifact.id,
    kind: artifact.descriptor.artifact.kind,
    relativePath: artifactPath.slice(prefix.length),
    mediaType: artifact.descriptor.artifact.mediaType ?? 'application/octet-stream',
    content: artifact.content,
    schemaVersion: artifact.descriptor.artifact.schemaVersion,
    createdAt: artifact.descriptor.artifact.createdAt,
  };
}

function relocateReviewedKnowledgeArtifact(
  artifact: SerializedRepositoryKnowledgeArtifact,
  runRoot: string,
  publicationPayloadHash: string,
  publicationArtifactId: string,
  reviewIds: readonly string[],
): { descriptor: RepositoryKnowledgeArtifact; stored: RepositoryIngestionStoredArtifact } {
  const sourcePath = artifact.descriptor.artifact.path;
  const prefix = '.forexplore/modules/';
  if (sourcePath === undefined || !sourcePath.startsWith(prefix)) {
    throw new Error(`Reviewed knowledge artifact has an unexpected path: ${artifact.descriptor.artifact.id}`);
  }
  const targetPath = `${runRoot}/reviewed-modules/${publicationPayloadHash}/${sourcePath.slice(prefix.length)}`;
  const ref: RepositoryIngestionArtifactRef = {
    ...artifact.descriptor.artifact,
    path: targetPath,
    byteLength: Buffer.byteLength(artifact.content, 'utf8'),
  };
  return {
    descriptor: {
      ...artifact.descriptor,
      artifact: ref,
      sourceArtifactIds: [...new Set([
        ...artifact.descriptor.sourceArtifactIds,
        ...reviewIds,
        publicationArtifactId,
      ])].sort(),
    },
    stored: { path: targetPath, content: artifact.content, mode: 'immutable' },
  };
}

function assertIndependentModuleDocuments(
  documents: IndexedModuleKnowledgeDocument[],
  pages: RepositoryModuleKnowledgePage[],
  input: ReviewAndPublishRepositoryModuleKnowledgeInput,
): void {
  assertCompleteModuleSet(pages.map((page) => page.moduleId), documents.map((document) => document.moduleId), 'module index document');
  for (const document of documents) {
    if (!document.repositoryScopes.includes(input.scope.repositoryId)) {
      throw new Error(`Module index document lacks its explicit repository scope: ${document.moduleId}`);
    }
  }
}

function assertReceiptMatches(
  receipt: RepositoryModuleIndexReceipt,
  publication: RepositoryKnowledgePublication,
  pages: RepositoryModuleKnowledgePage[],
  allowedStatuses: RepositoryModuleIndexReceipt['status'][],
): void {
  validateRepositoryModuleIndexReceipt(receipt);
  const moduleIds = pages.map((page) => page.moduleId).sort();
  if (
    !allowedStatuses.includes(receipt.status) ||
    receipt.publicationId !== publication.id ||
    receipt.publicationPayloadHash !== publication.payloadHash ||
    receipt.generation !== publication.generation ||
    canonicalJson(receipt.scope) !== canonicalJson(publication.scope) ||
    receipt.documentCount !== moduleIds.length ||
    canonicalJson(receipt.moduleIds) !== canonicalJson(moduleIds)
  ) {
    throw new Error('Module index receipt does not match the staged repository knowledge publication.');
  }
}

function assertRemoteHead(
  head: ModuleKnowledgeIndexHead,
  publication: RepositoryKnowledgePublication,
): void {
  if (
    head.repositoryId !== publication.scope.repositoryId ||
    head.channel !== publication.scope.channel ||
    head.publicationId !== publication.id ||
    head.publicationPayloadHash !== publication.payloadHash ||
    head.generation !== publication.generation
  ) {
    throw new Error('Remote module index activated a different publication head.');
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

function expectedRemoteGeneration(
  snapshot: Awaited<ReturnType<RepositoryKnowledgePublicationStore['read']>>,
  publication: RepositoryKnowledgePublication,
): number | null {
  if (publication.status !== 'active') return snapshot.head?.generation ?? null;
  if (publication.previousPublicationId === undefined) return null;
  const predecessor = snapshot.publications.find((candidate) =>
    candidate.id === publication.previousPublicationId
  );
  if (predecessor === undefined) {
    throw new Error('Active publication replay lacks its predecessor generation.');
  }
  return predecessor.generation;
}

function publicationStateArtifact(
  runRoot: string,
  publication: RepositoryKnowledgePublication,
) {
  return immutableJsonArtifact(
    `${publication.id}:${publication.status}:${publication.contentHash.slice(0, 16)}`,
    'repository-knowledge-publication',
    `${runRoot}/knowledge-publications/${safeArtifactName(`${publication.id}:${publication.status}:${publication.contentHash}`)}.json`,
    publication,
    publication.status === 'staged' ? publication.stagedAt : publication.activatedAt!,
  );
}

function indexReceiptStateArtifact(
  runRoot: string,
  receipt: RepositoryModuleIndexReceipt,
) {
  return immutableJsonArtifact(
    `${receipt.id}:${receipt.status}:${receipt.contentHash.slice(0, 16)}`,
    'repository-module-index-receipt',
    `${runRoot}/module-index-receipts/${safeArtifactName(`${receipt.id}:${receipt.status}:${receipt.contentHash}`)}.json`,
    receipt,
    receipt.updatedAt,
  );
}

function publicationHeadArtifact(
  runRoot: string,
  head: RepositoryKnowledgePublicationHead,
) {
  return immutableJsonArtifact(
    `repository-knowledge-publication-head:${head.scope.repositoryId}:${head.scope.channel}:${head.contentHash.slice(0, 16)}`,
    'repository-knowledge-publication-head',
    `${runRoot}/publication-heads/${safeArtifactName(head.contentHash)}.json`,
    head,
    head.updatedAt,
  );
}

async function readCurrentReviews(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleKnowledgeReview[]> {
  const current = selectCurrentRepositoryModuleSummaryArtifactRefs(manifest);
  return Promise.all(current.knowledgeReviews.map((ref) =>
    readJsonArtifact<RepositoryModuleKnowledgeReview>(input, ref, readArtifact),
  ));
}

async function readLatestRecordedReviews(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleKnowledgeReview[]> {
  const event = [...manifest.events].reverse().find((candidate) =>
    candidate.type === 'module-knowledge-review-recorded'
  );
  return readReviewRefs(
    input,
    (event?.artifactRefs ?? []).filter((ref) => ref.kind === 'repository-module-knowledge-review'),
    readArtifact,
  );
}

async function readReviewRefs(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  refs: readonly RepositoryIngestionArtifactRef[],
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleKnowledgeReview[]> {
  return Promise.all(refs.map((ref) =>
    readJsonArtifact<RepositoryModuleKnowledgeReview>(input, ref, readArtifact),
  ));
}

async function readPublicationRevision(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  publicationId: string,
  status: RepositoryKnowledgePublication['status'],
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryKnowledgePublication> {
  for (const ref of manifest.artifacts.knowledgePublications) {
    const revision = await readJsonArtifact<RepositoryKnowledgePublication>(input, ref, readArtifact);
    if (revision.id === publicationId && revision.status === status) return revision;
  }
  throw new Error(`Publishing replay lacks the ${status} publication revision: ${publicationId}`);
}

async function readIndexReceiptRevision(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  publicationId: string,
  status: RepositoryModuleIndexReceipt['status'],
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleIndexReceipt> {
  for (const ref of manifest.artifacts.moduleIndexReceipts) {
    const revision = await readJsonArtifact<RepositoryModuleIndexReceipt>(input, ref, readArtifact);
    if (revision.publicationId === publicationId && revision.status === status) return revision;
  }
  throw new Error(`Publishing replay lacks the ${status} module-index receipt: ${publicationId}`);
}

function assertReplaySubmissions(
  submissions: readonly RepositoryModuleKnowledgeReviewSubmission[],
  reviews: readonly RepositoryModuleKnowledgeReview[],
): void {
  if (submissions.length === 0) return;
  assertCompleteModuleSet(reviews.map((review) => review.moduleId), submissions.map((item) => item.moduleId), 'replayed summary-review decision');
  const reviewByModule = new Map(reviews.map((review) => [review.moduleId, review]));
  for (const submission of submissions) {
    const review = reviewByModule.get(submission.moduleId)!;
    if (
      submission.decision !== review.decision ||
      submission.reviewerId.trim() !== review.reviewerId ||
      (submission.comment?.trim() ?? undefined) !== review.comment ||
      (submission.reviewedAt !== undefined && submission.reviewedAt !== review.reviewedAt)
    ) {
      throw new Error(`Replayed summary review conflicts with the persisted decision: ${submission.moduleId}`);
    }
  }
}

function aggregateDecision(reviews: readonly RepositoryModuleKnowledgeReview[]): RepositoryModuleKnowledgeReviewDecision {
  if (reviews.some((review) => review.decision === 'reject')) return 'reject';
  if (reviews.some((review) => review.decision === 'revise')) return 'revise';
  return 'accept';
}

function reviewEventActor(reviews: readonly RepositoryModuleKnowledgeReview[]) {
  const reviewerIds = [...new Set(reviews.map((review) => review.reviewerId))];
  return reviewerIds.length === 1
    ? { kind: 'human' as const, id: reviewerIds[0]! }
    : { kind: 'system' as const, id: knowledgePublisher.id };
}

function assertCompleteModuleSet(expected: string[], actual: string[], label: string): void {
  const canonicalExpected = [...new Set(expected)].sort();
  const canonicalActual = [...new Set(actual)].sort();
  if (
    actual.length !== canonicalActual.length ||
    canonicalJson(canonicalActual) !== canonicalJson(canonicalExpected)
  ) {
    throw new Error(`Repository ingestion requires exactly one ${label} per current module.`);
  }
}

async function readJsonArtifact<T>(
  input: Pick<ReviewAndPublishRepositoryModuleKnowledgeInput, 'repositoryRoot' | 'ingestionId'>,
  artifact: RepositoryIngestionArtifactRef,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<T> {
  const content = await readArtifact(input.repositoryRoot, input.ingestionId, artifact);
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`Repository ingestion artifact is invalid JSON: ${artifact.id}`);
  }
}

function requiredArtifact<T>(artifact: T | undefined, label: string): T {
  if (artifact === undefined) throw new Error(`Repository ingestion lacks ${label}.`);
  return artifact;
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

function manifestCommitMarker(
  manifest: RepositoryIngestionManifest,
  manifestPath: string,
  expectedContentHash: string,
): RepositoryIngestionStoredArtifact {
  return {
    path: manifestPath,
    content: serializeRepositoryIngestionManifest(manifest),
    mode: 'manifest',
    expectedContentHash,
  };
}

function safeArtifactName(value: string): string {
  return `${value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}-${sha256Hex(value).slice(0, 12)}`;
}

function latestTimestamp(...timestamps: string[]): string {
  for (const timestamp of timestamps) {
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error('Knowledge publication timestamp is invalid.');
  }
  return [...timestamps].sort().at(-1)!;
}

function hasEvent(manifest: RepositoryIngestionManifest, idempotencyKey: string): boolean {
  return manifest.events.some((event) => event.idempotencyKey === idempotencyKey);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
