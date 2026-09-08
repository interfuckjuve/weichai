import { describe, expect, it, vi } from 'vitest';
import { buildStructuralIndex } from '@forexplore/code-indexer';
import { indexModuleHierarchy, type ModuleHierarchyDecision, type ModuleHierarchyDecisionRequest, type ModuleHierarchyPlanner, type ProjectModuleProposal } from '@forexplore/contracts';
import { buildAdaptiveModuleProposal, type AdaptiveModuleOptions } from './module-hierarchy.js';
import { projectAnalysisObjective, projectPlanHash, validateProjectResult } from './project-analysis.js';

const files = [
  { relativePath: 'package.json', content: '{"name":"adaptive-example"}' },
  { relativePath: 'api/main.ts', content: 'export function api() { return true; }' },
  { relativePath: 'engine/edit/apply.ts', content: 'import { store } from "../../storage/store"; import { document } from "../model/document"; export function apply() { return store(document()); }' },
  { relativePath: 'engine/model/document.ts', content: 'export function document() { return "document"; }' },
  { relativePath: 'engine/model/state.ts', content: 'export function state() { return "state"; }' },
  { relativePath: 'storage/store.ts', content: 'export function store(value: string) { return value; }' },
  { relativePath: 'storage/cache.ts', content: 'export function cache() { return true; }' },
];

function evidence(request: ModuleHierarchyDecisionRequest) {
  return [...new Set(request.candidates.flatMap((candidate) => candidate.evidenceIds))].slice(0, 8);
}
function stop(request: ModuleHierarchyDecisionRequest, stopReason: 'cohesive' | 'insufficient-evidence' = 'cohesive'): ModuleHierarchyDecision {
  return { action: 'stop', name: request.name, nodeKind: request.name === 'engine' ? 'subsystem' : 'module',
    description: 'A cohesive implementation responsibility', reason: 'The supplied declarations share one responsibility',
    evidenceIds: evidence(request), stopReason };
}
function split(request: ModuleHierarchyDecisionRequest): ModuleHierarchyDecision {
  return { action: 'split', name: request.name, nodeKind: request.name === 'engine' ? 'subsystem' : 'module',
    description: 'Coordinates independent responsibilities', reason: 'The candidate responsibilities have distinct boundaries',
    evidenceIds: evidence(request), children: request.candidates.map((candidate) => ({ name: candidate.name,
      nodeKind: candidate.name === 'engine' ? 'subsystem' : 'module', description: `Responsibility implemented in ${candidate.relativePath}`,
      groupIds: [candidate.id], evidenceIds: candidate.evidenceIds })) };
}
const variablePlanner: ModuleHierarchyPlanner = { decide: async (request) =>
  request.candidates.length >= 2 && (request.nodeId.startsWith('project:') || ['engine', 'model'].includes(request.name)) ? split(request) : stop(request) };

async function build(input = files, options: AdaptiveModuleOptions = {}) {
  const index = buildStructuralIndex({ repositoryId: 'repo', analysisRevision: 'revision', files: input }).index;
  const project = index.projects.find((project) => project.relativePath === '') ?? index.projects[0]!;
  const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId: project.projectId };
  const proposal = await buildAdaptiveModuleProposal(index, scope, projectAnalysisObjective, options);
  const receipt = [...new Set([...proposal.modules.flatMap((module) => module.evidenceIds), ...(proposal.dependencies ?? []).flatMap((edge) => edge.evidenceIds)])];
  const coverage = validateProjectResult(index, scope, { proposal, evidence: { ...scope, analysisHash: index.analysisHash,
    planHash: projectPlanHash(proposal), evidenceIds: receipt } });
  expect(coverage?.assigned).toBe(index.files.filter((file) => file.projectId === scope.projectId).length);
  expect(coverage?.unassigned).toEqual([]);
  return { index, scope, proposal, tree: indexModuleHierarchy(proposal.modules) };
}

function assertOwnership(proposal: ProjectModuleProposal) {
  const tree = indexModuleHierarchy(proposal.modules);
  const files = proposal.modules.flatMap((module) => module.sourceFiles);
  expect(new Set(files).size).toBe(files.length);
  for (const module of proposal.modules) {
    const children = tree.childrenById.get(module.id)!;
    if (children.length) {
      expect(children.length).toBeGreaterThanOrEqual(2);
      expect(module.sourceFiles).toEqual([]); expect(module.symbolKeys).toEqual([]);
      expect(module.refinement?.state).toBe('split');
    } else expect(module.sourceFiles.length).toBeGreaterThan(0);
    expect(module.metrics?.fileCount).toBe(tree.sourceFiles(module.id).files.length);
  }
}

