import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { buildStructuralIndex } from '../services/code-indexer/src/structural-index';
import { InMemoryIndexStore } from '../services/code-intelligence-service/src/index-store';
import { SeekDbIndexStore, seekDbIndexStoreInternals } from '../services/code-intelligence-service/src/seekdb-index-store';
import { SeekDbProjection } from '../services/code-intelligence-service/src/seekdb-projection';
import { ProjectAnalysisCoordinator, projectPlanHash } from '../services/code-intelligence-service/src/project-analysis';
import type { ModuleArtifactRecord, StructuralIndex } from '../packages/contracts/src';

// Exercise real SQL in a database owned exclusively by this acceptance run.
async function main() {
  const projectJobOnly = process.argv.includes('--project-job-only');
  const database = `index_perf_${randomUUID().replaceAll('-', '')}`;
  const config = {
    host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1',
    port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root',
    password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
    database,
  };
  const pool = mysql.createPool({ ...config, database: undefined, connectionLimit: 2 });
  const store = new SeekDbIndexStore(config, pool);
  let created = false;
  try {
    await pool.query(`CREATE DATABASE ${database}`);
    created = true;
    await store.initialize();
    if (process.argv.includes('--slow-transaction')) {
      await seekDbIndexStoreInternals.withTransaction(pool, async (connection) => {
        const [before] = await connection.query<mysql.RowDataPacket[]>('SELECT @@session.ob_query_timeout AS timeout');
        assert(Number(before[0]!.timeout) >= 60_000_000);
        await connection.query('SELECT SLEEP(11)');
      });
      console.log(JSON.stringify({ indexingStatementOverTenSeconds: 'passed' }));
    }
    const { index, sourceFiles } = buildStructuralIndex({
      repositoryId: 'performance-fixture', analysisRevision: 'revision-one',
      files: [
        { relativePath: 'package.json', content: '{"name":"performance-fixture"}' },
        ...Array.from({ length: projectJobOnly ? 3 : 300 }, (_, id) => ({
          relativePath: `src/file${id}.ts`,
          content: `import { value0 } from './file0';\nexport function value${id}() { return ${id} + 1; }`,
        })),
      ],
    });
    const memory = new InMemoryIndexStore();
    const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision };
    const now = new Date().toISOString();
    for (const target of [store, memory]) {
      await target.putRepository({ repositoryId: index.repositoryId, localPath: process.cwd(),
        displayName: 'Performance fixture', role: 'history', analysisStatus: 'registered',
        activeRevision: null, createdAt: now, updatedAt: now });
      const revision = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision,
        analysisHash: index.analysisHash, indexerVersion: 'performance-test', createdAt: now };
      await target.putRevision({ ...revision, status: 'building' });
      await target.putStructuralIndex(index, sourceFiles);
      await new SeekDbProjection(target).project(index, sourceFiles);
      await target.putRevision({ ...revision, status: 'ready', completedAt: now });
      await target.activateRevision(scope);
    }
    const normalize = (value: StructuralIndex | null) => {
      assert(value);
      return JSON.parse(JSON.stringify({ ...value,
        projects: [...value.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
        files: [...value.files].sort((a, b) => a.fileId.localeCompare(b.fileId)),
        symbols: [...value.symbols].sort((a, b) => a.symbolId.localeCompare(b.symbolId)),
        dependencyEdges: [...value.dependencyEdges].sort((a, b) => a.dependencyEdgeId.localeCompare(b.dependencyEdgeId)),
        diagnostics: [...value.diagnostics].sort((a, b) => a.diagnosticId.localeCompare(b.diagnosticId)),
      }));
    };
    assert.deepEqual(normalize(await store.getStructuralIndex(index)), normalize(await memory.getStructuralIndex(index)));
    assert.deepEqual(await store.listSearchDocuments(scope), await memory.listSearchDocuments(scope));
    for (const [relativePath, text] of sourceFiles) assert.equal(await store.getSourceText(scope, relativePath), text);
    const projection = new SeekDbProjection(store);
    const artifact = (id: string, text: string): ModuleArtifactRecord => ({
      repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, analysisHash: index.analysisHash,
      moduleArtifactId: id, kind: 'module-summary', status: 'current', planHash: 'e'.repeat(64),
      contentHash: 'd'.repeat(64), createdAt: now, updatedAt: now, payload: { text },
    });
    await store.putModuleArtifact(artifact('first', 'first summary'));
    await store.putModuleArtifact(artifact('second', 'second summary'));
    await projection.projectModuleArtifacts(index);
    const before = await store.listSearchDocuments(scope);
    const summaryStarted = performance.now();
    await store.putModuleArtifact(artifact('first', 'updated summary'));
    await projection.projectModuleArtifacts(index, undefined, 'first');
    const summaryMs = performance.now() - summaryStarted;
    const after = await store.listSearchDocuments(scope);
    assert.deepEqual(after.filter((item) => item.moduleArtifactId !== 'first'), before.filter((item) => item.moduleArtifactId !== 'first'));
    assert(after.find((item) => item.moduleArtifactId === 'first')?.text.includes('updated summary'));
    await store.replaceSearchDocuments(scope, [], 'first');
    assert.deepEqual(await store.listSearchDocuments(scope), after.filter((item) => item.moduleArtifactId !== 'first'));

    const projectScope = { ...scope, projectId: index.projects[0]!.projectId };
    let modelCalls = 0;
    const jobs = new ProjectAnalysisCoordinator({ store, plan: async (request) => {
      modelCalls++;
      const artifacts = await store.listModuleArtifacts(scope);
      assert(artifacts.some((item) => item.kind === 'other' && (item.payload as { state?: string }).state === 'analyzing'));
      const proposal = {
        ...scope, analysisHash: index.analysisHash, objective: request.objective,
        summary: 'Fixture project summary', unassignedFiles: [],
        modules: [{ id: 'fixture', kind: 'feature', name: 'Fixture', description: 'Fixture utilities',
          sourceFiles: index.files.filter((file) => file.projectId === request.projectId).map((file) => file.relativePath),
          symbolKeys: [], dependsOn: [], evidenceIds: [`project:${request.projectId}`] }],
      };
      return { proposal, evidence: { ...scope, analysisHash: index.analysisHash,
        planHash: projectPlanHash(proposal), evidenceIds: [`project:${request.projectId}`] } };
    } });
    await jobs.ensure(projectScope);
    assert.equal(modelCalls, 1);
    const ready = await jobs.read(projectScope);
    assert.equal(ready.state, 'ready', ready.error);
    assert.equal(ready.projection, 'ready', ready.error);
    const projectArtifacts = (await store.listModuleArtifacts(scope)).filter((item) => item.moduleArtifactId.startsWith('project-'));
    assert.equal(projectArtifacts.length, 2);
    for (const artifact of projectArtifacts) {
      assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(`sha256:${artifact.contentHash}`, projectPlanHash(artifact.payload));
      assert.match(artifact.planHash!, /^sha256:[a-f0-9]{64}$/);
    }
    const reopened = new ProjectAnalysisCoordinator({ store, plan: async () => { throw new Error('fixture model failure'); } });
    await reopened.ensure(projectScope);
    assert.equal((await reopened.read(projectScope)).state, 'ready');
    await reopened.ensure(projectScope, true);
    assert.equal((await reopened.read(projectScope)).state, 'failed');
    assert.equal((await reopened.read(projectScope)).error, 'fixture model failure');
    assert((await store.listSearchDocuments(scope)).some((item) => item.kind === 'summary' && item.moduleArtifactId?.startsWith('project-summary:')));
    if (projectJobOnly) {
      console.log(JSON.stringify({ passed: true, projectJobPersistence: true, summaryPersistence: true,
        reopened: true, failurePersistence: true, model: 'fixture' }));
      return;
    }

    await pool.query(`CREATE TABLE ${database}.insert_benchmark (id INT PRIMARY KEY, value TEXT) ORGANIZATION = HEAP`);
    const connection = await pool.getConnection();
    const sql = `INSERT INTO ${database}.insert_benchmark (id, value)`;
    const rows = Array.from({ length: 1000 }, (_, id) => ({ values: [id, `sample '${id} \u4e2d\u6587`] }));
    const timings: Record<string, number> = {};
    try {
      for (const mode of ['single', 'batch']) {
        await connection.beginTransaction();
        const started = performance.now();
        if (mode === 'single') {
          for (const row of rows) await seekDbIndexStoreInternals.insertBatches(connection, sql, [row]);
        } else {
          assert.equal(await seekDbIndexStoreInternals.insertBatches(connection, sql, rows), 4);
        }
        timings[mode] = Math.round(performance.now() - started);
        const [actual] = await connection.query(`SELECT id, value FROM ${database}.insert_benchmark ORDER BY id`);
        assert.deepEqual(actual, rows.map((row) => ({ id: row.values[0], value: row.values[1] })));
        await connection.rollback();
      }
    } finally {
      await connection.rollback();
      connection.release();
    }
    console.log(JSON.stringify({ passed: true, projectJobPersistence: true, summaryPersistence: true, failurePersistence: true,
      files: index.files.length, symbols: index.symbols.length,
      dependencies: index.dependencyEdges.length, summaryUpdateMs: Math.round(summaryMs),
      insertRows: rows.length, singleStatements: rows.length, batchStatements: 4, durationMs: timings }));
  } finally {
    try { if (created) await pool.query(`DROP DATABASE ${database}`); }
    finally { await store.close(); }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
