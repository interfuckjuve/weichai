export interface ModuleRerankerConfig {
  /** Only a local inference server is supported; redirects are forbidden. */
  url: string;
  model: string;
  timeoutMs?: number;
}

export interface ModuleReranker {
  readonly model: string;
  rank(query: string, documents: readonly string[], signal: AbortSignal): Promise<Array<{ index: number; score: number }>>;
}

/** Joint query/document scoring remains on the host machine. */
export class LocalModuleReranker implements ModuleReranker {
  readonly model: string;
  private readonly config: Readonly<ModuleRerankerConfig>;
  constructor(config: ModuleRerankerConfig) {
    const url = new URL(config.url);
    const timeout = config.timeoutMs ?? 4_000;
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password ||
      !config.model.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 8_000) {
      throw new Error('Reranking requires a loopback IP HTTP endpoint, model and 1..8000 ms timeout.');
    }
    this.config = Object.freeze({ ...config, timeoutMs: timeout });
    this.model = config.model;
  }

  async rank(query: string, documents: readonly string[], parentSignal: AbortSignal): Promise<Array<{ index: number; score: number }>> {
    parentSignal.throwIfAborted();
    if (documents.length === 0) return [];
    if (documents.length > 20) throw new Error('At most 20 modules may be reranked.');
    const response = await fetch(this.config.url, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([parentSignal, AbortSignal.timeout(this.config.timeoutMs!)]),
      body: JSON.stringify({ model: this.model, query: query.slice(0, 32_000), documents: documents.map((document) => document.slice(0, 8_000)), top_n: documents.length }),
    });
    if (!response.ok) throw new Error(`Module reranking failed with HTTP ${response.status}.`);
    const payload = await response.json() as { results?: Array<{ index?: unknown; relevance_score?: unknown }> };
    if (!Array.isArray(payload.results) || payload.results.length !== documents.length) throw new Error('Reranker must score every candidate module.');
    const seen = new Set<number>();
    const results = payload.results.map((result) => {
      const index = result.index;
      const score = result.relevance_score;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documents.length || seen.has(index) ||
        typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error('Reranker returned an invalid candidate index or score.');
      seen.add(index);
      return { index, score };
    });
    return results.sort((a, b) => b.score - a.score || a.index - b.index);
  }
}
