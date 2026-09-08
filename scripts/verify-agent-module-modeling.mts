import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs, parseEnv } from 'node:util';
import mysql from 'mysql2/promise';
import { getEncoding } from 'js-tiktoken';
import type { ContextPacket, ModuleArtifactRecord, ProjectAnalysisRecord, ProjectAnalysisScope, TaskRetrievalRequest } from '@forexplore/contracts';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { projectAnalysisProfile, projectPlanHash, validateProjectResult } from '../services/code-intelligence-service/src/project-analysis.js';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:4044' }, database: { type: 'string', default: 'forexplore_agent_restore_20260908' },
  scope: { type: 'string', multiple: true }, 'wait-ms': { type: 'string', default: '420000' },
  'verify-existing': { type: 'boolean', default: false }, 'not-before': { type: 'string' },
  'model-log': { type: 'string' }, 'output-dir': { type: 'string', default: 'logs' },
} });
const endpoint = new URL(values.endpoint!);
assert(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname));
assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.database!));
const waitMs = Number(values['wait-ms']);
assert(Number.isInteger(waitMs) && waitMs >= 1000 && waitMs <= 1200000);
if (values['verify-existing']) assert(values['not-before'] && Number.isFinite(Date.parse(values['not-before'])), 'Existing verification needs an explicit freshness timestamp.');
const scopes: ProjectAnalysisScope[] = (values.scope ?? [
  'repo-844e394d-f077-435d-834b-a959e54ce988,analysis-eecb83c4-0d57-418c-be17-4025e9e279e5,project-7c71b4f8d3dc92250cb9907e',
  'repo-e33d94e5-9acb-4305-82ed-901f8488a17f,analysis-11a9ad82-c153-48b0-aa81-186dd5a6ed5f,project-a61821301eaff059b0967198',
]).map((value) => {
  const parts = value.split(','); assert(parts.length === 3 && parts.every((part) => /^[A-Za-z0-9._-]{1,256}$/.test(part)));
  return { repositoryId: parts[0]!, analysisRevision: parts[1]!, projectId: parts[2]! };
});
assert(scopes.length > 0 && scopes.length <= 8);
const legacy = parseEnv(await readFile('services/retrieval-service/.env', 'utf8'));
const config = { host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? legacy.SEEKDB_HOST ?? '127.0.0.1',
  port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? legacy.SEEKDB_PORT ?? 2881), user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? legacy.SEEKDB_USER ?? 'root',
  password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? legacy.SEEKDB_PASSWORD ?? '', database: values.database!, vectorDimension: 384 };
assert(['localhost', '127.0.0.1', '::1'].includes(config.host));
const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, connectionLimit: 3 });
const store = new SeekDbIndexStore(config, pool);
const startedAt = new Date().toISOString();
const output = path.resolve(values['output-dir']!);
const timestamp = startedAt.replace(/[:.]/g, '-');
const tokenizer = getEncoding('cl100k_base');
const report: Record<string, unknown> = { startedAt, database: values.database, endpoint: endpoint.origin, passed: false,
  mode: values['verify-existing'] ? 'Verify existing fresh Agent output without triggering model calls' : 'Force real authorized Agent analysis through the local workbench',
  projects: [], semanticSurfaceChecks: 'Chinese functional names/descriptions and rejection of directory-count templates; this is not an automatic semantic correctness score.' };
const projects = report.projects as Array<Record<string, unknown>>;
const markdowns: Array<{ name: string; markdown: string }> = [];
const logOffset = values['model-log'] ? await stat(values['model-log']).then((file) => file.size).catch(() => 0) : 0;

async function post<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(route, endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  const text = await response.text(); assert.equal(response.status, 200, `HTTP ${response.status}: ${text.slice(0, 700)}`);
  return JSON.parse(text) as T;
}
async function artifacts(scope: ProjectAnalysisScope) {
  const values = await store.getModuleArtifacts(scope, [`project-summary:${scope.projectId}:${projectAnalysisProfile}`, `project-job:${scope.projectId}:${projectAnalysisProfile}`]);
  return { summary: values.find((value) => value.kind === 'module-summary'), job: values.find((value) => value.moduleArtifactId.startsWith('project-job:')) };
}
function metadata(artifact: ModuleArtifactRecord | undefined) {
  if (!artifact) return null;
  const record = artifact.payload as ProjectAnalysisRecord;
  return { planHash: artifact.planHash, contentHash: artifact.contentHash, updatedAt: artifact.updatedAt, analysisHash: artifact.analysisHash,
    state: record.state, projection: record.projection, modeling: record.modeling, modules: record.proposal?.modules.length, error: record.error };
}
async function checkpoint() {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `agent-module-modeling-${timestamp}.json`), JSON.stringify(report, null, 2));
}

