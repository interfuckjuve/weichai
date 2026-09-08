import type { AddressInfo } from 'node:net';
import type { ModuleHierarchyDecisionRequest, ModuleHierarchyPlanner } from '@forexplore/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http-server.js';

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});

async function listen(planner?: ModuleHierarchyPlanner): Promise<string> {
  const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Unused adaptation route.'); } }, moduleHierarchyPlanner: planner });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const snapshot: ModuleHierarchyDecisionRequest = {
  repositoryId: 'repo', analysisRevision: 'revision', projectId: 'project', analysisHash: 'hash', nodeId: 'node', name: 'Parser', depth: 2,
  metrics: { fileCount: 1, sourceBytes: 40, symbolCount: 1 },
  candidates: [{ id: 'parser', name: 'Parser', relativePath: 'src/parser', fileCount: 1, sourceBytes: 40, symbolCount: 1,
    languages: ['TypeScript'], samplePaths: ['src/parser/index.ts'], coreApis: ['parse'], evidenceIds: ['file:parser'] }],
  dependencies: [], excerpts: [{ relativePath: 'src/parser/index.ts', content: 'export function parse() {}', evidenceId: 'file:parser' }],
};
const decision = { action: 'stop' as const, name: 'Parser', nodeKind: 'module' as const, description: 'Parses input.', reason: 'One coherent API.',
  evidenceIds: ['file:parser'], stopReason: 'cohesive' as const };

describe('bounded module hierarchy HTTP', () => {
  it('round-trips a validated decision through HTTP', async () => {
    const decide = vi.fn(async (_request: ModuleHierarchyDecisionRequest) => decision);
    const base = await listen({ decide });
    const response = await fetch(`${base}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(decision);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toEqual(snapshot);
  });

  it('is explicitly unavailable when no planner is configured', async () => {
    const base = await listen();
    const response = await fetch(`${base}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
    expect(response.status).toBe(503);
  });

  it.each([
    { ...snapshot, files: [{ path: '/private', source: 'arbitrary repository' }] },
    { ...snapshot, excerpts: [{ ...snapshot.excerpts[0], relativePath: '../private' }] },
    { ...snapshot, candidates: Array.from({ length: 65 }, (_, id) => ({ ...snapshot.candidates[0], id: String(id) })) },
  ])('rejects invalid evidence before model invocation', async (payload) => {
    const decide = vi.fn(async () => decision);
    const base = await listen({ decide });
    const response = await fetch(`${base}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(response.status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('returns safe failures for rejected model output or provider errors', async () => {
    for (const planner of [
      { decide: async () => ({ ...decision, evidenceIds: ['file:invented'] }) },
      { decide: async () => { throw new Error('private upstream response'); } },
    ]) {
      const base = await listen(planner);
      const response = await fetch(`${base}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('private');
    }
  });

  it('propagates client disconnect cancellation to an active planner', async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    const base = await listen({ decide: async (_request, signal) => {
      started();
      return await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { cancelled(); reject(new Error('cancelled')); }, { once: true }));
    } });
    const controller = new AbortController();
    const pending = fetch(`${base}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await active;
    controller.abort();
    await rejected;
    await aborted;
  });
});
