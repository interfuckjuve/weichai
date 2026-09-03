import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createConfiguredHttpServer } from './runtime.js';
import { retrievalHostOwnedRuntimeOverrideStages } from './implementation-index-v2.js';
import { SeekDbModuleKnowledgeStore } from './seekdb-module-knowledge-store.js';
import { SeekDbImplementationIndexStoreV2 } from './seekdb-implementation-index-v2-store.js';
import { SeekDbStore } from './seekdb-store.js';

describe('retrieval production composition', () => {
  it('constructs separate symbol/module stores and exposes module routes from real config', async () => {
    const config = loadConfig({
      RETRIEVAL_ALLOWED_REPOSITORIES: 'acme/orders',
      RETRIEVAL_MODULE_INDEX_TOKEN: 'writer-secret',
      SEEKDB_AUTO_MIGRATE: 'false',
      SEEKDB_VECTOR_DIMENSION: '8',
    });
    const { server, runtime } = createConfiguredHttpServer(config);

    try {
      expect(runtime.store).toBeInstanceOf(SeekDbStore);
      expect(runtime.moduleStore).toBeInstanceOf(SeekDbModuleKnowledgeStore);
      expect(runtime.implementationStoreV2).toBeInstanceOf(SeekDbImplementationIndexStoreV2);
      expect(runtime.moduleStore).not.toBe(runtime.store);
      expect(runtime.implementationStoreV2).not.toBe(runtime.store);
      expect(runtime.implementationEngineV2.search).toBeTypeOf('function');
      expect(runtime.implementationEngineV2.allowedOverrideStages).toEqual(
        retrievalHostOwnedRuntimeOverrideStages,
      );
      expect(runtime.implementationIndexV2.stage).toBeTypeOf('function');
      expect(runtime.runtimeCapabilitiesV2.routes).toEqual([]);
      expect(runtime.moduleIndex.stage).toBeTypeOf('function');
      expect(runtime.moduleEngine.search).toBeTypeOf('function');
      expect(runtime.indexer).toMatchObject({
        projectionVersion: 'module-knowledge-search-projection/1',
        embeddingProvider: 'hash',
        embeddingModel: 'forexplore-fnv1a-trigram-v1',
        embeddingDimension: 8,
      });
      expect(runtime.indexer.configurationHash).toMatch(/^[a-f0-9]{64}$/);

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const capabilities = await fetch(`http://127.0.0.1:${port}/v2/capabilities`);
      expect(capabilities.status).toBe(200);
      await expect(capabilities.json()).resolves.toMatchObject({
        runtimeCapabilities: { routes: [] },
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/module-knowledge/generations/stage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Module-index writer authorization failed.',
      });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
      }
      await Promise.all([
        runtime.store.close(),
        runtime.moduleStore.close(),
        runtime.implementationStoreV2.close(),
      ]);
    }
  });
});
