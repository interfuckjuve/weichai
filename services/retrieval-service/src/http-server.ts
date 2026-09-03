import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type {
  IndexedModuleKnowledgeDocument,
  Language,
  LanguageId,
  MigrationRuntimeCapabilitySnapshot,
  SearchCandidateV2,
  SearchRequestV2,
  SearchRequest,
} from '@forexplore/contracts';
import {
  validateSearchCandidateV2,
  validateSourceImplementationBundleV2,
} from '@forexplore/workflow-core';
import { ModuleKnowledgeCasError } from './seekdb-module-knowledge-store.js';
import { RepositoryScopeError, requireRepositoryScopes } from './repository-scope.js';
import type { SearchEngine, SearchStore } from './types.js';
import type {
  ImplementationIndexActivationRequestV2,
  ImplementationIndexGenerationKeyV2,
  ImplementationIndexGenerationV2,
  ImplementationIndexServiceV2,
  ImplementationIndexStoreV2,
  SearchEngineV2,
} from './implementation-index-v2-types.js';
import { validateImplementationIndexGenerationV2 } from './implementation-index-v2.js';
import {
  ImplementationIndexV2ConflictError,
  ImplementationIndexV2NotFoundError,
} from './seekdb-implementation-index-v2-store.js';
import type {
  ModuleKnowledgeActivationRequest,
  ModuleKnowledgeIndexService,
  ModuleKnowledgePublicationKey,
  ModuleKnowledgeQuery,
  ModuleKnowledgeSearchEngine,
  ModuleKnowledgeSearchStore,
  ModuleKnowledgeStageRequest,
  ModuleKnowledgeWithdrawRequest,
} from './module-knowledge-types.js';

