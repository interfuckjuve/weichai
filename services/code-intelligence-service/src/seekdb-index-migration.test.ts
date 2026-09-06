import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { ensureImmediateVectorIndex } from './seekdb-index-migration.js';

const table = '`test_db`.`search_documents`';
function fixture(options: { immediate?: boolean; concurrent?: boolean; copyFails?: boolean; lock?: number; mismatch?: boolean } = {}) {
  const ddl = (mode: string) => `CREATE TABLE \`search_documents\` (\n  \`embedding\` VECTOR(3),\n  VECTOR KEY \`idx_search_documents_embedding\` (\`embedding\`) WITH (DISTANCE=COSINE, SYNC_MODE=${mode})\n)`;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE') && options.lock === 0) throw new Error('migration mutex timeout');
    if (sql.startsWith('SHOW CREATE')) return [[{ 'Create Table': ddl(options.concurrent || sql.includes('search_documents_build_') ? 'IMMEDIATE' : 'ASYNC') }]];
    if (sql.startsWith('SELECT @@')) return [[{ query_timeout: 10000000, transaction_timeout: 100000000 }]];
    if (sql.startsWith('SELECT (SELECT COUNT')) return [[{ original_count: 3, copied_count: options.mismatch ? 2 : 3 }]];
    if (sql.startsWith('INSERT INTO') && options.copyFails) throw new Error('disk full');
    return [[]];
  });
  const connection = { query, beginTransaction: vi.fn(), release: vi.fn(), destroy: vi.fn() };
  const pool = { query: vi.fn(async () => [[{ 'Create Table': ddl(options.immediate ? 'IMMEDIATE' : 'ASYNC') }]]),
    getConnection: vi.fn(async () => connection) };
  return { pool: pool as unknown as Pool, connection, query };
}

describe('SeekDB vector index migration', () => {
  it('leaves an immediate index untouched', async () => {
    const { pool } = fixture({ immediate: true });
    expect(await ensureImmediateVectorIndex(pool, table, { allowWriteFence: false })).toEqual({ migrated: false });
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  it('requires explicit approval before changing an asynchronous table', async () => {
    const { pool } = fixture();
    await expect(ensureImmediateVectorIndex(pool, table, { allowWriteFence: false })).rejects.toThrow('explicit approval');
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('fences all writes and retains the original table in the atomic rename', async () => {
    const { pool, query, connection } = fixture();
    const result = await ensureImmediateVectorIndex(pool, table, { allowWriteFence: true });
    expect(result).toMatchObject({ migrated: true, rows: 3 });
    expect(result.backupTable).toContain('search_documents_backup_');
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.find((sql) => sql.startsWith('CREATE TABLE'))).toContain('SYNC_MODE=IMMEDIATE');
    const lock = statements.findIndex((sql) => sql.includes('FOR UPDATE'));
    const copy = statements.findIndex((sql) => sql.startsWith('INSERT INTO'));
    const swap = statements.findIndex((sql) => sql.startsWith('RENAME TABLE'));
    expect(lock).toBeLessThan(copy);
    expect(copy).toBeLessThan(swap);
    expect(statements[swap]).toContain(`RENAME TABLE ${table} TO ${result.backupTable},`);
    expect(statements.filter((sql) => sql.startsWith('CREATE TRIGGER'))).toHaveLength(3);
    expect(statements.filter((sql) => sql.startsWith('DROP TRIGGER'))).toHaveLength(3);
    expect(statements.some((sql) => /^(DELETE|DROP TABLE|UPDATE)/.test(sql))).toBe(false);
    expect(connection.destroy).toHaveBeenCalled();
  });

  it.each([{ copyFails: true }, { mismatch: true }])('keeps the original table after a failed copy: %j', async (options) => {
    const { pool, query, connection } = fixture(options);
    await expect(ensureImmediateVectorIndex(pool, table, { allowWriteFence: true })).rejects.toThrow();
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.startsWith('RENAME TABLE'))).toBe(false);
    expect(statements.filter((sql) => sql.startsWith('DROP TABLE'))).toEqual([expect.stringContaining('search_documents_build_')]);
    expect(statements.filter((sql) => sql.startsWith('DROP TRIGGER'))).toHaveLength(3);
    expect(connection.destroy).toHaveBeenCalled();
  });

  it('rechecks after another process completed migration', async () => {
    const { pool, query } = fixture({ concurrent: true });
    expect(await ensureImmediateVectorIndex(pool, table, { allowWriteFence: true })).toEqual({ migrated: false });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('CREATE'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  });

  it('does not change tables when migration lock acquisition fails', async () => {
    const { pool, query } = fixture({ lock: 0 });
    await expect(ensureImmediateVectorIndex(pool, table, { allowWriteFence: true })).rejects.toThrow('mutex timeout');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('CREATE TRIGGER'))).toBe(false);
  });
});
