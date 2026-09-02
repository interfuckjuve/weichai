import type {
  MaterializedMigrationRouteDescriptor,
  MigrationRouteAvailability,
  MigrationRouteDescriptor,
  MigrationRouteResolution,
  MigrationRouteResolutionRequest,
  MigrationRouteStageCapability,
  MigrationRuntimeCapabilitySnapshot,
  RepositoryStaticAnalysisAdapterDescriptor,
} from '@forexplore/contracts';
import type { RepositoryLanguageAdapterDescriptor } from '@forexplore/code-indexer';
import {
  materializeMigrationRuntimeCapabilitySnapshot,
  MigrationRouteRegistry,
  validateMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';
import type { ReviewedModuleCatalogHead } from './module-mapping-host';

const hostWorkspaceProvider = {
  id: 'forexplore.vscode.workspace-backfill',
  version: '1.0.0',
} as const;

export interface HostRuntimeCapabilityContext {
  source?: ReviewedModuleCatalogHead;
  target?: ReviewedModuleCatalogHead;
  analyzerDescriptors: readonly RepositoryLanguageAdapterDescriptor[];
  workspaceMutationAvailable: boolean;
}

export interface HostRuntimeCapabilityView {
  snapshot: MigrationRuntimeCapabilitySnapshot;
  resolutions: MigrationRouteResolution[];
}

/**
 * Combines service truth with capabilities genuinely owned by this extension.
 * Context collection, patching, compilation and behavior verification stay
 * byte-for-byte service-owned; only the four explicitly local stages may be
 * replaced before workflow-core rematerializes the Host-owned snapshot.
 */
export function combineHostRuntimeCapabilities(
  serviceSnapshot: MigrationRuntimeCapabilitySnapshot,
  context: HostRuntimeCapabilityContext,
): MigrationRuntimeCapabilitySnapshot {
  const validated = validateMigrationRuntimeCapabilitySnapshot(serviceSnapshot);
  const routes = validated.routes.map((route) => hostRoute(route, context));
  return materializeMigrationRuntimeCapabilitySnapshot({
    routes,
    createdAt: validated.createdAt,
  });
}

export function runtimeCapabilityView(
  snapshot: MigrationRuntimeCapabilitySnapshot,
): HostRuntimeCapabilityView {
  const validated = validateMigrationRuntimeCapabilitySnapshot(snapshot);
  const registry = new MigrationRouteRegistry(validated.routes);
  return {
    snapshot: validated,
    resolutions: validated.routes.map((route) => registry.resolve({
      sourceLanguageId: route.sourceLanguageId,
      targetLanguageId: route.targetLanguageId,
      strategy: route.strategy,
      requiredStages: route.stages.map(({ stage }) => stage),
    })),
  };
}

export function resolveRuntimeCapability(
  snapshot: MigrationRuntimeCapabilitySnapshot,
  request: MigrationRouteResolutionRequest,
): MigrationRouteResolution {
  const validated = validateMigrationRuntimeCapabilitySnapshot(snapshot);
  return new MigrationRouteRegistry(validated.routes).resolve(request);
}

function hostRoute(
  materialized: MaterializedMigrationRouteDescriptor,
  context: HostRuntimeCapabilityContext,
): MigrationRouteDescriptor {
  const stages = materialized.stages.map((stage) => {
    if (stage.stage === 'source-analysis') {
      return analysisStage(stage, materialized.sourceLanguageId, context.source, context);
    }
    if (stage.stage === 'target-analysis') {
      return analysisStage(stage, materialized.targetLanguageId, context.target, context);
    }
    if (
      context.workspaceMutationAvailable &&
      (stage.stage === 'workspace-apply' || stage.stage === 'workspace-rollback')
    ) {
      return {
        ...stage,
        providerId: hostWorkspaceProvider.id,
        providerVersion: hostWorkspaceProvider.version,
        availability: available(),
        requirements: unique([
          ...(stage.requirements ?? []),
          'approval:explicit-human',
          'workspace-boundary:trusted-vscode-host',
        ]),
      };
    }
    return cloneStage(stage);
  });
  return {
    schemaVersion: materialized.schemaVersion,
    id: materialized.id,
    name: materialized.name,
    version: materialized.version,
    sourceLanguageId: materialized.sourceLanguageId,
    targetLanguageId: materialized.targetLanguageId,
    strategy: materialized.strategy,
    stages,
    availability: aggregateAvailability(stages),
    validationPolicy: { ...materialized.validationPolicy },
  };
}

function analysisStage(
  serviceStage: MigrationRouteStageCapability,
  languageId: string,
  head: ReviewedModuleCatalogHead | undefined,
  context: HostRuntimeCapabilityContext,
): MigrationRouteStageCapability {
  if (serviceStage.availability.reasonCodes.some((reason) =>
    reason === 'retrieval-runtime-routes-empty' ||
    reason === 'retrieval-runtime-route-mismatch')) {
    return cloneStage(serviceStage);
  }
  const localDescriptor = context.analyzerDescriptors.find(
    (candidate) => candidate.languageId === languageId,
  );
  const reviewedDescriptor = head?.analysisAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!head) {
    return cloneStage(serviceStage);
  }
  if (!isCurrentReviewedHead(head, languageId)) {
    return unavailableLocalEvidence(serviceStage, 'host-reviewed-catalog-head-unverified');
  }
  if (!localDescriptor || !reviewedDescriptor) {
    return unavailableLocalEvidence(serviceStage, 'host-analysis-adapter-unavailable');
  }
  if (!sameAnalysisAdapter(reviewedDescriptor, localDescriptor)) {
    return unavailableLocalEvidence(
      serviceStage,
      'host-analysis-adapter-configuration-unverified',
    );
  }
  return {
    ...serviceStage,
    providerId: localDescriptor.id,
    providerVersion: localDescriptor.version,
    availability: available(),
    requirements: unique([
      ...(serviceStage.requirements ?? []),
      `analysis-content-hash:${head.analysisContentHash}`,
      `analysis-snapshot:${head.analysisSnapshotId}`,
      ...(localDescriptor.configurationHash
        ? [`analyzer-configuration:${localDescriptor.configurationHash}`]
        : []),
      `catalog-hash:${head.catalog.contentHash}`,
      `catalog-review-hash:${head.catalog.reviewHash!}`,
      `ir-hash:${head.ir.contentHash}`,
      `workspace:${head.workspaceId}`,
    ]),
  };
}

