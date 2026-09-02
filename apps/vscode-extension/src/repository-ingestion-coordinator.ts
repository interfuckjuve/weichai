import type {
  AnalysisAdapterDescriptor,
  AnalysisCapability,
  ModuleDiscoveryProposal,
  RepositoryArtifactProducer,
  RepositoryIngestionArtifactRef,
  RepositoryIngestionJsonValue,
  RepositoryIngestionManifest,
  RepositoryKnowledgeArtifact,
  RepositoryModuleCatalog,
  RepositoryModuleKnowledgePage,
  RepositoryStaticAnalysis,
  SerializedRepositoryKnowledgeArtifact,
} from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import {
  appendRepositoryModuleKnowledgeLog,
  canonicalJson,
  createRepositoryIngestionManifest,
  deriveInitialRepositoryModuleWikiDraft,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleKnowledgeArtifacts,
  materializeRepositoryModuleKnowledgeIndexArtifact,
  materializeRepositoryModuleKnowledgeLogArtifact,
  materializeRepositoryModuleKnowledgePage,
  materializeRepositoryModuleKnowledgeSchemaArtifact,
  recordRepositoryIngestionEvent,
  serializeRepositoryIngestionManifest,
  sha256Hex,
  transitionRepositoryIngestionManifest,
  validateRepositoryIngestionManifest,
} from '@forexplore/workflow-core';
import {
  bridgeRepositoryStaticAnalysis,
  repositoryIngestionBridgeVersion,
} from '@forexplore/code-indexer';
import {
  moduleDiscoveryClientVersion,
  type ModuleDiscoveryRequest,
} from './module-discovery-client';
import {
  persistRepositoryIngestionArtifacts,
  readRepositoryIngestionManifest,
  readRepositoryModuleKnowledgeLog,
  repositoryIngestionManifestPath,
  verifyRepositoryIngestionStoredArtifacts,
  type PersistRepositoryIngestionArtifactsRequest,
  type RepositoryIngestionStoredArtifact,
} from './repository-ingestion-store';
import {
  assessRepositoryModuleDiscoveryReadiness,
  type RepositoryModuleDiscoveryReadiness,
} from './repository-module-readiness';

export const repositoryIngestionCoordinatorVersion = '1.0.0';
export const repositoryModuleDiscoveryPolicyVersion = '1.0.0';

const hostProducer: RepositoryArtifactProducer = {
  kind: 'ingestion-host',
  id: 'forexplore-vscode/repository-ingestion-coordinator',
  version: repositoryIngestionCoordinatorVersion,
};

export interface InitializeRepositoryAfterStaticAnalysisInput {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  constraints?: ModuleDiscoveryRequest['constraints'];
  repositoryScopes?: string[];
}

export interface RepositoryIngestionCoordinatorDependencies {
  discoverModules(request: ModuleDiscoveryRequest): Promise<ModuleDiscoveryProposal>;
  loadManifest?: (
    repositoryRoot: string,
    ingestionId: string,
  ) => Promise<RepositoryIngestionManifest | null>;
  readKnowledgeLog?: (repositoryRoot: string) => Promise<string>;
  persist?: (request: PersistRepositoryIngestionArtifactsRequest) => Promise<string[]>;
  now?: () => string;
}

export interface RepositoryIngestionInitializationResult {
  ingestionId: string;
  manifestPath: string;
  status:
    | 'awaiting-module-review'
    | 'summarizing-modules'
    | 'awaiting-summary-review'
    | 'publishing-knowledge'
    | 'ready'
    | 'partial'
    | 'failed';
  manifest: RepositoryIngestionManifest;
  reused: boolean;
  proposal?: ModuleDiscoveryProposal;
  catalog?: RepositoryModuleCatalog;
  knowledgePages?: RepositoryModuleKnowledgePage[];
  searchProjectionCount: number;
  readiness?: RepositoryModuleDiscoveryReadiness;
  failureMessage?: string;
}

/**
 * Content/version identity for the dynamic initialization of one immutable
 * static snapshot. No wall-clock time, local absolute path, or service URL is
 * part of this key.
 */
