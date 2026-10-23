import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), spawnSync: vi.fn(), connect: vi.fn(), database: vi.fn(), get: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('node:net', () => ({ createConnection: mocks.connect }));
vi.mock('mysql2/promise', () => ({ createConnection: mocks.database }));
vi.mock('node:http', () => ({ get: mocks.get }));
// The launcher tests exercise service startup; workspace mapping has its own
// tests and must not read real platform files through the mocked filesystem.
vi.mock('./check-platform-workspace.mjs', () => ({ checkPlatformWorkspace: vi.fn() }));
vi.mock('./extension-startup.mjs', () => ({ waitForExtensionStartup: vi.fn(async () => ({
  status: 'ready', semanticQueryUrl: 'http://127.0.0.1:12345', adaptationUrl: 'http://127.0.0.1:12346',
})) }));
vi.mock('./embedding-identity.mjs', () => ({ inferEmbeddingVariant: vi.fn(async () => 'dml-fp16') }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: () => true, readdirSync: () => ['cached-model'],
  readFileSync: () => '"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*',
  closeSync: vi.fn(), mkdirSync: vi.fn(), openSync: vi.fn(), renameSync: vi.fn(), statSync: vi.fn(), writeFileSync: vi.fn(),
}));

const argv = [...process.argv];
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
  vi.stubEnv('CODE_INTELLIGENCE_SEEKDB_PORT', '2881');
  vi.stubEnv('CODE_INTELLIGENCE_SEEKDB_HOST', '127.0.0.1');
  vi.stubEnv('FOREXPLORE_EMBEDDING_PORT', '4021');
  vi.stubEnv('FOREXPLORE_RERANK_PORT', '4022');
  vi.stubEnv('FOREXPLORE_EMBEDDING_MODEL', 'embedding-test');
  vi.stubEnv('FOREXPLORE_EMBEDDING_REVISION', 'revision');
  vi.stubEnv('FOREXPLORE_EMBEDDING_DEVICE', undefined);
  vi.stubEnv('FOREXPLORE_EMBEDDING_DTYPE', undefined);
  vi.stubEnv('FOREXPLORE_RERANK_MODEL', undefined);
  process.argv = ['node', 'script'];
  mocks.connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  mocks.database.mockResolvedValue({ query: vi.fn().mockResolvedValue([]), destroy: vi.fn() });
  mocks.get.mockImplementation((url, _options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn() });
      callback(response);
      response.emit('data', JSON.stringify({ ready: true, model: new URL(url).port === '4021'
        ? 'embedding-test@revision' : 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101' }));
      response.emit('end');
    });
    return request;
  });
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: 'redhat.java\n' });
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
});
afterEach(() => {
  process.argv = [...argv];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('checks the configured external SeekDB host without starting Docker', async () => {
  vi.stubEnv('CODE_INTELLIGENCE_SEEKDB_HOST', 'db.example');
  await import('./start-recast-services.mjs');
  expect(mocks.connect).toHaveBeenCalledWith({ host: 'db.example', port: 2881 });
  expect(mocks.database).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example', port: 2881 }));
  expect(mocks.spawnSync).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('honors skip-seek-db while waiting for an externally managed local database', async () => {
  process.argv.push('--skip-seek-db');
  mocks.connect.mockImplementationOnce(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => socket.emit('error', new Error('not listening yet')));
    return socket;
  });
  await import('./start-recast-services.mjs');
  expect(mocks.database).toHaveBeenCalled();
  expect(mocks.spawnSync).not.toHaveBeenCalled();
});

it('starts the reranker that implements the module search HTTP contract', async () => {
  let rerankProbes = 0;
  mocks.connect.mockImplementation(({ port }) => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    if (port === 4022) rerankProbes++;
    const missing = port === 4022 && rerankProbes === 2;
    queueMicrotask(() => socket.emit(missing ? 'error' : 'connect', missing ? new Error('not listening') : undefined));
    return socket;
  });
  mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, unref: vi.fn(),
  }));
  await import('./start-recast-services.mjs');
  expect(mocks.spawn).toHaveBeenCalledWith(process.execPath,
    [expect.stringMatching(/serve-local-reranker\.mjs$/)], expect.objectContaining({ windowsHide: true }));
});

it.each([undefined, '', 'Xenova/bge-reranker-base', 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101'])(
  'reuses the pinned production reranker for configured model %s', async configuredModel => {
    vi.stubEnv('FOREXPLORE_RERANK_MODEL', configuredModel);
    const previousExitCode = process.exitCode;
    try {
      await import('./start-recast-services.mjs');
      expect(process.exitCode).toBe(previousExitCode);
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { process.exitCode = previousExitCode; }
  });

it('reuses an externally managed custom reranker with its configured identity', async () => {
  vi.stubEnv('FOREXPLORE_RERANK_MODEL', 'custom-reranker@revision');
  mocks.get.mockImplementation((url, _options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn() });
      callback(response);
      response.emit('data', JSON.stringify({ ready: true, model: new URL(url).port === '4021'
        ? 'embedding-test@revision' : 'custom-reranker@revision' }));
      response.emit('end');
    });
    return request;
  });
  const previousExitCode = process.exitCode;
  try {
    await import('./start-recast-services.mjs');
    expect(process.exitCode).toBe(previousExitCode);
    expect(mocks.spawn).not.toHaveBeenCalled();
  } finally { process.exitCode = previousExitCode; }
});

