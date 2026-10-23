// One command to bring up the local model services used by RECAST.
//
// Module search depends on three processes that were previously started by hand, and
// that fragility is not theoretical: during development the embedding server and
// Docker both died mid-session, and because the local reranker is now the default,
// a rerank server that is not listening silently costs 6 points of recall (the
// delivery falls back to the fused order and records CONTEXT_RERANK_UNAVAILABLE).
//
// Idempotent: compatible services are reused; occupied incompatible ports fail without terminating their owner.
//
//   npm run services:up
//
// Environment (all optional):
//   FOREXPLORE_EMBEDDING_PORT   4021
//   FOREXPLORE_RERANK_PORT      4022
//   FOREXPLORE_EMBEDDING_TOOLS  directory holding @huggingface/transformers
//                               (default: <LOCALAPPDATA>/recast/embed-tools)
//   FOREXPLORE_MODEL_CACHE      model cache directory
//   FOREXPLORE_MODEL_HOST       model host for downloads (default: a mirror,
//                               because Node's fetch ignores the proxy here)
//   SEEKDB_CONTAINER            forexplore-seekdb
//   RECAST_SERVICES_LOG_DIR     where child logs go (default: <tmp>/recast-services)

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { get } from 'node:http';
import { createConnection as connectDatabase } from 'mysql2/promise';
import { ensureDockerRuntime } from './docker-runtime.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runtimePackage = '@huggingface/transformers';
// Pinned to the version the service scripts assume: they rely on `env.cacheDir`,
// `env.allowRemoteModels` and `dtype: 'q8'`.
const runtimeVersion = '3.8.1';
const tokenizerVersion = '0.23.2';
const defaultRerankModel = 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101';
const configuredRerankModel = process.env.FOREXPLORE_RERANK_MODEL?.trim();
const rerankModel = !configuredRerankModel || configuredRerankModel === 'Xenova/bge-reranker-base'
  ? defaultRerankModel : configuredRerankModel;
const defaultModelHost = 'https://hf-mirror.com';
const embeddingPort = Number(process.env.FOREXPLORE_EMBEDDING_PORT ?? 4021);
const rerankPort = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
const seekdbPort = Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? process.env.SEEKDB_PORT ?? 2881);
const seekdbHost = process.env.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1';
const skipSeekDb = process.argv.includes('--skip-seek-db');
const container = process.env.SEEKDB_CONTAINER ?? 'forexplore-seekdb';

/**
 * A durable per-user location, never `os.tmpdir()`: the system cleans the temp
 * directory, and when the runtime disappeared with it every start burned its full
 * readiness budget and then failed with a bare MODULE_NOT_FOUND, which reached the
 * workbench as an unexplained "fetch failed".
 */
function defaultToolsDirectory() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    : path.join(homedir(), '.cache');
  return path.join(base, 'recast', 'embed-tools');
}

const tools = process.env.FOREXPLORE_EMBEDDING_TOOLS ?? defaultToolsDirectory();
const cache = process.env.FOREXPLORE_MODEL_CACHE ?? path.join(homedir(), '.cache', 'forexplore-model-cache');
// CUDA's driver is supplied by WSL, but CUDA/cuDNN user libraries belong to
// the isolated inference runtime, alongside the optional ONNX provider.
function cudaLibraryEnvironment() {
  if (process.platform !== 'linux') return {};
  const libraries = [];
  const nvidiaRoot = path.join(homedir(), '.cache', 'recast', 'cuda-runtime', 'nvidia');
  if (existsSync(nvidiaRoot)) {
    for (const name of readdirSync(nvidiaRoot).sort()) {
      const directory = path.join(nvidiaRoot, name, 'lib');
      if (existsSync(directory)) libraries.push(directory);
    }
  }
  if (existsSync('/usr/lib/wsl/lib')) libraries.push('/usr/lib/wsl/lib');
  if (process.env.LD_LIBRARY_PATH) libraries.push(process.env.LD_LIBRARY_PATH);
  return libraries.length ? { LD_LIBRARY_PATH: libraries.join(':') } : {};
}
const logDir = process.env.RECAST_SERVICES_LOG_DIR ?? path.join(tmpdir(), 'recast-services');
const waitMs = Number(process.env.RECAST_SERVICES_WAIT_MS ?? 180_000);
const maxLogBytes = 10 * 1024 * 1024;

