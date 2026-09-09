import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { InMemoryIndexStore, createCodeIntelligenceRuntime, createSemanticQueryHttpServer } from '@forexplore/code-intelligence-service';
import { WorkspaceTranslationHost } from '../../apps/vscode-extension/src/workspace-translation-host';
import { isWebviewToHostMessage } from '../../apps/vscode-extension/src/protocol/messages';
import { WorkspaceTranslationRuntime } from '../../services/adaptation-service/src/workspace-translation-runtime';
import { createHttpServer } from '../../services/adaptation-service/src/http-server';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

it('validates opaque handoff intents and rejects page-supplied paths, source and commands', () => {
  const start = { type: 'WORKSPACE_TRANSLATION', requestId: 'request', action: 'start', profileId: 'profile', packetId: 'packet', evidenceIds: ['evidence'] };
  expect(isWebviewToHostMessage(start)).toBe(true);
  expect(isWebviewToHostMessage({ type: 'WORKSPACE_TRANSLATION', requestId: 'request', action: 'describe' })).toBe(true);
  for (const extra of [{ context: [] }, { writeFiles: ['other.ts'] }, { command: 'echo pass' }, { runId: 'other' }]) {
    expect(isWebviewToHostMessage({ ...start, ...extra })).toBe(false);
  }
  for (const action of ['read', 'cancel', 'resume', 'rollback']) expect(isWebviewToHostMessage({ type: 'WORKSPACE_TRANSLATION', requestId: 'request', action, runId: '12345678-1234-1234-1234-123456789012' })).toBe(true);
});

it('hands cached indexed evidence through authenticated HTTP to behavior verification and restart-safe rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guochuang-handoff-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Limit.java'), 'public class Limit { public int limit(int n) { if (n < 0) throw new IllegalArgumentException(); return n + 1; } }');
  await writeFile(join(root, 'target.mjs'), '// original\n');
  await writeFile(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import { limit } from "./target.mjs"; assert.equal(limit(0), 1); assert.throws(() => limit(-1));');
  const intelligence = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  await intelligence.registry.register({ repositoryId: 'source', role: 'history', localPath: root });
  const indexed = await intelligence.coordinator.run({ repositoryId: 'source' });
  const packet = await intelligence.taskRetrieval.search({ requestId: 'evidence', requirement: 'limit', granularity: 'function', scopes: [indexed.scope], budget: { maxTokens: 3000, maxLatencyMs: 30000 } });
  const source = packet.evidence.find(item => item.relativePath === 'Limit.java')!;
  expect(source).toBeDefined();
  const semantic = createSemanticQueryHttpServer({ queryPort: intelligence.queryPort, taskRetrieval: intelligence.taskRetrieval });
  await new Promise<void>(resolve => semantic.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => semantic.close(error => error ? reject(error) : resolve())));
  const label = { repositoryId: 'source', relativePath: source.relativePath, relevance: 3 };
  const taskFile = join(root, 'tasks.json'), reportFile = join(root, 'report.json');
  await writeFile(taskFile, JSON.stringify([{ id: 'negative-input', request: { requestId: 'evaluation', requirement: 'limit', granularity: 'function', scopes: [indexed.scope], budget: { maxTokens: 3000, maxLatencyMs: 30000 } }, relevant: [label], requiredEvidence: [label] }]));
  await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../scripts/evaluate-guochuang.mts', import.meta.url)),
    '--tasks', taskFile, '--output', reportFile, '--url', `http://127.0.0.1:${(semantic.address() as AddressInfo).port}`]);
  expect(JSON.parse(await readFile(reportFile, 'utf8')).summary).toMatchObject({ tasks: 1, failures: 0, taskSuccessRate: 1, evidenceCoverage: 1 });
  const plan = { summary: 'Preserve boundary behavior', mappings: [{ source: 'limit', targetPath: 'target.mjs', targetSymbol: 'limit' }], dependencies: [],
    steps: [{ id: 'implement', description: 'Implement limit', files: ['target.mjs'], dependsOn: [] }] };
  const calls: Array<[string, unknown]> = [['submit_plan', plan], ['read_file', { path: 'target.mjs' }],
    ['write_file', { path: 'target.mjs', expectedHash: createHash('sha256').update('// original\n').digest('hex'), content: 'export function limit(n) { if (n < 0) throw new Error("negative"); return n + 1; }' }],
    ['complete_step', { stepId: 'implement' }], ['compile', {}], ['run_tests', {}], ['finish', {}]];
  let turn = 0;
  const runtime = new WorkspaceTranslationRuntime({ workspaceRoot: root, compileCommand: { executable: process.execPath, args: ['--check', 'target.mjs'] },
    verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs'] },
    client: { complete: async () => { const [name, args] = calls[turn++]!; return { content: '', toolCalls: [{ id: `call-${turn}`, name, arguments: JSON.stringify(args) }] }; } } });
  cleanup.push(() => runtime.shutdown());
  const token = 'fixed-test-token-with-at-least-32-characters';
  const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('unused'); } }, workspaceTranslation: { runtime, bearerToken: token } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect((await fetch(`${url}/v1/workspace-translations/configuration`)).status).toBe(401);
  const config = { url, token, profile: JSON.stringify({ workspaceRoot: root, sourceLanguage: 'Java', targetLanguage: 'JavaScript', workspaceFiles: ['target.mjs', 'verify.mjs'], writeFiles: ['target.mjs'] }) };
  const host = new WorkspaceTranslationHost(() => config);
  host.remember(packet);
  const describe = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe', action: 'describe' });
  expect(describe).toMatchObject({ type: 'WORKSPACE_TRANSLATION_RESULT', profile: { behavioralVerification: true, writeFiles: ['target.mjs'] } });
  if (describe.type !== 'WORKSPACE_TRANSLATION_RESULT' || !describe.profile) throw new Error('Missing profile');
  const profileId = describe.profile.profileId;
  const invalid = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'invalid', action: 'start', profileId, packetId: packet.packetId, evidenceIds: ['forged'] });
  expect(invalid.type).toBe('WORKSPACE_TRANSLATION_ERROR');
  const intent = { type: 'WORKSPACE_TRANSLATION' as const, requestId: 'start', action: 'start' as const, profileId, packetId: packet.packetId, evidenceIds: [source.evidenceId] };
  expect(await host.handle({ ...intent, profileId: 'stale-profile' })).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR' });
  const [started, duplicate] = await Promise.all([host.handle(intent), host.handle(intent)]);
  if (started.type !== 'WORKSPACE_TRANSLATION_RESULT' || !started.run) throw new Error(JSON.stringify(started));
  expect(duplicate).toEqual(started);
  let run = started.run;
  for (let attempt = 0; attempt < 200 && !['completed', 'failed'].includes(run.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20)); run = runtime.get(run.id);
  }
  expect(run).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
  expect(run.request.context.find(item => item.id === source.evidenceId)).toMatchObject({ content: source.content, revision: indexed.scope.analysisRevision, repository: 'source' });
  expect(run.request.context.at(-1)?.content).toContain('Snapshots');
  const restored = new WorkspaceTranslationHost(() => config);
  const rolled = await restored.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'rollback', action: 'rollback', runId: run.id });
  expect(rolled).toMatchObject({ type: 'WORKSPACE_TRANSLATION_RESULT', run: { status: 'rolled-back' } });
  expect(await readFile(join(root, 'target.mjs'), 'utf8')).toBe('// original\n');
}, 30000);
