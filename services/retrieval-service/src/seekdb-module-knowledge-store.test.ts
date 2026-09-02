import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import {
  repositoryKnowledgePublicationSchemaVersion,
  type IndexedModuleKnowledgeDocument,
  type RepositoryKnowledgePublication,
} from '@forexplore/contracts';
import {
  canonicalJson,
  materializeRepositoryModuleIndexReceipt,
  sha256Hex,
} from '@forexplore/workflow-core';
import { loadConfig } from './config.js';
import {
  createModuleKnowledgeIndexerMetadata,
  moduleKnowledgeSearchInternals,
} from './module-knowledge-search.js';
import {
  SeekDbModuleKnowledgeStore,
  seekDbModuleKnowledgeInternals,
} from './seekdb-module-knowledge-store.js';
import { SeekDbStore } from './seekdb-store.js';

function fakePool() {
  const query = vi.fn(async () => [[], []] as unknown);
  const end = vi.fn(async () => undefined);
  return {
    pool: { query, end } as unknown as Pool,
    query,
    end,
  };
}

function publicationFixture(): RepositoryKnowledgePublication {
  const immutable = {
    scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
    repositoryScopes: ['acme/orders'],
    generation: 1,
    source: {
      repositoryModuleBundleId: 'bundle-1',
      repositoryModuleBundleHash: 'd'.repeat(64),
      modules: [{
        moduleId: 'orders',
        evidenceBundleId: 'evidence-bundle-1',
        evidenceBundleHash: 'e'.repeat(64),
        wikiProposalId: 'wiki-proposal-1',
        wikiProposalHash: 'f'.repeat(64),
        knowledgeReviewId: 'knowledge-review-1',
        knowledgeReviewHash: '1'.repeat(64),
        knowledgePageId: 'wiki:orders',
        knowledgePageHash: 'a'.repeat(64),
      }],
    },
    artifacts: [],
  };
  const payloadHash = sha256Hex(canonicalJson(immutable));
  const payload = {
    schemaVersion: repositoryKnowledgePublicationSchemaVersion,
    id: `repository-knowledge-publication:${payloadHash.slice(0, 24)}`,
    ...immutable,
    status: 'staged' as const,
    payloadHash,
    stagedAt: '2026-09-01T00:00:00.000Z',
    producer: { kind: 'knowledge-publisher' as const, id: 'test-publisher', version: '1' },
  };
  return { ...payload, contentHash: sha256Hex(canonicalJson(payload)) };
}

