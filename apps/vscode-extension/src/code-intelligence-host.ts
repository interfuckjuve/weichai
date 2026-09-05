import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import type {
  AnalysisRevisionRecord,
  ModuleArtifactRecord,
  ModuleTarget,
  RepositoryId,
  RepositoryRecord,
  RepositoryRole,
  RepositoryRevisionScope,
  RepositoryStaticAnalysis,
  SearchCandidate,
  ProjectId,
  ProjectAnalysisPort, ProjectAnalysisResult, ProjectAnalysisScope, ProjectAnalysisRecord,
  StructuralIndex,
} from '@forexplore/contracts';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import type {
  CodeIntelligencePresentation,
  CodeIntelligenceRepositoryPresentation,
  CodeIntelligenceSummaryPresentation,
} from './ui-types';

/** Local-only SeekDB configuration; credentials never cross a UI boundary. */
export interface SeekDbRuntimeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  vectorDimension?: number;
  embedding?: { url: string; apiKey: string; model: string; supportsDimensions?: boolean; queryPrefix?: string; documentPrefix?: string };
}

/** The narrow host composition input intentionally excludes scanners/DB handles from callers. */
export interface CreateCodeIntelligenceRuntimeOptions {
  seekdb?: SeekDbRuntimeConfig;
  moduleReranker?: { url: string; model: string; timeoutMs?: number };
}

export interface CodeIntelligenceEnvironmentOptions {
  /** Production hosts require an explicit SeekDB database; dev/test may opt into transient storage. */
  allowInMemory?: boolean;
}

interface HostIndexStore {
  getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null>;
  getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null>;
  listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]>;
  listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]>;
  putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void>;
}

interface HostRepositoryRegistry {
  get(repositoryId: RepositoryId): Promise<RepositoryRecord | null>;
  list?(): Promise<RepositoryRecord[]>;
  unregister?(repositoryId: RepositoryId): Promise<void>;
  register(request: {
    repositoryId: RepositoryId;
    displayName?: string;
    localPath: string;
    role: RepositoryRole;
  }): Promise<RepositoryRecord>;
}

interface HostAnalysisCoordinator {
  run(request: { repositoryId: RepositoryId; mode: 'full' | 'incremental' }): Promise<unknown>;
}

interface HostJavaCsharpSpecializedProvider {
  register(binding: RepositoryRevisionScope & {
    analysisHash: string;
    analysis: RepositoryStaticAnalysis;
  }): Promise<void>;
}

/**
 * Structural typing keeps VS Code's typecheck out of the service source tree.
 * Runtime composition is still the actual code-intelligence service bundle.
 */
export interface CodeIntelligenceRuntime {
  store: HostIndexStore;
  registry: HostRepositoryRegistry;
  coordinator: HostAnalysisCoordinator;
  /** Trusted host bridge for legacy compiler-probe evidence; never expose it to Agent/MCP callers. */
  javaCsharpSpecializedProvider?: HostJavaCsharpSpecializedProvider;
  queryPort: SemanticQueryPort;
  moduleImplementationSearch?: {
    search(request: {
      target: ModuleTarget;
      requirement: string;
      topK: number;
      repositoryIds: readonly RepositoryId[];
    }, signal?: AbortSignal): Promise<SearchCandidate[]>;
  };
  close(): Promise<void>;
}

interface CodeIntelligenceServiceModule {
  ProjectAnalysisCoordinator: new (options: {
    store: HostIndexStore;
    plan(scope: ProjectAnalysisScope & { objective: string }): Promise<ProjectAnalysisResult>;
    onChange?(): void;
  }) => ProjectAnalysisPort;
  createCodeIntelligenceRuntime(
    options: CreateCodeIntelligenceRuntimeOptions,
  ): Promise<CodeIntelligenceRuntime>;
  SeekDbProjection: new (store: HostIndexStore) => {
    projectModuleArtifacts(index: StructuralIndex, signal?: AbortSignal): Promise<void>;
  };
  createSemanticQueryHttpServer(options: {
    queryPort: SemanticQueryPort;
    bearerToken?: string;
  }): Server;
}

let loadedCodeIntelligenceService: CodeIntelligenceServiceModule | undefined;

