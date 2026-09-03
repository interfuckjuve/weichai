import 'dotenv/config';
import { loadConfig } from './config.js';
import { SeekDbStore } from './seekdb-store.js';
import { SeekDbModuleKnowledgeStore } from './seekdb-module-knowledge-store.js';

const config = loadConfig();
const store = new SeekDbStore(config.seekdb);
const moduleStore = new SeekDbModuleKnowledgeStore(config.seekdb);

try {
  await Promise.all([store.initialize(), moduleStore.initialize()]);
  console.log(
    `SeekDB schemas ready: ${config.seekdb.database}.${config.seekdb.table} and ${config.seekdb.database}.${config.seekdb.moduleKnowledgeTable} (${config.seekdb.vectorDimension} dimensions)`,
  );
} finally {
  await Promise.all([store.close(), moduleStore.close()]);
}
