import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { RepositoryStructuralScanner } from '../services/code-intelligence-service/src/repository-scanner';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store';
import { SeekDbProjection } from '../services/code-intelligence-service/src/seekdb-projection';
import { ProjectAnalysisCoordinator } from '../services/code-intelligence-service/src/project-analysis';
import { TaskRetrievalService } from '../services/code-intelligence-service/src/task-retrieval';
import { contextTokenCount } from '../services/code-intelligence-service/src/context-compiler';
import type { SourceTextReader } from '../services/code-intelligence-service/src/index-store';

const root = process.env.TASK_SCALE_ROOT ?? '/mnt/e/CS/devsys/vscode/src';
const database = process.env.TASK_SCALE_DATABASE ?? 'forexplore_task_scale_20260908';
assert(/^forexplore_task_scale_[a-z0-9_]+$/.test(database), 'Capacity runs require their own forexplore_task_scale_* database.');
const config = { host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1', port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? 2881), user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root', password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '', database, vectorDimension: 64, structuralBatchRows: 2000 };
const startedAt = new Date().toISOString();
const metrics: Record<string, unknown> = { root, database, config: { ...config, password: undefined }, scannerConfig: { maxFileBytes: 4 * 1024 * 1024, maxFilesPerWorker: 64, maxBytesPerWorker: 8 * 1024 * 1024, workerHeapMiB: 512 }, embedding: 'local hash vectors; semantic quality not measured', locDefinition: 'Physical lines in indexed UTF-8 files, including comments, blanks and tests. No duplicated or generated capacity files.', limitations: ['Structure metadata remains in memory.', 'No million-line incremental rewrite is claimed.', 'Module labels use directory/dependency evidence; no LLM quality result is claimed.'] };
metrics.resourcesScope = 'Indexer Node parent plus separately reported parser workers; database and model service memory are not included.';
metrics.dependencyScope = 'Explicit syntactic imports, exports and project references; not a complete semantic call graph.';
const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, connectionLimit: 4 });
const store = new SeekDbIndexStore(config, pool);
const scanner = new RepositoryStructuralScanner({ maxFileBytes: 4 * 1024 * 1024 });
const revision = `scale-${Date.now()}`;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Scale verification interrupted')));
process.once('SIGTERM', () => controller.abort(new Error('Scale verification terminated')));
const output = process.env.TASK_SCALE_REPORT ?? path.resolve('logs/task-indexing-scale-20260908.json');
let sourceReader: SourceTextReader | undefined;
let supplementalReport: { passed: boolean; metrics: Record<string, unknown>; [key: string]: unknown } | undefined;
let maxHeapUsed = 0;
let maxRss = 0;
let stage = 'initializing';
let lastProgress = 0;
const info = console.info.bind(console);
console.info = (...args: unknown[]) => {
  const now = performance.now();
  if (now - lastProgress > 15_000 || !String(args[1]).includes('seekdb-transaction')) {
    info(...args); lastProgress = now;
  }
};
function sample(): void {
  const memory = process.memoryUsage();
  maxHeapUsed = Math.max(maxHeapUsed, memory.heapUsed);
  maxRss = Math.max(maxRss, memory.rss);
}
async function checkpoint(): Promise<void> {
  sample();
  metrics.resources = { sampledPeakHeapBytes: maxHeapUsed, sampledPeakRssBytes: maxRss, processMaxRssBytes: process.resourceUsage().maxRSS * 1024 };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed: false, stage, startedAt, updatedAt: new Date().toISOString(), metrics }, null, 2));
}
const timer = setInterval(() => { sample(); info('[scale-progress]', JSON.stringify({ stage, elapsedSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000), heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) })); }, 30_000);

