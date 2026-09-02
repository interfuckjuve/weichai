import { describe, expect, it, vi } from 'vitest';
import {
  moduleDiscoveryEndpoint,
  requestRepositoryModuleDiscovery,
} from './module-discovery-client';

describe('module discovery client', () => {
  it('builds a fixed endpoint and removes caller query and fragment', () => {
    expect(moduleDiscoveryEndpoint('http://127.0.0.1:8788/base/?unsafe=1#fragment'))
      .toBe('http://127.0.0.1:8788/base/v1/module-discovery');
  });

  it('sends only the snapshot selector and bounded discovery constraints', async () => {
    const proposal = { id: 'proposal-1' };
    const fetcher = vi.fn(async (_input: string | Request | URL, init?: RequestInit) =>
      new Response(JSON.stringify(proposal), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await expect(requestRepositoryModuleDiscovery(
      'http://127.0.0.1:8788',
      {
        snapshotId: 'snapshot-1',
        constraints: [{ id: 'boundary-1', description: 'Keep public APIs together.', required: true }],
      },
      fetcher as typeof fetch,
    )).resolves.toEqual(proposal);

    const [, init] = fetcher.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      snapshotId: 'snapshot-1',
      constraints: [{ id: 'boundary-1', description: 'Keep public APIs together.', required: true }],
    });
    expect(body).not.toHaveProperty('analysis');
    expect(body).not.toHaveProperty('ir');
    expect(body).not.toHaveProperty('source');
  });

  it('rejects traversal-like snapshot IDs before sending', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(requestRepositoryModuleDiscovery(
      'http://127.0.0.1:8788',
      { snapshotId: '../snapshot' },
      fetcher,
    )).rejects.toThrow('快照标识无效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces a bounded service error', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: 'snapshot not found' }),
      { status: 404 },
    )) as typeof fetch;
    await expect(requestRepositoryModuleDiscovery(
      'http://127.0.0.1:8788',
      { snapshotId: 'snapshot-1' },
      fetcher,
    )).rejects.toThrow('snapshot not found');
  });
});
