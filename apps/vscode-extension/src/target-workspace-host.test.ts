import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EntityImplementationAssessmentDraft,
  ModuleDiscoveryConstraint,
  ModuleDiscoveryProposal,
  RepositoryStaticAnalysis,
  TargetWorkspaceAnalysisLineage,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  analyzeRepository,
  bridgeRepositoryStaticAnalysis,
  repositoryAnalysisContentHash,
  repositoryAnalysisSnapshotId,
} from '@forexplore/code-indexer';
import {
  buildTargetWorkspaceModuleSnapshot,
  canonicalJson,
  createEntityImplementationAssessment,
  sha256Hex,
} from '@forexplore/workflow-core';
import {
  InMemoryTargetWorkspaceHostStore,
  TargetWorkspaceHost,
  type TargetWorkspaceHostDependencies,
  type TargetWorkspaceImplementationInventoryPort,
} from './target-workspace-host';

const roots: string[] = [];
const createdAt = '2026-09-02T00:00:00.000Z';
const hostTime = '2026-09-03T00:00:00.000Z';
const initialSource = [
  'export class PaymentService {',
  '  pay(): void {',
  '    throw new Error("Not implemented");',
  '  }',
  '}',
  '',
].join('\n');
const bodyOnlySource = [
  'export class PaymentService {',
  '  pay(): void {',
  '    const accepted = true; void accepted;',
  '  }',
  '}',
  '',
].join('\n');
const structurallyChangedSource = [
  'export class PaymentService {',
  '  pay(): void {',
  '    const accepted = true; void accepted;',
  '  }',
  '  refund(): void {}',
  '}',
  '',
].join('\n');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTargetWorkspace(source: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-target-workspace-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'payment.ts'), source, 'utf8');
  return root;
}

async function analysisFor(root: string, source?: string): Promise<RepositoryStaticAnalysis> {
  if (source !== undefined) {
    await writeFile(path.join(root, 'src', 'payment.ts'), source, 'utf8');
  }
  return analyzeRepository({
    root,
    repositoryId: 'target-payments',
    createdAt,
    semanticEnrichment: false,
    allowDirtyWorktreeForPlanning: true,
  });
}

function withCallableContainer(analysis: RepositoryStaticAnalysis): RepositoryStaticAnalysis {
  const type = analysis.symbols.find((symbol) => symbol.kind === 'class');
  const callable = analysis.symbols.find((symbol) =>
    symbol.kind === 'function' || symbol.kind === 'method',
  );
  if (!type || !callable) throw new Error('Target fixture requires one type and one callable.');
  const updated = {
    ...analysis,
    symbols: analysis.symbols.map((symbol) => symbol.id === callable.id
      ? { ...symbol, containerSymbolId: type.id }
      : symbol),
  };
  return {
    ...updated,
    contentHash: repositoryAnalysisContentHash(updated),
    snapshotId: repositoryAnalysisSnapshotId(updated),
  };
}

function withAmbiguousCallableIdentity(
  analysis: RepositoryStaticAnalysis,
): RepositoryStaticAnalysis {
  const callable = analysis.symbols.find((symbol) =>
    symbol.kind === 'function' || symbol.kind === 'method',
  );
  if (!callable) throw new Error('Target fixture requires one callable.');
  const updated = {
    ...analysis,
    symbols: [
      ...analysis.symbols,
      { ...callable, id: `${callable.id}:duplicate` },
    ],
  };
  return {
    ...updated,
    contentHash: repositoryAnalysisContentHash(updated),
    snapshotId: repositoryAnalysisSnapshotId(updated),
  };
}

