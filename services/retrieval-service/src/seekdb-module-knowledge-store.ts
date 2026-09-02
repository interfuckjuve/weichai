import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { IndexedModuleKnowledgeDocument, LanguageId } from '@forexplore/contracts';
import {
  materializeRepositoryModuleIndexReceipt,
  validateRepositoryModuleIndexReceipt,
} from '@forexplore/workflow-core';
import type { RetrievalConfig } from './config.js';
import {
  moduleKnowledgeProjectionVersion,
  moduleKnowledgeSearchInternals,
} from './module-knowledge-search.js';
import type {
  EmbeddedModuleKnowledgeGeneration,
  ModuleKnowledgeActivationRequest,
  ModuleKnowledgeGenerationState,
  ModuleKnowledgeHead,
  ModuleKnowledgeIndexReceipt,
  ModuleKnowledgeIndexerMetadata,
  ModuleKnowledgePublicationKey,
  ModuleKnowledgeQuery,
  ModuleKnowledgeSearchStore,
  ModuleKnowledgeTombstoneRequest,
  ModuleKnowledgeWithdrawRequest,
  RetrievedModuleKnowledgeDocument,
} from './module-knowledge-types.js';
import { requireRepositoryScopes } from './repository-scope.js';
import { expandedSearchText } from './text-analysis.js';

type SqlExecutor = Pick<Pool | PoolConnection, 'query'>;

interface ModuleGenerationRow extends RowDataPacket {
  generation_key: string | Buffer;
  repository_id: string;
  publication_channel: string;
  publication_id: string;
  generation_id: number | string;
  publication_hash: string;
  generation_content_hash: string;
  document_count: number | string;
  module_ids: string | string[];
  repository_scopes: string | string[];
  lifecycle_state: ModuleKnowledgeGenerationState;
  supersedes_publication_id: string | null;
  supersedes_generation_id: number | string | null;
  withdrawal_kind: 'superseded' | 'manual' | null;
  withdrawn_to_publication_id: string | null;
  withdrawn_to_generation_id: number | string | null;
  receipt_json: string | ModuleKnowledgeIndexReceipt | null;
}

interface ValidationDocumentRow extends RowDataPacket {
  document_id: string | Buffer;
  module_id: string;
  artifact_hash: string;
  publication_payload_hash: string;
  projection_hash: string;
  repository_id: string;
  publication_channel: string;
  publication_id: string;
  generation_id: number | string;
  boundary_status: IndexedModuleKnowledgeDocument['boundaryStatus'];
  narrative_status: IndexedModuleKnowledgeDocument['narrativeStatus'];
  verification_status: IndexedModuleKnowledgeDocument['verificationStatus'];
  trust_tier: IndexedModuleKnowledgeDocument['trustTier'];
  repository_scopes: string | string[];
}

interface ModuleHeadRow extends RowDataPacket {
  active_publication_id: string | null;
  active_publication_payload_hash: string | null;
  active_generation_id: number | string | null;
  revision: number | string;
}

interface ModuleDocumentRow extends RowDataPacket {
  schema_version: string;
  document_id: string | Buffer;
  artifact_id: string;
  artifact_hash: string;
  repository_id: string;
  publication_channel: string;
  publication_id: string;
  generation_id: number | string;
  module_id: string;
  module_catalog_id: string;
  title: string;
  summary: string;
  language_ids: string | LanguageId[];
  capabilities: string | string[];
  domain_terms: string | string[];
  public_api_signatures: string | string[];
  dependency_module_ids: string | string[];
  tags: string | string[];
  risks: string | string[];
  trust_tier: IndexedModuleKnowledgeDocument['trustTier'];
  boundary_status: IndexedModuleKnowledgeDocument['boundaryStatus'];
  narrative_status: IndexedModuleKnowledgeDocument['narrativeStatus'];
  verification_status: IndexedModuleKnowledgeDocument['verificationStatus'];
  repository_scopes: string | string[];
  searchable_content: string;
  semantic_score?: number | string;
  text_score?: number | string;
}

function quoteIdentifier(value: string): string {
  return `\`${value}\``;
}

function vectorHex(vector: number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return `X'${buffer.toString('hex')}'`;
}

