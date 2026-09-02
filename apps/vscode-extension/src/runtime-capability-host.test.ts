import type {
  MigrationRouteDescriptor,
  MigrationRouteStage,
  RepositoryStaticAnalysisAdapterDescriptor,
} from '@forexplore/contracts';
import {
  migrationRouteSchemaVersion,
  repositoryIngestionSchemaVersion,
  validationPolicySchemaVersion,
} from '@forexplore/contracts';
import type { RepositoryLanguageAdapterDescriptor } from '@forexplore/code-indexer';
import { materializeMigrationRuntimeCapabilitySnapshot } from '@forexplore/workflow-core';
import { describe, expect, it } from 'vitest';
import type { ReviewedModuleCatalogHead } from './module-mapping-host';
import {
  combineHostRuntimeCapabilities,
  resolveRuntimeCapability,
  runtimeCapabilityView,
} from './runtime-capability-host';
import { intersectRuntimeCapabilities } from './runtime-capability-client';

const NOW = '2026-09-02T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const adapter: RepositoryLanguageAdapterDescriptor = {
  id: 'forexplore.analysis.python',
  version: '1.0.0',
  languageId: 'python',
  capabilities: ['symbol-index'],
  configurationHash: HASH,
  analysisLevel: 'deep',
  fileExtensions: ['.py'],
  configurationFileNames: [],
  configurationFileExtensions: [],
};

function route(): MigrationRouteDescriptor {
  const unavailableStages = new Map<MigrationRouteStage, string>([
    ['source-analysis', 'external-host-required'],
    ['target-analysis', 'external-host-required'],
    ['behavior-validation', 'behavior-verifier-execution-disabled'],
    ['workspace-apply', 'http-workspace-apply-disabled'],
    ['workspace-rollback', 'http-workspace-rollback-disabled'],
  ]);
  const stages: MigrationRouteStage[] = [
    'source-analysis', 'target-analysis', 'context-collection', 'translation',
    'patch-generation', 'compile-validation', 'behavior-validation',
    'workspace-apply', 'workspace-rollback',
  ];
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'translate.python-to-python',
    name: 'Python exact route',
    version: '2.0.0',
    sourceLanguageId: 'python',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: stages.map((stage) => ({
      stage,
      providerId: `service.${stage}`,
      providerVersion: '9.0.0',
      capabilities: stage === 'translation' ? ['code-translation'] : [],
      availability: unavailableStages.has(stage)
        ? { status: 'unavailable', reasonCodes: [unavailableStages.get(stage)!] }
        : { status: 'available', reasonCodes: [] },
    })),
    availability: {
      status: 'unavailable',
      reasonCodes: [...unavailableStages].map(([stage, reason]) => `${stage}:${reason}`),
    },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'translate.python-to-python.policy',
      routeId: 'translate.python-to-python',
      routeVersion: '2.0.0',
      checks: [{
        id: 'behavior',
        label: 'Independent behavior check',
        phase: 'behavior',
        required: true,
        verifierId: 'service.behavior-validation',
      }],
      createdAt: NOW,
    },
  };
}

