import type {
  RepositoryArtifactProducer,
  TargetWorkspaceAnalysisLineage,
  TargetWorkspaceModuleSnapshot,
} from '@forexplore/contracts';
import {
  assessRepositoryImplementations,
  type RepositoryImplementationDetectorRegistry,
} from '@forexplore/code-indexer';
import {
  buildTargetWorkspaceModuleSnapshot,
  createEntityImplementationAssessment,
  validateTargetWorkspaceModuleSnapshot,
} from '@forexplore/workflow-core';
import type {
  TargetWorkspaceImplementationInventoryPort,
  TargetWorkspaceImplementationInventoryRequest,
} from './target-workspace-host';

export const localTargetWorkspaceImplementationInventoryVersion = '1.0.0';

/**
 * Trusted local composition of language detectors and workflow-core rollups.
 * The detector emits drafts only; this adapter binds them to the Host-owned IR
 * and reviewed catalog before returning a canonical 01B snapshot.
 */
export class LocalTargetWorkspaceImplementationInventory
implements TargetWorkspaceImplementationInventoryPort {
  constructor(
    private readonly detectorRegistry?: RepositoryImplementationDetectorRegistry,
  ) {}

  async build(
    request: TargetWorkspaceImplementationInventoryRequest,
    signal?: AbortSignal,
  ): Promise<TargetWorkspaceModuleSnapshot> {
    signal?.throwIfAborted();
    const drafts = await assessRepositoryImplementations({
      root: request.repositoryRoot,
      analysis: request.analysis,
      ir: request.ir,
      ...(this.detectorRegistry ? { detectorRegistry: this.detectorRegistry } : {}),
    });
    signal?.throwIfAborted();
    const lineage: TargetWorkspaceAnalysisLineage = {
      repositoryId: request.ir.repositoryId,
      ...(request.ir.repositoryRevision
        ? { repositoryRevision: request.ir.repositoryRevision }
        : {}),
      repositoryContentHash: request.ir.repositoryContentHash,
      unifiedRepositoryIrId: request.ir.id,
      unifiedRepositoryIrHash: request.ir.contentHash,
    };
    const assessments = drafts.map((draft) => createEntityImplementationAssessment({
      draft,
      lineage,
      createdAt: request.createdAt,
    }));
    const snapshot = buildTargetWorkspaceModuleSnapshot({
      ir: request.ir,
      catalog: request.catalog,
      assessments,
      producer: inventoryProducer(request.producer),
      createdAt: request.createdAt,
    });
    return validateTargetWorkspaceModuleSnapshot(snapshot, request.ir, request.catalog);
  }
}

function inventoryProducer(hostProducer: RepositoryArtifactProducer): RepositoryArtifactProducer {
  return {
    kind: 'ingestion-host',
    id: `${hostProducer.id}/implementation-inventory`,
    version: localTargetWorkspaceImplementationInventoryVersion,
    ...(hostProducer.configurationHash
      ? { configurationHash: hostProducer.configurationHash }
      : {}),
  };
}