function proposalFor(
  ir: UnifiedRepositoryIR,
  options: {
    suffix?: string;
    name?: string;
    constraints?: ModuleDiscoveryConstraint[];
  } = {},
): ModuleDiscoveryProposal {
  const moduleId = 'payments';
  const moduleFileIds = ir.files
    .filter((file) => file.role === 'source' || file.role === 'test' || file.role === 'generated')
    .map((file) => file.id)
    .sort();
  const moduleEntities = ir.entities
    .filter((entity) => entity.fileId !== undefined && moduleFileIds.includes(entity.fileId))
    .map((entity) => entity.id)
    .sort();
  const publicApiEntityIds = ir.apiSurfaces
    .filter((surface) =>
      moduleEntities.includes(surface.entityId) &&
      ['public', 'protected', 'exported'].includes(surface.exposure),
    )
    .map((surface) => surface.entityId)
    .sort();
  const withoutHash: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    schemaVersion: '1.1',
    id: `target-proposal-${options.suffix ?? 'initial'}`,
    repositoryId: ir.repositoryId,
    sourceIrId: ir.id,
    sourceIrHash: ir.contentHash,
    constraints: options.constraints ?? [],
    status: 'awaiting-review',
    modules: [{
      id: moduleId,
      name: options.name ?? 'Payments',
      kind: 'business-capability',
      description: 'Target payment skeleton.',
      responsibilities: ['Implement target payment behavior.'],
      businessCapabilities: ['payments'],
      fileIds: moduleFileIds,
      entityIds: moduleEntities,
      entryPointEntityIds: publicApiEntityIds,
      publicApiEntityIds,
      boundaryRationale: 'All declarations belong to the target payment capability.',
      evidenceRefs: [{ id: moduleFileIds[0]!, kind: 'source' }],
    }],
    assignments: ir.files.map((file) => {
      const assigned = moduleFileIds.includes(file.id);
      const kind = file.role === 'test'
        ? 'test' as const
        : file.role === 'generated'
          ? 'generated' as const
          : assigned
            ? 'owned' as const
            : 'excluded' as const;
      return {
        fileId: file.id,
        moduleIds: assigned ? [moduleId] : [],
        kind,
        rationale: assigned ? 'Target module source.' : 'Outside target production source.',
        evidenceRefs: [{ id: file.id, kind: 'source' as const }],
      };
    }),
    dependencies: [],
    assumptions: [],
    risks: [],
    unresolvedQuestions: [],
    producer: {
      kind: 'module-discovery-agent',
      id: 'test-module-discovery-agent',
      version: '1.0.0',
    },
    createdAt,
  };
  return {
    ...withoutHash,
    contentHash: sha256Hex(canonicalJson(withoutHash)),
  };
}

function withoutExplicitEntityOwner(
  proposal: ModuleDiscoveryProposal,
  entityId: string,
): ModuleDiscoveryProposal {
  const { contentHash: _contentHash, ...payload } = proposal;
  const updated: Omit<ModuleDiscoveryProposal, 'contentHash'> = {
    ...payload,
    modules: payload.modules.map((module) => ({
      ...module,
      entityIds: module.entityIds.filter((id) => id !== entityId),
      entryPointEntityIds: module.entryPointEntityIds.filter((id) => id !== entityId),
      publicApiEntityIds: module.publicApiEntityIds.filter((id) => id !== entityId),
    })),
  };
  return {
    ...updated,
    contentHash: sha256Hex(canonicalJson(updated)),
  };
}

function analysisLineage(ir: UnifiedRepositoryIR): TargetWorkspaceAnalysisLineage {
  return {
    repositoryId: ir.repositoryId,
    ...(ir.repositoryRevision === undefined ? {} : { repositoryRevision: ir.repositoryRevision }),
    repositoryContentHash: ir.repositoryContentHash,
    unifiedRepositoryIrId: ir.id,
    unifiedRepositoryIrHash: ir.contentHash,
  };
}

function implementationInventory(
  state: EntityImplementationAssessmentDraft['state'] = 'unimplemented',
): TargetWorkspaceImplementationInventoryPort {
  return {
    async build(request) {
      const lineage = analysisLineage(request.ir);
      const assessments = request.ir.entities
        .filter((entity) => entity.kind === 'callable' && entity.fileId !== undefined)
        .map((entity) => createEntityImplementationAssessment({
          draft: {
            entityId: entity.id,
            fileId: entity.fileId!,
            bodyHash: sha256Hex(`${entity.id}:${state}`),
            state,
            basis: state === 'unimplemented' ? 'explicit-stub' : 'syntactic-body',
            reasonCodes: [state === 'unimplemented' ? 'EXPLICIT_STUB' : 'BODY_PRESENT'],
            evidenceRefs: [{ id: entity.id, kind: 'syntactic-analysis' }],
            detector: {
              id: 'test-target-detector',
              version: '1.0.0',
              ...(entity.languageId === undefined ? {} : { languageId: entity.languageId }),
            },
          },
          lineage,
          createdAt: request.createdAt,
        }));
      return buildTargetWorkspaceModuleSnapshot({
        ir: request.ir,
        catalog: request.catalog,
        assessments,
        producer: request.producer,
        createdAt: request.createdAt,
      });
    },
  };
}

