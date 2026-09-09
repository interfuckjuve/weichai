import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleHierarchyDecisionRequest, ProjectAnalysisRecord, ProjectAnalysisResult, ProjectAnalysisScope, ProjectModule, StructuralIndex } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from './index.js';
import { ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash, validateProjectResult } from './project-analysis.js';
import { parseModuleHierarchyDecisionRequest } from './module-hierarchy-planner.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-project-analysis-'));
  roots.push(root);
  for (const name of ['a', 'b']) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'package.json'), JSON.stringify({ name }));
    await writeFile(path.join(root, name, 'index.ts'), `export function ${name}() { return 1; }`);
  }
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  await runtime.registry.register({ repositoryId: 'history', role: 'history', localPath: root });
  const run = await runtime.coordinator.run({ repositoryId: 'history' });
  const index = (await runtime.store.getStructuralIndex(run.scope))!;
  const scopes = index.projects.map((p) => ({ ...run.scope, projectId: p.projectId }));
  return { root, runtime, index, scopes };
}

function result(index: StructuralIndex, scope: ProjectAnalysisScope): ProjectAnalysisResult {
  const files = index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath);
  const proposal = {
    repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, analysisHash: index.analysisHash,
    objective: projectAnalysisObjective, summary: `Summary for ${scope.projectId}`, unassignedFiles: [],
    modules: [{ id: 'module', kind: 'feature', name: 'Core', description: 'Core behavior',
      sourceFiles: files, symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }],
  };
  return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
}

function coherentDecision(request: ModuleHierarchyDecisionRequest) {
  return { action: 'stop' as const, name: 'Coherent component', nodeKind: 'module' as const,
    description: 'Small component with one responsibility.', reason: 'The API and manifest describe one component.',
    stopReason: 'cohesive' as const, evidenceIds: request.candidates.flatMap((candidate) => candidate.evidenceIds).slice(0, 2) };
}

function hierarchicalResult(index: StructuralIndex, scope: ProjectAnalysisScope): ProjectAnalysisResult {
  const value = result(index, scope);
  const files = index.files.filter((file) => file.projectId === scope.projectId);
  const children: ProjectModule[] = files.map((file, position) => ({
    id: `child-${position}`, parentId: 'module', name: `Child ${position}`, kind: 'feature', nodeKind: 'module',
    description: 'One implementation unit.', sourceFiles: [file.relativePath],
    symbolKeys: index.symbols.filter((symbol) => symbol.relativePath === file.relativePath).map((symbol) => symbol.symbolKey),
    dependsOn: [], evidenceIds: [`project:${scope.projectId}`], refinement: { state: 'leaf', decisionSource: 'model', reason: 'One coherent unit.' },
    metrics: { fileCount: 1, sourceBytes: file.sizeBytes, symbolCount: index.symbols.filter((symbol) => symbol.relativePath === file.relativePath).length },
  }));
  const parent: ProjectModule = { ...value.proposal.modules[0]!, parentId: null, nodeKind: 'subsystem', sourceFiles: [], symbolKeys: [],
    refinement: { state: 'split', decisionSource: 'model', reason: 'Separate implementation responsibilities.' },
    metrics: { fileCount: files.length, sourceBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      symbolCount: children.reduce((sum, child) => sum + child.metrics!.symbolCount, 0) } };
  value.proposal.modules = [parent, ...children];
  value.proposal.hierarchy = { version: 1, algorithm: 'adaptive-module-tree/v1', maxDepth: 2,
    decisionCount: children.length + 1, modelDecisionCount: children.length + 1, deferredCount: 0 };
  value.evidence.planHash = projectPlanHash(value.proposal);
  return value;
}