async function verifyMainProject(scope: { repositoryId: string; analysisRevision: string }): Promise<Record<string, unknown>> {
  const [projects] = await pool.query<mysql.RowDataPacket[]>(`SELECT project_id, COUNT(*) AS files FROM ${database}.files
    WHERE repository_id = ? AND analysis_revision = ? GROUP BY project_id ORDER BY files DESC LIMIT 1`, [scope.repositoryId, scope.analysisRevision]);
  const projectId = projects[0]?.project_id as string | undefined;
  assert(projectId);
  const projectScope = { ...scope, projectId };
  store.getStructuralIndex = async () => { throw new Error('Online query attempted full structural index hydration'); };
  for (const name of ['listFiles', 'listSymbols', 'listDependencyEdges', 'listSearchDocuments'] as const) {
    store[name] = async () => { throw new Error(`Online query attempted ${name}`); };
  }
  const queryStarted = performance.now();
  info('[scale-query]', JSON.stringify({ operation: 'hybrid-symbol', projectId }));
  const hits = await store.searchSearchDocuments(projectScope, 'executeEdits', 10, 'symbol');
  const localSearchMs = Math.round(performance.now() - queryStarted);
  info('[scale-query]', JSON.stringify({ operation: 'hybrid-symbol-complete', durationMs: localSearchMs, hits: hits.length }));
  assert(hits.length > 0, 'The main project must return indexed executeEdits symbols.');
  const targetPath = 'vs/editor/browser/widget/codeEditor/codeEditorWidget.ts';
  const lookupStarted = performance.now();
  const symbols = await store.querySymbols!(scope, { projectId, relativePaths: [targetPath], kinds: ['method'], limit: 200 });
  const fact = symbols.symbols.find(symbol => symbol.name === 'executeEdits');
  assert(fact);
  const slice = await store.getSourceSlice!(scope, targetPath, fact.sourceRange, 12000);
  assert(slice?.text.includes('executeEdits'));
  const localLookupAndSliceMs = Math.round(performance.now() - lookupStarted);
  info('[scale-query]', JSON.stringify({ operation: 'source-slice-complete', durationMs: localLookupAndSliceMs }));
  const taskStarted = performance.now();
  info('[scale-query]', JSON.stringify({ operation: 'task-context', projectId }));
  const packet = await new TaskRetrievalService(store).search({ requestId: 'scale-editor-context', requirement: 'CodeEditorWidget executeEdits editor text model',
    granularity: 'function', scopes: [projectScope], budget: { maxTokens: 8000, maxFiles: 8, maxSourceLines: 1000, maxLatencyMs: 60000 } });
  const taskContextMs = Math.round(performance.now() - taskStarted);
  const targetEvidence = packet.evidence.find(item => item.relativePath === targetPath && item.symbolKey === fact.symbolKey &&
    item.role === 'implementation' && item.content.includes('executeEdits('));
  assert(targetEvidence, 'Task context must include source evidence for the requested real editor implementation.');
  const sourceBytes = await readFile(path.join(root, targetPath));
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), targetEvidence.fileHash);
  const source = sourceBytes.toString('utf8');
  const lineOffsets = [0];
  for (const match of source.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
  const range = targetEvidence.sourceRange;
  const expectedSource = source.slice(lineOffsets[range.startLine - 1]! + range.startColumn - 1,
    lineOffsets[range.endLine - 1]! + range.endColumn - 1);
  assert.equal(targetEvidence.content, expectedSource);
  assert.deepEqual(range, fact.sourceRange);
  assert.equal(targetEvidence.truncated, false);
  assert.equal(contextTokenCount(packet.markdown), packet.usage.tokens);
  assert(packet.usage.tokens <= 8000);
  assert(packet.evidence.length > 0);
  return { projectId, projectFiles: Number(projects[0]!.files), selection: 'Largest indexed project by file count',
    localSearchMs, localSearchHits: hits.length, localLookupAndSliceMs, targetPath, targetSymbol: fact.qualifiedName,
    sourceSliceRange: slice.sourceRange, sourceSliceChars: slice.text.length, sourceSliceTruncated: slice.truncated,
    targetEvidence: { evidenceId: targetEvidence.evidenceId, name: targetEvidence.name, relativePath: targetEvidence.relativePath, sourceRange: targetEvidence.sourceRange, chars: targetEvidence.content.length, truncated: targetEvidence.truncated },
    verification: { diskFileShaMatches: true, exactRangeSourceMatches: true, targetMethodComplete: true, independentlyCountedTokens: contextTokenCount(packet.markdown), tokenBudgetRespected: true },
    taskContextMs, taskContext: { status: packet.status, resultCount: packet.results.length, evidenceCount: packet.evidence.length,
      usage: packet.usage, gaps: packet.gaps.map(gap => gap.code) }, onlineFullIndexReads: 0 };
}

