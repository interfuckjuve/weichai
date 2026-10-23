#!/usr/bin/env node

/**
 * Cross-platform development launcher for the VS Code extension.
 *
 * This prepares SeekDB and local embedding/reranking, builds the extension,
 * and opens the Extension Development Host. The extension alone starts its
 * workspace-bound adaptation backend after its semantic endpoint is known.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlatformWorkspace } from './check-platform-workspace.mjs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { waitForExtensionStartup } from './extension-startup.mjs';
import { ensureDockerRuntime } from './docker-runtime.mjs';
import { inferEmbeddingVariant } from './embedding-identity.mjs';
import { createConnection as connectDatabase } from 'mysql2/promise';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'apps', 'vscode-extension');
const composeFile = path.join(repoRoot, 'services', 'code-intelligence-service', 'infra', 'docker-compose.yml');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vscodeCommand = process.env.FOREXPLORE_VSCODE_COMMAND?.trim() || 'code';

function usage() {
  console.log(`Usage: npm run dev:extension -- [options]

Options:
  --skip-seek-db       Do not run docker compose for SeekDB.
  --skip-services      Do not start local embedding/reranking dependencies.
  --folder <path>      Folder to open in the Extension Development Host.
  --preloaded          Open the ignored preloaded-workbench profile without scanning.
  --workspace <path>   .code-workspace file for --preloaded.
  --database <name>    SeekDB database for --preloaded.
  --user-data-dir <p>  Isolated VS Code user-data directory.
  --help               Show this help.

The Extension Development Host opens after dependency services are ready.
Use --skip-services for externally managed embedding/reranking dependencies.

The legacy PowerShell spellings (-SkipSeekDb, -SkipServices and -Folder) are
also accepted so existing Windows command lines remain compatible.`);
}

function parseArgs(argv) {
  const options = {
    skipSeekDb: false, skipServices: false, preloaded: false,
    folder: undefined, database: undefined, userDataDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const normalized = argument.toLowerCase();
    if (normalized === '--help' || normalized === '-help' || normalized === '-h') {
      usage();
      process.exit(0);
    }
    if (['--skip-seek-db', '--skipseekdb', '-skipseekdb'].includes(normalized)) {
      options.skipSeekDb = true;
      continue;
    }
    if (['--skip-services', '--skipservices', '-skipservices'].includes(normalized)) {
      options.skipServices = true;
      continue;
    }
    if (normalized === '--preloaded') {
      options.preloaded = true;
      continue;
    }
    if (normalized === '--database') {
      options.database = argv[++index];
      if (!options.database) throw new Error(`${argument} requires a database name.`);
      continue;
    }
    if (normalized.startsWith('--database=')) {
      options.database = argument.slice(argument.indexOf('=') + 1);
      if (!options.database) throw new Error(`${argument} requires a database name.`);
      continue;
    }
    if (normalized === '--workspace') {
      options.folder = argv[++index];
      if (!options.folder) throw new Error(`${argument} requires a workspace path.`);
      continue;
    }
    if (normalized.startsWith('--workspace=')) {
      options.folder = argument.slice(argument.indexOf('=') + 1);
      if (!options.folder) throw new Error(`${argument} requires a workspace path.`);
      continue;
    }
    if (normalized === '--user-data-dir') {
      options.userDataDir = argv[++index];
      if (!options.userDataDir) throw new Error(`${argument} requires a directory.`);
      continue;
    }
    if (normalized.startsWith('--user-data-dir=')) {
      options.userDataDir = argument.slice(argument.indexOf('=') + 1);
      if (!options.userDataDir) throw new Error(`${argument} requires a directory.`);
      continue;
    }
    if (normalized === '--folder' || normalized === '-folder') {
      options.folder = argv[++index];
      if (!options.folder) throw new Error(`${argument} requires a path.`);
      continue;
    }
    if (normalized.startsWith('--folder=') || normalized.startsWith('-folder=')) {
      options.folder = argument.slice(argument.indexOf('=') + 1);
      if (!options.folder) throw new Error(`${argument} requires a path.`);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function shellArgs(args) {
  if (process.platform !== 'win32') return args;
  // npm.cmd and the VS Code launcher need cmd.exe on Windows. Quote only
  // arguments that need it so repository paths containing spaces survive the
  // shell boundary.
  return args.map((argument) => /[\s"]/.test(argument)
    ? `"${argument.replace(/"/g, '\\"')}"`
    : argument);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, process.platform === 'win32' && options.shell !== false ? shellArgs(args) : args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireSuccess(command, args, label) {
  const status = runSync(command, args);
  if (status !== 0) throw new Error(`${label} failed with exit code ${status}.`);
}

function ensureCommand(command, args = ['--version']) {
  const result = spawnSync(command, shellArgs(args), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Required command '${command}' is not available on PATH.`);
  }
  return result;
}

function existingContainerState(name) {
  const inspected = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', name], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (inspected.error || inspected.status !== 0) return undefined;
  const state = inspected.stdout.trim();
  return state || undefined;
}

function ensureVsCodeExtension(extensionId) {
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME && extensionId === 'ms-vscode-remote.remote-wsl') {
    // Remote WSL belongs to the Windows client. After it is installed, `code`
    // inside WSL lists/manages Linux extensions, so check the client directly.
    const shim = path.isAbsolute(vscodeCommand) ? vscodeCommand : (process.env.PATH ?? '').split(path.delimiter)
      .map(directory => path.join(directory, vscodeCommand)).find(candidate => existsSync(`${candidate}.cmd`));
    if (!shim || !existsSync(`${shim}.cmd`)) return; // Already using a native/remote Linux CLI.
    const wrapper = `${shim}.cmd`;
    const paths = [...readFileSync(wrapper, 'utf8').matchAll(/"%~dp0([^"\r\n]+)"/g)]
      .map(match => path.resolve(path.dirname(wrapper), match[1].replaceAll('\\', '/')));
    if (!paths[0]?.endsWith('.exe') || !paths[1]?.endsWith('cli.js')) throw new Error('Unable to resolve the Windows VS Code client for WSL.');
    const converted = spawnSync('wslpath', ['-m', paths[1]], { encoding: 'utf8' });
    if (converted.status !== 0) throw new Error('Unable to resolve the Windows VS Code CLI path.');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', WSLENV: `ELECTRON_RUN_AS_NODE/w:${process.env.WSLENV ?? ''}` };
    const invoke = args => spawnSync(paths[0], [converted.stdout.trim(), ...args], { env, encoding: 'utf8', timeout: 180_000 });
    const listed = invoke(['--list-extensions']);
    if (listed.error || listed.status !== 0) throw new Error('Unable to inspect the Windows VS Code extensions.');
    if (listed.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase() === extensionId)) return;
    console.log(`Installing required Windows VS Code extension: ${extensionId}`);
    const installed = invoke(['--install-extension', extensionId]);
    if (installed.error || installed.status !== 0) throw new Error(`Unable to install ${extensionId}: ${installed.error?.message ?? installed.stderr}`);
    return;
  }
  ensureCommand(vscodeCommand, ['--version']);
  const listed = spawnSync(vscodeCommand, shellArgs(['--list-extensions']), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(`Unable to list VS Code extensions using '${vscodeCommand}'.`);
  }
  const installed = listed.stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase());
  if (installed.includes(extensionId.toLowerCase())) return;

  console.log(`Installing required VS Code extension: ${extensionId}`);
  requireSuccess(vscodeCommand, ['--install-extension', extensionId], `VS Code extension ${extensionId} installation`);
}

function setDefault(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function configureEnvironment(options) {
  if (options.preloaded) {
    // The preloaded window is deliberately opt-in. It uses the same runtime
    // composition as dev:extension, while making the bootstrap mode explicit
    // to the trusted extension host.
    process.env.FOREXPLORE_PRELOADED = '1';
    process.env.FOREXPLORE_AUTO_OPEN_PANEL = '1';
    if (options.database) process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = options.database;
  } else {
    // Do not let a stale shell variable turn the ordinary entry into the
    // preloaded profile after a previous local demo run.
    delete process.env.FOREXPLORE_PRELOADED;
    delete process.env.FOREXPLORE_PRELOADED_MANIFEST;
  }
  process.env.FOREXPLORE_AUTO_OPEN_PANEL = '1';
  setDefault('FOREXPLORE_SOURCE_SNAPSHOT_DIR', path.join(homedir(), '.cache', 'recast', 'source-snapshots'));
  setDefault('CODE_INTELLIGENCE_SEEKDB_DATABASE', options.preloaded
    ? 'forexplore_asset_upgrade_20261004'
    : 'forexplore_javafileupload_flow_20260913');
  setDefault('CODE_INTELLIGENCE_SEEKDB_PORT', process.env.SEEKDB_PORT || '2881');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_URL', `http://127.0.0.1:${process.env.FOREXPLORE_EMBEDDING_PORT || '4021'}/v1/embeddings`);
  setDefault('CODE_INTELLIGENCE_EMBEDDING_MODEL', 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS', 'false');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX', 'query: ');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX', 'passage: ');
  setDefault('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION', '384');
  setDefault('CODE_INTELLIGENCE_RERANK_URL', `http://127.0.0.1:${process.env.FOREXPLORE_RERANK_PORT || '4022'}/v1/rerank`);
  const rerankModel = process.env.FOREXPLORE_RERANK_MODEL?.trim();
  setDefault('CODE_INTELLIGENCE_RERANK_MODEL', !rerankModel || rerankModel === 'Xenova/bge-reranker-base'
    ? 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101' : rerankModel);
  // Device and precision change the produced vectors, so the workbench must declare
  // the same embedding variant as the offline ingestion: the store scopes embedding
  // reuse by model identity, and a mismatch would mix providers inside one index.
}

/**
 * When WSL invokes the Windows `code` launcher, only variables listed in
 * WSLENV reach the Windows extension host. Keep the runtime contract intact
 * across that boundary without forwarding the entire WSL environment.
 */