function unavailableLocalEvidence(
  stage: MigrationRouteStageCapability,
  reason: string,
): MigrationRouteStageCapability {
  const retained = cloneStage(stage);
  return {
    ...retained,
    availability: {
      status: 'unavailable',
      reasonCodes: unique([...retained.availability.reasonCodes, reason]),
      summary: 'The VS Code Host could not reverify the reviewed analysis lineage.',
    },
  };
}

function isCurrentReviewedHead(head: ReviewedModuleCatalogHead, languageId: string): boolean {
  return Boolean(
    head.analysisSnapshotId &&
    /^[0-9a-f]{64}$/.test(head.analysisContentHash) &&
    head.catalog.status === 'active' &&
    head.catalog.reviewId &&
    head.catalog.reviewHash &&
    head.catalog.sourceIrId === head.ir.id &&
    head.catalog.sourceIrHash === head.ir.contentHash &&
    head.ir.coverage.languageIds.includes(languageId),
  );
}

function sameAnalysisAdapter(
  reviewed: RepositoryStaticAnalysisAdapterDescriptor,
  local: RepositoryLanguageAdapterDescriptor,
): boolean {
  return typeof reviewed.configurationHash === 'string' &&
    reviewed.configurationHash.length > 0 &&
    typeof local.configurationHash === 'string' &&
    local.configurationHash.length > 0 &&
    reviewed.id === local.id &&
    reviewed.version === local.version &&
    reviewed.languageId === local.languageId &&
    reviewed.analysisLevel === local.analysisLevel &&
    reviewed.configurationHash === local.configurationHash &&
    JSON.stringify([...reviewed.capabilities].sort()) ===
      JSON.stringify([...local.capabilities].sort());
}

function cloneStage(stage: MigrationRouteStageCapability): MigrationRouteStageCapability {
  return {
    ...stage,
    capabilities: [...stage.capabilities],
    availability: {
      ...stage.availability,
      reasonCodes: [...stage.availability.reasonCodes],
    },
    ...(stage.requirements === undefined ? {} : { requirements: [...stage.requirements] }),
  };
}

function aggregateAvailability(
  stages: readonly MigrationRouteStageCapability[],
): MigrationRouteAvailability {
  const unavailable = stages.filter(({ availability }) => availability.status === 'unavailable');
  if (unavailable.length > 0) {
    return {
      status: 'unavailable',
      reasonCodes: unavailable.flatMap(({ stage, availability }) =>
        availability.reasonCodes.map((reason) => `${stage}:${reason}`)),
      summary: 'One or more required runtime stages are unavailable.',
    };
  }
  const degraded = stages.filter(({ availability }) => availability.status === 'degraded');
  if (degraded.length > 0) {
    return {
      status: 'degraded',
      reasonCodes: degraded.flatMap(({ stage, availability }) =>
        availability.reasonCodes.map((reason) => `${stage}:${reason}`)),
      summary: 'All required stages are executable, with declared limitations.',
    };
  }
  return available();
}

function available(): MigrationRouteAvailability {
  return { status: 'available', reasonCodes: [] };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
