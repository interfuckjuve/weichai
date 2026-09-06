import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

const vectorIndex = /^\s*VECTOR (?:KEY|INDEX) `idx_search_documents_embedding` \(`embedding`\) WITH \(([^\n]*)\)/im;

export interface VectorIndexMigration {
  migrated: boolean;
  backupTable?: string;
  rows?: number;
}

async function definition(connection: Pool | PoolConnection, table: string): Promise<string> {
  const [rows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${table}`);
  const ddl = String(rows[0]?.['Create Table'] ?? '');
  if (!vectorIndex.test(ddl)) throw new Error('Cannot migrate an unrecognized search vector index definition.');
  return ddl;
}

function immediate(ddl: string): boolean {
  return /\bSYNC_MODE\s*=\s*['"]?IMMEDIATE['"]?(?=\s*[,)]|\s*$)/i.test(vectorIndex.exec(ddl)![1]!);
}

/** Explicit maintenance only. The host must not invoke a write-fenced migration automatically. */
export async function ensureImmediateVectorIndex(pool: Pool, table: string, options: { allowWriteFence: boolean }): Promise<VectorIndexMigration> {
  if (!/^`[A-Za-z_][A-Za-z0-9_]*`\.`search_documents`$/.test(table)) throw new Error('Invalid search table identifier.');
  if (immediate(await definition(pool, table))) return { migrated: false };
  if (!options.allowWriteFence) throw new Error('Migration requires explicit approval of a temporary write fence; no source table was changed.');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const qualify = (name: string) => `${table.slice(0, table.indexOf('.') + 1)}\`${name}\``;
  const mutex = qualify('search_index_migration_lock');
  await pool.query(`CREATE TABLE IF NOT EXISTS ${mutex} (id INT PRIMARY KEY)`);
  await pool.query(`INSERT IGNORE INTO ${mutex} VALUES (1)`);
  const lockConnection = await pool.getConnection();
  let connection: PoolConnection | undefined;
  const staging = qualify(`search_documents_build_${suffix}`);
  const backup = qualify(`search_documents_backup_${suffix}`);
  const guards: string[] = [];
  let stagingCreated = false;
  let swapped = false;
  try {
    // DDL commits its own session. Keep the cross-process mutex in a separate transaction.
    await lockConnection.query('SET SESSION ob_trx_timeout = 1800000000');
    await lockConnection.beginTransaction();
    await lockConnection.query(`SELECT id FROM ${mutex} WHERE id = 1 FOR UPDATE`);
    connection = await pool.getConnection();
    const ddl = await definition(connection, table);
    if (immediate(ddl)) return { migrated: false };
    await connection.query('SET SESSION ob_query_timeout = 1800000000, ob_trx_timeout = 1800000000');
    const index = vectorIndex.exec(ddl)!;
    const parameters = index[1]!;
    const updated = /\bSYNC_MODE\s*=/i.test(parameters)
      ? parameters.replace(/\bSYNC_MODE\s*=\s*['"]?\w+['"]?/i, 'SYNC_MODE=IMMEDIATE')
      : `${parameters}, SYNC_MODE=IMMEDIATE`;
    // Preserve the database's complete canonical schema, including future columns and other indexes.
    const rebuiltDdl = ddl.replace(/^CREATE TABLE `search_documents`/i, `CREATE TABLE ${staging}`)
      .replace(index[0], index[0].replace(parameters, updated));
    if (rebuiltDdl === ddl || !rebuiltDdl.startsWith(`CREATE TABLE ${staging}`)) throw new Error('Unrecognized search table DDL header.');
    console.info('[forexplore:index-migration]', JSON.stringify({ stage: 'copying', table, backup }));
    await connection.query(rebuiltDdl);
    stagingCreated = true;
    const [triggers] = await connection.query<RowDataPacket[]>(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = 'search_documents'`, [table.split('`')[1]]);
    if (triggers.some((trigger) => !String(trigger.TRIGGER_NAME).startsWith('forexplore_migration_'))) {
      throw new Error('Search table has custom triggers; automatic migration requires manual review.');
    }
    // This SeekDB accepts MySQL locks without enforcing them. SIGNAL triggers reject concurrent DML.
    await connection.query(`USE ${table.slice(0, table.indexOf('.'))}`);
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const trigger = qualify(`forexplore_migration_${event.toLowerCase()}_${suffix}`);
      await connection.query(`CREATE TRIGGER ${trigger} BEFORE ${event} ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Search index migration in progress; retry after refresh completes'`);
      guards.push(trigger);
    }
    await connection.query(`INSERT INTO ${staging} SELECT * FROM ${table}`);
    const [counts] = await connection.query<RowDataPacket[]>(`SELECT (SELECT COUNT(*) FROM ${table}) AS original_count, (SELECT COUNT(*) FROM ${staging}) AS copied_count`);
    const rows = Number(counts[0]!.original_count);
    if (rows !== Number(counts[0]!.copied_count)) throw new Error('Search index migration row-count mismatch; original table retained.');
    if (!immediate(await definition(connection, staging))) throw new Error('Rebuilt vector index is not immediate; original table retained.');
    await connection.query(`RENAME TABLE ${table} TO ${backup}, ${staging} TO ${table}`);
    swapped = true;
    console.info('[forexplore:index-migration]', JSON.stringify({ stage: 'complete', table, backup, rows }));
    return { migrated: true, backupTable: backup, rows };
  } finally {
    // Interrupted migrations retain the original table; rerunning copies it and its guards to the backup.
    try {
      if (connection) {
        for (const trigger of guards) await connection.query(`DROP TRIGGER IF EXISTS ${trigger}`);
        if (stagingCreated && !swapped) await connection.query(`DROP TABLE IF EXISTS ${staging}`);
      }
    } finally {
      connection?.destroy();
      lockConnection.destroy();
    }
  }
}
