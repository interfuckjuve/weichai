import 'dotenv/config';
import { loadConfig } from './config.js';
import { createConfiguredHttpServer } from './runtime.js';

const config = loadConfig();
const { server, runtime } = createConfiguredHttpServer(config);
const { store, moduleStore, implementationStoreV2 } = runtime;

if (config.autoMigrate) {
  await Promise.all([
    store.initialize(),
    moduleStore.initialize(),
    implementationStoreV2.initialize(),
  ]);
}

server.listen(config.port, config.host, () => {
  console.log(`Retrieval service listening on http://${config.host}:${config.port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
  await Promise.all([store.close(), moduleStore.close(), implementationStoreV2.close()]);
}

function requestShutdown(): void {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
