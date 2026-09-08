import { createHash } from 'node:crypto';
import { queryRows } from './abortable-query.js';
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type {
  AnalysisRevisionRecord,
  DependencyEdgeRecord,
  IndexDiagnosticRecord,
  IndexedFileRecord,
  ModuleArtifactRecord,
  ProjectRecord,
  RepositoryAnalysisStatus,
  RepositoryId,
  RepositoryRecord,
  RepositoryRevisionScope,
  SearchDocumentRecord,
  SourceRange,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import {
  assertRelativePath,
  validateModuleArtifact,
  validateRevisionWrite,
  validateSearchDocumentRecords,
  validateSearchDocumentsAgainstIndex,
  validateStructuralIndex,
  validateSourceTexts,
  validateSummaryReplacement,
  validateLocalQuery,
  sliceSourceText,
  projectionFactLookup,
  type IndexStore,
  type LocalDependencyQuery,
  type LocalSymbolQuery,
  type SourceSlice,
  type SourceTextReader,
  type ProjectionFactLookup,
  type RevisionStatistics,
} from './index-store.js';
import {
  HashSearchEmbeddingProvider,
  ModelSearchEmbeddingProvider,
  type ModelSearchEmbeddingConfig,
  type SearchEmbeddingProvider,
} from './search-embedding.js';

export interface SeekDbIndexStoreConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  structuralBatchRows?: number;
  /** Kept for the vector-capable search_documents projection. */
  vectorDimension?: number;
  /** Host-configured model embedding provider; deterministic hashing is the safe local fallback. */
  embeddingProvider?: SearchEmbeddingProvider;
  embedding?: ModelSearchEmbeddingConfig;
}