interface HostFixture {
  host: TargetWorkspaceHost;
  store: InMemoryTargetWorkspaceHostStore;
  discoverModules: ReturnType<typeof vi.fn>;
  inventory: TargetWorkspaceImplementationInventoryPort;
  forbidden: {
    summarizeModules: ReturnType<typeof vi.fn>;
    publishKnowledge: ReturnType<typeof vi.fn>;
    activateSeekDbHead: ReturnType<typeof vi.fn>;
    writeSqliteRegistry: ReturnType<typeof vi.fn>;
  };
}

function hostFixture(
  analyses: readonly RepositoryStaticAnalysis[],
  proposal: ModuleDiscoveryProposal,
  inventory: TargetWorkspaceImplementationInventoryPort = implementationInventory(),
  gateVerificationAnalysis?: RepositoryStaticAnalysis,
): HostFixture {
  let analysisIndex = 0;
  let lastAnalysis = analyses[0]!;
  const store = new InMemoryTargetWorkspaceHostStore();
  const discoverModules = vi.fn(async () => proposal);
  const forbidden = {
    summarizeModules: vi.fn(async () => { throw new Error('summary must not run'); }),
    publishKnowledge: vi.fn(async () => { throw new Error('publication must not run'); }),
    activateSeekDbHead: vi.fn(async () => { throw new Error('SeekDB must not run'); }),
    writeSqliteRegistry: vi.fn(async () => { throw new Error('registry must not run'); }),
  };
  const dependencies = {
    store,
    discoverModules,
    implementationInventory: inventory,
    analyze: vi.fn(async () => {
      lastAnalysis = analyses[Math.min(analysisIndex++, analyses.length - 1)]!;
      return lastAnalysis;
    }),
    verifyCurrentAnalysis: vi.fn(async () => gateVerificationAnalysis ?? lastAnalysis),
    now: () => hostTime,
    // Poison ports are deliberately present at runtime. The target Host must
    // not inspect or call source-knowledge lifecycle capabilities.
    ...forbidden,
  } as unknown as TargetWorkspaceHostDependencies;
  return {
    host: new TargetWorkspaceHost(dependencies),
    store,
    discoverModules,
    inventory,
    forbidden,
  };
}

function gate1Request(
  workspaceId: string,
  proposal: ModuleDiscoveryProposal,
  ir: UnifiedRepositoryIR,
  decision: 'accept' | 'revise' | 'reject' = 'accept',
) {
  return {
    workspaceId,
    expectedProposalId: proposal.id,
    expectedProposalHash: proposal.contentHash,
    expectedIrId: ir.id,
    expectedIrHash: ir.contentHash,
    decision,
    reviewerId: 'target-architect',
  } as const;
}

