import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceTranslationRequest, WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslationRuntime } from './workspace-translation-runtime.js';
import type { WorkspaceTranslationModelClient } from './workspace-translation-agent.js';
import type { DeepSeekToolCompletion, DeepSeekToolMessage } from './deepseek-client.js';
import { createHttpServer } from './http-server.js';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from '@forexplore/code-intelligence-service';

const roots: string[] = [], runtimes: WorkspaceTranslationRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const call = (name: string, args = {}): DeepSeekToolCompletion => ({ content: '', toolCalls: [{ id: `tool-${name}`, name, arguments: JSON.stringify(args) }] });
const good = 'export function limit(value) { if (value < 0) throw new Error("negative"); return value + 1; }\n';
const bad = 'export function limit(value) { return value + 1; }\n';
const request: WorkspaceTranslationRequest = { spec: 'Increment nonnegative input and reject negative input.', sourceLanguage: 'Java', targetLanguage: 'JavaScript',
  context: [{ id: 'source', kind: 'source', content: 'int limit(int value) { if (value < 0) throw new IllegalArgumentException(); return value + 1; }' }],
  workspaceFiles: ['target.mjs', 'verify.mjs'], writeFiles: ['target.mjs'] };
const plan = { summary: 'Preserve boundary behavior', mappings: [{ source: 'limit', targetPath: 'target.mjs', targetSymbol: 'limit' }], dependencies: [],
  steps: [{ id: 'implement', description: 'Implement and validate limit', files: ['target.mjs'], dependsOn: [] }] };
function scripted(steps: Array<DeepSeekToolCompletion | ((messages: readonly DeepSeekToolMessage[]) => DeepSeekToolCompletion)>): WorkspaceTranslationModelClient {
  let turn = 0;
  return { complete: async messages => { const next = steps[turn++]; if (!next) throw new Error('Unexpected model turn'); return typeof next === 'function' ? next(messages) : next; } };
}
const prefix = (content = good) => [call('submit_plan', plan), call('read_file', { path: 'target.mjs' }),
  call('write_file', { path: 'target.mjs', expectedHash: hash('// original\n'), content }), call('complete_step', { stepId: 'implement' }), call('compile')];