it('fails immediately when a custom reranker is not externally running', async () => {
  vi.stubEnv('FOREXPLORE_RERANK_MODEL', 'custom-reranker@revision');
  mocks.connect.mockImplementation(({ port }) => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => socket.emit(port === 4022 ? 'error' : 'connect', port === 4022 ? new Error('not listening') : undefined));
    return socket;
  });
  const previousExitCode = process.exitCode;
  try {
    await import('./start-recast-services.mjs');
    expect(process.exitCode).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Start a compatible custom service'));
  } finally { process.exitCode = previousExitCode; }
});

it('rejects an occupied CPU service when CUDA was explicitly requested', async () => {
  vi.stubEnv('FOREXPLORE_EMBEDDING_DEVICE', 'cuda');
  const previousExitCode = process.exitCode;
  try {
    await import('./start-recast-services.mjs');
    expect(process.exitCode).toBe(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('expected cuda/automatic'));
  } finally { process.exitCode = previousExitCode; }
});

it('forwards skip-seek-db through the launcher npm separator', async () => {
  process.argv.push('--skip-seek-db');
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(mocks.spawnSync).toHaveBeenCalledWith(expect.stringMatching(/^npm/),
    ['run', 'services:up', '--', '--skip-seek-db'], expect.anything());
  expect(mocks.spawnSync.mock.calls.some(([command]) => command === 'docker')).toBe(false);
});

it.each([
  [undefined, 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101'],
  ['Xenova/bge-reranker-base', 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101'],
  ['custom-reranker@revision', 'custom-reranker@revision'],
])('configures extension reranker model %s as %s', async (configuredModel, expectedModel) => {
  vi.stubEnv('FOREXPLORE_RERANK_MODEL', configuredModel);
  vi.stubEnv('CODE_INTELLIGENCE_RERANK_URL', '');
  vi.stubEnv('CODE_INTELLIGENCE_RERANK_MODEL', '');
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(process.env.CODE_INTELLIGENCE_RERANK_URL).toBe('http://127.0.0.1:4022/v1/rerank');
  expect(process.env.CODE_INTELLIGENCE_RERANK_MODEL).toBe(expectedModel);
});

it('preserves explicit extension reranker endpoint and identity', async () => {
  vi.stubEnv('FOREXPLORE_RERANK_MODEL', 'launcher-reranker@revision');
  vi.stubEnv('CODE_INTELLIGENCE_RERANK_URL', 'http://127.0.0.1:4039/v1/rerank');
  vi.stubEnv('CODE_INTELLIGENCE_RERANK_MODEL', 'external-reranker@revision');
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(process.env.CODE_INTELLIGENCE_RERANK_URL).toBe('http://127.0.0.1:4039/v1/rerank');
  expect(process.env.CODE_INTELLIGENCE_RERANK_MODEL).toBe('external-reranker@revision');
});

it('does not launch local Docker for a configured remote database', async () => {
  vi.stubEnv('CODE_INTELLIGENCE_SEEKDB_HOST', 'db.example');
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(mocks.spawnSync.mock.calls.some(([command]) => command === 'docker')).toBe(false);
});

it('reuses a healthy local database even when Docker control commands are unavailable', async () => {
  mocks.spawnSync.mockImplementation((command) => command === 'docker'
    ? { status: 1, error: new Error('Docker control plane unavailable') }
    : { status: 0, stdout: 'redhat.java\n' });
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(mocks.database).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 2881 }));
  expect(mocks.spawnSync.mock.calls.some(([command]) => command === 'docker')).toBe(false);
});

it('starts the local engine when its SQL endpoint is unavailable', async () => {
  mocks.database.mockRejectedValueOnce(new Error('Connection refused'));
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  expect(mocks.spawnSync.mock.calls.some(([command, args]) => command === 'docker' && args[0] === 'info')).toBe(true);
});

it('finds Docker Desktop in either Windows installation layout', async () => {
  const { dockerDesktopCandidates } = await import('./docker-runtime.mjs');
  expect(dockerDesktopCandidates('win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' }))
    .toEqual(['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', 'C:\\Users\\user\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe']);
});

it('reports readiness even while the Remote WSL launcher stays attached', async () => {
  mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  await import('./run-vscode-extension.mjs');
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith(expect.stringContaining('RECAST services ready:')));
});