function codeIntelligenceService(): CodeIntelligenceServiceModule {
  // Keep test/UI typechecking independent from the service's source-level
  // ESM imports. The actual service is loaded only by the trusted host path.
  loadedCodeIntelligenceService ??= require('@forexplore/code-intelligence-service') as CodeIntelligenceServiceModule;
  return loadedCodeIntelligenceService;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

async function isSemanticQueryEndpoint(
  endpoint: string,
  bearerToken?: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/v1/semantic-query/listRepositories`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { repositories?: unknown };
    return Array.isArray(payload.repositories);
  } catch {
    return false;
  }
}

/**
 * Minimal persistence surface supplied by VS Code's globalState.  IDs are
 * deliberately keyed by a digest of a local path, and no local path ever
 * appears in a presentation returned from this host.
 */
export interface RepositoryIdentityStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): PromiseLike<void>;
}

export type CodeIntelligenceRuntimeFactory = (
  options: CreateCodeIntelligenceRuntimeOptions,
) => Promise<CodeIntelligenceRuntime>;

export interface CodeIntelligenceHostOptions {
  projectAnalysisPort?: ProjectAnalysisPort;
  planProject?: (scope: ProjectAnalysisScope & { objective: string }) => Promise<ProjectAnalysisResult>;
  onChange?: () => void;
  /**
   * The VS Code host owns this composition.  It can use SeekDB when its local
   * process environment has been configured, but it is never created by a
   * webview, MCP tool, or Agent request.
   */
  runtimeOptions?: CreateCodeIntelligenceRuntimeOptions;
  runtimeFactory?: CodeIntelligenceRuntimeFactory;
  identityStore?: RepositoryIdentityStore;
  output?: { appendLine(value: string): void };
  storageKind?: 'seekdb' | 'memory';
  now?: () => string;
  /** Test seam; production uses the service-owned SeekDB projection. */
  projectModuleArtifacts?: (
    runtime: CodeIntelligenceRuntime,
    index: StructuralIndex,
  ) => Promise<void>;
  /** Test seam; production uses the code-intelligence service transport. */
  semanticQueryServerFactory?: (options: {
    queryPort: SemanticQueryPort;
    bearerToken?: string;
  }) => Server;
}

export interface CodeIntelligenceRepositoryInput {
  localPath: string;
  displayName?: string;
  role: RepositoryRole;
}

export interface SynchronizeCodeIntelligenceRequest {
  scanRepositoryIds?: readonly string[];
  /** Automatic history initialization must not crawl unrelated workspace targets. */
  scanRoles?: readonly RepositoryRole[];
  /** Settings changes initialize newly visible roots without rescanning existing ones. */
  scanNewOnly?: boolean;
  repositories: readonly CodeIntelligenceRepositoryInput[];
  /** Full is useful for an explicit user refresh; ordinary refreshes reuse unchanged files. */
  forceFull?: boolean;
  /** Registration-only requests are useful for a lightweight status refresh. */
  scan?: boolean;
}

export interface CodeIntelligenceSynchronizationResult {
  presentation: CodeIntelligencePresentation;
  scannedRepositoryIds: RepositoryId[];
  failedRepositoryIds: RepositoryId[];
}

/**
 * Webview-facing revision intent. The host resolves both opaque IDs against
 * its own registry/store; it never accepts a local path or changes the
 * repository's active revision in response to this request.
 */
export interface SelectCodeIntelligenceRevisionRequest extends RepositoryRevisionScope {}

export interface PublishModuleSummaryRequest extends RepositoryRevisionScope {
  analysisHash: string;
  planHash: string;
  /** Already host-validated summary/plan data. It is never accepted from a Webview. */
  payload: unknown;
  contentHash?: string;
}

/**
 * Local-path input for the trusted host bridge only.  The result deliberately
 * contains revision identifiers but never echoes the root back to a caller.
 */
export interface BindJavaCsharpCompilerProbeEvidenceRequest {
  localPath: string;
  analysis: RepositoryStaticAnalysis;
}

export interface JavaCsharpCompilerProbeBindingResult {
  status: 'bound' | 'skipped';
  repositoryId?: RepositoryId;
  analysisRevision?: string;
}

const identityKeyPrefix = 'forexplore.code-intelligence.repository-id';

function defaultRuntimeFactory(
  options: CreateCodeIntelligenceRuntimeOptions,
): Promise<CodeIntelligenceRuntime> {
  return codeIntelligenceService().createCodeIntelligenceRuntime(options);
}

function stableIdentityKey(localPath: string): string {
  const normalized = process.platform === 'win32'
    ? path.resolve(localPath).toLowerCase()
    : path.resolve(localPath);
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${identityKeyPrefix}:${digest}`;
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function genericRuntimeFailure(): string {
  return '代码智能索引运行时不可用；请检查本机索引配置和输出日志。';
}

function memoryStorageNotice(): string {
  return '代码智能索引正在使用非持久的内存开发存储；配置 CODE_INTELLIGENCE_SEEKDB_DATABASE 以启用 SeekDB。';
}

function repositoryInputKey(input: CodeIntelligenceRepositoryInput): string {
  const normalized = path.resolve(input.localPath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** A presentation name is a label, never a second local-path channel. */
function safeRepositoryDisplayName(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const leaf = normalized.split('/').filter(Boolean).at(-1)?.trim();
  if (!leaf || leaf === '.' || leaf === '..') return 'repository';
  return leaf.slice(0, 160);
}

function preferredRepositoryInputs(
  inputs: readonly CodeIntelligenceRepositoryInput[],
): CodeIntelligenceRepositoryInput[] {
  const byPath = new Map<string, CodeIntelligenceRepositoryInput>();
  for (const input of inputs) {
    if (!input.localPath.trim()) continue;
    const key = repositoryInputKey(input);
    const current = byPath.get(key);
    // A workspace target has a stronger role than the same root configured as
    // a historical corpus.  This makes both paths use one registry record.
    if (!current || input.role === 'target') byPath.set(key, input);
  }
  return [...byPath.values()].sort((left, right) =>
    repositoryInputKey(left).localeCompare(repositoryInputKey(right)),
  );
}

function summaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.status === 'current' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function latestSummaryArtifact(
  artifacts: readonly ModuleArtifactRecord[],
  revision: AnalysisRevisionRecord,
): ModuleArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => (
      artifact.kind === 'module-summary' &&
      artifact.analysisHash === revision.analysisHash &&
      Boolean(artifact.planHash)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function isReadOnlyQueryableRevision(
  revision: AnalysisRevisionRecord,
): revision is AnalysisRevisionRecord & { status: 'ready' | 'superseded' } {
  return revision.status === 'ready' || revision.status === 'superseded';
}

function isBoundedOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isJavaCsharpLegacyFile(file: RepositoryStaticAnalysis['files'][number]): boolean {
  return file.language === 'Java' || file.language === 'C#';
}

/**
 * A compiler-probe snapshot is only safe to attach when its Java/C# source
 * bytes exactly match the active structural revision.  Other languages are
 * intentionally outside this compatibility provider's evidence domain.
 */
function compilerProbeFilesMatchStructuralIndex(
  analysis: RepositoryStaticAnalysis,
  index: StructuralIndex,
): boolean {
  const legacyFiles = analysis.files.filter(isJavaCsharpLegacyFile);
  const structuralFiles = index.files.filter((file) =>
    file.languageId === 'java' || file.languageId === 'csharp',
  );
  if (legacyFiles.length === 0 || legacyFiles.length !== structuralFiles.length) return false;
  const structuralByPath = new Map(structuralFiles.map((file) => [file.relativePath, file.sha256]));
  return legacyFiles.every((file) => structuralByPath.get(file.path) === file.sha256);
}

/**
 * Trusted VS Code composition for the shared repository chain.  The host is
 * allowed to hold local paths and invoke Registry/Coordinator; consumers get
 * only `SemanticQueryPort` or the path-free presentation above.
 */
export class CodeIntelligenceHost {
  #projectAnalysis?: ProjectAnalysisPort;
  #planProject?: CodeIntelligenceHostOptions['planProject'];
  #onChange?: () => void;
  #syncQueue: Promise<unknown> = Promise.resolve();
  #selectedTarget?: RepositoryId;
  #selectionSequence = 0;
  readonly #runtimeFactory: CodeIntelligenceRuntimeFactory;
  readonly #runtimeOptions: CreateCodeIntelligenceRuntimeOptions;
  readonly #identityStore?: RepositoryIdentityStore;
  readonly #output?: { appendLine(value: string): void };
  readonly #storageKind: 'seekdb' | 'memory';
  readonly #now: () => string;
  readonly #projectModuleArtifacts: (runtime: CodeIntelligenceRuntime, index: StructuralIndex) => Promise<void>;
  readonly #semanticQueryServerFactory: NonNullable<CodeIntelligenceHostOptions['semanticQueryServerFactory']>;
  #runtimePromise: Promise<CodeIntelligenceRuntime> | undefined;
  #synchronizing: Promise<CodeIntelligenceSynchronizationResult> | undefined;
  #ephemeralRepositoryIds = new Map<string, RepositoryId>();
  /** Repository visibility belongs to one VS Code window, not the shared persistent registry. */
  #visibleRepositoryIds = new Set<RepositoryId>();
  /** Per-panel-host display choice only; never persisted as repository state. */
  #selectedRevisions = new Map<RepositoryId, string>();
  #selectedProjects = new Map<RepositoryId, ProjectId>();
  #semanticQueryServer: Server | undefined;
  #semanticQueryEndpoint: string | undefined;
  #semanticServerStart?: Promise<string>;
  #lastFailure = false;
  #disposed = false;

  constructor(options: CodeIntelligenceHostOptions = {}) {
    this.#projectAnalysis = options.projectAnalysisPort;
    this.#planProject = options.planProject;
    this.#onChange = options.onChange;
    this.#runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
    this.#runtimeOptions = options.runtimeOptions ?? {};
    this.#identityStore = options.identityStore;
    this.#output = options.output;
    this.#storageKind = options.storageKind ?? (options.runtimeOptions?.seekdb ? 'seekdb' : 'memory');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#projectModuleArtifacts = options.projectModuleArtifacts ?? (async (runtime, index) => {
      await new (codeIntelligenceService().SeekDbProjection)(runtime.store).projectModuleArtifacts(index);
    });
    this.#semanticQueryServerFactory = options.semanticQueryServerFactory
      ?? ((serverOptions) => codeIntelligenceService().createSemanticQueryHttpServer(serverOptions));
  }

  /** Safe read-only data boundary suitable for a ToolCallingArchitectRuntime. */
  async semanticQueryPort(): Promise<SemanticQueryPort> {
    return (await this.runtime()).queryPort;
  }

  /**
   * Starts the loopback-only query transport consumed by the adaptation
   * service. The server exposes the already-composed read-only port and never
   * receives a local path or a database credential.
   */
  async startSemanticQueryServer(options: {
    port?: number;
    bearerToken?: string;
  } = {}): Promise<string> {
    if (this.#semanticServerStart) {
      const endpoint = await this.#semanticServerStart;
      if (this.#semanticQueryServer?.listening || await isSemanticQueryEndpoint(endpoint, options.bearerToken)) {
        return endpoint;
      }
      this.#semanticServerStart = undefined;
      this.#semanticQueryEndpoint = undefined;
    }
    if (!this.#semanticServerStart) {
      this.#semanticServerStart = this.startSemanticQueryServerInternal(options).catch((error) => {
        this.#semanticServerStart = undefined;
        throw error;
      });
    }
    return this.#semanticServerStart;
  }

  private async startSemanticQueryServerInternal(options: { port?: number; bearerToken?: string }): Promise<string> {
    if (this.#semanticQueryEndpoint) return this.#semanticQueryEndpoint;
    const port = options.port ?? 8790;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error('Semantic query server port must be a valid TCP port.');
    }
    const server = this.#semanticQueryServerFactory({
      queryPort: await this.semanticQueryPort(),
      ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
    });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if (isAddressInUse(error) && await isSemanticQueryEndpoint(endpoint, options.bearerToken)) {
        this.#semanticQueryEndpoint = endpoint;
        this.#output?.appendLine(`[forexplore] reusing semantic query port at ${endpoint}.`);
        return endpoint;
      }
      throw error;
    }
    this.#semanticQueryServer = server;
    this.#semanticQueryEndpoint = endpoint;
    this.#output?.appendLine(`[forexplore] semantic query port listening at ${this.#semanticQueryEndpoint}.`);
    return this.#semanticQueryEndpoint;
  }

  /** Resolves a registered local root to the active revision without exposing the root. */
  async activeScopeForPath(localPath: string): Promise<RepositoryRevisionScope> {
    const runtime = await this.runtime();
    const repositoryId = await this.existingRepositoryIdFor(localPath);
    if (!repositoryId) throw new Error('The repository path is not registered in the code-intelligence host.');
    const repository = await runtime.registry.get(repositoryId);
    if (!repository?.activeRevision) throw new Error('The repository has no active analysis revision.');
    return { repositoryId, analysisRevision: repository.activeRevision };
  }

  async selectedProjectForPath(localPath: string): Promise<ProjectId | null> {
    const scope = await this.activeScopeForPath(localPath);
    const selected = this.#selectedProjects.get(scope.repositoryId);
    if (!selected) return null;
    const projects = await (await this.runtime()).queryPort.listProjects(scope);
    return projects.projects.some((project) => project.value.projectId === selected) ? selected : null;
  }

  /** Runs module-first retrieval only across this window's current historical repositories. */
  async searchHistoricalImplementations(request: {
    target: ModuleTarget;
    requirement: string;
    topK: number;
  }, signal?: AbortSignal): Promise<SearchCandidate[]> {
    const runtime = await this.runtime();
    const targetScope = request.target.module;
    if (targetScope?.repositoryId && targetScope.analysisRevision) {
      const targetRepository = await runtime.registry.get(targetScope.repositoryId);
      if (targetRepository?.role !== 'target' || targetRepository.activeRevision !== targetScope.analysisRevision) {
        throw new Error('目标模块版本已变化，请重新选择当前模块。');
      }
    }
    if (!runtime.moduleImplementationSearch) {
      throw new Error('当前代码智能运行时未提供模块检索能力。');
    }
    const repositoryIds = (await runtime.registry.list?.() ?? [])
      .filter((repository) => repository.role === 'history' && this.#visibleRepositoryIds.has(repository.repositoryId))
      .map((repository) => repository.repositoryId);
    return runtime.moduleImplementationSearch.search({ ...request, repositoryIds }, signal);
  }

  /** Returns the active structural index for trusted host-side presentation. */
  async structuralIndexForPath(localPath: string): Promise<StructuralIndex | null> {
    try {
      const scope = await this.activeScopeForPath(localPath);
      return await (await this.runtime()).store.getStructuralIndex(scope);
    } catch {
      return null;
    }
  }

  async synchronize(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    const operation = this.#syncQueue.catch(() => {}).then(() => this.synchronizeInternal(request)).finally(() => {
      if (this.#synchronizing === operation) this.#synchronizing = undefined;
    });
    this.#synchronizing = operation;
    this.#syncQueue = operation;
    return operation;
  }

  /** Read the safe UI model without handing the Webview a registry or store. */
  async presentation(): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) {
      return this.emptyPresentation('error', genericRuntimeFailure());
    }
    if (!this.#runtimePromise) return this.emptyPresentation('initializing');
    try {
      const runtime = await this.runtime();
      return await this.presentationFor(runtime);
    } catch (error) {
      this.logFailure('read code intelligence status', error);
      return this.emptyPresentation('error', genericRuntimeFailure());
    }
  }

  /**
   * Select an already-indexed revision for read-only presentation/query work.
   * This only changes an in-memory display choice and deliberately never calls
   * the registry's activation APIs or the analysis coordinator.
   */
  async selectRevisionForDisplay(
    request: SelectCodeIntelligenceRevisionRequest,
  ): Promise<CodeIntelligencePresentation> {
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (!isBoundedOpaqueIdentifier(request.repositoryId) || !isBoundedOpaqueIdentifier(request.analysisRevision)) {
      throw new Error('A revision selection requires bounded repository and revision identifiers.');
    }
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository) throw new Error('The selected repository is not registered in this host.');
    const [revision, index] = await Promise.all([
      runtime.store.getRevision(request),
      runtime.store.getStructuralIndex(request),
    ]);
    if (
      !revision ||
      !index ||
      !isReadOnlyQueryableRevision(revision) ||
      index.analysisHash !== revision.analysisHash
    ) {
      throw new Error('The selected analysis revision is not available for read-only queries.');
    }
    // Verify the public query boundary accepts this exact immutable scope
    // before exposing it as selected. This remains a read-only operation.
    await runtime.queryPort.getRepositoryOverview(request);
    this.#selectedRevisions.set(request.repositoryId, request.analysisRevision);
    return this.presentationFor(runtime);
  }

  /** Selects a host-verified project inside the currently displayed revision. */
  async selectProjectForDisplay(request: RepositoryRevisionScope & { projectId: ProjectId }): Promise<CodeIntelligencePresentation> {
    const sequence = ++this.#selectionSequence;
    if (this.#disposed) throw new Error('Code intelligence host has been disposed.');
    if (!isBoundedOpaqueIdentifier(request.repositoryId) ||
        !isBoundedOpaqueIdentifier(request.analysisRevision) ||
        !isBoundedOpaqueIdentifier(request.projectId)) {
      throw new Error('A project selection requires bounded repository, revision, and project identifiers.');
    }
    const runtime = await this.runtime();
    const projects = await runtime.queryPort.listProjects({
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
    });
    if (!projects.projects.some((project) => project.value.projectId === request.projectId)) {
      throw new Error('The selected project is not part of the requested analysis revision.');
    }
    const repository = await runtime.registry.get(request.repositoryId);
    if (sequence !== this.#selectionSequence) return this.presentationFor(runtime);
    this.#selectedRevisions.set(request.repositoryId, request.analysisRevision);
    this.#selectedProjects.set(request.repositoryId, request.projectId);
    if (repository?.role === 'target') this.#selectedTarget = request.repositoryId;
    if (repository?.activeRevision === request.analysisRevision) this.scheduleProject(request);
    return this.presentationFor(runtime);
  }

  /**
   * Host-only summary publication for the tool-calling planning flow.  Legacy
   * RepositoryStaticAnalysis summaries are intentionally not coerced into a
   * new revision: their analysis hash is a different evidence domain.
   */
  async publishModuleSummary(request: PublishModuleSummaryRequest): Promise<void> {
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(request.repositoryId);
    if (!repository || repository.activeRevision !== request.analysisRevision) {
      throw new Error('A module summary may only be published for the active repository revision.');
    }
    const revision = await runtime.store.getRevision(request);
    const index = await runtime.store.getStructuralIndex(request);
    if (!revision || !index || revision.analysisHash !== request.analysisHash) {
      throw new Error('Module summary analysisHash does not match the indexed analysis revision.');
    }
    if (!request.planHash.trim()) throw new Error('Module summary planHash is required.');

    const now = this.#now();
    await runtime.store.putModuleArtifact({
      ...request,
      moduleArtifactId: `module-summary:${randomUUID()}`,
      kind: 'module-summary',
      status: 'current',
      contentHash: request.contentHash ?? contentHash(request.payload),
      createdAt: now,
      updatedAt: now,
    });
    // Rebuild only this revision's non-authoritative search projection.  The
    // projection class owns SeekDB writes and has no global clear operation.
    await this.#projectModuleArtifacts(runtime, index);
  }

  /**
   * Bind an already host-verified Java/C# compiler-probe snapshot to the
   * active structural revision.  This is intentionally a host-only hook: no
   * Agent, Webview, or MCP caller can supply a root or access the provider.
   *
   * The caller must have registered/scanned the root first.  A mismatch or a
   * missing Java/C# semantic bridge is non-fatal to the legacy workflow and
   * returns `skipped` without changing the active revision.
   */
  async bindJavaCsharpCompilerProbeEvidence(
    request: BindJavaCsharpCompilerProbeEvidenceRequest,
  ): Promise<JavaCsharpCompilerProbeBindingResult> {
    if (this.#disposed || !request.localPath.trim()) return { status: 'skipped' };
    try {
      const runtime = await this.runtime();
      const repositoryId = await this.existingRepositoryIdFor(request.localPath);
      if (!repositoryId) return { status: 'skipped' };
      const repository = await runtime.registry.get(repositoryId);
      const analysisRevision = repository?.activeRevision;
      if (!repository || !analysisRevision || !runtime.javaCsharpSpecializedProvider) {
        return { status: 'skipped', repositoryId };
      }
      const scope = { repositoryId, analysisRevision };
      const revision = await runtime.store.getRevision(scope);
      const index = await runtime.store.getStructuralIndex(scope);
      if (
        !revision ||
        revision.status !== 'ready' ||
        !index ||
        index.analysisHash !== revision.analysisHash ||
        !compilerProbeFilesMatchStructuralIndex(request.analysis, index)
      ) {
        return { status: 'skipped', repositoryId, analysisRevision };
      }
      await runtime.javaCsharpSpecializedProvider.register({
        ...scope,
        analysisHash: revision.analysisHash,
        analysis: request.analysis,
      });
      return { status: 'bound', repositoryId, analysisRevision };
    } catch (error) {
      this.logFailure('bind Java/C# compiler-probe evidence', error);
      return { status: 'skipped' };
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#selectedRevisions.clear();
    this.#selectedProjects.clear();
    const semanticQueryServer = this.#semanticQueryServer;
    this.#semanticQueryServer = undefined;
    this.#semanticQueryEndpoint = undefined;
    if (semanticQueryServer) {
      semanticQueryServer.close();
      semanticQueryServer.closeIdleConnections();
    }
    const pending = this.#runtimePromise;
    this.#runtimePromise = undefined;
    if (pending) {
      void pending.then((runtime) => runtime.close()).catch(() => undefined);
    }
  }

  private async synchronizeInternal(
    request: SynchronizeCodeIntelligenceRequest,
  ): Promise<CodeIntelligenceSynchronizationResult> {
    this.#output?.appendLine('[forexplore] code intelligence synchronization started.');
    let runtime: CodeIntelligenceRuntime;
    try {
      runtime = await this.runtime();
    } catch (error) {
      this.logFailure('start code intelligence runtime', error);
      return {
        presentation: this.emptyPresentation('error', genericRuntimeFailure()),
        scannedRepositoryIds: [],
        failedRepositoryIds: [],
      };
    }

    const registered = new Map<RepositoryId, RepositoryRecord>();
    const previouslyVisible = this.#visibleRepositoryIds;
    const failedRepositoryIds: RepositoryId[] = [];
    let registrationFailed = false;
    const normalizedInputs = await Promise.all(request.repositories.map(async (input) => ({
      ...input, localPath: await realpath(path.resolve(input.localPath)).catch(() => path.resolve(input.localPath)),
    })));
    const preferredInputs = preferredRepositoryInputs(normalizedInputs);
    const requestedScanPaths = request.scanRoles
      ? new Set(normalizedInputs.filter((input) => request.scanRoles!.includes(input.role)).map(repositoryInputKey))
      : undefined;
    for (const input of preferredInputs) {
      try {
        const repositoryId = await this.repositoryIdFor(input.localPath);
        const repository = await runtime.registry.register({
          repositoryId,
          localPath: input.localPath,
          role: input.role,
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
        });
        registered.set(repository.repositoryId, repository);
      } catch (error) {
        // The only identifier available to UI clients is a registered ID, so
        // an unregistered local-path error stays in the trusted host log.
        this.logFailure('register code intelligence repository', error);
        registrationFailed = true;
      }
    }
    this.#visibleRepositoryIds = new Set(registered.keys());
    if (this.#selectedTarget && !this.#visibleRepositoryIds.has(this.#selectedTarget)) {
      this.#selectedTarget = undefined;
    }
    this.#onChange?.();

    const scannedRepositoryIds: RepositoryId[] = [];
    if (request.scan !== false) {
      for (const repository of registered.values()) {
        if (request.scanRepositoryIds && !request.scanRepositoryIds.includes(repository.repositoryId)) continue;
        // A path explicitly configured as history can also be a workspace
        // target. Role precedence must not suppress that requested scan.
        if (requestedScanPaths && !requestedScanPaths.has(repositoryInputKey(repository))) continue;
        if (request.scanNewOnly && previouslyVisible.has(repository.repositoryId) &&
          (!requestedScanPaths || repository.activeRevision)) continue;
        try {
          this.#output?.appendLine(`[forexplore] indexing ${repository.role} repository: ${repository.displayName}.`);
          await runtime.coordinator.run({
            repositoryId: repository.repositoryId,
            mode: request.forceFull || !repository.activeRevision ? 'full' : 'incremental',
          });
          scannedRepositoryIds.push(repository.repositoryId);
          const current = await runtime.registry.get(repository.repositoryId);
          if (current?.activeRevision) {
            const index = await runtime.store.getStructuralIndex({ repositoryId: current.repositoryId, analysisRevision: current.activeRevision });
            for (const project of index?.projects ?? []) {
              if (repository.role === 'history' || index?.projects.length === 1 ||
                project.projectId === this.#selectedProjects.get(repository.repositoryId)) this.scheduleProject(project);
            }
          }
        } catch (error) {
          failedRepositoryIds.push(repository.repositoryId);
          this.logFailure(`index repository ${repository.repositoryId}`, error);
        } finally {
          this.#onChange?.();
        }
      }
    }

    this.#lastFailure = registrationFailed || failedRepositoryIds.length > 0;
    let presentation: CodeIntelligencePresentation;
    try {
      presentation = await this.presentationFor(runtime);
    } catch (error) {
      this.#lastFailure = true;
      this.logFailure('read synchronized code intelligence status', error);
      presentation = this.emptyPresentation('error', genericRuntimeFailure());
    }
    this.#output?.appendLine(
      `[forexplore] code intelligence synchronization complete: ${scannedRepositoryIds.length} scanned, ${failedRepositoryIds.length} failed.`,
    );
    return { presentation, scannedRepositoryIds, failedRepositoryIds };
  }

  private async projectAnalysis(): Promise<ProjectAnalysisPort> {
    const runtime = await this.runtime();
    this.#projectAnalysis ??= new (codeIntelligenceService().ProjectAnalysisCoordinator)({
      store: runtime.store,
      plan: (scope) => this.#planProject!(scope),
      onChange: this.#onChange,
    });
    return this.#projectAnalysis;
  }

  private scheduleProject(scope: ProjectAnalysisScope, force = false): void {
    if (!this.#planProject || this.#disposed) return;
    void this.projectAnalysis().then((analysis) => analysis.ensure(scope, force))
      .catch((error) => this.logFailure('project module analysis', error));
  }

  async retryProject(scope: ProjectAnalysisScope, force = false): Promise<void> {
    const runtime = await this.runtime();
    const repository = await runtime.registry.get(scope.repositoryId);
    if (repository?.activeRevision !== scope.analysisRevision) throw new Error('只能重试活动版本的项目。');
    const index = await runtime.store.getStructuralIndex(scope);
    if (!index?.projects.some((p) => p.projectId === scope.projectId)) throw new Error('项目不存在。');
    this.scheduleProject(scope, force);
  }

  async waitForProjects(): Promise<void> { await this.#projectAnalysis?.idle(); }

  /** Trusted presentation bridge: no filesystem fallback and no local JSON summaries. */
  async explorerData(): Promise<Array<{
    repository: RepositoryRecord; index: StructuralIndex; projectId: string;
    analysis?: ProjectAnalysisRecord; selectedTarget: boolean;
  }>> {
    const runtime = await this.runtime();
    const repositories = (await runtime.registry.list?.() ?? [])
      .filter((repository) => this.#visibleRepositoryIds.has(repository.repositoryId));
    const target = repositories.find((r) => r.repositoryId === this.#selectedTarget && r.role === 'target')
      ?? repositories.find((r) => r.role === 'target');
    return (await Promise.all(repositories.map(async (repository) => {
      const analysisRevision = this.#selectedRevisions.get(repository.repositoryId) ?? repository.activeRevision;
      if (!analysisRevision) return null;
      const index = await runtime.store.getStructuralIndex({ repositoryId: repository.repositoryId, analysisRevision });
      if (!index) return null;
      const projectId = index.projects.find((p) => p.projectId === this.#selectedProjects.get(repository.repositoryId))?.projectId
        ?? (repository.role === 'history' || index.projects.length === 1 ? index.projects[0]?.projectId : undefined);
      if (!projectId) return null;
      return {
        repository, index, projectId, selectedTarget: repository.repositoryId === target?.repositoryId,
        ...(this.#planProject ? { analysis: await (await this.projectAnalysis()).read({ repositoryId: repository.repositoryId, analysisRevision, projectId }) } : {}),
      };
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async runtime(): Promise<CodeIntelligenceRuntime> {
    if (!this.#runtimePromise) {
      this.#runtimePromise = this.#runtimeFactory(this.#runtimeOptions);
    }
    return this.#runtimePromise;
  }

  private async repositoryIdFor(localPath: string): Promise<RepositoryId> {
    const key = stableIdentityKey(await realpath(path.resolve(localPath)).catch(() => path.resolve(localPath)));
    const stored = this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key);
    if (stored) return stored;
    const generated = `repo-${randomUUID()}`;
    this.#ephemeralRepositoryIds.set(key, generated);
    await this.#identityStore?.update(key, generated);
    return generated;
  }

  private async existingRepositoryIdFor(localPath: string): Promise<RepositoryId | null> {
    const key = stableIdentityKey(await realpath(path.resolve(localPath)).catch(() => path.resolve(localPath)));
    return this.#identityStore?.get<RepositoryId>(key) ?? this.#ephemeralRepositoryIds.get(key) ?? null;
  }

  private async presentationFor(runtime: CodeIntelligenceRuntime): Promise<CodeIntelligencePresentation> {
    const listed = await runtime.queryPort.listRepositories();
    const repositories = await Promise.all(listed.repositories
      .filter((repository) => this.#visibleRepositoryIds.has(repository.repositoryId))
      .map(async (repository) => {
      const activeRevision = repository.analysisRevision;
      const availableRevisions = await this.revisionPresentations(
        runtime,
        repository.repositoryId,
        activeRevision,
      );
      const selectedRevision = this.selectedRevisionForDisplay(
        repository.repositoryId,
        activeRevision,
        availableRevisions,
      );
      const revisions = availableRevisions.map((revision) => ({
        ...revision,
        isSelected: revision.analysisRevision === selectedRevision?.analysisRevision,
      }));
      if (!selectedRevision) {
        return {
          repositoryId: repository.repositoryId,
          displayName: safeRepositoryDisplayName(repository.displayName),
          role: repository.role,
          analysisStatus: repository.analysisStatus,
          activeRevision,
          selectedRevision: null,
          revisions,
          languages: [],
          projects: [],
          selectedProjectId: null,
          summary: { status: 'missing' },
        } satisfies CodeIntelligenceRepositoryPresentation;
      }
      const scope = {
        repositoryId: repository.repositoryId,
        analysisRevision: selectedRevision.analysisRevision,
      };
      const [overview, projectsResult] = await Promise.all([
        runtime.queryPort.getRepositoryOverview(scope),
        runtime.queryPort.listProjects(scope),
      ]);
      const projects = await Promise.all(projectsResult.projects.map(async (project) => ({
        projectId: project.value.projectId,
        displayName: project.value.displayName,
        kind: project.value.kind,
        relativePath: project.value.relativePath,
        languageIds: [...project.value.languageIds],
        ...(this.#planProject ? { analysis: await (await this.projectAnalysis()).read(project.value) } : {}),
      })));
      const requestedProjectId = this.#selectedProjects.get(repository.repositoryId);
      const selectedProjectId = requestedProjectId && projects.some((project) => project.projectId === requestedProjectId)
        ? requestedProjectId
        : repository.role === 'history' || projects.length === 1 ? projects[0]?.projectId ?? null : null;
      if (requestedProjectId && requestedProjectId !== selectedProjectId) this.#selectedProjects.delete(repository.repositoryId);
      const projectAnalysis = projects.find((project) => project.projectId === selectedProjectId)?.analysis;
      return {
        repositoryId: repository.repositoryId,
        displayName: safeRepositoryDisplayName(repository.displayName),
        role: repository.role,
        analysisStatus: repository.analysisStatus,
        activeRevision,
        selectedRevision: selectedRevision.analysisRevision,
        revisions,
        languages: overview.overview.value.languages.map((language) => ({ ...language })),
        projects,
        selectedProjectId,
        summary: this.#planProject ? {
          status: projectAnalysis?.state === 'stale' ? 'stale' : projectAnalysis?.proposal ? 'current' : 'missing',
          analysisRevision: selectedRevision.analysisRevision,
          ...(projectAnalysis?.planHash ? { planHash: projectAnalysis.planHash } : {}),
        } : await this.summaryPresentation(
          runtime,
          scope,
          activeRevision
            ? { repositoryId: repository.repositoryId, analysisRevision: activeRevision }
            : null,
        ),
      } satisfies CodeIntelligenceRepositoryPresentation;
      }));
    const message = this.#lastFailure
      ? '部分仓库索引失败；请检查扩展输出日志。'
      : this.#storageKind === 'memory'
        ? memoryStorageNotice()
        : undefined;
    return {
      status: this.#lastFailure ? 'error' : 'ready',
      storage: this.#storageKind,
      repositories: repositories.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
      ...(message ? { message } : {}),
    };
  }

  private async revisionPresentations(
    runtime: CodeIntelligenceRuntime,
    repositoryId: RepositoryId,
    activeRevision: string | null,
  ): Promise<CodeIntelligenceRepositoryPresentation['revisions']> {
    const records = await runtime.store.listRevisions(repositoryId);
    const candidates = await Promise.all(records.map(async (revision) => {
      if (!isReadOnlyQueryableRevision(revision)) return null;
      const index = await runtime.store.getStructuralIndex(revision);
      if (!index || index.analysisHash !== revision.analysisHash) return null;
      return {
        analysisRevision: revision.analysisRevision,
        analysisHash: revision.analysisHash,
        status: revision.status,
        createdAt: revision.createdAt,
        ...(revision.completedAt ? { completedAt: revision.completedAt } : {}),
        isActive: revision.analysisRevision === activeRevision,
        isSelected: false,
      } satisfies CodeIntelligenceRepositoryPresentation['revisions'][number];
    }));
    return candidates
      .filter((revision): revision is NonNullable<typeof revision> => revision !== null)
      .sort((left, right) => (
        Number(right.isActive) - Number(left.isActive) ||
        right.createdAt.localeCompare(left.createdAt) ||
        left.analysisRevision.localeCompare(right.analysisRevision)
      ));
  }

  private selectedRevisionForDisplay(
    repositoryId: RepositoryId,
    activeRevision: string | null,
    revisions: CodeIntelligenceRepositoryPresentation['revisions'],
  ): CodeIntelligenceRepositoryPresentation['revisions'][number] | null {
    const requested = this.#selectedRevisions.get(repositoryId);
    const selected = requested
      ? revisions.find((revision) => revision.analysisRevision === requested)
      : undefined;
    if (requested && !selected) this.#selectedRevisions.delete(repositoryId);
    return selected ?? revisions.find((revision) => revision.analysisRevision === activeRevision) ?? null;
  }

  private async summaryPresentation(
    runtime: CodeIntelligenceRuntime,
    displayedScope: RepositoryRevisionScope,
    activeScope: RepositoryRevisionScope | null,
  ): Promise<CodeIntelligenceSummaryPresentation> {
    const displayedRevision = await runtime.store.getRevision(displayedScope);
    if (!displayedRevision) return { status: 'missing' };
    const displayedArtifacts = await runtime.store.listModuleArtifacts(displayedScope);

    // Historical revision selection is a view/query concern only. Its summary
    // cannot be presented as current when a different active revision exists.
    if (!activeScope || activeScope.analysisRevision !== displayedScope.analysisRevision) {
      const historical = latestSummaryArtifact(displayedArtifacts, displayedRevision);
      if (!historical) return { status: 'missing' };
      return {
        status: 'stale',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: historical.analysisHash,
        planHash: historical.planHash,
        updatedAt: historical.updatedAt,
      };
    }

    const current = summaryArtifact(displayedArtifacts, displayedRevision);
    if (current) {
      return {
        status: 'current',
        analysisRevision: displayedScope.analysisRevision,
        analysisHash: current.analysisHash,
        planHash: current.planHash,
        updatedAt: current.updatedAt,
      };
    }

    const revisions = await runtime.store.listRevisions(displayedScope.repositoryId);
    for (const revision of revisions) {
      if (revision.analysisRevision === displayedScope.analysisRevision) continue;
      const artifacts = await runtime.store.listModuleArtifacts(revision);
      const stale = latestSummaryArtifact(artifacts, revision);
      if (stale) {
        return {
          status: 'stale',
          analysisRevision: revision.analysisRevision,
          analysisHash: stale.analysisHash,
          planHash: stale.planHash,
          updatedAt: stale.updatedAt,
        };
      }
    }
    return { status: 'missing' };
  }

  private emptyPresentation(
    status: Extract<CodeIntelligencePresentation['status'], 'initializing' | 'error'>,
    message?: string,
  ): CodeIntelligencePresentation {
    return {
      status,
      storage: this.#storageKind,
      repositories: [],
      ...(message ? { message } : {}),
    };
  }

  private logFailure(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#output?.appendLine(`[forexplore] ${action}: ${detail}`);
  }
}

/**
 * SeekDB credentials stay in the local extension process environment.  Empty
 * configuration intentionally selects the in-memory development store rather
 * than guessing credentials or turning a Webview setting into a DB capability.
 */
export function codeIntelligenceRuntimeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: CodeIntelligenceEnvironmentOptions = {},
): CreateCodeIntelligenceRuntimeOptions {
  const database = environment.CODE_INTELLIGENCE_SEEKDB_DATABASE?.trim();
  if (!database) {
    if (options.allowInMemory === false) {
      throw new Error(
        'CODE_INTELLIGENCE_SEEKDB_DATABASE must be configured for a production code-intelligence host.',
      );
    }
    return {};
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_DATABASE must be a SQL identifier.');
  }
  const portValue = environment.CODE_INTELLIGENCE_SEEKDB_PORT?.trim();
  const port = portValue === undefined || portValue === '' ? 2881 : Number(portValue);
  const vectorDimensionValue = environment.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION?.trim();
  const vectorDimension = vectorDimensionValue === undefined || vectorDimensionValue === ''
    ? 384
    : Number(vectorDimensionValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_PORT must be a valid TCP port.');
  }
  if (!Number.isInteger(vectorDimension) || vectorDimension <= 0) {
    throw new Error('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION must be a positive integer.');
  }
  const embeddingUrl = environment.CODE_INTELLIGENCE_EMBEDDING_URL?.trim();
  const embeddingModel = environment.CODE_INTELLIGENCE_EMBEDDING_MODEL?.trim();
  if (Boolean(embeddingUrl) !== Boolean(embeddingModel)) throw new Error('Configure both CODE_INTELLIGENCE_EMBEDDING_URL and CODE_INTELLIGENCE_EMBEDDING_MODEL.');
  const rerankerUrl = environment.CODE_INTELLIGENCE_RERANK_URL?.trim();
  const rerankerModel = environment.CODE_INTELLIGENCE_RERANK_MODEL?.trim();
  if (Boolean(rerankerUrl) !== Boolean(rerankerModel)) throw new Error('Configure both CODE_INTELLIGENCE_RERANK_URL and CODE_INTELLIGENCE_RERANK_MODEL.');
  return {
    ...(rerankerUrl && rerankerModel ? { moduleReranker: { url: rerankerUrl, model: rerankerModel,
      timeoutMs: Number(environment.CODE_INTELLIGENCE_RERANK_TIMEOUT_MS ?? 4_000) } } : {}),
    seekdb: {
      host: environment.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1',
      port,
      user: environment.CODE_INTELLIGENCE_SEEKDB_USER?.trim() || 'root',
      password: environment.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '',
      database,
      vectorDimension,
      ...(embeddingUrl && embeddingModel ? { embedding: {
        url: embeddingUrl, model: embeddingModel, apiKey: environment.CODE_INTELLIGENCE_EMBEDDING_API_KEY ?? '',
        supportsDimensions: environment.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS !== 'false',
        queryPrefix: environment.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ?? '',
        documentPrefix: environment.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ?? '',
      } } : {}),
    },
  };
}

export const codeIntelligenceHostInternals = {
  compilerProbeFilesMatchStructuralIndex,
  contentHash,
  isJavaCsharpLegacyFile,
  memoryStorageNotice,
  preferredRepositoryInputs,
  repositoryInputKey,
  safeRepositoryDisplayName,
  stableIdentityKey,
  summaryArtifact,
};
