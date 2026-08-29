import mysql, {
  type Pool,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { RetrievalConfig } from './config.js';
import type {
  IndexedCodeDocument,
  RetrievedCodeDocument,
  SearchFilters,
  SearchStore,
} from './types.js';
import { expandedSearchText } from './text-analysis.js';
import { requireRepositoryScopes } from './repository-scope.js';

interface CodeSymbolRow extends RowDataPacket {
  id: string | Buffer;
  title: string;
  repository: string;
  license: string;
  language: IndexedCodeDocument['language'];
  kind: IndexedCodeDocument['kind'];
  path: string;
  signature: string;
  summary: string;
  preview: string;
  dependencies: string | string[];
  compatibility: string | string[];
  risks: string | string[];
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

function parseStringArray(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function number(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapRow(row: CodeSymbolRow): RetrievedCodeDocument {
  return {
    id: Buffer.isBuffer(row.id) ? row.id.toString('utf8') : String(row.id),
    title: row.title,
    repository: row.repository,
    license: row.license,
    language: row.language,
    kind: row.kind,
    path: row.path,
    signature: row.signature,
    summary: row.summary,
    preview: row.preview,
    dependencies: parseStringArray(row.dependencies),
    compatibility: parseStringArray(row.compatibility),
    risks: parseStringArray(row.risks),
    semanticScore: number(row.semantic_score),
    textScore: number(row.text_score),
  };
}

function filterSql(filters: SearchFilters): { sql: string; parameters: string[] } {
  const clauses: string[] = [];
  const parameters: string[] = [];
  const repositories = requireRepositoryScopes(filters.repositories);
  clauses.push(`repository IN (${repositories.map(() => '?').join(', ')})`);
  parameters.push(...repositories);
  if (filters.languages.length > 0) {
    clauses.push(`language IN (${filters.languages.map(() => '?').join(', ')})`);
    parameters.push(...filters.languages);
  }
  if (filters.kinds.length > 0) {
    clauses.push(`kind IN (${filters.kinds.map(() => '?').join(', ')})`);
    parameters.push(...filters.kinds);
  }
  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    parameters,
  };
}

const selectedColumns = `
  id, title, repository, license, language, kind, path, signature,
  summary, preview, dependencies, compatibility, risks
`;

export class SeekDbStore implements SearchStore {
  private readonly pool: Pool;
  private readonly qualifiedTable: string;
  private readonly database: string;
  private readonly table: string;
  private readonly dimension: number;

  constructor(config: RetrievalConfig['seekdb'], pool?: Pool) {
    this.database = config.database;
    this.table = config.table;
    this.dimension = config.vectorDimension;
    this.qualifiedTable = `${quoteIdentifier(config.database)}.${quoteIdentifier(config.table)}`;
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
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (
        id VARBINARY(512) PRIMARY KEY NOT NULL,
        title VARCHAR(512) NOT NULL,
        repository VARCHAR(512) NOT NULL,
        license VARCHAR(128) NOT NULL,
        language VARCHAR(64) NOT NULL,
        kind VARCHAR(32) NOT NULL,
        path VARCHAR(1024) NOT NULL,
        signature TEXT NOT NULL,
        summary TEXT NOT NULL,
        preview TEXT NOT NULL,
        dependencies JSON NOT NULL,
        compatibility JSON NOT NULL,
        risks JSON NOT NULL,
        search_text STRING NOT NULL,
        embedding VECTOR(${this.dimension}) NOT NULL,
        FULLTEXT INDEX idx_code_text(search_text) WITH PARSER ik,
        VECTOR INDEX idx_code_embedding (embedding)
          WITH (DISTANCE=cosine, TYPE=hnsw, LIB=vsag)
      ) ORGANIZATION = HEAP
    `);
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.qualifiedTable}`);
  }

  async upsert(documents: Array<IndexedCodeDocument & { embedding: number[] }>): Promise<void> {
    if (documents.length === 0) return;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const document of documents) {
        if (document.embedding.length !== this.dimension) {
          throw new Error(
            `Embedding for ${document.id} has ${document.embedding.length} dimensions; expected ${this.dimension}.`,
          );
        }
        const searchableSource = [
          document.title,
          document.repository,
          document.path,
          document.signature,
          document.summary,
          document.content || document.preview,
          document.dependencies.join(' '),
        ].join('\n');
        const searchable = `${searchableSource}\n${expandedSearchText(searchableSource)}`;
        const values = [
          document.id,
          document.title,
          document.repository,
          document.license,
          document.language,
          document.kind,
          document.path,
          document.signature,
          document.summary,
          document.preview,
          JSON.stringify(document.dependencies),
          JSON.stringify(document.compatibility),
          JSON.stringify(document.risks),
          searchable,
        ];
        await connection.query<ResultSetHeader>(
          `
            INSERT INTO ${this.qualifiedTable} (
              id, title, repository, license, language, kind, path, signature,
              summary, preview, dependencies, compatibility, risks, search_text, embedding
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vectorHex(document.embedding)})
            ON DUPLICATE KEY UPDATE
              title = VALUES(title),
              repository = VALUES(repository),
              license = VALUES(license),
              language = VALUES(language),
              kind = VALUES(kind),
              path = VALUES(path),
              signature = VALUES(signature),
              summary = VALUES(summary),
              preview = VALUES(preview),
              dependencies = VALUES(dependencies),
              compatibility = VALUES(compatibility),
              risks = VALUES(risks),
              search_text = VALUES(search_text),
              embedding = VALUES(embedding)
          `,
          values,
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

  async refreshIndex(): Promise<void> {
    await this.pool.query('CALL dbms_index_manager.refresh()');
  }

  async semanticSearch(
    embedding: number[],
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]> {
    if (embedding.length !== this.dimension) {
      throw new Error(`Query embedding has ${embedding.length} dimensions; expected ${this.dimension}.`);
    }
    const where = filterSql(filters);
    const vector = vectorHex(embedding);
    const [rows] = await this.pool.query<CodeSymbolRow[]>(
      `
        SELECT ${selectedColumns},
               GREATEST(0, 1 - cosine_distance(embedding, ${vector})) AS semantic_score
        FROM ${this.qualifiedTable}
        ${where.sql}
        ORDER BY cosine_distance(embedding, ${vector})
        APPROXIMATE
        LIMIT ?
      `,
      [...where.parameters, limit],
    );
    return rows.map(mapRow);
  }

  async textSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]> {
    const where = filterSql(filters);
    const match = 'MATCH(search_text) AGAINST (? IN NATURAL LANGUAGE MODE)';
    const prefix = where.sql ? `${where.sql} AND` : 'WHERE';
    const [rows] = await this.pool.query<CodeSymbolRow[]>(
      `
        SELECT ${selectedColumns}, ${match} AS text_score
        FROM ${this.qualifiedTable}
        ${prefix} ${match}
        ORDER BY text_score DESC
        LIMIT ?
      `,
      [query, ...where.parameters, query, limit],
    );
    const maxScore = Math.max(...rows.map((row) => Number(row.text_score) || 0), 1);
    return rows.map((row) =>
      mapRow({
        ...row,
        text_score: Math.min(1, (Number(row.text_score) || 0) / maxScore),
      } as CodeSymbolRow),
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const seekDbInternals = { vectorHex, filterSql };
