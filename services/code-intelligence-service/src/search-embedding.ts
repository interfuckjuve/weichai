import { createHash } from 'node:crypto';
import { OpenAiCompatibleEmbeddingProvider } from '@forexplore/retrieval-service/embedding';

/** Minimal embedding abstraction kept within the code-intelligence boundary. */
export interface SearchEmbeddingProvider {
  readonly dimension: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery?(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface ModelSearchEmbeddingConfig {
  url: string;
  apiKey: string;
  model: string;
  supportsDimensions?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
}

/** Bounded content cache is scoped to one immutable model configuration. */
export class ModelSearchEmbeddingProvider implements SearchEmbeddingProvider {
  readonly #client: OpenAiCompatibleEmbeddingProvider;
  readonly #cache = new Map<string, number[]>();
  constructor(readonly dimension: number, private readonly config: ModelSearchEmbeddingConfig) {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || !config.model.trim() || !Number.isInteger(dimension) || dimension < 1) {
      throw new Error('Embedding requires an HTTP endpoint, model and positive dimension.');
    }
    this.#client = new OpenAiCompatibleEmbeddingProvider(dimension, config.url, config.apiKey, config.model,
      { supportsDimensions: config.supportsDimensions, timeoutMs: 8_000, maxRetries: 0 });
  }
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.encode(texts.map((text) => `${this.config.documentPrefix ?? ''}${text}`), signal);
  }
  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return (await this.encode([`${this.config.queryPrefix ?? ''}${text}`], signal))[0]!;
  }
  private async encode(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    const keys = texts.map((text) => createHash('sha256').update(text).digest('hex'));
    const output = keys.map((key) => this.#cache.get(key));
    const missing = new Map<string, { text: string; indices: number[] }>();
    keys.forEach((key, index) => {
      if (output[index]) { const vector = output[index]!; this.#cache.delete(key); this.#cache.set(key, vector); return; }
      const entry = missing.get(key) ?? { text: texts[index]!, indices: [] };
      entry.indices.push(index); missing.set(key, entry);
    });
    const entries = [...missing.entries()];
    for (let offset = 0; offset < entries.length; offset += 16) {
      signal?.throwIfAborted();
      const batch = entries.slice(offset, offset + 16);
      const vectors = await this.#client.embed(batch.map(([, entry]) => entry.text), signal);
      batch.forEach(([key, entry], index) => {
        const vector = vectors[index]!;
        if (!vector.some((value) => value !== 0)) throw new Error('Embedding model returned a zero vector.');
        this.#cache.set(key, vector);
        entry.indices.forEach((position) => { output[position] = vector; });
        while (this.#cache.size > 4096) this.#cache.delete(this.#cache.keys().next().value!);
      });
    }
    return output.map((vector) => [...vector!]);
  }
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
