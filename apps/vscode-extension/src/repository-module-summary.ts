import type {
  RepositoryIngestionArtifactRef,
  RepositoryIngestionManifest,
  RepositoryModuleBundle,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleKnowledgeReview,
  RepositoryModuleWikiProposal,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  canonicalJson,
  serializeRepositoryIngestionManifest,
  selectCurrentRepositoryModuleSummaryArtifactRefs,
  selectRepositoryModuleSummaryRevisionArtifactRefs,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
  validateRepositoryModuleEvidenceBundle,
  validateRepositoryModuleKnowledgeReview,
  validateRepositoryModuleSummaryRevisionContext,
  validateRepositoryModuleWikiProposal,
} from '@forexplore/workflow-core';
import type { RepositoryModuleSummaryRequest } from './module-summary-client';
import {
  persistRepositoryIngestionArtifacts,
  readRepositoryIngestionArtifactContent,
  readRepositoryIngestionManifest,
  repositoryIngestionManifestPath,
  verifyRepositoryIngestionStoredArtifacts,
  type PersistRepositoryIngestionArtifactsRequest,
  type RepositoryIngestionStoredArtifact,
} from './repository-ingestion-store';

export const repositoryModuleSummaryCoordinatorVersion = '1.1.0';
export const repositoryModuleSummaryConcurrency = 4;

export interface GenerateRepositoryModuleSummariesInput {
  repositoryRoot: string;
  ingestionId: string;
}

