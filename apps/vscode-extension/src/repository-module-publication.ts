import type {
  ModuleDiscoveryProposal,
  RepositoryArtifactProducer,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionManifest,
  RepositoryModuleBundle,
  RepositoryModuleCatalog,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleKnowledgePage,
  RepositoryModuleReview,
  SerializedRepositoryKnowledgeArtifact,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  applyRepositoryModuleReview,
  canonicalJson,
  materializeRepositoryModuleEvidenceBundle,
  materializeRepositoryModuleBundle,
  materializeRepositoryModuleKnowledgeArtifacts,
  materializeRepositoryModuleKnowledgePage,
  materializeRepositoryModuleReview,
  recordRepositoryIngestionEvent,
  serializeRepositoryIngestionManifest,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
} from '@forexplore/workflow-core';
import {
  persistRepositoryIngestionArtifacts,
  readRepositoryIngestionArtifactContent,
  readRepositoryIngestionManifest,
  repositoryIngestionManifestPath,
  verifyRepositoryIngestionStoredArtifacts,
  type PersistRepositoryIngestionArtifactsRequest,
  type RepositoryIngestionStoredArtifact,
} from './repository-ingestion-store';
import { collectRepositoryModuleEvidence } from './repository-module-evidence';

export const repositoryModulePublicationVersion = '1.0.0';

const publicationProducer: RepositoryArtifactProducer = {
  kind: 'ingestion-host',
  id: 'forexplore-vscode/repository-module-publication',
  version: repositoryModulePublicationVersion,
};

export interface ReviewRepositoryModulePublicationInput {
  repositoryRoot: string;
  ingestionId: string;
  decision: RepositoryModuleReview['decision'];
  reviewerId: string;
  comment?: string;
  acceptedRiskIds?: string[];
}

export interface ReviewRepositoryModulePublicationDependencies {
  loadManifest?: (
    repositoryRoot: string,
    ingestionId: string,
  ) => Promise<RepositoryIngestionManifest | null>;
  readArtifact?: typeof readRepositoryIngestionArtifactContent;
  verifyStoredArtifacts?: typeof verifyRepositoryIngestionStoredArtifacts;
  persist?: (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>;
  now?: () => string;
}

export interface RepositoryModulePublicationResult {
  outcome: 'summarizing-modules' | 'revision-required' | 'rejected';
  review: RepositoryModuleReview;
  manifest: RepositoryIngestionManifest;
  manifestPath: string;
  catalog?: RepositoryModuleCatalog;
  knowledgePages?: RepositoryModuleKnowledgePage[];
  bundle?: RepositoryModuleBundle;
  evidenceBundles?: RepositoryModuleEvidenceBundle[];
}

/**
 * Apply the explicit human decision to an already committed draft ingestion.
 * The Agent never enters this function. Accepted publication appends an active
 * catalog, factual Bundle, and bounded Summary-Agent inputs, then advances the
 * manifest only to `summarizing-modules`. Generated Wiki prose has its own
 * later human gate and cannot be smuggled through boundary acceptance;
 * revise/reject preserve the decision and close the old proposal without
 * inventing a replacement.
 */
export async function reviewRepositoryModulePublication(
  input: ReviewRepositoryModulePublicationInput,
  dependencies: ReviewRepositoryModulePublicationDependencies = {},
): Promise<RepositoryModulePublicationResult> {
  const loadManifest = dependencies.loadManifest ?? readRepositoryIngestionManifest;
  const readArtifact = dependencies.readArtifact ?? readRepositoryIngestionArtifactContent;
  const verifyStored = dependencies.verifyStoredArtifacts ?? verifyRepositoryIngestionStoredArtifacts;
  const persist = dependencies.persist ?? persistRepositoryIngestionArtifacts;
  const manifest = await loadManifest(input.repositoryRoot, input.ingestionId);
  if (manifest === null) throw new Error(`Repository ingestion does not exist: ${input.ingestionId}`);
  validateRepositoryIngestionManifest(manifest);
  if (manifest.status !== 'awaiting-module-review') {
    throw new Error(`Repository ingestion is not awaiting module review: ${manifest.status}`);
  }
  await verifyStored(input.repositoryRoot, manifest);
  const irRef = requiredArtifact(manifest.artifacts.unifiedRepositoryIr, 'unified repository IR');
  const proposalRef = requiredArtifact(
    manifest.artifacts.moduleDiscoveryProposal,
    'module discovery proposal',
  );
  const draftRef = requiredArtifact(manifest.artifacts.moduleCatalog, 'draft module catalog');
  const [ir, proposal, draft, discoveredPages] = await Promise.all([
    readJsonArtifact<UnifiedRepositoryIR>(input, irRef, readArtifact),
    readJsonArtifact<ModuleDiscoveryProposal>(input, proposalRef, readArtifact),
    readJsonArtifact<RepositoryModuleCatalog>(input, draftRef, readArtifact),
    readDiscoveredKnowledgePages(input, manifest, readArtifact),
  ]);
  if (draft.status !== 'draft') {
    throw new Error('Repository module publication requires the committed draft catalog.');
  }

  const decidedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const review = materializeRepositoryModuleReview(proposal, ir, {
    decision: input.decision,
    reviewerId: input.reviewerId,
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.acceptedRiskIds === undefined ? {} : { acceptedRiskIds: input.acceptedRiskIds }),
    decidedAt,
  });
  const application = applyRepositoryModuleReview(draft, proposal, ir, review);
  const runRoot = `.forexplore/ingestion/${manifest.id}`;
  const reviewArtifact = immutableJsonArtifact(
    review.id,
    'module-review',
    `${runRoot}/reviews/${review.id.replaceAll(':', '_')}.json`,
    review,
    decidedAt,
  );
  let nextManifest = recordRepositoryIngestionEvent(manifest, {
    type: 'module-review-recorded',
    occurredAt: decidedAt,
    actor: { kind: 'human', id: review.reviewerId },
    idempotencyKey: `${manifest.id}:module-review:${review.contentHash}`,
    artifacts: { moduleReview: reviewArtifact.ref },
    details: {
      decision: review.decision,
      replacementProposalRequired: review.replacementProposalRequired,
    },
    message: `Recorded explicit human module review decision: ${review.decision}.`,
  });
  const previousManifestHash = sha256Hex(serializeRepositoryIngestionManifest(manifest));
  const manifestPath = repositoryIngestionManifestPath(manifest.id);

