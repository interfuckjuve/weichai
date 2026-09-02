import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModuleDiscoveryProposal } from '@forexplore/contracts';
import {
  analyzeRepository,
  bridgeRepositoryStaticAnalysis,
} from '@forexplore/code-indexer';
import {
  applyRepositoryModuleReview,
  canonicalJson,
  materializeRepositoryModuleCatalog,
  materializeRepositoryModuleReview,
  sha256Hex,
} from '@forexplore/workflow-core';
import { LocalTargetWorkspaceImplementationInventory } from './target-workspace-implementation-inventory';

const roots: string[] = [];
const NOW = '2026-09-02T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function targetFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-target-inventory-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'PaymentService.cs'), [
    'namespace Target;',
    'public class PaymentService {',
    '  public void Pay() { throw new NotImplementedException(); }',
    '  public string Status() { return "ready"; }',
    '}',
  ].join('\n'), 'utf8');
  const analysis = await analyzeRepository({
    root,
    repositoryId: 'target-payments',
    createdAt: NOW,
    allowDirtyWorktreeForPlanning: true,
  });
  const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
  const moduleFileIds = ir.files.filter((file) => file.role === 'source').map((file) => file.id);
  const moduleEntityIds = ir.entities
    .filter((entity) => entity.fileId && moduleFileIds.includes(entity.fileId))
    .map((entity) => entity.id);
  const proposalWithoutHash: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: '1.1',
    id: 'target-proposal',
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    constraints: [],
    status: 'awaiting-review',
    modules: [{
      id: 'payments',
      name: 'Payments',
      kind: 'business-capability',
      description: 'Target payment skeleton',
      responsibilities: ['payments'],
      businessCapabilities: ['payments'],
      fileIds: moduleFileIds,
      entityIds: moduleEntityIds,
      entryPointEntityIds: [],
      publicApiEntityIds: [],
      boundaryRationale: 'fixture',
      evidenceRefs: [{ id: moduleFileIds[0]!, kind: 'source' }],
    }],
    assignments: ir.files.map((file) => ({
      fileId: file.id,
      moduleIds: moduleFileIds.includes(file.id) ? ['payments'] : [],
      kind: moduleFileIds.includes(file.id) ? 'owned' as const : 'excluded' as const,
      rationale: 'fixture',
      evidenceRefs: [{ id: file.id, kind: 'source' as const }],
    })),
    dependencies: [],
    assumptions: [],
    risks: [],
    unresolvedQuestions: [],
    producer: { kind: 'module-discovery-agent', id: 'fixture-agent' },
    createdAt: NOW,
  };
  const proposal: ModuleDiscoveryProposal = {
    ...proposalWithoutHash,
    contentHash: sha256Hex(canonicalJson(proposalWithoutHash)),
  };
  const producer = { kind: 'ingestion-host' as const, id: 'target-host' };
  const draftCatalog = materializeRepositoryModuleCatalog(proposal, ir, {
    producer,
    createdAt: NOW,
  });
  const review = materializeRepositoryModuleReview(proposal, ir, {
    decision: 'accept',
    reviewerId: 'target-reviewer',
    decidedAt: NOW,
  });
  const catalog = applyRepositoryModuleReview(draftCatalog, proposal, ir, review).catalog!;
  return { root, analysis, ir, proposal, review, catalog, producer };
}

describe('LocalTargetWorkspaceImplementationInventory', () => {
  it('binds real C# detector drafts to the reviewed 01A catalog', async () => {
    const fixture = await targetFixture();
    const snapshot = await new LocalTargetWorkspaceImplementationInventory().build({
      ...fixture,
      repositoryRoot: fixture.root,
      createdAt: NOW,
    });
    const states = new Map(snapshot.assessments.map((assessment) => [assessment.entityId, assessment.state]));
    const symbolByName = new Map(fixture.analysis.symbols.map((symbol) => [symbol.name, symbol.id]));
    expect(states.get(symbolByName.get('Pay')!)).toBe('unimplemented');
    expect(states.get(symbolByName.get('Status')!)).toBe('implemented');
    expect(snapshot.workspaceCounts).toMatchObject({
      eligible: 2,
      implemented: 1,
      unimplemented: 1,
      unknown: 0,
    });
  }, 30_000);

  it('rejects a worktree changed after the analysis snapshot', async () => {
    const fixture = await targetFixture();
    await writeFile(
      path.join(fixture.root, 'src', 'PaymentService.cs'),
      'public class PaymentService { public void Pay() {} }\n',
      'utf8',
    );
    await expect(new LocalTargetWorkspaceImplementationInventory().build({
      ...fixture,
      repositoryRoot: fixture.root,
      createdAt: NOW,
    })).rejects.toThrow(/changed after static analysis/i);
  }, 30_000);
});
