import type {
  RepositoryModuleBundle,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleKnowledgeReview,
  RepositoryModuleWikiProposal,
} from '@forexplore/contracts';
import {
  validateRepositoryModuleEvidenceBundle,
  validateRepositoryModuleSummaryRevisionContext,
  validateRepositoryModuleWikiProposal,
} from '@forexplore/workflow-core';
import { localFetch } from './local-fetch';

export const moduleSummaryClientVersion = '1.1.0';

export interface RepositoryModuleSummaryRequest {
  repositoryModuleBundle: RepositoryModuleBundle;
  evidenceBundle: RepositoryModuleEvidenceBundle;
  previousProposal?: RepositoryModuleWikiProposal;
  reviseReview?: RepositoryModuleKnowledgeReview;
}

export function moduleSummaryEndpoint(adaptationApiUrl: string): string {
  let base: URL;
  try {
    base = new URL(adaptationApiUrl);
  } catch {
    throw new Error('模块摘要服务地址无效。');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('模块摘要服务必须使用 HTTP 或 HTTPS 地址。');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}/v1/module-summary`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

/**
 * Sends only the immutable host-validated evidence bundle and its provenance
 * closure. The returned Agent proposal remains generated/unreviewed and is
 * validated again before the host persists it.
 */
export async function requestRepositoryModuleSummary(
  adaptationApiUrl: string,
  request: RepositoryModuleSummaryRequest,
  fetcher: typeof localFetch = localFetch,
  signal?: AbortSignal,
): Promise<RepositoryModuleWikiProposal> {
  validateRepositoryModuleEvidenceBundle(
    request.evidenceBundle,
    request.repositoryModuleBundle,
  );
  const hasPrevious = request.previousProposal !== undefined;
  const hasReview = request.reviseReview !== undefined;
  if (hasPrevious !== hasReview) {
    throw new Error('模块摘要修订请求必须同时包含上一版提案和 revise 审核。');
  }
  const revisionContext = hasPrevious && hasReview
    ? { previousProposal: request.previousProposal!, reviseReview: request.reviseReview! }
    : undefined;
  if (revisionContext !== undefined) {
    validateRepositoryModuleSummaryRevisionContext(request.evidenceBundle, revisionContext);
  }
  const response = await fetcher(moduleSummaryEndpoint(adaptationApiUrl), {
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
    throw new Error(`模块摘要服务拒绝请求：${detail}`);
  }
  if (!isRecord(payload)) throw new Error('模块摘要服务返回的提案不是 JSON 对象。');
  const proposal = payload as unknown as RepositoryModuleWikiProposal;
  validateRepositoryModuleWikiProposal(proposal, request.evidenceBundle, revisionContext);
  return proposal;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('模块摘要服务返回了无效 JSON。');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
