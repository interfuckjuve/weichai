import {
  createDefaultLanguageRegistry,
  type LanguageRegistry,
} from '@forexplore/code-indexer';
import type { LanguageCapabilityLevel, LanguageId } from '@forexplore/contracts';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import {
  AnalysisCoordinator,
  type AnalysisCoordinatorOptions,
  type SearchProjection,
  type StructuralScanner,
} from './analysis-coordinator.js';
import { InMemoryIndexStore, type IndexStore } from './index-store.js';
import {
  RepositoryRegistry,
  type RepositoryRegistryOptions,
} from './repository-registry.js';
import { RepositoryStructuralScanner } from './repository-scanner.js';
import { SeekDbIndexStore, type SeekDbIndexStoreConfig } from './seekdb-index-store.js';
import { SeekDbProjection } from './seekdb-projection.js';
import { JavaCsharpSpecializedProvider } from './java-csharp-specialized-provider.js';
import { LspSessionManager } from './lsp-session-manager.js';
import {
  SemanticQueryService,
  type SemanticProvider,
  type SemanticQueryServiceOptions,
} from './semantic-query-service.js';
import { ModuleImplementationSearchService } from './module-implementation-search.js';

export {
  AnalysisCoordinator,
  type AnalysisCoordinatorClock,
  type AnalysisCoordinatorOptions,
  type AnalysisMode,
  type AnalysisRunResult,
  type RunAnalysisRequest,
  type SearchProjection,
  type StructuralScanner,
  type StructuralScanRequest,
  type StructuralScanResult,
} from './analysis-coordinator.js';
export { InMemoryIndexStore, type IndexStore } from './index-store.js';
export { RepositoryRegistry, type RegisterRepositoryRequest, type RepositoryRegistryOptions } from './repository-registry.js';
export {
  RepositoryStructuralScanner,
  snapshotRepositorySources,
  type RepositoryStructuralScannerOptions,
} from './repository-scanner.js';
export { SeekDbIndexStore, type SeekDbIndexStoreConfig } from './seekdb-index-store.js';
export { SeekDbProjection } from './seekdb-projection.js';
export {
  HashSearchEmbeddingProvider,
  type SearchEmbeddingProvider,
} from './search-embedding.js';
export {
  createSemanticQueryHttpServer,
  type SemanticQueryHttpServerOptions,
} from './semantic-query-http-server.js';
export {
  LspSessionManager,
  type LspSemanticSession,
} from './lsp-session-manager.js';
export {
  JavaCsharpSpecializedProvider,
  type JavaCsharpSpecializedBinding,
} from './java-csharp-specialized-provider.js';
export {
  SemanticQueryService,
  type SemanticProvider,
  type SemanticQueryServiceOptions,
} from './semantic-query-service.js';
export {
  ModuleImplementationSearchService,
  type ModuleImplementationSearchPort,
  type ModuleImplementationSearchRequest,
} from './module-implementation-search.js';

export interface CreateCodeIntelligenceRuntimeOptions {
  /** An injected store is useful in tests and avoids making MCP own storage. */
  store?: IndexStore;
  seekdb?: SeekDbIndexStoreConfig;
  languageRegistry?: LanguageRegistry;
  scanner?: StructuralScanner;
  projection?: SearchProjection;
  /** Host-owned LSP registry; the query layer never starts language servers. */
  lspSessionManager?: LspSessionManager;
  /** Host registration bridge for existing Java/C# compiler-probe evidence. */
  javaCsharpSpecializedProvider?: JavaCsharpSpecializedProvider;
  semanticProviders?: readonly SemanticProvider[];
  queryOptions?: Omit<SemanticQueryServiceOptions, 'languageCapabilities' | 'semanticProviders'>;
  registryOptions?: RepositoryRegistryOptions;
  coordinatorOptions?: AnalysisCoordinatorOptions;
  initialize?: boolean;
}

export interface CodeIntelligenceRuntime {
  store: IndexStore;
  registry: RepositoryRegistry;
  coordinator: AnalysisCoordinator;
  /** Host-only semantic session registries; never pass these to Agent/MCP code. */
  lspSessionManager: LspSessionManager;
  javaCsharpSpecializedProvider: JavaCsharpSpecializedProvider;
  queryPort: SemanticQueryPort;
  moduleImplementationSearch: ModuleImplementationSearchService;
  close(): Promise<void>;
}

function languageCapabilities(registry: LanguageRegistry): Map<LanguageId, LanguageCapabilityLevel> {
  return new Map(registry.list().map((registration) => [
    registration.languageId,
    registration.capabilityLevel,
  ]));
}

/**
 * Compose the one shared indexing/query chain used by historical and target
 * repositories. Only the host receives `registry` and `coordinator`; agents,
 * MCP, and webviews receive the read-only `queryPort`.
 */
export async function createCodeIntelligenceRuntime(
  options: CreateCodeIntelligenceRuntimeOptions = {},
): Promise<CodeIntelligenceRuntime> {
  if (options.store && options.seekdb) {
    throw new Error('Choose an injected IndexStore or a SeekDB configuration, not both.');
  }
  const ownsStore = !options.store;
  const store: IndexStore = options.store ?? (
    options.seekdb ? new SeekDbIndexStore(options.seekdb) : new InMemoryIndexStore()
  );
  if (options.initialize !== false) await store.initialize?.();
  const languageRegistry = options.languageRegistry ?? createDefaultLanguageRegistry();
  const registry = new RepositoryRegistry(store, options.registryOptions);
  const scanner = options.scanner ?? new RepositoryStructuralScanner({ languageRegistry });
  const projection = options.projection ?? new SeekDbProjection(store);
  const lspSessionManager = options.lspSessionManager ?? new LspSessionManager();
  const javaCsharpSpecializedProvider = options.javaCsharpSpecializedProvider ?? new JavaCsharpSpecializedProvider(store);
  const semanticProviders = [
    ...(options.semanticProviders ?? []),
    lspSessionManager,
    javaCsharpSpecializedProvider,
  ];
  const queryPort = new SemanticQueryService(store, {
    ...options.queryOptions,
    languageCapabilities: languageCapabilities(languageRegistry),
    semanticProviders,
  });
  const moduleImplementationSearch = new ModuleImplementationSearchService(store);
  const coordinator = new AnalysisCoordinator(
    registry,
    store,
    scanner,
    projection,
    options.coordinatorOptions,
  );
  return {
    store,
    registry,
    coordinator,
    lspSessionManager,
    javaCsharpSpecializedProvider,
    queryPort,
    moduleImplementationSearch,
    async close(): Promise<void> {
      if (ownsStore) await store.close?.();
    },
  };
}

export const runtimeInternals = { languageCapabilities };
export { ProjectAnalysisCoordinator, projectAnalysisProfile, projectAnalysisObjective, projectPlanHash, validateProjectResult } from './project-analysis.js';