function valueString(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function parseStringArray(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed: unknown = JSON.parse(value as string);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseReceipt(
  value: string | ModuleKnowledgeIndexReceipt | null,
): ModuleKnowledgeIndexReceipt {
  if (value === null) throw new Error('Module knowledge generation has no validation receipt.');
  if (typeof value === 'object') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as ModuleKnowledgeIndexReceipt;
  } catch {
    throw new Error('Module knowledge generation contains an invalid validation receipt.');
  }
}

function indexerStoreId(
  baseStoreId: string,
  metadata: ModuleKnowledgeIndexerMetadata,
): string {
  const parameters = new URLSearchParams({
    projection: metadata.projectionVersion,
    provider: metadata.embeddingProvider,
    model: metadata.embeddingModel,
    dimension: String(metadata.embeddingDimension),
    configurationHash: metadata.configurationHash,
  });
  return `${baseStoreId}#${parameters.toString()}`;
}

function parseIndexerStoreId(
  value: string,
  expectedBaseStoreId: string,
  expectedDimension: number,
): ModuleKnowledgeIndexerMetadata {
  const separator = value.indexOf('#');
  if (separator < 1 || value.slice(0, separator) !== expectedBaseStoreId) {
    throw new Error('Module knowledge receipt identifies another physical store.');
  }
  const parameters = new URLSearchParams(value.slice(separator + 1));
  const dimension = Number(parameters.get('dimension'));
  const metadata = {
    projectionVersion: parameters.get('projection') ?? '',
    embeddingProvider: parameters.get('provider') ?? '',
    embeddingModel: parameters.get('model') ?? '',
    embeddingDimension: dimension,
    configurationHash: parameters.get('configurationHash') ?? '',
  };
  if (
    metadata.projectionVersion !== moduleKnowledgeProjectionVersion ||
    !metadata.embeddingProvider ||
    !metadata.embeddingModel ||
    !Number.isSafeInteger(dimension) || dimension !== expectedDimension ||
    !/^[a-f0-9]{64}$/.test(metadata.configurationHash)
  ) {
    throw new Error('Module knowledge receipt has invalid indexer lineage metadata.');
  }
  return metadata;
}

function numberValue(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scopeKey(repositoryId: string, channel: string): string {
  return moduleKnowledgeSearchInternals.sha256({ repositoryId, channel });
}

function generationKey(key: ModuleKnowledgePublicationKey): string {
  return moduleKnowledgeSearchInternals.sha256({
    repositoryId: key.repositoryId,
    channel: key.channel,
    publicationId: key.publicationId,
    generation: key.generation,
  });
}

function documentKey(key: ModuleKnowledgePublicationKey, documentId: string): string {
  return moduleKnowledgeSearchInternals.sha256({
    repositoryId: key.repositoryId,
    channel: key.channel,
    publicationId: key.publicationId,
    generation: key.generation,
    documentId,
  });
}

function mapDocumentRow(row: ModuleDocumentRow): RetrievedModuleKnowledgeDocument {
  return {
    schemaVersion: row.schema_version as IndexedModuleKnowledgeDocument['schemaVersion'],
    id: valueString(row.document_id),
    documentKind: 'functional-module',
    artifactId: row.artifact_id,
    artifactHash: row.artifact_hash,
    repositoryId: row.repository_id,
    channel: row.publication_channel,
    publicationId: row.publication_id,
    publicationPayloadHash: row.publication_payload_hash,
    publicationGeneration: Number(row.generation_id),
    moduleId: row.module_id,
    moduleCatalogId: row.module_catalog_id,
    title: row.title,
    summary: row.summary,
    languageIds: parseStringArray(row.language_ids) as LanguageId[],
    capabilities: parseStringArray(row.capabilities),
    domainTerms: parseStringArray(row.domain_terms),
    publicApiSignatures: parseStringArray(row.public_api_signatures),
    dependencyModuleIds: parseStringArray(row.dependency_module_ids),
    tags: parseStringArray(row.tags),
    risks: parseStringArray(row.risks),
    trustTier: row.trust_tier,
    boundaryStatus: row.boundary_status,
    narrativeStatus: row.narrative_status,
    verificationStatus: row.verification_status,
    repositoryScopes: parseStringArray(row.repository_scopes),
    searchableContent: row.searchable_content,
    semanticScore: numberValue(row.semantic_score),
    textScore: numberValue(row.text_score),
  };
}

interface ModuleFilterSql {
  sql: string;
  parameters: string[];
}

function filterSql(query: ModuleKnowledgeQuery): ModuleFilterSql {
  const repositoryScopes = requireRepositoryScopes(
    query.repositoryScopes,
    'Module search ACL scopes',
  );
  const clauses = [
    'h.scope_key = ?',
    'd.repository_id = ?',
    'd.publication_channel = ?',
    'g.lifecycle_state = \'active\'',
    'd.boundary_status = \'reviewed\'',
    'd.narrative_status = \'reviewed\'',
    'd.trust_tier = \'reviewed\'',
    'd.verification_status = \'unverified\'',
  ];
  const parameters = [
    scopeKey(query.repositoryId, query.channel),
    query.repositoryId,
    query.channel,
  ];
  clauses.push(
    `(${repositoryScopes.map(() => 'JSON_CONTAINS(d.repository_scopes, JSON_QUOTE(?))').join(' OR ')})`,
  );
  parameters.push(...repositoryScopes);
  if ((query.languageIds?.length ?? 0) > 0) {
    clauses.push(
      `(${query.languageIds!.map(() => 'JSON_CONTAINS(d.language_ids, JSON_QUOTE(?))').join(' OR ')})`,
    );
    parameters.push(...query.languageIds!);
  }
  if ((query.capabilities?.length ?? 0) > 0) {
    clauses.push(
      `(${query.capabilities!.map(() => 'JSON_CONTAINS(d.capabilities, JSON_QUOTE(?))').join(' OR ')})`,
    );
    parameters.push(...query.capabilities!);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, parameters };
}

const selectedColumns = `
  d.schema_version, d.document_id, d.artifact_id, d.artifact_hash,
  d.publication_payload_hash,
  d.repository_id, d.publication_channel, d.publication_id, d.generation_id,
  d.module_id, d.module_catalog_id, d.title, d.summary, d.language_ids,
  d.capabilities, d.domain_terms, d.public_api_signatures,
  d.dependency_module_ids, d.tags, d.risks, d.boundary_status,
  d.narrative_status, d.verification_status, d.trust_tier,
  d.repository_scopes, d.searchable_content
`;

export class ModuleKnowledgeCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleKnowledgeCasError';
  }
}

