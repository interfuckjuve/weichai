import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createCodeIntelligenceRuntime, SeekDbIndexStore, ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash, ModelSearchEmbeddingProvider } from '../services/code-intelligence-service/src/index';
import { CodeIntelligenceHost } from '../apps/vscode-extension/src/code-intelligence-host';
import { buildStructuralIndex } from '../services/code-indexer/src/structural-index';
import type { ModuleTarget, ProjectAnalysisScope } from '../packages/contracts/src';

// Explicit synthetic contracts exercise the real model, SQL and product host; they are not enterprise quality labels.
const fixtures = [
  { id: 'expiry', title: 'Expiring lookup storage', description: 'Stores values by key and prevents expired values from being returned.',
    api: ['lookup', 'store'], files: { 'cache.ts': 'export class Store { private values = new Map<string, { value: string; until: number }>(); store(key: string, value: string, until: number) { this.values.set(key, {value, until}); } lookup(key: string, now: number) { const item = this.values.get(key); return item && item.until > now ? item.value : undefined; } }',
      'policy.ts': 'export function expiresAt(now: number, ttl: number) { if (ttl < 0) throw new Error("negative TTL"); return now + ttl; }' } },
  { id: 'retry', title: 'Deferred work scheduling', description: 'Retries unsuccessful jobs after exponential delays, with an upper bound on attempts.',
    api: ['schedule', 'nextDelay'], files: { 'scheduler.ts': 'export function schedule(attempt: number, maximum: number) { return attempt < maximum; }',
      'backoff.ts': 'export function nextDelay(attempt: number) { return Math.min(60000, 1000 * 2 ** attempt); }' } },
  { id: 'format', title: 'Localized monetary display', description: 'Formats monetary amounts into localized strings with configurable currency and precision.',
    api: ['formatAmount'], files: { 'format.ts': 'export function formatAmount(amount: number, currency: string) { return new Intl.NumberFormat("en", {style: "currency", currency}).format(amount); }',
      'precision.ts': 'export function roundAmount(amount: number, digits: number) { return Number(amount.toFixed(digits)); }' } },
];

