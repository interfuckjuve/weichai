import { describe, expect, it } from 'vitest';
import { HashSearchEmbeddingProvider } from './search-embedding.js';

describe('HashSearchEmbeddingProvider', () => {
  it('produces deterministic normalized vectors at the configured dimension', async () => {
    const provider = new HashSearchEmbeddingProvider(16);
    const [first, second] = await provider.embed(['export class Widget {}', 'export class Widget {}']);
    expect(first).toHaveLength(16);
    expect(second).toEqual(first);
    expect(Math.sqrt(first!.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 8);
  });
});
