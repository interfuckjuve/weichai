import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextPacket, TaskRetrievalRequest } from '@forexplore/contracts';
import type { SemanticQueryPort, TaskRetrievalPort } from '@forexplore/workflow-core';
import { createSemanticQueryHttpServer } from './semantic-query-http-server.js';

const request: TaskRetrievalRequest = {
  requestId: 'http-query', requirement: 'Change upload limits', granularity: 'function',
  scopes: [{ repositoryId: 'repository', analysisRevision: 'revision' }], budget: { maxTokens: 4000 },
};
const servers: Server[] = [];
async function listen(taskRetrieval?: TaskRetrievalPort, bearerToken?: string): Promise<string> {
  const server = createSemanticQueryHttpServer({ queryPort: {} as SemanticQueryPort, taskRetrieval, bearerToken });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address.');
  return `http://127.0.0.1:${address.port}/v1/task-search`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe('task context HTTP transport', () => {
  it('passes validated revision and budget to the task port and returns its packet', async () => {
    const packet = { requestId: request.requestId, markdown: 'Actual context' } as ContextPacket;
    const search = vi.fn(async () => packet);
    const response = await fetch(await listen({ search }), { method: 'POST', body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(packet);
    expect(search).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  });

  it('requires the configured port, valid request and bearer token before searching', async () => {
    const search = vi.fn();
    const unavailable = await fetch(await listen(), { method: 'POST', body: JSON.stringify(request) });
    expect(unavailable.status).toBe(404);
    const url = await listen({ search }, 'test-token');
    const denied = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
    expect(denied.status).toBe(401);
    const invalid = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ ...request, budget: { maxTokens: -1 } }) });
    expect(invalid.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it('cancels an in-flight task when the client disconnects', async () => {
    let began!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    const search: TaskRetrievalPort['search'] = async (_request, signal) => {
      began();
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => {
        cancelled(); reject(signal!.reason);
      }, { once: true }));
    };
    const controller = new AbortController();
    const pending = fetch(await listen({ search }), { method: 'POST', body: JSON.stringify(request), signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await aborted;
  }, 5000);

  it('does not expose provider details when a task fails', async () => {
    const url = await listen({ search: async () => { throw new Error('Private provider connection details'); } });
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('Private provider');
  });
});