  if (application.catalog === undefined) {
    nextManifest = transitionRepositoryIngestionManifest(nextManifest, {
      type: 'ingestion-superseded',
      occurredAt: decidedAt,
      actor: { kind: 'human', id: review.reviewerId },
      idempotencyKey: `${manifest.id}:review-closed:${review.contentHash}`,
      toStatus: 'superseded',
      message: review.decision === 'revise'
        ? 'The draft proposal requires a successor proposal and was not published.'
        : 'The draft proposal was rejected and was not published.',
    });
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId: manifest.id,
      artifacts: [
        reviewArtifact.stored,
        manifestCommitMarker(nextManifest, manifestPath, previousManifestHash),
      ],
    });
    return {
      outcome: review.decision === 'revise' ? 'revision-required' : 'rejected',
      review,
      manifest: nextManifest,
      manifestPath,
    };
  }

  const activeCatalog = application.catalog;
  const activeCatalogArtifact = immutableJsonArtifact(
    activeCatalog.id,
    'module-catalog',
    `${runRoot}/active-module-catalog.json`,
    activeCatalog,
    decidedAt,
  );
  nextManifest = recordRepositoryIngestionEvent(nextManifest, {
    type: 'module-catalog-produced',
    occurredAt: decidedAt,
    actor: { kind: 'system', id: publicationProducer.id },
    idempotencyKey: `${manifest.id}:active-module-catalog:${activeCatalog.contentHash}`,
    artifacts: { activeModuleCatalog: activeCatalogArtifact.ref },
    message: 'Materialized the active catalog from the exact accepted proposal and review.',
  });

  const wikiByModule = new Map(discoveredPages.map((page) => [page.moduleId, page.wiki]));
  const acceptedBoundaryPages = activeCatalog.modules.map((module) => {
    const wiki = wikiByModule.get(module.id);
    if (!wiki) throw new Error(`Draft ingestion lacks a knowledge page for module ${module.id}.`);
    return materializeRepositoryModuleKnowledgePage({
      catalog: activeCatalog,
      ir,
      moduleId: module.id,
      wiki,
      // Boundary acceptance does not turn generated draft prose into a human
      // reviewed narrative. It remains generated input until the independent
      // Summary Agent and knowledge-review gate complete.
      producer: proposal.producer,
      createdAt: decidedAt,
    });
  });
  const acceptedBoundaryKnowledge = acceptedBoundaryPages
    .flatMap(materializeRepositoryModuleKnowledgeArtifacts)
    .map((artifact) => relocateAcceptedBoundaryKnowledgeArtifact(artifact, runRoot));
  nextManifest = recordRepositoryIngestionEvent(nextManifest, {
    type: 'knowledge-artifact-produced',
    occurredAt: decidedAt,
    actor: { kind: 'system', id: publicationProducer.id },
    idempotencyKey: `${manifest.id}:accepted-boundary-knowledge:${review.contentHash}`,
    artifacts: { knowledge: acceptedBoundaryKnowledge.map((artifact) => artifact.descriptor) },
    message: 'Materialized reviewed boundary facts while retaining generated narrative trust.',
  });

  const bundle = materializeRepositoryModuleBundle({
    proposal,
    review,
    catalog: activeCatalog,
    ir,
    knowledgePages: acceptedBoundaryPages,
    producer: publicationProducer,
    createdAt: decidedAt,
  });
  const bundleArtifact = immutableJsonArtifact(
    bundle.id,
    'repository-module-bundle',
    `${runRoot}/repository-module-bundle.json`,
    bundle,
    decidedAt,
  );
  nextManifest = transitionRepositoryIngestionManifest(nextManifest, {
    type: 'module-bundle-produced',
    occurredAt: decidedAt,
    actor: { kind: 'system', id: publicationProducer.id },
    idempotencyKey: `${manifest.id}:repository-module-bundle:${bundle.contentHash}`,
    toStatus: 'summarizing-modules',
    artifacts: { moduleBundle: bundleArtifact.ref },
    message: 'Published reviewed boundary facts and opened the independent Summary Agent stage.',
  });

  const evidenceBundles = await Promise.all(bundle.modules.map(async (module) => {
    const evidence = await collectRepositoryModuleEvidence({
      repositoryRoot: input.repositoryRoot,
      bundle,
      moduleId: module.id,
    });
    return materializeRepositoryModuleEvidenceBundle({
      repositoryModuleBundle: bundle,
      moduleId: module.id,
      items: evidence.items,
      omissions: evidence.omissions,
      producer: publicationProducer,
      createdAt: decidedAt,
    });
  }));
  const evidenceArtifacts = evidenceBundles.map((evidenceBundle) => immutableJsonArtifact(
    evidenceBundle.id,
    'repository-module-evidence-bundle',
    `${runRoot}/summary-inputs/${safeArtifactName(evidenceBundle.id)}.json`,
    evidenceBundle,
    decidedAt,
  ));
  nextManifest = recordRepositoryIngestionEvent(nextManifest, {
    type: 'module-evidence-bundle-produced',
    occurredAt: decidedAt,
    actor: { kind: 'system', id: publicationProducer.id },
    idempotencyKey: `${manifest.id}:module-evidence-bundles:${sha256Hex(canonicalJson(
      evidenceBundles.map((item) => item.contentHash),
    ))}`,
    artifacts: { moduleEvidenceBundles: evidenceArtifacts.map((artifact) => artifact.ref) },
    message: 'Materialized bounded, immutable inputs for the independent Summary Agent.',
  });

  await persist({
    repositoryRoot: input.repositoryRoot,
    ingestionId: manifest.id,
    artifacts: [
      reviewArtifact.stored,
      activeCatalogArtifact.stored,
      ...acceptedBoundaryKnowledge.map((artifact) => ({
        path: artifact.descriptor.artifact.path!,
        content: artifact.content,
        mode: 'immutable' as const,
      })),
      bundleArtifact.stored,
      ...evidenceArtifacts.map((artifact) => artifact.stored),
      manifestCommitMarker(nextManifest, manifestPath, previousManifestHash),
    ],
  });
  return {
    outcome: 'summarizing-modules',
    review,
    manifest: nextManifest,
    manifestPath,
    catalog: activeCatalog,
    knowledgePages: acceptedBoundaryPages,
    bundle,
    evidenceBundles,
  };
}

