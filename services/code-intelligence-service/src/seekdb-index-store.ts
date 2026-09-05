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
  type IndexStore,
} from './index-store.js';
import {
  HashSearchEmbeddingProvider,
  type SearchEmbeddingProvider,
} from './search-embedding.js';

export interface SeekDbIndexStoreConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Kept for the vector-capable search_documents projection. */
  vectorDimension?: number;
  /** Host-configured model embedding provider; deterministic hashing is the safe local fallback. */
  embeddingProvider?: SearchEmbeddingProvider;
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
    ...(moduleArtifactId ? { moduleArtifactId } : {}),
    contentHash: row.content_hash,
    title: row.title,
    text: row.document_text,
  };
}

async function withTransaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const value = await operation(connection);
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * SeekDB persistence for the authoritative revision model. It uses dedicated
 * tables instead of expanding legacy `code_symbols`; each replacement DELETE
 * is bound to one repository + analysis revision.
 */
export class SeekDbIndexStore implements IndexStore {
  readonly #database: string;
  readonly #tables: Record<string, string>;
  readonly #vectorDimension: number;
  readonly #embeddingProvider: SearchEmbeddingProvider;

  constructor(config: SeekDbIndexStoreConfig, private readonly pool: Pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectionLimit: 8,
    enableKeepAlive: true,
    decimalNumbers: true,
  } satisfies PoolOptions)) {
    this.#database = identifier(config.database);
    this.#vectorDimension = config.vectorDimension ?? 384;
    if (!Number.isInteger(this.#vectorDimension) || this.#vectorDimension < 1) {
      throw new Error('SeekDB vectorDimension must be a positive integer.');
    }
    this.#embeddingProvider = config.embeddingProvider ?? new HashSearchEmbeddingProvider(this.#vectorDimension);
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
      diagnostics: qualify('index_diagnostics'),
    };
  }

  async initialize(): Promise<void> {
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
        UNIQUE KEY uq_files_path (repository_id, analysis_revision, relative_path)
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
        module_artifact_id VARCHAR(256) NULL,
        content_hash CHAR(64) NOT NULL,
        title VARCHAR(2048) NOT NULL,
        document_text LONGTEXT NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.#vectorDimension}) NOT NULL,
        PRIMARY KEY (repository_id, analysis_revision, search_document_id),
        FULLTEXT INDEX idx_search_documents_text (search_text) WITH PARSER ik,
        VECTOR INDEX idx_search_documents_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
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

  async getRepository(repositoryId: RepositoryId): Promise<RepositoryRecord | null> {
    const [rows] = await this.pool.query<RepositoryRow[]>(
      `SELECT * FROM ${this.#tables.repositories} WHERE repository_id = ?`, [repositoryId],
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

  async getRevision(scope: RepositoryRevisionScope): Promise<AnalysisRevisionRecord | null> {
    const [rows] = await this.pool.query<RevisionRow[]>(`
      SELECT * FROM ${this.#tables.analysisRevisions}
      WHERE repository_id = ? AND analysis_revision = ?
    `, scopeParams(scope));
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
      for (const project of index.projects) await this.#insertProject(connection, project);
      for (const file of index.files) await this.#insertFile(connection, file, sourceTexts.get(file.relativePath) ?? null);
      for (const symbol of index.symbols) await this.#insertSymbol(connection, symbol);
      for (const edge of index.dependencyEdges) await this.#insertDependency(connection, edge);
      for (const diagnostic of index.diagnostics) await this.#insertDiagnostic(connection, diagnostic);
    });
  }

  async getStructuralIndex(scope: RepositoryRevisionScope): Promise<StructuralIndex | null> {
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
    const index = await this.getStructuralIndex(artifact);
    if (!index) throw new Error('Cannot write a module artifact before its structural index exists.');
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
      validateModuleArtifact(artifact, index, toRepository(repository));
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

  async replaceSearchDocuments(scope: RepositoryRevisionScope, documents: SearchDocumentRecord[]): Promise<void> {
    // Validate scope, document shape, and repository-relative paths before
    // opening the delete-and-replace transaction.
    validateSearchDocumentRecords(scope, documents);
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
    const embeddings = await this.#embeddingProvider.embed(searchable);
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
      await connection.query(`DELETE FROM ${this.#tables.searchDocuments} WHERE repository_id = ? AND analysis_revision = ?`, scopeParams(scope));
      for (const { document, searchText, embedding } of projected) {
        await connection.query(`
          INSERT INTO ${this.#tables.searchDocuments} (
            repository_id, analysis_revision, search_document_id, kind, relative_path, symbol_key,
            module_artifact_id, content_hash, title, document_text, search_text, embedding
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vectorHex(embedding)})
        `, [
          document.repositoryId, document.analysisRevision, document.searchDocumentId, document.kind,
          document.relativePath, document.symbolKey ?? null, document.moduleArtifactId ?? null,
          document.contentHash, document.title, document.text, searchText,
        ]);
      }
    });
  }

  async listSearchDocuments(scope: RepositoryRevisionScope): Promise<SearchDocumentRecord[]> {
    const [rows] = await this.pool.query<SearchDocumentRow[]>(`
      SELECT search_document_id, kind, relative_path, symbol_key, module_artifact_id, content_hash, title, document_text
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
    scope: RepositoryRevisionScope,
    query: string,
    limit: number,
    kind: SearchDocumentRecord['kind'] = 'symbol',
  ): Promise<SearchDocumentRecord[]> {
    const text = query.trim();
    if (!text || !Number.isInteger(limit) || limit < 1) return [];
    const boundedLimit = Math.min(limit, 200);
    const [embedding] = await this.#embeddingProvider.embed([text]);
    if (!embedding) throw new Error('Search embedding provider omitted a query vector.');
    assertEmbedding(embedding, this.#vectorDimension);
    const candidateLimit = Math.min(Math.max(boundedLimit * 4, 24), 800);
    const select = `
      search_document_id, kind, relative_path, symbol_key, module_artifact_id, content_hash, title, document_text
    `;
    const textMatch = 'MATCH(search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const [textRows, vectorRows] = await Promise.all([
      this.pool.query<SearchDocumentRow[]>(`
        SELECT ${select}, ${textMatch} AS text_score
        FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND kind = ? AND ${textMatch}
        ORDER BY text_score DESC
        LIMIT ?
      `, [text, ...scopeParams(scope), kind, text, candidateLimit]),
      this.pool.query<SearchDocumentRow[]>(`
        SELECT ${select}, GREATEST(0, 1 - cosine_distance(embedding, ${vectorHex(embedding)})) AS semantic_score
        FROM ${this.#tables.searchDocuments}
        WHERE repository_id = ? AND analysis_revision = ? AND kind = ?
        ORDER BY cosine_distance(embedding, ${vectorHex(embedding)})
        APPROXIMATE
        LIMIT ?
      `, [...scopeParams(scope), kind, candidateLimit]),
    ]);
    const byId = new Map<string, { document: SearchDocumentRecord; score: number }>();
    const add = (rows: SearchDocumentRow[], rankWeight: number): void => {
      rows.forEach((row, index) => {
        const document = toSearchDocument(scope, row);
        const existing = byId.get(document.searchDocumentId);
        const score = (existing?.score ?? 0) + 1 / (60 + index + 1) * rankWeight;
        byId.set(document.searchDocumentId, { document, score });
      });
    };
    add(textRows[0], 1);
    add(vectorRows[0], 1);
    return [...byId.values()]
      .sort((left, right) => right.score - left.score || left.document.searchDocumentId.localeCompare(right.document.searchDocumentId))
      .slice(0, boundedLimit)
      .map(({ document }) => document);
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

  async #insertProject(connection: PoolConnection, project: ProjectRecord): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.#tables.projects} (
        repository_id, analysis_revision, project_id, kind, display_name, relative_path,
        manifest_paths, source_roots, test_roots, language_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      project.repositoryId, project.analysisRevision, project.projectId, project.kind, project.displayName,
      project.relativePath, JSON.stringify(project.manifestPaths), JSON.stringify(project.sourceRoots),
      JSON.stringify(project.testRoots), JSON.stringify(project.languageIds),
    ]);
  }

  async #insertFile(connection: PoolConnection, file: IndexedFileRecord, sourceText: string | null): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.#tables.files} (
        repository_id, analysis_revision, file_id, relative_path, language_id, role, sha256,
        size_bytes, parse_status, project_id, source_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      file.repositoryId, file.analysisRevision, file.fileId, file.relativePath, file.languageId ?? null,
      file.role, file.sha256, file.sizeBytes, file.parseStatus, file.projectId ?? null, sourceText,
    ]);
  }

  async #insertSymbol(connection: PoolConnection, symbol: SymbolRecord): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.#tables.symbols} (
        repository_id, analysis_revision, symbol_id, symbol_key, ast_declaration_id, name, qualified_name,
        kind, language_id, relative_path, source_range, signature, container_symbol_key, project_id,
        exported, provider, confidence, evidence_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      symbol.repositoryId, symbol.analysisRevision, symbol.symbolId, symbol.symbolKey, symbol.astDeclarationId,
      symbol.name, symbol.qualifiedName, symbol.kind, symbol.languageId, symbol.relativePath,
      JSON.stringify(symbol.sourceRange), symbol.signature ?? null, symbol.containerSymbolKey ?? null,
      symbol.projectId ?? null, symbol.exported, symbol.provider, symbol.confidence, symbol.evidenceLevel,
    ]);
  }

  async #insertDependency(connection: PoolConnection, edge: DependencyEdgeRecord): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.#tables.dependencyEdges} (
        repository_id, analysis_revision, dependency_edge_id, kind, source_symbol_key, target_symbol_key,
        source_relative_path, target_relative_path, target_reference, internal, resolution, provider,
        confidence, evidence_level, evidence_ranges
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      edge.repositoryId, edge.analysisRevision, edge.dependencyEdgeId, edge.kind,
      edge.sourceSymbolKey ?? null, edge.targetSymbolKey ?? null, edge.sourceRelativePath,
      edge.targetRelativePath ?? null, edge.targetReference ?? null, edge.internal, edge.resolution,
      edge.provider, edge.confidence, edge.evidenceLevel, JSON.stringify(edge.evidenceRanges),
    ]);
  }

  async #insertDiagnostic(connection: PoolConnection, diagnostic: IndexDiagnosticRecord): Promise<void> {
    await connection.query(`
      INSERT INTO ${this.#tables.diagnostics} (
        repository_id, analysis_revision, diagnostic_id, severity, message, code, relative_path,
        source_range, provider, confidence, evidence_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      diagnostic.repositoryId, diagnostic.analysisRevision, diagnostic.diagnosticId, diagnostic.severity,
      diagnostic.message, diagnostic.code ?? null, diagnostic.relativePath,
      diagnostic.sourceRange === null ? null : JSON.stringify(diagnostic.sourceRange), diagnostic.provider,
      diagnostic.confidence, diagnostic.evidenceLevel,
    ]);
  }
}

export const seekDbIndexStoreInternals = {
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
