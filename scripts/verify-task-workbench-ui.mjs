import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium } = requireTools('@playwright/test');
const url = process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4040';
const deadline = Date.now() + 60000;
while (true) {
  try {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (health.ok && (await health.json()).status === 'ready') break;
  } catch { /* Startup opens the listening socket after schema initialization. */ }
  if (Date.now() > deadline) throw new Error('The live workbench did not become ready.');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const browser = await chromium.launch({ headless: true,
  ...(process.env.FOREXPLORE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FOREXPLORE_CHROMIUM_EXECUTABLE } : {}),
});
const errors = [];
const results = [];
await mkdir('logs', { recursive: true });
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(url);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-search-controls input').count(), 0);
    await page.locator('.module-tree [role="treeitem"]').first().waitFor({ timeout: 60000 });
    const expansion = page.waitForResponse((response) => response.url().endsWith('/v1/workbench/message') && response.request().postDataJSON()?.type === 'LOAD_MODULE_CHILDREN');
    await page.getByRole('button', { name: '展开 src / Implementation', exact: true }).click();
    const children = (await (await expansion).json()).find((message) => message.type === 'MODULE_CHILDREN');
    assert(children?.page.nodes.length > 0, 'Expanding a persisted module must read its actual files.');
    await page.locator('.module-tree').getByRole('button', { name: '展开 file-upload.ts', exact: true }).waitFor();
    await page.screenshot({ path: `logs/task-workbench-${name}-modules.png`, fullPage: true });
    assert.equal(await page.getByLabel('检索粒度', { exact: true }).locator('option[value="subsystem"]').evaluate((option) => option.disabled), true);
    await page.getByLabel('开发需求', { exact: true }).fill('修改文件上传总大小限制和单个文件大小限制');
    await page.getByLabel('检索范围').selectOption('all');
    await page.getByLabel('检索粒度', { exact: true }).selectOption('function');
    const responsePromise = page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/v1/workbench/message') || response.request().method() !== 'POST') return false;
      return response.request().postDataJSON()?.type === 'START_TASK_SEARCH';
    }, { timeout: 65000 });
    await page.getByRole('button', { name: '检索相关代码', exact: true }).click();
    const messages = await (await responsePromise).json();
    const result = messages.find((message) => message.type === 'TASK_SEARCH_RESULT');
    assert(result, JSON.stringify(messages));
    assert(result.packet.evidence.length > 0, `${name} returned no source evidence`);
    assert(result.packet.usage.tokens <= result.packet.usage.maxTokens);
    await page.getByRole('button', { name: '导出上下文', exact: true }).waitFor();
    assert(!/token|预算/i.test(await page.locator('.context-export').innerText()));
    if (name === 'mobile') await page.locator('.context-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `logs/task-workbench-${name}-context.png`, fullPage: true });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出上下文', exact: true }).click();
    const download = await downloadPromise;
    assert.equal(await readFile(await download.path(), 'utf8'), result.packet.markdown);
    await page.getByRole('button', { name: '复制上下文', exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), result.packet.markdown);
    const detail = await page.getByLabel('代码证据', { exact: true }).locator('pre').innerText();
    assert.equal(detail, result.packet.evidence[0].content);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} page overflows horizontally`);
    await page.locator('.workbench-modes').getByRole('button', { name: '复用迁移', exact: true }).click();
    await page.locator('.migration-progress').waitFor();
    await page.locator('.workbench-modes').getByRole('button', { name: '任务检索', exact: true }).click();
    assert.equal(await page.getByLabel('开发需求', { exact: true }).inputValue(), '修改文件上传总大小限制和单个文件大小限制');
    results.push({ name, width, height, evidence: result.packet.evidence.length, tokens: result.packet.usage.tokens,
      snapshots: result.packet.snapshots, downloadMatches: true, copyMatches: true, sourceMatches: true });
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, url, results, errors };
  await writeFile('logs/task-workbench-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