export interface GenerateRepositoryModuleSummariesDependencies {
  summarizeModule(request: RepositoryModuleSummaryRequest): Promise<RepositoryModuleWikiProposal>;
  loadManifest?: (
    repositoryRoot: string,
    ingestionId: string,
  ) => Promise<RepositoryIngestionManifest | null>;
  readArtifact?: typeof readRepositoryIngestionArtifactContent;
  verifyStoredArtifacts?: typeof verifyRepositoryIngestionStoredArtifacts;
  persist?: (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>;
  now?: () => string;
}

export interface GenerateRepositoryModuleSummariesResult {
  manifest: RepositoryIngestionManifest;
  manifestPath: string;
  repositoryModuleBundle: RepositoryModuleBundle;
  evidenceBundles: RepositoryModuleEvidenceBundle[];
  wikiProposals: RepositoryModuleWikiProposal[];
  reused: boolean;
}

/**
 * Runs the independent Summary Agent over every bounded EvidenceBundle. The
 * coordinator persists only generated proposals and stops at the second human
 * gate; it cannot infer review or publication from model success.
 */
export async function generateRepositoryModuleSummaries(
  input: GenerateRepositoryModuleSummariesInput,
  dependencies: GenerateRepositoryModuleSummariesDependencies,
): Promise<GenerateRepositoryModuleSummariesResult> {
  const loadManifest = dependencies.loadManifest ?? readRepositoryIngestionManifest;
  const readArtifact = dependencies.readArtifact ?? readRepositoryIngestionArtifactContent;
  const verifyStored = dependencies.verifyStoredArtifacts ?? verifyRepositoryIngestionStoredArtifacts;
  const persist = dependencies.persist ?? persistRepositoryIngestionArtifacts;
  const manifest = await loadManifest(input.repositoryRoot, input.ingestionId);
  if (!manifest) throw new Error(`Repository ingestion does not exist: ${input.ingestionId}`);
  validateRepositoryIngestionManifest(manifest);
  if (manifest.status !== 'summarizing-modules' && manifest.status !== 'awaiting-summary-review') {
    throw new Error(`Repository ingestion is not in the Summary Agent lifecycle: ${manifest.status}`);
  }
  await verifyStored(input.repositoryRoot, manifest);
  const moduleBundleRef = requiredArtifact(manifest.artifacts.moduleBundle, 'repository module bundle');
  const repositoryModuleBundle = await readJsonArtifact<RepositoryModuleBundle>(
    input,
    moduleBundleRef,
    readArtifact,
  );
  const currentRefs = selectCurrentRepositoryModuleSummaryArtifactRefs(manifest);
  const evidenceBundles = await Promise.all(currentRefs.evidenceBundles.map((ref) =>
    readJsonArtifact<RepositoryModuleEvidenceBundle>(input, ref, readArtifact),
  ));
  assertCompleteModuleSet(
    repositoryModuleBundle.modules.map((module) => module.id),
    evidenceBundles.map((bundle) => bundle.moduleId),
    'evidence bundle',
  );
  for (const evidenceBundle of evidenceBundles) {
    validateRepositoryModuleEvidenceBundle(evidenceBundle, repositoryModuleBundle);
  }

  if (manifest.status === 'awaiting-summary-review') {
    const wikiProposals = await Promise.all(currentRefs.wikiProposals.map((ref) =>
      readJsonArtifact<RepositoryModuleWikiProposal>(input, ref, readArtifact),
    ));
    validateProposalSet(repositoryModuleBundle, evidenceBundles, wikiProposals);
    return {
      manifest,
      manifestPath: repositoryIngestionManifestPath(manifest.id),
      repositoryModuleBundle,
      evidenceBundles,
      wikiProposals,
      reused: true,
    };
  }

  const revisionRefs = selectRepositoryModuleSummaryRevisionArtifactRefs(manifest);
  const [previousProposals, priorKnowledgeReviews] = await Promise.all([
    Promise.all(revisionRefs.previousWikiProposals.map((ref) =>
      readJsonArtifact<RepositoryModuleWikiProposal>(input, ref, readArtifact),
    )),
    Promise.all(revisionRefs.priorKnowledgeReviews.map((ref) =>
      readJsonArtifact<RepositoryModuleKnowledgeReview>(input, ref, readArtifact),
    )),
  ]);
  const isRevision = previousProposals.length > 0 || priorKnowledgeReviews.length > 0;
  if (isRevision) {
    assertCompleteModuleSet(
      repositoryModuleBundle.modules.map((module) => module.id),
      previousProposals.map((proposal) => proposal.moduleId),
      'previous Wiki proposal',
    );
    assertCompleteModuleSet(
      repositoryModuleBundle.modules.map((module) => module.id),
      priorKnowledgeReviews.map((review) => review.moduleId),
      'prior knowledge review',
    );
  }
  const evidenceByModule = new Map(evidenceBundles.map((bundle) => [bundle.moduleId, bundle]));
  const previousByModule = new Map(previousProposals.map((proposal) => [proposal.moduleId, proposal]));
  const priorReviewByModule = new Map(priorKnowledgeReviews.map((review) => [review.moduleId, review]));
  if (isRevision) {
    for (const module of repositoryModuleBundle.modules) {
      const evidenceBundle = evidenceByModule.get(module.id)!;
      const previousProposal = previousByModule.get(module.id)!;
      const review = priorReviewByModule.get(module.id)!;
      validateRepositoryModuleKnowledgeReview(review, previousProposal, evidenceBundle);
      if (review.decision === 'reject') {
        throw new Error('A rejected module summary cannot enter the revision lifecycle.');
      }
      if (review.decision === 'revise') {
        validateRepositoryModuleSummaryRevisionContext(evidenceBundle, {
          previousProposal,
          reviseReview: review,
        });
      }
    }
  }
  const wikiProposals = await mapWithConcurrency(
    repositoryModuleBundle.modules,
    repositoryModuleSummaryConcurrency,
    async (module) => {
      const evidenceBundle = evidenceByModule.get(module.id)!;
      const previousProposal = previousByModule.get(module.id);
      const priorReview = priorReviewByModule.get(module.id);
      if (isRevision && priorReview?.decision === 'accept') {
        return previousProposal!;
      }
      const revisionContext = !isRevision
        ? undefined
        : {
            previousProposal: previousProposal!,
            reviseReview: priorReview!,
          };
      const proposal = await dependencies.summarizeModule({
        repositoryModuleBundle,
        evidenceBundle,
        ...(revisionContext ?? {}),
      });
      validateRepositoryModuleWikiProposal(proposal, evidenceBundle, revisionContext);
      return proposal;
    },
  );
  validateProposalSet(repositoryModuleBundle, evidenceBundles, wikiProposals);
  const occurredAt = latestTimestamp([
    manifest.updatedAt,
    (dependencies.now ?? (() => new Date().toISOString()))(),
    ...wikiProposals.map((proposal) => proposal.createdAt),
  ]);
  const runRoot = `.forexplore/ingestion/${manifest.id}`;
  const proposalArtifacts = wikiProposals.map((proposal) => immutableJsonArtifact(
    proposal.id,
    'repository-module-wiki-proposal',
    `${runRoot}/summary-proposals/${safeArtifactName(proposal.id)}.json`,
    proposal,
    proposal.createdAt,
  ));
  const carriedAcceptedReviewRefs = priorKnowledgeReviews
    .filter((review) => review.decision === 'accept')
    .map((review) => revisionRefs.priorKnowledgeReviews.find((ref) => ref.id === review.id)!)
    .filter((ref): ref is RepositoryIngestionArtifactRef => ref !== undefined);
  const nextManifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'module-wiki-proposal-produced',
    occurredAt,
    actor: { kind: 'agent', id: 'repository-module-summary-agent' },
    idempotencyKey: `${manifest.id}:module-wiki-proposals:${sha256Hex(canonicalJson(
      wikiProposals.map((proposal) => proposal.contentHash),
    ))}`,
    toStatus: 'awaiting-summary-review',
    artifacts: {
      moduleWikiProposals: proposalArtifacts.map((artifact) => artifact.ref),
      ...(carriedAcceptedReviewRefs.length === 0
        ? {}
        : { moduleKnowledgeReviews: carriedAcceptedReviewRefs }),
    },
    message: 'Generated evidence-bound Wiki proposals and stopped at the independent human summary-review gate.',
  });
  const manifestPath = repositoryIngestionManifestPath(manifest.id);
  await persist({
    repositoryRoot: input.repositoryRoot,
    ingestionId: manifest.id,
    artifacts: [
      ...proposalArtifacts
        .filter((artifact) => !previousProposals.some((proposal) => proposal.id === artifact.ref.id))
        .map((artifact) => artifact.stored),
      manifestCommitMarker(
        nextManifest,
        manifestPath,
        sha256Hex(serializeRepositoryIngestionManifest(manifest)),
      ),
    ],
  });
  return {
    manifest: nextManifest,
    manifestPath,
    repositoryModuleBundle,
    evidenceBundles,
    wikiProposals,
    reused: false,
  };
}

