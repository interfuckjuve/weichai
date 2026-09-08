import { describe, expect, it, vi } from 'vitest';
import { HttpModuleHierarchyPlanner, moduleHierarchyEndpoint } from './module-hierarchy-client.js';
import type { ModuleHierarchyDecisionRequest } from '@forexplore/contracts';

const snapshot: ModuleHierarchyDecisionRequest = {
  repositoryId: 'repo', analysisRevision: 'revision', projectId: 'project', analysisHash: 'hash', nodeId: 'node', name: 'Parser', depth: 0,
  metrics: { fileCount: 1, sourceBytes: 10, symbolCount: 1 }, dependencies: [], excerpts: [],
  candidates: [{ id: 'parser', name: 'Parser', relativePath: 'parser.ts', fileCount: 1, sourceBytes: 10, symbolCount: 1,
    languages: ['TypeScript'], samplePaths: ['parser.ts'], coreApis: ['parse'], evidenceIds: ['file:parser'] }],
};

describe('module hierarchy client boundary', () => {
  it('strips base queries and rejects credential URLs and non-HTTP protocols', () => {
    expect(moduleHierarchyEndpoint('http://127.0.0.1:8788/prefix/?query=1#fragment')).toBe('http://127.0.0.1:8788/prefix/module-hierarchy/decision');
    expect(() => moduleHierarchyEndpoint('file:///private')).toThrow();
    expect(() => moduleHierarchyEndpoint('http://user:secret@localhost:8788')).toThrow();
  });

  it('does not call a service after caller cancellation', async () => {
    const fetcher = vi.fn();
    const planner = new HttpModuleHierarchyPlanner('http://localhost:8788', fetcher);
    await expect(planner.decide({} as never, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('validates successful responses and rejects untrusted service content', async () => {
    const decision = { action: 'stop', name: 'Parser', nodeKind: 'module', description: 'Parses input.', reason: 'One coherent API.', evidenceIds: ['file:parser'] };
    const fetcher = vi.fn(async () => Response.json(decision));
    await expect(new HttpModuleHierarchyPlanner('http://localhost:8788', fetcher).decide(snapshot)).resolves.toMatchObject({ ...decision, stopReason: 'cohesive' });
    const bad = vi.fn(async () => Response.json({ ...decision, evidenceIds: ['invented'] }));
    await expect(new HttpModuleHierarchyPlanner('http://localhost:8788', bad).decide(snapshot)).rejects.toThrow('unknown');
    const failed = vi.fn(async () => new Response('private provider body', { status: 502 }));
    await expect(new HttpModuleHierarchyPlanner('http://localhost:8788', failed).decide(snapshot)).rejects.toThrow(/^Module hierarchy service request failed with HTTP 502\.$/);
  });
});
