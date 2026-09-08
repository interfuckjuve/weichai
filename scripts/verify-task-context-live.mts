import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { getEncoding } from 'js-tiktoken';
import type { ContextPacket, RetrievalGranularity, TaskRetrievalRequest, TaskRetrievalScope, TaskContextEvidence } from '@forexplore/contracts';
import type { PanelInitPayload } from '../apps/vscode-extension/src/protocol/messages.js';
import type { ModuleWorkspacePresentation } from '../apps/vscode-extension/src/ui-types.js';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:4040' },
  'target-root': { type: 'string', default: 'fixtures/code-corpus/commons-fileupload-ts' },
  'reference-root': { type: 'string', multiple: true },
  'wait-ms': { type: 'string', default: '180000' },
  'output-dir': { type: 'string', default: 'logs' },
} });
const endpoint = new URL(values.endpoint!);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Live verification must use a local service.');
const outputDirectory = path.resolve(values['output-dir']!);
const waitMs = Number(values['wait-ms']);
assert(Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 600000, 'wait-ms must be in 0..600000.');
const tokenizer = getEncoding('cl100k_base');
const sourceRoots = new Map<string, string>();
const cachedFiles = new Map<string, { text: string; sha256: string }>();
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = { startedAt, endpoint: endpoint.origin, provider: 'Real HTTP service; no provider mocks', cases: [], passed: false };
const cases = report.cases as Array<Record<string, unknown>>;
let representative: ContextPacket | undefined;

async function post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(route, endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(65000) });
  const text = await response.text();
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

function scopeFor(workspace: ModuleWorkspacePresentation, role: 'target' | 'reference'): TaskRetrievalScope {
  assert(workspace.repositoryId && workspace.revision && workspace.projectId, `${workspace.name}: missing fixed scope`);
  return { repositoryId: workspace.repositoryId, analysisRevision: workspace.revision, projectId: workspace.projectId, role };
}

async function ready(): Promise<PanelInitPayload> {
  const waitingStarted = performance.now();
  const deadline = performance.now() + waitMs;
  let lastError: unknown;
  let lastReportedError = '';
  let lastReportedAt = 0;
  while (true) {
    try {
      const healthResponse = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(10000) });
      assert.equal(healthResponse.status, 200, 'Health endpoint is unavailable.');
      const health = await healthResponse.json() as { status: string; error?: string };
      if (health.status !== 'ready') throw new Error(health.error ?? `Index construction status: ${health.status}.`);
      const messages = await post<Array<{ type: string; payload?: PanelInitPayload }>>('/v1/workbench/message', { type: 'READY' }, AbortSignal.timeout(15000));
      const payload = messages.find((item) => item.type === 'INIT')?.payload;
      assert(payload, 'READY did not return INIT.');
      assert(payload.moduleExplorer.target.repositoryId && payload.moduleExplorer.target.revision, 'Target is not indexed yet.');
      assert(payload.moduleExplorer.target.analysis?.state === 'ready', 'Target modules are not ready yet.');
      assert(payload.moduleExplorer.history.some((item) => item.revision && item.analysis?.state === 'ready'), 'Reference modules are not ready yet.');
      report.readinessWaitMs = Math.round(performance.now() - waitingStarted);
      return payload;
    } catch (error) {
      lastError = error;
      if (performance.now() >= deadline) throw lastError;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReportedError || performance.now() - lastReportedAt >= 30000) {
        console.info(`Waiting for indexed target and reference modules: ${message}`);
        lastReportedError = message;
        lastReportedAt = performance.now();
      }
      await pause(3000);
    }
  }
}

