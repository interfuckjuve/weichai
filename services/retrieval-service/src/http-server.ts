import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Language, SearchRequest } from '@forexplore/contracts';
import { RepositoryScopeError, requireRepositoryScopes } from './repository-scope.js';
import type { SearchEngine, SearchStore } from './types.js';

export interface HttpServerOptions {
  engine: SearchEngine;
  store: SearchStore;
  corsOrigin: string;
  /** Deployment-owned allow-list. Never derive this from a client request. */
  allowedRepositories: readonly string[];
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
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
    throw new HttpError(413, 'Request body exceeds 1 MiB.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body exceeds 1 MiB.');
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

export function createHttpServer(options: HttpServerOptions): Server {
  return createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      json(response, 204, null, options.corsOrigin);
      return;
    }

    try {
      if (request.method === 'GET' && request.url === '/health') {
        await options.store.ping();
        json(response, 200, { status: 'ok', storage: 'seekdb' }, options.corsOrigin);
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

      json(response, 404, { error: 'Not found.' }, options.corsOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown retrieval error.';
      const status = error instanceof HttpError ? error.status : 503;
      if (!(error instanceof HttpError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}
