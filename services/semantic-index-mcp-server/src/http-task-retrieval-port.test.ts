import { expect, it, vi } from 'vitest';
import { HttpTaskRetrievalPort } from './http-task-retrieval-port.js';

it('allows only a literal local host and prevents redirects carrying task inputs', async () => {
  for (const endpoint of ['https://example.org', 'http://localhost:8790', 'http://192.168.1.2:8790',
    'http://user:password@127.0.0.1:8790', 'http://127.0.0.1:8790/private', 'http://127.0.0.1:8790/?secret=value']) {
    expect(() => new HttpTaskRetrievalPort({ endpoint })).toThrow('existing HTTP host');
  }
  expect(() => new HttpTaskRetrievalPort({ endpoint: 'http://[::1]:8790' })).not.toThrow();
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ packetId: 'packet-1' })));
  const adapter = new HttpTaskRetrievalPort({ endpoint: 'http://127.0.0.1:8790', bearerToken: 'local-token', fetch: fetcher });
  const request = { requestId: 'request-1', requirement: 'find quote', scopes: [{ repositoryId: 'quotes', analysisRevision: 'analysis-1' }], budget: { maxTokens: 4000 } };
  const signal = new AbortController().signal;
  expect(await adapter.search(request, signal)).toMatchObject({ packetId: 'packet-1' });
  expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:8790/v1/task-search'), expect.objectContaining({
    method: 'POST', redirect: 'error', signal, body: JSON.stringify(request), headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
  }));
});

it('reports local HTTP failure without reflecting arbitrary remote error bodies', async () => {
  const fetcher = vi.fn(async () => new Response('private database details', { status: 500 }));
  const adapter = new HttpTaskRetrievalPort({ endpoint: 'http://127.0.0.1:8790', fetch: fetcher });
  await expect(adapter.search({ requestId: 'request-1', requirement: 'quote', scopes: [{ repositoryId: 'quotes', analysisRevision: 'analysis-1' }], budget: { maxTokens: 4000 } })).rejects.toThrow('status 500');
});
