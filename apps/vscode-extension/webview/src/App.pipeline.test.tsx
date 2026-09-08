/// <reference types="node" />
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectPlanHash } from '@forexplore/code-intelligence-service';
import type { ProjectAnalysisScope } from '@forexplore/contracts';
import { CodeIntelligenceHost } from '../../src/code-intelligence-host';
import { buildProjectExplorer, readExplorerChildren, type ExplorerChildrenIndex } from '../../src/project-explorer';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import { isWebviewToHostMessage } from '../../src/protocol/messages';
import App from './App';
import type { ModuleExplorerPresentation } from '../../src/ui-types';

let reactRoot: Root | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('enables subsystem search from complete projected metadata beyond the first tree page', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: () => {} });
  const explorer: ModuleExplorerPresentation = { generatedAt: '', history: [], target: {
    id: 'target', repositoryId: 'target', projectId: 'project', revision: 'revision', mode: 'target', name: 'Target', rootLabel: '.',
    stats: { modules: 81, files: 81, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' }, rootTotal: 81,
    tree: Array.from({ length: 80 }, (_, index) => ({ id: `module:${index}`, name: `Module ${index}`, kind: 'module', children: [] })),
    analysis: { repositoryId: 'target', analysisRevision: 'revision', projectId: 'project', analysisProfile: 'test', updatedAt: '',
      state: 'ready', projection: 'ready', proposal: { summary: 'Published hierarchy' },
      hierarchy: { nodeCount: 81, rootCount: 81, moduleCount: 80, subsystemCount: 1, leafCount: 81,
        splitCount: 0, deferredCount: 0, unknownCount: 0, maxDepth: 0 } },
  } };
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  await act(async () => post({ type: 'INIT', payload: { target: null, workspaceRoot: '',
    settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [], moduleExplorer: explorer,
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { retrieval: 'connected', adaptation: 'unconfigured', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } }));
  const option = () => container.querySelector<HTMLOptionElement>('[aria-label="检索粒度"] option[value="subsystem"]')!;
  expect(option().disabled).toBe(false);
  explorer.target.analysis!.projection = 'pending';
  await act(async () => post({ type: 'MODULE_EXPLORER', explorer: { ...explorer, target: { ...explorer.target } } }));
  expect(option().disabled).toBe(true);
  explorer.target.analysis!.projection = 'ready';
  explorer.target.analysis!.hierarchy!.subsystemCount = 0;
  await act(async () => post({ type: 'MODULE_EXPLORER', explorer: { ...explorer, target: { ...explorer.target } } }));
  expect(option().disabled).toBe(true);
});

