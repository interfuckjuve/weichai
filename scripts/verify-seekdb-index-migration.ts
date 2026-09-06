import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { ensureImmediateVectorIndex } from '../services/code-intelligence-service/src/seekdb-index-migration';

async function main() {
const database = `index_migration_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', connectionLimit: 4 });
const table = `\`${database}\`.\`search_documents\``;
try {
  await pool.query(`CREATE DATABASE \`${database}\``);
  await pool.query(`CREATE TABLE ${table} (
    id INT PRIMARY KEY, document_text LONGTEXT NOT NULL, embedding VECTOR(3) NOT NULL,
    future_column JSON, FULLTEXT INDEX idx_text(document_text),
    VECTOR INDEX idx_search_documents_embedding(embedding) WITH(DISTANCE=cosine,TYPE=hnsw,LIB=vsag,SYNC_MODE=async)
  ) ORGANIZATION=HEAP`);
  await pool.query(`INSERT INTO ${table} VALUES (1, 'alpha document', '[1,0,0]', '{"keep":true}'), (2, 'beta document', '[0,1,0]', NULL)`);
  const snapshot = async (name: string) => (await pool.query(`SELECT id,document_text,embedding,future_column FROM ${name} ORDER BY id`))[0];
  const before = await snapshot(table);
  const approve = { allowWriteFence: true };
  const guardedPool = (failCopy: boolean) => new Proxy(pool, {
    get(target, key) {
      if (key === 'getConnection') return async () => {
        const connection = await target.getConnection();
        return new Proxy(connection, { get(conn, property) {
          if (property === 'query') return async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('INSERT INTO') && sql.includes(`SELECT * FROM ${table}`)) {
              for (const write of [`INSERT INTO ${table} VALUES (4,'blocked','[1,0,0]',NULL)`,
                `UPDATE ${table} SET document_text='blocked' WHERE id=1`, `DELETE FROM ${table} WHERE id=1`]) {
                await assert.rejects(pool.query(write), /migration in progress/);
              }
              if (failCopy) throw new Error('injected copy failure');
            }
            return conn.query(sql, values);
          };
          const value = Reflect.get(conn, property);
          return typeof value === 'function' ? value.bind(conn) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(ensureImmediateVectorIndex(guardedPool(true), table, approve), /injected copy failure/);
  assert.deepEqual(await snapshot(table), before);
  await pool.query(`UPDATE ${table} SET document_text='alpha document' WHERE id=1`);
  const interrupted = await pool.getConnection();
  try {
    await interrupted.query(`USE \`${database}\``);
    await interrupted.query(`CREATE TRIGGER forexplore_migration_insert_interrupted BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Search index migration in progress'`);
  } finally { interrupted.destroy(); }
  const results = await Promise.all([ensureImmediateVectorIndex(guardedPool(false), table, approve), ensureImmediateVectorIndex(pool, table, approve)]);
  assert.equal(results.filter((result) => result.migrated).length, 1, 'Concurrent startup must migrate only once');
  const migration = results.find((result) => result.migrated)!;
  assert.deepEqual(await snapshot(table), before);
  assert.deepEqual(await snapshot(migration.backupTable!), before);
  const [matches] = await pool.query<mysql.RowDataPacket[]>(`SELECT id FROM ${table} ORDER BY cosine_distance(embedding,'[1,0,0]') APPROXIMATE LIMIT 2`);
  assert.deepEqual(matches.map((row) => row.id), [1, 2]);
  const [fulltext] = await pool.query<mysql.RowDataPacket[]>(`SELECT id FROM ${table} WHERE MATCH(document_text) AGAINST('alpha')`);
  assert.deepEqual(fulltext.map((row) => row.id), [1]);
  await pool.query(`INSERT INTO ${table} VALUES (3, 'new immediate vector', '[0,0,1]', NULL)`);
  const [fresh] = await pool.query<mysql.RowDataPacket[]>(`SELECT id FROM ${table} ORDER BY cosine_distance(embedding,'[0,0,1]') APPROXIMATE LIMIT 1`);
  assert.equal(fresh[0]!.id, 3);
  assert.deepEqual(await ensureImmediateVectorIndex(pool, table, { allowWriteFence: false }), { migrated: false });
  console.log(JSON.stringify({ passed: true, concurrentStartup: true, existingVectorsPreserved: true,
    futureColumnsPreserved: true, backupPreserved: true, fulltext: true, immediateNewWrites: true, writeFence: true, failureRecovery: true, interruptedRecovery: true }));
} finally {
  await pool.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await pool.end();
}
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
