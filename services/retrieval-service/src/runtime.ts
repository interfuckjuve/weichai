import type { RetrievalConfig } from './config.js';
import {
  HashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
} from './embedding.js';
import { DeepSeekReranker } from './reranker.js';
import { RerankingSearchEngine } from './reranking-engine.js';
import { SeekDbSearchEngine } from './search-engine.js';
import { SeekDbStore } from './seekdb-store.js';
import {
  createModuleKnowledgeIndexerMetadata,
  DefaultModuleKnowledgeIndexService,
  HybridModuleKnowledgeSearchEngine,
} from './module-knowledge-search.js';
import { SeekDbModuleKnowledgeStore } from './seekdb-module-knowledge-store.js';
import { createHttpServer } from './http-server.js';
import type { EmbeddingProvider, LlmReranker, SearchEngine } from './types.js';
import { materializeMigrationRuntimeCapabilitySnapshot } from '@forexplore/workflow-core';
import {
  DefaultImplementationIndexServiceV2,
  HybridImplementationSearchEngineV2,
  retrievalHostOwnedRuntimeOverrideStages,
} from './implementation-index-v2.js';
import { SeekDbImplementationIndexStoreV2 } from './seekdb-implementation-index-v2-store.js';

export function createEmbeddingProvider(config: RetrievalConfig): EmbeddingProvider {
  if (config.embedding.provider === 'openai') {
    return new OpenAiCompatibleEmbeddingProvider(
      config.embedding.dimension,
      config.embedding.url,
      config.embedding.apiKey,
      config.embedding.model,
      { supportsDimensions: config.embedding.supportsDimensions },
    );
  }
  return new HashEmbeddingProvider(config.embedding.dimension);
}

export function createReranker(config: RetrievalConfig): LlmReranker | null {
  if (config.reranking.provider === 'none') return null;

  return new DeepSeekReranker(
    config.reranking.model,
    config.reranking.url,
    config.reranking.apiKey,
    config.reranking.timeoutMs,
    config.reranking.maxRetries,
  );
}

export function createRuntime(config: RetrievalConfig) {
  const store = new SeekDbStore(config.seekdb);
  const embeddings = createEmbeddingProvider(config);
  const reranker = createReranker(config);
  // The PDF workflow sends exactly the hybrid Top20 to the reranker. The
  // base engine keeps its broader default recall when reranking is disabled.
  const baseEngine: SearchEngine = new SeekDbSearchEngine(
    store,
    embeddings,
    reranker ? 20 : undefined,
  );
  const engine: SearchEngine = reranker
    ? new RerankingSearchEngine(
        baseEngine,
        reranker,
        20,
        config.reranking.provider === 'deepseek'
          ? config.reranking.validationRetries
          : 0,
      )
    : baseEngine;
  const indexer = createModuleKnowledgeIndexerMetadata(
    config.embedding.provider === 'openai'
      ? {
          embeddingProvider: 'openai-compatible',
          embeddingModel: config.embedding.model,
          embeddingDimension: config.embedding.dimension,
          configuration: {
            url: config.embedding.url,
            supportsDimensions: config.embedding.supportsDimensions,
          },
        }
      : {
          embeddingProvider: 'hash',
          embeddingModel: 'forexplore-fnv1a-trigram-v1',
          embeddingDimension: config.embedding.dimension,
          configuration: { algorithm: 'fnv1a-word-trigram', normalization: 'l2' },
        },
  );
  const moduleStore = new SeekDbModuleKnowledgeStore(config.seekdb, undefined, indexer);
  const moduleIndex = new DefaultModuleKnowledgeIndexService(moduleStore, embeddings, indexer);
  const moduleEngine = new HybridModuleKnowledgeSearchEngine(moduleStore, embeddings);
  const implementationStoreV2 = new SeekDbImplementationIndexStoreV2(config.seekdb);
  const runtimeCapabilitiesV2 = config.migrationRuntimeCapabilitySnapshot ??
    materializeMigrationRuntimeCapabilitySnapshot({
      routes: [],
      createdAt: '1970-01-01T00:00:00.000Z',
    });
  const implementationIndexV2 = new DefaultImplementationIndexServiceV2(
    implementationStoreV2,
    embeddings,
  );
  const implementationEngineV2 = new HybridImplementationSearchEngineV2(
    implementationStoreV2,
    embeddings,
    runtimeCapabilitiesV2,
    retrievalHostOwnedRuntimeOverrideStages,
  );
  return {
    store,
    moduleStore,
    implementationStoreV2,
    embeddings,
    engine,
    moduleIndex,
    moduleEngine,
    implementationIndexV2,
    implementationEngineV2,
    runtimeCapabilitiesV2,
    indexer,
  };
}

/**
 * Production composition root used by the executable server and by the
 * configuration-level test. Keeping this here prevents the module routes from
 * existing only in tests that inject hand-written stores/services.
 */
export function createConfiguredHttpServer(
  config: RetrievalConfig,
  runtime = createRuntime(config),
) {
  const server = createHttpServer({
    engine: runtime.engine,
    store: runtime.store,
    corsOrigin: config.corsOrigin,
    allowedRepositories: config.allowedRepositories,
    moduleEngine: runtime.moduleEngine,
    moduleIndex: runtime.moduleIndex,
    moduleStore: runtime.moduleStore,
    moduleIndexToken: config.moduleIndexToken,
    moduleIndexMaxBodyBytes: config.moduleIndexMaxBodyBytes,
    implementationEngineV2: runtime.implementationEngineV2,
    implementationIndexV2: runtime.implementationIndexV2,
    implementationStoreV2: runtime.implementationStoreV2,
    implementationIndexToken: config.implementationIndexToken,
    implementationIndexMaxBodyBytes: config.implementationIndexMaxBodyBytes,
  });
  return { server, runtime };
}
