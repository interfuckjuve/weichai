import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { ensureImmediateVectorIndex } from '../services/code-intelligence-service/src/seekdb-index-migration';

async function main() {
  const { values } = parseArgs({ options: { database: { type: 'string' }, apply: { type: 'boolean' }, 'allow-write-fence': { type: 'boolean' } } });
  const database = values.database ?? process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
  assert(database && /^[A-Za-z_][A-Za-z0-9_]*$/.test(database), 'Specify --database with the existing database name.');
  const host = process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1';
  assert(['127.0.0.1', 'localhost', '::1'].includes(host), 'This maintenance script supports the local database only.');
  const pool = mysql.createPool({ host, port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? 2881),
    user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root', password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? '', connectionLimit: 4 });
  const table = `\`${database}\`.\`search_documents\``;
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS documents FROM ${table}`);
    console.log(JSON.stringify({ database, documents: rows[0]!.documents, action: values.apply ? 'apply' : 'preview',
      temporaryWriteFence: true, originalTableRetained: true, reencode: false }));
    if (!values.apply) return;
    assert(values['allow-write-fence'], 'Review and approve the temporary write fence before using --apply --allow-write-fence.');
    const result = await ensureImmediateVectorIndex(pool, table, { allowWriteFence: true });
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
