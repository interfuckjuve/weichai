import type {
  IndexedModuleKnowledgeDocument,
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationScope,
  RepositoryModuleIndexReceipt,
} from '@forexplore/contracts';
import {
  validateRepositoryKnowledgePublication,
  validateRepositoryModuleIndexReceipt,
} from '@forexplore/workflow-core';
import { localFetch } from './local-fetch';

const sha256Pattern = /^[0-9a-f]{64}$/;

export interface ModuleKnowledgePublicationKey {
  repositoryId: string;
  channel: string;
  publicationId: string;
  generation: number;
}

export interface ModuleKnowledgeIndexHead {
  repositoryId: string;
  channel: string;
  publicationId: string | null;
  publicationPayloadHash: string | null;
  generation: number | null;
  revision: number;
}

export interface ModuleKnowledgeIndexPublisher {
  stage(input: {
    publication: RepositoryKnowledgePublication;
    repositoryScopes: string[];
    documents: IndexedModuleKnowledgeDocument[];
  }): Promise<RepositoryModuleIndexReceipt>;
  validate(key: ModuleKnowledgePublicationKey): Promise<RepositoryModuleIndexReceipt>;
  readHead(scope: RepositoryKnowledgePublicationScope): Promise<ModuleKnowledgeIndexHead | null>;
  activate(
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number | null,
  ): Promise<ModuleKnowledgeIndexHead>;
  withdraw(
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number,
  ): Promise<ModuleKnowledgeIndexHead>;
}

export class HttpModuleKnowledgeIndexPublisher implements ModuleKnowledgeIndexPublisher {
  private readonly writerToken: string;

  constructor(
    private readonly retrievalApiUrl: string,
    writerToken: string,
    private readonly fetcher: typeof localFetch = localFetch,
  ) {
    this.writerToken = writerToken.trim();
    if (!this.writerToken) throw new Error('模块知识索引写入令牌未配置。');
  }

  async stage(input: {
    publication: RepositoryKnowledgePublication;
    repositoryScopes: string[];
    documents: IndexedModuleKnowledgeDocument[];
  }): Promise<RepositoryModuleIndexReceipt> {
    validateRepositoryKnowledgePublication(input.publication);
    const repositoryScopes = canonicalScopes(input.repositoryScopes, 'stage repositoryScopes');
    if (!sameStrings(repositoryScopes, input.publication.repositoryScopes)) {
      throw new Error('模块知识索引 stage ACL 与不可变发布 ACL 不匹配。');
    }
    for (const document of input.documents) {
      const documentScopes = canonicalScopes(document.repositoryScopes, `document ${document.id} ACL`);
      if (
        !sameStrings(documentScopes, repositoryScopes) ||
        !sameStrings(document.repositoryScopes, repositoryScopes)
      ) {
        throw new Error(`模块知识文档 ${document.id} 的 ACL 与不可变发布 ACL 不匹配。`);
      }
    }
    const payload = await this.post('generations/stage', { ...input, repositoryScopes });
    const receipt = requireObjectField(payload, 'receipt') as unknown as RepositoryModuleIndexReceipt;
    validateRepositoryModuleIndexReceipt(receipt);
    assertReceiptMatchesPublication(receipt, input.publication);
    if (receipt.status !== 'validated') {
      throw new Error('模块知识索引 stage 未返回已校验回执。');
    }
    return receipt;
  }

  async validate(key: ModuleKnowledgePublicationKey): Promise<RepositoryModuleIndexReceipt> {
    assertPublicationKey(key);
    const payload = await this.post('generations/validate', key);
    const receipt = requireObjectField(payload, 'receipt') as unknown as RepositoryModuleIndexReceipt;
    validateRepositoryModuleIndexReceipt(receipt);
    assertReceiptMatchesKey(receipt, key);
    if (receipt.status !== 'validated') {
      throw new Error('模块知识索引 validate 未返回已校验回执。');
    }
    return receipt;
  }

  async readHead(
    scope: RepositoryKnowledgePublicationScope,
  ): Promise<ModuleKnowledgeIndexHead | null> {
    assertPublicationScope(scope);
    const payload = await this.post('generations/head', scope);
    if (payload.head === null) return null;
    const head = parseHead(payload.head);
    assertHeadScope(head, scope);
    return head;
  }

  async activate(
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number | null,
  ): Promise<ModuleKnowledgeIndexHead> {
    assertPublicationKey(key);
    if (expectedActiveGeneration !== null &&
      (!Number.isSafeInteger(expectedActiveGeneration) || expectedActiveGeneration < 1)) {
      throw new Error('模块知识索引 expectedActiveGeneration 无效。');
    }
    if (expectedActiveGeneration !== null && key.generation <= expectedActiveGeneration) {
      throw new Error('模块知识索引激活必须推进当前 generation。');
    }
    const payload = await this.post('generations/activate', { ...key, expectedActiveGeneration });
    const head = parseHead(requireObjectField(payload, 'head'));
    assertHeadScope(head, key);
    if (head.publicationId !== key.publicationId || head.generation !== key.generation) {
      throw new Error('模块知识索引 activate 响应未指向目标发布代。');
    }
    return head;
  }

  async withdraw(
    key: ModuleKnowledgePublicationKey,
    expectedActiveGeneration: number,
  ): Promise<ModuleKnowledgeIndexHead> {
    assertPublicationKey(key);
    if (!Number.isSafeInteger(expectedActiveGeneration) || expectedActiveGeneration < 1) {
      throw new Error('模块知识索引 expectedActiveGeneration 无效。');
    }
    const payload = await this.post('generations/withdraw', { ...key, expectedActiveGeneration });
    const head = parseHead(requireObjectField(payload, 'head'));
    assertHeadScope(head, key);
    return head;
  }