function head(): ReviewedModuleCatalogHead {
  const reviewedAdapter: RepositoryStaticAnalysisAdapterDescriptor = {
    id: adapter.id,
    version: adapter.version,
    languageId: adapter.languageId,
    capabilities: [...adapter.capabilities],
    configurationHash: adapter.configurationHash,
    analysisLevel: adapter.analysisLevel,
  };
  return {
    workspaceId: 'workspace:python',
    analysisSnapshotId: 'snapshot:python',
    analysisContentHash: HASH,
    analysisAdapters: [reviewedAdapter],
    ir: {
      schemaVersion: repositoryIngestionSchemaVersion,
      id: 'ir:python',
      repositoryId: 'repository:python',
      profileId: 'profile:python',
      repositoryContentHash: HASH,
      sourceShardIds: ['shard:python'],
      capabilities: ['symbol-index'],
      files: [], entities: [], apiSurfaces: [], dependencies: [],
      coverage: {
        discoveredFileCount: 0, analysedFileCount: 0, failedFileCount: 0,
        skippedFileCount: 0, languageIds: ['python'], missingCapabilities: [], segments: [],
      },
      diagnostics: [],
      contentHash: 'b'.repeat(64),
      producer: { kind: 'ingestion-host', id: 'test' },
      createdAt: NOW,
    },
    catalog: {
      schemaVersion: repositoryIngestionSchemaVersion,
      id: 'catalog:python',
      repositoryId: 'repository:python',
      sourceIrId: 'ir:python',
      sourceIrHash: 'b'.repeat(64),
      sourceProposalId: 'proposal:python',
      sourceProposalHash: 'c'.repeat(64),
      status: 'active',
      modules: [], assignments: [], dependencies: [],
      unassignedFileIds: [], overlappingFileIds: [],
      reviewId: 'review:python',
      reviewHash: 'd'.repeat(64),
      contentHash: 'e'.repeat(64),
      producer: { kind: 'human', id: 'reviewer' },
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe('Host runtime capability composition', () => {
  it('does not overwrite a retrieval-empty source-analysis denial with a local analyzer', () => {
    const service = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const retrieval = materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt: NOW });
    const intersected = intersectRuntimeCapabilities(service, retrieval);
    const combined = combineHostRuntimeCapabilities(intersected, {
      source: head(),
      target: head(),
      analyzerDescriptors: [adapter],
      workspaceMutationAvailable: true,
    });
    expect(combined.routes[0]!.stages.find(({ stage }) => stage === 'source-analysis'))
      .toMatchObject({
        availability: {
          status: 'unavailable',
          reasonCodes: expect.arrayContaining(['retrieval-runtime-routes-empty']),
        },
      });
  });

  it('replaces only proven local analysis/mutation stages and preserves verifier truth', () => {
    const service = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const reviewed = head();

    const combined = combineHostRuntimeCapabilities(service, {
      source: reviewed,
      target: reviewed,
      analyzerDescriptors: [adapter],
      workspaceMutationAvailable: true,
    });
    const result = runtimeCapabilityView(combined).resolutions[0]!;

    expect(combined.contentHash).not.toBe(service.contentHash);
    expect(combined.routes[0]!.stages.filter((stage) => [
      'source-analysis', 'target-analysis', 'workspace-apply', 'workspace-rollback',
    ].includes(stage.stage)).every((stage) => stage.availability.status === 'available')).toBe(true);
    expect(combined.routes[0]!.stages.find(({ stage }) => stage === 'behavior-validation'))
      .toEqual(service.routes[0]!.stages.find(({ stage }) => stage === 'behavior-validation'));
    expect(combined.routes[0]!.stages.find(({ stage }) => stage === 'context-collection'))
      .toEqual(service.routes[0]!.stages.find(({ stage }) => stage === 'context-collection'));
    expect(result).toMatchObject({
      status: 'unsupported',
      reasonCodes: ['behavior-validation:behavior-verifier-execution-disabled'],
    });
  });

  it('keeps source analysis unavailable when the catalog/analyzer head is stale', () => {
    const service = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const stale = head();
    stale.catalog.sourceIrHash = 'f'.repeat(64);

    const combined = combineHostRuntimeCapabilities(service, {
      source: stale,
      target: head(),
      analyzerDescriptors: [adapter],
      workspaceMutationAvailable: true,
    });

    expect(combined.routes[0]!.stages.find(({ stage }) => stage === 'source-analysis'))
      .toMatchObject({
        availability: {
          status: 'unavailable',
          reasonCodes: expect.arrayContaining(['host-reviewed-catalog-head-unverified']),
        },
      });
    expect(runtimeCapabilityView(combined).resolutions[0]).toMatchObject({
      status: 'unsupported',
      reasonCodes: expect.arrayContaining(['source-analysis:external-host-required']),
    });
  });

  it('does not trust adapter identity when reviewed configurationHash is absent', () => {
    const service = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const unverified = head();
    delete unverified.analysisAdapters[0]!.configurationHash;

    const combined = combineHostRuntimeCapabilities(service, {
      source: unverified,
      target: unverified,
      analyzerDescriptors: [adapter],
      workspaceMutationAvailable: true,
    });

    expect(combined.routes[0]!.stages.find(({ stage }) => stage === 'source-analysis'))
      .toMatchObject({
        availability: {
          status: 'unavailable',
          reasonCodes: expect.arrayContaining([
            'host-analysis-adapter-configuration-unverified',
          ]),
        },
      });
    expect(JSON.stringify(combined)).not.toContain('analyzer-configuration:undefined');
  });

  it('resolves unknown exact pairs as unsupported instead of inferring a route', () => {
    const service = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    expect(resolveRuntimeCapability(service, {
      sourceLanguageId: 'go',
      targetLanguageId: 'rust',
      strategy: 'translate',
    })).toEqual({
      status: 'unsupported',
      key: { sourceLanguageId: 'go', targetLanguageId: 'rust', strategy: 'translate' },
      reason: 'route-not-registered',
      reasonCodes: ['route-not-registered'],
    });
  });
});