describe('TargetWorkspaceHost', () => {
  it('reuses 01A discovery through Gate1 and has no Summary, registry, SeekDB, or publication effect', async () => {
    const root = await createTargetWorkspace(initialSource);
    const analysis = await analysisFor(root);
    const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
    const proposal = proposalFor(ir);
    const fixture = hostFixture([analysis], proposal);

    const record = await fixture.host.initialize({
      workspaceId: 'target-workspace',
      repositoryRoot: root,
    });

    expect(record).toMatchObject({
      role: 'target-workspace',
      stage: 'awaiting-module-review',
      discovery: {
        proposal: { id: proposal.id },
        draftCatalog: { status: 'draft' },
      },
    });
    expect(fixture.discoverModules).toHaveBeenCalledTimes(1);
    for (const port of Object.values(fixture.forbidden)) expect(port).not.toHaveBeenCalled();
  });

  it('binds Gate1 to proposal and IR hashes, then serves snapshot/entity target context', async () => {
    const root = await createTargetWorkspace(initialSource);
    const analysis = withCallableContainer(await analysisFor(root));
    const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
    const callable = ir.entities.find((entity) => entity.kind === 'callable')!;
    const proposal = withoutExplicitEntityOwner(proposalFor(ir), callable.id);
    const inventory = implementationInventory();
    const inventorySpy = vi.spyOn(inventory, 'build');
    const fixture = hostFixture([analysis], proposal, inventory);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });

    await expect(fixture.host.submitGate1({
      ...gate1Request('target-workspace', proposal, ir),
      expectedProposalHash: '0'.repeat(64),
    })).rejects.toThrow('stale');
    expect(inventorySpy).not.toHaveBeenCalled();

    const reviewed = await fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, ir),
    );
    expect(reviewed.stage).toBe('reviewed');
    expect(reviewed.accepted?.catalog.status).toBe('active');
    expect(reviewed.accepted?.snapshot?.workspaceCounts).toMatchObject({
      eligible: 1,
      unimplemented: 1,
    });
    const context = await fixture.host.getTargetContext({
      workspaceId: 'target-workspace',
      snapshotId: reviewed.accepted!.snapshot!.id,
      snapshotHash: reviewed.accepted!.snapshot!.contentHash,
      entityId: callable.id,
    });
    expect(context).toMatchObject({
      role: 'target-workspace',
      snapshotId: reviewed.accepted!.snapshot!.id,
      entity: { id: callable.id },
      module: { id: 'payments' },
      assessment: { state: 'unimplemented' },
      classRollup: { counts: { eligible: 1, unimplemented: 1 } },
      moduleRollup: { counts: { eligible: 1, unimplemented: 1 } },
    });
    await expect(fixture.host.getTargetContext({
      workspaceId: 'target-workspace',
      snapshotId: reviewed.accepted!.snapshot!.id,
      snapshotHash: 'f'.repeat(64),
      entityId: callable.id,
    })).rejects.toThrow('stale');
    for (const port of Object.values(fixture.forbidden)) expect(port).not.toHaveBeenCalled();
  });

  it('records a revise decision and accepts only a distinct, current replacement proposal', async () => {
    const root = await createTargetWorkspace(initialSource);
    const analysis = await analysisFor(root);
    const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
    const proposal = proposalFor(ir);
    const fixture = hostFixture([analysis], proposal);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });
    const revisionRequired = await fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, ir, 'revise'),
    );
    expect(revisionRequired.stage).toBe('revision-required');
    expect(revisionRequired.gate1Review).toMatchObject({
      decision: 'revise',
      replacementProposalRequired: true,
    });
    await expect(fixture.host.submitRevision({
      workspaceId: 'target-workspace',
      replacementProposal: proposal,
    })).rejects.toThrow('distinct');

    const replacement = proposalFor(ir, { suffix: 'revision-2', name: 'Reviewed Payments' });
    const awaiting = await fixture.host.submitRevision({
      workspaceId: 'target-workspace',
      replacementProposal: replacement,
    });
    expect(awaiting).toMatchObject({
      stage: 'awaiting-module-review',
      discovery: {
        proposal: { id: replacement.id },
        draftCatalog: { status: 'draft' },
      },
    });
  });

  it('fails Gate1 closed when the repository changes after the proposal was produced', async () => {
    const root = await createTargetWorkspace(initialSource);
    const initial = await analysisFor(root);
    const changed = await analysisFor(root, structurallyChangedSource);
    const ir = bridgeRepositoryStaticAnalysis(initial).unifiedIr;
    const proposal = proposalFor(ir);
    const fixture = hostFixture([initial], proposal, implementationInventory(), changed);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });

    await expect(fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, ir),
    )).rejects.toThrow('changed before Gate1');
    expect(await fixture.host.get('target-workspace')).toMatchObject({
      stage: 'stale',
      latest: { analysis: { snapshotId: changed.snapshotId } },
    });
  });

  it('serializes concurrent mutations so one Gate1 decision cannot overwrite another', async () => {
    const root = await createTargetWorkspace(initialSource);
    const analysis = await analysisFor(root);
    const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
    const proposal = proposalFor(ir);
    const fixture = hostFixture([analysis], proposal);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });

    const [first, second] = await Promise.allSettled([
      fixture.host.submitGate1(gate1Request('target-workspace', proposal, ir, 'accept')),
      fixture.host.submitGate1(gate1Request('target-workspace', proposal, ir, 'reject')),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(await fixture.host.get('target-workspace')).toMatchObject({
      stage: 'reviewed',
      gate1Review: { decision: 'accept' },
    });
  });

  it('marks body-only changes compatible but unusable, and structural changes stale', async () => {
    const root = await createTargetWorkspace(initialSource);
    const initial = await analysisFor(root);
    const bodyOnly = await analysisFor(
      root,
      bodyOnlySource,
    );
    const structurallyChanged = await analysisFor(
      root,
      structurallyChangedSource,
    );
    const initialIr = bridgeRepositoryStaticAnalysis(initial).unifiedIr;
    const proposal = proposalFor(initialIr);
    const inventory = implementationInventory();
    const inventorySpy = vi.spyOn(inventory, 'build');
    const fixture = hostFixture(
      [initial, bodyOnly, bodyOnly, structurallyChanged],
      proposal,
      inventory,
    );
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });
    const reviewed = await fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, initialIr),
    );
    expect(inventorySpy).toHaveBeenCalledTimes(1);

    const compatible = await fixture.host.refresh('target-workspace');
    expect(compatible).toMatchObject({
      stage: 'body-only-compatible',
      freshness: { status: 'body-only-compatible' },
    });
    const callable = initialIr.entities.find((entity) => entity.kind === 'callable')!;
    await expect(fixture.host.getTargetContext({
      workspaceId: 'target-workspace',
      snapshotId: reviewed.accepted!.snapshot!.id,
      snapshotHash: reviewed.accepted!.snapshot!.contentHash,
      entityId: callable.id,
    })).rejects.toThrow('body-only-compatible');
    expect(inventorySpy).toHaveBeenCalledTimes(1);

    const bodyIr = bridgeRepositoryStaticAnalysis(bodyOnly).unifiedIr;
    const rebaseRequest = {
      workspaceId: 'target-workspace',
      expectedModuleSnapshotId: reviewed.accepted!.snapshot!.id,
      expectedModuleSnapshotHash: reviewed.accepted!.snapshot!.contentHash,
      expectedCatalogId: reviewed.accepted!.catalog.id,
      expectedCatalogHash: reviewed.accepted!.catalog.contentHash,
      expectedLatestAnalysisSnapshotId: bodyOnly.snapshotId,
      expectedLatestIrId: bodyIr.id,
      expectedLatestIrHash: bodyIr.contentHash,
    };
    await expect(fixture.host.rebaseBodyOnly({
      ...rebaseRequest,
      expectedLatestIrHash: '0'.repeat(64),
    })).rejects.toThrow('stale');
    expect((await fixture.host.get('target-workspace'))?.stage).toBe('body-only-compatible');

    const awaitingReview = await fixture.host.rebaseBodyOnly(rebaseRequest);
    expect(awaitingReview).toMatchObject({
      stage: 'awaiting-module-review',
      discovery: {
        proposal: {
          sourceIrId: bodyIr.id,
          sourceIrHash: bodyIr.contentHash,
          status: 'awaiting-review',
        },
        draftCatalog: { status: 'draft' },
      },
    });
    expect(fixture.discoverModules).toHaveBeenCalledTimes(1);
    expect(inventorySpy).toHaveBeenCalledTimes(1);

    const stillAwaitingReview = await fixture.host.refresh('target-workspace');
    expect(stillAwaitingReview).toMatchObject({
      stage: 'awaiting-module-review',
      discovery: { proposal: { id: awaitingReview.discovery!.proposal.id } },
    });

    const rebasedProposal = awaitingReview.discovery!.proposal;
    expect(rebasedProposal.assignments[0]?.fileId).toBe(bodyIr.files[0]?.id);
    expect(rebasedProposal.assignments[0]?.fileId).not.toBe(initialIr.files[0]?.id);
    const rereviewed = await fixture.host.submitGate1(
      gate1Request('target-workspace', rebasedProposal, bodyIr),
    );
    expect(rereviewed.stage).toBe('reviewed');
    expect(inventorySpy).toHaveBeenCalledTimes(2);
    expect(rereviewed.accepted!.snapshot!.id).not.toBe(reviewed.accepted!.snapshot!.id);
    expect(rereviewed.accepted!.snapshot!.assessments.map((assessment) => assessment.id))
      .not.toEqual(reviewed.accepted!.snapshot!.assessments.map((assessment) => assessment.id));

    const stale = await fixture.host.refresh('target-workspace');
    expect(stale).toMatchObject({
      stage: 'stale',
      freshness: { status: 'stale' },
    });
    expect(stale.freshness?.reasonCodes).toContain('structure-changed');
  });

  it('fails a body-only boundary rebase closed when declaration identity is ambiguous', async () => {
    const root = await createTargetWorkspace(initialSource);
    const initial = withAmbiguousCallableIdentity(await analysisFor(root));
    const bodyOnly = withAmbiguousCallableIdentity(await analysisFor(root, bodyOnlySource));
    const initialIr = bridgeRepositoryStaticAnalysis(initial).unifiedIr;
    const bodyIr = bridgeRepositoryStaticAnalysis(bodyOnly).unifiedIr;
    const proposal = proposalFor(initialIr);
    const inventory = implementationInventory();
    const inventorySpy = vi.spyOn(inventory, 'build');
    const fixture = hostFixture([initial, bodyOnly], proposal, inventory);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });
    const reviewed = await fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, initialIr),
    );
    const compatible = await fixture.host.refresh('target-workspace');
    expect(compatible.stage).toBe('body-only-compatible');

    await expect(fixture.host.rebaseBodyOnly({
      workspaceId: 'target-workspace',
      expectedModuleSnapshotId: reviewed.accepted!.snapshot!.id,
      expectedModuleSnapshotHash: reviewed.accepted!.snapshot!.contentHash,
      expectedCatalogId: reviewed.accepted!.catalog.id,
      expectedCatalogHash: reviewed.accepted!.catalog.contentHash,
      expectedLatestAnalysisSnapshotId: bodyOnly.snapshotId,
      expectedLatestIrId: bodyIr.id,
      expectedLatestIrHash: bodyIr.contentHash,
    })).rejects.toThrow('ambiguous');
    expect(await fixture.host.get('target-workspace')).toMatchObject({
      stage: 'stale',
      failure: expect.stringContaining('failed closed'),
    });
    expect(fixture.discoverModules).toHaveBeenCalledTimes(1);
    expect(inventorySpy).toHaveBeenCalledTimes(1);
    for (const port of Object.values(fixture.forbidden)) expect(port).not.toHaveBeenCalled();
  });

  it('persists an accepted Gate1 decision when status detection fails and supports a bounded retry', async () => {
    const root = await createTargetWorkspace(initialSource);
    const analysis = await analysisFor(root);
    const ir = bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
    const proposal = proposalFor(ir);
    const validInventory = implementationInventory();
    let attempt = 0;
    const inventory: TargetWorkspaceImplementationInventoryPort = {
      async build(request, signal) {
        attempt += 1;
        if (attempt === 1) throw new Error('detector unavailable');
        return validInventory.build(request, signal);
      },
    };
    const fixture = hostFixture([analysis], proposal, inventory);
    await fixture.host.initialize({ workspaceId: 'target-workspace', repositoryRoot: root });
    await expect(fixture.host.submitGate1(
      gate1Request('target-workspace', proposal, ir),
    )).rejects.toThrow('detector unavailable');
    const failed = await fixture.host.get('target-workspace');
    expect(failed).toMatchObject({
      stage: 'status-inventory-failed',
      gate1Review: { decision: 'accept' },
      accepted: { catalog: { status: 'active' } },
      failure: 'detector unavailable',
    });

    const retried = await fixture.host.rebuildImplementationInventory('target-workspace');
    expect(retried.stage).toBe('reviewed');
    expect(retried.accepted?.snapshot).toBeDefined();
    expect(attempt).toBe(2);
    const accepted = retried.accepted!;
    const reproduced = await validInventory.build({
      repositoryRoot: root,
      analysis: accepted.analysis,
      ir: accepted.ir,
      proposal: accepted.proposal,
      review: accepted.review,
      catalog: accepted.catalog,
      producer: accepted.snapshot!.producer,
      createdAt: accepted.review.decidedAt,
    });
    expect(reproduced.id).toBe(accepted.snapshot!.id);
    expect(reproduced.contentHash).toBe(accepted.snapshot!.contentHash);
  });
});
