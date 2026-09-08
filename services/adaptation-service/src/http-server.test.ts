import type { AddressInfo } from 'node:net';
import type {
  AdaptationRequest,
  AdaptationResultV2,
  AdaptationResult,
  ModuleMigrationProposal,
  MigrationRuntimeCapabilitySnapshot,
  RepositoryArchitectureRequest,
  RepositoryIngestionJsonValue,
  RepositoryStaticAnalysis,
  SearchCandidate,
} from '@forexplore/contracts';
import type {
  CodeAdaptationPort,
  MigrationExecutionV2ValidationContext,
  RepositoryArchitecturePort,
} from '@forexplore/workflow-core';
import {
  materializeMigrationRuntimeCapabilitySnapshot,
  validateAdaptationResultV2,
} from '@forexplore/workflow-core';
import {
  createVerificationResult,
  type VerificationStrategyDescriptor,
} from '@forexplore/translation-verifier';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpServer,
  type MigrationExecutionV2ArtifactStore,
  type StaticAnalysisSnapshotStore,
} from './http-server';
import {
  AdaptationAdapterV2,
  type CodeAdaptationPortV2,
} from './adaptation-adapter-v2';
import {
  fixtureVerificationAssessment,
  adaptationV2GeneratedContent,
  adaptationV2TestNow,
  createAdaptationV2TestFixture,
} from "./adaptation-v2-test-support";
import { createAdaptationRuntimeCapabilitySnapshot } from './runtime-capability-snapshot';

const httpBehaviorStrategyDescriptor: VerificationStrategyDescriptor = {
  id: 'forexplore.translation-verifier.differential',
  version: '1.0.0',
  displayName: 'Fixture Differential Verifier',
};

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
    runtimeCapabilitySnapshot?: MigrationRuntimeCapabilitySnapshot;
    adapterV2?: CodeAdaptationPortV2;
    migrationExecutionV2Artifacts?: MigrationExecutionV2ArtifactStore;
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

function deterministicAdapterV2(
  runtimeCapabilities: MigrationRuntimeCapabilitySnapshot,
): CodeAdaptationPortV2 {
  return new AdaptationAdapterV2({
    runtimeCapabilities,
    analyzer: {
      providerId: "forexplore.analyzer.deepseek",
      providerVersion: "1.0.0",
      analyze: async () => ({
        schemaVersion: "1.0",
        behavior: ["Normalize text."],
        targetConstraints: ["Keep sibling function."],
        mappings: [],
        risks: [],
        unresolved: [],
      }),
    },
    planner: {
      providerId: "forexplore.planner.deepseek",
      providerVersion: "1.0.0",
      plan: async () => ({
        schemaVersion: "1.0",
        steps: ["Replace the approved declaration."],
        preservedFacts: [],
        expectedTargetChanges: ["normalize"],
        validationFocus: ["behavior"],
        unresolved: [],
      }),
    },
    translator: {
      providerId: "forexplore.translator.deepseek",
      providerVersion: "1.0.0",
      strategy: "translate",
      translate: async () => ({
        schemaVersion: "1.0",
        generatedContent: adaptationV2GeneratedContent,
        completedSteps: ["translated"],
        unresolved: [],
      }),
      repair: async (_input, _analysis, _plan, previous) => ({
        schemaVersion: "1.0" as const,
        generatedContent: previous.generatedContent,
        completedSteps: previous.completedSteps,
        unresolved: previous.unresolved,
      }),
    },
    verifier: {
      providerId: "forexplore.translation-verifier.differential",
      providerVersion: "1.0.0",
      strategyDescriptor: httpBehaviorStrategyDescriptor,
      verifyWithReceipt: async (input) => ({
        result: createVerificationResult(
          {
            schemaVersion: "1.0",
            request: input.request,
            analysisReport:
              input.analysis as unknown as RepositoryIngestionJsonValue,
            migrationPlan:
              input.plan as unknown as RepositoryIngestionJsonValue,
            translation: {
              round: input.round,
              generatedContent: input.translation.generatedContent,
              files: input.files,
              patchHash: input.patchHash,
            },
          },
          httpBehaviorStrategyDescriptor,
          {
            ...fixtureVerificationAssessment({}),
            status: "pass",
            summary: "Controlled local test-fixture verifier passed.",
            issues: [],
            artifacts: [
              {
                id: "http-v2-report",
                kind: "report",
                path: ".forexplore/evidence/http-v2.json",
                contentHash: "a".repeat(64),
                mediaType: "application/json",
              },
            ],
            strategyReport: { fixture: true },
          },
          () => adaptationV2TestNow,
        ),
        resultArtifact: {
          id: "verification-result:http",
          kind: "verification-result",
          path: "verification-result.json",
          contentHash: "c".repeat(64),
          size: 2,
          mediaType: "application/json",
        },
      }),
    },
    compiler: {
      capability: (languageId) =>
        languageId === "python"
          ? {
              providerId: "forexplore.compiler.python",
              providerVersion: "1.0.0",
            }
          : undefined,
      validate: () => ({
        status: "pass",
        summary: "Python syntax fixture passed.",
      }),
    },
    now: () => adaptationV2TestNow,
  });
}

