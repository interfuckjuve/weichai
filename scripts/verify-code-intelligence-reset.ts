import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store';

async function main() {
  const database = `reset_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const config = { host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384 };
  const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database });
  const store = new SeekDbIndexStore(config);
  const command = path.resolve('scripts/reset-code-intelligence-index.ts');
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [...process.execArgv, command, '--database', database, ...args], {
    env: { ...process.env, CODE_INTELLIGENCE_SEEKDB_HOST: config.host, CODE_INTELLIGENCE_SEEKDB_PORT: String(config.port),
      CODE_INTELLIGENCE_SEEKDB_USER: config.user, CODE_INTELLIGENCE_SEEKDB_PASSWORD: config.password,
      CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION: '384', CODE_INTELLIGENCE_EMBEDDING_URL: '', CODE_INTELLIGENCE_EMBEDDING_MODEL: '' },
  });
  try {
    await store.initialize();
    await pool.query(`INSERT INTO \`${database}\`.repositories VALUES ('old', 'old parent workspace', '/old-parent', 'target', 'ready', 'old-revision', 'old', 'old')`);
    const [definitions] = await pool.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${database}\`.search_documents`);
    const legacyDdl = String(definitions[0]!['Create Table']).replace('CREATE TABLE `search_documents`', `CREATE TABLE \`${database}\`.\`search_documents\``).replace(/SYNC_MODE=IMMEDIATE/i, 'SYNC_MODE=ASYNC');
    await pool.query(`DROP TABLE \`${database}\`.search_documents`);
    await pool.query(legacyDdl);
    await run();
    assert.equal((await store.listRepositories()).length, 1, 'Preview must retain data');
    await pool.query(`CREATE TABLE \`${database}\`.unrelated_data (id INT PRIMARY KEY)`);
    await assert.rejects(run('--apply'), /unrelated tables/);
    assert.equal((await store.listRepositories()).length, 1, 'Rejected reset must retain data');
    await pool.query(`DROP TABLE \`${database}\`.unrelated_data`);
    await run('--apply');
    await store.initialize();
    assert.deepEqual(await store.listRepositories(), []);
    const [fresh] = await pool.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${database}\`.search_documents`);
    assert.match(String(fresh[0]!['Create Table']), /SYNC_MODE=IMMEDIATE/i);
    const vector = JSON.stringify([1, ...Array<number>(383).fill(0)]);
    await pool.query(`INSERT INTO \`${database}\`.search_documents (repository_id,analysis_revision,search_document_id,kind,content_hash,title,document_text,search_text,embedding)
      VALUES ('new','new','probe','symbol',?,'probe','probe','probe',?)`, ['a'.repeat(64), vector]);
    const [hits] = await pool.query<mysql.RowDataPacket[]>(`SELECT search_document_id FROM \`${database}\`.search_documents ORDER BY cosine_distance(embedding, ?) APPROXIMATE LIMIT 1`, [vector]);
    assert.equal(hits[0]?.search_document_id, 'probe');
    console.log(JSON.stringify({ passed: true, previewPreservesData: true, unrelatedTablesProtected: true,
      oldDataRemoved: true, initialization: true, immediateVectorSearch: true }));
  } finally {
    await store.close();
    await pool.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
