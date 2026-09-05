import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectAnalysisResult, ProjectAnalysisScope, StructuralIndex } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from './index.js';
import { ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash, validateProjectResult } from './project-analysis.js';

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

describe('project understanding lifecycle', () => {
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
