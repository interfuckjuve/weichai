import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

/** Cancel pool waits as well as active SQL, without returning a busy connection to the pool. */
export async function queryRows<T extends RowDataPacket[]>(pool: Pool, sql: string, values: unknown[], signal?: AbortSignal): Promise<T> {
  if (!signal) return (await pool.query<T>(sql, values))[0];
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let connection: PoolConnection | undefined;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      connection?.destroy();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pool.getConnection().then(async (acquired) => {
      connection = acquired;
      if (aborted) { acquired.release(); return; }
      try {
        const [rows] = await acquired.query<T>({ sql, timeout: 10_000 }, values);
        resolve(rows);
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (!aborted) acquired.release();
      }
    }).catch((error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
