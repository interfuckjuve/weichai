import type {
  IndexedImplementationDocumentV2,
  MigrationRuntimeCapabilitySnapshot,
  SearchCandidateV2,
  SearchRequestV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';
import {
  validateIndexedImplementationDocumentV2,
  validateMigrationRuntimeCapabilitySnapshot,
  validateSearchCandidateV2,
  validateSearchRequestV2,
  validateSourceImplementationBundleV2,
  type ResolveSourceBundleV2Request,
  type ResolvedSourceBundleV2,
  type SearchPortV2,
  type SourceBundleResolverPortV2,
} from '@forexplore/workflow-core';
import type { SeekDbAdapterOptions } from './seekdb-code-search';

interface SearchResponseV2 {
  candidates: SearchCandidateV2[];
  indexedDocuments: IndexedImplementationDocumentV2[];
}

export interface SeekDbAdapterOptionsV2 extends SeekDbAdapterOptions {
  /** Re-resolved for every operation so a runtime snapshot rotation fails closed. */
  runtimeCapabilities:
    | MigrationRuntimeCapabilitySnapshot
    | (() => MigrationRuntimeCapabilitySnapshot | Promise<MigrationRuntimeCapabilitySnapshot>);
}

function endpoint(baseUrl: string, endpointPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${endpointPath}`;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // Fall through to the HTTP status.
  }
  return response.statusText || `HTTP ${response.status}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * V2 client keeps the immutable request intact and verifies every returned
 * artifact through workflow-core. Shape checks only frame JSON arrays; they
 * are never treated as content-address validation.
 */
export class SeekDbCodeSearchAdapterV2
  implements SearchPortV2, SourceBundleResolverPortV2 {
  private readonly searchEndpoint: string;
  private readonly sourceBundleEndpoint: string;
  private readonly request: typeof globalThis.fetch;
  private readonly runtimeProvider: SeekDbAdapterOptionsV2['runtimeCapabilities'];

  constructor(options: SeekDbAdapterOptionsV2) {
    if (!options.baseUrl.trim()) throw new Error('SeekDB retrieval API base URL must not be empty.');
    this.searchEndpoint = endpoint(options.baseUrl, '/v2/search');
    this.sourceBundleEndpoint = endpoint(options.baseUrl, '/v2/source-bundles/resolve');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.runtimeProvider = options.runtimeCapabilities;
    if (typeof this.runtimeProvider !== 'function') {
      validateMigrationRuntimeCapabilitySnapshot(this.runtimeProvider);
    }
  }

  private async runtime(): Promise<MigrationRuntimeCapabilitySnapshot> {
    const value = typeof this.runtimeProvider === 'function'
      ? await this.runtimeProvider()
      : this.runtimeProvider;
    return validateMigrationRuntimeCapabilitySnapshot(value);
  }

  private async post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new Error(`无法连接 SeekDB V2 检索服务 ${url}。`, { cause: error });
    }
    if (!response.ok) throw new Error(`SeekDB V2 retrieval failed: ${await responseError(response)}`);
    return response.json();
  }

  async search(request: SearchRequestV2, signal?: AbortSignal): Promise<SearchCandidateV2[]> {
    const runtime = await this.runtime();
    validateSearchRequestV2(request, runtime);
    const body = await this.post(this.searchEndpoint, {
      request,
      runtimeCapabilities: runtime,
    }, signal);
    if (!isObject(body) || !Array.isArray(body.candidates) || !Array.isArray(body.indexedDocuments)) {
      throw new Error('SeekDB V2 retrieval returned an invalid evidence envelope.');
    }
    const response = body as unknown as SearchResponseV2;
    if (response.candidates.length !== response.indexedDocuments.length) {
      throw new Error('SeekDB V2 retrieval omitted authoritative indexed evidence.');
    }
    const documents = new Map<string, IndexedImplementationDocumentV2>();
    for (const document of response.indexedDocuments) {
      validateIndexedImplementationDocumentV2(document);
      if (documents.has(document.id)) throw new Error('SeekDB V2 retrieval repeated indexed evidence.');
      documents.set(document.id, document);
    }
    for (const candidate of response.candidates) {
      const document = documents.get(candidate.indexedDocumentId);
      if (!document) throw new Error('SeekDB V2 retrieval candidate has no authoritative indexed evidence.');
      validateSearchCandidateV2(candidate, request, document, runtime);
    }
    return response.candidates;
  }

  async resolveSourceBundle(
    request: ResolveSourceBundleV2Request,
    signal?: AbortSignal,
  ): Promise<ResolvedSourceBundleV2> {
    const runtime = await this.runtime();
    validateSearchRequestV2(request.request, runtime);
    const body = await this.post(this.sourceBundleEndpoint, {
      resolution: request,
      runtimeCapabilities: runtime,
    }, signal);
    if (!isObject(body) || !isObject(body.indexedDocument) || !isObject(body.bundle)) {
      throw new Error('SeekDB V2 source bundle resolver returned an invalid evidence envelope.');
    }
    const indexedDocument = body.indexedDocument as unknown as IndexedImplementationDocumentV2;
    const bundle = body.bundle as unknown as SourceImplementationBundleV2;
    validateIndexedImplementationDocumentV2(indexedDocument);
    validateSearchCandidateV2(request.candidate, request.request, indexedDocument, runtime);
    validateSourceImplementationBundleV2(bundle);
    if (
      bundle.id !== request.candidate.sourceBundle.id ||
      bundle.contentHash !== request.candidate.sourceBundle.contentHash ||
      bundle.candidate.id !== indexedDocument.candidate.id ||
      bundle.candidate.contentHash !== indexedDocument.candidate.contentHash
    ) {
      throw new Error('SeekDB V2 source bundle does not match the selected candidate lineage.');
    }
    return { indexedDocument, bundle };
  }
}

export function withSeekDbSearchV2<T extends object>(
  ports: T,
  options: SeekDbAdapterOptionsV2,
): Omit<T, 'search' | 'sourceBundleResolver'> & {
  search: SearchPortV2;
  sourceBundleResolver: SourceBundleResolverPortV2;
} {
  const adapter = new SeekDbCodeSearchAdapterV2(options);
  return {
    ...ports,
    search: adapter,
    sourceBundleResolver: adapter,
  };
}
