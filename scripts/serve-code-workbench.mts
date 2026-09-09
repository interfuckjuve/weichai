import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { ModuleTarget, RepositoryRole, TaskRetrievalRequest } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, createSemanticQueryHttpServer, validateTaskRetrievalRequest } from '../services/code-intelligence-service/src/index.js';
import { CodeIntelligenceHost, codeIntelligenceRuntimeOptionsFromEnvironment } from '../apps/vscode-extension/src/code-intelligence-host.js';
import { buildProjectExplorer, readExplorerChildren, type ExplorerChildrenIndex } from '../apps/vscode-extension/src/project-explorer.js';
import { HttpModuleHierarchyPlanner } from '../apps/vscode-extension/src/module-hierarchy-client.js';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client.js';
import { isWebviewToHostMessage, type HostToWebviewMessage, type PanelInitPayload, type WebviewToHostMessage } from '../apps/vscode-extension/src/protocol/messages.js';

const { values } = parseArgs({ options: {
  target: { type: 'string', multiple: true }, reference: { type: 'string', multiple: true },
  port: { type: 'string', default: '4040' }, 'semantic-port': { type: 'string', default: '4041' },
  database: { type: 'string' }, 'register-only': { type: 'boolean', default: false },
  'rebuild-modules': { type: 'boolean', default: false }, 'hierarchy-url': { type: 'string' },
  'adaptation-url': { type: 'string' }, 'structural-baseline': { type: 'boolean', default: false },
} });
const root = process.cwd();
const workspaceTranslation = new WorkspaceTranslationHost(() => ({ url: values['adaptation-url'] ?? '',
  token: process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN, profile: process.env.FOREXPLORE_TRANSLATION_PROFILE }));
const targets = values.target?.length ? values.target : [root];
const references = values.reference ?? [];
const inputs = await Promise.all([
  ...targets.map((localPath) => ({ localPath, role: 'target' as RepositoryRole })),
  ...references.map((localPath) => ({ localPath, role: 'history' as RepositoryRole })),
].map(async (input) => ({ ...input, localPath: await realpath(path.resolve(input.localPath)) })));
const visiblePaths = new Set(inputs.map((input) => input.localPath));
const environment = { ...process.env };
const hierarchyUrl = values['hierarchy-url'] ?? values['adaptation-url'];
try {
  const legacy = parseEnv(await readFile(path.join(root, 'services/retrieval-service/.env'), 'utf8'));
  for (const name of ['HOST', 'PORT', 'USER', 'PASSWORD']) environment[`CODE_INTELLIGENCE_SEEKDB_${name}`] ??= legacy[`SEEKDB_${name}`];
} catch { /* Environment-only deployments do not require a repository .env file. */ }
environment.CODE_INTELLIGENCE_SEEKDB_DATABASE = values.database ?? environment.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? 'forexplore_code_workbench';
const runtimeOptions = codeIntelligenceRuntimeOptionsFromEnvironment(environment, { allowInMemory: false });
const clients = new Set<ServerResponse>();
let notification: ReturnType<typeof setTimeout> | undefined;
let modelVersion = 0;
function changed(): void {
  modelVersion++;
  if (notification) return;
  notification = setTimeout(() => {
    notification = undefined;
    for (const client of clients) client.write(`data: ${modelVersion}\n\n`);
  }, 150);
}
const runtime = await createCodeIntelligenceRuntime({ ...runtimeOptions, projectAnalysis: {
  onChange: changed, hierarchyPlanner: hierarchyUrl ? new HttpModuleHierarchyPlanner(hierarchyUrl) : undefined,
  allowStructuralFallback: values['structural-baseline'],
  plan: values['adaptation-url'] ? (scope) => requestSemanticModuleMigrationProposal(values['adaptation-url']!, scope, undefined, AbortSignal.timeout(300_000)) : undefined,
} });
const host = new CodeIntelligenceHost({
  runtimeFactory: async () => runtime, runtimeOptions, projectAnalysisPort: runtime.projectAnalysis,
  storageKind: 'seekdb', onChange: changed, output: { appendLine: (line) => console.info(line) },
});
const registration = await host.synchronize({ repositories: inputs, scan: false });
const registrationFailed = registration.presentation.status === 'error' || registration.presentation.repositories.length !== new Set(inputs.map((input) => input.localPath)).size;
let currentTarget: ModuleTarget | undefined;
let currentTargets = new Map<string, ModuleTarget>();
let currentChildren: ExplorerChildrenIndex = new Map();
let topK = 4;
let status: 'indexing' | 'ready' | 'error' = registrationFailed ? 'error' : values['register-only'] ? 'ready' : 'indexing';
let failure: string | undefined = registrationFailed ? '部分工程注册失败，请查看服务日志。' : undefined;
let refreshing: Promise<void> | undefined;
let cached: { version: number; payload: PanelInitPayload } | undefined;
let loadingPayload: Promise<PanelInitPayload> | undefined;