export function calculateRepositoryIngestionId(
  analysis: RepositoryStaticAnalysis,
  constraints: ModuleDiscoveryRequest['constraints'] = [],
  repositoryScopes: readonly string[] = [],
): string {
  const hash = sha256Hex(canonicalJson({
    schemaVersion: repositoryIngestionSchemaVersion,
    snapshotId: analysis.snapshotId,
    repositoryContentHash: analysis.contentHash,
    staticAnalyzerVersion: analysis.analyzerVersion,
    bridgeVersion: repositoryIngestionBridgeVersion,
    moduleDiscoveryClientVersion,
    coordinatorVersion: repositoryIngestionCoordinatorVersion,
    moduleDiscoveryPolicyVersion: repositoryModuleDiscoveryPolicyVersion,
    constraints,
    repositoryScopes: [...new Set(repositoryScopes)].sort(),
  }));
  return `ingestion-${hash.slice(0, 32)}`;
}

/**
 * Trusted, testable coordinator for repository initialization. It only reads
 * the already-created static snapshot, calls a read-only discovery port, and
 * materializes evidence-bound artifacts. It never executes repository code or
 * advances a draft catalog past human review.
 */
export async function initializeRepositoryAfterStaticAnalysis(
  input: InitializeRepositoryAfterStaticAnalysisInput,
  dependencies: RepositoryIngestionCoordinatorDependencies,
): Promise<RepositoryIngestionInitializationResult> {
  const ingestionId = calculateRepositoryIngestionId(
    input.analysis,
    input.constraints ?? [],
    input.repositoryScopes ?? [],
  );
  const manifestPath = repositoryIngestionManifestPath(ingestionId);
  const loadManifest = dependencies.loadManifest ?? readRepositoryIngestionManifest;
  const existing = await loadManifest(input.repositoryRoot, ingestionId);
  if (existing !== null) {
    validateRepositoryIngestionManifest(existing);
    if (
      existing.id !== ingestionId ||
      existing.repositoryContentHash !== input.analysis.contentHash ||
      ![
        'awaiting-module-review',
        'summarizing-modules',
        'awaiting-summary-review',
        'publishing-knowledge',
        'ready',
        'partial',
        'failed',
      ].includes(existing.status)
    ) {
      throw new Error('Existing repository ingestion commit marker does not match this snapshot initialization.');
    }
    await verifyRepositoryIngestionStoredArtifacts(input.repositoryRoot, existing);
    return {
      ingestionId,
      manifestPath,
      status: existing.status as RepositoryIngestionInitializationResult['status'],
      manifest: existing,
      reused: true,
      searchProjectionCount: manifestSearchProjectionCount(existing),
      ...(existing.failure === undefined ? {} : { failureMessage: existing.failure.message }),
    };
  }

  const bridge = bridgeRepositoryStaticAnalysis(input.analysis);
  const completedAnalysisCapabilities = canonicalCapabilities(bridge.unifiedIr.capabilities);
  // Missing optional evidence remains explicit in IR coverage; it must not be
  // misrepresented as a requested capability and then make reviewed publication
  // impossible. Required module-discovery gaps are handled by the host gate below.
  const requestedCapabilities = completedAnalysisCapabilities;
  const analysisAdapters = analysisAdapterDescriptors(bridge.shards);
  const occurredAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const persist = dependencies.persist ?? persistRepositoryIngestionArtifacts;
  const runRoot = `.forexplore/ingestion/${ingestionId}`;

  const profile = immutableJsonArtifact(
    bridge.profile.id,
    'repository-profile',
    `${runRoot}/profile.json`,
    bridge.profile,
    occurredAt,
  );
  const shardArtifacts = bridge.shards.map((shard, index) => immutableJsonArtifact(
    shard.id,
    'analysis-shard',
    `${runRoot}/shards/${String(index + 1).padStart(4, '0')}.json`,
    shard,
    occurredAt,
  ));
  const unifiedIr = immutableJsonArtifact(
    bridge.unifiedIr.id,
    'unified-repository-ir',
    `${runRoot}/unified-ir.json`,
    bridge.unifiedIr,
    occurredAt,
  );
  const immutableArtifacts: RepositoryIngestionStoredArtifact[] = [
    profile.stored,
    ...shardArtifacts.map((item) => item.stored),
    unifiedIr.stored,
  ];

  let manifest = createRepositoryIngestionManifest({
    id: ingestionId,
    repositoryId: bridge.profile.repositoryId,
    mode: 'full',
    ...(bridge.profile.revision === undefined ? {} : { repositoryRevision: bridge.profile.revision }),
    repositoryContentHash: input.analysis.contentHash,
    configurationHash: sha256Hex(canonicalJson({
      bridgeVersion: repositoryIngestionBridgeVersion,
      moduleDiscoveryClientVersion,
      coordinatorVersion: repositoryIngestionCoordinatorVersion,
      moduleDiscoveryPolicyVersion: repositoryModuleDiscoveryPolicyVersion,
      constraints: input.constraints ?? [],
      repositoryScopes: [...new Set(input.repositoryScopes ?? [])].sort(),
    })),
    requestedCapabilities,
    analysisAdapters,
    requestedAt: occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:requested`,
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'ingestion-started',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:profiling`,
    toStatus: 'profiling',
    message: 'Started repository profiling from the immutable static-analysis snapshot.',
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'profile-produced',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:profile`,
    artifacts: { profile: profile.ref },
    message: 'Produced the language-neutral repository profile.',
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'adapter-selected',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:analyzing`,
    toStatus: 'analyzing',
    message: 'Selected read-only analysis adapters for the discovered languages.',
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'shard-produced',
    occurredAt,
    actor: { kind: 'adapter', id: 'forexplore-code-indexer' },
    idempotencyKey: `${ingestionId}:shards`,
    artifacts: { shards: shardArtifacts.map((item) => item.ref) },
    message: `Produced ${shardArtifacts.length} language analysis shard(s).`,
  });
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'status-changed',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:merging`,
    toStatus: 'merging',
  });
  manifest = recordRepositoryIngestionEvent(manifest, {
    type: 'unified-ir-produced',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:unified-ir`,
    artifacts: { unifiedRepositoryIr: unifiedIr.ref },
    completedCapabilities: completedAnalysisCapabilities,
    diagnostics: bridge.unifiedIr.diagnostics,
    message: 'Merged analysis shards into the adapter-neutral repository IR.',
  });
  const readiness = assessRepositoryModuleDiscoveryReadiness(bridge.shards, bridge.unifiedIr);
  if (!readiness.ready) {
    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:analysis-partial`,
      toStatus: 'partial',
      details: asRepositoryJson({
        requiredCapabilities: readiness.requiredCapabilities,
        blockingIssues: readiness.blockingIssues,
        missingOptionalCapabilities: readiness.missingOptionalCapabilities,
      }),
      message: 'Repository evidence is incomplete for module discovery; no Agent call was made.',
    });
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId,
      artifacts: [
        ...immutableArtifacts,
        manifestStoredArtifact(manifest, manifestPath),
      ],
    });
    return {
      ingestionId,
      manifestPath,
      status: 'partial',
      manifest,
      reused: false,
      searchProjectionCount: 0,
      readiness,
    };
  }
  manifest = transitionRepositoryIngestionManifest(manifest, {
    type: 'status-changed',
    occurredAt,
    actor: { kind: 'system', id: hostProducer.id },
    idempotencyKey: `${ingestionId}:discovering-modules`,
    toStatus: 'discovering-modules',
    message: 'Started read-only functional module discovery.',
  });
  const manifestBeforeModuleDiscovery = manifest;
  const analysisImmutableArtifacts = [...immutableArtifacts];

  try {
    const proposal = await dependencies.discoverModules({
      snapshotId: input.analysis.snapshotId,
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    });
    const proposalArtifact = immutableJsonArtifact(
      proposal.id,
      'module-discovery-proposal',
      `${runRoot}/module-proposal.json`,
      proposal,
      occurredAt,
    );
    const catalog = materializeRepositoryModuleCatalog(proposal, bridge.unifiedIr, {
      producer: hostProducer,
      createdAt: occurredAt,
    });
    const catalogArtifact = immutableJsonArtifact(
      catalog.id,
      'module-catalog',
      `${runRoot}/module-catalog.json`,
      catalog,
      occurredAt,
    );
    immutableArtifacts.push(proposalArtifact.stored, catalogArtifact.stored);
    manifest = recordRepositoryIngestionEvent(manifest, {
      type: 'module-proposal-produced',
      occurredAt,
      actor: { kind: 'agent', id: proposal.producer.id },
      idempotencyKey: `${ingestionId}:module-proposal`,
      artifacts: { moduleDiscoveryProposal: proposalArtifact.ref },
      message: 'The Module Discovery Agent produced an evidence-bound proposal for human review.',
    });
    manifest = recordRepositoryIngestionEvent(manifest, {
      type: 'module-catalog-produced',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:draft-catalog`,
      artifacts: { moduleCatalog: catalogArtifact.ref },
      message: 'Materialized a host-validated draft catalog; no human approval was inferred.',
    });

    const pages = catalog.modules.map((module) => materializeRepositoryModuleKnowledgePage({
      catalog,
      ir: bridge.unifiedIr,
      moduleId: module.id,
      wiki: deriveInitialRepositoryModuleWikiDraft(proposal, catalog, bridge.unifiedIr, module.id),
      producer: proposal.producer,
      createdAt: occurredAt,
    }));
    const draftKnowledgeRoot = `${runRoot}/draft-modules`;
    const pageArtifacts = pages
      .flatMap(materializeRepositoryModuleKnowledgeArtifacts)
      .map((artifact) => relocateKnowledgeArtifact(artifact, draftKnowledgeRoot));
    const indexArtifact = relocateKnowledgeArtifact(
      materializeRepositoryModuleKnowledgeIndexArtifact(
        pages,
        hostProducer,
        occurredAt,
      ),
      draftKnowledgeRoot,
    );
    const schemaMaterialized = materializeRepositoryModuleKnowledgeSchemaArtifact(
      hostProducer,
      occurredAt,
    );
    // The maintenance schema is version-derived; binding it to this IR makes
    // its publication association explicit for the manifest's provenance rule.
    const schemaArtifact: SerializedRepositoryKnowledgeArtifact = relocateKnowledgeArtifact({
      ...schemaMaterialized,
      descriptor: {
        ...schemaMaterialized.descriptor,
        sourceArtifactIds: [bridge.unifiedIr.id],
      },
    }, draftKnowledgeRoot);
    const currentKnowledge: SerializedRepositoryKnowledgeArtifact[] = [
      ...pageArtifacts,
      indexArtifact,
      schemaArtifact,
    ];
    manifest = recordRepositoryIngestionEvent(manifest, {
      type: 'knowledge-artifact-produced',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:knowledge`,
      artifacts: { knowledge: currentKnowledge.map((item) => item.descriptor) },
      details: { searchProjectionDocumentCount: 0 },
      message: 'Materialized discovered-tier review pages; no unreviewed search projection was produced.',
    });

    manifest = transitionRepositoryIngestionManifest(manifest, {
      type: 'status-changed',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:awaiting-module-review`,
      toStatus: 'awaiting-module-review',
      message: 'Dynamic initialization completed and is waiting for explicit human module review.',
    });

    const readKnowledgeLog = dependencies.readKnowledgeLog ?? readRepositoryModuleKnowledgeLog;
    let log = await readKnowledgeLog(input.repositoryRoot);
    if (!log) log = '# Repository Module Knowledge Log\n\n';
    for (const event of manifest.events) log = appendRepositoryModuleKnowledgeLog(log, event);
    const currentLogArtifact = materializeRepositoryModuleKnowledgeLogArtifact(
      log,
      [
        bridge.unifiedIr.id,
        catalog.id,
        ...pageArtifacts.map((artifact) => artifact.descriptor.artifact.id),
      ],
      hostProducer,
      occurredAt,
    );
    const logArtifact = relocateKnowledgeArtifact(
      currentLogArtifact,
      `${runRoot}/knowledge-history`,
    );
    manifest = recordRepositoryIngestionEvent(manifest, {
      type: 'knowledge-artifact-produced',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:knowledge-log`,
      artifacts: { knowledge: [logArtifact.descriptor] },
      message: 'Published the append-only log after recording the awaiting-module-review boundary; the log intentionally excludes only this self-publication event.',
    });

    const storedKnowledge: RepositoryIngestionStoredArtifact[] = [
      ...pageArtifacts.map(immutableKnowledgeArtifact),
      immutableKnowledgeArtifact(indexArtifact),
      immutableKnowledgeArtifact(schemaArtifact),
      immutableKnowledgeArtifact(logArtifact),
      {
        path: currentLogArtifact.descriptor.artifact.path!,
        content: currentLogArtifact.content,
        mode: 'append-only-derived',
      },
    ];
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId,
      artifacts: [
        ...immutableArtifacts,
        ...storedKnowledge,
        manifestStoredArtifact(manifest, manifestPath),
      ],
    });
    return {
      ingestionId,
      manifestPath,
      status: 'awaiting-module-review',
      manifest,
      reused: false,
      proposal,
      catalog,
      knowledgePages: pages,
      searchProjectionCount: 0,
      readiness,
    };
  } catch (error) {
    const message = boundedError(error);
    manifest = transitionRepositoryIngestionManifest(manifestBeforeModuleDiscovery, {
      type: 'ingestion-failed',
      occurredAt,
      actor: { kind: 'system', id: hostProducer.id },
      idempotencyKey: `${ingestionId}:failed`,
      toStatus: 'failed',
      message: 'Dynamic repository initialization failed after preserving the static snapshot.',
      failure: {
        code: 'MODULE_DISCOVERY_INITIALIZATION_FAILED',
        message,
        retryable: false,
        failedStage: 'discovering-modules',
      },
    });
    const failureEvidence = manifest.failure!;
    let failureLogArtifact: SerializedRepositoryKnowledgeArtifact | undefined;
    let failureCurrentLogArtifact: SerializedRepositoryKnowledgeArtifact | undefined;
    try {
      const readKnowledgeLog = dependencies.readKnowledgeLog ?? readRepositoryModuleKnowledgeLog;
      let failureLog = await readKnowledgeLog(input.repositoryRoot);
      if (!failureLog) failureLog = '# Repository Module Knowledge Log\n\n';
      for (const event of manifest.events) {
        failureLog = appendRepositoryModuleKnowledgeLog(failureLog, event);
      }
      failureCurrentLogArtifact = materializeRepositoryModuleKnowledgeLogArtifact(
        failureLog,
        manifestSourceArtifactIds(manifest),
        hostProducer,
        occurredAt,
      );
      failureLogArtifact = relocateKnowledgeArtifact(
        failureCurrentLogArtifact,
        `${runRoot}/knowledge-history`,
      );
      manifest = recordRepositoryIngestionEvent(manifest, {
        type: 'knowledge-artifact-produced',
        occurredAt,
        actor: { kind: 'system', id: hostProducer.id },
        idempotencyKey: `${ingestionId}:failed-knowledge-log`,
        artifacts: { knowledge: [failureLogArtifact.descriptor] },
        failure: failureEvidence,
        message: 'Published failure evidence to the append-only knowledge log; the log intentionally excludes only this self-publication event.',
      });
    } catch {
      // The immutable failed manifest remains the commit marker even when the
      // derived global log itself is unavailable or unsafe to update.
      failureLogArtifact = undefined;
      failureCurrentLogArtifact = undefined;
    }
    await persist({
      repositoryRoot: input.repositoryRoot,
      ingestionId,
      artifacts: [
        ...analysisImmutableArtifacts,
        ...(failureLogArtifact === undefined || failureCurrentLogArtifact === undefined
          ? []
          : [
            immutableKnowledgeArtifact(failureLogArtifact),
            {
              path: failureCurrentLogArtifact.descriptor.artifact.path!,
              content: failureCurrentLogArtifact.content,
              mode: 'append-only-derived' as const,
            },
          ]),
        manifestStoredArtifact(manifest, manifestPath),
      ],
    });
    return {
      ingestionId,
      manifestPath,
      status: 'failed',
      manifest,
      reused: false,
      searchProjectionCount: 0,
      failureMessage: message,
    };
  }
}

/** UI-safe projection: it reports review and publication boundaries explicitly. */
export function repositoryIngestionInitializationPreview(
  result: RepositoryIngestionInitializationResult,
): Record<string, unknown> {
  return {
    kind: 'RepositoryDynamicInitialization',
    ingestionId: result.ingestionId,
    status: result.status,
    reused: result.reused,
    manifestPath: result.manifestPath,
    repositoryId: result.manifest.repositoryId,
    repositoryContentHash: result.manifest.repositoryContentHash,
    moduleCount: result.catalog?.modules.length ?? null,
    knowledgePageCount: result.knowledgePages?.length ?? null,
    searchProjectionDocumentCount: result.searchProjectionCount,
    missingAnalysisCapabilities: result.manifest.requestedCapabilities.filter(
      (capability) => !result.manifest.completedCapabilities.includes(capability),
    ),
    moduleDiscoveryBlockingIssues: result.readiness?.blockingIssues ?? [],
    missingOptionalAnalysisCapabilities:
      result.readiness?.missingOptionalCapabilities ?? [],
    humanModuleReviewRequired: result.status === 'awaiting-module-review',
    moduleCatalogApproved: [
      'summarizing-modules',
      'awaiting-summary-review',
      'publishing-knowledge',
      'ready',
    ].includes(result.status),
    knowledgePublicationActive: result.status === 'ready',
    repositoryModuleBundle:
      result.manifest.artifacts.moduleBundle?.id ?? null,
    searchDatabaseUpserted: false,
    ...(result.failureMessage === undefined ? {} : { failure: result.failureMessage }),
    artifactPaths: {
      immutableRun: `.forexplore/ingestion/${result.ingestionId}/`,
      moduleWiki: '.forexplore/modules/',
      manifest: result.manifestPath,
    },
    manifest: result.manifest,
  };
}

/** Matches the retrieval service's repository-scope grammar. */
export function defaultRepositoryKnowledgeScope(repositoryId: string): string {
  const normalized = repositoryId
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 180);
  return `local-repository/${normalized || sha256Hex(repositoryId).slice(0, 32)}`;
}

function analysisAdapterDescriptors(
  shards: ReturnType<typeof bridgeRepositoryStaticAnalysis>['shards'],
): AnalysisAdapterDescriptor[] {
  return shards.map((shard): AnalysisAdapterDescriptor => ({
    schemaVersion: repositoryIngestionSchemaVersion,
    id: shard.adapterId,
    name: `Repository static analysis for ${shard.languageIds.join(', ')}`,
    version: shard.adapterVersion,
    languageIds: [...shard.languageIds].sort(),
    capabilities: canonicalCapabilities(shard.capabilities),
    modes: ['full'],
    shardStrategy: 'language',
    outputs: ['api-surface', 'dependencies', 'diagnostics', 'entities', 'files'],
    deterministic: true,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalCapabilities(capabilities: readonly AnalysisCapability[]): AnalysisCapability[] {
  return [...new Set(capabilities)].sort();
}

function manifestSourceArtifactIds(manifest: RepositoryIngestionManifest): string[] {
  return [
    ...(manifest.artifacts.profile ? [manifest.artifacts.profile.id] : []),
    ...manifest.artifacts.shards.map((artifact) => artifact.id),
    ...(manifest.artifacts.unifiedRepositoryIr ? [manifest.artifacts.unifiedRepositoryIr.id] : []),
    ...(manifest.artifacts.moduleDiscoveryProposal
      ? [manifest.artifacts.moduleDiscoveryProposal.id]
      : []),
    ...(manifest.artifacts.moduleReview ? [manifest.artifacts.moduleReview.id] : []),
    ...(manifest.artifacts.moduleCatalog ? [manifest.artifacts.moduleCatalog.id] : []),
    ...(manifest.artifacts.activeModuleCatalog
      ? [manifest.artifacts.activeModuleCatalog.id]
      : []),
    ...(manifest.artifacts.moduleBundle ? [manifest.artifacts.moduleBundle.id] : []),
    ...manifest.artifacts.moduleEvidenceBundles.map((artifact) => artifact.id),
    ...manifest.artifacts.moduleWikiProposals.map((artifact) => artifact.id),
    ...manifest.artifacts.moduleKnowledgeReviews.map((artifact) => artifact.id),
    ...manifest.artifacts.knowledgePublications.map((artifact) => artifact.id),
    ...manifest.artifacts.moduleIndexReceipts.map((artifact) => artifact.id),
    ...manifest.artifacts.publicationHeads.map((artifact) => artifact.id),
    ...(manifest.artifacts.incrementalImpactSet
      ? [manifest.artifacts.incrementalImpactSet.id]
      : []),
    ...manifest.artifacts.knowledge.map((knowledge) => knowledge.artifact.id),
  ];
}

function manifestSearchProjectionCount(manifest: RepositoryIngestionManifest): number {
  const event = manifest.events.find((candidate) =>
    candidate.idempotencyKey === `${manifest.id}:knowledge`,
  );
  const details = event?.details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return 0;
  const update = details.update;
  if (typeof update !== 'object' || update === null || Array.isArray(update)) return 0;
  const count = update.searchProjectionDocumentCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
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

function serializedKnowledgeArtifact(
  id: string,
  kind: RepositoryIngestionArtifactRef['kind'],
  artifactPath: string,
  mediaType: string,
  format: RepositoryKnowledgeArtifact['format'],
  content: string,
  sourceArtifactIds: string[],
  producer: RepositoryArtifactProducer,
  createdAt: string,
): SerializedRepositoryKnowledgeArtifact {
  return {
    descriptor: {
      artifact: {
        id,
        kind,
        contentHash: sha256Hex(content),
        hashAlgorithm: 'sha256',
        schemaVersion: repositoryIngestionSchemaVersion,
        path: artifactPath,
        mediaType,
        byteLength: Buffer.byteLength(content, 'utf8'),
        createdAt,
      },
      format,
      sourceArtifactIds: [...new Set(sourceArtifactIds)].sort(),
      producer,
    },
    content,
  };
}

function immutableKnowledgeArtifact(
  artifact: SerializedRepositoryKnowledgeArtifact,
): RepositoryIngestionStoredArtifact {
  return {
    path: artifact.descriptor.artifact.path!,
    content: artifact.content,
    mode: 'immutable',
  };
}

/**
 * Materializers deliberately emit the human-facing `.forexplore/modules/*`
 * layout. Historic manifests must never close over those mutable views, so an
 * ingestion commits its own immutable copy and leaves current-view publication
 * to the post-review control-plane.
 */
function relocateKnowledgeArtifact(
  artifact: SerializedRepositoryKnowledgeArtifact,
  immutableRoot: string,
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
        path: `${immutableRoot}/${original.slice('.forexplore/modules/'.length)}`,
      },
    },
  };
}

function manifestStoredArtifact(
  manifest: RepositoryIngestionManifest,
  manifestPath: string,
): RepositoryIngestionStoredArtifact {
  return {
    path: manifestPath,
    content: serializeRepositoryIngestionManifest(manifest),
    mode: 'manifest',
  };
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\r\n?/g, '\n').slice(0, 4_000) || 'Unknown module discovery failure.';
}

function asRepositoryJson(value: unknown): RepositoryIngestionJsonValue {
  return JSON.parse(canonicalJson(value)) as RepositoryIngestionJsonValue;
}
