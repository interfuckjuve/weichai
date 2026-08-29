import type { SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbCodeSearchAdapter } from './seekdb-code-search';

const request: SearchRequest = {
  target: {
    id: 'target',
    name: 'getQuote',
    kind: 'function',
    path: 'quote.ts',
    language: 'TypeScript',
    signature: 'getQuote(): Promise<Quote>',
  },
  requirement: 'add caching and stale fallback',
  topK: 3,
  repositoryScopes: [],
};

describe('SeekDbCodeSearchAdapter', () => {
  it('posts the stable search contract to the retrieval service', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            id: 'cache',
            title: 'get_or_load',
            score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.9 },
          },
        ],
      }),
    );
    const adapter = new SeekDbCodeSearchAdapter({
      baseUrl: 'http://127.0.0.1:8787/',
      fetch,
    });

    const result = await adapter.search(request);

    expect(result[0]?.id).toBe('cache');
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/v1/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ...request,
          repositoryScopes: undefined,
        }),
      }),
    );
  });

  it('surfaces the service error message', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: 'seekdb is unavailable' }, { status: 503 }),
    );
    const adapter = new SeekDbCodeSearchAdapter({ baseUrl: 'http://localhost', fetch });

    await expect(adapter.search(request)).rejects.toThrow('seekdb is unavailable');
  });

  it('explains how to recover when the service is unreachable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const adapter = new SeekDbCodeSearchAdapter({
      baseUrl: 'http://127.0.0.1:8787',
      fetch,
    });

    await expect(adapter.search(request)).rejects.toThrow(
      '请确认已通过 npm run dev 启动服务',
    );
  });
});
