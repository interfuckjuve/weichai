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
import { buildProjectExplorer } from '../../src/project-explorer';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import App from './App';

let reactRoot: Root | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
  if (directory) await rm(directory, { recursive: true, force: true });
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
  const inputs = () => [...historyPaths.map((localPath) => ({ localPath, role: 'history' as const })), { localPath: paths[2]!, role: 'target' as const }];
  const emit = async () => {
    post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
    post({ type: 'MODULE_EXPLORER', explorer: (await buildProjectExplorer(host)).presentation });
  };
  const sent: WebviewToHostMessage[] = [];
  const pending: Promise<void>[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {}, postMessage: (raw) => {
    const message = raw as WebviewToHostMessage; sent.push(message);
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
  const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App />));
  await act(async () => post({ type: 'INIT', payload: {
    target: null, workspaceRoot: paths[2]!, settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [],
    codeIntelligence: await host.presentation(), moduleExplorer: (await buildProjectExplorer(host)).presentation,
    serviceStatus: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
  } }));
  expect(container.textContent).toContain('Stored summary: target');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
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
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.all(pending);
  });
  expect(sent).toContainEqual({ type: 'SAVE_SETTINGS', settings: { repositoryPaths: paths.slice(0, 2), topK: 4 } });
  expect(plan).toHaveBeenCalledTimes(3);
  const history = (await host.presentation()).repositories.find((r) => r.displayName === 'history-b')!;
  await act(async () => {
    const selector = container.querySelector<HTMLSelectElement>(`select[aria-label="history-b 项目"]`)!;
    selector.value = history.projects[0]!.projectId;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.all(pending);
  });
  expect(container.textContent).toContain('Stored summary: history-b');
  expect(container.textContent).toContain('Agent module history-b');
  expect(container.textContent).not.toContain('WRONG DISK SUMMARY');
  await host.synchronize({ repositories: inputs() }); await host.waitForProjects();
  expect(plan).toHaveBeenCalledTimes(3);
}, 20_000);
