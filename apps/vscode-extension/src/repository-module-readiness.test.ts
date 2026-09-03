import { describe, expect, it } from 'vitest';
import type { AnalysisShard, UnifiedRepositoryIR } from '@forexplore/contracts';
import { repositoryIngestionSchemaVersion } from '@forexplore/contracts';
import { assessRepositoryModuleDiscoveryReadiness } from './repository-module-readiness';

const hash = 'a'.repeat(64);

function shard(overrides: Partial<AnalysisShard> = {}): AnalysisShard {
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'shard-typescript',
    repositoryId: 'repository-1',
    profileId: 'profile-1',
    adapterId: 'adapter-typescript',
    adapterVersion: '1.0.0',
    mode: 'full',
    languageIds: ['typescript'],
    projectIds: [],
    pathPrefixes: [],
    inputContentHash: hash,
    capabilities: ['file-inventory', 'symbol-index', 'api-surface'],
    status: 'completed',
    files: [{
      id: 'file-source',
      path: 'src/order.ts',
      contentHash: hash,
      role: 'source',
      languageId: 'typescript',
      projectIds: [],
    }],
    entities: [],
    apiSurfaces: [],
    dependencies: [],
    diagnostics: [],
    producer: { kind: 'analysis-adapter', id: 'adapter-typescript', version: '1.0.0' },
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function ir(shards: readonly AnalysisShard[]): UnifiedRepositoryIR {
  const files = shards.flatMap((item) => item.files);
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'ir-1',
    repositoryId: 'repository-1',
    profileId: 'profile-1',
    repositoryContentHash: hash,
    sourceShardIds: shards.map((item) => item.id),
    capabilities: [...new Set(shards.flatMap((item) => item.capabilities))],
    files,
    entities: [],
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: files.length,
      analysedFileCount: files.filter((file) => file.languageId !== undefined).length,
      failedFileCount: 0,
      skippedFileCount: files.filter((file) => file.languageId === undefined).length,
      languageIds: [...new Set(files.flatMap((file) => file.languageId ? [file.languageId] : []))],
      missingCapabilities: [],
      segments: shards.map((item) => ({
        id: `coverage-${item.id}`,
        shardId: item.id,
        ...(item.languageIds[0] === undefined ? {} : { languageId: item.languageIds[0] }),
        discoveredFileCount: item.files.length,
        analysedFileCount: item.files.filter((file) => file.languageId !== undefined).length,
        failedFileCount: 0,
        skippedFileCount: item.files.filter((file) => file.languageId === undefined).length,
        capabilities: item.capabilities,
        missingCapabilities: [],
        diagnosticIds: [],
      })),
    },
    diagnostics: [],
    contentHash: hash,
    producer: { kind: 'ingestion-host', id: 'host', version: '1.0.0' },
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('repository module discovery readiness', () => {
  it('allows a complete source shard while retaining optional capability gaps', () => {
    const source = shard();
    const result = assessRepositoryModuleDiscoveryReadiness([source], ir([source]));
    expect(result.ready).toBe(true);
    expect(result.blockingIssues).toEqual([]);
    expect(result.missingOptionalCapabilities).toEqual([
      'dependency-graph',
      'semantic-binding',
      'test-association',
    ]);
  });

  it('fails closed for inventory-only unknown files without treating docs as source', () => {
    const source = shard();
    const inventory = shard({
      id: 'shard-inventory',
      adapterId: 'inventory-only',
      languageIds: [],
      capabilities: ['file-inventory'],
      files: [
        {
          id: 'file-unknown',
          path: 'src/order.kt',
          contentHash: hash,
          role: 'other',
          projectIds: [],
        },
        {
          id: 'file-readme',
          path: 'README.md',
          contentHash: hash,
          role: 'documentation',
          projectIds: [],
        },
      ],
    });
    const result = assessRepositoryModuleDiscoveryReadiness([source, inventory], ir([source, inventory]));
    expect(result.ready).toBe(false);
    expect(result.blockingIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNCLASSIFIED_REPOSITORY_FILE', fileIds: ['file-unknown'] }),
    ]));
  });

  it('rejects missing API evidence, partial source shards, and an IR/shard mismatch', () => {
    const incomplete = shard({
      status: 'partial',
      capabilities: ['file-inventory', 'symbol-index'],
    });
    const mismatched = { ...ir([incomplete]), sourceShardIds: ['another-shard'] };
    const result = assessRepositoryModuleDiscoveryReadiness([incomplete], mismatched);
    expect(result.ready).toBe(false);
    expect(result.blockingIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'IR_SHARD_MISMATCH',
      'INCOMPLETE_ANALYSIS_SHARD',
      'MISSING_ANALYSIS_CAPABILITY',
    ]));
  });
});
