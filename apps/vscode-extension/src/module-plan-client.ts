import type {
  ModuleMigrationPlan,
  ModuleMigrationProposal,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { buildModuleMigrationPlan } from '@forexplore/workflow-core';
import { localFetch } from './local-fetch';

/** The only payload the extension sends to the read-only architecture API. */
export interface ModulePlanRequest {
  snapshotId: string;
  objective: string;
  immutableConstraints?: string[];
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
