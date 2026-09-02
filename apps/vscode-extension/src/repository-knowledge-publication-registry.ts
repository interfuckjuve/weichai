import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type {
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
} from '@forexplore/contracts';
import { canonicalJson, sha256Hex } from '@forexplore/workflow-core';

const databaseRelativePath = '.forexplore/control-plane/registry.sqlite';
const lockRelativePath = '.forexplore/control-plane/registry.lock';
const schemaVersion = 1;

export interface RepositoryKnowledgeRegistrySnapshot {
  scope: RepositoryKnowledgePublicationScope;
  maxGeneration: number;
  head?: RepositoryKnowledgePublicationHead;
  publications: RepositoryKnowledgePublication[];
  currentProjectionDirty: boolean;
}

export interface ActivateRepositoryKnowledgeRegistryInput {
  repositoryRoot: string;
  publication: RepositoryKnowledgePublication;
  head: RepositoryKnowledgePublicationHead;
  expectedHeadHash: string | null;
  occurredAt: string;
}

export interface WithdrawRepositoryKnowledgeRegistryInput {
  repositoryRoot: string;
  publication: RepositoryKnowledgePublication;
  restoredPublication?: RepositoryKnowledgePublication;
  head?: RepositoryKnowledgePublicationHead;
  expectedHeadHash: string;
  occurredAt: string;
  reason: string;
}

export interface RepositoryKnowledgePublicationRegistry {
  read(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
  ): Promise<RepositoryKnowledgeRegistrySnapshot>;
  stage(
    repositoryRoot: string,
    publication: RepositoryKnowledgePublication,
    occurredAt: string,
  ): Promise<RepositoryKnowledgeRegistrySnapshot>;
  activate(input: ActivateRepositoryKnowledgeRegistryInput): Promise<RepositoryKnowledgeRegistrySnapshot>;
  withdraw(input: WithdrawRepositoryKnowledgeRegistryInput): Promise<RepositoryKnowledgeRegistrySnapshot>;
  markCurrentProjectionSynchronized(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
    expectedHeadHash: string | null,
  ): Promise<boolean>;
}