  private async post(operation: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetcher(moduleKnowledgeIndexEndpoint(this.retrievalApiUrl, operation), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.writerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `HTTP ${response.status}`;
      throw new Error(`模块知识索引服务拒绝 ${operation}：${detail}`);
    }
    if (!isRecord(payload)) throw new Error(`模块知识索引 ${operation} 响应不是 JSON 对象。`);
    return payload;
  }
}

export function moduleKnowledgeIndexEndpoint(baseUrl: string, operation: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('模块知识索引服务地址无效。');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('模块知识索引服务必须使用 HTTP 或 HTTPS 地址。');
  }
  const loopback = base.hostname === '127.0.0.1' || base.hostname === '[::1]' ||
    base.hostname.toLowerCase() === 'localhost';
  if (base.protocol === 'http:' && !loopback) {
    throw new Error('非本机模块知识索引服务必须使用 HTTPS。');
  }
  if (base.username || base.password) {
    throw new Error('模块知识索引服务地址不能内嵌凭据。');
  }
  if (!/^[a-z-]+\/[a-z-]+$/.test(operation)) throw new Error('模块知识索引操作无效。');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}/v1/module-knowledge/${operation}`.replace(/\/{2,}/g, '/');
  base.search = '';
  base.hash = '';
  return base.toString();
}

function parseHead(value: unknown): ModuleKnowledgeIndexHead {
  if (!isRecord(value)) throw new Error('模块知识索引 head 不是对象。');
  const hasActivePublication = value.publicationId !== null;
  if (
    typeof value.repositoryId !== 'string' || !value.repositoryId.trim() ||
    typeof value.channel !== 'string' || !value.channel.trim() ||
    (value.publicationId !== null &&
      (typeof value.publicationId !== 'string' || !value.publicationId.trim())) ||
    (value.publicationPayloadHash !== null &&
      (typeof value.publicationPayloadHash !== 'string' ||
        !sha256Pattern.test(value.publicationPayloadHash))) ||
    (value.generation !== null &&
      (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1)) ||
    hasActivePublication !== (value.publicationPayloadHash !== null) ||
    hasActivePublication !== (value.generation !== null) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0
  ) {
    throw new Error('模块知识索引 head 无效。');
  }
  return value as unknown as ModuleKnowledgeIndexHead;
}

function assertReceiptMatchesPublication(
  receipt: RepositoryModuleIndexReceipt,
  publication: RepositoryKnowledgePublication,
): void {
  assertReceiptMatchesKey(receipt, {
    repositoryId: publication.scope.repositoryId,
    channel: publication.scope.channel,
    publicationId: publication.id,
    generation: publication.generation,
  });
  if (receipt.publicationPayloadHash !== publication.payloadHash) {
    throw new Error('模块知识索引回执与发布载荷哈希不匹配。');
  }
  const expectedModuleIds = publication.source.modules.map(({ moduleId }) => moduleId).sort();
  if (
    receipt.documentCount !== expectedModuleIds.length ||
    receipt.moduleIds.length !== expectedModuleIds.length ||
    receipt.moduleIds.some((moduleId, index) => moduleId !== expectedModuleIds[index])
  ) {
    throw new Error('模块知识索引回执未覆盖发布中的全部模块。');
  }
}

function assertPublicationKey(key: ModuleKnowledgePublicationKey): void {
  assertPublicationScope(key);
  if (
    typeof key.publicationId !== 'string' || !key.publicationId.trim() ||
    !Number.isSafeInteger(key.generation) || key.generation < 1
  ) {
    throw new Error('模块知识索引发布代键无效。');
  }
}

function assertPublicationScope(scope: RepositoryKnowledgePublicationScope): void {
  if (
    typeof scope.repositoryId !== 'string' || !scope.repositoryId.trim() ||
    typeof scope.channel !== 'string' ||
    !scope.channel.trim() ||
    scope.channel !== scope.channel.trim() ||
    scope.channel.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(scope.channel)
  ) {
    throw new Error('模块知识索引发布范围无效。');
  }
}

function assertReceiptMatchesKey(
  receipt: RepositoryModuleIndexReceipt,
  key: ModuleKnowledgePublicationKey,
): void {
  if (
    receipt.publicationId !== key.publicationId ||
    receipt.scope.repositoryId !== key.repositoryId ||
    receipt.scope.channel !== key.channel ||
    receipt.generation !== key.generation
  ) {
    throw new Error('模块知识索引回执与请求的发布代不匹配。');
  }
}

function assertHeadScope(
  head: ModuleKnowledgeIndexHead,
  key: Pick<ModuleKnowledgePublicationKey, 'repositoryId' | 'channel'>,
): void {
  if (head.repositoryId !== key.repositoryId || head.channel !== key.channel) {
    throw new Error('模块知识索引 head 与请求的仓库或通道不匹配。');
  }
}

function canonicalScopes(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`模块知识索引 ${label} 不能为空。`);
  }
  const scopes = values.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`模块知识索引 ${label} 包含无效仓库范围。`);
    }
    return value.trim();
  });
  return [...new Set(scopes)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireObjectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!isRecord(field)) throw new Error(`模块知识索引响应缺少 ${key}。`);
  return field;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('模块知识索引服务返回了无效 JSON。');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
