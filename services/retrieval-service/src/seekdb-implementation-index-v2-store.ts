import { createHash } from 'node:crypto';
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type {
  IndexedImplementationDocumentV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';
import {
  validateIndexedImplementationDocumentV2,
  validateSourceImplementationBundleV2,
  type ResolveSourceBundleV2Request,
  type ResolvedSourceBundleV2,
} from '@forexplore/workflow-core';
import type { RetrievalConfig } from './config.js';
import {
  materializeImplementationIndexGenerationV2,
  validateImplementationIndexGenerationV2,
} from './implementation-index-v2.js';
import type {
  EmbeddedImplementationIndexGenerationV2,
  ImplementationIndexActivationRequestV2,
  ImplementationIndexGenerationKeyV2,
  ImplementationIndexGenerationV2,
  ImplementationIndexHeadV2,
  ImplementationIndexStoreV2,
  ImplementationSearchFiltersV2,
  RetrievedImplementationDocumentV2,
} from './implementation-index-v2-types.js';
import { requireRepositoryScopes } from './repository-scope.js';

type SqlExecutor = Pick<Pool | PoolConnection, 'query'>;

interface GenerationRow extends RowDataPacket {
  generation_key: string | Buffer;
  generation_id: string;
  repository_id: string;
  generation_number: number | string;
  generation_content_hash: string;
  document_count: number | string;
  lifecycle_state: 'staged' | 'active' | 'superseded';
  generation_json: string | ImplementationIndexGenerationV2;
}

interface HeadRow extends RowDataPacket {
  generation_id: string | null;
  generation_number: number | string | null;
  generation_content_hash: string | null;
  source_catalog_id: string | null;
  source_catalog_hash: string | null;
  revision: number | string;
}

interface DocumentRow extends RowDataPacket {
  document_json: string | IndexedImplementationDocumentV2;
  repository_id: string;
  generation_id: string;
  generation_number: number | string;
  generation_content_hash: string;
  source_catalog_id: string;
  source_catalog_hash: string;
  semantic_score?: number | string;
  text_score?: number | string;
}

interface BundleRow extends RowDataPacket {
  bundle_json: string | SourceImplementationBundleV2;
}

export class ImplementationIndexV2NotFoundError extends Error {}
export class ImplementationIndexV2ConflictError extends Error {}

function quoteIdentifier(value: string): string {
  return `\`${value}\``;
}

function vectorHex(vector: number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return `X'${buffer.toString('hex')}'`;
}

function keyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function generationKey(repositoryId: string, generationId: string): string {
  return keyHash({ repositoryId, generationId });
}

function parseJson<T>(value: string | T, label: string): T {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
}

function score(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapDocument(row: DocumentRow): RetrievedImplementationDocumentV2 {
  return {
    document: parseJson(row.document_json, 'V2 implementation document'),
    indexGeneration: {
      repositoryId: row.repository_id,
      id: row.generation_id,
      generation: Number(row.generation_number),
      contentHash: row.generation_content_hash,
      sourceCatalogId: row.source_catalog_id,
      sourceCatalogHash: row.source_catalog_hash,
    },
    ...(score(row.semantic_score) === undefined ? {} : { semanticScore: score(row.semantic_score) }),
    ...(score(row.text_score) === undefined ? {} : { textScore: score(row.text_score) }),
  };
}

function filterSql(filters: ImplementationSearchFiltersV2): { sql: string; parameters: string[] } {
  const repositories = requireRepositoryScopes(filters.repositoryScopes, 'V2 implementation ACL scopes');
  if (filters.candidateLanguageIds.length === 0) {
    throw new Error('V2 implementation search requires an exact candidate language.');
  }
  const languages = [...new Set(filters.candidateLanguageIds)];
  if (languages.length !== filters.candidateLanguageIds.length || languages.some((value) => !value.trim())) {
    throw new Error('V2 implementation candidate languages must be non-empty and unique.');
  }
  const scopeChecks = repositories
    .map(() => 'JSON_CONTAINS(d.repository_scopes, JSON_QUOTE(?))')
    .join(' OR ');
  return {
    sql: `WHERE d.repository_id IN (${repositories.map(() => '?').join(', ')})
      AND (${scopeChecks})
      AND d.language_id IN (${languages.map(() => '?').join(', ')})`,
    parameters: [...repositories, ...repositories, ...languages],
  };
}

export class SeekDbImplementationIndexStoreV2 implements ImplementationIndexStoreV2 {
  private readonly pool: Pool;
  private readonly documentsTable: string;
  private readonly generationsTable: string;
  private readonly headsTable: string;
  private readonly bundlesTable: string;
  private readonly database: string;
  private readonly dimension: number;

  constructor(config: RetrievalConfig['seekdb'], pool?: Pool) {
    const names = {
      documents: `${config.table}_v2_documents`,
      generations: `${config.table}_v2_generations`,
      heads: `${config.table}_v2_heads`,
      bundles: `${config.table}_v2_bundles`,
    };
    if (Object.values(names).some((name) => name.length > 64)) {
      throw new Error('SEEKDB_TABLE is too long for independent V2 lifecycle tables.');
    }
    this.database = config.database;
    this.dimension = config.vectorDimension;
    this.documentsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(names.documents)}`;
    this.generationsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(names.generations)}`;
    this.headsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(names.heads)}`;
    this.bundlesTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(names.bundles)}`;
    const options: PoolOptions = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      connectionLimit: 8,
      enableKeepAlive: true,
      decimalNumbers: true,
    };
    this.pool = pool ?? mysql.createPool(options);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async initialize(): Promise<void> {
    await this.pool.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(this.database)}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.generationsTable} (
        generation_key VARBINARY(64) PRIMARY KEY NOT NULL,
        generation_id VARCHAR(512) NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        generation_number BIGINT NOT NULL,
        generation_content_hash CHAR(64) NOT NULL,
        source_catalog_id VARCHAR(512) NOT NULL,
        source_catalog_hash CHAR(64) NOT NULL,
        document_count BIGINT NOT NULL,
        lifecycle_state VARCHAR(32) NOT NULL,
        generation_json JSON NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        UNIQUE KEY uq_v2_generation_id(repository_id, generation_id),
        UNIQUE KEY uq_v2_generation_number(repository_id, generation_number)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.documentsTable} (
        document_key VARBINARY(64) PRIMARY KEY NOT NULL,
        generation_key VARBINARY(64) NOT NULL,
        document_id VARCHAR(512) NOT NULL,
        document_hash CHAR(64) NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        language_id VARCHAR(128) NOT NULL,
        repository_scopes JSON NOT NULL,
        document_json JSON NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.dimension}) NOT NULL,
        UNIQUE KEY uq_v2_generation_document(generation_key, document_id),
        FULLTEXT INDEX idx_v2_implementation_text(search_text) WITH PARSER ik,
        VECTOR INDEX idx_v2_implementation_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.headsTable} (
        repository_id VARCHAR(512) PRIMARY KEY NOT NULL,
        generation_key VARBINARY(64),
        generation_id VARCHAR(512),
        generation_number BIGINT,
        generation_content_hash CHAR(64),
        source_catalog_id VARCHAR(512),
        source_catalog_hash CHAR(64),
        revision BIGINT NOT NULL
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.bundlesTable} (
        bundle_key VARBINARY(64) PRIMARY KEY NOT NULL,
        generation_key VARBINARY(64) NOT NULL,
        bundle_id VARCHAR(512) NOT NULL,
        bundle_hash CHAR(64) NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        bundle_json JSON NOT NULL,
        UNIQUE KEY uq_v2_generation_bundle(generation_key, bundle_id)
      ) ORGANIZATION = HEAP
    `);
  }

  async stage(generation: EmbeddedImplementationIndexGenerationV2): Promise<void> {
    const materialized = materializeImplementationIndexGenerationV2({
      ...generation,
      documents: generation.documents.map(({ document }) => document),
    });
    if (materialized.id !== generation.id || materialized.contentHash !== generation.contentHash) {
      throw new Error('Embedded V2 implementation generation does not match its content address.');
    }
    const connection = await this.pool.getConnection();
    const key = generationKey(generation.repositoryId, generation.id);
    try {
      await connection.beginTransaction();
      await connection.query<ResultSetHeader>(`
        INSERT INTO ${this.generationsTable} (
          generation_key, generation_id, repository_id, generation_number,
          generation_content_hash, source_catalog_id, source_catalog_hash,
          document_count, lifecycle_state, generation_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)
      `, [
        key,
        generation.id,
        generation.repositoryId,
        generation.generation,
        generation.contentHash,
        generation.sourceCatalog.moduleCatalogId,
        generation.sourceCatalog.moduleCatalogHash,
        generation.documents.length,
        JSON.stringify(materialized),
        generation.createdAt,
      ]);
      for (const { document, embedding } of generation.documents) {
        if (embedding.length !== this.dimension) {
          throw new Error(`Embedding for ${document.id} has ${embedding.length} dimensions; expected ${this.dimension}.`);
        }
        await connection.query<ResultSetHeader>(`
          INSERT INTO ${this.documentsTable} (
            document_key, generation_key, document_id, document_hash,
            repository_id, language_id, repository_scopes,
            document_json, search_text, embedding
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${vectorHex(embedding)})
        `, [
          keyHash({ key, documentId: document.id }),
          key,
          document.id,
          document.contentHash,
          generation.repositoryId,
          document.candidate.entity.languageId,
          JSON.stringify(generation.repositoryScopes),
          JSON.stringify(document),
          document.searchText,
        ]);
      }
      for (const bundle of generation.sourceBundles) {
        await connection.query<ResultSetHeader>(`
          INSERT INTO ${this.bundlesTable} (
            bundle_key, generation_key, bundle_id, bundle_hash,
            repository_id, bundle_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          keyHash({ key, bundleId: bundle.id }),
          key,
          bundle.id,
          bundle.contentHash,
          generation.repositoryId,
          JSON.stringify(bundle),
        ]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async generation(
    executor: SqlExecutor,
    key: ImplementationIndexGenerationKeyV2,
    forUpdate = false,
  ): Promise<ImplementationIndexGenerationV2> {
    const [rows] = await executor.query<GenerationRow[]>(`
      SELECT generation_key, generation_id, repository_id, generation_number,
             generation_content_hash, document_count, lifecycle_state, generation_json
      FROM ${this.generationsTable}
      WHERE generation_key = ?${forUpdate ? ' FOR UPDATE' : ''}
    `, [generationKey(key.repositoryId, key.generationId)]);
    const row = rows[0];
    if (!row) throw new ImplementationIndexV2NotFoundError('V2 implementation index generation does not exist.');
    if (
      row.repository_id !== key.repositoryId ||
      row.generation_id !== key.generationId ||
      Number(row.generation_number) !== key.generation ||
      row.generation_content_hash !== key.generationContentHash
    ) {
      throw new ImplementationIndexV2ConflictError('V2 implementation index generation lineage is stale.');
    }
    const generation = validateImplementationIndexGenerationV2(
      parseJson(row.generation_json, 'V2 implementation generation'),
    );
    const [counts] = await executor.query<Array<RowDataPacket & { count: number | string }>>(
      `SELECT COUNT(*) AS count FROM ${this.documentsTable} WHERE generation_key = ?`,
      [generationKey(key.repositoryId, key.generationId)],
    );
    if (Number(counts[0]?.count ?? -1) !== generation.documents.length ||
        Number(row.document_count) !== generation.documents.length) {
      throw new ImplementationIndexV2ConflictError('V2 implementation generation document set is incomplete.');
    }
    const [bundleCounts] = await executor.query<Array<RowDataPacket & { count: number | string }>>(
      `SELECT COUNT(*) AS count FROM ${this.bundlesTable} WHERE generation_key = ?`,
      [generationKey(key.repositoryId, key.generationId)],
    );
    if (Number(bundleCounts[0]?.count ?? -1) !== generation.sourceBundles.length) {
      throw new ImplementationIndexV2ConflictError('V2 implementation generation source bundles are incomplete.');
    }
    return generation;
  }

  validate(key: ImplementationIndexGenerationKeyV2): Promise<ImplementationIndexGenerationV2> {
    return this.generation(this.pool, key);
  }

  async activate(request: ImplementationIndexActivationRequestV2): Promise<ImplementationIndexHeadV2> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const generation = await this.generation(connection, request, true);
      const [heads] = await connection.query<HeadRow[]>(`
        SELECT generation_id, generation_number, generation_content_hash,
               source_catalog_id, source_catalog_hash, revision
        FROM ${this.headsTable} WHERE repository_id = ? FOR UPDATE
      `, [request.repositoryId]);
      const current = heads[0];
      const currentId = current?.generation_id ?? null;
      if (currentId !== request.expectedActiveGenerationId) {
        throw new ImplementationIndexV2ConflictError('V2 implementation index head changed before activation.');
      }
      if (currentId) {
        await connection.query<ResultSetHeader>(
          `UPDATE ${this.generationsTable} SET lifecycle_state = 'superseded'
           WHERE repository_id = ? AND generation_id = ? AND lifecycle_state = 'active'`,
          [request.repositoryId, currentId],
        );
      }
      const [activated] = await connection.query<ResultSetHeader>(
        `UPDATE ${this.generationsTable} SET lifecycle_state = 'active'
         WHERE repository_id = ? AND generation_id = ? AND lifecycle_state = 'staged'`,
        [request.repositoryId, request.generationId],
      );
      if (activated.affectedRows !== 1) {
        throw new ImplementationIndexV2ConflictError(
          'V2 implementation generation is no longer staged for activation.',
        );
      }
      const revision = Number(current?.revision ?? 0) + 1;
      await connection.query<ResultSetHeader>(`
        INSERT INTO ${this.headsTable} (
          repository_id, generation_key, generation_id, generation_number,
          generation_content_hash, source_catalog_id, source_catalog_hash, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          generation_key = VALUES(generation_key),
          generation_id = VALUES(generation_id),
          generation_number = VALUES(generation_number),
          generation_content_hash = VALUES(generation_content_hash),
          source_catalog_id = VALUES(source_catalog_id),
          source_catalog_hash = VALUES(source_catalog_hash),
          revision = VALUES(revision)
      `, [
        request.repositoryId,
        generationKey(request.repositoryId, request.generationId),
        request.generationId,
        request.generation,
        request.generationContentHash,
        generation.sourceCatalog.moduleCatalogId,
        generation.sourceCatalog.moduleCatalogHash,
        revision,
      ]);
      await connection.commit();
      return {
        repositoryId: request.repositoryId,
        generationId: request.generationId,
        generation: request.generation,
        generationContentHash: request.generationContentHash,
        sourceCatalogId: generation.sourceCatalog.moduleCatalogId,
        sourceCatalogHash: generation.sourceCatalog.moduleCatalogHash,
        revision,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async activeHead(repositoryId: string): Promise<ImplementationIndexHeadV2 | null> {
    const [rows] = await this.pool.query<HeadRow[]>(`
      SELECT generation_id, generation_number, generation_content_hash,
             source_catalog_id, source_catalog_hash, revision
      FROM ${this.headsTable} WHERE repository_id = ?
    `, [repositoryId]);
    const row = rows[0];
    if (!row) return null;
    return {
      repositoryId,
      generationId: row.generation_id,
      generation: row.generation_number === null ? null : Number(row.generation_number),
      generationContentHash: row.generation_content_hash,
      sourceCatalogId: row.source_catalog_id,
      sourceCatalogHash: row.source_catalog_hash,
      revision: Number(row.revision),
    };
  }

  async resolveSourceBundle(
    request: ResolveSourceBundleV2Request,
  ): Promise<ResolvedSourceBundleV2> {
    const generation = request.candidate.indexGeneration;
    const head = await this.activeHead(generation.repositoryId);
    if (
      !head ||
      head.generationId !== generation.id ||
      head.generation !== generation.generation ||
      head.generationContentHash !== generation.contentHash ||
      head.sourceCatalogId !== generation.sourceCatalogId ||
      head.sourceCatalogHash !== generation.sourceCatalogHash
    ) {
      throw new ImplementationIndexV2ConflictError(
        'Selected source bundle belongs to a stale implementation index generation.',
      );
    }
    await this.validate({
      repositoryId: generation.repositoryId,
      generationId: generation.id,
      generation: generation.generation,
      generationContentHash: generation.contentHash,
    });
    const key = generationKey(generation.repositoryId, generation.id);
    const [documentRows] = await this.pool.query<DocumentRow[]>(`
      SELECT d.document_json, d.repository_id,
             h.generation_id, h.generation_number, h.generation_content_hash,
             h.source_catalog_id, h.source_catalog_hash
      FROM ${this.documentsTable} d
      INNER JOIN ${this.headsTable} h ON h.generation_key = d.generation_key
      WHERE d.generation_key = ? AND d.document_id = ? AND d.document_hash = ?
    `, [key, request.candidate.indexedDocumentId, request.candidate.indexedDocumentHash]);
    const documentRow = documentRows[0];
    if (!documentRow) {
      throw new ImplementationIndexV2NotFoundError('Selected V2 indexed implementation document was not found.');
    }
    const indexedDocument = validateIndexedImplementationDocumentV2(
      parseJson(documentRow.document_json, 'V2 implementation document'),
    );
    const [bundleRows] = await this.pool.query<BundleRow[]>(`
      SELECT bundle_json FROM ${this.bundlesTable}
      WHERE generation_key = ? AND bundle_id = ? AND bundle_hash = ?
    `, [key, request.candidate.sourceBundle.id, request.candidate.sourceBundle.contentHash]);
    const bundleRow = bundleRows[0];
    if (!bundleRow) {
      throw new ImplementationIndexV2NotFoundError('Selected V2 source bundle was not found.');
    }
    const bundle = validateSourceImplementationBundleV2(
      parseJson(bundleRow.bundle_json, 'V2 source bundle'),
    );
    return { indexedDocument, bundle };
  }

  async semanticSearch(
    embedding: number[],
    filters: ImplementationSearchFiltersV2,
    limit: number,
  ): Promise<RetrievedImplementationDocumentV2[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(`V2 query embedding has ${embedding.length} dimensions; expected ${this.dimension}.`);
    }
    const where = filterSql(filters);
    const vector = vectorHex(embedding);
    const [rows] = await this.pool.query<DocumentRow[]>(`
      SELECT d.document_json, d.repository_id,
             h.generation_id, h.generation_number, h.generation_content_hash,
             h.source_catalog_id, h.source_catalog_hash,
             GREATEST(0, 1 - cosine_distance(d.embedding, ${vector})) AS semantic_score
      FROM ${this.documentsTable} d
      INNER JOIN ${this.headsTable} h ON h.generation_key = d.generation_key
      ${where.sql}
      ORDER BY cosine_distance(d.embedding, ${vector}) APPROXIMATE
      LIMIT ?
    `, [...where.parameters, limit]);
    return rows.map(mapDocument);
  }

  async textSearch(
    query: string,
    filters: ImplementationSearchFiltersV2,
    limit: number,
  ): Promise<RetrievedImplementationDocumentV2[]> {
    const where = filterSql(filters);
    const match = 'MATCH(d.search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const [rows] = await this.pool.query<DocumentRow[]>(`
      SELECT d.document_json, d.repository_id,
             h.generation_id, h.generation_number, h.generation_content_hash,
             h.source_catalog_id, h.source_catalog_hash,
             ${match} AS text_score
      FROM ${this.documentsTable} d
      INNER JOIN ${this.headsTable} h ON h.generation_key = d.generation_key
      ${where.sql} AND ${match}
      ORDER BY text_score DESC LIMIT ?
    `, [query, ...where.parameters, query, limit]);
    const max = Math.max(...rows.map((row) => Number(row.text_score) || 0), 1);
    return rows.map((row) => mapDocument({
      ...row,
      text_score: Math.min(1, (Number(row.text_score) || 0) / max),
    } as DocumentRow));
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export const seekDbImplementationIndexV2Internals = { filterSql, generationKey, vectorHex };
