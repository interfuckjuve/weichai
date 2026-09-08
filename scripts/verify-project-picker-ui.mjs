import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.LOCALAPPDATA, 'Temp/forexplore-ui-tools/node_modules/playwright'));
const report = JSON.parse(await readFile('logs/project-analysis-live.json', 'utf8'));
const empty = { id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '', tree: [],
  stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
  summary: { exists: false, path: '' } };
function fixture(name, role) {
  const source = report.results.find((entry) => entry.name === name);
  const result = source.projects[0];
  const proposal = result.proposal;
  const projectId = result.projectId;
  const repositoryId = proposal.repositoryId;
  const project = { projectId, displayName: role === 'history' ? 'Cargo' : 'Circuit Lane', kind: role === 'history' ? 'cargo' : 'maven',
    relativePath: '', languageIds: [], analysis: { ...result, ...proposal } };
  return {
    repository: { repositoryId, displayName: name, role, analysisStatus: 'ready', activeRevision: proposal.analysisRevision,
      selectedRevision: proposal.analysisRevision, selectedProjectId: projectId, projects: [project], revisions: [], languages: [], summary: { status: 'current' } },
    workspace: { ...empty, id: repositoryId, repositoryId, projectId, name: `${name} / ${project.displayName}`, mode: role,
      revision: proposal.analysisRevision, rootLabel: '.', snapshotId: proposal.analysisRevision,
      analysis: { ...result, proposal }, dependencies: [], diagnostics: [],
      stats: { ...empty.stats, modules: proposal.modules.length, files: result.coverage.total },
      tree: proposal.modules.map((module) => ({ id: module.id, name: module.name, kind: 'module', description: module.description,
        children: module.sourceFiles.map((file) => ({ id: file, kind: 'file', name: path.basename(file), path: file, children: [] })) })) },
  };
}
const history = fixture('account-stream-rs', 'history');
const target = fixture('circuit-lane-java', 'target');
const payload = { target: null, workspaceRoot: '', settings: { repositoryPaths: ['account-stream-rs'], topK: 4 },
  repositoryStatuses: [], codeIntelligence: { status: 'ready', storage: 'seekdb', repositories: [history.repository] },
  serviceStatus: { retrieval: 'connected', adaptation: 'connected' },
  moduleExplorer: { generatedAt: new Date().toISOString(), target: empty, history: [history.workspace] },
  searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' };

// This bridge belongs only to the standalone visual fixture. The extension
// continues to obtain its state and filesystem actions from VS Code.
function bridge({ payload, target }) {
  window.previewMessages = [];
  const send = (message) => window.dispatchEvent(new MessageEvent('message', { data: structuredClone(message) }));
  const emit = () => {
    send({ type: 'CODE_INTELLIGENCE_STATUS', presentation: payload.codeIntelligence });
    send({ type: 'MODULE_EXPLORER', explorer: payload.moduleExplorer });
  };
  window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage(message) {
    window.previewMessages.push(message);
    setTimeout(() => {
      if (message.type === 'READY') send({ type: 'INIT', payload });
      if (message.type === 'ADD_TARGET_WORKSPACE') {
        payload.codeIntelligence.repositories = [payload.codeIntelligence.repositories[0], target.repository];
        payload.moduleExplorer.target = target.workspace;
        emit();
      }
      if (['SELECT_CODE_INTELLIGENCE_PROJECT', 'REFRESH_REPOSITORY', 'RETRY_PROJECT_ANALYSIS'].includes(message.type)) emit();
    }, 20);
  } });
}

const build = await esbuild.build({ entryPoints: ['apps/vscode-extension/webview/src/main.tsx'], bundle: true,
  write: false, outfile: 'preview.js', platform: 'browser', format: 'iife', minify: true, jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' } });
const css = build.outputFiles.find((file) => file.path.endsWith('.css')).text;
const js = build.outputFiles.find((file) => file.path.endsWith('.js')).text;
await mkdir('logs', { recursive: true });
const preview = path.resolve('logs/project-picker-preview.html');
await writeFile(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ForeXplore</title><style>${css}</style><body><div id="root"></div><script>(${bridge.toString()})(${JSON.stringify({ payload, target }).replaceAll('<', '\\u003c')});${js.replaceAll('</script', '<\\/script')}</script></body></html>`);
const browser = await chromium.launch({ headless: true,
  executablePath: path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1228/chrome-win64/chrome.exe') });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [name, width, height] of [['desktop', 1100, 780], ['narrow', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(pathToFileURL(preview).href);
    await page.locator('.workbench-modes').getByRole('button', { name: '复用迁移' }).click();
    await page.getByRole('heading', { name: '选择目标工程' }).waitFor();
    assert.equal(await page.locator('.project-selector').count(), 0);
    await page.screenshot({ path: `logs/project-picker-${name}-empty.png` });
    await page.getByRole('button', { name: '选择目标工程', exact: true }).click();
    await page.getByRole('menu', { name: '目标工程列表' }).waitFor();
    await page.screenshot({ path: `logs/project-picker-${name}-menu.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择目标工程', exact: true }).click();
    await page.getByRole('menuitem', { name: '从已打开工作区选择…' }).click();
    await page.getByRole('heading', { name: 'circuit-lane-java / Circuit Lane' }).waitFor();
    await page.screenshot({ path: `logs/project-picker-${name}-target.png` });
    await page.getByRole('tab', { name: /参考工程/ }).click();
    await page.getByRole('button', { name: '选择参考工程', exact: true }).click();
    await page.getByRole('menuitemradio').click();
    await page.getByRole('heading', { name: 'account-stream-rs / Cargo' }).first().waitFor();
    await page.screenshot({ path: `logs/project-picker-${name}-history.png` });
    assert(await page.evaluate(() => window.previewMessages.some((message) => message.type === 'SELECT_CODE_INTELLIGENCE_PROJECT')));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: ['1100x780', '390x844'], preview, screenshots: 8 }));
} finally { await browser.close(); }
