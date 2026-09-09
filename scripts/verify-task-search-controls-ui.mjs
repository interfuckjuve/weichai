import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const origin = new URL(process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4040');
assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password);
const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium, expect } = requireTools('@playwright/test');
const output = process.env.TASK_CONTROLS_UI_OUTPUT ?? 'logs';
const freshModel = process.env.TASK_CONTROLS_EXPECT_FRESH_MODEL === '1';
const report = { passed: false, startedAt: new Date().toISOString(), url: origin.href, viewports: [], screenshots: [], errors: [] };
let browser;
let page;

async function screenshot(name) {
  const file = path.join(output, `task-search-controls-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}

await mkdir(output, { recursive: true });
try {
  const readyResponse = await fetch(new URL('/v1/workbench/message', origin), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'READY' }),
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  assert(readyResponse.ok);
  let initial = (await readyResponse.json()).find((message) => message.type === 'INIT')?.payload;
  if (initial && !initial.moduleExplorer.target.projectId) {
    const target = initial.codeIntelligence.repositories.find((repository) => repository.role === 'target' && repository.projects.length > 0);
    assert(target?.selectedRevision, 'No authorized target revision is available.');
    const selection = await fetch(new URL('/v1/workbench/message', origin), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT',
        repositoryId: target.repositoryId, analysisRevision: target.selectedRevision, projectId: target.projects[0].projectId }),
      redirect: 'error', signal: AbortSignal.timeout(60_000) });
    assert(selection.ok);
    const messages = await selection.json();
    assert(!messages.some((message) => message.type === 'ERROR'), JSON.stringify(messages));
    const explorer = messages.find((message) => message.type === 'MODULE_EXPLORER')?.explorer;
    assert(explorer);
    initial = { ...initial, moduleExplorer: explorer };
  }
  assert(initial?.moduleExplorer.target.projectId, 'A real target project must be selected.');
  const retrievalScope = initial.moduleExplorer.history.some((workspace) => workspace.repositoryId && workspace.revision) ? 'all' : 'target';
  report.retrievalScope = retrievalScope;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (error) => report.errors.push(error.message));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin.href);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    await expect(page.locator('.task-search-controls input')).toHaveCount(0);
    await expect(page.locator('.task-search-controls select')).toHaveCount(2);
    assert(!/token|上下文预算/i.test(await page.locator('.task-search-controls').innerText()));
    await screenshot(`${name}-initial`);
    await page.getByLabel('开发需求', { exact: true }).fill('修改文件上传总大小限制和单个文件大小限制');
    await page.getByLabel('检索范围', { exact: true }).selectOption(retrievalScope);
    await page.getByLabel('检索粒度', { exact: true }).selectOption('function');
    const taskResponse = page.waitForResponse((response) => response.url().endsWith('/v1/workbench/message') &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'START_TASK_SEARCH', { timeout: 40_000 });
    await page.getByRole('button', { name: '检索相关代码', exact: true }).click();
    const response = await taskResponse;
    const request = response.request().postDataJSON().request;
    assert.deepEqual(Object.keys(request).sort(), ['granularity', 'requirement', 'scope']);
    const messages = await response.json();
    const packet = messages.find((message) => message.type === 'TASK_SEARCH_RESULT')?.packet;
    assert(packet, JSON.stringify(messages));
    assert(packet.evidence.some((item) => item.role === 'implementation'));
    assert.equal(packet.usage.maxTokens, 4000);
    assert(packet.usage.tokens <= packet.usage.maxTokens);
    const footer = page.locator('.context-export');
    await expect(footer).toBeAttached();
    assert(!/token|预算/i.test(await footer.innerText()));
    await footer.scrollIntoViewIfNeeded();
    await screenshot(`${name}-result`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出上下文', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(await readFile(await download.path(), 'utf8'), packet.markdown);
    if (packet.evidence.length > 1) {
      await page.locator('.context-list input[type="checkbox"]').last().uncheck();
      await expect(footer).toContainText('已筛选');
      assert(!/token|预算|字符/i.test(await footer.innerText()));
    }
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.locator('.settings-panel');
    await expect(settings).toBeAttached();
    assert(!/token|上下文预算/i.test(await settings.innerText()));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    report.viewports.push({ name, width, height, controls: ['scope', 'granularity'], requestHasBudget: false,
      resultHasTokenCounter: false, settingsHaveTokenControl: false, downloadMatches: true,
      evidence: packet.evidence.length, serviceLatencyMs: packet.usage.latencyMs });
  }
  if (process.env.TASK_CONTROLS_EXPECT_SEMANTIC === '1' || freshModel) {
    const restoration = JSON.parse(await readFile(process.env.TASK_CONTROLS_RESTORE_REPORT ?? 'logs/agent-module-restore.json', 'utf8'));
    assert.equal(restoration.passed, true);
    const repositoryName = process.env.TASK_CONTROLS_MODEL_REPOSITORY ?? 'account-stream-rs';
    const original = restoration.repositories.find((repository) => repository.name === repositoryName && repository.role === 'history');
    const reference = initial.codeIntelligence.repositories.find((repository) => repository.role === 'history' &&
      (freshModel ? repository.displayName === repositoryName : repository.repositoryId === original?.repositoryId));
    const project = reference?.projects.find((project) => process.env.TASK_CONTROLS_MODEL_PROJECT
      ? project.projectId === process.env.TASK_CONTROLS_MODEL_PROJECT
      : freshModel ? project.analysis?.modeling?.strategy === 'agent' : project.projectId === original?.projects[0]?.projectId);
    assert(reference && project, 'The expected semantic reference project is not visible.');
    const originalProject = original?.projects.find((candidate) => candidate.projectId === project.projectId) ??
      (original?.projects.length === 1 ? original.projects[0] : undefined);
    let previousPlanHash;
    let expectedPlanHash;
    let freshAfter;
    if (freshModel) {
      previousPlanHash = process.env.TASK_CONTROLS_PREVIOUS_PLAN_HASH ?? originalProject?.planHash;
      expectedPlanHash = process.env.TASK_CONTROLS_EXPECTED_PLAN_HASH;
      freshAfter = process.env.TASK_CONTROLS_FRESH_AFTER;
      assert(previousPlanHash && expectedPlanHash && Number.isFinite(Date.parse(freshAfter)),
        'The previous plan hash, completed model run plan hash and run start timestamp are required.');
      assert.equal(project.analysis?.modeling?.strategy, 'agent');
      assert.equal(project.analysis.state, 'ready');
      assert.equal(project.analysis.projection, 'ready');
      assert(project.analysis.planHash && project.analysis.planHash !== previousPlanHash, 'The model plan still matches the previous artifact.');
      assert.equal(project.analysis.planHash, expectedPlanHash, 'The published artifact does not match the completed model run.');
      assert(Date.parse(project.analysis.updatedAt) > Date.parse(freshAfter), 'The artifact predates the expected fresh model run.');
    } else {
      assert(originalProject?.originalHashesAndPayloadUnchanged, 'Restored semantic output must match its original artifact.');
      assert.equal(project.analysis?.planHash, originalProject.planHash);
      assert.notEqual(project.analysis?.modeling?.strategy, 'structural');
      assert(!project.analysis?.proposal?.hierarchy, 'This check must use the original flat semantic proposal.');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin.href);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    await page.locator('.workbench-modes').getByRole('button', { name: '复用迁移', exact: true }).click();
    await page.locator('.workspace-switch').getByRole('tab', { name: /参考工程/ }).click();
    await page.getByRole('button', { name: '选择参考工程', exact: true }).click();
    const selectionResponse = page.waitForResponse((response) => response.url().endsWith('/v1/workbench/message') &&
      response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'SELECT_CODE_INTELLIGENCE_PROJECT' &&
      response.request().postDataJSON()?.projectId === project.projectId);
    await page.getByRole('group', { name: reference.displayName, exact: true }).getByRole('menuitemradio').filter({ hasText: project.displayName }).click();
    const selectedMessages = await (await selectionResponse).json();
    const selectedExplorer = selectedMessages.find((message) => message.type === 'MODULE_EXPLORER')?.explorer;
    const workspace = selectedExplorer?.history.find((candidate) => candidate.repositoryId === reference.repositoryId && candidate.projectId === project.projectId);
    assert(workspace, 'The real project selection did not return its module presentation.');
    assert.equal(workspace.revision, reference.selectedRevision);
    assert.equal(workspace.analysis?.state, 'ready');
    assert.equal(workspace.analysis?.projection, 'ready');
    assert.equal(workspace.analysis?.planHash, project.analysis?.planHash, 'The published artifact changed during UI verification.');
    const expectedModules = workspace.tree.filter((node) => node.kind === 'module').slice(0, 24);
    assert(expectedModules.length > 0);
    const cards = page.locator('.history-module-card');
    await expect(cards.locator(':scope > strong')).toHaveText(expectedModules.map((module) => module.name));
    await expect(cards.locator('.history-module-description')).toHaveText(expectedModules.map((module) => module.purpose ?? module.description));
    const titles = await cards.locator(':scope > strong').allTextContents();
    const descriptions = await cards.locator('.history-module-description').allTextContents();
    assert.deepEqual(titles, expectedModules.map((module) => module.name));
    assert.deepEqual(descriptions, expectedModules.map((module) => module.purpose ?? module.description));
    if (!freshModel) {
      assert.equal(titles.length, 10);
      assert.deepEqual(titles, originalProject.modules.map((module) => module.name));
    }
    assert(titles.some((title) => /[\u3400-\u9fff]/.test(title)), 'The restored module cards contain no Chinese semantic name.');
    assert(descriptions.some((description) => /[\u3400-\u9fff]/.test(description)), 'The restored module cards contain no Chinese functional description.');
    await cards.first().scrollIntoViewIfNeeded();
    await screenshot('semantic-catalog-desktop');
    await cards.first().click();
    const preview = page.getByLabel('当前选择', { exact: true });
    await expect(preview).toContainText(descriptions[0]);
    await preview.scrollIntoViewIfNeeded();
    await screenshot('semantic-modules-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await cards.first().scrollIntoViewIfNeeded();
    await screenshot('semantic-catalog-mobile');
    await preview.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot('semantic-modules-mobile');
    const summary = page.locator('.project-analysis .project-summary');
    await expect(summary).toHaveText(workspace.analysis.proposal.summary);
    assert(/[\u3400-\u9fff]/.test(workspace.analysis.proposal.summary), 'The published project summary contains no Chinese functional explanation.');
    if (freshModel) await expect(page.getByLabel('项目解析结果', { exact: true })).toContainText('模块来源：Agent 分析');
    await summary.scrollIntoViewIfNeeded();
    await screenshot('semantic-summary-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await summary.scrollIntoViewIfNeeded();
    await screenshot('semantic-summary-desktop');
    report.semanticModules = { repositoryId: reference.repositoryId, projectId: project.projectId,
      analysisRevision: workspace.revision, planHash: workspace.analysis.planHash,
      state: workspace.analysis.state, projection: workspace.analysis.projection,
      modeling: workspace.analysis.modeling, updatedAt: workspace.analysis.updatedAt,
      ...(freshModel ? { freshModel: true, previousPlanHash, expectedPlanHash, freshAfter } : { originalArtifactUnchanged: true }),
      totalModuleNodes: workspace.stats.modules, totalRootModules: workspace.analysis.hierarchy?.rootCount,
      displayedCards: titles.length, titles, descriptions, summary: workspace.analysis.proposal.summary,
      functionalDescriptionVisible: true };
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'task-search-controls-ui.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
