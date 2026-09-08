import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const origin = new URL(process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4040');
assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password);
const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium, expect } = requireTools('@playwright/test');
const output = process.env.TASK_CONTROLS_UI_OUTPUT ?? 'logs';
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
  if (process.env.TASK_CONTROLS_EXPECT_SEMANTIC === '1') {
    const restoration = JSON.parse(await readFile(process.env.TASK_CONTROLS_RESTORE_REPORT ?? 'logs/agent-module-restore.json', 'utf8'));
    assert.equal(restoration.passed, true);
    const original = restoration.repositories.find((repository) => repository.name === 'account-stream-rs' && repository.role === 'history');
    assert(original?.projects[0]?.originalHashesAndPayloadUnchanged, 'Restored semantic output must match its original artifact.');
    const reference = initial.codeIntelligence.repositories.find((repository) => repository.repositoryId === original.repositoryId);
    const project = reference?.projects.find((project) => project.projectId === original.projects[0].projectId);
    assert(reference && project, 'The verified original semantic reference project is not visible.');
    assert.notEqual(project.analysis?.modeling?.strategy, 'structural');
    assert(!project.analysis?.proposal?.hierarchy, 'This check must use the original flat semantic proposal.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(origin.href);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    await page.locator('.workbench-modes').getByRole('button', { name: '复用迁移', exact: true }).click();
    await page.locator('.workspace-switch').getByRole('tab', { name: /参考工程/ }).click();
    await page.getByRole('button', { name: '选择参考工程', exact: true }).click();
    await page.getByRole('group', { name: reference.displayName, exact: true }).getByRole('menuitemradio').filter({ hasText: project.displayName }).click();
    const cards = page.locator('.history-module-card');
    await expect(cards.first()).toBeVisible();
    const titles = await cards.locator(':scope > strong').allTextContents();
    const descriptions = await cards.locator('.history-module-description').allTextContents();
    assert.equal(titles.length, 10);
    assert.deepEqual(titles, original.projects[0].modules.map((module) => module.name));
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
    report.semanticModules = { repositoryId: reference.repositoryId, projectId: project.projectId,
      titles, descriptions, originalArtifactUnchanged: true, functionalDescriptionVisible: true };
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
