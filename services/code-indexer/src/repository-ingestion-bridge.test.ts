import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRepository,
  createDefaultRepositoryLanguageRegistry,
  createGenericRepositoryLanguageAdapter,
  RepositoryLanguageRegistry,
  type CompilerProbe,
} from './repository-analysis.js';
import {
  bridgeRepositoryStaticAnalysis,
  repositoryIngestionBridgeHash,
  repositoryStaticAnalysisToUnifiedIr,
} from './repository-ingestion-bridge.js';

const temporaryRoots: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-ingestion-bridge-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSource(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('bridgeRepositoryStaticAnalysis', () => {
  it('emits stable, evidence-closed API surfaces and per-language capability coverage', async () => {
    const root = await createRepository();
    await writeSource(root, 'java/Service.java', [
      'package sample;',
      'public class Service {',
      '  private String secret;',
      '  public int run(String value) { return 1; }',
      '}',
    ].join('\n'));
    await writeSource(root, 'dotnet/Worker.cs', [
      'namespace Demo;',
      'internal class Worker {',
      '  public void Execute() {}',
      '}',
    ].join('\n'));
    await writeSource(root, 'web/api.ts', [
      'export class PublicView {}',
      'function localView(): void {}',
    ].join('\n'));
    await writeSource(root, 'rust/api.rs', [
      'pub struct PublicLedger {}',
      'fn local_ledger() {}',
    ].join('\n'));
    await writeSource(root, 'go/api.go', [
      'package api',
      'func PublicHandler() {}',
      'func localHandler() {}',
    ].join('\n'));
    await writeSource(root, 'python/api.py', [
      'def public_task():',
      '    pass',
      'def _private_task():',
      '    pass',
    ].join('\n'));
    await writeSource(root, 'custom/api.acme', 'class UnknownApi {}\n');
    const registry = createDefaultRepositoryLanguageRegistry().register(
      createGenericRepositoryLanguageAdapter({
        languageId: 'acme',
        fileExtensions: ['.acme'],
      }),
    );
    const analysis = await analyzeRepository({
      root,
      languageRegistry: registry,
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    const first = bridgeRepositoryStaticAnalysis(analysis);
    const second = bridgeRepositoryStaticAnalysis(analysis);
    expect(second).toEqual(first);
    const surface = (name: string) => first.unifiedIr.apiSurfaces.find(
      (entry) => entry.name === name,
    );
    expect(surface('Service')).toEqual(expect.objectContaining({
      exposure: 'public',
      completeness: 'complete',
    }));
    expect(surface('secret')).toEqual(expect.objectContaining({ exposure: 'private' }));
    expect(surface('Worker')).toEqual(expect.objectContaining({ exposure: 'internal' }));
    expect(surface('Execute')).toEqual(expect.objectContaining({ exposure: 'public' }));
    expect(surface('PublicView')).toEqual(expect.objectContaining({ exposure: 'exported' }));
    expect(surface('localView')).toEqual(expect.objectContaining({ exposure: 'not-exported' }));
    expect(surface('PublicLedger')).toEqual(expect.objectContaining({ exposure: 'exported' }));
    expect(surface('local_ledger')).toEqual(expect.objectContaining({ exposure: 'not-exported' }));
    expect(surface('PublicHandler')).toEqual(expect.objectContaining({ exposure: 'exported' }));
    expect(surface('localHandler')).toEqual(expect.objectContaining({ exposure: 'not-exported' }));
    expect(surface('public_task')).toEqual(expect.objectContaining({
      exposure: 'exported',
      completeness: 'partial',
      missingFeatures: expect.arrayContaining(['exposure-derived-from-naming-convention']),
    }));
    expect(surface('_private_task')).toEqual(expect.objectContaining({ exposure: 'not-exported' }));
    expect(surface('UnknownApi')).toEqual(expect.objectContaining({
      exposure: 'unknown',
      completeness: 'unknown',
    }));

    const entityIds = new Set(first.unifiedIr.entities.map((entity) => entity.id));
    for (const apiSurface of first.unifiedIr.apiSurfaces) {
      expect(apiSurface.evidenceRefs).toHaveLength(1);
      expect(entityIds.has(apiSurface.evidenceRefs[0]?.id ?? '')).toBe(true);
      expect(apiSurface.evidenceRefs[0]?.sourceArtifactId).toBeUndefined();
      expect(apiSurface.id).toBe(
        `api-surface:${repositoryIngestionBridgeHash({
          ...apiSurface,
          id: undefined,
        }).slice(0, 32)}`,
      );
    }
    const runEntity = first.unifiedIr.entities.find((entity) => entity.name === 'run');
    const serviceEntity = first.unifiedIr.entities.find((entity) => entity.name === 'Service');
    expect(runEntity?.containerEntityId).toBe(serviceEntity?.id);

    for (const languageId of ['java', 'csharp', 'typescript', 'rust', 'go', 'python']) {
      const shard = first.shards.find((entry) => entry.languageIds[0] === languageId);
      const segment = first.unifiedIr.coverage.segments.find((entry) => entry.shardId === shard?.id);
      expect(shard?.capabilities).toContain('api-surface');
      expect(segment?.missingCapabilities).not.toContain('api-surface');
      expect(segment?.skippedFileCount).toBe(0);
    }
    const customShard = first.shards.find((entry) => entry.languageIds[0] === 'acme');
    const customSegment = first.unifiedIr.coverage.segments.find(
      (entry) => entry.shardId === customShard?.id,
    );
    expect(customShard?.capabilities).not.toContain('api-surface');
    expect(customSegment?.missingCapabilities).toContain('api-surface');
  });

  it('canonicalizes only legacy language labels and preserves custom IDs everywhere', async () => {
    const root = await createRepository();
    await writeSource(root, 'legacy/Service.legacycs', 'class Service {}');
    await writeSource(root, 'legacy/View.legacyts', 'class View {}');
    await writeSource(root, 'custom/Exact.custom', 'class Exact {}');
    const languageRegistry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        languageId: 'C#',
        fileExtensions: ['.legacycs'],
      }),
      createGenericRepositoryLanguageAdapter({
        languageId: 'TypeScript',
        fileExtensions: ['.legacyts'],
      }),
      createGenericRepositoryLanguageAdapter({
        languageId: 'Acme-Custom',
        fileExtensions: ['.custom'],
      }),
    ]);
    const analysis = await analyzeRepository({
      root,
      languageRegistry,
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    const { profile, shards, unifiedIr } = bridgeRepositoryStaticAnalysis(analysis);
    const expectedLanguageIds = ['Acme-Custom', 'csharp', 'typescript'];

    expect(profile.languages.map((entry) => entry.languageId)).toEqual(expectedLanguageIds);
    expect(shards.flatMap((shard) => shard.languageIds).sort()).toEqual(expectedLanguageIds);
    expect(unifiedIr.coverage.languageIds).toEqual(expectedLanguageIds);
    expect(unifiedIr.files.map((file) => file.languageId).sort()).toEqual(expectedLanguageIds);
    expect(unifiedIr.entities.map((entity) => entity.languageId).sort()).toEqual(
      expectedLanguageIds,
    );
    expect(profile.analysisAdapterIds).toEqual(
      languageRegistry.descriptors().map((descriptor) => descriptor.id).sort(),
    );
  });

  it('content-addresses deterministic profile, shards, and unified IR while preserving custom languages', async () => {
    const root = await createRepository();
    await writeSource(root, 'java/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'java/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));
    await writeSource(root, 'web/view.ts', 'export class View {}');
    await writeSource(root, 'custom/Payment.kt', 'class Payment {}');

    const languageRegistry = createDefaultRepositoryLanguageRegistry().register(
      createGenericRepositoryLanguageAdapter({
        languageId: 'acme-kotlin',
        fileExtensions: ['.kt'],
      }),
    );
    const compilerProbe: CompilerProbe = {
      async probe(request) {
        return {
          status: 'available',
          compiler: 'fixture-semantic-probe',
          bindings: [...request.candidates],
        };
      },
    };
    const analysis = await analyzeRepository({
      root,
      languageRegistry,
      compilerProbe,
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    const first = bridgeRepositoryStaticAnalysis(analysis);
    const second = bridgeRepositoryStaticAnalysis(analysis);

    expect(second).toEqual(first);
    expect(first.profile.languages.map((entry) => entry.languageId)).toEqual([
      'acme-kotlin',
      'java',
      'typescript',
    ]);
    expect(first.shards.flatMap((shard) => shard.languageIds).sort()).toEqual([
      'acme-kotlin',
      'java',
      'typescript',
    ]);
    expect(first.unifiedIr.coverage.languageIds).toEqual([
      'acme-kotlin',
      'java',
      'typescript',
    ]);
    expect(first.unifiedIr.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'custom/Payment.kt', languageId: 'acme-kotlin' }),
    ]));
    expect(first.unifiedIr.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Payment', languageId: 'acme-kotlin', kind: 'type' }),
    ]));

    const customShard = first.shards.find((shard) => shard.languageIds[0] === 'acme-kotlin');
    const javaShard = first.shards.find((shard) => shard.languageIds[0] === 'java');
    expect(customShard?.capabilities).toContain('symbol-index');
    expect(customShard?.capabilities).not.toContain('semantic-binding');
    expect(customShard?.capabilities).not.toContain('dependency-graph');
    expect(javaShard?.capabilities).toContain('semantic-binding');
    expect(first.unifiedIr.coverage.missingCapabilities).toEqual(expect.arrayContaining([
      'dependency-graph',
      'semantic-binding',
    ]));

    const semanticDependency = javaShard?.dependencies.find(
      (dependency) => dependency.evidenceLevel === 'semantic',
    );
    expect(semanticDependency?.evidenceRefs[0]).toEqual(expect.objectContaining({
      kind: 'semantic-analysis',
    }));
    expect(semanticDependency?.evidenceRefs[0]?.sourceArtifactId).toBeUndefined();

    const { id: profileId, ...profilePayload } = first.profile;
    expect(profileId).toBe(
      `repository-profile:${repositoryIngestionBridgeHash(profilePayload).slice(0, 32)}`,
    );
    for (const shard of first.shards) {
      const { id, contentHash, ...payload } = shard;
      expect(contentHash).toBe(repositoryIngestionBridgeHash(payload));
      expect(id).toBe(`analysis-shard:${contentHash?.slice(0, 32)}`);
    }
    const { id: irId, contentHash: irContentHash, ...irPayload } = first.unifiedIr;
    expect(irContentHash).toBe(repositoryIngestionBridgeHash(irPayload));
    expect(irId).toBe(`unified-repository-ir:${irContentHash.slice(0, 32)}`);
    expect(first.unifiedIr.sourceShardIds).toEqual(first.shards.map((shard) => shard.id));
    expect(repositoryStaticAnalysisToUnifiedIr(analysis)).toEqual(first.unifiedIr);
  });

  it('carries unregistered files through a language-neutral inventory shard without fake semantics', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.kt', 'class Service\n');
    await writeSource(root, 'README.md', '# Repository\n');
    await writeSource(root, 'assets/logo.svg', '<svg/>\n');
    const analysis = await analyzeRepository({
      root,
      languageRegistry: new RepositoryLanguageRegistry(),
      createdAt: '2026-08-31T00:00:00.000Z',
    });

    const { profile, shards, unifiedIr } = bridgeRepositoryStaticAnalysis(analysis);

    expect(profile.fileInventory).toEqual(expect.objectContaining({
      total: 3,
      documentation: 1,
      asset: 1,
      other: 1,
    }));
    expect(profile.analysisAdapterIds).toEqual(['repository-file-inventory']);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toEqual(expect.objectContaining({
      adapterId: 'repository-file-inventory',
      languageIds: [],
      capabilities: ['file-inventory'],
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'src/Service.kt' }),
      ]),
    }));
    expect(unifiedIr.coverage).toEqual(expect.objectContaining({
      discoveredFileCount: 3,
      analysedFileCount: 0,
      skippedFileCount: 3,
      missingCapabilities: ['api-surface', 'dependency-graph', 'semantic-binding', 'symbol-index'],
    }));
    expect(unifiedIr.capabilities).not.toContain('symbol-index');
  });

  it('keeps logical repository identity stable when a workspace snapshot changes', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.ts', 'export class Service {}\n');
    const first = bridgeRepositoryStaticAnalysis(await analyzeRepository({
      root,
      createdAt: '2026-08-31T00:00:00.000Z',
    }));
    await writeSource(root, 'src/Added.ts', 'export class Added {}\n');
    const second = bridgeRepositoryStaticAnalysis(await analyzeRepository({
      root,
      createdAt: '2026-08-31T00:01:00.000Z',
    }));

    expect(second.profile.repositoryId).toBe(first.profile.repositoryId);
    expect(second.unifiedIr.repositoryId).toBe(first.unifiedIr.repositoryId);
    expect(second.unifiedIr.repositoryContentHash).not.toBe(
      first.unifiedIr.repositoryContentHash,
    );
  });
});