async function main(): Promise<void> {
  await pool.query(`CREATE DATABASE IF NOT EXISTS ${database}`);
  await store.initialize();
  const [databaseParameters] = await pool.query<mysql.RowDataPacket[]>('SHOW PARAMETERS WHERE name IN ("log_disk_size", "memory_limit")');
  metrics.databaseParameters = databaseParameters.map(parameter => ({ name: parameter.name, value: parameter.value }));
  const verifyRevision = process.env.TASK_SCALE_VERIFY_REVISION;
  if (verifyRevision) {
    stage = 'supplemental-main-project-query';
    const report = JSON.parse(await readFile(output, 'utf8'));
    supplementalReport = report;
    assert.equal(report.metrics.analysisRevision, verifyRevision);
    assert.equal((await store.getRevision({ repositoryId: 'vscode-scale', analysisRevision: verifyRevision }))?.status, 'ready');
    const result = await verifyMainProject({ repositoryId: 'vscode-scale', analysisRevision: verifyRevision });
    report.metrics.supplementalMainProjectQuery = result;
    report.metrics.supplementalQueryCompletedAt = new Date().toISOString();
    report.passed = true;
    report.stage = 'complete';
    delete report.supplementalError;
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const existing = await store.getRepository('vscode-scale');
  assert(!existing?.activeRevision, 'Scale database already contains a published run; use a new TASK_SCALE_DATABASE to reproduce without overwriting it.');
  await store.putRepository({ repositoryId: 'vscode-scale', displayName: 'VS Code', localPath: root, role: 'target', analysisStatus: 'registered', activeRevision: null, createdAt: startedAt, updatedAt: startedAt });
  const t0 = performance.now();
  stage = 'snapshot-and-parse';
  await checkpoint();
  const scan = await scanner.scan({ repositoryId: 'vscode-scale', analysisRevision: revision, root, mode: 'full', signal: controller.signal });
  sourceReader = scan.sourceReader;
  assert(sourceReader && scan.sourceTexts.size === 0);
  metrics.scanMs = Math.round(performance.now() - t0);
  metrics.parserResources = scan.parserResources;
  const index = scan.index;
  metrics.files = index.files.length;
  metrics.sourceFiles = index.files.filter(file => file.role === 'source').length;
  metrics.sourceRevision = scan.sourceRevision;
  metrics.analysisRevision = revision;
  metrics.analysisHash = index.analysisHash;
  metrics.residentSourceMapEntries = scan.sourceTexts.size;
  metrics.bytes = index.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  metrics.maxFileBytes = index.files.reduce((largest, file) => Math.max(largest, file.sizeBytes), 0);
  metrics.symbols = index.symbols.length;
  metrics.edges = index.dependencyEdges.length;
  metrics.diagnostics = index.diagnostics.length;
  metrics.parseStatuses = Object.fromEntries(index.files.reduce((map, file) => map.set(file.parseStatus, (map.get(file.parseStatus) ?? 0) + 1), new Map<string, number>()));
  metrics.projects = index.projects.length;
  stage = 'structural-write';
  await checkpoint();
  const now = new Date().toISOString();
  await store.putRevision({ repositoryId: index.repositoryId, analysisRevision: revision, status: 'building', analysisHash: index.analysisHash,
    ...(scan.sourceRevision ? { sourceRevision: scan.sourceRevision } : {}), indexerVersion: 'scale-2.0', createdAt: now });
  const writeStarted = performance.now();
  let lines = 0, countedFiles = 0;
  const roleLines: Record<string, number> = {};
  const roles = new Map(index.files.map(file => [file.relativePath, file.role]));
  await store.putStructuralIndexFromSource!(index, { read: async relativePath => {
    const text = await sourceReader!.read(relativePath);
    if (text !== null) {
      let count = 0;
      for (let position = 0; position < text.length; position++) if (text[position] === '\n') count++;
      if (text.length && !text.endsWith('\n')) count++;
      lines += count; countedFiles++;
      const role = roles.get(relativePath) ?? 'other'; roleLines[role] = (roleLines[role] ?? 0) + count;
    }
    return text;
  } }, controller.signal);
  metrics.loc = lines;
  metrics.locByRole = roleLines;
  metrics.countedTextFiles = countedFiles;
  assert(lines >= Number(process.env.TASK_SCALE_MIN_LOC ?? 1_000_000), `Real corpus has only ${lines} physical lines.`);
  metrics.structuralWriteMs = Math.round(performance.now() - writeStarted);
  const projectionStarted = performance.now();
  stage = 'source-projection';
  await checkpoint();
  const projectionConfig = { maxDocuments: 2000, maxBytes: 4 * 1024 * 1024 };
  metrics.projectionConfig = projectionConfig;
  await new SeekDbProjection(store, projectionConfig).projectFromSource!(index, sourceReader!, controller.signal);
  metrics.projectionMs = Math.round(performance.now() - projectionStarted);
  await sourceReader!.dispose!(); sourceReader = undefined;
  await store.putRevision({ repositoryId: index.repositoryId, analysisRevision: revision, status: 'ready', analysisHash: index.analysisHash,
    ...(scan.sourceRevision ? { sourceRevision: scan.sourceRevision } : {}), indexerVersion: 'scale-2.0', createdAt: now, completedAt: new Date().toISOString() });
  await store.activateRevision({ repositoryId: index.repositoryId, analysisRevision: revision });
  const scope = { repositoryId: index.repositoryId, analysisRevision: revision };
  stage = 'module-modeling';
  await checkpoint();
  const modelingStarted = performance.now();
  const originalRead = store.getStructuralIndex.bind(store);
  store.getStructuralIndex = async requested => requested.repositoryId === scope.repositoryId && requested.analysisRevision === scope.analysisRevision ? index : originalRead(requested);
  const jobs = new ProjectAnalysisCoordinator({ store, allowStructuralFallback: true });
  let modules = 0, assigned = 0;
  const moduleDetails: unknown[] = [];
  for (const project of index.projects) {
    const projectScope = { ...scope, projectId: project.projectId };
    await jobs.ensure(projectScope);
    const record = await jobs.read(projectScope);
    assert.equal(record.state, 'ready', record.error);
    assert.equal(record.projection, 'ready', record.error);
    modules += record.proposal?.modules.length ?? 0;
    assigned += record.coverage?.assigned ?? 0;
    moduleDetails.push({ projectId: project.projectId, modules: record.proposal?.modules.length, coverage: record.coverage, modeling: record.modeling });
  }
  metrics.moduleModelingMs = Math.round(performance.now() - modelingStarted);
  metrics.modules = modules;
  metrics.assignedFiles = assigned;
  metrics.moduleDetails = moduleDetails;
  assert.equal(assigned, index.files.length);
  stage = 'local-query';
  await checkpoint();
  metrics.mainProjectQuery = await verifyMainProject(scope);
  const [counts] = await pool.query<mysql.RowDataPacket[]>(`SELECT kind, COUNT(*) AS count FROM ${database}.search_documents WHERE repository_id = ? AND analysis_revision = ? GROUP BY kind`, [scope.repositoryId, scope.analysisRevision]);
  metrics.projectionCounts = counts;
  stage = 'complete';
  await checkpoint();
  const report = { passed: true, startedAt, completedAt: new Date().toISOString(), metrics };
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert(index.files.length > 0);
}

main().catch(async error => { sample(); metrics.resources = { sampledPeakHeapBytes: maxHeapUsed, sampledPeakRssBytes: maxRss, processMaxRssBytes: process.resourceUsage().maxRSS * 1024 }; const report = supplementalReport
  ? { ...supplementalReport, passed: false, supplementalError: String(error), supplementalFailureAt: new Date().toISOString() }
  : { passed: false, stage, startedAt, completedAt: new Date().toISOString(), metrics, error: String(error) };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2)); console.error(JSON.stringify({ passed: false, stage, error: String(error) })); process.exitCode = 1;
}).finally(async () => { clearInterval(timer); await sourceReader?.dispose?.(); await store.close().catch(() => undefined); });