async function verifyContext(packet: ContextPacket, request: TaskRetrievalRequest, expectedHash: string) {
  assert.equal(packet.requestId, request.requestId); assert.equal(packet.requirement, request.requirement);
  assert.equal(packet.routing.requestedGranularity, request.granularity); assert.equal(packet.routing.source, 'user');
  assert.deepEqual(packet.routing.resolvedGranularities, [request.granularity]); assert(!Object.hasOwn(packet.routing, 'confidence'));
  const scope = request.scopes[0]!;
  assert.equal(packet.snapshots.length, 1); assert.equal(packet.snapshots[0]!.analysisHash, expectedHash);
  assert(packet.results.length > 0 && packet.results.every((result) => result.granularity === request.granularity && result.projectId === scope.projectId));
  assert(packet.evidence.some((evidence) => evidence.role === 'implementation'), 'Context has no primary implementation.');
  for (const item of [...packet.snapshots, ...packet.results, ...packet.relations, ...packet.evidence]) {
    assert.equal(item.repositoryId, scope.repositoryId); assert.equal(item.analysisRevision, scope.analysisRevision);
  }
  for (const item of packet.evidence) {
    const file = (await store.queryFiles(scope, { relativePaths: [item.relativePath], limit: 1 })).files[0];
    assert(file); assert.equal(file.sha256, item.fileHash);
    const text = await store.getSourceText(scope, item.relativePath); assert(text !== null);
    assert.equal(createHash('sha256').update(text).digest('hex'), item.fileHash);
    const offsets = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
    const offset = (line: number, column: number) => {
      assert(Number.isInteger(line) && Number.isInteger(column) && line > 0 && column > 0 && offsets[line - 1] !== undefined);
      const result = offsets[line - 1]! + column - 1;
      assert(result <= (offsets[line] === undefined ? text.length : offsets[line]! - 1)); return result;
    };
    const range = item.sourceRange, from = offset(range.startLine, range.startColumn), to = offset(range.endLine, range.endColumn);
    assert(to > from); assert.equal(text.slice(from, to), item.content);
    assert.equal(createHash('sha256').update(item.content).digest('hex'), item.contentHash);
    if (item.symbolKey) {
      const symbols = (await store.querySymbols(scope, { symbolKeys: [item.symbolKey], limit: 1 })).symbols;
      assert.equal(symbols.length, 1); assert.equal(symbols[0]!.relativePath, item.relativePath);
      const declaration = symbols[0]!.sourceRange;
      assert(from >= offset(declaration.startLine, declaration.startColumn) && to <= offset(declaration.endLine, declaration.endColumn), 'Excerpt escaped its indexed declaration.');
    }
  }
  assert.equal(packet.usage.tokenizer, 'cl100k_base');
  assert.equal(packet.usage.tokens, tokenizer.encode(packet.markdown, [], []).length);
  assert(packet.usage.tokens <= request.budget.maxTokens);
  assert.equal(packet.usage.characters, packet.markdown.length);
  assert.equal(new Set(packet.evidence.map((evidence) => evidence.evidenceId)).size, packet.evidence.length);
}