async function readDiscoveredKnowledgePages(
  input: Pick<ReviewRepositoryModulePublicationInput, 'repositoryRoot' | 'ingestionId'>,
  manifest: RepositoryIngestionManifest,
  readArtifact: typeof readRepositoryIngestionArtifactContent,
): Promise<RepositoryModuleKnowledgePage[]> {
  const pageRefs = manifest.artifacts.knowledge
    .filter((knowledge) =>
      knowledge.format === 'json' &&
      knowledge.artifact.kind === 'repository-wiki' &&
      knowledge.artifact.path?.endsWith('/summary.json'),
    )
    .map((knowledge) => knowledge.artifact);
  if (pageRefs.length === 0) throw new Error('Draft ingestion has no module knowledge pages.');
  return Promise.all(pageRefs.map((ref) =>
    readJsonArtifact<RepositoryModuleKnowledgePage>(input, ref, readArtifact),
  ));
}

async function readJsonArtifact<T>(
  input: Pick<ReviewRepositoryModulePublicationInput, 'repositoryRoot' | 'ingestionId'>,
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

function requiredArtifact(
  artifact: RepositoryIngestionArtifactRef | undefined,
  label: string,
): RepositoryIngestionArtifactRef {
  if (!artifact) throw new Error(`Repository ingestion lacks ${label}.`);
  return artifact;
}

function relocateAcceptedBoundaryKnowledgeArtifact(
  artifact: SerializedRepositoryKnowledgeArtifact,
  runRoot: string,
): SerializedRepositoryKnowledgeArtifact {
  const original = artifact.descriptor.artifact.path;
  if (!original?.startsWith('.forexplore/modules/')) {
    throw new Error('Repository module knowledge artifact uses an unexpected path.');
  }
  return {
    ...artifact,
    descriptor: {
      ...artifact.descriptor,
      artifact: {
        ...artifact.descriptor.artifact,
        path: `${runRoot}/accepted-boundary-modules/${original.slice('.forexplore/modules/'.length)}`,
      },
    },
  };
}

function safeArtifactName(value: string): string {
  return `${value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}-${sha256Hex(value).slice(0, 12)}`;
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
