import type { ContextPacket, TaskRetrievalRequest } from '@forexplore/contracts';
import type { TaskRetrievalPort } from '@forexplore/workflow-core';
import type { HttpSemanticQueryPortOptions } from './http-semantic-query-port.js';

export class HttpTaskRetrievalPort implements TaskRetrievalPort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #token?: string;

  constructor(options: HttpSemanticQueryPortOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('Task retrieval requires an existing HTTP host at 127.0.0.1 or [::1], without credentials or a path.');
    }
    this.#endpoint = new URL('/v1/task-search', endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = options.bearerToken?.trim() || undefined;
  }

  async search(request: TaskRetrievalRequest, signal?: AbortSignal): Promise<ContextPacket> {
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Local task retrieval failed with status ${response.status}.`);
    return await response.json() as ContextPacket;
  }
}
