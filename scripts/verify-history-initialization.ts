import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createCodeIntelligenceRuntime, SeekDbIndexStore } from '../services/code-intelligence-service/src/index';
import { CodeIntelligenceHost } from '../apps/vscode-extension/src/code-intelligence-host';

async function main(): Promise<void> {
  const database = `history_init_${randomUUID().replaceAll('-', '')}`;
  const config = {
    host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1',
    port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root',
    password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
  };
  const admin = mysql.createPool(config);
  const store = new SeekDbIndexStore({ ...config, database });
  let host: CodeIntelligenceHost | undefined;
  try {
    const runtime = await createCodeIntelligenceRuntime({ store });
    const scans: string[] = [];
    const run = runtime.coordinator.run.bind(runtime.coordinator);
    runtime.coordinator.run = async (request) => {
      const repository = await runtime.registry.get(request.repositoryId);
      assert.equal(repository?.role, 'history', 'Parent workspace must not be scanned during history initialization.');
      scans.push(repository.localPath);
      return run(request);
    };
    host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, storageKind: 'seekdb' });
    const started = performance.now();
    const result = await host.synchronize({
      repositories: [
        { localPath: path.resolve('..'), role: 'target' },
        { localPath: path.resolve('fixtures/code-corpus/account-stream-rs'), role: 'history' },
      ],
      scanRoles: ['history'],
    });
    assert.equal(result.presentation.status, 'ready');
    assert.equal(result.failedRepositoryIds.length, 0);
    assert.equal(scans.length, 1);
    const history = result.presentation.repositories.find((repository) => repository.role === 'history')!;
    const target = result.presentation.repositories.find((repository) => repository.role === 'target')!;
    assert.equal(history.analysisStatus, 'ready');
    assert.equal(target.activeRevision, null);
    const index = await store.getStructuralIndex({ repositoryId: history.repositoryId, analysisRevision: history.activeRevision! });
    assert(index);
    assert.equal(index.files.length, 16);
    console.log(JSON.stringify({ passed: true, durationMs: Math.round(performance.now() - started),
      scannedPaths: scans, files: index.files.length, symbols: index.symbols.length,
      dependencies: index.dependencyEdges.length, parentWorkspaceScanned: false }));
  } finally {
    host?.dispose();
    await store.close();
    try { await admin.query(`DROP DATABASE IF EXISTS ${database}`); }
    finally { await admin.end(); }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
