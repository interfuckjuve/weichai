import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { ArchitectAgent } from './architect-agent.js';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store.js';
import { TranslationVerifierAdapter } from './verification-adapter.js';

const config = loadConfig();

const adapter = new AdaptationAdapter({
  apiKey: config.apiKey,
  skeletonProjectPath: config.skeletonProjectPath,
  projectRoot: config.projectRoot,
  corpusRoot: config.corpusRoot,
  verifier: new TranslationVerifierAdapter({
    apiKey: config.apiKey,
    timeoutMs: Number.parseInt(process.env.VERIFIER_TIMEOUT_MS ?? "", 10) || undefined,
    // A normal HTTP service has model credentials and the developer's
    // workspace available.  It must fail closed until a different deployment
    // injects an externally isolated executor.
    execution: config.verifierExecution,
  }),
});

const server = createHttpServer({
  adapter,
  architecturePort: new ArchitectAgent({ apiKey: config.apiKey }),
  staticAnalysisSnapshots: new FileStaticAnalysisSnapshotStore({
    analysisRoot: config.analysisRoot,
  }),
  corsOrigin: config.corsOrigin,
});

server.listen(config.port, config.host, () => {
  console.log(`Adaptation service listening on http://${config.host}:${config.port}`);
  console.log(`Target project: ${config.projectRoot}`);
  console.log(`Static analysis snapshots: ${config.analysisRoot}`);
  console.log("Differential execution: disabled (no isolated executor configured)");
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function requestShutdown(): void {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
