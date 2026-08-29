import type { AddressInfo } from 'node:net';
import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http-server.js';
import type { SearchEngine, SearchStore } from './types.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

function store(): SearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    semanticSearch: vi.fn(async () => []),
    textSearch: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
}

async function listen(
  engine: SearchEngine,
  searchStore: SearchStore,
  allowedRepositories: readonly string[] = ['demo/cache'],
): Promise<string> {
  const server = createHttpServer({
    engine,
    store: searchStore,
    corsOrigin: 'http://localhost:4173',
    allowedRepositories,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'add a resilient cache',
  topK: 3,
  candidateLanguages: ['Java'],
};

describe('retrieval HTTP API', () => {
  it('checks SeekDB health and serves the shared search contract', async () => {
    const candidate = { id: 'cache' } as SearchCandidate;
    const engine: SearchEngine = {
      search: vi.fn(async () => [candidate]),
    };
    const searchStore = store();
    const url = await listen(engine, searchStore);

    const health = await fetch(`${url}/health`);
    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(await health.json()).toEqual({ status: 'ok', storage: 'seekdb' });
    expect(await response.json()).toEqual({ candidates: [candidate] });
    expect(searchStore.ping).toHaveBeenCalledOnce();
    expect(engine.search).toHaveBeenCalledWith({
      ...request,
      repositoryScopes: ['demo/cache'],
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4173',
    );
  });

  it('rejects malformed search requests before querying the engine', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topK: 0 }),
    });

    expect(response.status).toBe(400);
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('accepts an empty requirement when target metadata is present', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());
    const emptyRequirement = {
      ...request,
      requirement: '',
      target: {
        ...request.target,
        documentation: 'Returns a cached quote with provider fallback.',
      },
    };

    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(emptyRequirement),
    });

    expect(response.status).toBe(200);
    expect(engine.search).toHaveBeenCalledWith({
      ...emptyRequirement,
      repositoryScopes: ['demo/cache'],
    });
  });

  it('rejects unknown or empty candidate language constraints', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    for (const candidateLanguages of [[], ['Kotlin']]) {
      const response = await fetch(`${url}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, candidateLanguages }),
      });

      expect(response.status).toBe(400);
    }
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('accepts only a boolean rerank option', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    const disabled = { ...request, rerank: false };
    const valid = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(disabled),
    });
    expect(valid.status).toBe(200);
    expect(engine.search).toHaveBeenCalledWith({
      ...disabled,
      repositoryScopes: ['demo/cache'],
    });

    for (const rerank of ['false', 0, null]) {
      const response = await fetch(`${url}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, rerank }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('reports invalid JSON and oversized bodies as client errors', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store());

    const invalidJson = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const oversized = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(1024 * 1024 + 1),
    });

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(oversized.status).toBe(413);
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('uses only the configured server-side repositories when the client omits a scope', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store(), ['demo/cache', 'demo/runtime']);

    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    expect(engine.search).toHaveBeenCalledWith({
      ...request,
      repositoryScopes: ['demo/cache', 'demo/runtime'],
    });
  });

  it('fails closed for empty, malformed, and unauthorized client repository scopes', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store(), ['demo/cache']);

    const cases = [
      { repositoryScopes: [], status: 400 },
      { repositoryScopes: ['configured-repositories'], status: 400 },
      { repositoryScopes: ['other/private'], status: 403 },
    ];
    for (const { repositoryScopes, status } of cases) {
      const response = await fetch(`${url}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, repositoryScopes }),
      });
      expect(response.status).toBe(status);
    }
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('fails closed when a deployment has no configured repositories', async () => {
    const engine: SearchEngine = { search: vi.fn(async () => []) };
    const url = await listen(engine, store(), []);

    const response = await fetch(`${url}/v1/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(503);
    expect(engine.search).not.toHaveBeenCalled();
  });
});