const runtimeResolvable = (directory) => {
  try {
    createRequire(path.join(directory, 'package.json')).resolve(runtimePackage);
    return true;
  } catch {
    return false;
  }
};

/**
 * The inference runtime carries native ONNX binaries, so it lives outside the
 * workspace instead of in every install. A fresh machine — or one whose cache was
 * cleaned — therefore has nothing to launch: install it on demand rather than
 * reporting a probe timeout.
 */
function ensureEmbeddingRuntime() {
  const hasRuntime = runtimeResolvable(tools);
  let hasTokenizer = false;
  try { createRequire(path.join(tools, 'package.json')).resolve('tokenizers'); hasTokenizer = true; } catch { /* optional */ }
  if (hasRuntime && hasTokenizer) return true;
  if (process.env.FOREXPLORE_EMBEDDING_SKIP_INSTALL === '1') {
    if (hasRuntime) return true;
    console.error(`Embedding runtime ${runtimePackage} is missing from ${tools} and FOREXPLORE_EMBEDDING_SKIP_INSTALL=1.`);
    return false;
  }
  console.log(`Preparing inference runtime in ${tools}${hasRuntime ? ' (adding native tokenization)' : ''}.`);
  mkdirSync(tools, { recursive: true });
  const manifest = path.join(tools, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({ name: 'recast-embed-tools', private: true, version: '1.0.0' }, null, 2)}\n`);
  }
  const installed = spawnSync(npmCommand, ['install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund',
    ...(hasRuntime ? [] : [`${runtimePackage}@${runtimeVersion}`]), `tokenizers@${tokenizerVersion}`], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (installed.status !== 0 || !runtimeResolvable(tools)) {
    if (hasRuntime && runtimeResolvable(tools)) {
      console.warn('Native tokenization could not be installed; continuing with JavaScript tokenization.');
      return true;
    }
    console.error(`Unable to install ${runtimePackage} into ${tools}.`);
    console.error('Install it by hand, or point FOREXPLORE_EMBEDDING_TOOLS at a directory that already contains it.');
    return false;
  }
  console.log(`Embedding runtime ready in ${tools}.`);
  return true;
}

const modelCachePopulated = () => {
  try {
    return existsSync(cache) && readdirSync(cache).length > 0;
  } catch {
    return false;
  }
};

/**
 * The library downloads from huggingface.co, which Node on this machine cannot
 * always reach (its fetch ignores the configured proxy). The mirror is therefore
 * the default whenever no host is set; a complete cache loads offline, and the
 * host is then never consulted.
 */
function modelHostEnvironment() {
  if (process.env.FOREXPLORE_MODEL_HOST) return { FOREXPLORE_MODEL_HOST: process.env.FOREXPLORE_MODEL_HOST };
  if (!modelCachePopulated()) console.log(`Model cache ${cache} is empty; downloading through ${defaultModelHost}.`);
  return { FOREXPLORE_MODEL_HOST: defaultModelHost };
}

const listening = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const socket = createConnection({ host, port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
});

async function serviceReady(label, port) {
  try {
    if (label === 'SeekDB') {
      const connection = await connectDatabase({ host: seekdbHost, port, connectTimeout: 1500,
        user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? process.env.SEEKDB_USER ?? 'root',
        password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? process.env.SEEKDB_PASSWORD ?? '' });
      try { await connection.query({ sql: 'SELECT 1', timeout: 1500 }); }
      finally { connection.destroy(); }
    } else {
      const health = await new Promise((resolve, reject) => {
        get(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }, response => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { body += chunk; });
          response.on('error', reject);
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw new Error(`health returned HTTP ${response.statusCode}`);
              resolve(JSON.parse(body));
            } catch (error) { reject(error); }
          });
        }).on('error', reject);
      });
      const model = label === 'embedding'
        ? `${process.env.FOREXPLORE_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small'}@${process.env.FOREXPLORE_EMBEDDING_REVISION ?? '761b726dd34fb83930e26aab4e9ac3899aa1fa78'}`
        : rerankModel;
      if (health.model !== model || (label === 'embedding' && health.ready !== true)) {
        throw new Error(`port ${port} is not serving the configured ${label} model ${model}`);
      }
      if (label === 'embedding') {
        const device = process.env.FOREXPLORE_EMBEDDING_DEVICE?.trim();
        const dtype = process.env.FOREXPLORE_EMBEDDING_DTYPE?.trim();
        if ((device && health.device !== device) || (dtype && health.dtype !== dtype)) {
          throw new Error(`port ${port} serves ${health.device}/${health.dtype}, expected ${device || 'automatic'}/${dtype || 'automatic'}`);
        }
      }
    }
    return { ready: true };
  } catch (error) { return { ready: false, detail: error.message }; }
}

