import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { expect, it } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, createSemanticQueryHttpServer, ProjectAnalysisCoordinator } from './index.js';
import { ToolCallingArchitectRuntime } from '../../adaptation-service/src/tool-calling-architect-runtime';
import { HttpSemanticQueryPort } from '../../adaptation-service/src/http-semantic-query-port';
import { createHttpServer } from '../../adaptation-service/src/http-server';
import { requestSemanticModuleMigrationProposal } from '../../../apps/vscode-extension/src/module-plan-client';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it('publishes a project summary through the actual planning HTTP route and revision-scoped tool transport', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-http-project-'));
  const servers: Server[] = [];
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
    await writeFile(path.join(root, 'index.ts'), 'export function add(a: number, b: number) { return a + b; }');
    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await runtime.registry.register({ repositoryId: 'history', role: 'history', localPath: root });
    const run = await runtime.coordinator.run({ repositoryId: 'history' });
    const index = (await runtime.store.getStructuralIndex(run.scope))!;
    const project = index.projects[0]!;
    const queryServer = createSemanticQueryHttpServer({ queryPort: runtime.queryPort }); servers.push(queryServer);
    const queryPort = new HttpSemanticQueryPort({ endpoint: await listen(queryServer) });
    let turns = 0;
    let objective = '';
    const architect = new ToolCallingArchitectRuntime({ queryPort, client: { complete: async (messages) => {
      turns++;
      const user = messages.find((message) => message.role === 'user')!;
      const response = JSON.parse(user.content.split('[INITIAL_PROJECT_CONTEXT]\n')[1]!.split('\n')[0]!);
      expect(response.files.items).toHaveLength(2);
      expect(response.symbols.items.length).toBeGreaterThan(0);
      expect(response.dependencies.omittedFromPage).toBe(0);
      return { content: JSON.stringify({
        schemaVersion: '1.0', ...run.scope, analysisHash: index.analysisHash, objective,
        summary: 'Provides an addition function.', unassignedFiles: [],
        modules: [{ id: 'math', name: 'Math', kind: 'feature', description: 'Addition utilities',
          sourceFiles: response.files.items.map((file: { relativePath: string }) => file.relativePath),
          symbolKeys: [], dependsOn: [], writeSet: [], resourceLocks: [], evidenceIds: [response.project.evidenceId] }],
      }) };
    } } });
    const adaptation = createHttpServer({
      adapter: { adapt: async () => { throw new Error('not used'); } }, semanticArchitecturePort: architect,
    }); servers.push(adaptation);
    const url = await listen(adaptation);
    const jobs = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async (request) => {
      objective = request.objective;
      return requestSemanticModuleMigrationProposal(url, request);
    } });
    const scope = { ...run.scope, projectId: project.projectId };
    await jobs.ensure(scope);
    const record = await jobs.read(scope);
    expect(record.error).toBeUndefined();
    expect(record).toMatchObject({ state: 'ready', projection: 'ready', coverage: { total: 2, assigned: 2 } });
    expect(record.proposal?.summary).toBe('Provides an addition function.');
    expect(turns).toBe(1);
    expect((await runtime.store.listSearchDocuments(run.scope)).some((document) => document.kind === 'summary')).toBe(true);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    await rm(root, { recursive: true, force: true });
  }
});
