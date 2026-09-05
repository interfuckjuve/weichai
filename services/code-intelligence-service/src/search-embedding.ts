/** Minimal embedding abstraction kept within the code-intelligence boundary. */
export interface SearchEmbeddingProvider {
  readonly dimension: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function features(text: string): string[] {
  const words = text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const values: string[] = [];
  for (const word of words) {
    values.push(`word:${word}`);
    for (let index = 0; index <= word.length - 3; index += 1) values.push(`gram:${word.slice(index, index + 3)}`);
  }
  return values;
}

/**
 * Deterministic offline fallback. A host can inject a model-backed provider,
 * while this keeps every SeekDB projection row vector-indexable in local
 * setups instead of silently storing NULL embeddings.
 */
export class HashSearchEmbeddingProvider implements SearchEmbeddingProvider {
  constructor(readonly dimension = 384) {
    if (!Number.isInteger(dimension) || dimension < 1) {
      throw new Error('Search embedding dimension must be a positive integer.');
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return texts.map((text) => {
      signal?.throwIfAborted();
      const vector = Array.from({ length: this.dimension }, () => 0);
      for (const feature of features(text)) {
        const hash = fnv1a(feature);
        const position = hash % this.dimension;
        vector[position] = (vector[position] ?? 0) + ((hash & 0x80000000) === 0 ? 1 : -1);
      }
      return normalize(vector);
    });
  }
}

export const searchEmbeddingInternals = { features, fnv1a, normalize };
