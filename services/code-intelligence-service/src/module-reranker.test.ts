import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModuleReranker } from './module-reranker.js';

afterEach(() => vi.restoreAllMocks());
const config = { url: 'http://127.0.0.1:4022/v1/rerank', model: 'local-test' };

describe('local module cross-encoder adapter', () => {
  it('accepts only loopback IPs and never follows redirects', async () => {
    expect(() => new LocalModuleReranker({ ...config, url: 'https://example.com/rerank' })).toThrow('loopback');
    expect(() => new LocalModuleReranker({ ...config, url: 'http://127.0.0.1.example.com/rerank' })).toThrow('loopback');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] })));
    await new LocalModuleReranker(config).rank('query', ['document'], new AbortController().signal);
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('error');
  });

  it('returns a validated permutation ordered by joint relevance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] })));
    expect(await new LocalModuleReranker(config).rank('query', ['first', 'second'], new AbortController().signal)).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
  });

  it('rejects omissions, duplicate IDs, invalid scores and service failures', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const results of [[], [{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.9 }], [{ index: 0, relevance_score: 2 }, { index: 1, relevance_score: 0.5 }]]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ results })));
      await expect(new LocalModuleReranker(config).rank('query', ['first', 'second'], new AbortController().signal)).rejects.toThrow();
    }
    fetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(new LocalModuleReranker(config).rank('query', ['first'], new AbortController().signal)).rejects.toThrow('503');
  });
});