export interface HttpServerOptions {
  engine: SearchEngine;
  store: SearchStore;
  corsOrigin: string;
  /** Deployment-owned allow-list. Never derive this from a client request. */
  allowedRepositories: readonly string[];
  moduleEngine?: ModuleKnowledgeSearchEngine;
  moduleIndex?: ModuleKnowledgeIndexService;
  moduleStore?: ModuleKnowledgeSearchStore;
  /** Empty/omitted deliberately disables every module-index mutation. */
  moduleIndexToken?: string;
  moduleIndexMaxBodyBytes?: number;
  implementationEngineV2?: SearchEngineV2;
  implementationIndexV2?: ImplementationIndexServiceV2;
  implementationStoreV2?: ImplementationIndexStoreV2;
  /** Empty/omitted deliberately disables V2 generation mutations. */
  implementationIndexToken?: string;
  implementationIndexMaxBodyBytes?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const languages = new Set<Language>([
  'TypeScript',
  'Python',
  'Java',
  'C#',
  'Rust',
  'Go',
]);

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  corsOrigin: string,
): void {
  response.writeHead(status, {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number = 1024 * 1024,
): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function isSearchRequest(value: unknown): value is SearchRequest {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<SearchRequest>;
  const target = body.target as Partial<SearchRequest['target']> | undefined;
  return (
    typeof body.requirement === 'string' &&
    Number.isInteger(body.topK) &&
    Number(body.topK) >= 1 &&
    Number(body.topK) <= 50 &&
    (body.repositoryScopes === undefined ||
      (Array.isArray(body.repositoryScopes) &&
        body.repositoryScopes.every((scope) => typeof scope === 'string'))) &&
    (body.rerank === undefined || typeof body.rerank === 'boolean') &&
    (body.candidateLanguages === undefined ||
      (Array.isArray(body.candidateLanguages) &&
        body.candidateLanguages.length > 0 &&
        body.candidateLanguages.every(
          (language) =>
            typeof language === 'string' && languages.has(language as Language),
        ))) &&
    typeof target === 'object' &&
    target !== null &&
    typeof target.id === 'string' &&
    typeof target.name === 'string' &&
    typeof target.path === 'string' &&
    typeof target.signature === 'string' &&
    (target.documentation === undefined || typeof target.documentation === 'string') &&
    ['class', 'function'].includes(String(target.kind)) &&
    typeof target.language === 'string' &&
    languages.has(target.language as Language)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSearchRequestV2(value: unknown): value is SearchRequestV2 {
  if (!isRecord(value) || value.schemaVersion !== '2.0') return false;
  return (
    typeof value.id === 'string' &&
    typeof value.contentHash === 'string' &&
    isRecord(value.target) &&
    isRecord(value.route) &&
    typeof value.requirement === 'string' &&
    Number.isInteger(value.topK) &&
    Array.isArray(value.repositoryScopes) &&
    Array.isArray(value.candidateLanguageIds) &&
    typeof value.rerank === 'boolean' &&
    typeof value.createdAt === 'string'
  );
}

function isRuntimeCapabilitySnapshot(
  value: unknown,
): value is MigrationRuntimeCapabilitySnapshot {
  return isRecord(value) && value.schemaVersion === '2.0' &&
    typeof value.id === 'string' && Array.isArray(value.routes) &&
    typeof value.createdAt === 'string' && typeof value.contentHash === 'string';
}

function isSourceBundleCandidateRef(value: unknown): value is SearchCandidateV2 {
  if (!isRecord(value) || !isRecord(value.sourceBundle) || !isRecord(value.indexGeneration)) {
    return false;
  }
  return value.schemaVersion === '2.0' &&
    typeof value.requestId === 'string' && typeof value.requestHash === 'string' &&
    typeof value.indexedDocumentId === 'string' && typeof value.indexedDocumentHash === 'string' &&
    typeof value.sourceBundle.id === 'string' && typeof value.sourceBundle.contentHash === 'string' &&
    typeof value.indexGeneration.repositoryId === 'string' &&
    typeof value.indexGeneration.id === 'string' &&
    Number.isSafeInteger(value.indexGeneration.generation) &&
    typeof value.indexGeneration.contentHash === 'string';
}

function isImplementationIndexGenerationV2(
  value: unknown,
): value is ImplementationIndexGenerationV2 {
  return isRecord(value) && value.schemaVersion === '2.0' &&
    typeof value.id === 'string' && typeof value.contentHash === 'string' &&
    typeof value.repositoryId === 'string' && Number.isSafeInteger(value.generation) &&
    isRecord(value.sourceCatalog) && Array.isArray(value.repositoryScopes) &&
    Array.isArray(value.documents) && Array.isArray(value.sourceBundles) &&
    typeof value.createdAt === 'string';
}

function isImplementationGenerationKeyV2(
  value: unknown,
): value is ImplementationIndexGenerationKeyV2 {
  return isRecord(value) && typeof value.repositoryId === 'string' &&
    typeof value.generationId === 'string' && Number.isSafeInteger(value.generation) &&
    typeof value.generationContentHash === 'string';
}

function isImplementationActivationV2(
  value: unknown,
): value is ImplementationIndexActivationRequestV2 {
  if (!isImplementationGenerationKeyV2(value)) return false;
  const activation = value as Partial<ImplementationIndexActivationRequestV2>;
  return activation.expectedActiveGenerationId === null ||
    typeof activation.expectedActiveGenerationId === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isIndexedModuleDocument(value: unknown): value is IndexedModuleKnowledgeDocument {
  if (!isRecord(value)) return false;
  return (
    typeof value.schemaVersion === 'string' &&
    typeof value.id === 'string' &&
    value.documentKind === 'functional-module' &&
    typeof value.artifactId === 'string' &&
    typeof value.artifactHash === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.moduleId === 'string' &&
    typeof value.moduleCatalogId === 'string' &&
    typeof value.publicationId === 'string' &&
    typeof value.publicationPayloadHash === 'string' &&
    Number.isSafeInteger(value.publicationGeneration) &&
    Number(value.publicationGeneration) >= 1 &&
    typeof value.channel === 'string' &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    isStringArray(value.languageIds) &&
    isStringArray(value.capabilities) &&
    isStringArray(value.domainTerms) &&
    isStringArray(value.publicApiSignatures) &&
    isStringArray(value.dependencyModuleIds) &&
    isStringArray(value.tags) &&
    isStringArray(value.risks) &&
    ['proposed', 'reviewed'].includes(String(value.boundaryStatus)) &&
    ['generated', 'reviewed'].includes(String(value.narrativeStatus)) &&
    ['unverified', 'partial', 'verified'].includes(String(value.verificationStatus)) &&
    ['discovered', 'reviewed', 'verified'].includes(String(value.trustTier)) &&
    isStringArray(value.repositoryScopes) &&
    typeof value.searchableContent === 'string'
  );
}

function isModulePublicationKey(value: unknown): value is ModuleKnowledgePublicationKey {
  if (!isRecord(value)) return false;
  return (
    typeof value.repositoryId === 'string' &&
    typeof value.channel === 'string' &&
    typeof value.publicationId === 'string' &&
    Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
  );
}

function isModulePublicationScope(
  value: unknown,
): value is Pick<ModuleKnowledgePublicationKey, 'repositoryId' | 'channel'> {
  return isRecord(value) &&
    typeof value.repositoryId === 'string' && value.repositoryId.trim().length > 0 &&
    typeof value.channel === 'string' &&
    value.channel.trim().length > 0 &&
    value.channel === value.channel.trim() &&
    value.channel.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value.channel);
}

function isModuleStageRequest(value: unknown): value is ModuleKnowledgeStageRequest {
  if (!isRecord(value)) return false;
  const body = value as unknown as Partial<ModuleKnowledgeStageRequest>;
  const publication = body.publication;
  return isRecord(publication) &&
    typeof publication.id === 'string' &&
    publication.status === 'staged' &&
    typeof publication.payloadHash === 'string' &&
    Number.isSafeInteger(publication.generation) && Number(publication.generation) >= 1 &&
    isRecord(publication.scope) &&
    typeof publication.scope.repositoryId === 'string' &&
    typeof publication.scope.channel === 'string' &&
    isStringArray(publication.repositoryScopes) &&
    Array.isArray(publication.source?.modules) &&
    isStringArray(body.repositoryScopes) &&
    Array.isArray(body.documents) &&
    body.documents.every(isIndexedModuleDocument);
}

function isModuleActivationRequest(value: unknown): value is ModuleKnowledgeActivationRequest {
  if (!isModulePublicationKey(value)) return false;
  const body = value as unknown as Partial<ModuleKnowledgeActivationRequest>;
  return body.expectedActiveGeneration === null ||
    (Number.isSafeInteger(body.expectedActiveGeneration) && Number(body.expectedActiveGeneration) >= 1);
}

function isModuleWithdrawRequest(value: unknown): value is ModuleKnowledgeWithdrawRequest {
  if (!isModulePublicationKey(value)) return false;
  const body = value as unknown as Partial<ModuleKnowledgeWithdrawRequest>;
  return Number.isSafeInteger(body.expectedActiveGeneration) && Number(body.expectedActiveGeneration) >= 1;
}

function isModuleQuery(value: unknown): value is ModuleKnowledgeQuery {
  if (!isRecord(value)) return false;
  return (
    typeof value.query === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.channel === 'string' &&
    Number.isInteger(value.topK) &&
    Number(value.topK) >= 1 &&
    Number(value.topK) <= 50 &&
    isStringArray(value.repositoryScopes) &&
    (value.languageIds === undefined || isStringArray(value.languageIds)) &&
    (value.capabilities === undefined || isStringArray(value.capabilities))
  );
}

function authorizedRequest(
  request: SearchRequest,
  configuredRepositories: readonly string[],
): SearchRequest {
  let allowedRepositories: string[];
  try {
    allowedRepositories = requireRepositoryScopes(
      configuredRepositories,
      'Retrieval service allowed repositories',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No repositories are authorized.';
    throw new HttpError(503, message);
  }

  if (request.repositoryScopes === undefined) {
    return { ...request, repositoryScopes: allowedRepositories };
  }

  let requestedRepositories: string[];
  try {
    requestedRepositories = requireRepositoryScopes(
      request.repositoryScopes,
      'Search request repository scopes',
    );
  } catch (error) {
    const message = error instanceof RepositoryScopeError
      ? error.message
      : 'Invalid repository scope.';
    throw new HttpError(400, message);
  }

  const allowed = new Set(allowedRepositories);
  const unauthorized = requestedRepositories.find((repository) => !allowed.has(repository));
  if (unauthorized) {
    throw new HttpError(403, `Repository is not authorized for this retrieval service: ${unauthorized}.`);
  }

  return { ...request, repositoryScopes: requestedRepositories };
}

function authorizedRequestV2(
  request: SearchRequestV2,
  combinedRuntimeCapabilities: MigrationRuntimeCapabilitySnapshot,
  engine: SearchEngineV2,
  configuredRepositories: readonly string[],
): SearchRequestV2 {
  try {
    engine.validateRequest(request, combinedRuntimeCapabilities);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid SearchRequestV2 payload.');
  }
  const allowed = deploymentRepositories(configuredRepositories);
  let requested: string[];
  try {
    requested = requireRepositoryScopes(request.repositoryScopes, 'SearchRequestV2 repository scopes');
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid V2 repository scopes.');
  }
  const unauthorized = requested.find((repository) => !allowed.includes(repository));
  if (unauthorized) {
    throw new HttpError(403, `Repository is not authorized for this retrieval service: ${unauthorized}.`);
  }
  // SearchRequestV2 is content addressed. Authorization may reject it but may
  // never inject or strip scopes and thereby create a different request.
  return request;
}

function deploymentRepositories(configuredRepositories: readonly string[]): string[] {
  try {
    return requireRepositoryScopes(
      configuredRepositories,
      'Retrieval service allowed repositories',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No repositories are authorized.';
    throw new HttpError(503, message);
  }
}

function authorizeRepository(
  repositoryId: string,
  configuredRepositories: readonly string[],
): void {
  const allowed = deploymentRepositories(configuredRepositories);
  if (!allowed.includes(repositoryId)) {
    throw new HttpError(403, `Repository is not authorized for this retrieval service: ${repositoryId}.`);
  }
}

function authorizedModuleQuery(
  request: ModuleKnowledgeQuery,
  configuredRepositories: readonly string[],
): ModuleKnowledgeQuery {
  const allowed = deploymentRepositories(configuredRepositories);
  if (!allowed.includes(request.repositoryId)) {
    throw new HttpError(403, `Repository is not authorized for this retrieval service: ${request.repositoryId}.`);
  }
  const scopes = authorizedModuleScopes(
    request.repositoryScopes,
    request.repositoryId,
    allowed,
    'Module search repository scopes',
  );
  return { ...request, repositoryScopes: scopes };
}

function authorizedModuleScopes(
  requestedScopes: readonly string[],
  repositoryId: string,
  allowedRepositories: readonly string[],
  label: string,
): string[] {
  let scopes: string[];
  try {
    scopes = requireRepositoryScopes(requestedScopes, label);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid repository scope.');
  }
  const unauthorized = scopes.find((scope) => !allowedRepositories.includes(scope));
  if (unauthorized) {
    throw new HttpError(403, `Repository is not authorized for this retrieval service: ${unauthorized}.`);
  }
  if (!scopes.includes(repositoryId)) {
    throw new HttpError(400, `${label} must include repositoryId.`);
  }
  return scopes;
}

function requireModuleWriter(request: IncomingMessage, configuredToken: string | undefined): void {
  if (!configuredToken) {
    throw new HttpError(503, 'Module-index control endpoints are disabled for this deployment.');
  }
  const expected = Buffer.from(`Bearer ${configuredToken}`, 'utf8');
  const supplied = Buffer.from(request.headers.authorization ?? '', 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new HttpError(401, 'Module-index writer authorization failed.');
  }
}

function requireImplementationWriter(
  request: IncomingMessage,
  configuredToken: string | undefined,
): void {
  if (!configuredToken) {
    throw new HttpError(503, 'V2 implementation-index control endpoints are disabled for this deployment.');
  }
  const expected = Buffer.from(`Bearer ${configuredToken}`, 'utf8');
  const supplied = Buffer.from(request.headers.authorization ?? '', 'utf8');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new HttpError(401, 'V2 implementation-index writer authorization failed.');
  }
}

function requireModuleServices(options: HttpServerOptions): {
  moduleIndex: ModuleKnowledgeIndexService;
} {
  if (!options.moduleIndex) {
    throw new HttpError(503, 'Module knowledge indexing is unavailable.');
  }
  return { moduleIndex: options.moduleIndex };
}

function requireModuleStore(options: HttpServerOptions): ModuleKnowledgeSearchStore {
  if (!options.moduleStore) {
    throw new HttpError(503, 'Module knowledge storage is unavailable.');
  }
  return options.moduleStore;
}

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      json(response, 204, null, options.corsOrigin);
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/health') {
        await Promise.all([
          options.store.ping(),
          options.moduleStore?.ping(),
          options.implementationStoreV2?.ping(),
        ]);
        json(response, 200, { status: 'ok', storage: 'seekdb' }, options.corsOrigin);
        return;
      }

      if (request.method === 'GET' && request.url === '/v2/capabilities') {
        if (!options.implementationEngineV2) {
          throw new HttpError(503, 'V2 implementation search is unavailable.');
        }
        json(response, 200, {
          runtimeCapabilities: options.implementationEngineV2.runtimeCapabilities,
        }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/search') {
        if (!options.implementationEngineV2) {
          throw new HttpError(503, 'V2 implementation search is unavailable.');
        }
        const body = await readBody(request);
        if (!isRecord(body) || !isSearchRequestV2(body.request) ||
            !isRuntimeCapabilitySnapshot(body.runtimeCapabilities)) {
          throw new HttpError(400, 'Invalid SearchRequestV2 payload.');
        }
        const result = await options.implementationEngineV2.search(
          authorizedRequestV2(
            body.request,
            body.runtimeCapabilities,
            options.implementationEngineV2,
            options.allowedRepositories,
          ),
          body.runtimeCapabilities,
        );
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/source-bundles/resolve') {
        if (!options.implementationEngineV2 || !options.implementationStoreV2) {
          throw new HttpError(503, 'V2 source bundle resolution is unavailable.');
        }
        const body = await readBody(request);
        if (!isRecord(body) || !isRecord(body.resolution) ||
            !isSearchRequestV2(body.resolution.request) ||
            !isSourceBundleCandidateRef(body.resolution.candidate) ||
            !isRuntimeCapabilitySnapshot(body.runtimeCapabilities)) {
          throw new HttpError(400, 'Invalid V2 source bundle resolution request.');
        }
        const searchRequest = authorizedRequestV2(
          body.resolution.request,
          body.runtimeCapabilities,
          options.implementationEngineV2,
          options.allowedRepositories,
        );
        const selectedCandidate = body.resolution.candidate;
        if (
          selectedCandidate.requestId !== searchRequest.id ||
          selectedCandidate.requestHash !== searchRequest.contentHash ||
          selectedCandidate.targetId !== searchRequest.target.id ||
          selectedCandidate.targetHash !== searchRequest.target.contentHash
        ) {
          throw new HttpError(409, 'Selected V2 candidate does not bind to the exact search request and target.');
        }
        if (!searchRequest.repositoryScopes.includes(selectedCandidate.indexGeneration.repositoryId)) {
          throw new HttpError(403, 'Selected V2 candidate repository is outside the authorized search scopes.');
        }
        authorizeRepository(selectedCandidate.indexGeneration.repositoryId, options.allowedRepositories);
        const resolutionRequest = {
          request: searchRequest,
          candidate: selectedCandidate,
        };
        const resolved = await options.implementationStoreV2.resolveSourceBundle(resolutionRequest);
        try {
          validateSearchCandidateV2(
            resolutionRequest.candidate,
            searchRequest,
            resolved.indexedDocument,
            body.runtimeCapabilities,
          );
          validateSourceImplementationBundleV2(resolved.bundle);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'Stale V2 source bundle lineage.');
        }
        if (
          resolved.bundle.id !== resolutionRequest.candidate.sourceBundle.id ||
          resolved.bundle.contentHash !== resolutionRequest.candidate.sourceBundle.contentHash ||
          resolved.bundle.candidate.id !== resolved.indexedDocument.candidate.id ||
          resolved.bundle.candidate.contentHash !== resolved.indexedDocument.candidate.contentHash ||
          !searchRequest.repositoryScopes.includes(resolved.indexedDocument.sourceCatalog.repositoryId)
        ) {
          throw new HttpError(409, 'Resolved V2 source bundle lineage does not match the selected candidate.');
        }
        json(response, 200, resolved, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/implementation-index/generations/stage') {
        requireImplementationWriter(request, options.implementationIndexToken);
        if (!options.implementationIndexV2) {
          throw new HttpError(503, 'V2 implementation indexing is unavailable.');
        }
        const body = await readBody(
          request,
          options.implementationIndexMaxBodyBytes ?? 32 * 1024 * 1024,
        );
        if (!isImplementationIndexGenerationV2(body)) {
          throw new HttpError(400, 'Invalid ImplementationIndexGenerationV2 payload.');
        }
        try {
          validateImplementationIndexGenerationV2(body);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'Invalid V2 generation.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        await options.implementationIndexV2.stage(body);
        json(response, 201, { generationId: body.id, contentHash: body.contentHash }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/implementation-index/generations/validate') {
        requireImplementationWriter(request, options.implementationIndexToken);
        if (!options.implementationIndexV2) throw new HttpError(503, 'V2 implementation indexing is unavailable.');
        const body = await readBody(request);
        if (!isImplementationGenerationKeyV2(body)) throw new HttpError(400, 'Invalid V2 generation key.');
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const generation = await options.implementationIndexV2.validate(body);
        json(response, 200, { generation }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/implementation-index/generations/activate') {
        requireImplementationWriter(request, options.implementationIndexToken);
        if (!options.implementationIndexV2) throw new HttpError(503, 'V2 implementation indexing is unavailable.');
        const body = await readBody(request);
        if (!isImplementationActivationV2(body)) throw new HttpError(400, 'Invalid V2 activation request.');
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const head = await options.implementationIndexV2.activate(body);
        json(response, 200, { head }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v2/implementation-index/generations/head') {
        requireImplementationWriter(request, options.implementationIndexToken);
        if (!options.implementationStoreV2) throw new HttpError(503, 'V2 implementation storage is unavailable.');
        const body = await readBody(request);
        if (!isRecord(body) || typeof body.repositoryId !== 'string') {
          throw new HttpError(400, 'Invalid V2 implementation head request.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const head = await options.implementationStoreV2.activeHead(body.repositoryId);
        json(response, 200, { head }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/search') {
        const body = await readBody(request);
        if (!isSearchRequest(body)) {
          json(response, 400, { error: 'Invalid SearchRequest payload.' }, options.corsOrigin);
          return;
        }
        const candidates = await options.engine.search(
          authorizedRequest(body, options.allowedRepositories),
        );
        json(response, 200, { candidates }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/search') {
        if (!options.moduleEngine) {
          throw new HttpError(503, 'Module knowledge search is unavailable.');
        }
        const body = await readBody(request);
        if (!isModuleQuery(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgeQuery payload.');
        }
        const result = await options.moduleEngine.search(
          authorizedModuleQuery(body, options.allowedRepositories),
        );
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/stage') {
        requireModuleWriter(request, options.moduleIndexToken);
        const { moduleIndex } = requireModuleServices(options);
        const body = await readBody(
          request,
          options.moduleIndexMaxBodyBytes ?? 16 * 1024 * 1024,
        );
        if (!isModuleStageRequest(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgeStageRequest payload.');
        }
        authorizeRepository(body.publication.scope.repositoryId, options.allowedRepositories);
        const repositoryScopes = authorizedModuleScopes(
          body.repositoryScopes,
          body.publication.scope.repositoryId,
          deploymentRepositories(options.allowedRepositories),
          'Module publication repository scopes',
        );
        const receipt = await moduleIndex.stage({ ...body, repositoryScopes });
        json(response, 201, { receipt }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/validate') {
        requireModuleWriter(request, options.moduleIndexToken);
        const { moduleIndex } = requireModuleServices(options);
        const body = await readBody(request);
        if (!isModulePublicationKey(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgePublicationKey payload.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const receipt = await moduleIndex.validate(body);
        json(response, 200, { receipt }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/head') {
        requireModuleWriter(request, options.moduleIndexToken);
        const body = await readBody(request);
        if (!isModulePublicationScope(body)) {
          throw new HttpError(400, 'Invalid RepositoryKnowledgePublicationScope payload.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const head = await requireModuleStore(options).activeHead(
          body.repositoryId,
          body.channel,
        );
        json(response, 200, { head }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/activate') {
        requireModuleWriter(request, options.moduleIndexToken);
        const { moduleIndex } = requireModuleServices(options);
        const body = await readBody(request);
        if (!isModuleActivationRequest(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgeActivationRequest payload.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const head = await moduleIndex.activate(body);
        json(response, 200, { head }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/withdraw') {
        requireModuleWriter(request, options.moduleIndexToken);
        const { moduleIndex } = requireModuleServices(options);
        const body = await readBody(request);
        if (!isModuleWithdrawRequest(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgeWithdrawRequest payload.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        const head = await moduleIndex.withdraw(body);
        json(response, 200, { head }, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/module-knowledge/generations/tombstone') {
        requireModuleWriter(request, options.moduleIndexToken);
        const { moduleIndex } = requireModuleServices(options);
        const body = await readBody(request);
        if (!isModulePublicationKey(body)) {
          throw new HttpError(400, 'Invalid ModuleKnowledgePublicationKey payload.');
        }
        authorizeRepository(body.repositoryId, options.allowedRepositories);
        await moduleIndex.tombstone(body);
        json(response, 200, { status: 'tombstoned' }, options.corsOrigin);
        return;
      }

      json(response, 404, { error: 'Not found.' }, options.corsOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown retrieval error.';
      const status = error instanceof HttpError
        ? error.status
        : error instanceof ImplementationIndexV2NotFoundError
          ? 404
          : error instanceof ImplementationIndexV2ConflictError
            ? 409
        : error instanceof ModuleKnowledgeCasError
          ? 409
          : 503;
      if (!(error instanceof HttpError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}
