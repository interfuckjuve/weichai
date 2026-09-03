import { describe, expect, it, vi } from 'vitest';
import {
  createGenericRepositoryLanguageAdapter,
  RepositoryLanguageRegistry,
  type AnalyzeRepositoryRequest,
} from '@forexplore/code-indexer';
import type { RepositoryStaticAnalysis } from '@forexplore/contracts';
import { HostOwnedRepositoryAnalyzer } from './host-owned-repository-analyzer';

describe('HostOwnedRepositoryAnalyzer', () => {
  it('reuses the same registry and host-owned configuration for every analysis', async () => {
    const registry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        id: 'test.python',
        version: '1',
        languageId: 'python',
        fileExtensions: ['.py'],
      }),
    ]);
    const requests: AnalyzeRepositoryRequest[] = [];
    const result = { snapshotId: 'snapshot' } as RepositoryStaticAnalysis;
    const analyze = vi.fn(async (request: AnalyzeRepositoryRequest) => {
      requests.push(request);
      return result;
    });
    const host = new HostOwnedRepositoryAnalyzer({ languageRegistry: registry, analyze });

    await host.analyze({
      root: 'one',
      semanticEnrichment: false,
      allowDirtyWorktreeForPlanning: false,
    });
    await host.analyze({ root: 'two' });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.languageRegistry).toBe(registry);
    expect(requests[1]!.languageRegistry).toBe(registry);
    expect(requests.every((request) => request.semanticEnrichment === true)).toBe(true);
    expect(requests.every((request) => request.allowDirtyWorktreeForPlanning === true)).toBe(true);
    expect(host.descriptors()).toEqual(registry.descriptors());
    expect(host.fingerprint()).toBe(registry.fingerprint());
  });
});
