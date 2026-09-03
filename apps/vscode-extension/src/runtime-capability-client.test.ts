import { describe, expect, it, vi } from 'vitest';
import {
  migrationRouteSchemaVersion,
  validationPolicySchemaVersion,
  type MigrationRouteDescriptor,
} from '@forexplore/contracts';
import {
  materializeMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';
import {
  intersectRuntimeCapabilities,
  requestRetrievalRuntimeCapabilities,
  requestRuntimeCapabilities,
  runtimeCapabilityEndpoint,
} from './runtime-capability-client';

const NOW = '2026-09-02T00:00:00.000Z';

function route(id = 'route:typescript-to-python'): MigrationRouteDescriptor {
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id,
    name: 'TypeScript to Python',
    version: '2.0.0',
    sourceLanguageId: 'typescript',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: [{
      stage: 'source-analysis',
      providerId: 'analysis.typescript',
      providerVersion: '1.0.0',
      capabilities: ['behavior-extraction'],
      availability: { status: 'available', reasonCodes: [] },
    }, {
      stage: 'translation',
      providerId: 'translator',
      providerVersion: '1.0.0',
      capabilities: ['code-translation'],
      availability: { status: 'available', reasonCodes: [] },
    }],
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: `${id}.policy`,
      routeId: id,
      routeVersion: '2.0.0',
      checks: [{
        id: 'behavior',
        label: 'Behavior',
        phase: 'behavior',
        required: true,
        verifierId: 'verifier',
        verifierVersion: '1.0.0',
      }],
    },
  };
}

describe('runtime capability client', () => {
  it('loads and validates the direct V2 snapshot response', async () => {
    const snapshot = materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt: NOW });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));

    const result = await requestRuntimeCapabilities('http://127.0.0.1:8788/', fetcher, () => NOW);

    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v2/runtime-capabilities',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({ snapshot, source: 'service' });
  });

  it.each([
    ['request failure', vi.fn(async () => Promise.reject(new Error('offline')))],
    ['bad status', vi.fn(async () => new Response('unavailable', { status: 503 }))],
    ['bad hash', vi.fn(async () => new Response(JSON.stringify({
      ...materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt: NOW }),
      contentHash: '0'.repeat(64),
    }), { status: 200 }))],
  ])('returns a legal empty fail-closed snapshot for %s', async (_label, fetcher) => {
    const result = await requestRuntimeCapabilities('http://127.0.0.1:8788', fetcher, () => NOW);

    expect(result.source).toBe('fail-closed-empty');
    expect(result.error).toBeTruthy();
    expect(result.snapshot.routes).toEqual([]);
    expect(result.snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects non-HTTP endpoints before issuing a request', async () => {
    expect(() => runtimeCapabilityEndpoint('file:///tmp/adaptation')).toThrow(/HTTP or HTTPS/);
  });

  it('loads the retrieval capability envelope', async () => {
    const snapshot = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ runtimeCapabilities: snapshot }), {
      status: 200,
    }));
    const result = await requestRetrievalRuntimeCapabilities(
      'http://127.0.0.1:8787',
      fetcher,
      () => NOW,
    );
    expect(result).toEqual({ snapshot, source: 'service' });
  });

  it.each([
    ['empty', materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt: NOW }),
      'retrieval-runtime-routes-empty'],
    ['mismatched', materializeMigrationRuntimeCapabilitySnapshot({
      routes: [route('route:other')], createdAt: NOW,
    }), 'retrieval-runtime-route-mismatch'],
  ])('materializes a legal fail-closed route for %s retrieval routes', (_label, retrieval, reason) => {
    const adaptation = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
    const intersected = intersectRuntimeCapabilities(adaptation, retrieval);
    expect(intersected.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(intersected.routes[0]).toMatchObject({
      availability: { status: 'unavailable' },
      stages: expect.arrayContaining([
        expect.objectContaining({
          stage: 'source-analysis',
          availability: expect.objectContaining({ status: 'unavailable', reasonCodes: expect.arrayContaining([reason]) }),
        }),
      ]),
    });
  });
});