function configureWslEnvironmentPassthrough() {
  if (process.platform === 'win32') return;
  const prefixes = ['FOREXPLORE_', 'CODE_INTELLIGENCE_', 'ADAPTATION_', 'RECAST_', 'SEEKDB_'];
  const explicit = ['DEEPSEEK_API_KEY', 'SEMANTIC_QUERY_PORT_TOKEN'];
  const pathNames = new Set([
    'FOREXPLORE_PRELOADED_MANIFEST', 'FOREXPLORE_PRELOADED_WORKSPACE',
    'FOREXPLORE_MODEL_CACHE', 'FOREXPLORE_EMBEDDING_TOOLS', 'RECAST_SERVICES_LOG_DIR',
    'ADAPTATION_CODEX_HOME',
  ]);
  const names = Object.keys(process.env).filter(name => prefixes.some(prefix => name.startsWith(prefix)) || explicit.includes(name));
  const blocked = new Set(['CODEX_BIN', 'CODEX_MODEL']);
  const entries = (process.env.WSLENV ?? '').split(':').filter(Boolean)
    .filter(entry => !blocked.has(entry.split('/')[0]));
  for (const name of names) {
    if (entries.some(entry => entry.split('/')[0] === name)) continue;
    entries.push(`${name}/${pathNames.has(name) || /(?:PATH|ROOT|DIR|FILE|CACHE|TOOLS)$/i.test(name) ? 'p' : 'w'}`);
  }
  if (entries.length) process.env.WSLENV = entries.join(':');
}