async function adaptationStatus(): Promise<PanelInitPayload['serviceStatus']['adaptation']> {
  type PlanningCapability = 'semanticModulePlanning' | 'moduleHierarchyPlanning';
  const requirements: Array<[string | undefined, PlanningCapability]> = [
    [values['adaptation-url'], 'semanticModulePlanning'],
    [hierarchyUrl, 'moduleHierarchyPlanning'],
  ];
  if (!requirements.some(([endpoint]) => endpoint)) return 'unconfigured';
  try {
    const endpoints = new Map<string, Set<PlanningCapability>>();
    for (const [endpoint, capability] of requirements) {
      if (!endpoint) continue;
      const url = new URL(endpoint);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/health`;
      url.search = ''; url.hash = '';
      const key = url.toString();
      const capabilities = endpoints.get(key) ?? new Set<PlanningCapability>();
      capabilities.add(capability); endpoints.set(key, capabilities);
    }
    const available = await Promise.all([...endpoints].map(async ([endpoint, capabilities]) => {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
      const health = await response.json() as { capabilities?: Partial<Record<PlanningCapability, boolean>> };
      return response.ok && [...capabilities].every((capability) => health.capabilities?.[capability] === true);
    }));
    return available.every(Boolean) ? 'connected' : 'error';
  } catch { return 'error'; }
}

async function payload(): Promise<PanelInitPayload> {
  if (cached?.version === modelVersion) return cached.payload;
  if (loadingPayload) return loadingPayload;
  const version = modelVersion;
  loadingPayload = (async () => {
    const explorer = await buildProjectExplorer(host, currentTarget);
    currentTargets = explorer.targets;
    currentChildren = explorer.childrenByNodeId;
    const presentation = await host.presentation();
    const registered = new Map((await runtime.registry.list()).map((repository) => [repository.localPath, repository]));
    const result: PanelInitPayload = {
      target: currentTarget ?? null,
      workspaceRoot: path.basename(inputs[0]!.localPath),
      settings: { repositoryPaths: inputs.filter((item) => item.role === 'history').map((item) => item.localPath), topK },
      repositoryStatuses: inputs.filter((item) => item.role === 'history').map((item) => {
        const repository = registered.get(item.localPath);
        return { path: item.localPath, exists: true, readable: true, indexed: Boolean(repository?.activeRevision),
          stale: Boolean(repository?.activeRevision && repository.analysisStatus === 'failed'), message: repository?.activeRevision ? '已建立版本化索引' : '等待建库' };
      }),
      codeIntelligence: presentation,
      moduleExplorer: explorer.presentation,
      serviceStatus: { retrieval: 'connected', adaptation: await adaptationStatus(), executionMode: 'real' },
      searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
    };
    cached = { version, payload: result };
    return result;
  })();
  try { return await loadingPayload; } finally { loadingPayload = undefined; }
}

async function updates(): Promise<HostToWebviewMessage[]> {
  const current = await payload();
  return [{ type: 'CODE_INTELLIGENCE_STATUS', presentation: current.codeIntelligence },
    { type: 'MODULE_EXPLORER', explorer: current.moduleExplorer },
    ...(failure ? [{ type: 'ERROR' as const, message: failure }] : [])];
}

async function build(repositoryId?: string, modulesOnly = false): Promise<void> {
  if (refreshing) return refreshing;
  status = 'indexing'; failure = undefined; changed();
  refreshing = (async () => {
    const result = await host.synchronize({ repositories: inputs, ...(modulesOnly ? { scan: false } : {}), ...(repositoryId ? { scanRepositoryIds: [repositoryId] } : {}) });
    if (result.failedRepositoryIds.length || result.presentation.status === 'error' || result.presentation.repositories.length !== new Set(inputs.map((input) => input.localPath)).size) throw new Error('部分工程注册或建库失败，请查看服务日志。');
    const visible = await host.presentation();
    for (const repository of visible.repositories) {
      if (!repository.activeRevision || repositoryId && repository.repositoryId !== repositoryId) continue;
      const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision };
      for (const project of await runtime.store.listProjects(scope)) {
        const projectScope = { ...scope, projectId: project.projectId };
        await runtime.projectAnalysis.ensure(projectScope, modulesOnly);
        const record = await runtime.projectAnalysis.read(projectScope);
        if (record.state !== 'ready' || record.projection !== 'ready') throw new Error(record.error ?? '模块建模或检索同步未完成。');
      }
    }
    await runtime.projectAnalysis.idle();
    status = 'ready';
  })().catch((error) => {
    status = 'error'; failure = error instanceof Error ? error.message : String(error); console.error(error);
  }).finally(() => { refreshing = undefined; changed(); });
  return refreshing;
}

async function message(value: WebviewToHostMessage, signal: AbortSignal): Promise<HostToWebviewMessage[]> {
  switch (value.type) {
    case 'WORKSPACE_TRANSLATION': return [await workspaceTranslation.handle(value)];
    case 'READY': return [{ type: 'INIT', payload: await payload() }];
    case 'LOAD_MODULE_CHILDREN':
      try {
        await payload();
        return [{ type: 'MODULE_CHILDREN', requestId: value.requestId, page: readExplorerChildren(currentChildren, value.request) }];
      } catch (error) {
        return [{ type: 'MODULE_CHILDREN_ERROR', requestId: value.requestId, message: error instanceof Error ? error.message : String(error) }];
      }
    case 'START_TASK_SEARCH':
      try { const packet = await host.searchTaskContext(value.requestId, value.targetScope, value.request, signal); workspaceTranslation.remember(packet);
        return [{ type: 'TASK_SEARCH_RESULT', requestId: value.requestId, packet }]; }
      catch (error) { return [{ type: 'TASK_SEARCH_ERROR', requestId: value.requestId, message: error instanceof Error ? error.message : String(error) }]; }
    case 'REFRESH_REPOSITORY': {
      const visible = await host.presentation();
      if (!visible.repositories.some((repository) => repository.repositoryId === value.repositoryId)) throw new Error('工程不在当前工作台范围内。');
      void build(value.repositoryId); return updates();
    }
    case 'REFRESH_MODULE_EXPLORER': changed(); return updates();
    case 'SELECT_CODE_INTELLIGENCE_PROJECT':
      await host.selectProjectForDisplay(value); currentTarget = undefined; changed();
      return [{ type: 'TARGET_CLEARED' }, ...await updates()];
    case 'SELECT_CODE_INTELLIGENCE_REVISION':
      await host.selectRevisionForDisplay(value); currentTarget = undefined; changed();
      return [{ type: 'TARGET_CLEARED' }, ...await updates()];
    case 'RETRY_PROJECT_ANALYSIS': await host.retryProject(value, value.force); changed(); return updates();
    case 'SELECT_WORKSPACE_TARGET': {
      await payload();
      const target = currentTargets.get(value.targetId);
      if (!target) throw new Error('目标不属于当前显示的工程版本。');
      currentTarget = target; changed(); return [{ type: 'TARGET_SELECTED', target }];
    }
    case 'START_SEARCH':
      if (!currentTarget) throw new Error('请先选择目标模块、类或函数。');
      return [{ type: 'SEARCH_RESULT', candidates: await host.searchHistoricalImplementations({ target: currentTarget, requirement: value.requirement, topK: value.topK }, signal) }];
    case 'CHECK_REPOSITORIES': return [{ type: 'REPOSITORY_STATUS', statuses: (await payload()).repositoryStatuses }];
    case 'SAVE_SETTINGS': {
      const current = await payload();
      if (JSON.stringify(value.settings.repositoryPaths) !== JSON.stringify(current.settings.repositoryPaths)) throw new Error('此工作台的工程范围由启动参数配置。');
      topK = value.settings.topK; changed(); return [{ type: 'SETTINGS_UPDATED', settings: (await payload()).settings }];
    }
    case 'CANCEL_TASK_SEARCH': return [];
    default: throw new Error('此操作需要在 VS Code 扩展中完成。');
  }
}

const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? root, 'package.json'));
const { build: bundle } = requireTools('esbuild') as typeof import('esbuild');
const output = await bundle({ entryPoints: [path.join(root, 'apps/vscode-extension/webview/src/browser-main.tsx')],
  bundle: true, write: false, outfile: 'workbench.js', format: 'iife', platform: 'browser', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' } });
const assets = new Map(output.outputFiles!.map((file) => [`/${path.basename(file.path)}`, file.contents]));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RECAST 智能开发工作台</title><link rel="stylesheet" href="/workbench.css"></head><body><div id="root"></div><script src="/workbench.js"></script></body></html>';

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 256 * 1024) throw new Error('Request body is too large.');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.destroyed) return;
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function authorizedTask(request: TaskRetrievalRequest, signal?: AbortSignal) {
  validateTaskRetrievalRequest(request);
  const visible = new Set((await runtime.registry.list()).filter((repository) => visiblePaths.has(repository.localPath))
    .map((repository) => repository.repositoryId));
  if (request.scopes.some((scope) => !visible.has(scope.repositoryId))) throw new Error('Repository is not exposed by this workbench.');
  return runtime.taskRetrieval.search(request, signal);
}
const semantic = createSemanticQueryHttpServer({ queryPort: runtime.queryPort, taskRetrieval: { search: authorizedTask },
  bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN });
const web = createServer(async (request, response) => {
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET') {
      if (pathname === '/health') { send(response, 200, { status, storage: 'seekdb', error: failure }); return; }
      if (pathname === '/v1/workbench') { send(response, 200, await updates()); return; }
      if (pathname === '/v1/workbench/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(`data: ${modelVersion}\n\n`); clients.add(response);
        request.once('close', () => clients.delete(response)); return;
      }
      if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return; }
      const asset = assets.get(pathname);
      if (asset) { response.writeHead(200, { 'content-type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(asset); return; }
    }
    if (request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host) { send(response, 403, { error: 'Origin is not allowed.' }); return; }
      const body = await readJson(request);
      if (pathname === '/v1/task-search') { send(response, 200, await authorizedTask(body as TaskRetrievalRequest, controller.signal)); return; }
      if (pathname === '/v1/workbench/message') {
        if (!isWebviewToHostMessage(body)) throw new Error('Invalid workbench message.');
        try { send(response, 200, await message(body, controller.signal)); }
        catch (error) { send(response, 200, [{ type: 'ERROR', message: error instanceof Error ? error.message : String(error) }]); }
        return;
      }
    }
    send(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    send(response, 400, { error: 'Request failed. Check the workbench service log.' });
  }
});

async function listen(server: Server, desired: string): Promise<number> {
  let port = Number(desired);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  for (let attempt = 0; attempt < 20; attempt++, port++) {
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      return port;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free local port found.');
}
const semanticPort = await listen(semantic, values['semantic-port']!);
const port = await listen(web, values.port!);
console.info(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, semanticUrl: `http://127.0.0.1:${semanticPort}`, database: environment.CODE_INTELLIGENCE_SEEKDB_DATABASE }));
if (values['rebuild-modules']) void build(undefined, true);
else if (!values['register-only']) void build();
async function shutdown(): Promise<void> {
  for (const client of clients) client.end();
  web.close(); semantic.close();
  await refreshing;
  await runtime.close();
  process.exitCode = 0;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
