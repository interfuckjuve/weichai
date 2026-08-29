import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to no authorized repositories and parses an explicit allow-list', () => {
    expect(loadConfig({}).allowedRepositories).toEqual([]);
    expect(
      loadConfig({
        RETRIEVAL_ALLOWED_REPOSITORIES: 'demo/cache, demo/runtime, demo/cache',
      }).allowedRepositories,
    ).toEqual(['demo/cache', 'demo/runtime']);
  });

  it('rejects malformed repository allow-list entries', () => {
    expect(() =>
      loadConfig({ RETRIEVAL_ALLOWED_REPOSITORIES: 'demo/cache, configured-repositories' }),
    ).toThrow('RETRIEVAL_ALLOWED_REPOSITORIES contains an invalid repository identifier');
  });

  it('requests dimensions by default for the default OpenAI embedding model', () => {
    const config = loadConfig({
      SEEKDB_EMBEDDING_PROVIDER: 'openai',
      SEEKDB_EMBEDDING_API_KEY: 'test-key',
    });

    expect(config.embedding).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      supportsDimensions: true,
    });
  });

  it('allows an OpenAI-compatible provider to opt out of dimensions', () => {
    const config = loadConfig({
      SEEKDB_EMBEDDING_PROVIDER: 'openai',
      SEEKDB_EMBEDDING_API_KEY: 'test-key',
      SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS: 'false',
    });

    expect(config.embedding).toMatchObject({
      provider: 'openai',
      supportsDimensions: false,
    });
  });

  it('uses the shared DeepSeek model settings for reranking', () => {
    const config = loadConfig({
      RERANK_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_API_BASE: 'https://deepseek.example.test/v1/',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      RERANK_MAX_RETRIES: '0',
      RERANK_VALIDATION_RETRIES: '0',
    });

    expect(config.reranking).toMatchObject({
      provider: 'deepseek',
      url: 'https://deepseek.example.test/v1/chat/completions',
      model: 'deepseek-v4-pro',
      maxRetries: 0,
      validationRetries: 0,
    });
  });
});