function resolveFolder(folder) {
  const resolved = path.resolve(repoRoot, folder);
  if (!existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}

function workspaceConfiguredRoots(workspacePath) {
  try {
    const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'));
    const folders = Array.isArray(workspace.folders) ? workspace.folders : [];
    return folders
      .filter((folder) => folder && typeof folder.path === 'string')
      .map((folder) => path.resolve(path.dirname(workspacePath), folder.path));
  } catch {
    return [];
  }
}

function defaultPreloadedWorkspace() {
  const candidates = [];
  if (process.env.FOREXPLORE_PRELOADED_WORKSPACE?.trim()) {
    candidates.push(process.env.FOREXPLORE_PRELOADED_WORKSPACE.trim());
  }
  candidates.push(path.join(repoRoot, 'experiments', 'enterprise-asset-upgrade', 'AssetUpgradeGateway.code-workspace'));
  // The source checkout and the materialized enterprise corpus can live in
  // different platform workspaces. Prefer the workspace whose configured
  // folders actually exist, while keeping the normal checkout as the fallback.
  try {
    const platforms = JSON.parse(readFileSync(path.join(repoRoot, '.recast-platforms.json'), 'utf8'));
    if (process.platform !== 'win32' && typeof platforms.windowsMountRoot === 'string') {
      candidates.push(path.join(platforms.windowsMountRoot, 'experiments', 'enterprise-asset-upgrade', 'AssetUpgradeGateway.code-workspace'));
    }
  } catch {
    // The mapping is optional outside the two platform workspaces.
  }
  return candidates
    .map((candidate) => path.resolve(repoRoot, candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index && existsSync(candidate))
    .sort((left, right) => {
      const score = (candidate) => workspaceConfiguredRoots(candidate).filter((root) => existsSync(root)).length;
      return score(right) - score(left);
    })[0];
}


async function startServices(options) {
  if (options.skipServices) return;
  const servicesStatus = runSync(npmCommand, ['run', 'services:up', ...(options.skipSeekDb ? ['--', '--skip-seek-db'] : [])]);
  if (servicesStatus !== 0) {
    throw new Error('Dependency startup failed; inspect the diagnostics above. The development host was not opened.');
  }
}

/** Start the configured SeekDB container without changing its durable volume. */
async function startSeekDb(options) {
  if (options.skipSeekDb) return true;
  const host = process.env.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return true;
  // An already available database is the readiness signal, including a database
  // shared from WSL. A slow Docker control plane must not block that service.
  let connection;
  try {
    connection = await connectDatabase({ host,
      port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? process.env.SEEKDB_PORT ?? 2881),
      user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? 'root',
      password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? process.env.SEEKDB_PASSWORD ?? '',
      connectTimeout: 5000 });
    await connection.query({ sql: 'SELECT 1', timeout: 5000 });
    console.log('SeekDB SQL is ready; reusing the running database.');
    return true;
  } catch { /* Start the configured local engine below when SQL is unavailable. */ }
  finally { connection?.destroy(); }
  if (!existsSync(composeFile)) {
    console.warn(`SeekDB compose file does not exist: ${composeFile}. Code intelligence will report fetch failures.`);
    return false;
  }
  try {
    ensureCommand('docker', ['--version']);
    await ensureDockerRuntime();
  } catch (error) {
    console.warn(`${error.message} SeekDB stays down; code intelligence will report fetch failures.`);
    return false;
  }

  // The container name is deliberately stable so other RECAST processes can
  // share the same SeekDB instance. Compose exits with a name-conflict error
  // when that instance already exists, even when it is healthy. Reuse it first;
  // only ask Compose to create a container when Docker has no such container.
  const existing = existingContainerState('forexplore-seekdb');
  if (existing === 'running') {
    console.log('SeekDB container forexplore-seekdb already exists; reusing it.');
    return true;
  }
  if (existing) {
    const started = runSync('docker', ['start', 'forexplore-seekdb']);
    if (started === 0) {
      console.log(`SeekDB container forexplore-seekdb was ${existing}; started it.`);
      return true;
    }
    console.warn(`SeekDB container forexplore-seekdb exists but could not be started (state: ${existing}).`);
    return false;
  }
  const status = runSync('docker', ['compose', '-f', composeFile, 'up', '-d']);
  if (status !== 0) {
    console.warn(`SeekDB startup failed with exit code ${status}. Code intelligence will report fetch failures.`);
    return false;
  }
  return true;
}


/** Open the Extension Development Host and settle when its launcher process exits. */
async function launchHost(options) {
  const args = [`--extensionDevelopmentPath=${extensionRoot}`, '--new-window'];
  // VS Code reloads an existing development host but keeps its old process
  // environment. Pass the public runtime contract explicitly on every launch.
  // Credentials stay in the inherited environment / VS Code secret storage.
  const publicEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:FOREXPLORE_|CODE_INTELLIGENCE_|RECAST_|ADAPTATION_PORT$)/.test(name) &&
    !/(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i.test(name)));
  publicEnvironment.FOREXPLORE_PRELOADED = options.preloaded ? '1' : '0';
  const launchFile = path.join(repoRoot, 'output/recast-startup/current-launch.json');
  const temporaryLaunchFile = `${launchFile}.${process.pid}.tmp`;
  await writeFile(temporaryLaunchFile, JSON.stringify({ version: 1, environment: publicEnvironment }));
  await rename(temporaryLaunchFile, launchFile);
  args.push('--extensionEnvironment', JSON.stringify(publicEnvironment));
  if (options.preloaded || options.userDataDir) {
    const userDataDir = path.resolve(repoRoot, options.userDataDir || '.recast-preloaded/vscode-user-data');
    await mkdir(userDataDir, { recursive: true });
    args.push('--user-data-dir', userDataDir);
  }
  if (options.folder) args.push(options.folder);
  // Invoke the Node CLI directly on Windows: shell quoting cannot safely carry
  // JSON environment values or paths containing shell metacharacters.
  let command = vscodeCommand;
  let commandArgs = args;
  let cliEnvironment = process.env;
  if (process.platform === 'win32') {
    const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(path.delimiter)
      .map(directory => path.join(directory, command.endsWith('.cmd') ? command : `${command}.cmd`));
    const wrapper = candidates.find(candidate => existsSync(candidate));
    const paths = wrapper ? [...readFileSync(wrapper, 'utf8').matchAll(/"%~dp0([^"\r\n]+)"/g)].map(match => path.resolve(path.dirname(wrapper), match[1])) : [];
    if (paths[0]?.endsWith('.exe') && paths[1]?.endsWith('cli.js')) {
      command = paths[0]; commandArgs = [paths[1], ...args];
      cliEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    } else if (!command.toLowerCase().endsWith('.exe')) {
      throw new Error('Unable to resolve the VS Code Node launcher; set FOREXPLORE_VSCODE_COMMAND to the VS Code executable.');
    }
  }
  const vscode = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: cliEnvironment,
    stdio: 'inherit',
    shell: false,
  });
  const exited = new Promise((resolve, reject) => {
    vscode.once('error', reject);
    vscode.once('exit', (code, signal) => {
      if (signal) reject(new Error(`VS Code exited due to signal ${signal}.`));
      else if (code !== 0) reject(new Error(`VS Code exited with code ${code}.`));
      else resolve();
    });
  });
  return { child: vscode, exited };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.chdir(repoRoot);
  checkPlatformWorkspace(repoRoot);
  configureEnvironment(options);

  if (options.preloaded && !options.folder) {
    options.folder = defaultPreloadedWorkspace();
    if (!options.folder) {
      throw new Error('找不到预置工作区。请使用 --workspace <path> 或 FOREXPLORE_PRELOADED_WORKSPACE 指定 .code-workspace 文件。');
    }
  }


  // Without Remote WSL, the Windows `code` shim opens a local window with a
  // Linux extension path, and the extension never activates.
  if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) {
    ensureVsCodeExtension('ms-vscode-remote.remote-wsl');
  }
  ensureVsCodeExtension('redhat.java');
  if (!await startSeekDb(options)) throw new Error('SeekDB startup failed; resolve the Docker error above before opening the development host.');

  if (options.preloaded) {
    const { preparePreloadedWorkspace } = await import('./prepare-preloaded-workspace.mjs');
    const database = process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
    const prepared = await preparePreloadedWorkspace({
      workspacePath: options.folder,
      outputDirectory: path.join(repoRoot, '.recast-preloaded', database),
      database,
    });
    process.env.FOREXPLORE_PRELOADED_MANIFEST = prepared.manifestPath;
    console.log(`Preloaded workbench: ${prepared.manifest.repositories.length} persisted repositories bound from ${database}.`);
  }

  requireSuccess(npmCommand, ['run', 'build:extension'], 'Extension build');

  if (options.folder) options.folder = resolveFolder(options.folder);

  await startServices(options);
  if (!process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT) {
    process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT = await inferEmbeddingVariant(process.env.CODE_INTELLIGENCE_EMBEDDING_URL);
  }
  const reportDirectory = path.join(repoRoot, 'output', 'recast-startup');
  await mkdir(reportDirectory, { recursive: true });
  process.env.FOREXPLORE_STARTUP_REPORT = path.join(reportDirectory, `${randomUUID()}.json`);
  configureWslEnvironmentPassthrough();
  console.log('Dependencies are ready; opening the development host.');
  console.log('VS Code will reload an existing development host with the current runtime configuration.');
  const host = await launchHost(options);
  // Remote WSL's CLI can remain attached to a live window. Its exit is not the
  // readiness signal; only failures should race the extension's acknowledgement.
  const ready = await Promise.race([
    waitForExtensionStartup(process.env.FOREXPLORE_STARTUP_REPORT, Number(process.env.RECAST_EXTENSION_WAIT_MS || 120_000)),
    host.exited.then(() => new Promise(() => {})),
  ]);
  host.child.unref?.();
  console.log(`RECAST services ready: index ${ready.semanticQueryUrl}; model backend ${ready.adaptationUrl}.`);
}

main().catch((error) => {
  console.error(`dev:extension failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
