import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import { queryRows } from './abortable-query.js';

describe('abortable SQL reads', () => {
  it('releases a connection that arrives after its caller cancelled the pool wait', async () => {
    let accept!: (connection: PoolConnection) => void;
    const connection = { query: vi.fn(), release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: () => new Promise<PoolConnection>((resolve) => { accept = resolve; }) } as Pool;
    const controller = new AbortController();
    const result = queryRows<RowDataPacket[]>(pool, 'SELECT 1', [], controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');
    accept(connection as unknown as PoolConnection);
    await Promise.resolve();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('destroys an active connection on cancellation and never releases it for reuse', async () => {
    const connection = { query: vi.fn(() => new Promise(() => {})), release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: async () => connection } as unknown as Pool;
    const controller = new AbortController();
    const result = queryRows<RowDataPacket[]>(pool, 'SELECT SLEEP(60)', [], controller.signal);
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it('returns successful rows and detaches cancellation from the released connection', async () => {
    const connection = { query: vi.fn().mockResolvedValue([[{ value: 1 }]]), release: vi.fn(), destroy: vi.fn() };
    const pool = { getConnection: async () => connection } as unknown as Pool;
    const controller = new AbortController();
    expect(await queryRows<RowDataPacket[]>(pool, 'SELECT 1', [], controller.signal)).toEqual([{ value: 1 }]);
    controller.abort();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
  });
});
