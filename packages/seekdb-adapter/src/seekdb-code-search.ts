import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import type { CodeSearchPort, WorkflowPorts } from '@forexplore/workflow-core';

export interface SeekDbAdapterOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

interface SearchResponse {
  candidates: SearchCandidate[];
}

function searchEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/search`;
}

/**
 * Repository authorization belongs to the retrieval service. UI callers must
 * not send display labels or a client-controlled allow-list as a search scope.
 */
function serverScopedRequest(request: SearchRequest): SearchRequest {
  const { repositoryScopes: _repositoryScopes, ...serverManagedRequest } = request;
  return serverManagedRequest;
}

function isSearchResponse(value: unknown): value is SearchResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidates = (value as { candidates?: unknown }).candidates;
  return (
    Array.isArray(candidates) &&
    candidates.every(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof (candidate as { id?: unknown }).id === 'string' &&
        typeof (candidate as { title?: unknown }).title === 'string' &&
        typeof (candidate as { score?: unknown }).score === 'object',
    )
  );
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // The status text below is more useful than a JSON parse failure.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export class SeekDbCodeSearchAdapter implements CodeSearchPort {
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: SeekDbAdapterOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('SeekDB retrieval API base URL must not be empty.');
    }
    this.endpoint = searchEndpoint(options.baseUrl);
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverScopedRequest(request)),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new Error(
        `无法连接 SeekDB 检索服务 ${this.endpoint}；请确认已通过 npm run dev 启动服务。`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new Error(`SeekDB retrieval failed: ${await responseError(response)}`);
    }

    const body: unknown = await response.json();
    if (!isSearchResponse(body)) {
      throw new Error('SeekDB retrieval returned an invalid response.');
    }
    return body.candidates;
  }
}

export function withSeekDbSearch(
  ports: WorkflowPorts,
  options: SeekDbAdapterOptions,
): WorkflowPorts {
  return {
    ...ports,
    search: new SeekDbCodeSearchAdapter(options),
  };
}
