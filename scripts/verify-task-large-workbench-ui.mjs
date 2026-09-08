import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const url = process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4042';
const origin = new URL(url);
assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname), 'The verifier only accesses a local workbench.');
const outputDirectory = process.env.TASK_LARGE_UI_OUTPUT ?? 'logs';
const reportFile = path.join(outputDirectory, 'task-large-workbench-ui.json');
const scaleReportFile = process.env.TASK_SCALE_REPORT ?? 'logs/task-indexing-scale-20260908.json';
const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium, expect } = requireTools('@playwright/test');
const pageSize = 80;
const maxInitialBytes = Number(process.env.TASK_LARGE_UI_MAX_INITIAL_BYTES ?? 2 * 1024 * 1024);
assert(Number.isSafeInteger(maxInitialBytes) && maxInitialBytes > 0);
const report = { passed: false, startedAt: new Date().toISOString(), url, stage: 'prerequisites',
  guardrails: { pageSize, maxInitialBytes }, screenshots: [], browserErrors: [], measurements: {} };
let browser;
let page;

async function requestJson(route, body) {
  const start = performance.now();
  const response = await fetch(new URL(route, origin), {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000), redirect: 'error',
  });
  const text = await response.text();
  assert(response.ok, `${route} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return { body: JSON.parse(text), bytes: Buffer.byteLength(text), latencyMs: Math.round(performance.now() - start) };
}

async function message(value) {
  const result = await requestJson('/v1/workbench/message', value);
  assert(Array.isArray(result.body), 'Workbench messages must be an array.');
  const error = result.body.find((item) => item.type === 'ERROR');
  assert(!error, error?.message);
  return result;
}

async function readyPayload() {
  const result = await message({ type: 'READY' });
  const init = result.body.find((item) => item.type === 'INIT');
  assert(init, 'The real workbench did not return INIT.');
  return { ...result, payload: init.payload };
}

async function children(scope, nodeId, offset, query) {
  const requestId = crypto.randomUUID();
  const result = await message({ type: 'LOAD_MODULE_CHILDREN', requestId,
    request: { ...scope, nodeId, offset, ...(query === undefined ? {} : { query, status: 'all' }) } });
  const response = result.body.find((item) => item.requestId === requestId && item.type === 'MODULE_CHILDREN');
  assert(response, JSON.stringify(result.body));
  assert(response.page.nodes.length <= pageSize, 'A child response exceeded the page bound.');
  assert(response.page.nodes.every((node) => node.children.length === 0), 'Child responses must remain shallow.');
  return { ...result, page: response.page };
}

async function allChildren(scope, nodeId, query) {
  const nodes = [];
  const requests = [];
  let total;
  do {
    const result = await children(scope, nodeId, nodes.length, query);
    total ??= result.page.total;
    assert.equal(result.page.total, total, 'An immutable node changed size during pagination.');
    assert(result.page.nodes.length > 0 || nodes.length === total, 'Pagination stopped before the final item.');
    requests.push({ offset: nodes.length, returned: result.page.nodes.length, bytes: result.bytes, latencyMs: result.latencyMs });
    nodes.push(...result.page.nodes);
    assert(requests.length <= 128, 'The chosen local branch exceeded this verifier\'s page guardrail.');
  } while (nodes.length < total);
  assert.equal(nodes.length, total);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length, 'Pagination duplicated node IDs.');
  return { nodes, total, requests };
}

function assertLightweightAnalysis(analysis) {
  if (!analysis?.proposal) return;
  for (const field of ['modules', 'dependencies', 'unassignedFiles']) {
    assert(!Object.hasOwn(analysis.proposal, field), `The initial payload contains the complete proposal field ${field}.`);
  }
  assert((analysis.coverage?.unassigned.length ?? 0) <= 200);
}

async function screenshot(name) {
  const file = path.join(outputDirectory, `task-large-workbench-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}