/**
 * Detached so the service outlives this command; logs go to a file, never a pipe.
 * A log over 10 MiB moves to `<label>.log.1` (replacing the older one) first.
 */
function launch(label, script, env) {
  mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${label}.log`);
  try {
    if (statSync(log).size > maxLogBytes) renameSync(log, `${log}.1`);
  } catch {
    // No log yet, or it is still held open; keep appending.
  }
  const handle = openSync(log, 'a');
  const child = spawn(process.execPath, [script], { detached: true, windowsHide: true, stdio: ['ignore', handle, handle], cwd: process.cwd(),
    env: { ...process.env, ...cudaLibraryEnvironment(), ...env } });
  closeSync(handle);
  const launched = { child, log, error: undefined };
  child.once('error', error => { launched.error = error.message; });
  child.unref();
  return launched;
}

const results = [];
const step = async (label, port, action) => {
  const host = label === 'SeekDB' ? seekdbHost : '127.0.0.1';
  const occupied = await listening(port, host);
  let detail = 'not listening';
  if (occupied) {
    const health = await serviceReady(label, port);
    if (health.ready || label !== 'SeekDB') {
      results.push([label, port, health.ready ? 'ready (existing)' : `FAILED: ${health.detail}`]);
      return health.ready;
    }
    // Docker can expose TCP before the database has finished recovery.
    detail = health.detail;
  }
  const launched = occupied ? undefined : await action();
  if (launched === false) { results.push([label, port, 'FAILED: dependency could not start']); return false; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (launched?.error || (launched?.child && (launched.child.exitCode !== null || launched.child.signalCode !== null))) {
      detail = launched.error ?? `process exited (${launched.child.signalCode ?? launched.child.exitCode})`;
      break;
    }
    if (await listening(port, host)) {
      const health = await serviceReady(label, port);
      if (health.ready) {
        results.push([label, port, `ready${launched?.log ? ` (log: ${launched.log})` : ''}`]);
        return true;
      }
      detail = health.detail;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  results.push([label, port, `FAILED: ${detail}${launched?.log ? ` (log: ${launched.log})` : ''}`]);
  return false;
};

const seekdb = await step('SeekDB', seekdbPort, async () => {
  if (skipSeekDb || !['127.0.0.1', 'localhost', '::1'].includes(seekdbHost)) return undefined;
  try { await ensureDockerRuntime(); }
  catch (error) { console.error(`SeekDB: ${error.message}`); return false; }
  const started = spawnSync('docker', ['start', container], { stdio: 'inherit' });
  if (started.status !== 0) return false;
  return undefined;
});

const runtimeReady = (await listening(embeddingPort) && await listening(rerankPort)) || ensureEmbeddingRuntime();
if (!runtimeReady) console.error('Local embedding and rerank servers cannot start without the inference runtime.');
const modelHost = modelHostEnvironment();

const embedding = await step('embedding', embeddingPort, () => runtimeReady && launch('embedding', path.join('scripts', 'serve-local-embeddings.mjs'),
  { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_EMBEDDING_PORT: String(embeddingPort), ...modelHost }));

const rerank = await step('rerank', rerankPort, () => {
  if (rerankModel !== defaultRerankModel) {
    console.error(`The managed reranker serves only ${defaultRerankModel}. Start a compatible custom service for ${rerankModel} on 127.0.0.1:${rerankPort} with /health and /v1/rerank, or unset FOREXPLORE_RERANK_MODEL to use the managed model.`);
    return false;
  }
  return runtimeReady && launch('rerank', path.join('scripts', 'serve-local-reranker.mjs'),
    { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_RERANK_PORT: String(rerankPort), ...modelHost });
});

console.log('\nservice    port   status');
for (const [label, port, status] of results) console.log(`${label.padEnd(10)} ${String(port).padEnd(6)} ${status}`);
if (!seekdb || !embedding || !rerank) {
  console.error('\nModule search will not reach full recall until every service above is up.');
  process.exitCode = 1;
}