async function run(scope: ProjectAnalysisScope) {
  const repository = await store.getRepository(scope.repositoryId), revision = await store.getRevision(scope);
  assert(repository && revision?.status === 'ready' && repository.activeRevision === scope.analysisRevision);
  const project = await store.getProject(scope, scope.projectId); assert(project);
  const before = await artifacts(scope); assert(before.summary?.status === 'current', 'Last valid module summary is absent.');
  const entry: Record<string, unknown> = { scope, name: repository.displayName, before: metadata(before.summary), beforeJob: metadata(before.job), states: [], contexts: [], passed: false };
  projects.push(entry); await checkpoint();
  const notBefore = values['verify-existing'] ? Date.parse(values['not-before']!) : Date.now();
  entry.analysisRequestedAt = new Date(notBefore).toISOString();
  let last = before;
  if (!values['verify-existing']) await post('/v1/workbench/message', { type: 'RETRY_PROJECT_ANALYSIS', ...scope, force: true });
  const deadline = performance.now() + waitMs;
  let lastState = '', lastUpdate = 0;
  while (true) {
    last = await artifacts(scope);
    assert(last.summary?.status === 'current', 'Last valid summary disappeared while reanalysis was running.');
    const job = last.job?.payload as ProjectAnalysisRecord | undefined;
    const summary = last.summary.payload as ProjectAnalysisRecord;
    const state = JSON.stringify({ state: job?.state, projection: job?.projection, planHash: last.summary.planHash, error: job?.error });
    if (state !== lastState) {
      (entry.states as unknown[]).push({ at: new Date().toISOString(), job: metadata(last.job), summary: metadata(last.summary), lastGoodPreserved: true });
      lastState = state; await checkpoint();
    }
    const fresh = Date.parse(last.summary.updatedAt) >= notBefore;
    if (job?.state === 'failed' && Date.parse(job.updatedAt) >= notBefore) throw new Error(`${repository.displayName}: ${job.error ?? 'Agent analysis failed'}; last valid summary was retained.`);
    if (fresh && job?.state === 'ready' && job.projection === 'ready' && summary.state === 'ready') break;
    if (values['verify-existing']) throw new Error('The existing Agent result does not satisfy the requested freshness and readiness threshold.');
    if (performance.now() >= deadline) throw new Error('Agent analysis exceeded the acceptance wait; last valid summary remains available.');
    if (performance.now() - lastUpdate >= 15000) { console.info(JSON.stringify({ name: repository.displayName, state: job?.state, projection: job?.projection, waitingMs: Date.now() - notBefore })); lastUpdate = performance.now(); }
    await pause(2000);
  }
  const artifact = last.summary!, record = artifact.payload as ProjectAnalysisRecord;
  entry.publicationObservedAt = new Date().toISOString();
  entry.after = metadata(artifact); entry.afterJob = metadata(last.job);
  entry.summary = record.proposal?.summary;
  entry.modules = record.proposal?.modules.map((module) => ({ id: module.id, name: module.name, description: module.description, sourceFiles: module.sourceFiles, coreApis: module.coreApis, refinement: module.refinement }));
  entry.coverage = record.coverage; entry.hierarchy = record.proposal?.hierarchy;
  entry.modelCalls = record.proposal?.hierarchy?.modelDecisionCount ?? null;
  entry.modelCallCountSource = record.proposal?.hierarchy ? 'Persisted accepted model decisions, not total network attempts' : 'Legacy tool-calling path does not persist a model-call counter; inspect the attached server-log window';
  await checkpoint();
  assert(record.proposal && record.modeling?.strategy === 'agent', 'Fresh result was not produced by the Agent path.');
  assert.equal(artifact.analysisHash, revision.analysisHash); assert.equal(projectPlanHash(record.proposal), artifact.planHash);
  assert(Date.parse(artifact.updatedAt) >= notBefore);
  const proposal = record.proposal;
  assert(/[\u3400-\u9fff]/.test(proposal.summary ?? ''), 'Fresh project summary does not contain Chinese functional descriptions.');
  assert(!/^.*:\s*\d+ root modules, \d+ module nodes, \d+ indexed files\.?$/.test(proposal.summary ?? ''), 'A structural count template was presented as Agent analysis.');
  assert(proposal.modules.length > 0);
  assert(proposal.modules.some((module) => /[\u3400-\u9fff]/.test(`${module.name} ${module.description}`)));
  assert(proposal.modules.every((module) => module.description.trim().length >= 15 && !/^.*:\s*\d+ files(?:, \d+ declarations)?\.?$/.test(module.description)));
  const index = await store.getStructuralIndex(scope); assert(index && index.analysisHash === revision.analysisHash);
  assert(index.files.length <= 1500 && index.symbols.length <= 30000, 'Small-project acceptance must not hydrate an unbounded corpus.');
  const evidenceIds = [...new Set([...proposal.modules.flatMap((module) => module.evidenceIds), ...(proposal.dependencies ?? []).flatMap((edge) => edge.evidenceIds)])];
  const coverage = validateProjectResult(index, scope, { proposal, evidence: { ...scope, analysisHash: revision.analysisHash, planHash: artifact.planHash!, evidenceIds } });
  assert.deepEqual(coverage, record.coverage);
  const sourceFiles = new Set(index.files.filter((file) => file.projectId === scope.projectId && file.role === 'source').map((file) => file.relativePath));
  const module = proposal.modules.find((candidate) => candidate.sourceFiles.some((file) => sourceFiles.has(file)) && (candidate.coreApis?.length ?? 0) > 0)
    ?? proposal.modules.find((candidate) => candidate.sourceFiles.some((file) => sourceFiles.has(file)));
  assert(module, 'Agent proposal has no source implementation module.');
  const symbol = index.symbols.filter((symbol) => symbol.projectId === scope.projectId && sourceFiles.has(symbol.relativePath) && ['function', 'method'].includes(symbol.kind))
    .sort((a, b) => Number(module.sourceFiles.includes(b.relativePath)) - Number(module.sourceFiles.includes(a.relativePath))
      || Number(b.exported) - Number(a.exported) || a.sourceRange.endLine - a.sourceRange.startLine - (b.sourceRange.endLine - b.sourceRange.startLine))
    .find((symbol) => symbol.sourceRange.endLine > symbol.sourceRange.startLine);
  assert(symbol, 'No indexed implementation is available for the declaration-range check.');
  entry.expectedDeclaration = { symbolKey: symbol.symbolKey, name: symbol.name, qualifiedName: symbol.qualifiedName, relativePath: symbol.relativePath, sourceRange: symbol.sourceRange };
  for (const [granularity, requirement] of [['module', `${module.name}\n${(module.coreApis ?? []).slice(0, 2).join('\n')}`], ['function', `修改 ${symbol.qualifiedName || symbol.name} 的实现与相关调用`]] as const) {
    const request: TaskRetrievalRequest = { requestId: `agent-model-${randomUUID()}`, requirement, granularity, scopes: [scope],
      budget: { maxTokens: 4000, maxLatencyMs: 60000, maxFiles: 15, maxSourceLines: 1000 } };
    const packet = await post<ContextPacket>('/v1/task-search', request);
    const context = { request, status: packet.status, routing: packet.routing, usage: packet.usage, results: packet.results,
      evidence: packet.evidence.map(({ content: _content, ...evidence }) => evidence), relations: packet.relations, gaps: packet.gaps,
      exactSnapshotRangeAndTokenCountVerified: false };
    (entry.contexts as unknown[]).push(context);
    markdowns.push({ name: `${repository.displayName}-${granularity}`, markdown: packet.markdown });
    await checkpoint();
    await verifyContext(packet, request, revision.analysisHash);
    context.exactSnapshotRangeAndTokenCountVerified = true;
    if (granularity === 'module') assert(packet.results.some((result) => result.moduleId === module.id), 'Named Agent module was absent from real retrieval.');
    else {
      assert(packet.results.some((result) => result.symbolKey === symbol.symbolKey), 'Queried declaration was absent from ranked results.');
      const beforeOrEqual = (line: number, column: number, otherLine: number, otherColumn: number) => line < otherLine || line === otherLine && column <= otherColumn;
      const range = symbol.sourceRange;
      const covering = packet.evidence.filter((evidence) => evidence.relativePath === symbol.relativePath
        && beforeOrEqual(evidence.sourceRange.startLine, evidence.sourceRange.startColumn, range.startLine, range.startColumn)
        && beforeOrEqual(range.endLine, range.endColumn, evidence.sourceRange.endLine, evidence.sourceRange.endColumn));
      assert(covering.length > 0, 'The complete queried declaration is absent from verified source evidence.');
      const declaration = await store.getSourceSlice(scope, symbol.relativePath, range, 32000);
      assert(declaration && !declaration.truncated); assert.deepEqual(declaration.sourceRange, range);
      assert(covering.every((evidence) => evidence.content.includes(declaration.text)), 'Containing source did not preserve the exact queried declaration text.');
      entry.declarationCoverage = { symbolKey: symbol.symbolKey, sourceRange: range, contentHash: createHash('sha256').update(declaration.text).digest('hex'),
        evidenceIds: covering.map((evidence) => evidence.evidenceId), symbolEvidenceRetained: covering.some((evidence) => evidence.symbolKey === symbol.symbolKey),
        completeDeclarationVerified: true };
    }
  }
  assert.equal((await store.getRevision(scope))?.analysisHash, revision.analysisHash);
  assert.equal((await artifacts(scope)).summary?.planHash, artifact.planHash, 'The module proposal changed during Context verification.');
  entry.coverage = coverage;
  entry.passed = true; await checkpoint();
  console.info(JSON.stringify({ name: repository.displayName, passed: true, modules: proposal.modules.length, coverage, modeling: record.modeling }));
}

