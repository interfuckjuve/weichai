import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store';
import { codeIntelligenceRuntimeOptionsFromEnvironment } from '../apps/vscode-extension/src/code-intelligence-host';

const ownedTables = new Set(['repositories', 'analysis_revisions', 'projects', 'files', 'symbols',
  'dependency_edges', 'module_artifacts', 'search_documents', 'index_diagnostics',
  'search_embedding_configuration', 'search_embedding_cache']);

async function main() {
  const { values } = parseArgs({ options: { database: { type: 'string' }, apply: { type: 'boolean' } } });
  const database = values.database ?? process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
  assert(database && /^[A-Za-z_][A-Za-z0-9_]*$/.test(database), 'Specify --database with the code-intelligence database name.');
  assert(!['mysql', 'information_schema', 'performance_schema', 'sys', 'oceanbase', 'test'].includes(database.toLowerCase()), 'System and shared default databases cannot be reset.');
  const { seekdb: config } = codeIntelligenceRuntimeOptionsFromEnvironment({ ...process.env, CODE_INTELLIGENCE_SEEKDB_DATABASE: database });
  assert(config && ['127.0.0.1', 'localhost', '::1'].includes(config.host), 'This reset tool supports the local database only.');
  const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, connectionLimit: 4 });
  try {
    // Validate model and dimension settings before the destructive statement.
    const store = new SeekDbIndexStore(config, pool);
    const [tables] = await pool.query<mysql.RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
    const unknown = tables.map((row) => String(row.TABLE_NAME)).filter((name) => !ownedTables.has(name));
    assert.equal(unknown.length, 0, `Database contains unrelated tables; reset refused: ${unknown.join(', ')}`);
    const counts: Record<string, number> = {};
    for (const { TABLE_NAME: name } of tables) {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${database}\`.\`${name}\``);
      counts[name] = Number(rows[0]!.count);
    }
    console.log(JSON.stringify({ action: values.apply ? 'reset' : 'preview', database, counts, preservesSourceFiles: true }));
    if (!values.apply) return;
    await pool.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await store.initialize();
    assert.deepEqual(await store.listRepositories(), []);
    console.log(JSON.stringify({ reset: true, initialized: true, database, repositories: 0,
      nextStep: 'Reload the extension and analyze only explicitly selected repositories.' }));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