describe('adaptation HTTP API', () => {
  it('serves health check', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', provider: 'deepseek' });
  });

  it('always serves a validated runtime capability snapshot', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const emptyUrl = await listen(adapter);

    const emptyResponse = await fetch(`${emptyUrl}/v2/runtime-capabilities`);
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual(expect.objectContaining({
      schemaVersion: '2.0',
      id: expect.stringMatching(/^migration-runtime-capabilities:/),
      routes: [],
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    const snapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: '2026-09-02T00:00:00.000Z',
      analysisExecution: 'trusted-host',
      verifierExecution: 'local-process',
      workspaceMutationExecution: 'trusted-host',
    });
    const configuredUrl = await listen(adapter, { runtimeCapabilitySnapshot: snapshot });
    const configuredResponse = await fetch(`${configuredUrl}/v2/runtime-capabilities`);
    expect(configuredResponse.status).toBe(200);
    expect(await configuredResponse.json()).toEqual(snapshot);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects a tampered runtime capability snapshot before listening', () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const snapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: '2026-09-02T00:00:00.000Z',
      analysisExecution: 'trusted-host',
      verifierExecution: 'local-process',
      workspaceMutationExecution: 'trusted-host',
    });
    const tampered = structuredClone(snapshot);
    tampered.contentHash = '0'.repeat(64);

    expect(() => createHttpServer({
      adapter,
      runtimeCapabilitySnapshot: tampered,
    })).toThrow('Runtime capability snapshot hash or canonical structure is invalid');
  });

  it('returns production route unavailability as a structured 409 capability fact', async () => {
    const fixture = createAdaptationV2TestFixture();
    const productionSnapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: 'disabled',
      verifierExecution: 'disabled',
      workspaceMutationExecution: 'disabled',
    });
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const adapterV2: CodeAdaptationPortV2 = { adapt: vi.fn() };
    const url = await listen(adapter, {
      runtimeCapabilitySnapshot: productionSnapshot,
      adapterV2,
    });

    const response = await fetch(`${url}/v2/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture.request),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      schemaVersion: '2.0',
      code: 'MIGRATION_ROUTE_UNAVAILABLE',
      routeId: fixture.request.route.routeId,
      reasonCodes: expect.arrayContaining([
        'behavior-validation:behavior-verifier-execution-disabled',
      ]),
    });
    expect(adapterV2.adapt).not.toHaveBeenCalled();
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('executes POST /v2/adapt only after resolving and validating server-owned artifacts', async () => {
    const fixture = createAdaptationV2TestFixture();
    expect(fixture.serviceRuntime.routes.find((route) => route.id === fixture.route.id)?.availability)
      .toMatchObject({ status: 'unavailable' });
    expect(fixture.runtime.routes.find((route) => route.id === fixture.route.id)?.availability)
      .toMatchObject({ status: 'available' });
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const adapterV2 = deterministicAdapterV2(fixture.serviceRuntime);
    const adapterSpy = vi.spyOn(adapterV2, 'adapt');
    const migrationExecutionV2Artifacts: MigrationExecutionV2ArtifactStore = {
      getArtifacts: vi.fn(async () => fixture.serverArtifacts),
    };
    const url = await listen(adapter, {
      runtimeCapabilitySnapshot: fixture.serviceRuntime,
      adapterV2,
      migrationExecutionV2Artifacts,
    });

    const response = await fetch(`${url}/v2/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture.request),
    });
    const body = await response.json() as AdaptationResultV2;

    expect(response.status).toBe(200);
    expect(validateAdaptationResultV2(body, fixture.request, fixture.validationContext)).toBe(body);
    expect(migrationExecutionV2Artifacts.getArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: fixture.request.id,
        routeId: fixture.request.route.routeId,
        sourceBundleId: fixture.sourceBundle.id,
        targetContextId: fixture.targetContext.id,
      }),
      expect.any(AbortSignal),
    );
    expect(adapterSpy).toHaveBeenCalledWith(
      fixture.request,
      expect.objectContaining({ runtimeCapabilities: fixture.runtime }),
      expect.any(AbortSignal),
    );
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects request artifacts that differ from the authoritative store before V2 execution', async () => {
    const fixture = createAdaptationV2TestFixture();
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const adapterV2: CodeAdaptationPortV2 = { adapt: vi.fn() };
    const migrationExecutionV2Artifacts: MigrationExecutionV2ArtifactStore = {
      getArtifacts: vi.fn(async () => fixture.serverArtifacts),
    };
    const url = await listen(adapter, {
      runtimeCapabilitySnapshot: fixture.serviceRuntime,
      adapterV2,
      migrationExecutionV2Artifacts,
    });
    const tampered = structuredClone(fixture.request);
    tampered.sourceBundle.files[0]!.content = 'preview-like untrusted replacement';

    const response = await fetch(`${url}/v2/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tampered),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      schemaVersion: '2.0',
      code: 'ADAPTATION_ARTIFACT_BINDING_MISMATCH',
      reasonCodes: ['source-bundle-mismatch'],
    });
    expect(adapterV2.adapt).not.toHaveBeenCalled();
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects a host-composed snapshot that overrides a service-owned behavior stage', async () => {
    const serviceRuntime = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: 'disabled',
      verifierExecution: 'local-process',
      workspaceMutationExecution: 'disabled',
    });
    const validCombined = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: 'trusted-host',
      verifierExecution: 'local-process',
      workspaceMutationExecution: 'trusted-host',
    });
    const maliciousCombined = materializeMigrationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      routes: validCombined.routes.map((route) => ({
        ...route,
        stages: route.stages.map((stage) => stage.stage === 'behavior-validation'
          ? { ...stage, providerId: 'host-overrode-behavior-verifier' }
          : stage),
      })),
    });
    const fixture = createAdaptationV2TestFixture({
      serviceRuntime,
      executionRuntime: maliciousCombined,
    });
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const adapterV2: CodeAdaptationPortV2 = { adapt: vi.fn() };
    const migrationExecutionV2Artifacts: MigrationExecutionV2ArtifactStore = {
      getArtifacts: vi.fn(async () => fixture.serverArtifacts),
    };
    const url = await listen(adapter, {
      runtimeCapabilitySnapshot: serviceRuntime,
      adapterV2,
      migrationExecutionV2Artifacts,
    });

    const response = await fetch(`${url}/v2/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fixture.request),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      schemaVersion: '2.0',
      code: 'MIGRATION_RUNTIME_COMPOSITION_REJECTED',
      reasonCodes: ['service-owned-stage-composition-mismatch'],
    });
    expect(adapterV2.adapt).not.toHaveBeenCalled();
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
