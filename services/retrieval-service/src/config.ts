import { requireRepositoryScopes } from './repository-scope.js';
import type { MigrationRuntimeCapabilitySnapshot } from '@forexplore/contracts';
import { validateMigrationRuntimeCapabilitySnapshot } from '@forexplore/workflow-core';

export type RerankingConfig =
  | { provider: 'none' }
  | {
      provider: 'deepseek';
      url: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
      maxRetries: number;
      validationRetries: number;
    };

export interface RetrievalConfig {
  host: string;
  port: number;
  corsOrigin: string;
  /**
   * Deployment-owned authorization boundary for every retrieval query. An
   * empty list deliberately leaves search unavailable rather than exposing the
   * full index during local setup or a misconfigured deployment.
   */
  allowedRepositories: string[];
  /** Bearer token for publication/index lifecycle mutations; empty disables writes. */
  moduleIndexToken: string;
  moduleIndexMaxBodyBytes: number;
  /** Bearer token for V2 implementation-index generation mutations. */
  implementationIndexToken: string;
  implementationIndexMaxBodyBytes: number;
  migrationRuntimeCapabilitySnapshot?: MigrationRuntimeCapabilitySnapshot;
  autoMigrate: boolean;
  seekdb: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    table: string;
    /** Dedicated functional-module projection; never aliases the symbol table. */
    moduleKnowledgeTable: string;
    vectorDimension: number;
  };
  embedding:
    | { provider: 'hash'; dimension: number }
    | {
        provider: 'openai';
        dimension: number;
        url: string;
        apiKey: string;
        model: string;
        supportsDimensions: boolean;
      };
  reranking: RerankingConfig;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function identifier(value: string | undefined, fallback: string, name: string): string {
  const selected = value?.trim() || fallback;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(selected)) {
    throw new Error(`${name} must be a SQL identifier containing only letters, digits, and _.`);
  }
  return selected;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function allowedRepositories(value: string | undefined): string[] {
  if (value === undefined || !value.trim()) return [];
  return requireRepositoryScopes(
    value.split(',').map((repository) => repository.trim()),
    'RETRIEVAL_ALLOWED_REPOSITORIES',
  );
}

function deepSeekChatCompletionsUrl(env: NodeJS.ProcessEnv): string {
  const legacyUrl = env.RERANK_OPENAI_URL?.trim();
  const apiBase = (env.DEEPSEEK_API_BASE?.trim() || legacyUrl || 'https://api.deepseek.com/v1')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/+$/, '');
  return `${apiBase}/chat/completions`;
}

