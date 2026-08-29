import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const { store, engine } = createRuntime(config);

if (config.autoMigrate) {
  await store.initialize();
}

const server = createHttpServer({
  engine,
  store,
  corsOrigin: config.corsOrigin,
  allowedRepositories: config.allowedRepositories,
});

server.listen(config.port, config.host, () => {
  console.log(`Retrieval service listening on http://${config.host}:${config.port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
  await store.close();
}

function requestShutdown(): void {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