it('opens without a method, saves two history paths, displays durable summaries and switches project scope', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  directory = await mkdtemp(path.join(tmpdir(), 'forexplore-webview-pipeline-'));
  const paths = ['history-a', 'history-b', 'target'].map((name) => path.join(directory!, name));
  for (const root of paths) {
    await mkdir(root);
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
    await writeFile(path.join(root, 'index.ts'), 'export function run() { return 1; }');
    // A conflicting legacy export must have no influence on the module tree.
    await mkdir(path.join(root, '.forexplore'));
    await writeFile(path.join(root, '.forexplore/module-summary.json'), '{"name":"WRONG DISK SUMMARY"}');
  }
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const plan = vi.fn(async (scope: ProjectAnalysisScope & { objective: string }) => {
    const index = (await runtime.store.getStructuralIndex(scope))!;
    const repository = (await runtime.registry.get(scope.repositoryId))!;
    const proposal = {
      repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, analysisHash: index.analysisHash,
      objective: scope.objective, summary: `Stored summary: ${repository.displayName}`, unassignedFiles: [],
      modules: [{ id: 'core', kind: 'feature', name: `Agent module ${repository.displayName}`, description: 'Core behavior',
        sourceFiles: index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath),
        symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`] }],
    };
    return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
  });
  const jobs = new ProjectAnalysisCoordinator({ store: runtime.store, plan });
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime, planProject: plan, projectAnalysisPort: jobs });
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  let historyPaths: string[] = [];
  let moduleChildren: ExplorerChildrenIndex = new Map();
  const explorerPresentation = async () => {
    const explorer = await buildProjectExplorer(host);
    moduleChildren = explorer.childrenByNodeId;
    return explorer.presentation;
  };
  const assertLightweightProjectAnalysis = async () => {
    const presentation = await host.presentation();
    const analysis = presentation.repositories[0]?.projects[0]?.analysis;
    expect(analysis?.proposal?.summary).toContain('Stored summary:');
    expect(analysis?.proposal).not.toHaveProperty('modules');
    expect(analysis?.projection).toBe('ready');
  };
  const inputs = () => [...historyPaths.map((localPath) => ({ localPath, role: 'history' as const })), { localPath: paths[2]!, role: 'target' as const }];
  const emit = async () => {
    post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
    post({ type: 'MODULE_EXPLORER', explorer: await explorerPresentation() });
  };
  const sent: WebviewToHostMessage[] = [];
  const pending: Promise<void>[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: (raw) => {
    const message = raw as WebviewToHostMessage; sent.push(message);
    expect(isWebviewToHostMessage(message)).toBe(true);
    if (message.type === 'LOAD_MODULE_CHILDREN') post({ type: 'MODULE_CHILDREN', requestId: message.requestId,
      page: readExplorerChildren(moduleChildren, message.request) });
    if (message.type === 'START_TASK_SEARCH') pending.push((async () => {
      const packet = await host.searchTaskContext(message.requestId, message.targetScope, message.request);
      post({ type: 'TASK_SEARCH_RESULT', requestId: message.requestId, packet });
    })());
    if (message.type === 'SAVE_SETTINGS') pending.push((async () => {
      historyPaths = message.settings.repositoryPaths;
      post({ type: 'SETTINGS_UPDATED', settings: message.settings });
      await host.synchronize({ repositories: inputs() }); await host.waitForProjects(); await emit();
    })());
    if (message.type === 'SELECT_CODE_INTELLIGENCE_PROJECT') pending.push((async () => {
      await host.selectProjectForDisplay(message); await emit();
    })());
  } });
  await host.synchronize({ repositories: inputs() }); await host.waitForProjects();
  await assertLightweightProjectAnalysis();
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: {
    target: null, workspaceRoot: paths[2]!, settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [],
    codeIntelligence: await host.presentation(), moduleExplorer: await explorerPresentation(),
    serviceStatus: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
  } }));
  expect(container.textContent).toContain('Stored summary: target');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
  expect(container.querySelector<HTMLOptionElement>('[aria-label="检索粒度"] option[value="function"]')?.disabled).toBe(false);
  expect(container.querySelector<HTMLOptionElement>('[aria-label="检索粒度"] option[value="class"]')?.disabled).toBe(true);
  expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 Agent module target"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开 index.ts"]')!.click());
  expect(container.querySelector('.module-tree')?.textContent).toContain('run');
  expect(sent.filter((message) => message.type === 'LOAD_MODULE_CHILDREN')).toHaveLength(2);
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('#task-query')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'run');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="检索粒度"]')!;
    select.value = 'function';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('.task-search form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.all(pending);
  });
  expect(sent.some((message) => message.type === 'START_TASK_SEARCH' && message.request.granularity === 'function')).toBe(true);
  expect(container.querySelector('.context-detail')?.textContent).toContain('function run() { return 1; }');
  await act(async () => (container.querySelector('.header-settings-button') as HTMLButtonElement).click());
  const clickText = async (text: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    expect(button).toBeDefined(); button!.click();
  });
  await clickText('添加第一个路径');
  const enter = async (index: number, value: string) => act(async () => {
    const input = container.querySelectorAll<HTMLInputElement>('.repository-path-fields input')[index]!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await enter(0, paths[0]!); await clickText('添加路径'); await enter(1, paths[1]!);
  await act(async () => {
    container.querySelector('.settings-panel')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.all(pending);
  });
  expect(sent).toContainEqual({ type: 'SAVE_SETTINGS', settings: { repositoryPaths: paths.slice(0, 2), topK: 4 } });
  expect(plan).toHaveBeenCalledTimes(3);
  const history = (await host.presentation()).repositories.find((r) => r.displayName === 'history-b')!;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.workspace-switch button:nth-child(2)')!.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="选择参考工程"]')!.click();
  });
  expect(container.querySelector('.project-selector')).toBeNull();
  expect(container.querySelector('.module-sidebar [role="menu"]')).not.toBeNull();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="group"][aria-label="history-b"] [role="menuitemradio"]')!.click();
    await Promise.all(pending);
  });
  expect(sent).toContainEqual({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', repositoryId: history.repositoryId,
    analysisRevision: history.selectedRevision, projectId: history.projects[0]!.projectId });
  expect(container.textContent).toContain('Stored summary: history-b');
  expect(container.textContent).toContain('Agent module history-b');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
  await host.synchronize({ repositories: inputs() }); await host.waitForProjects();
  expect(plan).toHaveBeenCalledTimes(3);
}, 20_000);