interface RepositoryRow extends RowDataPacket {
  repository_id: string | Buffer;
  display_name: string;
  local_path: string;
  role: RepositoryRecord['role'];
  analysis_status: RepositoryRecord['analysisStatus'];
  active_revision: string | Buffer | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RevisionRow extends RowDataPacket {
  repository_id: string | Buffer;
  analysis_revision: string | Buffer;
  status: AnalysisRevisionRecord['status'];
  analysis_hash: string;
  source_revision: string | null;
  indexer_version: string;
  created_at: string | Date;
  completed_at: string | Date | null;
  activated_at: string | Date | null;
  failure_reason: string | null;
}

interface ProjectRow extends RowDataPacket {
  project_id: string | Buffer;
  kind: string;
  display_name: string;
  relative_path: string;
  manifest_paths: string | string[];
  source_roots: string | string[];
  test_roots: string | string[];
  language_ids: string | string[];
}

interface FileRow extends RowDataPacket {
  file_id: string | Buffer;
  relative_path: string;
  language_id: string | null;
  role: IndexedFileRecord['role'];
  sha256: string;
  size_bytes: number | string;
  parse_status: IndexedFileRecord['parseStatus'];
  project_id: string | Buffer | null;
  source_text?: string | null;
}

interface SymbolRow extends RowDataPacket {
  symbol_id: string | Buffer;
  symbol_key: string;
  ast_declaration_id: string;
  name: string;
  qualified_name: string;
  kind: SymbolRecord['kind'];
  language_id: string;
  relative_path: string;
  source_range: string | object;
  signature: string | null;
  container_symbol_key: string | null;
  project_id: string | Buffer | null;
  exported: number | boolean;
  provider: SymbolRecord['provider'];
  confidence: number | string;
  evidence_level: SymbolRecord['evidenceLevel'];
}

interface DependencyRow extends RowDataPacket {
  dependency_edge_id: string | Buffer;
  kind: DependencyEdgeRecord['kind'];
  source_symbol_key: string | null;
  target_symbol_key: string | null;
  source_relative_path: string;
  target_relative_path: string | null;
  target_reference: string | null;
  internal: number | boolean;
  resolution: DependencyEdgeRecord['resolution'];
  provider: DependencyEdgeRecord['provider'];
  confidence: number | string;
  evidence_level: DependencyEdgeRecord['evidenceLevel'];
  evidence_ranges: string | object;
}

interface DiagnosticRow extends RowDataPacket {
  diagnostic_id: string | Buffer;
  severity: IndexDiagnosticRecord['severity'];
  message: string;
  code: string | null;
  relative_path: string | null;
  source_range: string | object | null;
  provider: IndexDiagnosticRecord['provider'];
  confidence: number | string;
  evidence_level: IndexDiagnosticRecord['evidenceLevel'];
}

interface ModuleArtifactRow extends RowDataPacket {
  module_artifact_id: string | Buffer;
  kind: ModuleArtifactRecord['kind'];
  status: ModuleArtifactRecord['status'];
  analysis_hash: string;
  plan_hash: string | null;
  content_hash: string;
  created_at: string | Date;
  updated_at: string | Date;
  payload: string | object | null;
}

interface SearchDocumentRow extends RowDataPacket {
  search_document_id: string | Buffer;
  kind: SearchDocumentRecord['kind'];
  relative_path: string | null;
  symbol_key: string | null;
  source_range?: string | object | null;
  module_artifact_id: string | Buffer | null;
  content_hash: string;
  title: string;
  document_text: string;
  text_score?: number | string;
  semantic_score?: number | string;
}

function vectorHex(vector: readonly number[]): string {
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return `X'${buffer.toString('hex')}'`;
}

function assertEmbedding(vector: readonly number[], dimension: number): void {
  if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Search embedding must contain ${dimension} finite values.`);
  }
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('SeekDB database identifiers may contain only letters, digits, and _.');
  }
  return `\`${value}\``;
}

function stringValue(value: string | Buffer | null): string | null {
  if (value === null) return null;
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function timestamp(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberValue(value: number | string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`SeekDB returned an invalid number: ${String(value)}`);
  return result;
}

function booleanValue(value: number | boolean): boolean {
  return value === true || value === 1;
}

function json<T>(value: string | object | null, fallback: T): T {
  if (value === null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  const parsed = json<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function scopeParams(scope: RepositoryRevisionScope): [string, string] {
  return [scope.repositoryId, scope.analysisRevision];
}

function toRepository(row: RepositoryRow): RepositoryRecord {
  return {
    repositoryId: stringValue(row.repository_id)!,
    displayName: row.display_name,
    localPath: row.local_path,
    role: row.role,
    analysisStatus: row.analysis_status,
    activeRevision: stringValue(row.active_revision),
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
  };
}

function toRevision(row: RevisionRow): AnalysisRevisionRecord {
  const sourceRevision = row.source_revision ?? undefined;
  const completedAt = timestamp(row.completed_at);
  const activatedAt = timestamp(row.activated_at);
  const failureReason = row.failure_reason ?? undefined;
  return {
    repositoryId: stringValue(row.repository_id)!,
    analysisRevision: stringValue(row.analysis_revision)!,
    status: row.status,
    analysisHash: row.analysis_hash,
    ...(sourceRevision ? { sourceRevision } : {}),
    indexerVersion: row.indexer_version,
    createdAt: timestamp(row.created_at)!,
    ...(completedAt ? { completedAt } : {}),
    ...(activatedAt ? { activatedAt } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function toProject(scope: RepositoryRevisionScope, row: ProjectRow): ProjectRecord {
  return {
    ...scope,
    projectId: stringValue(row.project_id)!,
    kind: row.kind,
    displayName: row.display_name,
    relativePath: row.relative_path,
    manifestPaths: jsonArray(row.manifest_paths),
    sourceRoots: jsonArray(row.source_roots),
    testRoots: jsonArray(row.test_roots),
    languageIds: jsonArray(row.language_ids),
  };
}

function toFile(scope: RepositoryRevisionScope, row: FileRow): IndexedFileRecord {
  const languageId = row.language_id ?? undefined;
  const projectId = stringValue(row.project_id);
  return {
    ...scope,
    fileId: stringValue(row.file_id)!,
    relativePath: row.relative_path,
    ...(languageId ? { languageId } : {}),
    role: row.role,
    sha256: row.sha256,
    sizeBytes: numberValue(row.size_bytes),
    parseStatus: row.parse_status,
    ...(projectId ? { projectId } : {}),
  };
}

function toSymbol(scope: RepositoryRevisionScope, row: SymbolRow): SymbolRecord {
  const signature = row.signature ?? undefined;
  const containerSymbolKey = row.container_symbol_key ?? undefined;
  const projectId = stringValue(row.project_id);
  return {
    ...scope,
    symbolId: stringValue(row.symbol_id)!,
    symbolKey: row.symbol_key,
    astDeclarationId: row.ast_declaration_id,
    name: row.name,
    qualifiedName: row.qualified_name,
    kind: row.kind,
    languageId: row.language_id,
    relativePath: row.relative_path,
    sourceRange: json(row.source_range, {} as SymbolRecord['sourceRange']),
    ...(signature ? { signature } : {}),
    ...(containerSymbolKey ? { containerSymbolKey } : {}),
    ...(projectId ? { projectId } : {}),
    exported: booleanValue(row.exported),
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
  };
}

function toDependency(scope: RepositoryRevisionScope, row: DependencyRow): DependencyEdgeRecord {
  const sourceSymbolKey = row.source_symbol_key ?? undefined;
  const targetSymbolKey = row.target_symbol_key ?? undefined;
  const targetRelativePath = row.target_relative_path ?? undefined;
  const targetReference = row.target_reference ?? undefined;
  return {
    ...scope,
    dependencyEdgeId: stringValue(row.dependency_edge_id)!,
    kind: row.kind,
    ...(sourceSymbolKey ? { sourceSymbolKey } : {}),
    ...(targetSymbolKey ? { targetSymbolKey } : {}),
    sourceRelativePath: row.source_relative_path,
    ...(targetRelativePath ? { targetRelativePath } : {}),
    ...(targetReference ? { targetReference } : {}),
    internal: booleanValue(row.internal),
    resolution: row.resolution,
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
    evidenceRanges: json(row.evidence_ranges, []),
  };
}

function toDiagnostic(scope: RepositoryRevisionScope, row: DiagnosticRow): IndexDiagnosticRecord {
  const code = row.code ?? undefined;
  return {
    ...scope,
    diagnosticId: stringValue(row.diagnostic_id)!,
    severity: row.severity,
    message: row.message,
    ...(code ? { code } : {}),
    relativePath: row.relative_path,
    sourceRange: json(row.source_range, null),
    provider: row.provider,
    confidence: numberValue(row.confidence),
    evidenceLevel: row.evidence_level,
  };
}

function toModuleArtifact(scope: RepositoryRevisionScope, row: ModuleArtifactRow): ModuleArtifactRecord {
  const planHash = row.plan_hash ?? undefined;
  const payload = json<unknown>(row.payload, undefined);
  return {
    ...scope,
    moduleArtifactId: stringValue(row.module_artifact_id)!,
    kind: row.kind,
    status: row.status,
    analysisHash: row.analysis_hash,
    ...(planHash ? { planHash } : {}),
    contentHash: row.content_hash,
    createdAt: timestamp(row.created_at)!,
    updatedAt: timestamp(row.updated_at)!,
    ...(payload === undefined ? {} : { payload }),
  };
}

function toSearchDocument(scope: RepositoryRevisionScope, row: SearchDocumentRow): SearchDocumentRecord {
  const symbolKey = row.symbol_key ?? undefined;
  const moduleArtifactId = stringValue(row.module_artifact_id);
  return {
    ...scope,
    searchDocumentId: stringValue(row.search_document_id)!,
    kind: row.kind,
    relativePath: row.relative_path,
    ...(symbolKey ? { symbolKey } : {}),
    ...(row.source_range ? { sourceRange: json<SourceRange | undefined>(row.source_range, undefined) } : {}),
    ...(moduleArtifactId ? { moduleArtifactId } : {}),
    contentHash: row.content_hash,
    title: row.title,
    text: row.document_text,
  };
}

async function withTransaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  let previousTimeout: number | undefined;
  let timeoutChanged = false;
  let transactionStarted = false;
  let reusable = true;
  const started = performance.now();
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT @@session.ob_query_timeout AS query_timeout');
    previousTimeout = Number(rows[0]!.query_timeout);
    // Bulk index writes also pay for secondary indexes and log flushes at COMMIT.
    if (previousTimeout > 0 && previousTimeout < 60_000_000) {
      await connection.query('SET SESSION ob_query_timeout = 60000000');
      timeoutChanged = true;
    }
    await connection.beginTransaction();
    transactionStarted = true;
    const value = await operation(connection);
    const commitStarted = performance.now();
    await connection.commit();
    transactionStarted = false;
    console.info('[forexplore:performance]', JSON.stringify({ stage: 'seekdb-transaction',
      durationMs: Math.round(performance.now() - started), commitMs: Math.round(performance.now() - commitStarted) }));
    return value;
  } catch (error) {
    if (transactionStarted) {
      try { await connection.rollback(); }
      catch { reusable = false; }
    }
    throw error;
  } finally {
    if (timeoutChanged && reusable) {
      try { await connection.query('SET SESSION ob_query_timeout = ?', [previousTimeout]); }
      catch { reusable = false; }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

type InsertRow = { values: unknown[]; vector?: string };

function* insertRows<T>(rows: readonly T[], convert: (row: T, index: number) => InsertRow): Iterable<InsertRow> {
  for (let index = 0; index < rows.length; index++) yield convert(rows[index]!, index);
}

// Limit both row count and escaped SQL size; a single large source stays intact.
async function insertBatches(connection: PoolConnection, sql: string, rows: Iterable<InsertRow>): Promise<number> {
  let batch: InsertRow[] = [];
  let bytes = 0;
  let statements = 0;
  const flush = async () => {
    if (!batch.length) return;
    const tuples = batch.map((row) => `(${row.values.map(() => '?').join(', ')}${row.vector ? `, ${row.vector}` : ''})`);
    await connection.query(`${sql} VALUES ${tuples.join(', ')}`, batch.flatMap((row) => row.values));
    statements += 1;
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.values.reduce<number>((total, value) => total +
      (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') * 2 + 2 : 32), 0) + (row.vector?.length ?? 0);
    if (batch.length && (batch.length >= 250 || bytes + size > 512 * 1024)) await flush();
    batch.push(row);
    bytes += size;
  }
  await flush();
  return statements;
}

/**
 * SeekDB persistence for the authoritative revision model. It uses dedicated
 * tables instead of expanding legacy `code_symbols`; each replacement DELETE
 * is bound to one repository + analysis revision.
 */
export class SeekDbIndexStore implements IndexStore {
  readonly #projectionFacts = new WeakMap<StructuralIndex, ProjectionFactLookup>();
  readonly #structuralBatchRows: number;
  readonly #database: string;
  readonly #tables: Record<string, string>;
  readonly #vectorDimension: number;
  readonly #embeddingProvider: SearchEmbeddingProvider;
  readonly #embeddingIdentity: string;
  readonly #legacyHashCompatible: boolean;
  readonly #persistEmbeddings: boolean;
  #persistentEmbeddingHits = 0;
  #embeddingProviderDocuments = 0;

  constructor(config: SeekDbIndexStoreConfig, private readonly pool: Pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectionLimit: 8,
    enableKeepAlive: true,
    decimalNumbers: true,
  } satisfies PoolOptions)) {
    this.#structuralBatchRows = config.structuralBatchRows ?? 250;
    if (!Number.isInteger(this.#structuralBatchRows) || this.#structuralBatchRows < 1 || this.#structuralBatchRows > 2048) throw new Error('Structural batch rows must be in 1..2048.');
    this.#database = identifier(config.database);
    this.#vectorDimension = config.vectorDimension ?? 384;
    if (!Number.isInteger(this.#vectorDimension) || this.#vectorDimension < 1) {
      throw new Error('SeekDB vectorDimension must be a positive integer.');
    }
    if (config.embeddingProvider && config.embedding) throw new Error('Choose an embedding provider or model configuration.');
    if (config.embeddingProvider && !config.embeddingProvider.identity?.trim()) {
      throw new Error('Custom persisted embedding providers require an immutable model/configuration identity.');
    }
    this.#embeddingProvider = config.embeddingProvider ?? (config.embedding
      ? new ModelSearchEmbeddingProvider(this.#vectorDimension, config.embedding)
      : new HashSearchEmbeddingProvider(this.#vectorDimension));
    this.#legacyHashCompatible = !config.embedding && !config.embeddingProvider;
    this.#persistEmbeddings = Boolean(config.embedding);
    this.#embeddingIdentity = createHash('sha256').update(JSON.stringify({
      dimension: this.#vectorDimension,
      provider: config.embedding ? 'model-v1' : config.embeddingProvider ? config.embeddingProvider.identity : 'hash-v1',
      ...(config.embedding ? { url: config.embedding.url, model: config.embedding.model,
        queryPrefix: config.embedding.queryPrefix ?? '', documentPrefix: config.embedding.documentPrefix ?? '',
        supportsDimensions: config.embedding.supportsDimensions ?? true } : {}),
    })).digest('hex');
    if (this.#embeddingProvider.dimension !== this.#vectorDimension) {
      throw new Error('SeekDB embeddingProvider dimension must match vectorDimension.');
    }
    const qualify = (name: string): string => `${this.#database}.${identifier(name)}`;
    this.#tables = {
      repositories: qualify('repositories'),
      analysisRevisions: qualify('analysis_revisions'),
      projects: qualify('projects'),
      files: qualify('files'),
      symbols: qualify('symbols'),
      dependencyEdges: qualify('dependency_edges'),
      moduleArtifacts: qualify('module_artifacts'),
      searchDocuments: qualify('search_documents'),
      embeddingConfiguration: qualify('search_embedding_configuration'),
      embeddingCache: qualify('search_embedding_cache'),
      diagnostics: qualify('index_diagnostics'),
    };
  }

  async initialize(): Promise<void> {
    const [versions] = await this.pool.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const version = /seekdb-v(\d+)\.(\d+)/i.exec(String(versions[0]?.version ?? ''));
    const supportsAsyncIndex = version !== null && (Number(version[1]) > 1 || Number(version[1]) === 1 && Number(version[2]) >= 3);
    await this.pool.query(`CREATE DATABASE IF NOT EXISTS ${this.#database}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.repositories} (
        repository_id VARCHAR(256) PRIMARY KEY NOT NULL,
        display_name VARCHAR(1024) NOT NULL,
        local_path TEXT NOT NULL,
        role VARCHAR(32) NOT NULL,
        analysis_status VARCHAR(32) NOT NULL,
        active_revision VARCHAR(256) NULL,
        created_at VARCHAR(64) NOT NULL,
        updated_at VARCHAR(64) NOT NULL
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.analysisRevisions} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        status VARCHAR(32) NOT NULL,
        analysis_hash CHAR(64) NOT NULL,
        source_revision VARCHAR(512) NULL,
        indexer_version VARCHAR(512) NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        completed_at VARCHAR(64) NULL,
        activated_at VARCHAR(64) NULL,
        failure_reason TEXT NULL,
        PRIMARY KEY (repository_id, analysis_revision),
        INDEX idx_analysis_revisions_repository (repository_id, created_at)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.projects} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        project_id VARCHAR(256) NOT NULL,
        kind VARCHAR(128) NOT NULL,
        display_name VARCHAR(1024) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        manifest_paths JSON NOT NULL,
        source_roots JSON NOT NULL,
        test_roots JSON NOT NULL,
        language_ids JSON NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, project_id)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.files} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        file_id VARCHAR(256) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        language_id VARCHAR(128) NULL,
        role VARCHAR(32) NOT NULL,
        sha256 CHAR(64) NOT NULL,
        size_bytes BIGINT NOT NULL,
        parse_status VARCHAR(32) NOT NULL,
        project_id VARCHAR(256) NULL,
        source_text LONGTEXT NULL,
        PRIMARY KEY (repository_id, analysis_revision, file_id),
        INDEX idx_files_path (repository_id, analysis_revision, relative_path(512))
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.symbols} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        symbol_id VARCHAR(256) NOT NULL,
        symbol_key VARCHAR(512) NOT NULL,
        ast_declaration_id VARCHAR(512) NOT NULL,
        name VARCHAR(1024) NOT NULL,
        qualified_name TEXT NOT NULL,
        kind VARCHAR(128) NOT NULL,
        language_id VARCHAR(128) NOT NULL,
        relative_path VARCHAR(4096) NOT NULL,
        source_range JSON NOT NULL,
        signature TEXT NULL,
        container_symbol_key VARCHAR(512) NULL,
        project_id VARCHAR(256) NULL,
        exported BOOLEAN NOT NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, symbol_id),
        UNIQUE KEY uq_symbols_key (repository_id, analysis_revision, symbol_key)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.dependencyEdges} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        dependency_edge_id VARCHAR(256) NOT NULL,
        kind VARCHAR(128) NOT NULL,
        source_symbol_key VARCHAR(512) NULL,
        target_symbol_key VARCHAR(512) NULL,
        source_relative_path VARCHAR(4096) NOT NULL,
        target_relative_path VARCHAR(4096) NULL,
        target_reference TEXT NULL,
        internal BOOLEAN NOT NULL,
        resolution VARCHAR(32) NOT NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        evidence_ranges JSON NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, dependency_edge_id)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.diagnostics} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        diagnostic_id VARCHAR(256) NOT NULL,
        severity VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        code VARCHAR(256) NULL,
        relative_path VARCHAR(4096) NULL,
        source_range JSON NULL,
        provider VARCHAR(64) NOT NULL,
        confidence DOUBLE NOT NULL,
        evidence_level VARCHAR(32) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, diagnostic_id)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.moduleArtifacts} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        module_artifact_id VARCHAR(256) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        analysis_hash CHAR(64) NOT NULL,
        plan_hash VARCHAR(128) NULL,
        content_hash CHAR(64) NOT NULL,
        created_at VARCHAR(64) NOT NULL,
        updated_at VARCHAR(64) NOT NULL,
        payload JSON NULL,
        PRIMARY KEY (repository_id, analysis_revision, module_artifact_id)
      ) ORGANIZATION = HEAP
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.#tables.searchDocuments} (
        repository_id VARCHAR(256) NOT NULL,
        analysis_revision VARCHAR(256) NOT NULL,
        search_document_id VARCHAR(256) NOT NULL,
        kind VARCHAR(64) NOT NULL,
        relative_path VARCHAR(4096) NULL,
        symbol_key VARCHAR(512) NULL,
        source_range JSON NULL,
        module_artifact_id VARCHAR(256) NULL,
        content_hash CHAR(64) NOT NULL,
        title VARCHAR(2048) NOT NULL,
        document_text LONGTEXT NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.#vectorDimension}) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, search_document_id),
        FULLTEXT INDEX idx_search_documents_text (search_text) WITH PARSER ik,
        VECTOR INDEX idx_search_documents_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag${supportsAsyncIndex ? ', SYNC_MODE=immediate' : ''})
      ) ORGANIZATION = HEAP
    `);
    const [sourceRangeColumns] = await this.pool.query<RowDataPacket[]>(`SHOW COLUMNS FROM ${this.#tables.searchDocuments} LIKE 'source_range'`);
    if (!sourceRangeColumns.length) await this.pool.query(`ALTER TABLE ${this.#tables.searchDocuments} ADD COLUMN source_range JSON NULL`);
    for (const [table, name, columns] of [
      [this.#tables.files, 'idx_files_project', 'repository_id, analysis_revision, project_id'],
      [this.#tables.symbols, 'idx_symbols_path', 'repository_id, analysis_revision, relative_path(512)'],
      [this.#tables.dependencyEdges, 'idx_dependencies_source_path', 'repository_id, analysis_revision, source_relative_path(512)'],
      [this.#tables.dependencyEdges, 'idx_dependencies_target_path', 'repository_id, analysis_revision, target_relative_path(512)'],
      [this.#tables.dependencyEdges, 'idx_dependencies_source_symbol', 'repository_id, analysis_revision, source_symbol_key'],
      [this.#tables.dependencyEdges, 'idx_dependencies_target_symbol', 'repository_id, analysis_revision, target_symbol_key'],
    ]) {
      const [indexes] = await this.pool.query<RowDataPacket[]>(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
      if (!indexes.length) await this.pool.query(`ALTER TABLE ${table} ADD INDEX ${name} (${columns})`);
    }
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.#tables.embeddingConfiguration} (
      slot INT PRIMARY KEY, config_hash CHAR(64) NOT NULL
    ) ORGANIZATION = HEAP`);
    const [configured] = await this.pool.query<RowDataPacket[]>(`SELECT config_hash FROM ${this.#tables.embeddingConfiguration} WHERE slot = 1`);
    if (!configured.length && !this.#legacyHashCompatible) {
      const [existing] = await this.pool.query<RowDataPacket[]>(`SELECT search_document_id FROM ${this.#tables.searchDocuments} LIMIT 1`);
      if (existing.length) throw new Error('Existing vectors have no model identity. Use a separate database and rebuild projections for this embedding model.');
    }
    await this.pool.query(`INSERT IGNORE INTO ${this.#tables.embeddingConfiguration} (slot, config_hash) VALUES (1, ?)`, [this.#embeddingIdentity]);
    const [identity] = await this.pool.query<RowDataPacket[]>(`SELECT config_hash FROM ${this.#tables.embeddingConfiguration} WHERE slot = 1`);
    if (String(identity[0]?.config_hash) !== this.#embeddingIdentity) {
      throw new Error('Embedding model/configuration does not match stored vectors. Use a separate database and rebuild projections.');
    }
    if (supportsAsyncIndex) {
      const [definitions] = await this.pool.query<RowDataPacket[]>(`SHOW CREATE TABLE ${this.#tables.searchDocuments}`);
      if (!/sync_mode\s*=\s*'?immediate'?/i.test(String(definitions[0]?.['Create Table'] ?? ''))) {
        throw new Error('Existing search index uses an incompatible asynchronous configuration. If the old analysis data is disposable, run scripts/reset-code-intelligence-index.ts --database <database> --apply, then reload the extension and reanalyze the selected repositories.');
      }
    }
    if (this.#persistEmbeddings) await this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.#tables.embeddingCache} (
      content_hash CHAR(64) PRIMARY KEY, embedding JSON NOT NULL
    ) ORGANIZATION = HEAP`);
  }

  get embeddingReuseStats(): { persistentHits: number; providerDocuments: number } {
    return { persistentHits: this.#persistentEmbeddingHits, providerDocuments: this.#embeddingProviderDocuments };
  }

  /** Reuse exact model inputs across revisions and process restarts. Model identity is bound during initialize. */
  private async embedDocuments(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    if (!this.#persistEmbeddings || texts.length === 0) return this.#embeddingProvider.embed(texts, signal);
    const keys = texts.map((text) => createHash('sha256').update(this.#embeddingIdentity).update('\0').update(text).digest('hex'));
    const unique = [...new Map(keys.map((key, index) => [key, texts[index]!])).entries()];
    const vectors = new Map<string, number[]>();
    for (let offset = 0; offset < unique.length; offset += 128) {
      signal?.throwIfAborted();
      const batch = unique.slice(offset, offset + 128);
      const [cached] = await this.pool.query<RowDataPacket[]>(`SELECT content_hash, embedding FROM ${this.#tables.embeddingCache}
        WHERE content_hash IN (${batch.map(() => '?').join(',')})`, batch.map(([key]) => key));
      for (const row of cached) {
        const vector = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
        if (!Array.isArray(vector)) throw new Error('Invalid persisted embedding.');
        assertEmbedding(vector, this.#vectorDimension);
        vectors.set(String(row.content_hash), vector);
      }
      this.#persistentEmbeddingHits += cached.length;
      const missing = batch.filter(([key]) => !vectors.has(key));
      for (let start = 0; start < missing.length; start += 16) {
        const inputs = missing.slice(start, start + 16);
        const encoded = await this.#embeddingProvider.embed(inputs.map(([, text]) => text), signal);
        if (encoded.length !== inputs.length) throw new Error('Embedding provider returned an unexpected document count.');
        this.#embeddingProviderDocuments += inputs.length;
        const parameters = inputs.flatMap(([key], index) => {
          const vector = encoded[index]!;
          assertEmbedding(vector, this.#vectorDimension);
          vectors.set(key, vector);
          return [key, JSON.stringify(vector)];
        });
        await this.pool.query(`INSERT IGNORE INTO ${this.#tables.embeddingCache} (content_hash, embedding)
          VALUES ${inputs.map(() => '(?, ?)').join(',')}`, parameters);
      }
    }
    return keys.map((key) => [...vectors.get(key)!]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async putRepository(repository: RepositoryRecord): Promise<void> {
    await this.pool.query<ResultSetHeader>(`
      INSERT INTO ${this.#tables.repositories} (
        repository_id, display_name, local_path, role, analysis_status, active_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name), local_path = VALUES(local_path), role = VALUES(role),
        analysis_status = VALUES(analysis_status), active_revision = VALUES(active_revision), updated_at = VALUES(updated_at)
    `, [
      repository.repositoryId, repository.displayName, repository.localPath, repository.role,
      repository.analysisStatus, repository.activeRevision, repository.createdAt, repository.updatedAt,
    ]);
  }

  async getRepository(repositoryId: RepositoryId, signal?: AbortSignal): Promise<RepositoryRecord | null> {
    const rows = await queryRows<RepositoryRow[]>(this.pool,
      `SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ?`, [repositoryId], signal,
    );
    const row = rows[0];
    return row ? toRepository(row) : null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const [rows] = await this.pool.query<RepositoryRow[]>(
      `SELECT * FROM ${this.#tables.repositories} ORDER BY repository_id`,
    );
    return rows.map(toRepository);
  }

  async removeRepository(repositoryId: RepositoryId): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const tables = [
        this.#tables.searchDocuments,
        this.#tables.moduleArtifacts,
        this.#tables.dependencyEdges,
        this.#tables.symbols,
        this.#tables.files,
        this.#tables.projects,
        this.#tables.diagnostics,
        this.#tables.analysisRevisions,
        this.#tables.repositories,
      ];
      for (const table of tables) {
        await connection.query(`DELETE FROM ${table} WHERE repository_id = ?`, [repositoryId]);
      }
    });
  }

  async putRevision(revision: AnalysisRevisionRecord): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT repository_id FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [revision.repositoryId]);
      if (!repositories[0]) {
        throw new Error(`Repository ${revision.repositoryId} is not registered.`);
      }
      const [rows] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(revision));
      const existing = rows[0] ? toRevision(rows[0]) : null;
      validateRevisionWrite(existing, revision);
      if (!existing) {
        await connection.query<ResultSetHeader>(`
          INSERT INTO ${this.#tables.analysisRevisions} (
            repository_id, analysis_revision, status, analysis_hash, source_revision, indexer_version,
            created_at, completed_at, activated_at, failure_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          revision.repositoryId, revision.analysisRevision, revision.status, revision.analysisHash,
          revision.sourceRevision ?? null, revision.indexerVersion, revision.createdAt,
          null, null, null,
        ]);
        return;
      }
      const [result] = await connection.query<ResultSetHeader>(`
        UPDATE ${this.#tables.analysisRevisions}
        SET status = ?, analysis_hash = ?, source_revision = ?, completed_at = ?, failure_reason = ?
        WHERE repository_id = ? AND analysis_revision = ? AND status = 'building'
      `, [
        revision.status, revision.analysisHash, revision.sourceRevision ?? null,
        revision.completedAt ?? null, revision.failureReason ?? null,
        ...scopeParams(revision),
      ]);
      if (result.affectedRows !== 1) {
        throw new Error(`Analysis revision ${revision.analysisRevision} changed while it was being finalized.`);
      }
    });
  }

  async getRevision(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<AnalysisRevisionRecord | null> {
    const rows = await queryRows<RevisionRow[]>(this.pool, `
      SELECT * FROM ${this.#tables.analysisRevisions}
      WHERE repository_id = ? AND analysis_revision = ?
    `, scopeParams(scope), signal);
    const row = rows[0];
    return row ? toRevision(row) : null;
  }

  async listRevisions(repositoryId: RepositoryId): Promise<AnalysisRevisionRecord[]> {
    const [rows] = await this.pool.query<RevisionRow[]>(`
      SELECT * FROM ${this.#tables.analysisRevisions}
      WHERE repository_id = ? ORDER BY created_at DESC
    `, [repositoryId]);
    return rows.map(toRevision);
  }

  async putStructuralIndex(index: StructuralIndex, sourceTexts: ReadonlyMap<string, string> = new Map()): Promise<void> {
    validateStructuralIndex(index);
    validateSourceTexts(index, sourceTexts);
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(index));
      const revision = revisions[0];
      if (!revision) throw new Error('Cannot write an index for an unknown analysis revision.');
      if (revision.status !== 'building') {
        throw new Error('Structural indexes may be written only while an analysis revision is building.');
      }
      if (revision.analysis_hash !== index.analysisHash) {
        throw new Error('Structural index analysisHash must match its analysis revision.');
      }
      await this.#deleteRevisionStructuralRecords(connection, index);
      const started = performance.now();
      let statements = await this.#insertProjects(connection, index.projects);
      statements += await this.#insertFiles(connection, index.files, sourceTexts);
      statements += await this.#insertSymbols(connection, index.symbols);
      statements += await this.#insertDependencies(connection, index.dependencyEdges);
      statements += await this.#insertDiagnostics(connection, index.diagnostics);
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'structural-insert', repositoryId: index.repositoryId,
        durationMs: Math.round(performance.now() - started), files: index.files.length, symbols: index.symbols.length,
        dependencies: index.dependencyEdges.length, insertStatements: statements }));
    });
  }

  async getStructuralIndex({ repositoryId, analysisRevision }: RepositoryRevisionScope): Promise<StructuralIndex | null> {
    const scope = { repositoryId, analysisRevision };
    const revision = await this.getRevision(scope);
    if (!revision) return null;
    const [projects, files, symbols, dependencyEdges, diagnostics] = await Promise.all([
      this.listProjects(scope), this.listFiles(scope), this.listSymbols(scope),
      this.listDependencyEdges(scope), this.listDiagnostics(scope),
    ]);
    // An empty valid repository still has a structural revision, so the
    // revision row is authoritative instead of using a non-empty array test.
    return {
      ...scope,
      analysisHash: revision.analysisHash,
      projects,
      files,
      symbols,
      dependencyEdges,
      diagnostics,
    };
  }

  async getStructuralIndexMetadata(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<Pick<StructuralIndex, 'repositoryId' | 'analysisRevision' | 'analysisHash'> | null> {
    const revision = await this.getRevision(scope, signal);
    return revision ? { ...scope, analysisHash: revision.analysisHash } : null;
  }

  async getRevisionStatistics(scope: RepositoryRevisionScope, signal?: AbortSignal): Promise<RevisionStatistics | null> {
    if (!await this.getRevision(scope, signal)) return null;
    const tables = [this.#tables.projects, this.#tables.files, this.#tables.symbols, this.#tables.dependencyEdges, this.#tables.diagnostics];
    const fields = ['projects', 'files', 'symbols', 'dependencies', 'diagnostics'];
    const counts = await queryRows<RowDataPacket[]>(this.pool, `SELECT ${tables.map((table, index) =>
      `(SELECT COUNT(*) FROM ${table} WHERE repository_id = ? AND analysis_revision = ?) AS ${fields[index]}`).join(', ')}`,
    tables.flatMap(() => scopeParams(scope)), signal);
    const rows = await queryRows<RowDataPacket[]>(this.pool, `SELECT language_id, COUNT(*) AS file_count, 0 AS has_semantic_symbols
      FROM ${this.#tables.files} WHERE repository_id = ? AND analysis_revision = ? AND language_id IS NOT NULL GROUP BY language_id
      UNION ALL SELECT language_id, 0 AS file_count, MAX(provider <> 'tree-sitter') AS has_semantic_symbols
      FROM ${this.#tables.symbols} WHERE repository_id = ? AND analysis_revision = ? GROUP BY language_id`,
    [...scopeParams(scope), ...scopeParams(scope)], signal);
    const languages = new Map<string, RevisionStatistics['languages'][number]>();
    for (const row of rows) {
      const languageId = String(row.language_id);
      const previous = languages.get(languageId) ?? { languageId, fileCount: 0, hasSemanticSymbols: false };
      previous.fileCount += Number(row.file_count);
      previous.hasSemanticSymbols ||= Boolean(Number(row.has_semantic_symbols));
      languages.set(languageId, previous);
    }
    return { projects: Number(counts[0]!.projects), files: Number(counts[0]!.files), symbols: Number(counts[0]!.symbols),
      dependencies: Number(counts[0]!.dependencies), diagnostics: Number(counts[0]!.diagnostics),
      languages: [...languages.values()].filter(language => language.fileCount > 0).sort((a, b) => a.languageId.localeCompare(b.languageId)) };
  }

  async #writeBuilding(index: StructuralIndex, write: (connection: PoolConnection) => Promise<unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.query<RevisionRow[]>(`SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE`, scopeParams(index));
      if (rows[0]?.status !== 'building' || rows[0].analysis_hash !== index.analysisHash) throw new Error('Index batches require their matching building revision.');
      signal?.throwIfAborted();
      await write(connection);
      signal?.throwIfAborted();
    });
  }

  async putStructuralIndexFromSource(index: StructuralIndex, source: SourceTextReader, signal?: AbortSignal): Promise<void> {
    validateStructuralIndex(index);
    const batchRows = this.#structuralBatchRows;
    await this.#writeBuilding(index, (connection) => this.#deleteRevisionStructuralRecords(connection, index), signal);
    for (let offset = 0; offset < index.projects.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertProjects(connection, index.projects.slice(offset, offset + batchRows)), signal);
    }
    let files: IndexedFileRecord[] = [];
    let texts = new Map<string, string>();
    let bytes = 0;
    const flush = async () => {
      if (!files.length) return;
      await this.#writeBuilding(index, (connection) => this.#insertFiles(connection, files, texts), signal);
      files = []; texts = new Map(); bytes = 0;
    };
    for (const file of index.files) {
      signal?.throwIfAborted();
      const text = await source.read(file.relativePath);
      if (text === null && file.parseStatus !== 'failed') throw new Error(`Captured source is unavailable: ${file.relativePath}`);
      if (text !== null && createHash('sha256').update(text).digest('hex') !== file.sha256) throw new Error(`Source snapshot hash mismatch: ${file.relativePath}`);
      if (files.length >= 64 || (files.length && bytes + file.sizeBytes > 2 * 1024 * 1024)) await flush();
      files.push(file);
      if (text !== null) { texts.set(file.relativePath, text); bytes += Buffer.byteLength(text, 'utf8'); }
    }
    await flush();
    for (let offset = 0; offset < index.symbols.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertSymbols(connection, index.symbols.slice(offset, offset + batchRows)), signal);
    }
    for (let offset = 0; offset < index.dependencyEdges.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertDependencies(connection, index.dependencyEdges.slice(offset, offset + batchRows)), signal);
    }
    for (let offset = 0; offset < index.diagnostics.length; offset += batchRows) {
      await this.#writeBuilding(index, (connection) => this.#insertDiagnostics(connection, index.diagnostics.slice(offset, offset + batchRows)), signal);
    }
  }

  async appendSearchDocuments(index: StructuralIndex, documents: SearchDocumentRecord[], signal?: AbortSignal): Promise<void> {
    if (documents.length > 2048 || documents.reduce((sum, document) => sum + Buffer.byteLength(document.text, 'utf8'), 0) > 8 * 1024 * 1024 || documents.some((document) => document.kind === 'summary')) throw new Error('Base projection batches accept at most 2048 symbol/source documents and 8 MiB.');
    let facts = this.#projectionFacts.get(index);
    if (!facts) { facts = projectionFactLookup(index); this.#projectionFacts.set(index, facts); }
    validateSearchDocumentsAgainstIndex(index, documents, new Map(), null, facts);
    const texts = documents.map((document) => [document.title, document.relativePath ?? '', document.text].join('\n'));
    signal?.throwIfAborted();
    const embeddings = await this.embedDocuments(texts, signal);
    if (embeddings.length !== documents.length) throw new Error('Embedding provider returned an unexpected document count.');
    await this.#writeBuilding(index, (connection) => insertBatches(connection, `INSERT INTO ${this.#tables.searchDocuments} (
      repository_id, analysis_revision, search_document_id, kind, relative_path, symbol_key, source_range,
      module_artifact_id, content_hash, title, document_text, search_text, embedding
    )`, insertRows(documents, (document, position) => {
      const embedding = embeddings[position]!;
      assertEmbedding(embedding, this.#vectorDimension);
      return { vector: vectorHex(embedding), values: [document.repositoryId, document.analysisRevision, document.searchDocumentId,
        document.kind, document.relativePath, document.symbolKey ?? null, document.sourceRange ? JSON.stringify(document.sourceRange) : null,
        null, document.contentHash, document.title, document.text, texts[position]!] };
    })), signal);
  }

  async getSourceText(scope: RepositoryRevisionScope, relativePath: string): Promise<string | null> {
    assertRelativePath(relativePath, 'Source text path');
    const [rows] = await this.pool.query<FileRow[]>(`
      SELECT source_text FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ?
    `, [...scopeParams(scope), relativePath]);
    return rows[0]?.source_text ?? null;
  }

  async listProjects(scope: RepositoryRevisionScope): Promise<ProjectRecord[]> {
    const [rows] = await this.pool.query<ProjectRow[]>(`
      SELECT project_id, kind, display_name, relative_path, manifest_paths, source_roots, test_roots, language_ids
      FROM ${this.#tables.projects}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY project_id
    `, scopeParams(scope));
    return rows.map((row) => toProject(scope, row));
  }

  async getProject(scope: RepositoryRevisionScope, projectId: string, signal?: AbortSignal): Promise<ProjectRecord | null> {
    const rows = await queryRows<ProjectRow[]>(this.pool, `
      SELECT project_id, kind, display_name, relative_path, manifest_paths, source_roots, test_roots, language_ids
      FROM ${this.#tables.projects}
      WHERE repository_id = ? AND analysis_revision = ? AND project_id = ? LIMIT 1
    `, [...scopeParams(scope), projectId], signal);
    return rows[0] ? toProject(scope, rows[0]) : null;
  }

  async getSourcePreview(scope: RepositoryRevisionScope, relativePath: string, maxChars: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean } | null> {
    assertRelativePath(relativePath, 'Source preview path');
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 32_000) throw new Error('Source preview must be bounded to 1..32000 characters.');
    const rows = await queryRows<RowDataPacket[]>(this.pool, `SELECT SUBSTRING(source_text, 1, ?) AS preview,
      CHAR_LENGTH(source_text) > ? AS truncated FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ? LIMIT 1`,
    [maxChars, maxChars, ...scopeParams(scope), relativePath], signal);
    return rows[0]?.preview == null ? null : { text: String(rows[0].preview), truncated: Boolean(Number(rows[0].truncated)) };
  }

  async queryFiles(scope: RepositoryRevisionScope, query: { projectId?: string; relativePaths?: readonly string[]; after?: string; limit: number }, signal?: AbortSignal): Promise<{ files: IndexedFileRecord[]; truncated: boolean }> {
    validateLocalQuery(query, false);
    const conditions = ['repository_id = ?', 'analysis_revision = ?'];
    const values: unknown[] = scopeParams(scope);
    if (query.projectId) { conditions.push('project_id = ?'); values.push(query.projectId); }
    if (query.relativePaths?.length) { conditions.push(`relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    if (query.after) { conditions.push('relative_path > ?'); values.push(query.after); }
    const rows = await queryRows<FileRow[]>(this.pool, `SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id
      FROM ${this.#tables.files} WHERE ${conditions.join(' AND ')} ORDER BY relative_path LIMIT ?`, [...values, query.limit + 1], signal);
    return { files: rows.slice(0, query.limit).map((row) => toFile(scope, row)), truncated: rows.length > query.limit };
  }

  async querySymbols(scope: RepositoryRevisionScope, query: LocalSymbolQuery, signal?: AbortSignal): Promise<{ symbols: SymbolRecord[]; truncated: boolean }> {
    validateLocalQuery(query);
    const anchors: string[] = [];
    const values: unknown[] = scopeParams(scope);
    if (query.symbolKeys?.length) { anchors.push(`symbol_key IN (${query.symbolKeys.map(() => '?').join(',')})`); values.push(...query.symbolKeys); }
    if (query.relativePaths?.length) { anchors.push(`relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    const conditions = ['repository_id = ?', 'analysis_revision = ?', `(${anchors.join(' OR ')})`];
    if (query.projectId) { conditions.push('project_id = ?'); values.push(query.projectId); }
    if (query.kinds?.length) { conditions.push(`kind IN (${query.kinds.map(() => '?').join(',')})`); values.push(...query.kinds); }
    const rows = await queryRows<SymbolRow[]>(this.pool, `SELECT symbol_id, symbol_key, ast_declaration_id, name, qualified_name, kind, language_id,
      relative_path, source_range, signature, container_symbol_key, project_id, exported, provider, confidence, evidence_level
      FROM ${this.#tables.symbols} WHERE ${conditions.join(' AND ')} ORDER BY symbol_key LIMIT ?`, [...values, query.limit + 1], signal);
    return { symbols: rows.slice(0, query.limit).map((row) => toSymbol(scope, row)), truncated: rows.length > query.limit };
  }

  async queryDependencies(scope: RepositoryRevisionScope, query: LocalDependencyQuery, signal?: AbortSignal): Promise<{ dependencies: DependencyEdgeRecord[]; truncated: boolean }> {
    validateLocalQuery(query);
    if (query.direction && !['incoming', 'outgoing', 'both'].includes(query.direction)) throw new Error('Invalid dependency direction.');
    const anchors: string[] = [];
    const values: unknown[] = scopeParams(scope);
    const sides = query.direction === 'incoming' ? ['target'] : query.direction === 'outgoing' ? ['source'] : ['source', 'target'];
    for (const side of sides) {
      if (query.symbolKeys?.length) { anchors.push(`d.${side}_symbol_key IN (${query.symbolKeys.map(() => '?').join(',')})`); values.push(...query.symbolKeys); }
      if (query.relativePaths?.length) { anchors.push(`d.${side}_relative_path IN (${query.relativePaths.map(() => '?').join(',')})`); values.push(...query.relativePaths); }
    }
    const conditions = ['d.repository_id = ?', 'd.analysis_revision = ?', `(${anchors.join(' OR ')})`];
    if (query.projectId) {
      conditions.push(`EXISTS (SELECT 1 FROM ${this.#tables.files} f WHERE f.repository_id = d.repository_id AND f.analysis_revision = d.analysis_revision
        AND f.project_id = ? AND (f.relative_path = d.source_relative_path OR f.relative_path = d.target_relative_path))`);
      values.push(query.projectId);
    }
    const rows = await queryRows<DependencyRow[]>(this.pool, `SELECT dependency_edge_id, kind, source_symbol_key, target_symbol_key, source_relative_path,
      target_relative_path, target_reference, internal, resolution, provider, confidence, evidence_level, evidence_ranges
      FROM ${this.#tables.dependencyEdges} d WHERE ${conditions.join(' AND ')} ORDER BY dependency_edge_id LIMIT ?`, [...values, query.limit + 1], signal);
    return { dependencies: rows.slice(0, query.limit).map((row) => toDependency(scope, row)), truncated: rows.length > query.limit };
  }

  async getSourceSlice(scope: RepositoryRevisionScope, relativePath: string, range: SourceRange | undefined, maxChars: number, signal?: AbortSignal): Promise<SourceSlice | null> {
    assertRelativePath(relativePath, 'Source slice path');
    sliceSourceText('', range, maxChars);
    const startLine = range?.startLine ?? 1;
    const startColumn = range?.startColumn ?? 1;
    if (startColumn > 128_000) throw new Error('Source slice columns exceed the local read budget.');
    const limit = maxChars + startColumn + 1;
    const rows = await queryRows<FileRow[]>(this.pool, `SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id,
      SUBSTRING(source_text, IF(? = 1, 1, CHAR_LENGTH(SUBSTRING_INDEX(source_text, '\\n', ? - 1)) + 2), ?) AS source_text
      FROM ${this.#tables.files} WHERE repository_id = ? AND analysis_revision = ? AND relative_path = ?
      AND CHAR_LENGTH(source_text) - CHAR_LENGTH(REPLACE(source_text, '\\n', '')) >= ? - 1 LIMIT 1`,
    [startLine, startLine, limit, ...scopeParams(scope), relativePath, startLine], signal);
    const row = rows[0];
    if (!row || row.source_text == null) return null;
    const slice = sliceSourceText(row.source_text, range, maxChars, startLine, row.source_text.length >= limit);
    return slice ? { file: toFile(scope, row), ...slice } : null;
  }

  async getModuleArtifacts(scope: RepositoryRevisionScope, ids: readonly string[], signal?: AbortSignal): Promise<ModuleArtifactRecord[]> {
    if (ids.length > 200) throw new Error('At most 200 artifact IDs may be fetched.');
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await queryRows<ModuleArtifactRow[]>(this.pool, `
      SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
      FROM ${this.#tables.moduleArtifacts}
      WHERE repository_id = ? AND analysis_revision = ? AND module_artifact_id IN (${unique.map(() => '?').join(',')})
      LIMIT 200
    `, [...scopeParams(scope), ...unique], signal);
    return rows.map((row) => toModuleArtifact(scope, row));
  }

  async listFiles(scope: RepositoryRevisionScope): Promise<IndexedFileRecord[]> {
    const [rows] = await this.pool.query<FileRow[]>(`
      SELECT file_id, relative_path, language_id, role, sha256, size_bytes, parse_status, project_id
      FROM ${this.#tables.files}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY relative_path
    `, scopeParams(scope));
    return rows.map((row) => toFile(scope, row));
  }

  async listSymbols(scope: RepositoryRevisionScope): Promise<SymbolRecord[]> {
    const [rows] = await this.pool.query<SymbolRow[]>(`
      SELECT symbol_id, symbol_key, ast_declaration_id, name, qualified_name, kind, language_id,
        relative_path, source_range, signature, container_symbol_key, project_id, exported,
        provider, confidence, evidence_level
      FROM ${this.#tables.symbols}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY symbol_key
    `, scopeParams(scope));
    return rows.map((row) => toSymbol(scope, row));
  }

  async listDependencyEdges(scope: RepositoryRevisionScope): Promise<DependencyEdgeRecord[]> {
    const [rows] = await this.pool.query<DependencyRow[]>(`
      SELECT dependency_edge_id, kind, source_symbol_key, target_symbol_key, source_relative_path,
        target_relative_path, target_reference, internal, resolution, provider, confidence,
        evidence_level, evidence_ranges
      FROM ${this.#tables.dependencyEdges}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY dependency_edge_id
    `, scopeParams(scope));
    return rows.map((row) => toDependency(scope, row));
  }

  async listDiagnostics(scope: RepositoryRevisionScope): Promise<IndexDiagnosticRecord[]> {
    const [rows] = await this.pool.query<DiagnosticRow[]>(`
      SELECT diagnostic_id, severity, message, code, relative_path, source_range, provider, confidence, evidence_level
      FROM ${this.#tables.diagnostics}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY diagnostic_id
    `, scopeParams(scope));
    return rows.map((row) => toDiagnostic(scope, row));
  }

  async putModuleArtifact(artifact: ModuleArtifactRecord): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(artifact));
      const revision = revisions[0];
      if (!revision) throw new Error('Cannot write an artifact for an unknown analysis revision.');
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [artifact.repositoryId]);
      const repository = repositories[0];
      if (!repository) throw new Error('Cannot write an artifact for an unknown repository.');
      if (artifact.kind === 'module-summary' && artifact.status === 'current' && revision.status !== 'ready') {
        throw new Error('A current module summary requires a completed ready analysis revision.');
      }
      validateModuleArtifact(artifact, toRevision(revision), toRepository(repository));
      await connection.query<ResultSetHeader>(`
        INSERT INTO ${this.#tables.moduleArtifacts} (
          repository_id, analysis_revision, module_artifact_id, kind, status, analysis_hash, plan_hash,
          content_hash, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          kind = VALUES(kind), status = VALUES(status), analysis_hash = VALUES(analysis_hash),
          plan_hash = VALUES(plan_hash), content_hash = VALUES(content_hash), updated_at = VALUES(updated_at),
          payload = VALUES(payload)
      `, [
        artifact.repositoryId, artifact.analysisRevision, artifact.moduleArtifactId, artifact.kind,
        artifact.status, artifact.analysisHash, artifact.planHash ?? null, artifact.contentHash,
        artifact.createdAt, artifact.updatedAt, artifact.payload === undefined ? null : JSON.stringify(artifact.payload),
      ]);
    });
  }

  async listModuleArtifacts(scope: RepositoryRevisionScope): Promise<ModuleArtifactRecord[]> {
    const [rows] = await this.pool.query<ModuleArtifactRow[]>(`
      SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
      FROM ${this.#tables.moduleArtifacts}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY module_artifact_id
    `, scopeParams(scope));
    return rows.map((row) => toModuleArtifact(scope, row));
  }

  async replaceSearchDocuments(scope: RepositoryRevisionScope, documents: SearchDocumentRecord[], moduleArtifactId?: string): Promise<void> {
    // Validate scope, document shape, and repository-relative paths before
    // opening the delete-and-replace transaction.
    validateSearchDocumentRecords(scope, documents);
    validateSummaryReplacement(documents, moduleArtifactId);
    const [repository, revision, index, artifacts] = await Promise.all([
      this.getRepository(scope.repositoryId),
      this.getRevision(scope),
      this.getStructuralIndex(scope),
      this.listModuleArtifacts(scope),
    ]);
    if (!repository || !revision || !index) {
      throw new Error('Cannot project search documents before its structural index exists.');
    }
    if (revision.status !== 'building' && revision.status !== 'ready') {
      throw new Error('Search documents may be projected only for a building or ready analysis revision.');
    }
    validateSearchDocumentsAgainstIndex(
      index,
      documents,
      new Map(artifacts.map((artifact) => [artifact.moduleArtifactId, artifact])),
      repository,
    );
    const searchable = documents.map((document) => [
      document.title,
      document.relativePath ?? '',
      document.text,
    ].join('\n'));
    const embeddings = await this.embedDocuments(searchable);
    if (embeddings.length !== documents.length) {
      throw new Error('Search embedding provider returned an unexpected document count.');
    }
    const projected = documents.map((document, index) => {
      const embedding = embeddings[index];
      if (!embedding) throw new Error('Search embedding provider omitted a document vector.');
      assertEmbedding(embedding, this.#vectorDimension);
      return { document, searchText: searchable[index]!, embedding };
    });
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(scope));
      const lockedRevision = revisions[0];
      if (!lockedRevision || (lockedRevision.status !== 'building' && lockedRevision.status !== 'ready')) {
        throw new Error('Search documents may be projected only for a building or ready analysis revision.');
      }
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [scope.repositoryId]);
      const lockedRepository = repositories[0];
      if (!lockedRepository) throw new Error('Cannot project search documents for an unknown repository.');
      const [artifactRows] = await connection.query<ModuleArtifactRow[]>(`
        SELECT module_artifact_id, kind, status, analysis_hash, plan_hash, content_hash, created_at, updated_at, payload
        FROM ${this.#tables.moduleArtifacts}
        WHERE repository_id = ? AND analysis_revision = ?
      `, scopeParams(scope));
      validateSearchDocumentsAgainstIndex(
        index,
        documents,
        new Map(artifactRows.map((artifact) => {
          const converted = toModuleArtifact(scope, artifact);
          return [converted.moduleArtifactId, converted] as const;
        })),
        toRepository(lockedRepository),
      );
      await connection.query(
        `DELETE FROM ${this.#tables.searchDocuments} WHERE repository_id = ? AND analysis_revision = ?${moduleArtifactId === undefined ? '' : " AND kind = 'summary' AND module_artifact_id = ?"}`,
        [...scopeParams(scope), ...(moduleArtifactId === undefined ? [] : [moduleArtifactId])],
      );
      const started = performance.now();
      const statements = await insertBatches(connection, `
          INSERT INTO ${this.#tables.searchDocuments} (
            repository_id, analysis_revision, search_document_id, kind, relative_path, symbol_key, source_range,
            module_artifact_id, content_hash, title, document_text, search_text, embedding
          )
        `, insertRows(projected, ({ document, searchText, embedding }) => ({ vector: vectorHex(embedding), values: [
          document.repositoryId, document.analysisRevision, document.searchDocumentId, document.kind,
          document.relativePath, document.symbolKey ?? null, document.sourceRange ? JSON.stringify(document.sourceRange) : null, document.moduleArtifactId ?? null,
          document.contentHash, document.title, document.text, searchText,
        ] })));
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'search-insert', repositoryId: scope.repositoryId,
        moduleArtifactId, durationMs: Math.round(performance.now() - started), documents: documents.length, insertStatements: statements }));
    });
  }

  async listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]> {
    const [rows] = await this.pool.query<SearchDocumentRow[]>(`
      SELECT search_document_id, kind, relative_path, symbol_key, source_range, module_artifact_id, content_hash, title, document_text
      FROM ${this.#tables.searchDocuments}
      WHERE repository_id = ? AND analysis_revision = ? ORDER BY search_document_id
    `, scopeParams(scope));
    return rows.map((row) => toSearchDocument(scope, row));
  }

  /**
   * Hybrid full-text/vector lookup over the revision-local symbol projection.
   * The structural index remains the source of truth; callers use returned
   * symbol keys only to select authoritative records in the same scope.
   */
  async searchSearchDocuments(
    scope: RepositoryRevisionScope & { projectId?: string },
    query: string,
    limit: number,
    kind: SearchDocumentRecord['kind'] = 'symbol',
    signal?: AbortSignal,
  ): Promise<SearchDocumentRecord[]> {
    signal?.throwIfAborted();
    const text = query.trim();
    if (!text || !Number.isInteger(limit) || limit < 1) return [];
    const boundedLimit = Math.min(limit, 200);
    const embedding = this.#embeddingProvider.embedQuery
      ? await this.#embeddingProvider.embedQuery(text, signal)
      : (await this.#embeddingProvider.embed([text], signal))[0];
    if (!embedding) throw new Error('Search embedding provider omitted a query vector.');
    assertEmbedding(embedding, this.#vectorDimension);
    const candidateLimit = Math.min(Math.max(boundedLimit * 4, 24), 800);
    const select = `
      search_document_id, kind, relative_path, symbol_key, source_range, module_artifact_id, content_hash, title, document_text
    `;
    const textMatch = 'MATCH(d.search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const projectFilter = !scope.projectId ? '' : kind === 'summary'
      ? " AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(document_text), document_text, '{}'), '$.projectId')) = ?"
      : ` AND relative_path IN (SELECT relative_path FROM ${this.#tables.files} WHERE repository_id = ? AND analysis_revision = ? AND project_id = ?)`;
    const projectValues = !scope.projectId ? [] : kind === 'summary' ? [scope.projectId] : [...scopeParams(scope), scope.projectId];
    // The explicit join lets full-text retrieval hash project ownership once instead of running a subquery per match.
    const textProjectJoin = scope.projectId && kind !== 'summary'
      ? ` JOIN ${this.#tables.files} f ON f.repository_id = d.repository_id AND f.analysis_revision = d.analysis_revision
          AND f.relative_path = d.relative_path AND f.project_id = ?` : '';
    const textProjectFilter = scope.projectId && kind === 'summary'
      ? " AND JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(d.document_text), d.document_text, '{}'), '$.projectId')) = ?" : '';
    const [textRows, vectorRows] = await Promise.all([
      queryRows<RowDataPacket[]>(this.pool, `
        SELECT d.search_document_id, ${textMatch} AS text_score
        FROM ${this.#tables.searchDocuments} d${textProjectJoin}
        WHERE d.repository_id = ? AND d.analysis_revision = ? AND d.kind = ?${textProjectFilter} AND ${textMatch}
        ORDER BY text_score DESC
        LIMIT ?
      `, [text, ...(textProjectJoin ? [scope.projectId] : []), ...scopeParams(scope), kind,
        ...(textProjectFilter ? [scope.projectId] : []), text, candidateLimit], signal),
      queryRows<RowDataPacket[]>(this.pool, `
        SELECT search_document_id, GREATEST(0, 1 - cosine_distance(embedding, ${vectorHex(embedding)})) AS semantic_score
        FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND kind = ?${projectFilter}
        ORDER BY cosine_distance(embedding, ${vectorHex(embedding)})
        APPROXIMATE
        LIMIT ?
      `, [...scopeParams(scope), kind, ...projectValues, candidateLimit], signal),
    ]);
    signal?.throwIfAborted();
    const byId = new Map<string, { score: number; retrievalScore: NonNullable<SearchDocumentRecord['retrievalScore']> }>();
    const add = (rows: RowDataPacket[], rankWeight: number): void => {
      rows.forEach((row, index) => {
        const searchDocumentId = stringValue(row.search_document_id)!;
        const existing = byId.get(searchDocumentId);
        const score = (existing?.score ?? 0) + 1 / (60 + index + 1) * rankWeight;
        const retrievalScore = {
          ...existing?.retrievalScore,
          ...(row.semantic_score !== undefined ? { semantic: numberValue(row.semantic_score) } : {}),
          ...(row.text_score !== undefined ? { lexical: numberValue(row.text_score) } : {}),
          fusion: score,
        };
        byId.set(searchDocumentId, { score, retrievalScore });
      });
    };
    add(textRows, 1);
    add(vectorRows, 1);
    const selected = [...byId.entries()]
      .sort(([leftId, left], [rightId, right]) => right.score - left.score || leftId.localeCompare(rightId))
      .slice(0, boundedLimit);
    if (!selected.length) return [];
    // Retrieve long source text only after both ranked candidate sets have been bounded and fused.
    const rows = await queryRows<SearchDocumentRow[]>(this.pool, `SELECT ${select} FROM ${this.#tables.searchDocuments}
      WHERE repository_id = ? AND analysis_revision = ? AND search_document_id IN (${selected.map(() => '?').join(',')})
      LIMIT ?`, [...scopeParams(scope), ...selected.map(([searchDocumentId]) => searchDocumentId), boundedLimit], signal);
    const documents = new Map(rows.map(row => {
      const document = toSearchDocument(scope, row);
      return [document.searchDocumentId, document] as const;
    }));
    return selected.flatMap(([searchDocumentId, scores]) => {
      const document = documents.get(searchDocumentId);
      return document ? [{ ...document, retrievalScore: scores.retrievalScore }] : [];
    });
  }

  async activateRevision(
    scope: RepositoryRevisionScope,
    status: Extract<RepositoryAnalysisStatus, 'ready' | 'degraded'> = 'ready',
  ): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const [revisions] = await connection.query<RevisionRow[]>(`
        SELECT * FROM ${this.#tables.analysisRevisions}
        WHERE repository_id = ? AND analysis_revision = ? FOR UPDATE
      `, scopeParams(scope));
      const revision = revisions[0];
      if (!revision || revision.status !== 'ready') throw new Error('Only a ready revision can be activated.');
      if (!revision.completed_at || revision.failure_reason !== null) {
        throw new Error('Only a completed successful analysis revision can be activated.');
      }
      const [repositories] = await connection.query<RepositoryRow[]>(`
        SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ? FOR UPDATE
      `, [scope.repositoryId]);
      const repository = repositories[0];
      if (!repository) throw new Error('Cannot activate a revision for an unknown repository.');
      const previousRevision = stringValue(repository.active_revision);
      if (previousRevision === scope.analysisRevision) return;
      const now = new Date().toISOString();
      if (previousRevision && previousRevision !== scope.analysisRevision) {
        await connection.query(`
          UPDATE ${this.#tables.analysisRevisions}
          SET status = 'superseded'
          WHERE repository_id = ? AND analysis_revision = ? AND status = 'ready'
        `, [scope.repositoryId, previousRevision]);
        await connection.query(`
          UPDATE ${this.#tables.moduleArtifacts}
          SET status = 'stale', updated_at = ?
          WHERE repository_id = ? AND analysis_revision = ? AND status = 'current'
        `, [now, scope.repositoryId, previousRevision]);
        // Summary projections have no mutable status column. Drop only those
        // documents when their bound artifact becomes stale; the prior
        // revision's source/symbol projections remain queryable by scope.
        await connection.query(`
          DELETE FROM ${this.#tables.searchDocuments}
          WHERE repository_id = ? AND analysis_revision = ? AND kind = 'summary'
        `, [scope.repositoryId, previousRevision]);
      }
      await connection.query(`
        UPDATE ${this.#tables.analysisRevisions}
        SET activated_at = ? WHERE repository_id = ? AND analysis_revision = ?
      `, [now, ...scopeParams(scope)]);
      await connection.query(`
        UPDATE ${this.#tables.repositories}
        SET active_revision = ?, analysis_status = ?, updated_at = ? WHERE repository_id = ?
      `, [scope.analysisRevision, status, now, scope.repositoryId]);
    });
  }

  async #deleteRevisionStructuralRecords(connection: PoolConnection, scope: RepositoryRevisionScope): Promise<void> {
    const tables = [
      this.#tables.dependencyEdges,
      this.#tables.symbols,
      this.#tables.files,
      this.#tables.projects,
      this.#tables.diagnostics,
    ];
    for (const table of tables) {
      await connection.query(`DELETE FROM ${table} WHERE repository_id = ? AND analysis_revision = ?`, scopeParams(scope));
    }
  }

  async #insertProjects(connection: PoolConnection, projects: ProjectRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.projects} (
        repository_id, analysis_revision, project_id, kind, display_name, relative_path,
        manifest_paths, source_roots, test_roots, language_ids
      )
    `, insertRows(projects, (project) => ({ values: [
      project.repositoryId, project.analysisRevision, project.projectId, project.kind, project.displayName,
      project.relativePath, JSON.stringify(project.manifestPaths), JSON.stringify(project.sourceRoots),
      JSON.stringify(project.testRoots), JSON.stringify(project.languageIds),
    ] })));
  }

  async #insertFiles(connection: PoolConnection, files: IndexedFileRecord[], sourceTexts: ReadonlyMap<string, string>): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.files} (
        repository_id, analysis_revision, file_id, relative_path, language_id, role, sha256,
        size_bytes, parse_status, project_id, source_text
      )
    `, insertRows(files, (file) => ({ values: [
      file.repositoryId, file.analysisRevision, file.fileId, file.relativePath, file.languageId ?? null,
      file.role, file.sha256, file.sizeBytes, file.parseStatus, file.projectId ?? null, sourceTexts.get(file.relativePath) ?? null,
    ] })));
  }

  async #insertSymbols(connection: PoolConnection, symbols: SymbolRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.symbols} (
        repository_id, analysis_revision, symbol_id, symbol_key, ast_declaration_id, name, qualified_name,
        kind, language_id, relative_path, source_range, signature, container_symbol_key, project_id,
        exported, provider, confidence, evidence_level
      )
    `, insertRows(symbols, (symbol) => ({ values: [
      symbol.repositoryId, symbol.analysisRevision, symbol.symbolId, symbol.symbolKey, symbol.astDeclarationId,
      symbol.name, symbol.qualifiedName, symbol.kind, symbol.languageId, symbol.relativePath,
      JSON.stringify(symbol.sourceRange), symbol.signature ?? null, symbol.containerSymbolKey ?? null,
      symbol.projectId ?? null, symbol.exported, symbol.provider, symbol.confidence, symbol.evidenceLevel,
    ] })));
  }

  async #insertDependencies(connection: PoolConnection, edges: DependencyEdgeRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.dependencyEdges} (
        repository_id, analysis_revision, dependency_edge_id, kind, source_symbol_key, target_symbol_key,
        source_relative_path, target_relative_path, target_reference, internal, resolution, provider,
        confidence, evidence_level, evidence_ranges
      )
    `, insertRows(edges, (edge) => ({ values: [
      edge.repositoryId, edge.analysisRevision, edge.dependencyEdgeId, edge.kind,
      edge.sourceSymbolKey ?? null, edge.targetSymbolKey ?? null, edge.sourceRelativePath,
      edge.targetRelativePath ?? null, edge.targetReference ?? null, edge.internal, edge.resolution,
      edge.provider, edge.confidence, edge.evidenceLevel, JSON.stringify(edge.evidenceRanges),
    ] })));
  }

  async #insertDiagnostics(connection: PoolConnection, diagnostics: IndexDiagnosticRecord[]): Promise<number> {
    return insertBatches(connection, `
      INSERT INTO ${this.#tables.diagnostics} (
        repository_id, analysis_revision, diagnostic_id, severity, message, code, relative_path,
        source_range, provider, confidence, evidence_level
      )
    `, insertRows(diagnostics, (diagnostic) => ({ values: [
      diagnostic.repositoryId, diagnostic.analysisRevision, diagnostic.diagnosticId, diagnostic.severity,
      diagnostic.message, diagnostic.code ?? null, diagnostic.relativePath,
      diagnostic.sourceRange === null ? null : JSON.stringify(diagnostic.sourceRange), diagnostic.provider,
      diagnostic.confidence, diagnostic.evidenceLevel,
    ] })));
  }
}

export const seekDbIndexStoreInternals = {
  withTransaction,
  insertBatches,
  assertEmbedding,
  identifier,
  json,
  jsonArray,
  stringValue,
  toDependency,
  toDiagnostic,
  toFile,
  toProject,
  toRepository,
  toRevision,
  toSearchDocument,
  toSymbol,
  vectorHex,
};
