import type {
  ModuleMigrationPlan,
  ModuleMigrationProposal,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { moduleMigrationSchemaVersion } from '@forexplore/contracts';
import { buildModuleMigrationPlan } from '@forexplore/workflow-core';
import { localFetch } from './local-fetch';

/** The only payload the extension sends to the read-only architecture API. */
export interface ModulePlanRequest {
  snapshotId: string;
  objective: string;
  immutableConstraints?: string[];
}

export interface SemanticModulePlanRequest {
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
  objective: string;
  immutableConstraints?: string[];
}

export interface SemanticModulePlanProposal {
  summary?: string;
  unassignedFiles?: Array<{ path: string; reason: string }>;
  repositoryId: string;
  analysisRevision: string;
  analysisHash: string;
  objective: string;
  modules: Array<{
    id: string;
    name: string;
    kind: 'feature' | 'shared-contract' | 'infrastructure' | 'integration' | 'test-support' | 'other';
    description: string;
    purpose?: string;
    coreApis?: string[];
    language?: 'TypeScript' | 'Python' | 'Java' | 'C#' | 'Rust' | 'Go' | 'Mixed' | 'Unknown';
    domain?: string;
    sourceFiles: string[];
    symbolKeys: string[];
    dependsOn: string[];
    writeSet: string[];
    resourceLocks: string[];
    evidenceIds: string[];
  }>;
  dependencies?: Array<{
    moduleId: string;
    dependsOnModuleId: string;
    source: 'static' | 'architect' | 'human';
    evidenceIds: string[];
  }>;
  risks?: string[];
}

export interface SemanticModulePlanResult {
  proposal: SemanticModulePlanProposal;
  evidence: {
    repositoryId: string;
    analysisRevision: string;
    analysisHash: string;
    planHash: string;
    evidenceIds: string[];
  };
}

/**
 * Builds the module-planning endpoint without allowing a configured base URL
 * to retain a query, fragment, or browser-controlled request path.
 */
export function modulePlanEndpoint(adaptationApiUrl: string): string {
  let base: URL;
  try {
    base = new URL(adaptationApiUrl);
  } catch {
    throw new Error('模块规划服务地址无效。');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('模块规划服务必须使用 HTTP 或 HTTPS 地址。');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}/v1/module-plan`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

export function semanticModulePlanEndpoint(adaptationApiUrl: string): string {
  let base: URL;
  try {
    base = new URL(adaptationApiUrl);
  } catch {
    throw new Error('模块规划服务地址无效。');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('模块规划服务必须使用 HTTP 或 HTTPS 地址。');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}/v1/semantic-module-plan`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

/**
 * Requests the revision-scoped tool-calling plan. Unlike the legacy route,
 * this payload cannot carry a snapshot, source text, or local path.
 */
export async function requestSemanticModuleMigrationProposal(
  adaptationApiUrl: string,
  request: SemanticModulePlanRequest,
  fetcher: typeof localFetch = localFetch,
  signal?: AbortSignal,
): Promise<SemanticModulePlanResult> {
  assertSemanticModulePlanRequest(request);
  const response = await fetcher(semanticModulePlanEndpoint(adaptationApiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      objective: request.objective,
      ...(request.immutableConstraints === undefined
        ? {}
        : { immutableConstraints: request.immutableConstraints }),
    }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = extractServiceError(payload) ?? `HTTP ${response.status}`;
    throw new Error(`revision-scoped 模块规划服务拒绝请求：${message}`);
  }
  if (!isRecord(payload) || !isRecord(payload.proposal) || !isRecord(payload.evidence)) {
    throw new Error('revision-scoped 模块规划服务返回了无效结果。');
  }
  return payload as unknown as SemanticModulePlanResult;
}

/**
 * Requests an untrusted proposal from the architecture service.  Repository
 * contents never cross this boundary: the service receives only an immutable
 * snapshot ID plus the host-collected planning request.
 */
export async function requestModuleMigrationProposal(
  adaptationApiUrl: string,
  request: ModulePlanRequest,
  fetcher: typeof localFetch = localFetch,
  signal?: AbortSignal,
): Promise<ModuleMigrationProposal> {
  assertModulePlanRequest(request);
  const response = await fetcher(modulePlanEndpoint(adaptationApiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      snapshotId: request.snapshotId,
      objective: request.objective,
      ...(request.immutableConstraints === undefined
        ? {}
        : { immutableConstraints: request.immutableConstraints }),
    }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = extractServiceError(payload) ?? `HTTP ${response.status}`;
    throw new Error(`模块规划服务拒绝请求：${message}`);
  }
  if (!isRecord(payload)) {
    throw new Error('模块规划服务返回的提案不是 JSON 对象。');
  }
  // The model/service response is deliberately treated as untrusted. The
  // deterministic workflow validator below owns all partition and schedule
  // safety decisions.
  return payload as unknown as ModuleMigrationProposal;
}

/** Validate the architecture output and derive the host-owned schedule. */
export function buildTrustedModuleMigrationPlan(
  analysis: RepositoryStaticAnalysis,
  proposal: ModuleMigrationProposal,
  now = new Date().toISOString(),
): ModuleMigrationPlan {
  return buildModuleMigrationPlan(analysis, proposal, {
    now,
    maxParallelism: 4,
  });
}

/**
 * Adapts a revision-scoped proposal to the existing migration scheduler while
 * retaining the new proposal as the authoritative SeekDB artifact. The
 * adapter never invents files or symbols: it only joins semantic paths to
 * the host-owned legacy snapshot for compatibility with wave execution.
 */
export function buildLegacyModuleMigrationProposalFromSemantic(
  analysis: RepositoryStaticAnalysis,
  proposal: SemanticModulePlanProposal,
): ModuleMigrationProposal {
  if (proposal.objective.trim() === '') throw new Error('Semantic module proposal has no objective.');
  const filesByPath = new Map(analysis.files.map((file) => [file.path, file]));
  const moduleFiles = new Map<string, Set<string>>();
  const modules = proposal.modules.map((module) => {
    const sourceFiles = uniqueKnownFiles(module.sourceFiles, filesByPath, 'source');
    const testFiles = uniqueKnownFiles(module.sourceFiles, filesByPath, 'test');
    const generatedFiles = uniqueKnownFiles(module.sourceFiles, filesByPath, 'generated');
    const owned = new Set([...sourceFiles, ...testFiles, ...generatedFiles]);
    moduleFiles.set(module.id, owned);
    const symbolIds = analysis.symbols
      .filter((symbol) => owned.has(symbol.path))
      .map((symbol) => symbol.id);
    const evidenceIds = new Set(symbolIds);
    for (const edge of analysis.dependencies) {
      if (owned.has(edge.sourcePath) || (edge.targetPath !== undefined && owned.has(edge.targetPath))) {
        evidenceIds.add(edge.id);
      }
    }
    return {
      id: module.id,
      name: module.name,
      kind: module.kind,
      description: module.description,
      ...(module.purpose === undefined ? {} : { purpose: module.purpose }),
      ...(module.coreApis === undefined ? {} : { coreApis: module.coreApis }),
      ...(module.language === undefined ? {} : { language: module.language }),
      ...(module.domain === undefined ? {} : { domain: module.domain }),
      sourceFiles,
      ...(testFiles.length ? { testFiles } : {}),
      ...(generatedFiles.length ? { generatedFiles } : {}),
      symbolIds,
      dependsOn: [...module.dependsOn],
      writeSet: uniqueKnownPaths(module.writeSet, filesByPath, owned),
      resourceLocks: [...module.resourceLocks],
      evidenceIds: [...evidenceIds].sort(),
    };
  });

  const assignments = analysis.files.map((file) => {
    const owner = modules.find((module) => (
      module.sourceFiles.includes(file.path) ||
      module.testFiles?.includes(file.path) ||
      module.generatedFiles?.includes(file.path)
    ));
    if (file.role === 'source' && owner) return { path: file.path, kind: 'module' as const, moduleId: owner.id };
    if (file.role === 'test' && owner) return { path: file.path, kind: 'test' as const, moduleId: owner.id };
    if (file.role === 'generated' && owner) return { path: file.path, kind: 'generated' as const, moduleId: owner.id };
    return { path: file.path, kind: 'excluded' as const, reason: '未被 revision-scoped Agent 归属；保留在快照中。' };
  });

  const dependencies = (proposal.dependencies ?? []).map((dependency) => {
    const sourceFiles = moduleFiles.get(dependency.moduleId) ?? new Set<string>();
    const targetFiles = moduleFiles.get(dependency.dependsOnModuleId) ?? new Set<string>();
    const evidenceEdgeIds = analysis.dependencies
      .filter((edge) => (
        sourceFiles.has(edge.sourcePath) &&
        (targetFiles.size === 0 || edge.targetPath === undefined || targetFiles.has(edge.targetPath))
      ))
      .map((edge) => edge.id);
    return {
      moduleId: dependency.moduleId,
      dependsOnModuleId: dependency.dependsOnModuleId,
      source: dependency.source,
      evidenceEdgeIds,
    };
  });

  return {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: analysis.snapshotId,
    objective: proposal.objective,
    modules,
    fileAssignments: assignments,
    ...(dependencies.length ? { dependencies } : {}),
    ...(proposal.risks === undefined ? {} : { risks: proposal.risks }),
  };
}

function uniqueKnownFiles(
  paths: readonly string[],
  filesByPath: ReadonlyMap<string, RepositoryStaticAnalysis['files'][number]>,
  role: RepositoryStaticAnalysis['files'][number]['role'],
): string[] {
  return [...new Set(paths)].filter((filePath) => filesByPath.get(filePath)?.role === role);
}

function uniqueKnownPaths(
  paths: readonly string[],
  filesByPath: ReadonlyMap<string, RepositoryStaticAnalysis['files'][number]>,
  owned: ReadonlySet<string>,
): string[] {
  return [...new Set(paths)].filter((filePath) => filesByPath.has(filePath) && owned.has(filePath));
}

function assertModulePlanRequest(request: ModulePlanRequest): void {
  if (!request.snapshotId.trim()) throw new Error('静态分析快照标识不能为空。');
  if (!request.objective.trim()) throw new Error('模块迁移目标不能为空。');
  if (request.objective.length > 16_000) throw new Error('模块迁移目标过长。');
  if (request.immutableConstraints !== undefined) {
    if (request.immutableConstraints.length > 64) {
      throw new Error('不可变约束不能超过 64 条。');
    }
    for (const constraint of request.immutableConstraints) {
      if (!constraint.trim() || constraint.length > 2_000) {
        throw new Error('不可变约束不能为空且不能超过 2000 个字符。');
      }
    }
  }
}

function assertSemanticModulePlanRequest(request: SemanticModulePlanRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.repositoryId)) {
    throw new Error('repositoryId 无效。');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.analysisRevision)) {
    throw new Error('analysisRevision 无效。');
  }
  if (request.projectId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.projectId)) {
    throw new Error('projectId 无效。');
  }
  if (!request.objective.trim()) throw new Error('模块迁移目标不能为空。');
  if (request.objective.length > 16_000) throw new Error('模块迁移目标过长。');
  if (request.immutableConstraints !== undefined) {
    if (request.immutableConstraints.length > 64) {
      throw new Error('不可变约束不能超过 64 条。');
    }
    for (const constraint of request.immutableConstraints) {
      if (!constraint.trim() || constraint.length > 2_000) {
        throw new Error('不可变约束不能为空且不能超过 2000 个字符。');
      }
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('模块规划服务返回了无效 JSON。');
  }
}

function extractServiceError(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.error !== 'string') return undefined;
  return payload.error.length <= 1_000 ? payload.error : `${payload.error.slice(0, 1_000)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
