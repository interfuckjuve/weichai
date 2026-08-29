import type { SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbSearchEngine, searchInternals } from './search-engine.js';
import type {
  EmbeddingProvider,
  RetrievedCodeDocument,
  SearchStore,
} from './types.js';

const baseDocument: RetrievedCodeDocument = {
  id: 'cache',
  title: 'AsyncTTLCache.get_or_load',
  repository: 'demo/cache',
  license: 'Apache-2.0',
  language: 'Python',
  kind: 'function',
  path: 'cache.py',
  signature: 'async def get_or_load(key, loader)',
  summary: 'TTL cache with stale fallback',
  preview: 'async def get_or_load(): pass',
  dependencies: [],
  compatibility: ['async'],
  risks: [],
};

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'add ttl cache and stale fallback',
  topK: 2,
  repositoryScopes: ['demo/cache'],
};

function fakeStore(): SearchStore {
  return {
    ping: vi.fn(async () => undefined),
    initialize: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    refreshIndex: vi.fn(async () => undefined),
    semanticSearch: vi.fn(async () => [
      { ...baseDocument, semanticScore: 0.92 },
      {
        ...baseDocument,
        id: 'container',
        title: 'UploadContainer',
        kind: 'class',
        semanticScore: 0.99,
      },
      {
        ...baseDocument,
        id: 'queue',
        title: 'Queue.push',
        semanticScore: 0.3,
      },
    ]),
    textSearch: vi.fn(async () => [{ ...baseDocument, textScore: 0.88 }]),
    close: vi.fn(async () => undefined),
  };
}

const embeddings: EmbeddingProvider = {
  dimension: 3,
  embed: vi.fn(async () => [[1, 0, 0]]),
};

describe('SeekDbSearchEngine', () => {
  it('queries vector and full-text indexes and fuses duplicate candidates', async () => {
    const store = fakeStore();
    const engine = new SeekDbSearchEngine(store, embeddings);

    const candidates = await engine.search(request);

    expect(candidates[0]?.id).toBe('cache');
    expect(candidates).toHaveLength(2);
    expect(store.semanticSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ repositories: ['demo/cache'], kinds: ['function'] }),
      50,
    );
    expect(store.textSearch).toHaveBeenCalledOnce();
  });

  it('pushes candidate language constraints to storage and rejects mismatched rows', async () => {
    const store = fakeStore();
    const engine = new SeekDbSearchEngine(store, embeddings);

    const candidates = await engine.search({
      ...request,
      candidateLanguages: ['Java'],
    });

    expect(candidates).toEqual([]);
    expect(store.semanticSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ languages: ['Java'] }),
      50,
    );
    expect(store.textSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ languages: ['Java'] }),
      50,
    );
  });

  it('hard-isolates class targets from function candidates', async () => {
    const store = fakeStore();
    const engine = new SeekDbSearchEngine(store, embeddings);
    const classDocument: RetrievedCodeDocument = {
      ...baseDocument,
      id: 'class-candidate',
      title: 'UploadParser',
      kind: 'class',
    };
    (store.semanticSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...baseDocument, semanticScore: 0.99 },
      { ...classDocument, semanticScore: 0.92 },
    ]);
    (store.textSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...baseDocument, textScore: 0.99 },
      { ...classDocument, textScore: 0.92 },
    ]);
    const results = await engine.search({
      ...request,
      target: { ...request.target, kind: 'class', name: 'UploadParser' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'class-candidate', kind: 'class' });
    expect(store.semanticSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ kinds: ['class'] }),
      50,
    );
  });

  it('uses an exact recall limit when configured for PDF reranking', async () => {
    const store = fakeStore();
    const engine = new SeekDbSearchEngine(store, embeddings, 20);

    await engine.search({ ...request, topK: 4 });

    expect(store.semanticSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.anything(),
      20,
    );
    expect(store.textSearch).toHaveBeenCalledWith(expect.any(String), expect.anything(), 20);
  });

  it('refuses an unscoped request before embedding or querying storage', async () => {
    const store = fakeStore();
    const localEmbeddings: EmbeddingProvider = {
      dimension: 3,
      embed: vi.fn(async () => [[1, 0, 0]]),
    };
    const engine = new SeekDbSearchEngine(store, localEmbeddings);

    await expect(engine.search({ ...request, repositoryScopes: [] })).rejects.toThrow(
      'Repository scope must contain at least one repository.',
    );
    expect(localEmbeddings.embed).not.toHaveBeenCalled();
    expect(store.semanticSearch).not.toHaveBeenCalled();
    expect(store.textSearch).not.toHaveBeenCalled();
  });
});

describe('search internals', () => {
  it('fails closed for missing, UI-label, wildcard, or malformed repository scopes', () => {
    for (const scopes of [
      undefined,
      [],
      ['configured-repositories'],
      ['repo:oceanbase/seekdb'],
      ['org/*'],
    ]) {
      expect(() => searchInternals.repositoryScopes(scopes)).toThrow(
        'Repository scope',
      );
    }
  });

  it('preserves only exact repository identifiers', () => {
    expect(searchInternals.repositoryScopes(['oceanbase/seekdb', 'chiparon/weichai']))
      .toEqual(['oceanbase/seekdb', 'chiparon/weichai']);
  });

  it('expands camel-case symbols and target paths into searchable domain terms', () => {
    const settlementRequest: SearchRequest = {
      ...request,
      target: {
        id: 'settle-batch',
        name: 'settleBatch',
        kind: 'function',
        path: 'src/application/settlement/settlement-service.ts',
        language: 'TypeScript',
        signature:
          'settleBatch(request: SettlementBatchRequest): Promise<SettlementBatchResult>',
      },
      requirement: 'settleBatch',
    };

    const query = searchInternals.queryText(settlementRequest);
    expect(query).toContain('settle');
    expect(query).toContain('batch');
    expect(query).toContain('settlement');
    expect(searchInternals.overlap('settleBatch', 'settlement batch queue')).toBeGreaterThan(0);
  });

  it('uses target signatures and documentation when the requirement is empty', () => {
    const metadataOnlyRequest: SearchRequest = {
      ...request,
      requirement: '',
      target: {
        ...request.target,
        signature: 'GetQuoteAsync(QuoteRequest request)',
        documentation: 'Returns a cached quote with stale provider fallback.',
      },
    };

    const query = searchInternals.queryText(metadataOnlyRequest);
    expect(query).toContain('GetQuoteAsync');
    expect(query).toContain('QuoteRequest');
    expect(query).toContain('cached quote with stale provider fallback');
  });

  it('reranks a broad but bounded candidate pool for large corpora', () => {
    expect(searchInternals.expandedLimit(1)).toBe(50);
    expect(searchInternals.expandedLimit(20)).toBe(100);
    expect(searchInternals.expandedLimit(50)).toBe(250);
  });

  it('deduplicates candidate language constraints', () => {
    expect(searchInternals.candidateLanguages(['Java', 'Java', 'Python'])).toEqual([
      'Java',
      'Python',
    ]);
  });

  it('uses the target kind as the sole candidate kind filter', () => {
    expect(searchInternals.candidateKinds('class')).toEqual(['class']);
    expect(searchInternals.candidateKinds('function')).toEqual(['function']);
  });
});
