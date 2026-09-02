import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { ArchitectAgent } from './architect-agent.js';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store.js';
import { ModuleDiscoveryAgent } from './module-discovery-agent.js';
import { ModuleSummaryAgent } from './module-summary-agent.js';
import { createDefaultTargetEngineeringAdapterRegistry } from './context-collector.js';
import { createAdaptationRuntimeCapabilitySnapshot } from './runtime-capability-snapshot.js';
import {
  AdaptationAdapterV2,
  DeepSeekMigrationAnalyzerV2,
  DeepSeekMigrationPlannerV2,
  DeepSeekMigrationTranslatorV2,
} from './adaptation-adapter-v2.js';

const config = loadConfig();
const targetEngineeringRegistry = createDefaultTargetEngineeringAdapterRegistry();

const adapter = new AdaptationAdapter({
  apiKey: config.apiKey,
  skeletonProjectPath: config.skeletonProjectPath,
  projectRoot: config.projectRoot,
  targetEngineeringRegistry,
});

const runtimeCapabilitySnapshot = createAdaptationRuntimeCapabilitySnapshot({
  createdAt: new Date().toISOString(),
  analysisExecution: 'disabled',
  verifierExecution: 'disabled',
  workspaceMutationExecution: 'disabled',
  targetEngineeringRegistry,
});
const migrationAgentsV2 = { apiKey: config.apiKey };
const adapterV2 = new AdaptationAdapterV2({
  runtimeCapabilities: runtimeCapabilitySnapshot,
  analyzer: new DeepSeekMigrationAnalyzerV2(migrationAgentsV2),
  planner: new DeepSeekMigrationPlannerV2(migrationAgentsV2),
  translator: new DeepSeekMigrationTranslatorV2(migrationAgentsV2),
  targetEngineeringRegistry,
});

const server = createHttpServer({
  adapter,
  adapterV2,
  runtimeCapabilitySnapshot,
  architecturePort: new ArchitectAgent({ apiKey: config.apiKey }),
  moduleDiscoveryPort: new ModuleDiscoveryAgent({ apiKey: config.apiKey }),
  moduleSummaryPort: new ModuleSummaryAgent({ apiKey: config.apiKey }),
  staticAnalysisSnapshots: new FileStaticAnalysisSnapshotStore({
    analysisRoot: config.analysisRoot,
  }),
  corsOrigin: config.corsOrigin,
});

server.listen(config.port, config.host, () => {
  console.log(`Adaptation service listening on http://${config.host}:${config.port}`);
  console.log(`Target project: ${config.projectRoot}`);
  console.log(`Static analysis snapshots: ${config.analysisRoot}`);
  console.log(`Runtime capability snapshot: ${runtimeCapabilitySnapshot.id}`);
  console.log('Behavior verification: disabled (no isolated executor configured)');
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