async function main() {
  const reportIndex = process.argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
  assert(reportIndex < 0 || reportPath, '--report requires an output path');
  const moduleReranker = process.argv.includes('--rerank') ? {
    url: 'http://127.0.0.1:4022/v1/rerank', model: 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101', timeoutMs: 4_000,
  } : undefined;
  const endpoint = process.env.CODE_INTELLIGENCE_EMBEDDING_URL ?? 'http://127.0.0.1:4021/v1/embeddings';
  assert(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname), 'This acceptance run uses a local model only.');
  const database = `module_accept_${randomUUID().replaceAll('-', '')}`;
  const config = { host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384,
    embedding: { url: endpoint, apiKey: '', model: process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      supportsDimensions: false, queryPrefix: 'query: ', documentPrefix: 'passage: ' } };
  const admin = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password });
  const root = await mkdtemp(path.join(tmpdir(), 'module-acceptance-'));
  const store = new SeekDbIndexStore(config);
  const metrics: unknown[] = [];
  let cacheReuse: unknown;
  const loadMetrics: unknown[] = [];
  let incremental: unknown;
  let acceptanceReport: Record<string, unknown> = { passed: false, startedAt: new Date().toISOString(), metrics, loadMetrics, moduleReranker };
  try {
    const runtime = await createCodeIntelligenceRuntime({ store, moduleReranker });
    const inputs = [];
    const plan = async (scope: ProjectAnalysisScope & { objective: string }) => {
      const index = (await store.getStructuralIndex(scope))!;
      const repository = (await store.getRepository(scope.repositoryId))!;
      const fixture = fixtures.find((item) => item.id === repository.displayName)!;
      const proposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: fixture.description,
        modules: [{ id: fixture.id, name: fixture.title, kind: 'feature', language: 'TypeScript', description: fixture.description,
          coreApis: fixture.api, sourceFiles: index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath),
          symbolKeys: index.symbols.filter((symbol) => symbol.projectId === scope.projectId).map((symbol) => symbol.symbolKey), dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }] };
      return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
    };
    const jobs = new ProjectAnalysisCoordinator({ store, plan });
    const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, projectAnalysisPort: jobs, planProject: plan });
    for (const fixture of fixtures) {
      const localPath = path.join(root, fixture.id);
      await mkdir(localPath);
      await writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: fixture.id }));
      for (const [name, content] of Object.entries(fixture.files)) await writeFile(path.join(localPath, name), content);
      inputs.push({ localPath, displayName: fixture.id, role: 'history' as const });
    }
    await host.synchronize({ repositories: inputs });
    await host.waitForProjects();
    const repositories = await host.presentation();
    for (const repository of repositories.repositories) for (const project of repository.projects) {
      assert.equal(project.analysis?.state, 'ready', project.analysis?.error);
      assert.equal(project.analysis.projection, 'ready');
    }
    const oldRead = store.getStructuralIndex.bind(store);
    store.getStructuralIndex = async () => { throw new Error('Online search attempted full structural-index hydration'); };
    const queries = [
      { expected: 'expiry', requirement: '按键缓存查询结果，在有效期结束后不再返回旧数据', name: 'LookupService' },
      { expected: 'retry', requirement: '失败任务使用指数退避重新执行，到达次数上限后停止', name: 'WorkDispatcher' },
      { expected: 'format', requirement: '将金额按币种和小数精度格式化为本地化文本', name: 'AmountView' },
    ];
    try {
      for (const query of queries) {
        const target: ModuleTarget = { id: query.expected, name: query.name, kind: 'module', path: 'Target.java', language: 'Java', signature: '',
          module: { sourceFiles: ['Target.java'], coreApis: [], dependsOn: [] } };
        const start = performance.now();
        const results = await host.searchHistoricalImplementations({ target, requirement: query.requirement, topK: 3 });
        const durationMs = Math.round(performance.now() - start);
        if (!results.length && process.argv.includes('--diagnostics')) {
          const [counts] = await admin.query(`SELECT repository_id, kind, COUNT(*) AS count FROM ${database}.search_documents GROUP BY repository_id, kind`);
          console.log(JSON.stringify({ stage: 'projection-counts', counts }));
          const vector = await new ModelSearchEmbeddingProvider(384, config.embedding).embedQuery(query.requirement);
          const binary = Buffer.alloc(vector.length * 4);
          vector.forEach((value, index) => binary.writeFloatLE(value, index * 4));
          const distance = `cosine_distance(embedding, X'${binary.toString('hex')}')`;
          for (const approximate of ['', 'APPROXIMATE']) {
            const [rows] = await admin.query(`SELECT repository_id, kind, ${distance} AS distance FROM ${database}.search_documents ORDER BY ${distance} ${approximate} LIMIT 30`);
            console.log(JSON.stringify({ stage: 'vector-diagnostic', approximate, rows }));
          }
          for (const repository of repositories.repositories) {
            const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision! };
            const recalled = await store.searchSearchDocuments(scope, query.requirement, 3, 'summary');
            const artifacts = await store.getModuleArtifacts(scope, recalled.flatMap((doc) => doc.moduleArtifactId ? [doc.moduleArtifactId] : []));
            console.log(JSON.stringify({ stage: 'empty-recall-diagnostic', repository: repository.displayName,
              revision: await store.getRevision(scope), recalled, artifacts }));
          }
        }
        assert(results.length > 0, 'No module candidates');
        if (moduleReranker) assert(results.every((result) => result.moduleMatch?.reranker?.model === moduleReranker.model));
        assert.equal(results[0]!.sourceModule!.moduleId, query.expected, 'Synthetic semantic smoke test ranked the wrong module first');
        assert(results.every((result) => result.kind === 'module' && result.sourceModule!.sourceFiles!.length === 3));
        assert.equal(new Set(results.map((result) => result.id)).size, results.length);
        metrics.push({ query: query.requirement, expected: query.expected, top1: results[0]!.sourceModule!.moduleId,
          hitAt3: results.some((result) => result.sourceModule!.moduleId === query.expected), durationMs,
          modules: results.map((result) => ({ id: result.sourceModule!.moduleId, score: result.score.overall })) });
      }
      for (const concurrency of [1, 4, 8, 16]) {
        const samples: Array<{ durationMs: number; correct: boolean; error?: string }> = [];
        for (let round = 0; round < 2; round++) {
          samples.push(...await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
            const query = queries[(index + round) % queries.length]!;
            const target: ModuleTarget = { id: query.expected, name: query.name, kind: 'module', path: 'Target.java', language: 'Java', signature: '',
              module: { sourceFiles: ['Target.java'], coreApis: [], dependsOn: [] } };
            const started = performance.now();
            try {
              const result = await host.searchHistoricalImplementations({ target, requirement: query.requirement, topK: 3 });
              return { durationMs: Math.round(performance.now() - started), correct: result[0]?.sourceModule?.moduleId === query.expected };
            } catch (error) {
              return { durationMs: Math.round(performance.now() - started), correct: false, error: error instanceof Error ? error.message : String(error) };
            }
          })));
        }
        const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
        const percentile = (fraction: number) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
        loadMetrics.push({ concurrency, cache: 'warm query/document cache', queries: samples.length,
          meanMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
          p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
          errors: samples.filter((sample) => sample.error).length,
          correctWithinTenSeconds: samples.filter((sample) => sample.correct && sample.durationMs <= 10_000).length, samples });
        if (!moduleReranker) assert(samples.every((sample) => sample.correct), `Synthetic retrieval failed at concurrency ${concurrency}`);
      }
    } finally { store.getStructuralIndex = oldRead; }
    const reopened = new SeekDbIndexStore(config);
    try {
      await reopened.initialize();
      for (const repository of repositories.repositories) {
        const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision! };
        await reopened.replaceSearchDocuments(scope, await reopened.listSearchDocuments(scope));
      }
      assert.equal(reopened.embeddingReuseStats.providerDocuments, 0, 'Unchanged projection should reuse persisted embeddings after restart');
      assert(reopened.embeddingReuseStats.persistentHits > 0);
      cacheReuse = reopened.embeddingReuseStats;
    } finally { await reopened.close(); }
    const expiry = repositories.repositories.find((repository) => repository.displayName === 'expiry')!;
    const priorStats = store.embeddingReuseStats;
    await writeFile(path.join(root, 'expiry', 'policy.ts'), 'export function expiresAt(now: number, ttl: number) { return now + Math.max(0, ttl); }');
    const updated = await runtime.coordinator.run({ repositoryId: expiry.repositoryId, mode: 'incremental' });
    assert.equal(updated.reusedFileCount, 2);
    assert.deepEqual(updated.changedPaths, ['policy.ts']);
    const actual = (await store.getStructuralIndex(updated.scope))!;
    const files = await Promise.all(actual.files.map(async (file) => ({ relativePath: file.relativePath, content: (await store.getSourceText(updated.scope, file.relativePath))! })));
    const full = buildStructuralIndex({ ...updated.scope, files }).index;
    const normalized = (index: typeof actual) => ({ ...index,
      projects: [...index.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
      files: [...index.files].sort((a, b) => a.fileId.localeCompare(b.fileId)),
      symbols: [...index.symbols].sort((a, b) => a.symbolId.localeCompare(b.symbolId)),
      dependencyEdges: [...index.dependencyEdges].sort((a, b) => a.dependencyEdgeId.localeCompare(b.dependencyEdgeId)),
      diagnostics: [...index.diagnostics].sort((a, b) => a.diagnosticId.localeCompare(b.diagnosticId)) });
    assert.equal(projectPlanHash(normalized(actual)), projectPlanHash(normalized(full)), 'Incremental and full structural builds differ');
    const afterStats = store.embeddingReuseStats;
    incremental = { changedPaths: updated.changedPaths, reusedFiles: updated.reusedFileCount, equivalentToFull: true,
      persistentVectorHits: afterStats.persistentHits - priorStats.persistentHits,
      providerDocuments: afterStats.providerDocuments - priorStats.providerDocuments };
    assert(afterStats.persistentHits > priorStats.persistentHits);
    assert(afterStats.providerDocuments > priorStats.providerDocuments);
    const other = new SeekDbIndexStore({ ...config, embedding: { ...config.embedding, model: 'different-model' } });
    try { await assert.rejects(other.initialize(), /does not match stored vectors/); } finally { await other.close(); }
    const loadPassed = loadMetrics.every((value) => { const row = value as { queries: number; correctWithinTenSeconds: number }; return row.queries === row.correctWithinTenSeconds; });
    const report = { passed: loadPassed, integrationPassed: true, scope: 'synthetic integration and load; not enterprise accuracy acceptance',
      realDatabase: true, realEmbedding: true, moduleAnalysis: 'explicit fixture contracts', productHost: true,
      modelIdentityIsolation: true, cacheReuse, incremental, loadMetrics, moduleReranker,
      loadPassed,
      databaseVersion: (await admin.query('SELECT VERSION() AS version'))[0],
      model: config.embedding.model, cpu: cpus()[0]?.model, memoryBytes: totalmem(), metrics };
    console.log(JSON.stringify(report, null, 2));
    acceptanceReport = { ...acceptanceReport, ...report };
    if (!loadPassed) process.exitCode = 1;
  } catch (error) {
    acceptanceReport.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await store.close();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    } finally {
      if (reportPath) await writeFile(reportPath, JSON.stringify(acceptanceReport, null, 2));
    }
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
