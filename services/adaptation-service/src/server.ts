import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { ArchitectAgent } from './architect-agent.js';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store.js';
import { HttpSemanticQueryPort } from './http-semantic-query-port.js';
import { WorkspaceTranslationRuntime } from './workspace-translation-runtime.js';
import { createWorkspaceTranslationModelClient } from './workspace-translation-agent.js';
import {
  createDeepSeekToolCallingArchitectClient,
  ToolCallingArchitectRuntime,
} from './tool-calling-architect-runtime.js';

const config = loadConfig();

const adapter = new AdaptationAdapter({
  apiKey: config.apiKey,
  skeletonProjectPath: config.skeletonProjectPath,
  projectRoot: config.projectRoot,
});

let server: ReturnType<typeof createHttpServer> | undefined;
let workspaceTranslationRuntime: WorkspaceTranslationRuntime | undefined;

async function main(): Promise<void> {
  if (config.workspaceTranslation) {
    workspaceTranslationRuntime = new WorkspaceTranslationRuntime({
      workspaceRoot: config.projectRoot,
      compileCommand: config.workspaceTranslation.compileCommand,
      maxModelTurns: config.workspaceTranslation.maxModelTurns,
      timeoutMs: config.workspaceTranslation.timeoutMs,
      client: createWorkspaceTranslationModelClient({ apiKey: config.apiKey, temperature: 0 }),
    });
  }
  // Legacy /v1/module-plan remains snapshot-compatible. The semantic route is
  // explicitly opt-in and talks only to the VS Code host's read-only HTTP
  // SemanticQueryPort endpoint; this process never creates an index runtime.
  const semanticArchitecturePort = config.semanticQueryPort
    ? new ToolCallingArchitectRuntime({
      queryPort: new HttpSemanticQueryPort(config.semanticQueryPort),
      client: createDeepSeekToolCallingArchitectClient({ apiKey: config.apiKey, temperature: 0 }),
    })
    : undefined;
  const httpServer = createHttpServer({
    adapter,
    architecturePort: new ArchitectAgent({ apiKey: config.apiKey }),
    staticAnalysisSnapshots: new FileStaticAnalysisSnapshotStore({
      analysisRoot: config.analysisRoot,
    }),
    ...(semanticArchitecturePort ? { semanticArchitecturePort } : {}),
    ...(workspaceTranslationRuntime && config.workspaceTranslation ? {
      workspaceTranslation: { runtime: workspaceTranslationRuntime, bearerToken: config.workspaceTranslation.bearerToken },
    } : {}),
    corsOrigin: config.corsOrigin,
  });
  server = httpServer;

  httpServer.listen(config.port, config.host, () => {
    console.log(`Adaptation service listening on http://${config.host}:${config.port}`);
    console.log(`Target project: ${config.projectRoot}`);
    console.log(`Static analysis snapshots: ${config.analysisRoot}`);
    if (semanticArchitecturePort) {
      console.log('Revision-scoped semantic module planning is enabled.');
    }
  });
}

async function shutdown(): Promise<void> {
  await workspaceTranslationRuntime?.shutdown();
  const activeServer = server;
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => (error ? reject(error) : resolve()));
    activeServer.closeIdleConnections();
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

void main().catch((error) => {
  console.error('Adaptation service failed to start:', error);
  process.exitCode = 1;
});