async function sourceEvidenceMatches(item: TaskContextEvidence): Promise<void> {
  const root = sourceRoots.get(item.repositoryId);
  assert(root, `No source checkout mapped for ${item.repositoryId}.`);
  assert(!path.isAbsolute(item.relativePath) && !item.relativePath.split('/').includes('..'), 'Evidence path escaped its repository.');
  const filename = path.resolve(root, item.relativePath);
  assert(filename.startsWith(`${root}${path.sep}`), 'Evidence filename escaped its repository.');
  let file = cachedFiles.get(filename);
  if (!file) {
    const bytes = await readFile(filename);
    file = { text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') };
    cachedFiles.set(filename, file);
  }
  assert.equal(item.fileHash, file.sha256, `${item.relativePath}: indexed file hash differs from the checkout.`);
  assert.equal(item.contentHash, createHash('sha256').update(item.content).digest('hex'), `${item.relativePath}: excerpt hash mismatch.`);
  const starts = [0];
  for (let offset = 0; offset < file.text.length; offset++) if (file.text[offset] === '\n') starts.push(offset + 1);
  const position = (line: number, column: number) => {
    assert(Number.isInteger(line) && Number.isInteger(column) && line >= 1 && column >= 1, 'Invalid source coordinates.');
    const start = starts[line - 1];
    assert(start !== undefined, `${item.relativePath}:${line}: line outside source.`);
    const end = starts[line] === undefined ? file.text.length : starts[line]! - 1;
    assert(start + column - 1 <= end, `${item.relativePath}:${line}:${column}: column outside source.`);
    return start + column - 1;
  };
  const from = position(item.sourceRange.startLine, item.sourceRange.startColumn);
  const to = position(item.sourceRange.endLine, item.sourceRange.endColumn);
  assert(to > from, 'Source ranges must be nonempty and end-exclusive.');
  assert.equal(item.content, file.text.slice(from, to), `${item.relativePath}: returned content differs from its exact source range.`);
}

async function verifyPacket(packet: ContextPacket, request: TaskRetrievalRequest): Promise<void> {
  assert.equal(packet.requestId, request.requestId);
  assert.equal(packet.requirement, request.requirement);
  assert(['complete', 'partial', 'unavailable'].includes(packet.status));
  assert.equal(packet.routing.requestedGranularity, request.granularity ?? 'auto');
  assert.equal(packet.routing.source, request.granularity === 'auto' || request.granularity === undefined ? 'automatic' : 'user');
  if (packet.routing.source === 'user') {
    assert(!Object.hasOwn(packet.routing, 'confidence'), 'Manual selection must not carry routing confidence.');
    assert(packet.routing.resolvedGranularities.every((item) => item === request.granularity), 'Manual granularity was substituted.');
    assert(packet.results.every((item) => item.granularity === request.granularity), 'A primary result violates the requested granularity.');
  }
  const scopes = new Set(request.scopes.map((scope) => `${scope.repositoryId}@${scope.analysisRevision}`));
  assert.equal(packet.snapshots.length, request.scopes.length);
  for (const snapshot of packet.snapshots) {
    assert(scopes.has(`${snapshot.repositoryId}@${snapshot.analysisRevision}`), 'Snapshot changed during retrieval.');
    assert(snapshot.analysisHash, 'Snapshot has no analysis hash.');
  }
  for (const item of [...packet.results, ...packet.evidence, ...packet.relations]) assert(scopes.has(`${item.repositoryId}@${item.analysisRevision}`), 'Result or evidence crossed a requested version boundary.');
  for (const item of packet.evidence) await sourceEvidenceMatches(item);
  assert.equal(packet.usage.tokenizer, 'cl100k_base');
  assert.equal(packet.usage.tokens, tokenizer.encode(packet.markdown, [], []).length, 'Token count does not cover the exported Markdown.');
  assert(packet.usage.tokens <= request.budget.maxTokens, 'Actual Markdown exceeds the requested token budget.');
  assert.equal(packet.usage.characters, packet.markdown.length);
  if (packet.evidence.some((item) => item.truncated)) assert.equal(packet.status, 'partial', 'Truncated evidence must not be reported as complete.');
}

async function runCase(name: string, requirement: string, granularity: RetrievalGranularity, scopes: TaskRetrievalScope[], check?: (packet: ContextPacket) => void, maxTokens = 8000): Promise<void> {
  const request: TaskRetrievalRequest = { requestId: `live-${name}-${randomUUID()}`, requirement, granularity, scopes,
    budget: { maxTokens, maxLatencyMs: 60000, maxFiles: 30, maxSourceLines: 1600 } };
  const started = performance.now();
  const entry: Record<string, unknown> = { name, request, passed: false };
  cases.push(entry);
  try {
    const packet = await post<ContextPacket>('/v1/task-search', request);
    entry.httpElapsedMs = Math.round(performance.now() - started);
    await verifyPacket(packet, request);
    entry.status = packet.status;
    entry.routing = packet.routing;
    entry.results = packet.results.map(({ name, granularity, repositoryId, relativePath }) => ({ name, granularity, repositoryId, relativePath }));
    entry.evidenceCount = packet.evidence.length;
    entry.relationCount = packet.relations.length;
    entry.usage = packet.usage;
    entry.gaps = packet.gaps;
    entry.versionsAndSourceRangesVerified = true;
    if (name === 'chinese-size-limits' || name === 'default-budget-auto') {
      representative = packet;
      report.representativeCase = name;
    }
    check?.(packet);
    entry.passed = true;
    if (name === 'no-match-exploration') entry.observation = packet.results.length === 0
      ? 'This exploratory request returned no results; it is not a measured no-match accuracy rate.'
      : 'The exploratory unrelated request returned candidates. Zero-match rejection is not established.';
    console.info(`${name}: ${packet.status}, ${packet.results.length} results, ${packet.evidence.length} excerpts, ${packet.usage.tokens} tokens, ${entry.httpElapsedMs} ms`);
  } catch (error) {
    entry.httpElapsedMs = Math.round(performance.now() - started);
    entry.error = error instanceof Error ? error.message : String(error);
    console.error(`${name}: ${entry.error}`);
  }
}

function verifySizeLimitImplementation(packet: ContextPacket): void {
  assert(packet.results.length > 0 && packet.evidence.length > 0, 'Chinese requirement returned no implementation evidence.');
  const text = packet.evidence.map((item) => item.content).join('\n');
  assert(/sizeMax|getSizeMax|setSizeMax/.test(text), 'Total upload size evidence is missing.');
  assert(/fileSizeMax|getFileSizeMax|setFileSizeMax/.test(text), 'Per-file size evidence is missing.');
  assert(packet.evidence.some((item) => item.role === 'implementation' && /if\s*\([^\n]*sizeMax/.test(item.content)
    && /throw new SizeLimitExceededException/.test(item.content)), 'Total upload limit validation and its exception are missing from the implementation.');
  assert(packet.evidence.some((item) => item.role === 'implementation' && /if\s*\([^\n]*fileSizeMax/.test(item.content)
    && /throw new FileSizeLimitExceededException/.test(item.content)), 'Per-file limit validation and its exception are missing from the implementation.');
}

try {
  const payload = await ready();
  const target = payload.moduleExplorer.target;
  const referenceRoots = await Promise.all((values['reference-root'] ?? payload.settings.repositoryPaths).map((root) => realpath(path.resolve(root))));
  sourceRoots.set(target.repositoryId!, await realpath(path.resolve(values['target-root']!)));
  const references = payload.moduleExplorer.history.filter((workspace) => {
    const repository = payload.codeIntelligence.repositories.find((item) => item.repositoryId === workspace.repositoryId);
    const root = referenceRoots.find((candidate) => repository?.displayName === path.basename(candidate) || workspace.name.startsWith(`${path.basename(candidate)} /`));
    if (root && workspace.repositoryId) sourceRoots.set(workspace.repositoryId, root);
    return Boolean(root && workspace.revision && workspace.analysis?.state === 'ready');
  });
  assert(references.length > 0, 'No indexed reference checkout could be mapped.');
  const java = references.find((workspace) => payload.codeIntelligence.repositories.find((repository) => repository.repositoryId === workspace.repositoryId)
    ?.languages.some((language) => language.languageId === 'java'));
  assert(java, 'The verification requires a real Java reference project.');
  const targetScope = scopeFor(target, 'target');
  const referenceScope = scopeFor(java, 'reference');
  const both = [targetScope, referenceScope];
  report.scopes = both;
  report.sourceRoots = Object.fromEntries(sourceRoots);
  report.moduleModeling = { target: { name: target.name, modules: target.stats.modules, state: target.analysis?.state },
    reference: { name: java.name, modules: java.stats.modules, state: java.analysis?.state } };
  assert(target.stats.modules > 0 && java.stats.modules > 0, 'Real target and reference module models must be present.');
  await runCase('chinese-size-limits', '我要修改上传功能的大小限制，定位总请求大小和单个文件大小的校验实现，以及超限异常处理。', 'auto', both, verifySizeLimitImplementation);
  await runCase('default-budget-auto', '修改文件上传总大小限制和单个文件大小限制', 'auto', both, verifySizeLimitImplementation, 4000);
  await runCase('default-budget-function', '修改文件上传总大小限制和单个文件大小限制', 'function', both, verifySizeLimitImplementation, 4000);
  await runCase('explicit-parse-request', '定位 parseRequest 函数，检查上传内容解析及文件项创建的调用依赖。', 'function', both, (packet) => {
    assert(packet.results.some((item) => /parseRequest/.test(item.name)), 'parseRequest was not returned as a primary function result.');
    assert(packet.evidence.some((item) => /parseRequest/.test(item.content)), 'parseRequest source was not included.');
  });
  await runCase('java-reference-parse-request', 'parseRequest 上传请求解析和文件项创建', 'function', [referenceScope], (packet) => {
    assert(packet.results.some((item) => /parseRequest/.test(item.name)), 'Java reference parseRequest was not located.');
    assert(packet.evidence.some((item) => item.relativePath.endsWith('.java') && /parseRequest/.test(item.content)), 'Java reference source was not included.');
  });
  await runCase('class-interface', '定位 FileItem 和 FileItemFactory 类或接口，查看文件项的读写与创建约定。', 'class', [targetScope], (packet) => {
    assert(packet.results.length > 0 && packet.evidence.length > 0, 'Class/interface query returned no implementation evidence.');
    assert(packet.results.some((item) => /FileItem/.test(item.name)), 'FileItem class/interface was not located.');
  });
  await runCase('module-model', '上传解析、请求大小限制和临时文件存储功能模块', 'module', both, (packet) => {
    assert(packet.results.length > 0 && packet.results.every((item) => item.granularity === 'module'), 'Real indexed module results are unavailable.');
    assert(packet.evidence.length > 0, 'Module result contains no indexed source.');
  });
  await runCase('no-match-exploration', 'qzv_unrelated_7f0298 星际导航量子纠错和气象卫星轨道计算', 'function', both);
  await runCase('unavailable-subsystem', '查看整个上传子系统', 'subsystem', both, (packet) => {
    assert.equal(packet.status, 'unavailable');
    assert.deepEqual(packet.routing.resolvedGranularities, []);
    assert.deepEqual(packet.results, []);
    assert(packet.gaps.some((gap) => gap.code === 'GRANULARITY_UNAVAILABLE'));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('live-http-cancellation')), 25);
  const cancellation: Record<string, unknown> = { name: 'http-cancellation', passed: false };
  cases.push(cancellation);
  try {
    await assert.rejects(post('/v1/task-search', { requestId: `cancel-${randomUUID()}`, requirement: '检查上传解析中的资源释放和临时文件生命周期',
      granularity: 'auto', scopes: both, budget: { maxTokens: 8000, maxLatencyMs: 60000 } }, controller.signal), /live-http-cancellation/);
    assert(controller.signal.aborted);
    const health = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(10000) });
    assert.equal(health.status, 200);
    cancellation.passed = true;
    cancellation.observation = 'In-flight HTTP request was aborted and the service remained responsive. This HTTP-only check does not measure downstream worker termination.';
  } catch (error) { cancellation.error = error instanceof Error ? error.message : String(error); }
  finally { clearTimeout(timer); }
  report.passed = cases.every((entry) => entry.passed === true);
} catch (error) {
  report.setupError = error instanceof Error ? error.message : String(error);
  console.error(report.setupError);
} finally {
  report.finishedAt = new Date().toISOString();
  report.latencyInterpretation = 'Observed end-to-end timings only; no enterprise SLA or no-match accuracy claim is established by this small live sample.';
  await mkdir(outputDirectory, { recursive: true });
  const reportPath = path.join(outputDirectory, 'task-context-live-report.json');
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportJson);
  await writeFile(path.join(outputDirectory, `task-context-live-${startedAt.replace(/[:.]/g, '-')}.json`), reportJson);
  if (representative) await writeFile(path.join(outputDirectory, 'task-context-live.md'), representative.markdown);
  console.info(`Report: ${reportPath}`);
  if (!report.passed) process.exitCode = 1;
}