function waitForChildren(nodeId, offset, query) {
  return page.waitForResponse((response) => {
    if (!response.url().endsWith('/v1/workbench/message') || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON();
    return body?.type === 'LOAD_MODULE_CHILDREN' && body.request.nodeId === nodeId &&
      body.request.offset === offset && (query === undefined || body.request.query === query);
  }, { timeout: 60_000 });
}

async function responsePage(response) {
  const messages = await response.json();
  const result = messages.find((item) => item.type === 'MODULE_CHILDREN');
  assert(result, JSON.stringify(messages));
  assert(result.page.nodes.length <= pageSize);
  return result.page;
}

await mkdir(outputDirectory, { recursive: true });
try {
  const scale = JSON.parse(await readFile(scaleReportFile, 'utf8'));
  assert(scale.passed === true || scale.buildPassed === true, 'Run only after the dedicated real-corpus build verification completes.');
  assert(scale.metrics.loc >= 1_000_000, 'The referenced run must contain at least one million indexed physical lines.');
  const health = await requestJson('/health');
  assert.deepEqual({ status: health.body.status, storage: health.body.storage }, { status: 'ready', storage: 'seekdb' });
  report.corpus = { report: scaleReportFile, repositoryRoot: scale.metrics.root, database: scale.metrics.database,
    files: scale.metrics.files, symbols: scale.metrics.symbols, loc: scale.metrics.loc,
    analysisRevision: scale.metrics.analysisRevision, sourceRevision: scale.metrics.sourceRevision,
    embedding: scale.metrics.embedding, upstreamValidation: { passed: scale.passed,
      buildPassed: scale.buildPassed ?? scale.passed, stage: scale.stage ?? 'complete',
      supplementalError: scale.supplementalError ?? null } };

  report.stage = 'initial-payload';
  const first = await readyPayload();
  report.measurements.firstReady = { bytes: first.bytes, latencyMs: first.latencyMs };
  assert.equal(first.payload.codeIntelligence.storage, 'seekdb');
  const repository = first.payload.codeIntelligence.repositories.find((item) => item.repositoryId === 'vscode-scale');
  assert(repository, 'The workbench must reuse the real capacity run repository identity.');
  assert.equal(repository.activeRevision, scale.metrics.analysisRevision);
  const projects = [...repository.projects].sort((left, right) => (right.analysis?.coverage?.total ?? 0) - (left.analysis?.coverage?.total ?? 0));
  const project = projects[0];
  assert(project?.analysis?.coverage?.total > 1000, 'No large analyzed project is visible.');
  assert.equal(project.analysis.state, 'ready');
  assert.equal(project.analysis.projection, 'ready');
  const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, projectId: project.projectId };
  const selection = await message({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', ...scope });
  report.measurements.selectProject = { bytes: selection.bytes, latencyMs: selection.latencyMs };
  const selected = await readyPayload();
  const workspace = selected.payload.moduleExplorer.target;
  assert.equal(workspace.repositoryId, scope.repositoryId);
  assert.equal(workspace.projectId, scope.projectId);
  assert.equal(workspace.revision, scope.analysisRevision);
  assert.equal(workspace.stats.files, project.analysis.coverage.total);
  assert(workspace.stats.types > 0 && workspace.stats.methods > 0);
  assert.equal(workspace.tree.length, Math.min(pageSize, workspace.rootTotal));
  assert(workspace.rootTotal >= workspace.stats.modules);
  assert(workspace.tree.every((node) => node.children.length === 0 && Number.isInteger(node.childrenTotal)));
  for (const repo of selected.payload.codeIntelligence.repositories) for (const item of repo.projects) assertLightweightAnalysis(item.analysis);
  assertLightweightAnalysis(workspace.analysis);
  report.scope = { ...scope, projectName: project.displayName };
  report.measurements.selectedReady = { bytes: selected.bytes, latencyMs: selected.latencyMs,
    initialTreeNodes: workspace.tree.length, rootTotal: workspace.rootTotal, initiallyEmbeddedDescendants: 0, stats: workspace.stats,
    analysis: { state: workspace.analysis.state, projection: workspace.analysis.projection, modeling: workspace.analysis.modeling },
    displayedDetails: { dependencies: workspace.dependencies?.length ?? 0, diagnostics: workspace.diagnostics?.length ?? 0 },
    detailCounts: workspace.detailCounts,
    sectionBytes: Object.fromEntries(Object.entries(selected.payload).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value))])),
    workspaceSectionBytes: Object.fromEntries(Object.entries(workspace).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value))])) };
  assert(selected.bytes <= maxInitialBytes, `Selected initial payload is ${selected.bytes} bytes, exceeding the ${maxInitialBytes}-byte verification guardrail.`);

  report.stage = 'complete-local-pagination';
  const roots = await allChildren(scope, '$root');
  assert.equal(roots.total, workspace.rootTotal);
  assert.equal(roots.nodes.filter((node) => node.kind === 'module').length, workspace.stats.modules);
  assert.equal(roots.nodes.reduce((sum, node) => sum + (node.contents?.files ?? 0), 0), workspace.stats.files);
  report.measurements.completeRoots = { total: roots.total, modules: workspace.stats.modules,
    filesAcrossRoots: workspace.stats.files, pages: roots.requests, uniqueNodes: roots.nodes.length };
  const hidden = await allChildren(scope, '$search', 'executeEdits');
  assert(hidden.nodes.some((node) => node.name === 'executeEdits'), 'Search did not find the real unexpanded executeEdits method.');
  const candidatePaths = [...new Set(hidden.nodes.map((node) => node.path).filter(Boolean))];
  let branch;
  for (const relativePath of candidatePaths.slice(0, 12)) {
    const matches = await allChildren(scope, '$search', relativePath);
    branch = matches.nodes.find((node) => node.childrenTotal > pageSize);
    if (branch) break;
  }
  assert(branch, 'No actual file or type with more than one child page was found near executeEdits.');
  const complete = await allChildren(scope, branch.id);
  assert.equal(complete.total, branch.childrenTotal);
  assert(complete.requests.length > 1);
  const forbiddenRequestId = crypto.randomUUID();
  const forbidden = await message({ type: 'LOAD_MODULE_CHILDREN', requestId: forbiddenRequestId,
    request: { ...scope, analysisRevision: 'not-a-visible-revision', nodeId: branch.id, offset: 0 } });
  assert(forbidden.body.some((item) => item.type === 'MODULE_CHILDREN_ERROR' && item.requestId === forbiddenRequestId));
  assert.deepEqual((await readyPayload()).payload.moduleExplorer.target.stats, workspace.stats, 'Reading child pages changed complete project statistics.');
  report.measurements.hiddenSearch = { query: 'executeEdits', returned: hidden.total, pages: hidden.requests,
    exactMatches: hidden.nodes.filter((node) => node.name === 'executeEdits').map((node) => ({ name: node.name, path: node.path, kind: node.kind })) };
  report.measurements.completeBranch = { id: branch.id, name: branch.name, path: branch.path, total: complete.total,
    pages: complete.requests, uniqueNodes: complete.nodes.length, otherRevisionRejected: true };

  report.stage = 'desktop-browser';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  const navigationStarted = performance.now();
  await page.goto(url);
  await page.getByLabel('开发需求', { exact: true }).waitFor();
  const treeItems = page.locator('.module-tree [role="treeitem"]');
  await expect(treeItems).toHaveCount(Math.min(pageSize, workspace.tree.length));
  const initiallyRendered = await treeItems.count();
  assert.equal(await page.locator('.module-tree [aria-expanded="true"]').count(), 0);
  const navigationMs = Math.round(performance.now() - navigationStarted);
  await screenshot('desktop-initial');
  report.measurements.desktop = { width: 1440, height: 1000, navigationMs,
    initiallyRenderedTreeNodes: initiallyRendered };

  let renderedRoots = initiallyRendered;
  if (workspace.rootTotal > initiallyRendered) {
    const nextRootsResponse = waitForChildren('$root', initiallyRendered);
    await page.locator('.module-tree > .tree-more').click();
    const nextRoots = await responsePage(await nextRootsResponse);
    renderedRoots += nextRoots.nodes.length;
    await expect(treeItems).toHaveCount(renderedRoots);
    report.measurements.desktop.loadedRootPages = [initiallyRendered, nextRoots.nodes.length];
  }

  const module = workspace.tree.slice(0, pageSize).find((node) => node.kind === 'module' && node.childrenTotal > 0);
  assert(module);
  const moduleResponse = waitForChildren(module.id, 0);
  await page.getByRole('button', { name: `展开 ${module.name}`, exact: true }).click();
  const modulePage = await responsePage(await moduleResponse);
  assert(modulePage.nodes.length > 0);
  await expect(treeItems).toHaveCount(renderedRoots + modulePage.nodes.length);
  await screenshot('desktop-module');

  const hiddenResponse = waitForChildren('$search', 0, 'executeEdits');
  await page.locator('.module-search input').fill('executeEdits');
  const hiddenPage = await responsePage(await hiddenResponse);
  await expect(treeItems).toHaveCount(hiddenPage.nodes.length);
  await expect(page.locator('.module-tree')).toContainText('executeEdits');
  await expect(page.locator('.module-tree .tree-location')).toHaveCount(hiddenPage.nodes.length);
  await screenshot('desktop-hidden-search');

  const pathResponse = waitForChildren('$search', 0, branch.path);
  await page.locator('.module-search input').fill(branch.path);
  let loaded = await responsePage(await pathResponse);
  let loadedCount = loaded.nodes.length;
  const branchToggle = page.getByRole('button', { name: new RegExp(`^(?:展开|折叠) ${branch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  while (await branchToggle.count() === 0 && loadedCount < loaded.total) {
    const next = waitForChildren('$search', loadedCount, branch.path);
    await page.locator('.module-tree > .tree-more').click();
    loaded = await responsePage(await next);
    loadedCount += loaded.nodes.length;
    await expect(treeItems).toHaveCount(loadedCount);
  }
  await expect(branchToggle).toHaveCount(1);
  const firstBranchResponse = waitForChildren(branch.id, 0);
  const branchElement = branchToggle.locator('..').locator('..');
  await branchToggle.click();
  const firstBranchPage = await responsePage(await firstBranchResponse);
  await expect(branchElement.locator(':scope > [role="group"] > .tree-node')).toHaveCount(firstBranchPage.nodes.length);
  const secondBranchResponse = waitForChildren(branch.id, firstBranchPage.nodes.length);
  await branchElement.locator(':scope > [role="group"] > .tree-more').click();
  const secondBranchPage = await responsePage(await secondBranchResponse);
  await expect(branchElement.locator(':scope > [role="group"] > .tree-node')).toHaveCount(firstBranchPage.nodes.length + secondBranchPage.nodes.length);
  report.measurements.desktop.expandedModuleChildren = modulePage.nodes.length;
  report.measurements.desktop.hiddenSearchNodes = hiddenPage.nodes.length;
  report.measurements.desktop.loadedBranchPages = [firstBranchPage.nodes.length, secondBranchPage.nodes.length];
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Desktop layout overflows horizontally.');
  await screenshot('desktop-paginated');

  report.stage = 'desktop-task-context';
  const requirement = 'CodeEditorWidget executeEdits editor text model';
  await page.getByLabel('开发需求', { exact: true }).fill(requirement);
  await page.getByLabel('检索范围').selectOption('target');
  await page.getByLabel('检索粒度', { exact: true }).selectOption('function');
  await expect(page.locator('.task-search-controls input')).toHaveCount(0);
  const taskResponse = page.waitForResponse((response) => response.url().endsWith('/v1/workbench/message') &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'START_TASK_SEARCH', { timeout: 40_000 });
  const taskStarted = performance.now();
  await page.getByRole('button', { name: '检索相关代码', exact: true }).click();
  const taskMessages = await (await taskResponse).json();
  const taskLatencyMs = Math.round(performance.now() - taskStarted);
  const task = taskMessages.find((item) => item.type === 'TASK_SEARCH_RESULT');
  assert(task, JSON.stringify(taskMessages));
  const packet = task.packet;
  assert.notEqual(packet.status, 'unavailable');
  assert.equal(packet.routing.requestedGranularity, 'function');
  assert.equal(packet.usage.maxTokens, 4000);
  assert(packet.usage.tokens > 0 && packet.usage.tokens <= packet.usage.maxTokens);
  assert(packet.snapshots.some((snapshot) => snapshot.repositoryId === scope.repositoryId && snapshot.analysisRevision === scope.analysisRevision));
  const implementationPath = 'vs/editor/browser/widget/codeEditor/codeEditorWidget.ts';
  const implementation = packet.evidence.find((item) => item.role === 'implementation' && item.relativePath === implementationPath && /(?:^|\.)executeEdits$/.test(item.name));
  assert(implementation, 'The task packet must contain the actual CodeEditorWidget.executeEdits implementation.');
  assert.equal(implementation.analysisRevision, scope.analysisRevision);
  const sourceBytes = await readFile(path.join(scale.metrics.root, implementationPath));
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), implementation.fileHash, 'The source file differs from the indexed immutable snapshot.');
  assert.equal(createHash('sha256').update(implementation.content).digest('hex'), implementation.contentHash);
  const source = sourceBytes.toString('utf8');
  const lineStarts = [0];
  for (let position = 0; position < source.length; position++) if (source[position] === '\n') lineStarts.push(position + 1);
  const range = implementation.sourceRange;
  const declarationLine = source.split('\n').findIndex((line) => line.includes('public executeEdits(')) + 1;
  assert(declarationLine > 1);
  assert.equal(range.startLine, declarationLine, 'The delivered range must retain the original method location.');
  const expectedSource = source.slice(lineStarts[range.startLine - 1] + range.startColumn - 1,
    lineStarts[range.endLine - 1] + range.endColumn - 1);
  assert.equal(implementation.content, expectedSource, 'Evidence content does not match its original file range.');
  await page.locator('.context-list .context-row > button').nth(packet.evidence.indexOf(implementation)).click();
  assert.equal(await page.getByLabel('代码证据', { exact: true }).locator('pre').textContent(), implementation.content);
  await page.locator('.context-export').scrollIntoViewIfNeeded();
  await screenshot('desktop-context');
  report.context = { requirement, granularity: 'function', internalBudget: packet.usage.maxTokens, status: packet.status,
    roundTripMs: taskLatencyMs, serviceLatencyMs: packet.usage.latencyMs, tokens: packet.usage.tokens,
    evidenceCount: packet.evidence.length, resultCount: packet.results.length, gaps: packet.gaps.map((gap) => gap.code),
    implementation: { name: implementation.name, relativePath: implementationPath, sourceRange: range,
      truncated: implementation.truncated, contentHash: implementation.contentHash, fileHash: implementation.fileHash },
    snapshotFileHashMatches: true, originalRangeMatches: true, previewMatches: true };

  report.stage = 'mobile-browser';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.getByLabel('开发需求', { exact: true }).waitFor();
  await expect(treeItems).toHaveCount(Math.min(pageSize, workspace.tree.length));
  const granularity = page.getByLabel('检索粒度', { exact: true });
  assert.equal(await granularity.locator('option[value="module"]').evaluate((option) => option.disabled), false);
  await granularity.selectOption('module');
  await expect(granularity).toHaveValue('module');
  await screenshot('mobile-initial');
  const mobileHiddenResponse = waitForChildren('$search', 0, 'executeEdits');
  await page.locator('.module-search input').fill('executeEdits');
  const mobileHiddenPage = await responsePage(await mobileHiddenResponse);
  await expect(treeItems).toHaveCount(mobileHiddenPage.nodes.length);
  const locations = page.locator('.module-tree .tree-location');
  await expect(locations).toHaveCount(mobileHiddenPage.nodes.length);
  const firstLocation = mobileHiddenPage.nodes[0];
  await expect(locations.first()).toHaveAttribute('title', `${firstLocation.path}:${firstLocation.line}`);
  const mobileOverflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth > innerWidth,
    tree: document.querySelector('.module-tree').scrollWidth > document.querySelector('.module-tree').clientWidth,
  }));
  assert.deepEqual(mobileOverflow, { page: false, tree: false }, 'Mobile content overflows horizontally.');
  await screenshot('mobile-hidden-search');
  report.measurements.mobile = { width: 390, height: 844, initialRootNodes: Math.min(pageSize, workspace.tree.length),
    moduleOptionEnabled: true, selectedGranularity: 'module', hiddenSearchNodes: mobileHiddenPage.nodes.length,
    disambiguatedLocations: await locations.count(), horizontalOverflow: mobileOverflow };
  assert.deepEqual(report.browserErrors, []);
  report.stage = 'complete';
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await screenshot('desktop-failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
