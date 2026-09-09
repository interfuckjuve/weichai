import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { SemanticQueryPort } from '@forexplore/workflow-core';

const maxBodyBytes = 256 * 1024;
const operations = new Set<keyof SemanticQueryPort>([
  'listRepositories',
  'getRepositoryOverview',
  'listProjects',
  'getFileStructure',
  'searchSymbols',
  'getSymbol',
  'findDefinition',
  'findReferences',
  'getDependencies',
  'getDiagnostics',
  'readSourceExcerpt',
]);

export interface SemanticQueryHttpServerOptions {
  /** Host-owned read-only query port; this transport owns neither index nor LSP. */
  queryPort: SemanticQueryPort;
  /** Required for non-loopback listening; kept outside Agent-visible payloads. */
  bearerToken?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxBodyBytes) throw new HttpError(413, 'Request is too large.');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw new HttpError(413, 'Request is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

function requestToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

function authorized(request: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const actual = requestToken(request);
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function operationFor(url: string | undefined): keyof SemanticQueryPort | undefined {
  if (!url) return undefined;
  const pathname = new URL(url, 'http://semantic-query.local').pathname;
  const prefix = '/v1/semantic-query/';
  if (!pathname.startsWith(prefix)) return undefined;
  const candidate = pathname.slice(prefix.length) as keyof SemanticQueryPort;
  return operations.has(candidate) ? candidate : undefined;
}

/**
 * Minimal localhost-friendly transport used when the standalone MCP process
 * must proxy a host-owned SemanticQueryPort. It deliberately exposes only
 * the eleven read-only operations, with no repository registration/indexing
 * route and no filesystem or database credentials.
 */
export function createSemanticQueryHttpServer(options: SemanticQueryHttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'Only POST is supported.');
      if (!authorized(request, options.bearerToken)) throw new HttpError(401, 'Unauthorized.');
      const operation = operationFor(request.url);
      if (!operation) throw new HttpError(404, 'Unknown semantic query operation.');
      const body = await readJson(request);
      const handler = options.queryPort[operation] as (
        request: unknown,
        signal?: AbortSignal,
      ) => Promise<unknown>;
      const result = await handler.call(options.queryPort, body, AbortSignal.timeout(60_000));
      send(response, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        send(response, error.status, { error: { message: error.message } });
      } else {
        // Do not leak host paths, DB connection strings, or provider details
        // across the MCP transport boundary.
        send(response, 400, { error: { message: 'Semantic index query failed.' } });
      }
    }
  });
}