try {
  const health = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200); assert.equal((await health.json() as { status: string }).status, 'ready');
  for (const scope of scopes) {
    try { await run(scope); }
    catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 3000);
      const entry = projects.find((entry) => (entry.scope as ProjectAnalysisScope).repositoryId === scope.repositoryId && (entry.scope as ProjectAnalysisScope).projectId === scope.projectId);
      if (entry) { entry.error = message; entry.verificationCompletedAt = new Date().toISOString(); } else projects.push({ scope, passed: false, error: message, verificationCompletedAt: new Date().toISOString() });
      console.error(JSON.stringify({ scope, error: message })); await checkpoint();
    }
  }
  assert(projects.length === scopes.length && projects.every((entry) => entry.passed), 'One or more live Agent modeling checks failed.');
  report.passed = true;
} catch (error) { report.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000); process.exitCode = 1; }
finally {
  await pool.end(); report.completedAt = new Date().toISOString();
  if (values['model-log']) {
    const file = await open(values['model-log'], 'r');
    try {
      const size = (await file.stat()).size, bytes = Buffer.alloc(Math.min(256000, Math.max(0, size - logOffset)));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, logOffset);
      const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n').filter((line) => /\[(?:live-model|forexplore:performance|agent-model)\]/.test(line));
      const calls = lines.flatMap((line) => {
        const marker = line.indexOf('[agent-model]');
        if (marker < 0) return [];
        try {
          const event = JSON.parse(line.slice(marker + '[agent-model]'.length).trim());
          if (!['success', 'failure', 'cancelled'].includes(event.status) || !['semantic', 'hierarchy'].includes(event.strategy)) return [];
          return [{ strategy: event.strategy, status: event.status, model: event.model, startedAt: event.startedAt, completedAt: event.completedAt,
            elapsedMs: event.elapsedMs, inputChars: event.inputChars, outputChars: event.outputChars }];
        } catch { return []; }
      });
      report.modelLog = { path: values['model-log'], startByte: logOffset, endByte: logOffset + bytesRead, truncated: size - logOffset > bytesRead,
        metrics: lines, completedCallEvents: calls, successfulCalls: calls.filter((event) => event.status === 'success').length };
      for (const entry of projects) {
        const from = Date.parse(String(entry.analysisRequestedAt)), to = Date.parse(String(entry.publicationObservedAt ?? entry.verificationCompletedAt ?? report.completedAt));
        const strategy = (entry.after as { modeling?: { algorithm?: string } } | undefined)?.modeling?.algorithm === 'adaptive-module-tree/v1' ? 'hierarchy' : 'semantic';
        entry.observedModelCalls = calls.filter((event) => event.strategy === strategy && Date.parse(event.startedAt) >= from && Date.parse(event.completedAt) <= to);
        entry.observedModelCallsAttribution = 'Matching strategy and project analysis time window in the shared local model-service log.';
      }
    } finally { await file.close(); }
  }
  await checkpoint(); await writeFile(path.join(output, 'agent-module-modeling.json'), JSON.stringify(report, null, 2));
  for (const item of markdowns) await writeFile(path.join(output, `agent-module-modeling-${item.name}.md`), item.markdown);
  console.info(JSON.stringify({ passed: report.passed, report: path.join(output, 'agent-module-modeling.json'), error: report.error }));
}