describe('adaptive module hierarchy builder', () => {
  it('publishes root functionality and keeps refinement rationale out of module purpose', async () => {
    const { proposal } = await build(files, { planner: { decide: async (request) => ({ ...stop(request),
      description: 'Provides document editing with durable storage and cached model state.',
      reason: 'The indexed declarations share one responsibility.' }) } });
    expect(proposal.summary).toBe('Provides document editing with durable storage and cached model state.');
    expect(proposal.modules[0]).toMatchObject({ description: proposal.summary, purpose: proposal.summary,
      refinement: { reason: 'The indexed declarations share one responsibility.' } });
  });

  it.each(['budget', 'failure'] as const)('preserves model responsibilities when child refinement stops due to %s', async (mode) => {
    let rootDecision: ModuleHierarchyDecision | undefined;
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => {
      if (!request.nodeId.startsWith('project:')) throw new Error('Child model unavailable.');
      rootDecision = split(request);
      return { ...rootDecision, description: 'Coordinates document APIs, editing state and durable storage.' };
    });
    const { proposal } = await build(files, { planner: { decide }, ...(mode === 'budget' ? { maxModelCalls: 1 } : {}) });
    expect(proposal.summary).toBe('Coordinates document APIs, editing state and durable storage.');
    expect(rootDecision?.action).toBe('split');
    if (rootDecision?.action !== 'split') throw new Error('Expected root split.');
    expect(proposal.modules).toHaveLength(rootDecision.children.length);
    for (const child of rootDecision.children) {
      expect(proposal.modules.find((module) => module.name === child.name)).toMatchObject({
        name: child.name, description: child.description.trim(), purpose: child.description.trim(), nodeKind: child.nodeKind,
        evidenceIds: child.evidenceIds, refinement: { state: 'deferred', decisionSource: 'structural',
          reason: expect.stringContaining(mode === 'budget' ? 'budget' : 'unavailable') },
      });
    }
    expect(proposal.hierarchy?.modelDecisionCount).toBe(1);
    assertOwnership(proposal);
  });

  it('allows different branches to stop at different depths and records model boundaries', async () => {
    const { proposal, tree } = await build(files, { planner: variablePlanner });
    assertOwnership(proposal);
    const leaves = proposal.modules.filter((module) => !tree.childrenById.get(module.id)!.length);
    const depths = new Set(leaves.map((module) => tree.depthById.get(module.id)));
    expect(depths.has(0)).toBe(true); expect(depths.has(2)).toBe(true);
    const engine = proposal.modules.find((module) => module.name === 'engine')!;
    expect(engine.nodeKind).toBe('subsystem');
    expect(engine.refinement).toMatchObject({ state: 'split', decisionSource: 'model' });
    expect(proposal.hierarchy?.modelDecisionCount).toBeGreaterThan(1);
    expect(proposal.hierarchy?.deferredCount).toBe(0);
    expect(proposal.hierarchy?.maxDepth).toBe(3);
  });

  it('rolls real internal dependency evidence up to disjoint ancestor scopes', async () => {
    const { proposal, tree, index } = await build(files, { planner: variablePlanner });
    const engine = proposal.modules.find((module) => module.name === 'engine')!;
    const storage = proposal.modules.find((module) => module.name === 'storage')!;
    const implementation = proposal.modules.find((module) => module.sourceFiles.includes('engine/edit/apply.ts'))!;
    const edges = proposal.dependencies!;
    expect(edges.some((edge) => edge.moduleId === engine.id && edge.dependsOnModuleId === storage.id)).toBe(true);
    expect(edges.some((edge) => edge.moduleId === implementation.id && edge.dependsOnModuleId === storage.id)).toBe(true);
    const realEvidence = new Set(index.dependencyEdges.map((edge) => `dependency:${edge.dependencyEdgeId}`));
    for (const edge of edges) {
      expect(edge.evidenceIds.every((id) => realEvidence.has(id))).toBe(true);
      const from = new Set(tree.sourceFiles(edge.moduleId).files);
      expect(tree.sourceFiles(edge.dependsOnModuleId).files.every((file) => !from.has(file))).toBe(true);
      expect(tree.byId.get(edge.moduleId)!.dependsOn).toContain(edge.dependsOnModuleId);
    }
  });

  it('uses a single structural leaf for a small source scope', async () => {
    const { proposal } = await build(files.slice(0, 2));
    expect(proposal.modules).toHaveLength(1);
    expect(proposal.modules[0]!.refinement).toMatchObject({ state: 'leaf', decisionSource: 'structural' });
    expect(proposal.hierarchy?.modelDecisionCount).toBe(0);
    assertOwnership(proposal);
  });

  it('does not expose parser batch boundaries as arbitrary 64-file modules', async () => {
    const flat = [files[0]!, ...Array.from({ length: 130 }, (_, i) => ({ relativePath: `flat/item${i}.ts`, content: `export function item${i}() { return ${i}; }` }))];
    const { proposal } = await build(flat);
    assertOwnership(proposal);
    expect(proposal.modules.some((module) => module.sourceFiles.length === 130)).toBe(true);
    expect(proposal.modules.some((module) => module.sourceFiles.length === 64)).toBe(false);
    expect(proposal.modules.find((module) => module.sourceFiles.length === 130)!.refinement?.state).toBe('deferred');
    const coherent = await build(flat, { planner: { decide: async (request) => stop(request) } });
    expect(coherent.proposal.modules).toHaveLength(1);
    expect(coherent.proposal.modules[0]!.sourceFiles).toHaveLength(131);
    expect(coherent.proposal.modules[0]!.refinement).toMatchObject({ state: 'leaf', decisionSource: 'model' });
  });

  it('rejects invalid model ownership and preserves full coverage in structural fallback', async () => {
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => {
      const result = split(request);
      if (result.action === 'split') result.children[0]!.groupIds = ['invented-group'];
      return result;
    });
    const { proposal } = await build(files, { planner: { decide }, maxModelCalls: 1 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(proposal.hierarchy?.modelDecisionCount).toBe(0);
    expect(proposal.hierarchy?.deferredCount).toBeGreaterThan(0);
    expect(proposal.risks?.join(' ')).toContain('invalid');
    assertOwnership(proposal);
  });

  it('marks an indivisible flat inventory as deferred without calling a model with no candidates', async () => {
    const flat = Array.from({ length: 130 }, (_, i) => ({ relativePath: `flat/item${i}.ts`, content: `export function item${i}() { return ${i}; }` }));
    const decide = vi.fn(variablePlanner.decide);
    const { proposal } = await build(flat, { planner: { decide } });
    expect(decide).not.toHaveBeenCalled();
    expect(proposal.modules).toHaveLength(1);
    expect(proposal.modules[0]!.sourceFiles).toHaveLength(130);
    expect(proposal.modules[0]!.refinement?.state).toBe('deferred');
    assertOwnership(proposal);
  });

  it('checks the total deadline again after a model returns a split decision', async () => {
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => {
      const until = performance.now() + 20;
      while (performance.now() < until) { /* Simulate synchronous model response processing past the deadline. */ }
      return split(request);
    });
    const { proposal } = await build(files, { planner: { decide }, maxDurationMs: 10, modelTimeoutMs: 1000 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(proposal.modules).toHaveLength(1);
    expect(proposal.modules[0]!.refinement).toMatchObject({ state: 'deferred', decisionSource: 'budget' });
    expect(proposal.modules[0]!.refinement?.reason).toContain('deadline');
    assertOwnership(proposal);
  });

  it('bounds model calls, node count and depth while leaving explicit deferred branches', async () => {
    const decide = vi.fn(variablePlanner.decide);
    const limitedCalls = await build(files, { planner: { decide }, maxModelCalls: 1 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(limitedCalls.proposal.hierarchy?.deferredCount).toBeGreaterThan(0);
    assertOwnership(limitedCalls.proposal);
    const limitedNodes = await build(files, { planner: variablePlanner, maxNodes: 1 });
    expect(limitedNodes.proposal.modules).toHaveLength(1);
    expect(limitedNodes.proposal.modules[0]!.refinement).toMatchObject({ state: 'deferred', decisionSource: 'budget' });
    const limitedDepth = await build(files, { planner: variablePlanner, maxDepth: 1 });
    expect([...limitedDepth.tree.depthById.values()].every((depth) => depth === 0)).toBe(true);
    expect(limitedDepth.proposal.hierarchy?.deferredCount).toBeGreaterThan(0);
    assertOwnership(limitedDepth.proposal);
  });

  it('distinguishes insufficient evidence from a completed coherent leaf', async () => {
    const { proposal } = await build(files, { planner: { decide: async (request) => stop(request, 'insufficient-evidence') } });
    expect(proposal.modules).toHaveLength(1);
    expect(proposal.modules[0]!.refinement).toMatchObject({ state: 'deferred', decisionSource: 'model' });
    expect(proposal.hierarchy?.deferredCount).toBe(1);
    expect(proposal.hierarchy?.modelDecisionCount).toBe(1);
  });

  it('times out a noncooperating planner and honors explicit cancellation', async () => {
    const decide = vi.fn(async () => new Promise<ModuleHierarchyDecision>(() => {}));
    const { proposal } = await build(files, { planner: { decide }, maxModelCalls: 1, modelTimeoutMs: 10 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(proposal.hierarchy?.deferredCount).toBeGreaterThan(0);
    assertOwnership(proposal);
    const cancelled = vi.fn(variablePlanner.decide);
    await expect(build(files, { planner: { decide: cancelled }, signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(cancelled).not.toHaveBeenCalled();
  });
});