function validateProposalSet(
  repositoryModuleBundle: RepositoryModuleBundle,
  evidenceBundles: RepositoryModuleEvidenceBundle[],
  wikiProposals: RepositoryModuleWikiProposal[],
): void {
  assertCompleteModuleSet(
    repositoryModuleBundle.modules.map((module) => module.id),
    wikiProposals.map((proposal) => proposal.moduleId),
    'Wiki proposal',
  );
  const evidenceByModule = new Map(evidenceBundles.map((bundle) => [bundle.moduleId, bundle]));
  for (const proposal of wikiProposals) {
    validateRepositoryModuleWikiProposal(proposal, evidenceByModule.get(proposal.moduleId)!);
  }
}

function assertCompleteModuleSet(expected: string[], actual: string[], label: string): void {
  const canonicalExpected = [...new Set(expected)].sort();
  const canonicalActual = [...new Set(actual)].sort();
  if (
    actual.length !== canonicalActual.length ||
    canonicalJson(canonicalActual) !== canonicalJson(canonicalExpected)
  ) {
    throw new Error(`Repository ingestion requires exactly one ${label} per module.`);
  }
}

async function readJsonArtifact<T>(
  input: GenerateRepositoryModuleSummariesInput,
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index]!, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function latestTimestamp(values: readonly string[]): string {
  for (const value of values) {
    if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid Summary lifecycle timestamp: ${value}`);
  }
  return [...values].sort().at(-1)!;
}