async function setup(client: WorkspaceTranslationModelClient, verification = true) {
  const root = await mkdtemp(join(tmpdir(), 'huawei-translation-')); roots.push(root);
  await writeFile(join(root, 'target.mjs'), '// original\n');
  await writeFile(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import { limit } from "./target.mjs"; assert.equal(limit(0), 1); assert.equal(limit(9), 10); assert.throws(() => limit(-1), /negative/);\n');
  const options = { workspaceRoot: root, compileCommand: { executable: process.execPath, args: ['--check', 'target.mjs'] }, client, maxModelTurns: 30,
    ...(verification ? { verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs'] } } : {}) };
  const runtime = new WorkspaceTranslationRuntime(options); runtimes.push(runtime);
  return { root, runtime, options };
}
async function finished(runtime: WorkspaceTranslationRuntime, id: string) {
  for (let i = 0; i < 250; i++) {
    const value = runtime.get(id);
    if (['completed', 'failed', 'cancelled'].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Translation did not finish');
}

describe('workspace behavioral acceptance', () => {
  it('carries revision-pinned retrieved source through multi-file generation and real behavioral verification', async () => {
    const library = 'export function checked(value) { if (value < 0) throw new Error("negative"); return value; }\n';
    const wrapper = 'import { checked } from "./checked.mjs"; export function limit(value) { return checked(value) + 1; }\n';
    const multiPlan = { ...plan, steps: [
      { id: 'library', description: 'Translate input validation', files: ['checked.mjs'], dependsOn: [] },
      { id: 'implement', description: 'Compose the entry point', files: ['target.mjs'], dependsOn: ['library'] },
    ] };
    const { runtime, root } = await setup(scripted([call('submit_plan', multiPlan), call('read_file', { path: 'checked.mjs' }),
      call('write_file', { path: 'checked.mjs', expectedHash: null, content: library }), call('complete_step', { stepId: 'library' }),
      call('read_file', { path: 'target.mjs' }), call('write_file', { path: 'target.mjs', expectedHash: hash('// original\n'), content: wrapper }),
      call('complete_step', { stepId: 'implement' }), call('compile'), call('run_tests'), call('finish')]));
    const sourceRoot = join(root, 'reference'); await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'Limit.java'), 'public class Limit { public int limit(int value) { if (value < 0) throw new IllegalArgumentException(); return value + 1; } }');
    const intelligence = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await intelligence.registry.register({ repositoryId: 'reference', role: 'history', localPath: sourceRoot });
    const indexed = await intelligence.coordinator.run({ repositoryId: 'reference' });
    const packet = await intelligence.taskRetrieval.search({ requestId: 'limit-source', requirement: 'limit', granularity: 'function', scopes: [indexed.scope], budget: { maxTokens: 3000, maxLatencyMs: 30000 } });
    expect(packet.evidence.some(item => item.content.includes('IllegalArgumentException'))).toBe(true);
    const translated = runtime.start({ ...request, workspaceFiles: [...request.workspaceFiles, 'checked.mjs'], writeFiles: ['checked.mjs', 'target.mjs'],
      context: packet.evidence.map(item => ({ id: item.evidenceId, kind: 'source', content: item.content, path: item.relativePath, repository: item.repositoryId, revision: item.analysisRevision })) });
    const result = await finished(runtime, translated.id);
    expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified', completedSteps: ['library', 'implement'] });
    expect(result.changes).toHaveLength(2);
    expect(result.request.context.every(item => item.revision === indexed.scope.analysisRevision)).toBe(true);
    expect(result.verification?.runs[0]?.success).toBe(true);
    runtime.rollback(result.id);
    await expect(readFile(join(root, 'checked.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
  });
  it('rejects compile-only completion, repairs a real failed behavior, and supports restart-safe rollback', async () => {
    const { runtime, root, options } = await setup(scripted([...prefix(bad), call('run_tests'), call('finish'), messages => {
      expect(messages.at(-1)?.content).toContain('passing behavioral verification');
      return call('read_file', { path: 'target.mjs' });
    }, call('write_file', { path: 'target.mjs', expectedHash: hash(bad), content: good }), call('complete_step', { stepId: 'implement' }),
    call('compile'), call('run_tests'), call('finish')]));
    const final = await finished(runtime, runtime.start(request).id);
    expect(final).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    expect(final.verification?.runs.map(value => value.success)).toEqual([false, true]);
    expect(final.verification?.runs.every(value => value.filesUnchanged && value.sourceSnapshot.length === 64 && value.planHash.length === 64)).toBe(true);
    await runtime.shutdown();
    const restored = new WorkspaceTranslationRuntime(options); runtimes.push(restored);
    expect(restored.get(final.id).acceptance).toBe('behavior-verified');
    expect(restored.rollback(final.id).status).toBe('rolled-back');
    expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
  });

  it('requires a new verification after source changes following successful tests', async () => {
    const { runtime } = await setup(scripted([...prefix(), call('run_tests'), call('read_file', { path: 'target.mjs' }),
      call('write_file', { path: 'target.mjs', expectedHash: hash(good), content: bad }), call('complete_step', { stepId: 'implement' }), call('compile'), call('finish'),
      messages => { expect(messages.at(-1)?.content).toContain('passing behavioral verification'); return call('report_blocker', { reason: 'Verification must be repeated' }); }]));
    const result = await finished(runtime, runtime.start(request).id);
    expect(result).toMatchObject({ status: 'failed', acceptance: 'compilation-only' });
  });

  it('rejects writes to criteria and detects criteria changes outside the task', async () => {
    let root = '';
    const state = await setup(scripted([...prefix(), call('run_tests'), asyncLast])); root = state.root;
    function asyncLast() { return call('finish'); }
    expect(() => state.runtime.start({ ...request, writeFiles: ['target.mjs', 'verify.mjs'] })).toThrow('criteria');
    const run = state.runtime.start(request);
    await writeFile(join(root, 'verify.mjs'), '// weakened suite\n');
    const result = await finished(state.runtime, run.id);
    expect(result.status).toBe('failed');
    expect(result.acceptance).toBe('compilation-only');
  });

  it('keeps unconfigured runs compilation-only', async () => {
    const { runtime } = await setup(scripted([...prefix(), call('finish')]), false);
    expect(await finished(runtime, runtime.start(request).id)).toMatchObject({ status: 'completed', acceptance: 'compilation-only' });
  });

  it('exposes real verification records and rollback through the authenticated HTTP route', async () => {
    const { runtime, root } = await setup(scripted([...prefix(), call('run_tests'), call('finish')]));
    const token = 'test-huawei-token'.repeat(3);
    const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Unused legacy route'); } }, workspaceTranslation: { runtime, bearerToken: token } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/workspace-translations`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    try {
      expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(request) });
      expect(response.status).toBe(202);
      const started = await response.json() as WorkspaceTranslationRun;
      await finished(runtime, started.id);
      const result = await (await fetch(`${endpoint}/${started.id}`, { headers })).json() as WorkspaceTranslationRun;
      expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
      expect(result.verification?.runs[0]?.exitCode).toBe(0);
      expect((await fetch(`${endpoint}/${started.id}/rollback`, { method: 'POST', headers })).status).toBe(200);
      expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
