import type {
  ModuleDiscoveryConstraint,
  ModuleDiscoveryProposal,
} from '@forexplore/contracts';
import { localFetch } from './local-fetch';

export const moduleDiscoveryClientVersion = '1.0.0';

/** The extension never uploads repository contents or the unified IR. */
export interface ModuleDiscoveryRequest {
  snapshotId: string;
  constraints?: Array<Pick<ModuleDiscoveryConstraint, 'id' | 'description' | 'required'>>;
}

export function moduleDiscoveryEndpoint(adaptationApiUrl: string): string {
  let base: URL;
  try {
    base = new URL(adaptationApiUrl);
  } catch {
    throw new Error('模块发现服务地址无效。');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('模块发现服务必须使用 HTTP 或 HTTPS 地址。');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}/v1/module-discovery`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

/**
 * Requests an evidence-bound proposal for one already persisted snapshot.
 * The response remains untrusted until workflow-core validates it against the
 * host-owned unified repository IR.
 */
export async function requestRepositoryModuleDiscovery(
  adaptationApiUrl: string,
  request: ModuleDiscoveryRequest,
  fetcher: typeof localFetch = localFetch,
  signal?: AbortSignal,
): Promise<ModuleDiscoveryProposal> {
  assertRequest(request);
  const response = await fetcher(moduleDiscoveryEndpoint(adaptationApiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error.slice(0, 1_000)
      : `HTTP ${response.status}`;
    throw new Error(`模块发现服务拒绝请求：${detail}`);
  }
  if (!isRecord(payload)) {
    throw new Error('模块发现服务返回的提案不是 JSON 对象。');
  }
  return payload as unknown as ModuleDiscoveryProposal;
}

function assertRequest(request: ModuleDiscoveryRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(request.snapshotId)) {
    throw new Error('静态分析快照标识无效。');
  }
  if (request.constraints === undefined) return;
  if (request.constraints.length > 64) throw new Error('模块发现约束不能超过 64 条。');
  const ids = new Set<string>();
  for (const constraint of request.constraints) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(constraint.id) ||
      ids.has(constraint.id) ||
      !constraint.description.trim() ||
      constraint.description.length > 2_000 ||
      typeof constraint.required !== 'boolean'
    ) {
      throw new Error('模块发现约束无效。');
    }
    ids.add(constraint.id);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('模块发现服务返回了无效 JSON。');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