describe('SeekDB module knowledge storage', () => {
  it('creates a physically separate projection and preserves symbol clear semantics', async () => {
    const config = loadConfig({
      SEEKDB_VECTOR_DIMENSION: '2',
      SEEKDB_TABLE: 'code_symbols',
      SEEKDB_MODULE_KNOWLEDGE_TABLE: 'module_knowledge',
    });
    const symbolsPool = fakePool();
    const modulesPool = fakePool();
    const symbols = new SeekDbStore(config.seekdb, symbolsPool.pool);
    const modules = new SeekDbModuleKnowledgeStore(config.seekdb, modulesPool.pool);

    await Promise.all([symbols.initialize(), modules.initialize()]);
    await symbols.clear();

    const symbolSql = symbolsPool.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    const moduleSql = modulesPool.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(symbolSql).toContain('`forexplore`.`code_symbols`');
    expect(moduleSql).toContain('`forexplore`.`module_knowledge`');
    expect(moduleSql).toContain('`forexplore`.`module_knowledge_generations`');
    expect(moduleSql).toContain('`forexplore`.`module_knowledge_heads`');
    expect(moduleSql).not.toContain('`forexplore`.`code_symbols`');
    expect('clear' in modules).toBe(false);
    expect(symbolSql).toContain('DELETE FROM `forexplore`.`code_symbols`');
  });

  it('persists explainable projection and embedding lineage in the receipt store identity', () => {
    const indexer = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'openai-compatible',
      embeddingModel: 'embedding-model-v2',
      embeddingDimension: 768,
      configuration: { url: 'https://embedding.example.test/v1/embeddings' },
    });
    const storeId = seekDbModuleKnowledgeInternals.indexerStoreId(
      'seekdb:forexplore.module_knowledge',
      indexer,
    );

    expect(storeId).toContain('projection=module-knowledge-search-projection%2F1');
    expect(storeId).toContain('provider=openai-compatible');
    expect(storeId).toContain('model=embedding-model-v2');
    expect(storeId).toContain('dimension=768');
    expect(seekDbModuleKnowledgeInternals.parseIndexerStoreId(
      storeId,
      'seekdb:forexplore.module_knowledge',
      768,
    )).toEqual(indexer);
  });

  it('fails active-head reads closed when runtime embedding lineage changed', async () => {
    const publication = publicationFixture();
    const indexedWith = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'hash',
      embeddingModel: 'forexplore-fnv1a-trigram-v1',
      embeddingDimension: 2,
      configuration: { normalization: 'l2' },
    });
    const currentRuntime = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'hash',
      embeddingModel: 'forexplore-fnv1a-trigram-v1',
      embeddingDimension: 2,
      configuration: { normalization: 'none' },
    });
    const receipt = materializeRepositoryModuleIndexReceipt({
      publication,
      status: 'validated',
      storeId: seekDbModuleKnowledgeInternals.indexerStoreId(
        'seekdb:forexplore.module_knowledge',
        indexedWith,
      ),
      documentCount: 1,
      moduleIds: ['orders'],
      indexArtifactHash: 'b'.repeat(64),
      createdAt: '2026-09-01T00:01:00.000Z',
    });
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('_heads')) {
        return [[{
          active_publication_id: publication.id,
          active_publication_payload_hash: publication.payloadHash,
          active_generation_id: 1,
          revision: 1,
        }], []];
      }
      if (sql.includes('_generations')) {
        return [[{ receipt_json: receipt }], []];
      }
      return [[], []];
    });
    const pool = {
      query,
      end: vi.fn(async () => undefined),
    } as unknown as Pool;
    const modules = new SeekDbModuleKnowledgeStore(
      loadConfig({ SEEKDB_VECTOR_DIMENSION: '2' }).seekdb,
      pool,
      currentRuntime,
    );

    await expect(modules.activeHead('acme/orders', 'branch:main'))
      .rejects.toThrow('another projection or embedding configuration');
  });

  it('excludes inactive generations in SQL instead of clearing or post-filtering them', async () => {
    const config = loadConfig({ SEEKDB_VECTOR_DIMENSION: '2' });
    const database = fakePool();
    const modules = new SeekDbModuleKnowledgeStore(config.seekdb, database.pool);

    await modules.semanticSearch([1, 0], {
      query: 'orders',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: ['acme/orders'],
      topK: 5,
      languageIds: ['typescript'],
      capabilities: ['order management'],
    }, 30);

    const [sql, parameters] = database.query.mock.calls.at(-1)!;
    expect(String(sql)).toContain('JOIN `forexplore`.`module_knowledge_heads` h');
    expect(String(sql)).toContain('h.active_publication_id = d.publication_id');
    expect(String(sql)).toContain('h.active_generation_id = d.generation_id');
    expect(String(sql)).toContain("g.lifecycle_state = 'active'");
    expect(String(sql)).toContain("d.boundary_status = 'reviewed'");
    expect(String(sql)).toContain("d.narrative_status = 'reviewed'");
    expect(String(sql)).toContain("d.trust_tier = 'reviewed'");
    expect(String(sql)).toContain("d.verification_status = 'unverified'");
    expect(String(sql)).not.toContain('DELETE FROM');
    expect(parameters).toEqual([
      seekDbModuleKnowledgeInternals.scopeKey('acme/orders', 'branch:main'),
      'acme/orders',
      'branch:main',
      'acme/orders',
      'typescript',
      'order management',
      30,
    ]);
  });

  it('fails closed when an ACL scope is absent', () => {
    expect(() => seekDbModuleKnowledgeInternals.filterSql({
      query: 'orders',
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      repositoryScopes: [],
      topK: 5,
    })).toThrow('must contain at least one repository');
  });

  it('reuses a validated generation when a retry produces different embedding bytes', async () => {
    const publication = publicationFixture();
    const indexer = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'openai-compatible',
      embeddingModel: 'embedding-model-v2',
      embeddingDimension: 2,
      configuration: { url: 'https://embedding.example.test/v1/embeddings' },
    });
    const persistedProjectionHash = '2'.repeat(64);
    const persistedGenerationHash = moduleKnowledgeSearchInternals.generationHash({
      repositoryId: publication.scope.repositoryId,
      channel: publication.scope.channel,
      publicationId: publication.id,
      publicationPayloadHash: publication.payloadHash,
      generation: publication.generation,
    }, [{
      document: {
        id: 'indexed-module-knowledge:orders',
        moduleId: 'orders',
        artifactHash: 'a'.repeat(64),
      } as IndexedModuleKnowledgeDocument,
      embedding: [],
      projectionHash: persistedProjectionHash,
    }], indexer.configurationHash);
    const receipt = materializeRepositoryModuleIndexReceipt({
      publication,
      status: 'validated',
      storeId: seekDbModuleKnowledgeInternals.indexerStoreId(
        'seekdb:forexplore.module_knowledge',
        indexer,
      ),
      documentCount: 1,
      moduleIds: ['orders'],
      indexArtifactHash: persistedGenerationHash,
      createdAt: '2026-09-01T00:01:00.000Z',
    });
    const persistedGeneration = {
      repository_id: publication.scope.repositoryId,
      publication_channel: publication.scope.channel,
      publication_id: publication.id,
      publication_hash: publication.payloadHash,
      generation_id: publication.generation,
      generation_content_hash: persistedGenerationHash,
      document_count: 1,
      module_ids: JSON.stringify(['orders']),
      repository_scopes: JSON.stringify(publication.repositoryScopes),
      lifecycle_state: 'staged',
      receipt_json: receipt,
    };
    const query = vi.fn(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM') && sql.includes('_generations')) {
        return [[persistedGeneration], []];
      }
      if (sql.includes('SELECT document_id')) {
        return [[{
          document_id: 'indexed-module-knowledge:orders',
          module_id: 'orders',
          artifact_hash: 'a'.repeat(64),
          publication_payload_hash: publication.payloadHash,
          projection_hash: persistedProjectionHash,
          repository_id: publication.scope.repositoryId,
          publication_channel: publication.scope.channel,
          publication_id: publication.id,
          generation_id: publication.generation,
          boundary_status: 'reviewed',
          narrative_status: 'reviewed',
          verification_status: 'unverified',
          trust_tier: 'reviewed',
          repository_scopes: JSON.stringify(publication.repositoryScopes),
        }], []];
      }
      return [{ affectedRows: 0 }, []];
    });
    const connection = {
      query,
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
    };
    const pool = {
      query,
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => undefined),
    } as unknown as Pool;
    const modules = new SeekDbModuleKnowledgeStore(
      loadConfig({ SEEKDB_VECTOR_DIMENSION: '2' }).seekdb,
      pool,
      indexer,
    );

    const replayed = await modules.stage({
      repositoryId: publication.scope.repositoryId,
      channel: publication.scope.channel,
      publicationId: publication.id,
      publicationPayloadHash: publication.payloadHash,
      publication,
      generation: publication.generation,
      repositoryScopes: publication.repositoryScopes,
      indexer,
      documents: [{
        document: {
          id: 'indexed-module-knowledge:orders',
          moduleId: 'orders',
        } as IndexedModuleKnowledgeDocument,
        embedding: [0.25, 0.75],
        projectionHash: '3'.repeat(64),
      }],
      generationContentHash: '4'.repeat(64),
    });

    expect(replayed).toEqual(receipt);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
  });

  it('makes activate and manual withdraw retries idempotent for an outbox reconciler', async () => {
    const immutablePublication = {
      scope: { repositoryId: 'acme/orders', channel: 'branch:main' },
      repositoryScopes: ['acme/orders'],
      generation: 1,
      source: {
        repositoryModuleBundleId: 'bundle-1',
        repositoryModuleBundleHash: 'd'.repeat(64),
        modules: [{
          moduleId: 'orders',
          evidenceBundleId: 'evidence-bundle-1',
          evidenceBundleHash: 'e'.repeat(64),
          wikiProposalId: 'wiki-proposal-1',
          wikiProposalHash: 'f'.repeat(64),
          knowledgeReviewId: 'knowledge-review-1',
          knowledgeReviewHash: '1'.repeat(64),
          knowledgePageId: 'wiki:orders',
          knowledgePageHash: 'a'.repeat(64),
        }],
      },
      artifacts: [],
    };
    const payloadHash = sha256Hex(canonicalJson(immutablePublication));
    const publicationPayload = {
      schemaVersion: repositoryKnowledgePublicationSchemaVersion,
      id: `repository-knowledge-publication:${payloadHash.slice(0, 24)}`,
      ...immutablePublication,
      status: 'staged' as const,
      payloadHash,
      stagedAt: '2026-09-01T00:00:00.000Z',
      producer: { kind: 'knowledge-publisher' as const, id: 'test-publisher', version: '1' },
    };
    const publication: RepositoryKnowledgePublication = {
      ...publicationPayload,
      contentHash: sha256Hex(canonicalJson(publicationPayload)),
    };
    const indexer = createModuleKnowledgeIndexerMetadata({
      embeddingProvider: 'hash',
      embeddingModel: 'forexplore-fnv1a-trigram-v1',
      embeddingDimension: 2,
      configuration: { algorithm: 'fnv1a-word-trigram', normalization: 'l2' },
    });
    const projectionHash = '2'.repeat(64);
    const generationContentHash = moduleKnowledgeSearchInternals.generationHash({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publicationId: publication.id,
      publicationPayloadHash: publication.payloadHash,
      generation: 1,
    }, [{
      document: {
        id: 'indexed-module-knowledge:orders',
        moduleId: 'orders',
        artifactHash: 'a'.repeat(64),
      } as IndexedModuleKnowledgeDocument,
      embedding: [],
        projectionHash,
    }], indexer.configurationHash);
    const receipt = materializeRepositoryModuleIndexReceipt({
      publication,
      status: 'validated',
      storeId: seekDbModuleKnowledgeInternals.indexerStoreId(
        'seekdb:forexplore.module_knowledge',
        indexer,
      ),
      documentCount: 1,
      moduleIds: ['orders'],
      indexArtifactHash: generationContentHash,
      createdAt: '2026-09-01T00:01:00.000Z',
    });
    const generation = {
      generation_key: seekDbModuleKnowledgeInternals.generationKey({
        repositoryId: 'acme/orders',
        channel: 'branch:main',
        publicationId: publication.id,
        generation: 1,
      }),
      repository_id: 'acme/orders',
      publication_channel: 'branch:main',
      publication_id: publication.id,
      generation_id: 1,
      publication_hash: publication.payloadHash,
      generation_content_hash: generationContentHash,
      document_count: 1,
      module_ids: JSON.stringify(['orders']),
      repository_scopes: JSON.stringify(['acme/orders']),
      lifecycle_state: 'staged',
      supersedes_publication_id: null,
      supersedes_generation_id: null,
      withdrawal_kind: null,
      withdrawn_to_publication_id: null,
      withdrawn_to_generation_id: null,
      receipt_json: receipt,
    };
    const validationRows = [{
      document_id: 'indexed-module-knowledge:orders',
      module_id: 'orders',
      artifact_hash: 'a'.repeat(64),
      publication_payload_hash: publication.payloadHash,
      projection_hash: projectionHash,
      repository_id: publication.scope.repositoryId,
      publication_channel: publication.scope.channel,
      publication_id: publication.id,
      generation_id: publication.generation,
      boundary_status: 'reviewed',
      narrative_status: 'reviewed',
      verification_status: 'unverified',
      trust_tier: 'reviewed',
      repository_scopes: JSON.stringify(publication.repositoryScopes),
    }];
    let head: {
      active_publication_id: string | null;
      active_publication_payload_hash: string | null;
      active_generation_id: number | null;
      revision: number;
    } | undefined;
    const query = vi.fn(async (sqlValue: string, parameters: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM') && sql.includes('_generations')) {
        return [[generation], []];
      }
      if (sql.includes('SELECT document_id')) return [validationRows, []];
      if (sql.includes('SELECT active_publication_id')) return [head ? [head] : [], []];
      if (sql.includes("SET lifecycle_state = 'active',") && sql.includes('supersedes_publication_id')) {
        generation.lifecycle_state = 'active';
        generation.supersedes_publication_id = parameters[0] as string | null;
        generation.supersedes_generation_id = parameters[1] as number | null;
        generation.withdrawal_kind = null;
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('INSERT INTO') && sql.includes('_heads')) {
        head = {
          active_publication_id: parameters[3] as string,
          active_publication_payload_hash: parameters[4] as string,
          active_generation_id: parameters[5] as number,
          revision: parameters[6] as number,
        };
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes("withdrawal_kind = 'manual'")) {
        generation.lifecycle_state = 'withdrawn';
        generation.withdrawal_kind = 'manual';
        generation.withdrawn_to_publication_id = parameters[0] as string | null;
        generation.withdrawn_to_generation_id = parameters[1] as number | null;
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('UPDATE') && sql.includes('_heads')) {
        head = {
          active_publication_id: parameters[0] as string | null,
          active_publication_payload_hash: parameters[1] as string | null,
          active_generation_id: parameters[2] as number | null,
          revision: parameters[3] as number,
        };
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 1 }, []];
    });
    const connection = {
      query,
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
    };
    const pool = {
      query,
      getConnection: vi.fn(async () => connection),
      end: vi.fn(async () => undefined),
    } as unknown as Pool;
    const store = new SeekDbModuleKnowledgeStore(
      loadConfig({ SEEKDB_VECTOR_DIMENSION: '2' }).seekdb,
      pool,
    );
    const key = {
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publicationId: publication.id,
      generation: 1,
    };

    const activated = await store.activate({ ...key, expectedActiveGeneration: null });
    const activationRetry = await store.activate({ ...key, expectedActiveGeneration: null });
    const withdrawn = await store.withdraw({ ...key, expectedActiveGeneration: 1 });
    const withdrawalRetry = await store.withdraw({ ...key, expectedActiveGeneration: 1 });

    expect(activated).toEqual({
      ...key,
      publicationPayloadHash: publication.payloadHash,
      revision: 1,
    });
    expect(activationRetry).toEqual(activated);
    expect(withdrawn).toEqual({
      repositoryId: 'acme/orders',
      channel: 'branch:main',
      publicationId: null,
      publicationPayloadHash: null,
      generation: null,
      revision: 2,
    });
    expect(withdrawalRetry).toEqual(withdrawn);
  });
});