export class SeekDbModuleKnowledgeStore implements ModuleKnowledgeSearchStore {
  private readonly pool: Pool;
  private readonly documentsTable: string;
  private readonly generationsTable: string;
  private readonly headsTable: string;
  private readonly database: string;
  private readonly dimension: number;
  private readonly storeId: string;
  private readonly expectedIndexer?: ModuleKnowledgeIndexerMetadata;

  constructor(
    config: RetrievalConfig['seekdb'],
    pool?: Pool,
    expectedIndexer?: ModuleKnowledgeIndexerMetadata,
  ) {
    this.database = config.database;
    const baseTable = config.moduleKnowledgeTable;
    this.documentsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(baseTable)}`;
    this.generationsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(`${baseTable}_generations`)}`;
    this.headsTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(`${baseTable}_heads`)}`;
    this.dimension = config.vectorDimension;
    this.storeId = `seekdb:${config.database}.${baseTable}`;
    this.expectedIndexer = expectedIndexer;
    if (expectedIndexer && expectedIndexer.embeddingDimension !== this.dimension) {
      throw new Error('Module store and indexer embedding dimensions differ.');
    }
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
        generation_key CHAR(64) PRIMARY KEY NOT NULL,
        scope_key CHAR(64) NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        publication_channel VARCHAR(512) NOT NULL,
        publication_id VARCHAR(512) NOT NULL,
        generation_id BIGINT NOT NULL,
        publication_hash CHAR(64) NOT NULL,
        generation_content_hash CHAR(64) NOT NULL,
        document_count INT NOT NULL,
        module_ids JSON NOT NULL,
        repository_scopes JSON NOT NULL,
        lifecycle_state VARCHAR(16) NOT NULL,
        supersedes_publication_id VARCHAR(512) NULL,
        supersedes_generation_id BIGINT NULL,
        withdrawal_kind VARCHAR(16) NULL,
        withdrawn_to_publication_id VARCHAR(512) NULL,
        withdrawn_to_generation_id BIGINT NULL,
        receipt_json JSON NULL,
        INDEX idx_module_generation_scope(scope_key, lifecycle_state),
        UNIQUE KEY idx_module_generation_number(scope_key, generation_id)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.headsTable} (
        scope_key CHAR(64) PRIMARY KEY NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        publication_channel VARCHAR(512) NOT NULL,
        active_publication_id VARCHAR(512) NULL,
        active_publication_payload_hash CHAR(64) NULL,
        active_generation_id BIGINT NULL,
        revision BIGINT NOT NULL
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.documentsTable} (
        row_key CHAR(64) PRIMARY KEY NOT NULL,
        generation_key CHAR(64) NOT NULL,
        scope_key CHAR(64) NOT NULL,
        schema_version VARCHAR(64) NOT NULL,
        document_id VARBINARY(512) NOT NULL,
        artifact_id VARCHAR(512) NOT NULL,
        artifact_hash CHAR(64) NOT NULL,
        publication_payload_hash CHAR(64) NOT NULL,
        projection_hash CHAR(64) NOT NULL,
        repository_id VARCHAR(512) NOT NULL,
        publication_channel VARCHAR(512) NOT NULL,
        publication_id VARCHAR(512) NOT NULL,
        generation_id BIGINT NOT NULL,
        module_id VARCHAR(512) NOT NULL,
        module_catalog_id VARCHAR(512) NOT NULL,
        title VARCHAR(512) NOT NULL,
        summary TEXT NOT NULL,
        language_ids JSON NOT NULL,
        capabilities JSON NOT NULL,
        domain_terms JSON NOT NULL,
        public_api_signatures JSON NOT NULL,
        dependency_module_ids JSON NOT NULL,
        tags JSON NOT NULL,
        risks JSON NOT NULL,
        trust_tier VARCHAR(16) NOT NULL,
        boundary_status VARCHAR(16) NOT NULL,
        narrative_status VARCHAR(16) NOT NULL,
        verification_status VARCHAR(16) NOT NULL,
        repository_scopes JSON NOT NULL,
        searchable_content LONGTEXT NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.dimension}) NOT NULL,
        INDEX idx_module_documents_generation(generation_key),
        FULLTEXT INDEX idx_module_text(search_text) WITH PARSER ik,
        VECTOR INDEX idx_module_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
  }

  async stage(generation: EmbeddedModuleKnowledgeGeneration): Promise<ModuleKnowledgeIndexReceipt> {
    for (const entry of generation.documents) {
      if (entry.embedding.length !== this.dimension) {
        throw new Error(
          `Embedding for ${entry.document.id} has ${entry.embedding.length} dimensions; expected ${this.dimension}.`,
        );
      }
    }
    const connection = await this.pool.getConnection();
    const key = generationKey(generation);
    try {
      await connection.beginTransaction();
      const [existingRows] = await connection.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable} WHERE generation_key = ? FOR UPDATE`,
        [key],
      );
      const existing = existingRows[0];
      if (existing) {
        const storedScopes = parseStringArray(existing.repository_scopes);
        const identical =
          existing.publication_hash === generation.publicationPayloadHash &&
          Number(existing.document_count) === generation.documents.length &&
          storedScopes.length === generation.repositoryScopes.length &&
          storedScopes.every((scope, index) => scope === generation.repositoryScopes[index]);
        if (!identical) {
          throw new Error(
            `Module knowledge generation ${generation.generation} already exists with different content.`,
          );
        }
        if (existing.lifecycle_state === 'tombstoned') {
          throw new Error(`Module knowledge generation ${generation.generation} is tombstoned.`);
        }
        // The immutable publication payload, not a freshly sampled embedding,
        // is the idempotency boundary. Embedding services are not required to
        // reproduce bit-identical vectors after a response is lost. Revalidate
        // the already-persisted projection (including its recorded indexer
        // identity and generation hash) and return its durable receipt.
        const receipt = await this.validateWith(connection, generation);
        await connection.commit();
        await connection.query('CALL dbms_index_manager.refresh()');
        return receipt;
      }

      const [sameNumberRows] = await connection.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable}
         WHERE scope_key = ? AND generation_id = ? FOR UPDATE`,
        [scopeKey(generation.repositoryId, generation.channel), generation.generation],
      );
      if (sameNumberRows.length > 0) {
        throw new Error(
          `Module knowledge generation number ${generation.generation} is already allocated in this repository channel.`,
        );
      }

      const moduleIds = generation.documents.map(({ document }) => document.moduleId).sort();
      await connection.query<ResultSetHeader>(
        `INSERT INTO ${this.generationsTable} (
          generation_key, scope_key, repository_id, publication_channel,
          publication_id, generation_id, publication_hash, generation_content_hash,
          document_count, module_ids, repository_scopes, lifecycle_state,
          supersedes_publication_id, supersedes_generation_id, withdrawal_kind,
          withdrawn_to_publication_id, withdrawn_to_generation_id, receipt_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, NULL, NULL, NULL, NULL, NULL)`,
        [
          key,
          scopeKey(generation.repositoryId, generation.channel),
          generation.repositoryId,
          generation.channel,
          generation.publicationId,
          generation.generation,
          generation.publicationPayloadHash,
          generation.generationContentHash,
          generation.documents.length,
          JSON.stringify(moduleIds),
          JSON.stringify(generation.repositoryScopes),
        ],
      );

      for (const { document, embedding, projectionHash } of generation.documents) {
        const source = `${document.searchableContent}\n${expandedSearchText(document.searchableContent)}`;
        await connection.query<ResultSetHeader>(
          `INSERT INTO ${this.documentsTable} (
            row_key, generation_key, scope_key, schema_version, document_id,
            artifact_id, artifact_hash, publication_payload_hash, projection_hash, repository_id,
            publication_channel, publication_id, generation_id, module_id,
            module_catalog_id, title, summary, language_ids, capabilities,
            domain_terms, public_api_signatures, dependency_module_ids, tags,
            risks, boundary_status, narrative_status, verification_status,
            trust_tier, repository_scopes, searchable_content,
            search_text, embedding
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ${vectorHex(embedding)})`,
          [
            documentKey(generation, document.id),
            key,
            scopeKey(generation.repositoryId, generation.channel),
            document.schemaVersion,
            document.id,
            document.artifactId,
            document.artifactHash,
            document.publicationPayloadHash,
            projectionHash,
            document.repositoryId,
            generation.channel,
            generation.publicationId,
            generation.generation,
            document.moduleId,
            document.moduleCatalogId,
            document.title,
            document.summary,
            JSON.stringify(document.languageIds),
            JSON.stringify(document.capabilities),
            JSON.stringify(document.domainTerms),
            JSON.stringify(document.publicApiSignatures),
            JSON.stringify(document.dependencyModuleIds),
            JSON.stringify(document.tags),
            JSON.stringify(document.risks),
            document.boundaryStatus,
            document.narrativeStatus,
            document.verificationStatus,
            document.trustTier,
            JSON.stringify(document.repositoryScopes),
            document.searchableContent,
            source,
          ],
        );
      }
      const validated = await this.validatePhysicalWith(connection, generation, generation.indexer);
      const now = new Date().toISOString();
      const receipt = materializeRepositoryModuleIndexReceipt({
        publication: generation.publication,
        status: 'validated',
        storeId: indexerStoreId(this.storeId, generation.indexer),
        documentCount: validated.documentCount,
        moduleIds: validated.moduleIds,
        indexArtifactHash: generation.generationContentHash,
        createdAt: now,
      });
      await connection.query<ResultSetHeader>(
        `UPDATE ${this.generationsTable} SET receipt_json = ? WHERE generation_key = ?`,
        [JSON.stringify(receipt), key],
      );
      await connection.commit();
      await connection.query('CALL dbms_index_manager.refresh()');
      return receipt;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async validate(key: ModuleKnowledgePublicationKey): Promise<ModuleKnowledgeIndexReceipt> {
    const receipt = await this.validateWith(this.pool, key);
    await this.pool.query('CALL dbms_index_manager.refresh()');
    return receipt;
  }

  private async validateWith(
    executor: SqlExecutor,
    key: ModuleKnowledgePublicationKey,
  ): Promise<ModuleKnowledgeIndexReceipt> {
    const validated = await this.validatePhysicalWith(executor, key);
    const receipt = parseReceipt(validated.row.receipt_json);
    validateRepositoryModuleIndexReceipt(receipt);
    this.assertRuntimeIndexer(parseIndexerStoreId(receipt.storeId, this.storeId, this.dimension));
    if (
      receipt.publicationId !== validated.row.publication_id ||
      receipt.publicationPayloadHash !== validated.row.publication_hash ||
      receipt.scope.repositoryId !== validated.row.repository_id ||
      receipt.scope.channel !== validated.row.publication_channel ||
      receipt.generation !== Number(validated.row.generation_id) ||
      receipt.documentCount !== validated.documentCount ||
      receipt.indexArtifactHash !== validated.row.generation_content_hash ||
      receipt.moduleIds.join('\u0000') !== validated.moduleIds.join('\u0000')
    ) {
      throw new Error(`Module knowledge receipt does not match generation ${key.generation}.`);
    }
    return receipt;
  }

  private async validatePhysicalWith(
    executor: SqlExecutor,
    key: ModuleKnowledgePublicationKey,
    stagedIndexer?: ModuleKnowledgeIndexerMetadata,
  ): Promise<{ row: ModuleGenerationRow; documentCount: number; moduleIds: string[] }> {
    const storageKey = generationKey(key);
    const [generationRows] = await executor.query<ModuleGenerationRow[]>(
      `SELECT * FROM ${this.generationsTable} WHERE generation_key = ?`,
      [storageKey],
    );
    const row = generationRows[0];
    if (!row) throw new Error(`Module knowledge generation not found: ${key.generation}.`);
    const [documentRows] = await executor.query<ValidationDocumentRow[]>(
      `SELECT document_id, module_id, artifact_hash, publication_payload_hash, projection_hash,
              repository_id, publication_channel, publication_id, generation_id,
              boundary_status, narrative_status, verification_status, trust_tier,
              repository_scopes
       FROM ${this.documentsTable}
       WHERE generation_key = ?
       ORDER BY document_id`,
      [storageKey],
    );
    if (documentRows.length !== Number(row.document_count)) {
      throw new Error(
        `Module knowledge generation ${row.generation_id} expected ${row.document_count} documents but stored ${documentRows.length}.`,
      );
    }
    const generationScopes = parseStringArray(row.repository_scopes);
    for (const document of documentRows) {
      const documentScopes = parseStringArray(document.repository_scopes);
      if (
        document.repository_id !== row.repository_id ||
        document.publication_channel !== row.publication_channel ||
        document.publication_id !== row.publication_id ||
        Number(document.generation_id) !== Number(row.generation_id) ||
        document.publication_payload_hash !== row.publication_hash ||
        document.boundary_status !== 'reviewed' ||
        document.narrative_status !== 'reviewed' ||
        document.verification_status !== 'unverified' ||
        document.trust_tier !== 'reviewed' ||
        documentScopes.length !== generationScopes.length ||
        documentScopes.some((scope, index) => scope !== generationScopes[index])
      ) {
        throw new Error(`Module knowledge generation ${row.generation_id} failed document envelope validation.`);
      }
    }
    const indexer = stagedIndexer ?? parseIndexerStoreId(
      parseReceipt(row.receipt_json).storeId,
      this.storeId,
      this.dimension,
    );
    const persistedHash = moduleKnowledgeSearchInternals.generationHash({
      repositoryId: row.repository_id,
      channel: row.publication_channel,
      publicationId: row.publication_id,
      publicationPayloadHash: row.publication_hash,
      generation: Number(row.generation_id),
    }, documentRows.map((document) => ({
      document: {
        id: valueString(document.document_id),
        moduleId: document.module_id,
        artifactHash: document.artifact_hash,
      } as IndexedModuleKnowledgeDocument,
      embedding: [],
      projectionHash: document.projection_hash,
    })), indexer.configurationHash);
    if (persistedHash !== row.generation_content_hash) {
      throw new Error(`Module knowledge generation ${row.generation_id} failed content validation.`);
    }
    return {
      row,
      documentCount: Number(row.document_count),
      moduleIds: parseStringArray(row.module_ids),
    };
  }

  async activate(request: ModuleKnowledgeActivationRequest): Promise<ModuleKnowledgeHead> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const receipt = await this.validateWith(connection, request);
      const [targetRows] = await connection.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable} WHERE generation_key = ? FOR UPDATE`,
        [generationKey(request)],
      );
      if (targetRows[0]?.lifecycle_state === 'tombstoned') {
        throw new Error(`Tombstoned module generation cannot be activated: ${request.generation}.`);
      }
      const key = scopeKey(request.repositoryId, request.channel);
      const [heads] = await connection.query<ModuleHeadRow[]>(
        `SELECT active_publication_id, active_publication_payload_hash,
                active_generation_id, revision
         FROM ${this.headsTable} WHERE scope_key = ? FOR UPDATE`,
        [key],
      );
      const head = heads[0];
      const activeGeneration = head?.active_generation_id === null || head?.active_generation_id === undefined
        ? null
        : Number(head.active_generation_id);
      if (
        head &&
        Number(head.active_generation_id) === request.generation &&
        head.active_publication_id === request.publicationId
      ) {
        await connection.commit();
        return this.mapHead(request, head);
      }
      if (activeGeneration !== request.expectedActiveGeneration) {
        throw new ModuleKnowledgeCasError(
          `Module knowledge head changed: expected ${request.expectedActiveGeneration ?? '<empty>'}, found ${activeGeneration ?? '<empty>'}.`,
        );
      }
      if (activeGeneration !== null && request.generation <= activeGeneration) {
        throw new ModuleKnowledgeCasError(
          `Module knowledge activation must advance the active generation: ` +
          `${request.generation} <= ${activeGeneration}.`,
        );
      }

      if (head?.active_generation_id && head.active_publication_id) {
        await connection.query<ResultSetHeader>(
          `UPDATE ${this.generationsTable}
           SET lifecycle_state = 'withdrawn', withdrawal_kind = 'superseded',
               withdrawn_to_publication_id = ?, withdrawn_to_generation_id = ?
           WHERE generation_key = ? AND lifecycle_state = 'active'`,
          [
            request.publicationId,
            request.generation,
            generationKey({
              repositoryId: request.repositoryId,
              channel: request.channel,
              publicationId: head.active_publication_id,
              generation: Number(head.active_generation_id),
            }),
          ],
        );
      }

      await connection.query<ResultSetHeader>(
        `UPDATE ${this.generationsTable}
         SET lifecycle_state = 'active',
             supersedes_publication_id = ?, supersedes_generation_id = ?,
             withdrawal_kind = NULL, withdrawn_to_publication_id = NULL,
             withdrawn_to_generation_id = NULL
         WHERE generation_key = ?`,
        [
          head?.active_publication_id ?? null,
          head?.active_generation_id ?? null,
          generationKey(request),
        ],
      );
      const revision = Number(head?.revision ?? 0) + 1;
      await connection.query<ResultSetHeader>(
        `INSERT INTO ${this.headsTable} (
          scope_key, repository_id, publication_channel,
          active_publication_id, active_publication_payload_hash,
          active_generation_id, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          active_publication_id = VALUES(active_publication_id),
          active_publication_payload_hash = VALUES(active_publication_payload_hash),
          active_generation_id = VALUES(active_generation_id),
          revision = VALUES(revision)`,
        [
          key,
          request.repositoryId,
          request.channel,
          request.publicationId,
          receipt.publicationPayloadHash,
          request.generation,
          revision,
        ],
      );
      await connection.commit();
      return {
        repositoryId: request.repositoryId,
        channel: request.channel,
        publicationId: request.publicationId,
        publicationPayloadHash: receipt.publicationPayloadHash,
        generation: request.generation,
        revision,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async withdraw(request: ModuleKnowledgeWithdrawRequest): Promise<ModuleKnowledgeHead> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const key = scopeKey(request.repositoryId, request.channel);
      const [heads] = await connection.query<ModuleHeadRow[]>(
        `SELECT active_publication_id, active_publication_payload_hash,
                active_generation_id, revision
         FROM ${this.headsTable} WHERE scope_key = ? FOR UPDATE`,
        [key],
      );
      const head = heads[0];
      const [generationRows] = await connection.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable} WHERE generation_key = ? FOR UPDATE`,
        [generationKey(request)],
      );
      const generation = generationRows[0];
      if (!generation) {
        throw new ModuleKnowledgeCasError('The module generation is no longer active.');
      }
      if (
        generation.lifecycle_state === 'withdrawn' &&
        generation.withdrawal_kind === 'manual' &&
        (head?.active_publication_id ?? null) === generation.withdrawn_to_publication_id &&
        (head?.active_generation_id === null || head?.active_generation_id === undefined
          ? null
          : Number(head.active_generation_id)) ===
          (generation.withdrawn_to_generation_id === null
            ? null
            : Number(generation.withdrawn_to_generation_id))
      ) {
        if (!head) throw new ModuleKnowledgeCasError('Module knowledge head is missing.');
        await connection.commit();
        return this.mapHead(request, head);
      }
      if (
        !head ||
        Number(head.active_generation_id) !== request.expectedActiveGeneration ||
        Number(head.active_generation_id) !== request.generation ||
        head.active_publication_id !== request.publicationId ||
        generation.lifecycle_state !== 'active'
      ) {
        throw new ModuleKnowledgeCasError('Only the expected active module generation can be withdrawn.');
      }

      let restoredPublication: string | null = null;
      let restoredPublicationPayloadHash: string | null = null;
      let restoredGeneration: number | null = null;
      if (generation.supersedes_publication_id && generation.supersedes_generation_id) {
        const restoreKey: ModuleKnowledgePublicationKey = {
          repositoryId: request.repositoryId,
          channel: request.channel,
          publicationId: generation.supersedes_publication_id,
          generation: Number(generation.supersedes_generation_id),
        };
        const [restoreRows] = await connection.query<ModuleGenerationRow[]>(
          `SELECT * FROM ${this.generationsTable} WHERE generation_key = ? FOR UPDATE`,
          [generationKey(restoreKey)],
        );
        if (restoreRows[0]?.lifecycle_state !== 'tombstoned') {
          const restoredReceipt = await this.validateWith(connection, restoreKey);
          await connection.query<ResultSetHeader>(
            `UPDATE ${this.generationsTable}
             SET lifecycle_state = 'active', withdrawal_kind = NULL,
                 withdrawn_to_publication_id = NULL, withdrawn_to_generation_id = NULL
             WHERE generation_key = ?`,
            [generationKey(restoreKey)],
          );
          restoredPublication = restoreKey.publicationId;
          restoredPublicationPayloadHash = restoredReceipt.publicationPayloadHash;
          restoredGeneration = restoreKey.generation;
        }
      }
      await connection.query<ResultSetHeader>(
        `UPDATE ${this.generationsTable}
         SET lifecycle_state = 'withdrawn', withdrawal_kind = 'manual',
             withdrawn_to_publication_id = ?, withdrawn_to_generation_id = ?
         WHERE generation_key = ?`,
        [restoredPublication, restoredGeneration, generationKey(request)],
      );
      const revision = Number(head.revision) + 1;
      await connection.query<ResultSetHeader>(
        `UPDATE ${this.headsTable}
         SET active_publication_id = ?, active_publication_payload_hash = ?,
             active_generation_id = ?, revision = ?
         WHERE scope_key = ?`,
        [
          restoredPublication,
          restoredPublicationPayloadHash,
          restoredGeneration,
          revision,
          key,
        ],
      );
      await connection.commit();
      return {
        repositoryId: request.repositoryId,
        channel: request.channel,
        publicationId: restoredPublication,
        publicationPayloadHash: restoredPublicationPayloadHash,
        generation: restoredGeneration,
        revision,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async tombstone(request: ModuleKnowledgeTombstoneRequest): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const key = scopeKey(request.repositoryId, request.channel);
      const [heads] = await connection.query<ModuleHeadRow[]>(
        `SELECT active_publication_id, active_publication_payload_hash,
                active_generation_id, revision
         FROM ${this.headsTable} WHERE scope_key = ? FOR UPDATE`,
        [key],
      );
      const head = heads[0];
      if (
        head?.active_publication_id === request.publicationId &&
        Number(head.active_generation_id) === request.generation
      ) {
        throw new Error('An active module generation must be withdrawn before tombstoning.');
      }
      const [rows] = await connection.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable} WHERE generation_key = ? FOR UPDATE`,
        [generationKey(request)],
      );
      const generation = rows[0];
      if (!generation) throw new Error(`Module knowledge generation not found: ${request.generation}.`);
      if (generation.lifecycle_state !== 'tombstoned') {
        await connection.query<ResultSetHeader>(
          `UPDATE ${this.generationsTable} SET lifecycle_state = 'tombstoned'
           WHERE generation_key = ?`,
          [generationKey(request)],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async semanticSearch(
    embedding: number[],
    query: ModuleKnowledgeQuery,
    limit: number,
  ): Promise<RetrievedModuleKnowledgeDocument[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Module query embedding has ${embedding.length} dimensions; expected ${this.dimension}.`,
      );
    }
    const where = filterSql(query);
    const vector = vectorHex(embedding);
    const [rows] = await this.pool.query<ModuleDocumentRow[]>(
      `SELECT ${selectedColumns},
              GREATEST(0, 1 - cosine_distance(d.embedding, ${vector})) AS semantic_score
       FROM ${this.documentsTable} d
       JOIN ${this.headsTable} h
         ON h.scope_key = d.scope_key
        AND h.active_publication_id = d.publication_id
        AND h.active_generation_id = d.generation_id
       JOIN ${this.generationsTable} g ON g.generation_key = d.generation_key
       ${where.sql}
       ORDER BY cosine_distance(d.embedding, ${vector})
       APPROXIMATE
       LIMIT ?`,
      [...where.parameters, limit],
    );
    return rows.map(mapDocumentRow);
  }

  async textSearch(
    queryText: string,
    query: ModuleKnowledgeQuery,
    limit: number,
  ): Promise<RetrievedModuleKnowledgeDocument[]> {
    const where = filterSql(query);
    const match = 'MATCH(d.search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const [rows] = await this.pool.query<ModuleDocumentRow[]>(
      `SELECT ${selectedColumns}, ${match} AS text_score
       FROM ${this.documentsTable} d
       JOIN ${this.headsTable} h
         ON h.scope_key = d.scope_key
        AND h.active_publication_id = d.publication_id
        AND h.active_generation_id = d.generation_id
       JOIN ${this.generationsTable} g ON g.generation_key = d.generation_key
       ${where.sql} AND ${match}
       ORDER BY text_score DESC
       LIMIT ?`,
      [queryText, ...where.parameters, queryText, limit],
    );
    const maxScore = Math.max(...rows.map((row) => Number(row.text_score) || 0), 1);
    return rows.map((row) => mapDocumentRow({
      ...row,
      text_score: Math.min(1, (Number(row.text_score) || 0) / maxScore),
    } as ModuleDocumentRow));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapHead(
    key: ModuleKnowledgePublicationKey,
    row: ModuleHeadRow,
  ): ModuleKnowledgeHead {
    return {
      repositoryId: key.repositoryId,
      channel: key.channel,
      publicationId: row.active_publication_id,
      publicationPayloadHash: row.active_publication_payload_hash,
      generation: row.active_generation_id === null ? null : Number(row.active_generation_id),
      revision: Number(row.revision),
    };
  }

  async activeHead(repositoryId: string, channel: string): Promise<ModuleKnowledgeHead | null> {
    const [rows] = await this.pool.query<ModuleHeadRow[]>(
      `SELECT active_publication_id, active_publication_payload_hash,
              active_generation_id, revision
       FROM ${this.headsTable}
       WHERE scope_key = ? AND repository_id = ? AND publication_channel = ?`,
      [scopeKey(repositoryId, channel), repositoryId, channel],
    );
    const row = rows[0];
    if (!row || row.active_publication_id === null || row.active_generation_id === null) {
      return null;
    }
    const key = {
      repositoryId,
      channel,
      publicationId: row.active_publication_id,
      generation: Number(row.active_generation_id),
    };
    if (this.expectedIndexer) {
      const [generationRows] = await this.pool.query<ModuleGenerationRow[]>(
        `SELECT * FROM ${this.generationsTable} WHERE generation_key = ?`,
        [generationKey(key)],
      );
      const generation = generationRows[0];
      if (!generation) {
        throw new Error('Active module knowledge head has no persisted generation.');
      }
      const receipt = parseReceipt(generation.receipt_json);
      validateRepositoryModuleIndexReceipt(receipt);
      this.assertRuntimeIndexer(parseIndexerStoreId(receipt.storeId, this.storeId, this.dimension));
    }
    return this.mapHead(key, row);
  }

  private assertRuntimeIndexer(metadata: ModuleKnowledgeIndexerMetadata): void {
    if (!this.expectedIndexer) return;
    if (
      metadata.projectionVersion !== this.expectedIndexer.projectionVersion ||
      metadata.embeddingProvider !== this.expectedIndexer.embeddingProvider ||
      metadata.embeddingModel !== this.expectedIndexer.embeddingModel ||
      metadata.embeddingDimension !== this.expectedIndexer.embeddingDimension ||
      metadata.configurationHash !== this.expectedIndexer.configurationHash
    ) {
      throw new Error(
        'Active module knowledge generation was built by another projection or embedding configuration; reindex before search.',
      );
    }
  }
}

export const seekDbModuleKnowledgeInternals = {
  documentKey,
  filterSql,
  generationKey,
  indexerStoreId,
  mapDocumentRow,
  parseIndexerStoreId,
  scopeKey,
  vectorHex,
};