export interface SqliteRepositoryKnowledgePublicationRegistryDependencies {
  initializeSqlJs?: () => Promise<SqlJsStatic>;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Portable SQLite registry for the VS Code extension host.
 *
 * sql.js avoids an Electron native-ABI dependency. Since sql.js exports a
 * complete SQLite image instead of holding an OS-backed connection, all writes
 * are serialized by a repository-local exclusive lock and published using a
 * durable temporary file followed by an atomic rename. SQL transactions still
 * enforce the domain CAS while the lock makes the exported image linearizable.
 */
export class SqliteRepositoryKnowledgePublicationRegistry
implements RepositoryKnowledgePublicationRegistry {
  private readonly initializeSqlJs: () => Promise<SqlJsStatic>;
  private sqlPromise: Promise<SqlJsStatic> | undefined;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLockMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(dependencies: SqliteRepositoryKnowledgePublicationRegistryDependencies = {}) {
    this.initializeSqlJs = dependencies.initializeSqlJs ?? defaultInitializeSqlJs;
    this.lockTimeoutMs = dependencies.lockTimeoutMs ?? 5_000;
    this.lockRetryMs = dependencies.lockRetryMs ?? 20;
    this.staleLockMs = dependencies.staleLockMs ?? 30_000;
    this.sleep = dependencies.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async read(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
  ): Promise<RepositoryKnowledgeRegistrySnapshot> {
    validateScope(scope);
    const database = await this.openDatabase(repositoryRoot);
    try {
      return readSnapshot(database, scope);
    } finally {
      database.close();
    }
  }

  async stage(
    repositoryRoot: string,
    publication: RepositoryKnowledgePublication,
    occurredAt: string,
  ): Promise<RepositoryKnowledgeRegistrySnapshot> {
    assertPublicationState(publication, 'staged');
    return this.write(repositoryRoot, (database) => {
      const before = readSnapshot(database, publication.scope);
      const existing = before.publications.find((candidate) => candidate.id === publication.id);
      if (existing !== undefined) {
        if (existing.contentHash !== publication.contentHash) {
          throw new Error('Repository knowledge publication ID already has different content.');
        }
        return before;
      }
      if (publication.generation !== before.maxGeneration + 1) {
        throw new Error('Repository knowledge publication generation compare-and-swap conflict.');
      }
      database.run('BEGIN IMMEDIATE');
      try {
        ensureScope(database, publication.scope);
        database.run(
          `INSERT INTO publications (
             id, repository_id, channel, generation, status, payload_hash,
             publication_hash, publication_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            publication.id,
            publication.scope.repositoryId,
            publication.scope.channel,
            publication.generation,
            publication.status,
            publication.payloadHash,
            publication.contentHash,
            canonicalJson(publication),
          ],
        );
        database.run(
          `UPDATE publication_scopes
             SET max_generation = ?, updated_at = ?
           WHERE repository_id = ? AND channel = ?`,
          [
            publication.generation,
            occurredAt,
            publication.scope.repositoryId,
            publication.scope.channel,
          ],
        );
        insertEvent(database, publication.scope, publication.id, 'staged', occurredAt, publication);
        database.run('COMMIT');
      } catch (error) {
        rollback(database);
        throw error;
      }
      return readSnapshot(database, publication.scope);
    });
  }

  async activate(
    input: ActivateRepositoryKnowledgeRegistryInput,
  ): Promise<RepositoryKnowledgeRegistrySnapshot> {
    assertPublicationState(input.publication, 'active');
    assertHead(input.head, input.publication);
    return this.write(input.repositoryRoot, (database) => {
      const before = readSnapshot(database, input.publication.scope);
      assertExpectedHead(before.head, input.expectedHeadHash);
      const target = requirePublication(before, input.publication.id);
      if (target.status !== 'staged' && target.status !== 'withdrawn') {
        throw new Error(`Repository knowledge publication cannot be activated from ${target.status}.`);
      }
      const oldHead = before.head;
      if (input.publication.previousPublicationId !== oldHead?.publicationId) {
        throw new Error('Activation previous publication does not match the exact CAS head.');
      }
      database.run('BEGIN IMMEDIATE');
      try {
        updatePublication(database, input.publication);
        database.run(
          `UPDATE publication_scopes
             SET active_publication_id = ?, head_hash = ?, head_json = ?,
                 current_projection_dirty = 1, updated_at = ?
           WHERE repository_id = ? AND channel = ?`,
          [
            input.head.publicationId,
            input.head.contentHash,
            canonicalJson(input.head),
            input.occurredAt,
            input.publication.scope.repositoryId,
            input.publication.scope.channel,
          ],
        );
        insertEvent(
          database,
          input.publication.scope,
          input.publication.id,
          'activated',
          input.occurredAt,
          input.publication,
        );
        database.run('COMMIT');
      } catch (error) {
        rollback(database);
        throw error;
      }
      return readSnapshot(database, input.publication.scope);
    });
  }

  async withdraw(
    input: WithdrawRepositoryKnowledgeRegistryInput,
  ): Promise<RepositoryKnowledgeRegistrySnapshot> {
    assertPublicationState(input.publication, 'withdrawn');
    if (input.restoredPublication !== undefined) {
      assertPublicationState(input.restoredPublication, 'active');
      assertSameScope(input.publication.scope, input.restoredPublication.scope);
      if (input.head === undefined) {
        throw new Error('A restored publication requires a replacement head.');
      }
      assertHead(input.head, input.restoredPublication);
    } else if (input.head !== undefined) {
      throw new Error('A replacement head requires a restored publication.');
    }
    return this.write(input.repositoryRoot, (database) => {
      const before = readSnapshot(database, input.publication.scope);
      assertExpectedHead(before.head, input.expectedHeadHash);
      if (before.head?.publicationId !== input.publication.id) {
        throw new Error('Only the active repository knowledge publication can be withdrawn.');
      }
      const active = requirePublication(before, input.publication.id);
      if (active.status !== 'active' || input.publication.previousStateHash !== active.contentHash) {
        throw new Error('Withdrawal does not carry the exact active publication state.');
      }
      if (input.restoredPublication !== undefined) {
        const previous = requirePublication(before, input.restoredPublication.id);
        if (
          input.publication.previousPublicationId !== previous.id ||
          input.restoredPublication.contentHash !== previous.contentHash
        ) {
          throw new Error('Withdrawal does not carry the exact predecessor state.');
        }
      }
      database.run('BEGIN IMMEDIATE');
      try {
        updatePublication(database, input.publication);
        insertEvent(
          database,
          input.publication.scope,
          input.publication.id,
          'withdrawn',
          input.occurredAt,
          { publication: input.publication, reason: input.reason },
        );
        if (input.restoredPublication !== undefined) {
          updatePublication(database, input.restoredPublication);
          insertEvent(
            database,
            input.publication.scope,
            input.restoredPublication.id,
            'restored',
            input.occurredAt,
            input.restoredPublication,
          );
        }
        database.run(
          `UPDATE publication_scopes
             SET active_publication_id = ?, head_hash = ?, head_json = ?,
                 current_projection_dirty = 1, updated_at = ?
           WHERE repository_id = ? AND channel = ?`,
          [
            input.head?.publicationId ?? null,
            input.head?.contentHash ?? null,
            input.head === undefined ? null : canonicalJson(input.head),
            input.occurredAt,
            input.publication.scope.repositoryId,
            input.publication.scope.channel,
          ],
        );
        database.run('COMMIT');
      } catch (error) {
        rollback(database);
        throw error;
      }
      return readSnapshot(database, input.publication.scope);
    });
  }

  async markCurrentProjectionSynchronized(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
    expectedHeadHash: string | null,
  ): Promise<boolean> {
    return this.write(repositoryRoot, (database) => {
      const before = readSnapshot(database, scope);
      if ((before.head?.contentHash ?? null) !== expectedHeadHash) return false;
      database.run(
        `UPDATE publication_scopes SET current_projection_dirty = 0
         WHERE repository_id = ? AND channel = ?`,
        [scope.repositoryId, scope.channel],
      );
      return true;
    });
  }

  private async sql(): Promise<SqlJsStatic> {
    this.sqlPromise ??= this.initializeSqlJs();
    return this.sqlPromise;
  }

  private async openDatabase(repositoryRoot: string): Promise<Database> {
    const SQL = await this.sql();
    const databasePath = resolveRegistryPath(repositoryRoot, databaseRelativePath);
    await assertSafeRegistryParents(repositoryRoot, databasePath);
    await assertSafeRegistryTarget(databasePath, true);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFile(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const database = bytes === undefined ? new SQL.Database() : new SQL.Database(bytes);
    initializeSchema(database);
    return database;
  }

  private async write<T>(repositoryRoot: string, operation: (database: Database) => T): Promise<T> {
    const release = await this.acquireLock(repositoryRoot);
    let database: Database | undefined;
    try {
      database = await this.openDatabase(repositoryRoot);
      const result = operation(database);
      await persistDatabase(repositoryRoot, database);
      return result;
    } finally {
      database?.close();
      await release();
    }
  }

  private async acquireLock(repositoryRoot: string): Promise<() => Promise<void>> {
    const lockPath = resolveRegistryPath(repositoryRoot, lockRelativePath);
    await assertSafeRegistryParents(repositoryRoot, lockPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await assertSafeRegistryParents(repositoryRoot, lockPath);
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(lockPath, 'wx');
        await handle.writeFile(canonicalJson({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }));
        await handle.sync();
        return async () => {
          await handle?.close();
          try {
            await unlink(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await removeAbandonedLock(lockPath, this.staleLockMs);
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error('Timed out acquiring repository knowledge registry lock.');
        }
        await this.sleep(this.lockRetryMs);
      }
    }
  }
}

async function defaultInitializeSqlJs(): Promise<SqlJsStatic> {
  const bundledWasm = path.join(
    typeof __dirname === 'string' ? __dirname : process.cwd(),
    'sql-wasm.wasm',
  );
  const developmentCandidates = [
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(process.cwd(), '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  ];
  const wasmPath = [bundledWasm, ...developmentCandidates].find((candidate) => existsSync(candidate));
  if (wasmPath === undefined) {
    throw new Error('sql.js WASM runtime is missing from the extension bundle.');
  }
  return initSqlJs({
    locateFile: () => wasmPath,
  });
}

function initializeSchema(database: Database): void {
  database.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS registry_metadata (
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publication_scopes (
      repository_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      max_generation INTEGER NOT NULL DEFAULT 0,
      active_publication_id TEXT,
      head_hash TEXT,
      head_json TEXT,
      current_projection_dirty INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, channel)
    );
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'withdrawn')),
      payload_hash TEXT NOT NULL,
      publication_hash TEXT NOT NULL,
      publication_json TEXT NOT NULL,
      UNIQUE (repository_id, channel, generation)
    );
    CREATE TABLE IF NOT EXISTS publication_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      repository_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `);
  const metadata = database.exec('SELECT schema_version FROM registry_metadata LIMIT 1');
  const current = metadata[0]?.values[0]?.[0];
  if (current === undefined) {
    database.run('INSERT INTO registry_metadata (schema_version) VALUES (?)', [schemaVersion]);
  } else if (current !== schemaVersion) {
    throw new Error(`Unsupported repository knowledge registry schema: ${String(current)}.`);
  }
}

function ensureScope(database: Database, scope: RepositoryKnowledgePublicationScope): void {
  database.run(
    `INSERT OR IGNORE INTO publication_scopes (
       repository_id, channel, max_generation, current_projection_dirty, updated_at
     ) VALUES (?, ?, 0, 0, '')`,
    [scope.repositoryId, scope.channel],
  );
}

function readSnapshot(
  database: Database,
  scope: RepositoryKnowledgePublicationScope,
): RepositoryKnowledgeRegistrySnapshot {
  validateScope(scope);
  const scopeResult = database.exec(
    `SELECT max_generation, head_json, current_projection_dirty
       FROM publication_scopes WHERE repository_id = ? AND channel = ?`,
    [scope.repositoryId, scope.channel],
  )[0]?.values[0];
  const publicationRows = database.exec(
    `SELECT publication_json FROM publications
      WHERE repository_id = ? AND channel = ? ORDER BY generation ASC`,
    [scope.repositoryId, scope.channel],
  )[0]?.values ?? [];
  return {
    scope: { ...scope },
    maxGeneration: asSafeInteger(scopeResult?.[0] ?? 0, 'registry generation'),
    ...(scopeResult?.[1] === null || scopeResult?.[1] === undefined
      ? {}
      : { head: parseJson<RepositoryKnowledgePublicationHead>(scopeResult[1], 'publication head') }),
    publications: publicationRows.map((row) =>
      parseJson<RepositoryKnowledgePublication>(row[0], 'publication')),
    currentProjectionDirty: scopeResult?.[2] === 1,
  };
}

function requirePublication(
  snapshot: RepositoryKnowledgeRegistrySnapshot,
  publicationId: string,
): RepositoryKnowledgePublication {
  const publication = snapshot.publications.find((candidate) => candidate.id === publicationId);
  if (publication === undefined) {
    throw new Error(`Repository knowledge publication does not exist: ${publicationId}`);
  }
  return publication;
}

function updatePublication(database: Database, publication: RepositoryKnowledgePublication): void {
  database.run(
    `UPDATE publications
        SET status = ?, payload_hash = ?, publication_hash = ?, publication_json = ?
      WHERE id = ? AND repository_id = ? AND channel = ?`,
    [
      publication.status,
      publication.payloadHash,
      publication.contentHash,
      canonicalJson(publication),
      publication.id,
      publication.scope.repositoryId,
      publication.scope.channel,
    ],
  );
  if (database.getRowsModified() !== 1) {
    throw new Error(`Repository knowledge publication update target is missing: ${publication.id}`);
  }
}

function insertEvent(
  database: Database,
  scope: RepositoryKnowledgePublicationScope,
  publicationId: string,
  eventType: string,
  occurredAt: string,
  event: unknown,
): void {
  database.run(
    `INSERT INTO publication_events (
       repository_id, channel, publication_id, event_type, occurred_at, event_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [scope.repositoryId, scope.channel, publicationId, eventType, occurredAt, canonicalJson(event)],
  );
}

async function persistDatabase(repositoryRoot: string, database: Database): Promise<void> {
  const databasePath = resolveRegistryPath(repositoryRoot, databaseRelativePath);
  await assertSafeRegistryParents(repositoryRoot, databasePath);
  await mkdir(path.dirname(databasePath), { recursive: true });
  await assertSafeRegistryParents(repositoryRoot, databasePath);
  await assertSafeRegistryTarget(databasePath, true);
  const temporary = `${databasePath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(database.export());
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, databasePath);
  } finally {
    await handle?.close();
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function removeAbandonedLock(lockPath: string, staleLockMs: number): Promise<void> {
  let lockStat;
  try {
    lockStat = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
    throw new Error('Repository knowledge registry lock is not a regular file.');
  }
  if (Date.now() - lockStat.mtimeMs < staleLockMs) return;
  let owner: { pid?: unknown } = {};
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
  } catch {
    // An incomplete lock older than the stale threshold was abandoned before
    // its owner record became durable.
  }
  if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && processIsAlive(owner.pid)) {
    return;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function resolveRegistryPath(repositoryRoot: string, relativePath: string): string {
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Repository knowledge registry path escapes the repository root.');
  }
  return target;
}

async function assertSafeRegistryParents(repositoryRoot: string, target: string): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Repository knowledge registry parent is a symbolic link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Repository knowledge registry parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertSafeRegistryTarget(target: string, allowMissing: boolean): Promise<void> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`Repository knowledge registry target is a symbolic link: ${target}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Repository knowledge registry target is not a regular file: ${target}`);
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertExpectedHead(
  head: RepositoryKnowledgePublicationHead | undefined,
  expectedHeadHash: string | null,
): void {
  if ((head?.contentHash ?? null) !== expectedHeadHash) {
    throw new Error('Repository knowledge publication head compare-and-swap conflict.');
  }
}

function assertPublicationState(
  publication: RepositoryKnowledgePublication,
  status: RepositoryKnowledgePublication['status'],
): void {
  validateScope(publication.scope);
  if (publication.status !== status) {
    throw new Error(`Repository knowledge publication must be ${status}.`);
  }
  if (!Number.isSafeInteger(publication.generation) || publication.generation <= 0) {
    throw new Error('Repository knowledge publication generation must be a positive integer.');
  }
  assertHash(publication.contentHash, 'publication content hash');
  assertHash(publication.payloadHash, 'publication payload hash');
  const { contentHash: _contentHash, ...body } = publication;
  if (sha256Hex(canonicalJson(body)) !== publication.contentHash) {
    throw new Error('Repository knowledge publication content hash is invalid.');
  }
}

function assertHead(
  head: RepositoryKnowledgePublicationHead,
  publication: RepositoryKnowledgePublication,
): void {
  assertSameScope(head.scope, publication.scope);
  if (
    head.publicationId !== publication.id ||
    head.publicationHash !== publication.contentHash ||
    head.generation !== publication.generation
  ) {
    throw new Error('Repository knowledge publication head does not identify the active publication state.');
  }
  const { contentHash: _contentHash, ...body } = head;
  if (sha256Hex(canonicalJson(body)) !== head.contentHash) {
    throw new Error('Repository knowledge publication head content hash is invalid.');
  }
}

function assertSameScope(
  left: RepositoryKnowledgePublicationScope,
  right: RepositoryKnowledgePublicationScope,
): void {
  if (left.repositoryId !== right.repositoryId || left.channel !== right.channel) {
    throw new Error('Repository knowledge publication scope mismatch.');
  }
}

function validateScope(scope: RepositoryKnowledgePublicationScope): void {
  if (!scope.repositoryId.trim()) throw new Error('Repository knowledge publication repository ID is required.');
  if (!scope.channel.trim()) throw new Error('Repository knowledge publication channel is required.');
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hash.`);
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') throw new Error(`Stored ${label} is not JSON text.`);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${label} is invalid JSON.`);
  }
}

function asSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored ${label} is invalid.`);
  }
  return value;
}

function rollback(database: Database): void {
  try {
    database.run('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

export function repositoryKnowledgeRegistryDatabasePath(repositoryRoot: string): string {
  return resolveRegistryPath(repositoryRoot, databaseRelativePath);
}

export function repositoryKnowledgeRegistryScopeKey(
  scope: RepositoryKnowledgePublicationScope,
): string {
  validateScope(scope);
  return createHash('sha256')
    .update(`${scope.repositoryId}\0${scope.channel}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}
