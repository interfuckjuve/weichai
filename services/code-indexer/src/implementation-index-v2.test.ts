import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  repositoryIngestionSchemaVersion,
  type ModuleDiscoveryProposal,
  type RepositoryModuleCatalog,
  type RepositoryModuleReview,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  applyRepositoryModuleReview,
  canonicalJson,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleReview,
  sha256Hex,
} from '@forexplore/workflow-core';
import { afterEach, describe, expect, it } from 'vitest';
import { materializeReviewedImplementationIndexV2 } from './implementation-index-v2.js';
import { analyzeRepository } from './repository-analysis.js';
import {
  bridgeRepositoryStaticAnalysis,
  repositoryIngestionBridgeHash,
} from './repository-ingestion-bridge.js';

const now = '2026-09-02T10:00:00.000Z';
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-v2-index-'));
  roots.push(root);
  return root;
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function reviewed(ir: UnifiedRepositoryIR): {
  proposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
} {
  const module = {
    id: 'reviewed-module',
    name: 'Reviewed implementation',
    kind: 'business-capability' as const,
    description: 'Reviewed calculation behavior.',
    responsibilities: ['Calculate normalized values'],
    businessCapabilities: ['Calculation'],
    fileIds: ir.files.map((file) => file.id).sort(),
    entityIds: ir.entities.map((entity) => entity.id).sort(),
    entryPointEntityIds: ir.entities.filter((entity) => entity.kind === 'callable' && !entity.testOnly)
      .map((entity) => entity.id).sort(),
    publicApiEntityIds: ir.apiSurfaces
      .filter((surface) => !ir.entities.find((entity) => entity.id === surface.entityId)?.testOnly)
      .map((surface) => surface.entityId).sort(),
    boundaryRationale: 'The source and its tests change together.',
    evidenceRefs: ir.entities.slice(0, 1).map((entity) => ({
      id: entity.id,
      kind: 'syntactic-analysis' as const,
    })),
  };
  const withoutHash: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: 'reviewed-proposal',
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    objective: 'Index reviewed implementations.',
    constraints: [],
    status: 'awaiting-review',
    modules: [module],
    assignments: ir.files.map((file) => ({
      fileId: file.id,
      moduleIds: [module.id],
      kind: 'owned' as const,
      rationale: 'Reviewed single-module fixture.',
      evidenceRefs: [{ id: file.id, kind: 'source' as const }],
    })),
    dependencies: [],
    assumptions: [],
    risks: [],
    unresolvedQuestions: [],
    producer: { kind: 'module-discovery-agent', id: 'test-discovery', version: '1.0.0' },
    createdAt: now,
  };
  const proposal = { ...withoutHash, contentHash: sha256Hex(canonicalJson(withoutHash)) };
  const draft = materializeRepositoryModuleCatalog(proposal, ir, {
    producer: { kind: 'ingestion-host', id: 'test-host', version: '1.0.0' },
    createdAt: now,
  });
  const review = materializeRepositoryModuleReview(proposal, ir, {
    decision: 'accept',
    reviewerId: 'reviewer',
    decidedAt: now,
  });
  const catalog = applyRepositoryModuleReview(draft, proposal, ir, review).catalog;
  if (!catalog) throw new Error('Accepted fixture did not create an active catalog.');
  return { proposal, review, catalog };
}

async function fixture() {
  const root = await repository();
  const primary = [
    'export function calculate(input: number): number {',
    '  const normalize = (value: number) => ({ value, valid: value > 0 });',
    '  return normalize(input).value;',
    '}',
  ].join('\n');
  const test = [
    'export function testCalculate(): void {',
    '  if (calculate(2) !== 2) throw new Error("failed");',
    '}',
  ].join('\n');
  await write(root, 'src/calculate.ts', primary);
  await write(root, 'tests/calculate.test.ts', test);
  const analysis = await analyzeRepository({
    root,
    repositoryId: 'reviewed-source',
    createdAt: now,
  });
  const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
  const sourceFiles = [
    { path: 'src/calculate.ts', content: primary },
    { path: 'tests/calculate.test.ts', content: test },
  ];
  return { root, ir, sourceFiles, primary, ...reviewed(ir) };
}

describe('materializeReviewedImplementationIndexV2', () => {
  it('builds a content-addressed TypeScript top-level bundle from reviewed source facts', async () => {
    const value = await fixture();
    const primary = value.ir.entities.find((entity) => entity.name === 'calculate')!;
    const [artifact] = materializeReviewedImplementationIndexV2({
      unifiedIr: value.ir,
      proposal: value.proposal,
      review: value.review,
      catalog: value.catalog,
      sourceFiles: value.sourceFiles,
      entityIds: [primary.id],
      producer: { providerId: 'reviewed-source-indexer', providerVersion: '2.0.0' },
      createdAt: now,
    });

    expect(artifact?.bundle.files.find((file) => file.role === 'primary')?.content).toBe(value.primary);
    expect(artifact?.bundle.testEntityIds.length).toBeGreaterThan(0);
    expect(artifact?.bundle.files.some((file) => file.role === 'test')).toBe(true);
    expect(artifact?.document.candidate.entity.kind).toBe('callable');
    expect(artifact?.document.candidate.entity.languageId).toBe('typescript');
    expect(artifact?.document.searchText).toContain('normalize = (value: number) => ({');
    expect(artifact?.document.sourceCatalog.moduleReviewId).toBe(value.review.id);
    expect(artifact?.document.sourceBundle).toEqual({
      id: artifact?.bundle.id,
      contentHash: artifact?.bundle.contentHash,
    });
  });

  it('fails closed for stale IR/catalog/source content and incomplete adapter ranges', async () => {
    const value = await fixture();
    const primary = value.ir.entities.find((entity) => entity.name === 'calculate')!;
    const input = {
      unifiedIr: value.ir,
      proposal: value.proposal,
      review: value.review,
      catalog: value.catalog,
      sourceFiles: value.sourceFiles,
      entityIds: [primary.id],
      producer: { providerId: 'reviewed-source-indexer', providerVersion: '2.0.0' },
      createdAt: now,
    } as const;
    expect(() => materializeReviewedImplementationIndexV2({
      ...input,
      sourceFiles: value.sourceFiles.map((file) =>
        file.path === 'src/calculate.ts' ? { ...file, content: `${file.content}\n// changed` } : file),
    })).toThrow('Source file is stale');
    expect(() => materializeReviewedImplementationIndexV2({
      ...input,
      unifiedIr: { ...value.ir, repositoryContentHash: 'f'.repeat(64) },
    })).toThrow('IR content address is stale');
    expect(() => materializeReviewedImplementationIndexV2({
      ...input,
      catalog: { ...value.catalog, status: 'stale' },
    })).toThrow('exact accepted module review and active catalog');

    const irPayload = {
      ...value.ir,
      entities: value.ir.entities.map((entity) =>
        entity.id === primary.id ? { ...entity, range: undefined } : entity),
    };
    const { id: _id, contentHash: _hash, ...withoutAddress } = irPayload;
    const contentHash = repositoryIngestionBridgeHash(withoutAddress);
    const noRangeIr: UnifiedRepositoryIR = {
      ...withoutAddress,
      id: `unified-repository-ir:${contentHash.slice(0, 32)}`,
      contentHash,
    };
    const noRangeReviewed = reviewed(noRangeIr);
    expect(() => materializeReviewedImplementationIndexV2({
      ...input,
      unifiedIr: noRangeIr,
      ...noRangeReviewed,
    })).toThrow('adapter-owned complete source range');
  });
});
