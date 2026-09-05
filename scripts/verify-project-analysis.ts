import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  createCodeIntelligenceRuntime, createSemanticQueryHttpServer, SeekDbIndexStore, ProjectAnalysisCoordinator,
} from '../services/code-intelligence-service/src/index';
import { ToolCallingArchitectRuntime, createDeepSeekToolCallingArchitectClient } from '../services/adaptation-service/src/tool-calling-architect-runtime';
import { HttpSemanticQueryPort } from '../services/adaptation-service/src/http-semantic-query-port';
import { createHttpServer } from '../services/adaptation-service/src/http-server';
import { CodeIntelligenceHost } from '../apps/vscode-extension/src/code-intelligence-host';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client';
import { buildProjectExplorer } from '../apps/vscode-extension/src/project-explorer';
import type { ProjectAnalysisScope } from '../packages/contracts/src';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const configuredDatabase = process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
  const database = configuredDatabase ?? `project_live_${randomUUID().replaceAll('-', '')}`;
  const corpus = process.argv.includes('--corpus');
  assert(apiKey, 'Set DEEPSEEK_API_KEY and, for a compatible provider, DEEPSEEK_API_BASE / DEEPSEEK_MODEL.');
  assert(database, 'Set CODE_INTELLIGENCE_SEEKDB_DATABASE to a dedicated acceptance database.');
  const config = {
    host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1',
    port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root',
    password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '', database,
  };
  const admin = mysql.createPool({ ...config, database: undefined });
  if (!configuredDatabase) await admin.query(`CREATE DATABASE ${database}`);
  const store = new SeekDbIndexStore(config);
  const runtime = await createCodeIntelligenceRuntime({ store });
  // Refuse to reconcile a real user's registry with the acceptance fixture paths.
  assert.equal((await runtime.registry.list()).length, 0, 'Acceptance database must contain no registered repositories.');
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-live-analysis-'));
  const servers: Server[] = [];
  const modelRequests: unknown[] = [];
  let acceptanceReport: unknown = { passed: false, modelRequests };
  try {
    const queryServer = createSemanticQueryHttpServer({ queryPort: runtime.queryPort }); servers.push(queryServer);
    const queryUrl = await listen(queryServer);
    let modelTurns = 0;
    const client = createDeepSeekToolCallingArchitectClient({ apiKey, temperature: 0,
      request: async (url, init) => {
        const turn = modelTurns;
        const started = performance.now();
        const response = await fetch(url, init);
        const payload = await response.clone().json() as { usage?: unknown; choices?: Array<{ message?: { tool_calls?: Array<{ function: { name: string } }> } }> };
        const metrics = { turn, durationMs: Math.round(performance.now() - started),
          status: response.status, usage: payload.usage,
          tools: payload.choices?.[0]?.message?.tool_calls?.map((call) => call.function.name) ?? [] };
        modelRequests.push(metrics);
        console.log('[live-model]', JSON.stringify(metrics));
        return response;
      },
    });
    const architecture = new ToolCallingArchitectRuntime({
      queryPort: new HttpSemanticQueryPort({ endpoint: queryUrl }),
      client: { complete: (...args) => { modelTurns++; return client.complete(...args); } },
    });
    const adaptation = createHttpServer({
      adapter: { adapt: async () => { throw new Error('Code adaptation is outside this acceptance test.'); } },
      semanticArchitecturePort: architecture,
    });
    servers.push(adaptation);
    const adaptationUrl = await listen(adaptation);
    const plan = (scope: ProjectAnalysisScope & { objective: string }) =>
      requestSemanticModuleMigrationProposal(adaptationUrl, scope, undefined, AbortSignal.timeout(300_000));
    const jobs = new ProjectAnalysisCoordinator({ store, plan });
    const identities = new Map<string, string>();
    const hostOptions = {
      runtimeFactory: async () => runtime, planProject: plan, projectAnalysisPort: jobs,
      identityStore: { get: <T>(key: string) => identities.get(key) as T | undefined, update: async (key: string, value: string) => { identities.set(key, value); } },
    };
    const host = new CodeIntelligenceHost(hostOptions);
    const inputs = [];
    const repositories = corpus
      ? [['ledger-flow-ts', 'history'], ['account-stream-rs', 'history'], ['circuit-lane-java', 'target']] as const
      : [['history-a', 'history'], ['history-b', 'history'], ['target', 'target']] as const;
    for (const [name, role] of repositories) {
      const localPath = corpus ? path.resolve('fixtures/code-corpus', name) : path.join(root, name);
      if (!corpus) {
        await mkdir(localPath);
        await writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name }));
        await writeFile(path.join(localPath, 'index.ts'), 'export function add(a: number, b: number): number { return a + b; }');
      }
      inputs.push({ localPath, role });
    }
    const started = performance.now();
    await host.synchronize({ repositories: inputs }); await host.waitForProjects();
    let view = await host.presentation();
    const results = view.repositories.map((repository) => ({ name: repository.displayName,
      projects: repository.projects.map((project) => ({ projectId: project.projectId,
        state: project.analysis?.state, projection: project.analysis?.projection, error: project.analysis?.error,
        coverage: project.analysis?.coverage, proposal: project.analysis?.proposal })) }));
    acceptanceReport = { passed: false, modelTurns, modelRequests, results };
    assert.equal(view.repositories.length, 3);
    for (const repository of view.repositories) {
      for (const project of repository.projects) {
        assert.equal(project.analysis?.state, 'ready', project.analysis?.error);
        assert.equal(project.analysis?.projection, 'ready', project.analysis?.error);
        assert(project.analysis.proposal?.summary);
      }
    }
    const turnsAfterPublish = modelTurns;
    const analysisDurationMs = Math.round(performance.now() - started);
    const revisions = view.repositories.map((r) => r.activeRevision);
    await host.synchronize({ repositories: inputs }); await host.waitForProjects();
    assert.equal(modelTurns, turnsAfterPublish, 'Unchanged refresh must not invoke the model.');
    view = await host.presentation();
    assert.deepEqual(view.repositories.map((r) => r.activeRevision), revisions);
    const reopenedJobs = new ProjectAnalysisCoordinator({ store, plan });
    const reopened = new CodeIntelligenceHost({ ...hostOptions, projectAnalysisPort: reopenedJobs });
    await reopened.synchronize({ repositories: inputs }); await reopened.waitForProjects();
    const tree = await buildProjectExplorer(reopened);
    assert(tree.presentation.target.analysis?.proposal?.summary);
    assert.equal(tree.presentation.history.length, 2);
    assert.equal(modelTurns, turnsAfterPublish, 'Reopening must read persisted summaries.');
    const report = { passed: true, repositories: view.repositories.length, modelTurns, analysisDurationMs,
      durableSummaries: true, unchangedRefresh: true, reopened: true, modelRequests, results };
    acceptanceReport = report;
    console.log(JSON.stringify(report));
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    try {
      if (corpus) {
        await mkdir('logs', { recursive: true });
        await writeFile('logs/project-analysis-live.json', JSON.stringify(acceptanceReport, null, 2));
      }
      if (configuredDatabase) {
        for (const repository of await runtime.registry.list()) await runtime.registry.unregister(repository.repositoryId);
      }
    } finally {
      await store.close();
      try {
        if (!configuredDatabase) {
          await admin.query('SET SESSION ob_query_timeout = 60000000');
          await admin.query(`DROP DATABASE ${database}`);
        }
      } finally {
        await admin.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
