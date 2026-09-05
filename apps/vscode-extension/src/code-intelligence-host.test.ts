import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryStaticAnalysis } from '@forexplore/contracts';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  type CodeIntelligenceRuntime,
  type RepositoryIdentityStore,
} from './code-intelligence-host';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryIdentityStore implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createRuntime(options: { languageId?: 'typescript' | 'java' | 'csharp' } = {}):
  CodeIntelligenceRuntime & { registeredBindings: Array<Record<string, unknown>> } {
  const repositories = new Map<string, any>();
  const revisions = new Map<string, any>();
  const indexes = new Map<string, any>();
  const artifacts = new Map<string, any[]>();
  const registeredBindings: Array<Record<string, unknown>> = [];
  const languageId = options.languageId ?? 'typescript';
  const relativePath = languageId === 'java'
    ? 'src/Example.java'
    : languageId === 'csharp'
      ? 'src/Example.cs'
      : 'src/example.ts';
  let scanCount = 0;
  const key = (scope: { repositoryId: string; analysisRevision: string }) =>
    `${scope.repositoryId}\u0000${scope.analysisRevision}`;
  const store = {
    async getRevision(scope: { repositoryId: string; analysisRevision: string }) {
      return revisions.get(key(scope)) ?? null;
    },
    async getStructuralIndex(scope: { repositoryId: string; analysisRevision: string }) {
      return indexes.get(key(scope)) ?? null;
    },
    async listRevisions(repositoryId: string) {
      return [...revisions.values()]
        .filter((revision) => revision.repositoryId === repositoryId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async listModuleArtifacts(scope: { repositoryId: string; analysisRevision: string }) {
      return [...(artifacts.get(key(scope)) ?? [])];
    },
    async putModuleArtifact(artifact: any) {
      const entries = artifacts.get(key(artifact)) ?? [];
      entries.push({ ...artifact });
      artifacts.set(key(artifact), entries);
    },
  };
  const registry = {
    async list() { return [...repositories.values()]; },
    async unregister(repositoryId: string) { repositories.delete(repositoryId); },
    async get(repositoryId: string) {
      return repositories.get(repositoryId) ?? null;
    },
    async register(input: any) {
      const samePath = [...repositories.values()].find((repository) => repository.localPath === input.localPath);
      const current = samePath ?? {
        repositoryId: input.repositoryId,
        localPath: input.localPath,
        createdAt: '2026-01-01T00:00:00.000Z',
        activeRevision: null,
        analysisStatus: 'registered',
      };
      const next = {
        ...current,
        displayName: input.displayName ?? path.basename(input.localPath),
        role: input.role,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      repositories.set(next.repositoryId, next);
      return next;
    },
  };
  const coordinator = {
    async run(request: { repositoryId: string }) {
      const repository = repositories.get(request.repositoryId);
      if (!repository) throw new Error('unknown repository');
      scanCount += 1;
      const scope = { repositoryId: request.repositoryId, analysisRevision: `revision-${scanCount}` };
      const priorRevision = repository.activeRevision;
      if (priorRevision) {
        const prior = revisions.get(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision }));
        if (prior) prior.status = 'superseded';
        const priorArtifacts = artifacts.get(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision })) ?? [];
        artifacts.set(key({ repositoryId: request.repositoryId, analysisRevision: priorRevision }), priorArtifacts.map((artifact) => (
          artifact.status === 'current' ? { ...artifact, status: 'stale' } : artifact
        )));
      }
      const index = {
        ...scope,
        analysisHash: `analysis-${scanCount}`,
        projects: [],
        files: [{
          ...scope,
          fileId: `file-${scanCount}`,
          relativePath,
          languageId,
          role: 'source',
          sha256: `sha-${scanCount}`,
          sizeBytes: 1,
          parseStatus: 'parsed',
        }],
        symbols: [],
        dependencyEdges: [],
        diagnostics: [],
      };
      revisions.set(key(scope), {
        ...scope,
        status: 'ready',
        analysisHash: index.analysisHash,
        indexerVersion: 'test',
        createdAt: `2026-01-01T00:00:0${scanCount}.000Z`,
      });
      indexes.set(key(scope), index);
      repositories.set(request.repositoryId, {
        ...repository,
        activeRevision: scope.analysisRevision,
        analysisStatus: 'ready',
        updatedAt: `2026-01-01T00:00:0${scanCount}.000Z`,
      });
    },
  };
  const queryPort = {
    async listRepositories() {
      return {
        repositories: [...repositories.values()].map(({ localPath: _localPath, ...repository }) => ({
          ...repository,
          analysisRevision: repository.activeRevision,
        })),
      };
    },
    async getRepositoryOverview(scope: { repositoryId: string; analysisRevision: string }) {
      const repository = repositories.get(scope.repositoryId);
      const revision = revisions.get(key(scope));
      const index = indexes.get(key(scope));
      if (!repository || !revision || !index) throw new Error('unknown revision');
      const { localPath: _localPath, ...safeRepository } = repository;
      return {
        overview: {
          ...scope,
          evidenceId: `revision:${scope.analysisRevision}`,
          provider: 'tree-sitter',
          confidence: 1,
          evidenceLevel: 'structural',
          relativePath: null,
          sourceRange: null,
          value: {
            repository: safeRepository,
            revision,
            projectCount: 0,
            fileCount: index.files.length,
            symbolCount: 0,
            dependencyCount: 0,
            diagnosticCount: 0,
            languages: [{ languageId, capabilityLevel: 'structural', fileCount: index.files.length }],
          },
        },
      };
    },
    async listProjects() {
      return { projects: [] };
    },
  };
  return {
    store,
    registry,
    coordinator,
    javaCsharpSpecializedProvider: {
      async register(binding) {
        registeredBindings.push({ ...binding });
      },
    },
    queryPort: queryPort as any,
    registeredBindings,
    async close() {},
  };
}

