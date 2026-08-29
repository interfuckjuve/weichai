import type { AddressInfo } from 'node:net';
import type {
  AdaptationRequest,
  AdaptationResult,
  ModuleMigrationProposal,
  RepositoryArchitectureRequest,
  RepositoryStaticAnalysis,
  SearchCandidate,
} from '@forexplore/contracts';
import type {
  CodeAdaptationPort,
  RepositoryArchitecturePort,
} from '@forexplore/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpServer,
  type StaticAnalysisSnapshotStore,
} from './http-server';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(
  adapter: CodeAdaptationPort,
  options: {
    architecturePort?: RepositoryArchitecturePort;
    staticAnalysisSnapshots?: StaticAnalysisSnapshotStore;
  } = {},
): Promise<string> {
  const server = createHttpServer({
    adapter,
    ...options,
    corsOrigin: 'http://localhost:4173',
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const javaCandidate: SearchCandidate = {
  id: 'java-candidate',
  title: 'calculate',
  repository: 'fixture/java',
  license: 'Apache-2.0',
  language: 'Java',
  kind: 'function',
  path: 'src/Calculator.java',
  signature: 'public double calculate()',
  summary: 'Calculates a value.',
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: 'public double calculate() { return 1.0; }',
  dependencies: [],
  compatibility: [],
  risks: [],
};

const adaptationRequest: AdaptationRequest = {
  target: {
    id: 'target',
    name: 'Calculate',
    kind: 'function',
    path: 'src/Calculator.cs',
    language: 'C#',
    signature: 'public decimal Calculate()',
  },
  candidate: javaCandidate,
  requirement: 'Translate the calculation.',
  strategy: 'translate',
  decisionNotes: '',
};

const adaptationResult: AdaptationResult = {
  strategy: 'translate',
  targetLanguage: 'C#',
  generatedCode: 'public decimal Calculate() { return 1.0m; }',
  interfaceMappings: [],
  validation: [
    {
      id: 'compile',
      label: '独立编译',
      status: 'pass',
      required: true,
      command: 'dotnet build --nologo -v q',
      summary: '编译通过。编译通过不证明业务行为正确。',
    },
  ],
  files: [
    {
      path: 'src/Calculator.cs',
      status: 'modified',
      expectedOriginalSha256: 'a'.repeat(64),
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'throw new NotImplementedException();' },
            { type: 'add', content: 'return 1.0m;' },
          ],
        },
      ],
    },
  ],
};

const staticAnalysis: RepositoryStaticAnalysis = {
  schemaVersion: '1.0',
  snapshotId: 'snapshot-http-1',
  contentHash: 'a'.repeat(64),
  analyzerVersion: 'code-indexer/1.0',
  createdAt: '2026-08-26T00:00:00.000Z',
  repository: { revision: 'abc123' },
  files: [{
    path: 'src/Quote.java',
    sha256: 'b'.repeat(64),
    role: 'source',
    language: 'Java',
  }],
  symbols: [{
    id: 'quote-symbol',
    name: 'Quote',
    qualifiedName: 'example.Quote',
    kind: 'class',
    language: 'Java',
    path: 'src/Quote.java',
  }],
  dependencies: [],
  diagnostics: [],
};

const modulePlan: ModuleMigrationProposal = {
  schemaVersion: '1.0',
  snapshotId: staticAnalysis.snapshotId,
  objective: 'Plan quote migration modules.',
  modules: [{
    id: 'quote',
    name: 'Quote',
    kind: 'feature',
    description: 'Quote feature.',
    sourceFiles: ['src/Quote.java'],
    symbolIds: ['quote-symbol'],
    dependsOn: [],
    writeSet: ['src/Quote.java'],
    resourceLocks: [],
    evidenceIds: ['quote-symbol'],
  }],
  fileAssignments: [{ path: 'src/Quote.java', kind: 'module', moduleId: 'quote' }],
  dependencies: [],
  risks: [],
};

describe('adaptation HTTP API', () => {
  it('serves health check', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', provider: 'deepseek' });
  });

  it('routes adaptation requests to the adapter', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => adaptationResult),
    };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });

    expect(response.status).toBe(200);
    expect(adapter.adapt).toHaveBeenCalledWith(
      adaptationRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(adaptationResult);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4173',
    );
  });

  it('plans modules from a server-owned snapshot without accepting repository source', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = {
      proposeModulePlan: vi.fn(async () => modulePlan),
    };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async (snapshotId) => (
        snapshotId === staticAnalysis.snapshotId ? staticAnalysis : null
      )),
    };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: staticAnalysis.snapshotId,
        objective: modulePlan.objective,
        immutableConstraints: ['Keep the public contract stable.'],
      }),
    });

    expect(response.status).toBe(200);
    expect(staticAnalysisSnapshots.getSnapshot).toHaveBeenCalledWith(
      staticAnalysis.snapshotId,
      expect.any(AbortSignal),
    );
    expect(architecturePort.proposeModulePlan).toHaveBeenCalledWith(
      {
        schemaVersion: '1.0',
        analysis: staticAnalysis,
        objective: modulePlan.objective,
        immutableConstraints: ['Keep the public contract stable.'],
      } satisfies RepositoryArchitectureRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(modulePlan);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects module-plan bodies that try to upload analysis, source, or paths', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = { proposeModulePlan: vi.fn() };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = { getSnapshot: vi.fn() };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    for (const body of [
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, analysis: staticAnalysis },
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, source: 'class Secret {}' },
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, path: 'src/Secret.java' },
    ]) {
      const response = await fetch(`${url}/v1/module-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(staticAnalysisSnapshots.getSnapshot).not.toHaveBeenCalled();
    expect(architecturePort.proposeModulePlan).not.toHaveBeenCalled();
  });

  it('does not expose module planning when the read-only host port is absent', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Module planning is not configured.' });
  });

  it('returns 404 when the requested server-owned snapshot does not exist', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = { proposeModulePlan: vi.fn() };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = { getSnapshot: vi.fn(async () => null) };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'unknown', objective: modulePlan.objective }),
    });

    expect(response.status).toBe(404);
    expect(architecturePort.proposeModulePlan).not.toHaveBeenCalled();
  });

  it('disables bare HTTP write-back', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'HTTP write-back is disabled. Apply an approved migration from the VS Code host.',
    });
  });

  it('rejects malformed adaptation requests', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'translate' }),
    });

    expect(response.status).toBe(400);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('requires JSON content type and valid JSON', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const noContentType = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      body: JSON.stringify(adaptationRequest),
    });
    expect(noContentType.status).toBe(415);

    const invalidJson = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes and handles OPTIONS', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
    expect((await fetch(`${url}/v1/adapt`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('returns 502 when the adapter throws', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => {
        throw new Error('DeepSeek API timeout');
      }),
    };
    const url = await listen(adapter);
    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toBe('DeepSeek API timeout');
  });
});