function runtimeCapabilitySnapshot(
  value: string | undefined,
): MigrationRuntimeCapabilitySnapshot | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('RETRIEVAL_MIGRATION_RUNTIME_CAPABILITY_SNAPSHOT_JSON must be valid JSON.');
  }
  try {
    return validateMigrationRuntimeCapabilitySnapshot(parsed as MigrationRuntimeCapabilitySnapshot);
  } catch (error) {
    throw new Error(
      `RETRIEVAL_MIGRATION_RUNTIME_CAPABILITY_SNAPSHOT_JSON is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const dimension = positiveInteger(
    env.SEEKDB_VECTOR_DIMENSION,
    384,
    'SEEKDB_VECTOR_DIMENSION',
  );
  const provider = env.SEEKDB_EMBEDDING_PROVIDER?.trim().toLowerCase() || 'hash';
  if (provider !== 'hash' && provider !== 'openai') {
    throw new Error('SEEKDB_EMBEDDING_PROVIDER must be "hash" or "openai".');
  }

  const embedding: RetrievalConfig['embedding'] =
    provider === 'openai'
      ? {
          provider: 'openai',
          dimension,
          url: env.SEEKDB_EMBEDDING_URL?.trim() || 'https://api.openai.com/v1/embeddings',
          apiKey: env.SEEKDB_EMBEDDING_API_KEY?.trim() || '',
          model: env.SEEKDB_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
          supportsDimensions: boolean(
            env.SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS,
            true,
          ),
        }
      : { provider: 'hash', dimension };

  if (embedding.provider === 'openai' && !embedding.apiKey) {
    throw new Error('SEEKDB_EMBEDDING_API_KEY is required for the openai provider.');
  }

  const rerankProvider = env.RERANK_PROVIDER?.trim().toLowerCase() || 'none';
  if (!['none', 'deepseek'].includes(rerankProvider)) {
    throw new Error('RERANK_PROVIDER must be "none" or "deepseek".');
  }

  const reranking: RerankingConfig =
    rerankProvider === 'deepseek'
      ? {
          provider: 'deepseek',
          url: deepSeekChatCompletionsUrl(env),
          // RERANK_OPENAI_API_KEY is a temporary migration fallback for the
          // existing local .env; new deployments use DEEPSEEK_API_KEY.
          apiKey: env.DEEPSEEK_API_KEY?.trim() || env.RERANK_OPENAI_API_KEY?.trim() || '',
          model: env.DEEPSEEK_MODEL?.trim() || env.RERANK_OPENAI_MODEL?.trim() || 'deepseek-v4-flash',
          timeoutMs: positiveInteger(env.RERANK_TIMEOUT_MS, 90_000, 'RERANK_TIMEOUT_MS'),
          maxRetries: nonNegativeInteger(env.RERANK_MAX_RETRIES, 2, 'RERANK_MAX_RETRIES'),
          validationRetries: nonNegativeInteger(
            env.RERANK_VALIDATION_RETRIES,
            2,
            'RERANK_VALIDATION_RETRIES',
          ),
        }
      : { provider: 'none' };

  if (reranking.provider === 'deepseek' && !reranking.apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for the DeepSeek rerank provider.');
  }

  const symbolTable = identifier(env.SEEKDB_TABLE, 'code_symbols', 'SEEKDB_TABLE');
  const moduleKnowledgeTable = identifier(
    env.SEEKDB_MODULE_KNOWLEDGE_TABLE,
    'module_knowledge',
    'SEEKDB_MODULE_KNOWLEDGE_TABLE',
  );
  if (moduleKnowledgeTable === symbolTable) {
    throw new Error('SEEKDB_MODULE_KNOWLEDGE_TABLE must differ from SEEKDB_TABLE.');
  }
  if (moduleKnowledgeTable.length > 52) {
    throw new Error(
      'SEEKDB_MODULE_KNOWLEDGE_TABLE must be at most 52 characters so lifecycle table names remain valid.',
    );
  }
  const configuredRuntimeCapabilities = runtimeCapabilitySnapshot(
    env.RETRIEVAL_MIGRATION_RUNTIME_CAPABILITY_SNAPSHOT_JSON,
  );

  return {
    host: env.RETRIEVAL_HOST?.trim() || '127.0.0.1',
    port: positiveInteger(env.RETRIEVAL_PORT, 8787, 'RETRIEVAL_PORT'),
    corsOrigin: env.RETRIEVAL_CORS_ORIGIN?.trim() || '*',
    allowedRepositories: allowedRepositories(env.RETRIEVAL_ALLOWED_REPOSITORIES),
    moduleIndexToken: env.RETRIEVAL_MODULE_INDEX_TOKEN?.trim() || '',
    moduleIndexMaxBodyBytes: positiveInteger(
      env.RETRIEVAL_MODULE_INDEX_MAX_BODY_BYTES,
      16 * 1024 * 1024,
      'RETRIEVAL_MODULE_INDEX_MAX_BODY_BYTES',
    ),
    implementationIndexToken: env.RETRIEVAL_IMPLEMENTATION_INDEX_TOKEN?.trim() || '',
    implementationIndexMaxBodyBytes: positiveInteger(
      env.RETRIEVAL_IMPLEMENTATION_INDEX_MAX_BODY_BYTES,
      32 * 1024 * 1024,
      'RETRIEVAL_IMPLEMENTATION_INDEX_MAX_BODY_BYTES',
    ),
    ...(configuredRuntimeCapabilities
      ? {
          migrationRuntimeCapabilitySnapshot: configuredRuntimeCapabilities,
        }
      : {}),
    autoMigrate: boolean(env.SEEKDB_AUTO_MIGRATE, true),
    seekdb: {
      host: env.SEEKDB_HOST?.trim() || '127.0.0.1',
      port: positiveInteger(env.SEEKDB_PORT, 2881, 'SEEKDB_PORT'),
      user: env.SEEKDB_USER?.trim() || 'root',
      password: env.SEEKDB_PASSWORD || '',
      database: identifier(env.SEEKDB_DATABASE, 'forexplore', 'SEEKDB_DATABASE'),
      table: symbolTable,
      moduleKnowledgeTable,
      vectorDimension: dimension,
    },
    embedding,
    reranking,
  };
}