describe('project understanding lifecycle', () => {
  it('reuses durable validated decisions after recreating the coordinator', async () => {
    const { runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(request));
    const first = new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } });
    await first.ensure(scope);
    expect((await first.read(scope)).state).toBe('ready');
    const calls = decide.mock.calls.length;
    const artifacts = await runtime.store.listModuleArtifacts(scope);
    expect(artifacts.some(value => value.moduleArtifactId.startsWith('module-decisions:'))).toBe(true);
    const job = artifacts.find(value => value.moduleArtifactId.startsWith('project-job:'))!;
    const payload = { ...structuredClone(job.payload) as ProjectAnalysisRecord, state: 'analyzing' as const };
    await runtime.store.putModuleArtifact({ ...job, payload, contentHash: projectPlanHash(payload).slice('sha256:'.length) });
    const restored = new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } });
    await restored.ensure(scope);
    expect((await restored.read(scope)).state).toBe('ready');
    expect(decide).toHaveBeenCalledTimes(calls);
    await restored.ensure(scope, true);
    expect(decide.mock.calls.length).toBeGreaterThan(calls);
  });
  it('normalizes workbench retry messages before sending strict model evidence', async () => {
    const { runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(parseModuleHierarchyDecisionRequest(request)));
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } });
    const message = { ...scope, type: 'RETRY_PROJECT_ANALYSIS', force: true };
    await projects.ensure(message, true);
    expect(decide).toHaveBeenCalledTimes(1);
    const record = await projects.read(scope);
    expect(record).toMatchObject({ state: 'ready', projection: 'ready', modeling: { strategy: 'agent' } });
    expect(record).not.toHaveProperty('type');
    expect(record).not.toHaveProperty('force');
  });

  it('explicitly rebuilds a persisted flat plan into a hierarchy without rescanning the repository', async () => {
    const { runtime, index, scopes } = await setup();
    const scope = scopes[0]!;
    const legacy = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => result(index, scope) });
    await legacy.ensure(scope);
    expect((await legacy.read(scope)).proposal?.hierarchy).toBeUndefined();
    const scan = vi.spyOn(runtime.coordinator, 'run');
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(request));
    const upgraded = new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } });
    await upgraded.ensure(scope, true);
    const published = await upgraded.read(scope);
    expect(published).toMatchObject({ state: 'ready', projection: 'ready', analysisRevision: index.analysisRevision,
      proposal: { hierarchy: { algorithm: 'adaptive-module-tree/v1', modelDecisionCount: 1 } }, coverage: { total: 2, assigned: 2 } });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    const fullRead = vi.spyOn(runtime.store, 'getStructuralIndex');
    await new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } }).ensure(scope);
    expect(fullRead).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy responsibilities without modeling metadata when a hierarchy planner is added', async () => {
    const { runtime, index, scopes } = await setup();
    const scope = scopes[0]!;
    await new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => result(index, scope) }).ensure(scope);
    for (const artifact of await runtime.store.listModuleArtifacts(scope)) {
      const payload = structuredClone(artifact.payload) as ProjectAnalysisRecord;
      delete payload.modeling;
      await runtime.store.putModuleArtifact({ ...artifact, payload, contentHash: projectPlanHash(payload).slice('sha256:'.length) });
    }
    const artifacts = await runtime.store.listModuleArtifacts(scope);
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(request));
    const fullRead = vi.spyOn(runtime.store, 'getStructuralIndex');
    const reopened = new ProjectAnalysisCoordinator({ store: runtime.store, hierarchyPlanner: { decide } });
    await reopened.ensure(scope);
    const record = await reopened.read(scope);
    expect(record).toMatchObject({ state: 'ready', projection: 'ready', proposal: result(index, scope).proposal });
    expect(record.modeling).toBeUndefined();
    expect(record.proposal?.hierarchy).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
    expect(await runtime.store.listModuleArtifacts(scope)).toEqual(artifacts);
  });

  it('prefers the existing responsibility agent for a small repository even when a hierarchy planner is configured', async () => {
    const { runtime, index, scopes } = await setup();
    const scope = scopes[0]!;
    const plan = vi.fn(async () => result(index, scope));
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(request));
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan, hierarchyPlanner: { decide } });
    await projects.ensure(scope);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(await projects.read(scope)).toMatchObject({ state: 'ready', modeling: { strategy: 'agent' }, proposal: result(index, scope).proposal });
  });

  it('uses bounded hierarchy decisions when the repository exceeds the agent limit even if the selected project is small', async () => {
    const { runtime, index, scopes } = await setup();
    const scope = scopes[0]!;
    expect(index.files).toHaveLength(4);
    expect(index.files.filter((file) => file.projectId === scope.projectId)).toHaveLength(2);
    const plan = vi.fn(async () => result(index, scope));
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => coherentDecision(request));
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan, hierarchyPlanner: { decide }, maxAgentProjectFiles: 3 });
    await projects.ensure(scope);
    expect(plan).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(await projects.read(scope)).toMatchObject({ state: 'ready', proposal: { hierarchy: { modelDecisionCount: 1 } } });
  });

  it.each(['unconfigured', 'failed', 'invalid'] as const)('does not publish a structural tree as an agent result when the model is %s', async (mode) => {
    const { runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const decide = vi.fn(async (request: ModuleHierarchyDecisionRequest) => {
      if (mode === 'failed') throw new Error('Provider unavailable.');
      return { ...coherentDecision(request), evidenceIds: ['invented'] };
    });
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store,
      ...(mode === 'unconfigured' ? {} : { hierarchyPlanner: { decide } }) });
    await projects.ensure(scope);
    const record = await projects.read(scope);
    expect(record.state).toBe('failed');
    expect(record.error).toBeTruthy();
    expect(record.proposal).toBeUndefined();
    expect(record.coverage).toBeUndefined();
    expect(record.planHash).toBeUndefined();
    expect((await runtime.store.listModuleArtifacts(scope)).filter((artifact) => artifact.kind === 'module-summary')).toEqual([]);
    expect((await runtime.store.listSearchDocuments(scope)).filter((document) => document.kind === 'summary')).toEqual([]);
  });

  it('hides a persisted structural baseline by default while leaving it available to explicit capacity tooling', async () => {
    const { runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const baseline = new ProjectAnalysisCoordinator({ store: runtime.store, allowStructuralFallback: true });
    await baseline.ensure(scope);
    expect(await baseline.read(scope)).toMatchObject({ state: 'ready', modeling: { strategy: 'structural' }, coverage: { total: 2, assigned: 2 } });
    const artifacts = await runtime.store.listModuleArtifacts(scope);
    const record = await new ProjectAnalysisCoordinator({ store: runtime.store }).read(scope);
    expect(record).toMatchObject({ state: 'missing', projection: 'pending' });
    expect(record.error).toBeTruthy();
    expect(record.proposal).toBeUndefined();
    expect(record.coverage).toBeUndefined();
    expect(record.planHash).toBeUndefined();
    expect(record.modeling).toBeUndefined();
    expect(await runtime.store.listModuleArtifacts(scope)).toEqual(artifacts);
  });

  it('also hides structural responsibilities when displaying an older repository revision', async () => {
    const { root, runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const baseline = new ProjectAnalysisCoordinator({ store: runtime.store, allowStructuralFallback: true });
    await baseline.ensure(scope);
    await writeFile(path.join(root, 'a/index.ts'), 'export function a() { return 2; }');
    const latest = await runtime.coordinator.run({ repositoryId: 'history', mode: 'incremental' });
    expect(latest.scope.analysisRevision).not.toBe(scope.analysisRevision);
    expect(await baseline.read(scope)).toMatchObject({ state: 'stale', modeling: { strategy: 'structural' }, proposal: expect.any(Object) });
    const hidden = await new ProjectAnalysisCoordinator({ store: runtime.store }).read(scope);
    expect(hidden.proposal).toBeUndefined();
    expect(hidden.coverage).toBeUndefined();
    expect(hidden.planHash).toBeUndefined();
    expect(hidden.modeling).toBeUndefined();
  });

  it('does not reveal structural results from an interrupted project analysis job', async () => {
    const { runtime, scopes } = await setup();
    const scope = scopes[0]!;
    const baseline = new ProjectAnalysisCoordinator({ store: runtime.store, allowStructuralFallback: true });
    await baseline.ensure(scope);
    const job = (await runtime.store.listModuleArtifacts(scope)).find((artifact) => artifact.moduleArtifactId.startsWith('project-job:'))!;
    const payload = { ...structuredClone(job.payload) as ProjectAnalysisRecord, state: 'analyzing' as const };
    await runtime.store.putModuleArtifact({ ...job, payload, contentHash: projectPlanHash(payload).slice('sha256:'.length) });
    const hidden = await new ProjectAnalysisCoordinator({ store: runtime.store }).read(scope);
    expect(hidden).toMatchObject({ state: 'failed', error: expect.stringContaining('中断') });
    expect(hidden.proposal).toBeUndefined();
    expect(hidden.coverage).toBeUndefined();
    expect(hidden.planHash).toBeUndefined();
    expect(hidden.modeling).toBeUndefined();
  });

  it.each(['legacy', 'hierarchy'] as const)('retains the previous agent proposal and its hash when a forced %s rebuild fails', async (mode) => {
    const { runtime, index, scopes } = await setup();
    const scope = scopes[0]!;
    const initial = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => result(index, scope) });
    await initial.ensure(scope);
    const previous = await initial.read(scope);
    const summaryBefore = (await runtime.store.listModuleArtifacts(scope)).find((artifact) => artifact.kind === 'module-summary')!;
    const fail = async (): Promise<never> => { throw new Error('Forced rebuild failed.'); };
    const failed = new ProjectAnalysisCoordinator({ store: runtime.store,
      ...(mode === 'legacy' ? { plan: fail } : { hierarchyPlanner: { decide: fail } }) });
    await failed.ensure(scope, true);
    const record = await failed.read(scope);
    expect(record).toMatchObject({ state: 'failed', error: expect.any(String), planHash: previous.planHash,
      proposal: previous.proposal, coverage: previous.coverage });
    expect((await runtime.store.listModuleArtifacts(scope)).find((artifact) => artifact.kind === 'module-summary')).toEqual(summaryBefore);
  });

  it('validates leaf ownership, ancestry, metrics and refinement states before publishing a hierarchy', async () => {
    const { index, scopes } = await setup();
    const scope = scopes[0]!;
    const valid = hierarchicalResult(index, scope);
    expect(validateProjectResult(index, scope, valid)).toMatchObject({ total: 2, assigned: 2 });
    const mutations: Array<(value: ProjectAnalysisResult) => void> = [
      (value) => { value.proposal.modules[0]!.parentId = value.proposal.modules[1]!.id; },
      (value) => { value.proposal.modules[1]!.parentId = 'missing'; },
      (value) => { value.proposal.modules[0]!.sourceFiles = value.proposal.modules[1]!.sourceFiles; },
      (value) => { value.proposal.modules[0]!.symbolKeys = value.proposal.modules.flatMap((module) => module.symbolKeys); },
      (value) => { value.proposal.modules[0]!.metrics!.fileCount++; },
      (value) => { value.proposal.modules[1]!.metrics!.sourceBytes++; },
      (value) => { value.proposal.modules[0]!.refinement!.state = 'leaf'; },
      (value) => { value.proposal.hierarchy!.maxDepth++; },
      (value) => { value.proposal.hierarchy!.modelDecisionCount = value.proposal.hierarchy!.decisionCount + 1; },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(valid);
      mutate(invalid);
      invalid.evidence.planHash = projectPlanHash(invalid.proposal);
      expect(() => validateProjectResult(index, scope, invalid)).toThrow();
    }
  });

  it('publishes structural baselines only with explicit opt-in and reopens those persisted results', async () => {
    const { runtime, scopes } = await setup();
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, allowStructuralFallback: true });
    await projects.ensure(scopes[0]!);
    const record = await projects.read(scopes[0]!);
    expect(record).toMatchObject({ state: 'ready', projection: 'ready', modeling: { strategy: 'structural' }, coverage: { total: 2, assigned: 2 } });
    expect(record.proposal?.modules.flatMap((module) => module.sourceFiles)).toHaveLength(2);
    const reopened = new ProjectAnalysisCoordinator({ store: runtime.store, allowStructuralFallback: true, plan: async () => { throw new Error('Persisted models must be reused.'); } });
    await reopened.ensure(scopes[0]!);
    expect((await reopened.read(scopes[0]!)).planHash).toBe(record.planHash);
  });

  it('publishes independent projects and reuses summaries across incremental/full scans and coordinator restart', async () => {
    const { runtime, index, scopes } = await setup();
    const plan = vi.fn(async (scope: ProjectAnalysisScope) => result(index, scope));
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
    await Promise.all(scopes.map((scope) => projects.ensure(scope)));
    expect(plan).toHaveBeenCalledTimes(2);
    for (const mode of ['incremental', 'full'] as const) {
      const refreshed = await runtime.coordinator.run({ repositoryId: 'history', mode });
      expect(refreshed.scope.analysisRevision).toBe(index.analysisRevision);
    }
    const reopened = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
    await Promise.all(scopes.map((scope) => reopened.ensure(scope)));
    expect(plan).toHaveBeenCalledTimes(2);
    expect((await reopened.read(scopes[0]!)).proposal?.summary).toContain(scopes[0]!.projectId);
    await reopened.ensure(scopes[0]!, true);
    expect(plan).toHaveBeenCalledTimes(3);
    const artifacts = await runtime.store.listModuleArtifacts(index);
    for (const artifact of artifacts) {
      expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(`sha256:${artifact.contentHash}`).toBe(projectPlanHash(artifact.payload));
      expect(artifact.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(artifacts.filter((a) => a.kind === 'module-summary' && a.status === 'current')).toHaveLength(2);
    expect((await runtime.store.listSearchDocuments(index)).filter((d) => d.kind === 'summary')).toHaveLength(6);
  });

  it('retries a failed projection without making another model request', async () => {
    const { runtime, index, scopes } = await setup();
    const plan = vi.fn(async (scope: ProjectAnalysisScope) => result(index, scope));
    const project = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan, project });
    await projects.ensure(scopes[0]!);
    expect(await projects.read(scopes[0]!)).toMatchObject({ state: 'ready', projection: 'failed' });
    await projects.ensure(scopes[0]!);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(await projects.read(scopes[0]!)).toMatchObject({ state: 'ready', projection: 'ready' });
  });

  it('rejects a late model result and successfully analyzes the latest revision', async () => {
    const { root, runtime, index, scopes } = await setup();
    let release!: (value: ProjectAnalysisResult) => void;
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan: () => new Promise((resolve) => { release = resolve; }) });
    const pending = projects.ensure(scopes[0]!);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await writeFile(path.join(root, 'a/index.ts'), 'export function a() { return 2; }');
    const latest = await runtime.coordinator.run({ repositoryId: 'history', mode: 'incremental' });
    release(result(index, scopes[0]!));
    await pending;
    expect(await projects.read(scopes[0]!)).toMatchObject({ state: 'stale' });
    expect((await runtime.store.listModuleArtifacts(index)).filter((a) => a.kind === 'module-summary')).toHaveLength(0);
    const nextIndex = (await runtime.store.getStructuralIndex(latest.scope))!;
    const next = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async (scope) => result(nextIndex, scope) });
    const nextScope = { ...latest.scope, projectId: scopes[0]!.projectId };
    await next.ensure(nextScope);
    expect(await next.read(nextScope)).toMatchObject({ state: 'ready' });
  });

  it('deduplicates pending tasks and recovers interrupted jobs', async () => {
    const { runtime, index, scopes } = await setup();
    let release!: (value: ProjectAnalysisResult) => void;
    const plan = vi.fn(() => new Promise<ProjectAnalysisResult>((resolve) => { release = resolve; }));
    const projects = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
    const first = projects.ensure(scopes[0]!);
    const duplicate = projects.ensure(scopes[0]!);
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const restarted = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
    expect(await restarted.read(scopes[0]!)).toMatchObject({ state: 'failed', error: expect.stringContaining('中断') });
    release(result(index, scopes[0]!));
    await first;
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('checks hashes, evidence, project ownership and complete file coverage before publishing', async () => {
    const { index, scopes } = await setup();
    const valid = result(index, scopes[0]!);
    expect(validateProjectResult(index, scopes[0]!, valid)?.assigned).toBe(2);
    const mutations = [
      (r: ProjectAnalysisResult) => { r.proposal.analysisRevision = 'wrong'; },
      (r: ProjectAnalysisResult) => { r.proposal.modules[0]!.sourceFiles = []; },
      (r: ProjectAnalysisResult) => { r.proposal.modules[0]!.sourceFiles.push('b/index.ts', 'a/index.ts'); },
      (r: ProjectAnalysisResult) => { r.proposal.modules[0]!.evidenceIds = ['unknown']; },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(valid); mutate(invalid);
      invalid.evidence.planHash = projectPlanHash(invalid.proposal);
      expect(() => validateProjectResult(index, scopes[0]!, invalid)).toThrow();
    }
    valid.evidence.planHash = 'wrong';
    expect(() => validateProjectResult(index, scopes[0]!, valid)).toThrow(/哈希/);
  });
});
