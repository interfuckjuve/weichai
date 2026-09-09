import { afterEach, describe, expect, it, vi } from 'vitest';
import { HashSearchEmbeddingProvider, ModelSearchEmbeddingProvider } from './search-embedding.js';

afterEach(() => vi.restoreAllMocks());

describe('model embedding adapter', () => {
  it('pins preprocessing and identity against later configuration mutations', async () => {
    const requests: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.input);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
    const config = { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', documentPrefix: 'passage: ' };
    const provider = new ModelSearchEmbeddingProvider(2, config);
    const identity = provider.identity;
    config.documentPrefix = 'changed: ';
    await provider.embed(['same']);
    expect(requests).toEqual([['passage: same']]);
    expect(provider.identity).toBe(identity);
    expect(new ModelSearchEmbeddingProvider(2, config).identity).not.toBe(identity);
  });

  it('deduplicates content, separates query/document instructions and protects cached vectors', async () => {
    const requests: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.input);
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model',
      queryPrefix: 'query: ', documentPrefix: 'passage: ' });
    const first = await provider.embed(['same', 'same']);
    first[0]![0] = 99;
    expect(await provider.embed(['same'])).toEqual([[1, 0]]);
    expect(await provider.embedQuery('same')).toEqual([1, 0]);
    expect(requests).toEqual([['passage: same'], ['query: same']]);
    await expect(provider.embed(['same'], AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(requests).toHaveLength(2);
  });

  it('coalesces concurrent query channels within one request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    const signal = new AbortController().signal;
    const vectors = await Promise.all([1, 2, 3].map(() => provider.embedQuery('same request', signal)));
    expect(fetch).toHaveBeenCalledTimes(1);
    vectors[0]![0] = 99;
    expect(vectors[1]).toEqual([1, 0]);
  });

  it('limits batch size and skips empty requests', async () => {
    const sizes: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sizes.push(body.input.length);
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [0, 1] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    expect(await provider.embed([])).toEqual([]);
    expect(await provider.embed(Array.from({ length: 35 }, (_, i) => String(i)))).toHaveLength(35);
    expect(sizes).toEqual([16, 16, 3]);
  });

  it('rejects zero vectors without caching a successful result', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] })));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    await expect(provider.embed(['bad'])).rejects.toThrow('zero vector');
    await expect(provider.embed(['bad'])).rejects.toThrow('zero vector');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('HashSearchEmbeddingProvider', () => {
  it('produces deterministic normalized vectors at the configured dimension', async () => {
    const provider = new HashSearchEmbeddingProvider(16);
    const [first, second] = await provider.embed(['export class Widget {}', 'export class Widget {}']);
    expect(first).toHaveLength(16);
    expect(second).toEqual(first);
    expect(Math.sqrt(first!.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 8);
  });
});
