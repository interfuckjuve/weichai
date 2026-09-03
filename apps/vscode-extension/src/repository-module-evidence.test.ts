import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepositoryModuleBundle } from '@forexplore/contracts';
import { canonicalJson } from '@forexplore/workflow-core';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRepositoryModuleEvidence } from './repository-module-evidence';

const roots: string[] = [];
const now = '2026-09-01T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-module-evidence-'));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function bundle(files: Array<{ id: string; path: string; content: string; role?: 'source' | 'test' | 'documentation' | 'configuration' }>): RepositoryModuleBundle {
  const sourceFiles = files.filter((file) => file.id === 'source');
  const payload: Omit<RepositoryModuleBundle, 'id' | 'contentHash'> = {
    schemaVersion: '1.1',
    repositoryId: 'repository-test',
    repositoryRevision: 'abc123',
    repositoryContentHash: '1'.repeat(64),
    source: {
      unifiedRepositoryIrId: 'ir-test',
      unifiedRepositoryIrHash: '2'.repeat(64),
      moduleProposalId: 'proposal-test',
      moduleProposalHash: '3'.repeat(64),
      moduleReviewId: 'boundary-review-test',
      moduleReviewHash: '4'.repeat(64),
      moduleCatalogId: 'catalog-test',
      moduleCatalogHash: '5'.repeat(64),
    },
    capabilities: ['file-inventory', 'symbol-index', 'api-surface'],
    coverage: {
      discoveredFileCount: files.length,
      analysedFileCount: files.length,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['java'],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    modules: [{
      id: 'orders',
      name: 'Orders',
      kind: 'business-capability',
      description: 'Order processing.',
      responsibilities: ['Create orders.'],
      businessCapabilities: ['Orders'],
      fileIds: sourceFiles.map((file) => file.id),
      entityIds: ['entity-orders'],
      entryPointEntityIds: ['entity-orders'],
      publicApiEntityIds: ['entity-orders'],
      boundaryRationale: 'The service owns order behavior.',
      evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
    }],
    assignments: files.map((file) => ({
      fileId: file.id,
      moduleIds: file.id === 'source' ? ['orders'] : [],
      kind: file.id === 'source' ? 'owned' as const : 'excluded' as const,
      rationale: file.id === 'source' ? 'Owned source.' : 'Context-only file.',
      evidenceRefs: [{ id: file.id, kind: file.role === 'test' ? 'test' as const : 'source' as const }],
    })),
    moduleDependencies: [],
    files: files.map((file) => ({
      id: file.id,
      path: file.path,
      contentHash: hash(file.content),
      role: file.role ?? 'source',
      languageId: file.role === 'documentation' ? undefined : 'java',
      projectIds: ['app'],
    })),
    entities: [{
      id: 'entity-orders',
      kind: 'type',
      name: 'OrderService',
      qualifiedName: 'sample.OrderService',
      languageId: 'java',
      fileId: 'source',
      projectId: 'app',
      signature: 'public class OrderService',
    }],
    irDependencies: [],
    apiSurfaces: [{
      id: 'api-orders',
      entityId: 'entity-orders',
      languageId: 'java',
      kind: 'class',
      name: 'OrderService',
      qualifiedName: 'sample.OrderService',
      signature: 'public class OrderService',
      visibility: 'public',
      exposure: 'public',
      completeness: 'complete',
      missingFeatures: [],
      evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
    }],
    knowledgePages: [],
    producer: { kind: 'ingestion-host', id: 'test' },
    createdAt: now,
  };
  const contentHash = hash(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-bundle:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

function rehashBundle(value: RepositoryModuleBundle): RepositoryModuleBundle {
  const { id: _id, contentHash: _contentHash, ...payload } = value;
  const contentHash = hash(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-bundle:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

describe('collectRepositoryModuleEvidence', () => {
  it('collects owned source plus same-project documentation and structural evidence', async () => {
    const source = 'package sample;\npublic class OrderService {}\n';
    const readme = '# Orders\nCreates orders.\n';
    const root = await workspace({ 'src/OrderService.java': source, 'README.md': readme });
    const result = await collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: bundle([
        { id: 'source', path: 'src/OrderService.java', content: source },
        { id: 'readme', path: 'README.md', content: readme, role: 'documentation' },
      ]),
      moduleId: 'orders',
    });

    expect(result.items.some((item) => item.path === 'src/OrderService.java')).toBe(true);
    expect(result.items.some((item) => item.path === 'README.md')).toBe(true);
    expect(result.items.some((item) => item.kind === 'api-surface')).toBe(true);
    expect(result.scope.fileIds).toEqual(['readme', 'source']);
    expect(result.scope.evidenceIds).toEqual(expect.arrayContaining([
      'api-orders', 'entity-orders', 'readme', 'source',
    ]));
    for (const item of result.items) {
      expect(item.evidenceRefIds.every((id) => result.scope.evidenceIds.includes(id))).toBe(true);
    }
  });

  it('validates the content-addressed bundle before resolving any supplied file path', async () => {
    const accepted = bundle([{
      id: 'source',
      path: 'src/OrderService.java',
      content: 'accepted',
    }]);
    const tampered: RepositoryModuleBundle = {
      ...accepted,
      files: accepted.files.map((file) => ({ ...file, path: 'private/secret.txt' })),
    };
    const root = await workspace({
      'src/OrderService.java': 'accepted',
      'private/secret.txt': 'accepted',
    });

    await expect(collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: tampered,
      moduleId: 'orders',
    })).rejects.toThrow('bundle ID or content hash');
  });

  it('includes a bounded one-hop dependency file and its concrete evidence refs', async () => {
    const source = 'public class OrderService {}\n';
    const neighbor = 'public class OrderRepository {}\n';
    const root = await workspace({
      'src/OrderService.java': source,
      'src/OrderRepository.java': neighbor,
    });
    const base = bundle([
      { id: 'source', path: 'src/OrderService.java', content: source },
      { id: 'neighbor', path: 'src/OrderRepository.java', content: neighbor },
    ]);
    const accepted = rehashBundle({
      ...base,
      irDependencies: [{
        id: 'dependency-orders-repository',
        sourceEntityId: 'entity-orders',
        sourceFileId: 'source',
        targetFileId: 'neighbor',
        kind: 'invocation',
        internal: true,
        resolution: 'resolved',
        evidenceLevel: 'semantic',
        evidenceRefs: [{ id: 'dependency-callsite', kind: 'semantic-analysis' }],
      }],
    });
    const result = await collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: accepted,
      moduleId: 'orders',
    });

    expect(result.scope.fileIds).toContain('neighbor');
    expect(result.scope.dependencyIds).toContain('dependency-orders-repository');
    expect(result.scope.evidenceIds).toEqual(expect.arrayContaining([
      'neighbor', 'dependency-orders-repository', 'dependency-callsite',
    ]));
    expect(result.items.find((item) => item.kind === 'dependency-neighborhood')?.evidenceRefIds)
      .toEqual(['dependency-callsite', 'dependency-orders-repository']);
  });

  it('fails closed when repository bytes no longer match the accepted snapshot', async () => {
    const root = await workspace({ 'src/OrderService.java': 'changed' });
    const accepted = bundle([{
      id: 'source',
      path: 'src/OrderService.java',
      content: 'accepted',
    }]);

    await expect(collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: accepted,
      moduleId: 'orders',
    })).rejects.toThrow('changed after the accepted snapshot');
  });

  it('rejects lexical traversal before reading repository evidence', async () => {
    const root = await workspace({ 'src/OrderService.java': 'accepted' });
    const malicious = bundle([{
      id: 'source',
      path: '../outside.java',
      content: 'accepted',
    }]);

    await expect(collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: malicious,
      moduleId: 'orders',
    })).rejects.toThrow('escapes the repository root');
  });

  it('records explicit truncation under a bounded evidence budget', async () => {
    const content = '0123456789'.repeat(20);
    const root = await workspace({ 'src/OrderService.java': content });
    const result = await collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: bundle([{ id: 'source', path: 'src/OrderService.java', content }]),
      moduleId: 'orders',
      budget: { maxBytesPerFile: 32, maxTotalBytes: 64, maxItems: 4 },
    });

    const sourceItem = result.items.find((item) => item.path === 'src/OrderService.java');
    expect(sourceItem).toMatchObject({ truncated: true, truncationReason: 'per-file-or-total-byte-budget' });
    expect(sourceItem?.byteLength).toBeLessThanOrEqual(32);
  });

  it('hashes a large file to completion while retaining only the bounded prefix', async () => {
    const content = `${'a'.repeat(4 * 1024 * 1024)}\n`;
    const root = await workspace({ 'src/OrderService.java': content });
    const result = await collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: bundle([{ id: 'source', path: 'src/OrderService.java', content }]),
      moduleId: 'orders',
      budget: { maxBytesPerFile: 1_024, maxTotalBytes: 2_048, maxItems: 4 },
    });

    expect(result.items.find((item) => item.path === 'src/OrderService.java')).toMatchObject({
      byteLength: 1_024,
      truncated: true,
    });
  });

  it('omits sensitive configuration paths and high-confidence secret-like content', async () => {
    const source = 'public class OrderService {}\n';
    const env = 'PASSWORD=not-sent-to-model\n';
    const config = 'api_key=abcdefghijklmnop123456\n';
    const root = await workspace({
      'src/OrderService.java': source,
      '.env.production': env,
      'config/application.properties': config,
    });
    const result = await collectRepositoryModuleEvidence({
      repositoryRoot: root,
      bundle: bundle([
        { id: 'source', path: 'src/OrderService.java', content: source },
        { id: 'env', path: '.env.production', content: env, role: 'configuration' },
        { id: 'config', path: 'config/application.properties', content: config, role: 'configuration' },
      ]),
      moduleId: 'orders',
    });

    expect(result.items.some((item) => item.path === '.env.production')).toBe(false);
    expect(result.items.some((item) => item.path === 'config/application.properties')).toBe(false);
    expect(result.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'env', reason: 'sensitive-configuration-path-not-authorized' }),
      expect.objectContaining({ sourceId: 'config', reason: 'secret-like-configuration-content-not-authorized' }),
    ]));
  });
});
