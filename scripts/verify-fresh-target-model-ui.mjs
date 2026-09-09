import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const origin = new URL(process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4044');
assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password);
const expectedPlanHash = process.env.TASK_CONTROLS_EXPECTED_PLAN_HASH;
const freshAfter = process.env.TASK_CONTROLS_FRESH_AFTER;
assert(expectedPlanHash && Number.isFinite(Date.parse(freshAfter)), 'The completed model plan hash and run start time are required.');
const repositoryName = process.env.TASK_CONTROLS_MODEL_REPOSITORY ?? 'commons-fileupload-java-skeleton';
const output = process.env.TASK_CONTROLS_UI_OUTPUT ?? 'logs/agent-semantic-live';
const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium, expect } = requireTools('@playwright/test');
const report = { passed: false, startedAt: new Date().toISOString(), url: origin.href,
  mode: 'Read-only verification of a fresh target artifact and real UI; no model requests or mocked responses',
  expectedPlanHash, freshAfter, screenshots: [], viewports: [], browserErrors: [] };
let browser;
let page;

async function message(body) {
  const response = await fetch(new URL('/v1/workbench/message', origin), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  assert(response.ok);
  const messages = await response.json();
  assert(!messages.some((entry) => entry.type === 'ERROR'), JSON.stringify(messages));
  return messages;
}

async function screenshot(name) {
  const file = path.join(output, `fresh-target-model-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}

await mkdir(output, { recursive: true });
try {
  const initial = (await message({ type: 'READY' })).find((entry) => entry.type === 'INIT')?.payload;
  const repository = initial?.codeIntelligence.repositories.find((entry) => entry.role === 'target' && entry.displayName === repositoryName);
  const project = repository?.projects.find((entry) => process.env.TASK_CONTROLS_MODEL_PROJECT
    ? entry.projectId === process.env.TASK_CONTROLS_MODEL_PROJECT : entry.analysis?.planHash === expectedPlanHash);
  assert(repository?.selectedRevision && project, 'The expected freshly analyzed target project is not visible.');
  const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.selectedRevision, projectId: project.projectId };
  const selected = await message({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', ...scope });
  const workspace = selected.find((entry) => entry.type === 'MODULE_EXPLORER')?.explorer.target;
  assert(workspace && workspace.repositoryId === scope.repositoryId && workspace.projectId === scope.projectId);
  assert.equal(workspace.revision, scope.analysisRevision);
  const analysis = workspace.analysis;
  assert.equal(analysis?.state, 'ready');
  assert.equal(analysis?.projection, 'ready');
  assert.equal(analysis?.modeling?.strategy, 'agent');
  assert.equal(analysis.planHash, expectedPlanHash);
  assert(Date.parse(analysis.updatedAt) > Date.parse(freshAfter));
  const restoration = JSON.parse(await readFile(process.env.TASK_CONTROLS_RESTORE_REPORT ?? 'logs/agent-module-restore.json', 'utf8'));
  const original = restoration.repositories.find((entry) => entry.name === repositoryName && entry.role === 'target')?.projects
    .find((entry) => entry.projectId === project.projectId);
  const previousPlanHash = process.env.TASK_CONTROLS_PREVIOUS_PLAN_HASH ?? original?.planHash;
  assert(previousPlanHash && analysis.planHash !== previousPlanHash, 'The target still contains the original restored plan.');
  const modules = workspace.tree.filter((node) => node.kind === 'module');
  assert(modules.length > 0);
  assert(modules.some((node) => /[\u3400-\u9fff]/.test(node.name)));
  assert(/[\u3400-\u9fff]/.test(analysis.proposal.summary));
  const selectedModule = modules.find((node) => /[\u3400-\u9fff]/.test(node.purpose ?? node.description ?? ''));
  assert(selectedModule, 'No Chinese functional module description is available.');
  report.artifact = { ...scope, state: analysis.state, projection: analysis.projection, modeling: analysis.modeling,
    planHash: analysis.planHash, previousPlanHash, updatedAt: analysis.updatedAt, summary: analysis.proposal.summary,
    coverage: analysis.coverage, hierarchy: analysis.hierarchy, stats: workspace.stats,
    displayedRootModules: modules.map((node) => ({ id: node.id, name: node.name, purpose: node.purpose, description: node.description })) };

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin.href);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    await expect(page.locator('.task-search-controls input')).toHaveCount(0);
    await expect(page.locator('.task-search-controls select')).toHaveCount(2);
    assert(!/token|上下文预算/i.test(await page.locator('.task-search-controls').innerText()));
    for (const node of modules) await expect(page.locator(`[data-node-id=${JSON.stringify(node.id)}] > .tree-row > .tree-select`)).toContainText(node.name);
    await screenshot(`${name}-initial`);
    const row = page.locator(`[data-node-id=${JSON.stringify(selectedModule.id)}] > .tree-row > .tree-select`);
    await row.click();
    const preview = page.getByLabel('当前选择', { exact: true });
    await expect(preview).toContainText(selectedModule.purpose ?? selectedModule.description);
    await preview.scrollIntoViewIfNeeded();
    await screenshot(`${name}-module`);
    const summary = page.locator('.project-analysis .project-summary');
    await expect(summary).toHaveText(analysis.proposal.summary);
    await expect(page.getByLabel('项目解析结果', { exact: true })).toContainText('模块来源：Agent 分析');
    await summary.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(`${name}-summary`);
    report.viewports.push({ name, width, height, moduleNamesMatch: true, functionalDescriptionVisible: true,
      modelSummaryMatches: true, tokenControlsAbsent: true, horizontalOverflow: false });
  }
  const final = (await message({ type: 'READY' })).find((entry) => entry.type === 'INIT')?.payload.moduleExplorer.target;
  assert.equal(final?.analysis?.planHash, expectedPlanHash, 'The target artifact changed during verification.');
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'fresh-target-model-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