async function temporaryRepository(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `forexplore-code-intelligence-${name}-`));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'example.ts'), 'export const example = 1;\n');
  return root;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function semanticQueryTestServer(options: { bearerToken?: string }) {
  return createServer((request, response) => {
    const authorization = request.headers.authorization;
    if (options.bearerToken && authorization !== `Bearer ${options.bearerToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unauthorized.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ repositories: [] }));
  });
}

function javaCompilerProbeAnalysis(sha256 = 'sha-1'): RepositoryStaticAnalysis {
  return {
    schemaVersion: '1.0',
    snapshotId: 'legacy-java-snapshot',
    contentHash: 'legacy-content',
    analyzerVersion: 'legacy-compiler-probe',
    createdAt: '2026-01-01T00:00:00.000Z',
    repository: {},
    files: [{
      path: 'src/Example.java',
      sha256,
      role: 'source',
      language: 'Java',
    }],
    symbols: [{
      id: 'java:Example',
      name: 'Example',
      qualifiedName: 'sample.Example',
      kind: 'class',
      language: 'Java',
      path: 'src/Example.java',
      range: { path: 'src/Example.java', startLine: 1, endLine: 2 },
    }],
    dependencies: [{
      id: 'java-edge',
      sourceSymbolId: 'java:Example',
      targetSymbolId: 'java:Example',
      sourcePath: 'src/Example.java',
      targetPath: 'src/Example.java',
      kind: 'invocation',
      internal: true,
      resolution: 'resolved',
      evidence: 'semantic',
      evidenceRanges: [{ path: 'src/Example.java', startLine: 1, endLine: 1 }],
      snapshotId: 'legacy-java-snapshot',
    }],
    diagnostics: [],
  };
}

describe('CodeIntelligenceHost', () => {
  it('runs target and history roots through one host-owned revision chain without leaking local paths', async () => {
    const history = await temporaryRepository('history');
    const target = await temporaryRepository('target');
    const identityStore = new MemoryIdentityStore();
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore,
      storageKind: 'memory',
    });

    const result = await host.synchronize({
      repositories: [
        { localPath: history, role: 'history', displayName: 'C:\\private\\Legacy' },
        { localPath: target, role: 'target', displayName: '/private/Target' },
      ],
    });

    expect(result.failedRepositoryIds).toEqual([]);
    expect(result.scannedRepositoryIds).toHaveLength(2);
    expect(result.presentation).toMatchObject({ status: 'ready', storage: 'memory' });
    expect(result.presentation.message).toContain('非持久');
    expect(result.presentation.repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: 'Legacy', role: 'history', activeRevision: expect.any(String) }),
      expect.objectContaining({ displayName: 'Target', role: 'target', activeRevision: expect.any(String) }),
    ]));
    expect(result.presentation.repositories.every((repository) => (
      repository.languages.some((language) => (
        language.languageId === 'typescript' && language.capabilityLevel === 'structural'
      ))
    ))).toBe(true);
    expect(JSON.stringify(result.presentation)).not.toContain(history);
    expect(JSON.stringify(result.presentation)).not.toContain(target);
    expect(JSON.stringify(result.presentation)).not.toContain('private');

    const queryPort = await host.semanticQueryPort();
    const listed = await queryPort.listRepositories();
    expect(listed.repositories).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(history);
    expect(JSON.stringify(listed)).not.toContain(target);
  });

  it('binds a Java compiler-probe snapshot only when its source hashes match the active structural revision', async () => {
    const target = await temporaryRepository('java-binding');
    const runtime = createRuntime({ languageId: 'java' });
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore: new MemoryIdentityStore(),
      storageKind: 'memory',
    });

    const indexed = await host.synchronize({
      repositories: [{ localPath: target, role: 'target', displayName: 'Java target' }],
    });
    const repository = indexed.presentation.repositories[0];
    expect(repository?.activeRevision).toBe('revision-1');

    const bound = await host.bindJavaCsharpCompilerProbeEvidence({
      localPath: target,
      analysis: javaCompilerProbeAnalysis(),
    });
    expect(bound).toEqual({
      status: 'bound',
      repositoryId: repository?.repositoryId,
      analysisRevision: 'revision-1',
    });
    expect(runtime.registeredBindings).toEqual([
      expect.objectContaining({
        repositoryId: repository?.repositoryId,
        analysisRevision: 'revision-1',
        analysisHash: 'analysis-1',
      }),
    ]);

    await expect(host.bindJavaCsharpCompilerProbeEvidence({
      localPath: target,
      analysis: javaCompilerProbeAnalysis('different-sha'),
    })).resolves.toMatchObject({ status: 'skipped' });
    expect(runtime.registeredBindings).toHaveLength(1);
  });

  it('marks a formerly current summary stale after activating a newer revision', async () => {
    const target = await temporaryRepository('summary');
    const runtime = createRuntime();
    const host = new CodeIntelligenceHost({
      runtimeFactory: async () => runtime,
      identityStore: new MemoryIdentityStore(),
      projectModuleArtifacts: async () => {},
    });

    const initial = await host.synchronize({
      repositories: [{ localPath: target, role: 'target' }],
    });
    const repository = initial.presentation.repositories[0];
    expect(repository?.activeRevision).toBeTruthy();
    const scope = {
      repositoryId: repository!.repositoryId,
      analysisRevision: repository!.activeRevision!,
    };
    const revision = await runtime.store.getRevision(scope);
    expect(revision).not.toBeNull();
    await host.publishModuleSummary({
      ...scope,
      analysisHash: revision!.analysisHash,
      planHash: 'sha256:approved-plan',
      payload: { approved: true },
    });
    expect((await host.presentation()).repositories[0]?.summary.status).toBe('current');

    const refreshed = await host.synchronize({
      repositories: [{ localPath: target, role: 'target' }],
    });
    const refreshedRepository = refreshed.presentation.repositories[0];
    expect(refreshedRepository?.activeRevision).not.toBe(scope.analysisRevision);
    expect(refreshedRepository?.summary).toMatchObject({
      status: 'stale',
      analysisRevision: scope.analysisRevision,
      analysisHash: revision!.analysisHash,
      planHash: 'sha256:approved-plan',
    });

    const selected = await host.selectRevisionForDisplay(scope);
    const selectedRepository = selected.repositories.find((item) => item.repositoryId === scope.repositoryId);
    expect((await runtime.registry.get(scope.repositoryId))?.activeRevision)
      .toBe(refreshedRepository?.activeRevision);
    expect(selectedRepository).toMatchObject({
      activeRevision: refreshedRepository?.activeRevision,
      selectedRevision: scope.analysisRevision,
      summary: {
        status: 'stale',
        analysisRevision: scope.analysisRevision,
      },
    });
    expect(selectedRepository?.revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ analysisRevision: refreshedRepository?.activeRevision, isActive: true, isSelected: false }),
      expect.objectContaining({ analysisRevision: scope.analysisRevision, status: 'superseded', isActive: false, isSelected: true }),
    ]));

    await expect(host.selectRevisionForDisplay({
      repositoryId: scope.repositoryId,
      analysisRevision: 'unknown-revision',
    })).rejects.toThrow(/not available for read-only queries/);
    expect((await runtime.registry.get(scope.repositoryId))?.activeRevision)
      .toBe(refreshedRepository?.activeRevision);
  });

  it('keeps SeekDB configuration in the host environment and validates it before composition', () => {
    expect(codeIntelligenceRuntimeOptionsFromEnvironment({})).toEqual({});
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({}, { allowInMemory: false }))
      .toThrow(/must be configured for a production/);
    expect(codeIntelligenceRuntimeOptionsFromEnvironment({
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'code_intelligence',
      CODE_INTELLIGENCE_SEEKDB_PORT: '2881',
    })).toMatchObject({
      seekdb: {
        host: '127.0.0.1',
        port: 2881,
        database: 'code_intelligence',
      },
    });
    expect(() => codeIntelligenceRuntimeOptionsFromEnvironment({
      CODE_INTELLIGENCE_SEEKDB_DATABASE: 'invalid-name',
    })).toThrow(/SQL identifier/);
  });
});

it('processes a saved configuration that arrives during a scan, including removals', async () => {
  const first = await temporaryRepository('queued-first');
  const second = await temporaryRepository('queued-second');
  const runtime = createRuntime();
  const originalRun = runtime.coordinator.run.bind(runtime.coordinator);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  runtime.coordinator.run = async (request) => {
    if (++count === 1) { started(); await gate; }
    return originalRun(request);
  };
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const initial = host.synchronize({ repositories: [{ localPath: first, role: 'history' }] });
  await ready;
  const updated = host.synchronize({ repositories: [{ localPath: second, role: 'history' }] });
  release(); await initial;
  const result = await updated;
  expect(result.presentation.repositories).toHaveLength(1);
  expect(result.presentation.repositories[0]?.displayName).toBe(path.basename(second));
  expect(await runtime.registry.list!()).toHaveLength(2);
  expect(count).toBe(2);
});

it('keeps shared repository data while each host presents only its configured repositories', async () => {
  const first = await temporaryRepository('shared-first');
  const second = await temporaryRepository('shared-second');
  const runtime = createRuntime();
  const firstHost = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });
  const secondHost = new CodeIntelligenceHost({ runtimeFactory: async () => runtime });

  const firstResult = await firstHost.synchronize({ repositories: [{ localPath: first, role: 'target' }] });
  const secondResult = await secondHost.synchronize({ repositories: [{ localPath: second, role: 'target' }] });

  expect(firstResult.presentation.repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(first)]);
  expect(secondResult.presentation.repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(second)]);
  expect(await runtime.registry.list!()).toHaveLength(2);
  expect((await firstHost.presentation()).repositories.map((repository) => repository.displayName))
    .toEqual([path.basename(first)]);
});

it('reuses a compatible semantic query listener owned by another host', async () => {
  const runtime = createRuntime();
  const firstHost = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
    semanticQueryServerFactory: semanticQueryTestServer,
  });
  const secondHost = new CodeIntelligenceHost({
    runtimeFactory: async () => runtime,
    semanticQueryServerFactory: semanticQueryTestServer,
  });
  const port = await availablePort();

  try {
    const firstEndpoint = await firstHost.startSemanticQueryServer({ port, bearerToken: 'shared-token' });
    const secondEndpoint = await secondHost.startSemanticQueryServer({ port, bearerToken: 'shared-token' });
    expect(secondEndpoint).toBe(firstEndpoint);
  } finally {
    firstHost.dispose();
    secondHost.dispose();
  }
});
