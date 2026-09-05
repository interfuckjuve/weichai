import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleTarget } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectPlanHash, projectAnalysisObjective } from './index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const target: ModuleTarget = { id: 'target', kind: 'module', name: 'Payment', path: 'Payment.cs', language: 'C#',
  signature: 'SubmitPayment, RecoverPayment', module: { sourceFiles: ['Payment.cs'], coreApis: ['SubmitPayment', 'RecoverPayment'], dependsOn: [] } };

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'module-matching-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"name":"payment"}');
  await writeFile(path.join(root, 'payment.ts'), 'export function submitPayment() { return true; }');
  await writeFile(path.join(root, 'receipt.ts'), 'export function receipt() { return "accepted"; }');
  const store = new InMemoryIndexStore();
  const runtime = await createCodeIntelligenceRuntime({ store });
  await runtime.registry.register({ repositoryId: 'history', localPath: root, role: 'history', displayName: 'History' });
  const run = await runtime.coordinator.run({ repositoryId: 'history' });
  const index = (await store.getStructuralIndex(run.scope))!;
  const scope = { ...run.scope, projectId: index.projects[0]!.projectId };
  const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => {
    const proposal = { ...run.scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Payment module',
      modules: [{ id: 'payments', name: 'Payment processing', kind: 'feature', description: 'Submit payments and retain receipts',
        language: 'TypeScript', coreApis: ['submitPayment'], sourceFiles: index.files.map((file) => file.relativePath),
        symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }] };
    return { proposal, evidence: { ...run.scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
  } });
  await analysis.ensure(scope);
  const ready = await analysis.read(scope);
  expect(ready.state, ready.error).toBe('ready');
  return { runtime, store, scope, index };
}

describe('module-to-module matching', () => {
  it('returns the complete module once across multiple views without hydrating the full index', async () => {
    const { runtime, store, index } = await setup();
    for (const method of ['getStructuralIndex', 'listSearchDocuments', 'listModuleArtifacts', 'listSymbols', 'listFiles'] as const) {
      vi.spyOn(store, method).mockRejectedValue(new Error(`Unbounded access: ${method}`));
    }
    const results = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'module', title: 'Payment processing', language: 'TypeScript',
      sourceModule: { moduleId: 'payments', sourceFiles: index.files.map((file) => file.relativePath) },
      moduleMatch: { matchedApis: ['SubmitPayment'], missingApis: ['RecoverPayment'], verification: 'interface-only' } });
    expect(results[0]!.preview).toContain('submitPayment');
    expect(results[0]!.preview).toContain('receipt');
  });

  it('does not turn empty recall into an unbounded summary scan', async () => {
    const { runtime, store } = await setup();
    vi.spyOn(store, 'searchSearchDocuments').mockResolvedValue([]);
    const list = vi.spyOn(store, 'listSearchDocuments').mockRejectedValue(new Error('No fallback'));
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an artifact whose proposal no longer matches its evidence hash', async () => {
    const { runtime, store } = await setup();
    const get = store.getModuleArtifacts.bind(store);
    vi.spyOn(store, 'getModuleArtifacts').mockImplementation(async (scope, ids) => {
      const records = await get(scope, ids);
      return records.map((record) => ({ ...record, planHash: 'tampered' }));
    });
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
  });

  it('bounds preview reads while retaining the complete source manifest', async () => {
    const { runtime, store } = await setup();
    const preview = vi.spyOn(store, 'getSourcePreview').mockResolvedValue({ text: 'x'.repeat(4_000), truncated: true });
    const result = await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] });
    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview.mock.calls.every(([, , maxChars]) => maxChars === 4_000)).toBe(true);
    expect(result[0]!.moduleMatch?.previewTruncated).toBe(true);
    expect(result[0]!.sourceModule?.sourceFiles).toHaveLength(3);
    expect(result[0]!.preview.length).toBeLessThan(12_200);
  });

  it('honors cancellation before touching the repository', async () => {
    const { runtime, store } = await setup();
    const read = vi.spyOn(store, 'getRepository');
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] },
      AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a revision change during source preview', async () => {
    const { runtime, store } = await setup();
    const read = store.getSourceText.bind(store);
    vi.spyOn(store, 'getSourceText').mockImplementation(async (scope, file) => {
      const repository = (await store.getRepository(scope.repositoryId))!;
      await store.putRepository({ ...repository, activeRevision: 'new-revision' });
      return read(scope, file);
    });
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).rejects.toThrow('revision changed');
  });

  it('excludes target repositories and bounds corpus size', async () => {
    const { runtime, store } = await setup();
    await store.putRepository({ ...(await store.getRepository('history'))!, role: 'target' });
    expect(await runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: ['history'] })).toEqual([]);
    await expect(runtime.moduleImplementationSearch.search({ target, requirement: 'payment', topK: 5, repositoryIds: Array.from({ length: 33 }, (_, i) => String(i)) })).rejects.toThrow('32');
  });
});
