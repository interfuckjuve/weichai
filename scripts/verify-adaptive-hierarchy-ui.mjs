import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const origin = new URL(process.env.FOREXPLORE_WORKBENCH_URL ?? 'http://127.0.0.1:4042');
assert(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password,
  'The verifier requires a literal loopback HTTP workbench.');
const profile = process.env.ADAPTIVE_UI_PROFILE ?? 'large';
assert(['large', 'small'].includes(profile));
const output = process.env.ADAPTIVE_UI_OUTPUT ?? 'logs';
const reportPath = path.join(output, `adaptive-hierarchy-${profile}-ui.json`);
const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const { chromium, expect } = requireTools('@playwright/test');
const pageSize = 80;
const report = { passed: false, startedAt: new Date().toISOString(), url: origin.href, profile,
  stage: 'initial-payload', screenshots: [], browserErrors: [], measurements: {} };
let browser;
let page;

async function message(body) {
  const started = performance.now();
  const response = await fetch(new URL('/v1/workbench/message', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  assert(response.ok, `${body.type}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  const messages = JSON.parse(text);
  assert(Array.isArray(messages));
  assert(!messages.some((item) => item.type === 'ERROR'), JSON.stringify(messages));
  return { messages, bytes: Buffer.byteLength(text), latencyMs: Math.round(performance.now() - started) };
}

async function ready() {
  const result = await message({ type: 'READY' });
  const init = result.messages.find((item) => item.type === 'INIT');
  assert(init, 'The live workbench did not return its presentation.');
  return { ...result, payload: init.payload };
}

async function screenshot(name) {
  const file = path.join(output, `adaptive-hierarchy-${profile}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
}

await mkdir(output, { recursive: true });
try {
  const first = await ready();
  const targets = first.payload.codeIntelligence.repositories.filter((repository) => repository.role === 'target');
  const candidates = targets.flatMap((repository) => repository.projects.map((project) => ({ repository, project })))
    .sort((left, right) => (right.project.analysis?.coverage?.total ?? 0) - (left.project.analysis?.coverage?.total ?? 0));
  const selected = candidates.find(({ project }) => !process.env.ADAPTIVE_UI_PROJECT_ID || project.projectId === process.env.ADAPTIVE_UI_PROJECT_ID);
  assert(selected, 'No authorized target project is available.');
  const scope = { repositoryId: selected.repository.repositoryId, analysisRevision: selected.repository.selectedRevision,
    projectId: selected.project.projectId };
  assert(scope.analysisRevision);
  const selection = await message({ type: 'SELECT_CODE_INTELLIGENCE_PROJECT', ...scope });
  const current = await ready();
  const workspace = current.payload.moduleExplorer.target;
  assert.equal(workspace.projectId, scope.projectId);
  assert.equal(workspace.revision, scope.analysisRevision);
  assert.equal(workspace.analysis?.state, 'ready');
  assert.equal(workspace.analysis?.projection, 'ready');
  assert.equal(workspace.analysis?.proposal?.hierarchy?.version, 1, 'Rebuild this project with adaptive hierarchy before running this verifier.');
  assert(current.bytes <= 2 * 1024 * 1024, 'The initial presentation exceeds 2 MiB.');
  assert(workspace.tree.length <= pageSize);
  assert(workspace.tree.every((node) => node.children.length === 0));
  assert(!Object.hasOwn(workspace.analysis.proposal, 'modules'));
  report.scope = { ...scope, repositoryName: selected.repository.displayName, projectName: selected.project.displayName };
  report.measurements.initial = { bytes: current.bytes, selectProjectMs: selection.latencyMs,
    readyMs: current.latencyMs, rootNodes: workspace.rootTotal, renderedRoots: workspace.tree.length, stats: workspace.stats };

  const childrenCache = new Map();
  let requests = 0;
  async function allChildren(nodeId) {
    if (childrenCache.has(nodeId)) return childrenCache.get(nodeId);
    const nodes = [];
    let total;
    do {
      const requestId = crypto.randomUUID();
      const result = await message({ type: 'LOAD_MODULE_CHILDREN', requestId, request: { ...scope, nodeId, offset: nodes.length } });
      const response = result.messages.find((item) => item.type === 'MODULE_CHILDREN' && item.requestId === requestId);
      assert(response, JSON.stringify(result.messages));
      total ??= response.page.total;
      assert.equal(response.page.total, total);
      assert(response.page.nodes.length <= pageSize);
      assert(response.page.nodes.length > 0 || total === nodes.length);
      assert(response.page.nodes.every((node) => node.children.length === 0));
      nodes.push(...response.page.nodes);
      requests++;
      assert(requests <= 10_000, 'The verification exceeded its bounded local navigation requests.');
    } while (nodes.length < total);
    assert.equal(nodes.length, total);
    assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
    childrenCache.set(nodeId, nodes);
    return nodes;
  }

  report.stage = 'complete-module-hierarchy';
  const roots = await allChildren('$root');
  assert.equal(roots.length, workspace.rootTotal);
  assert.equal(roots.reduce((sum, node) => sum + node.contents.files, 0), workspace.stats.files);
  const queue = roots.filter((node) => node.kind === 'module');
  const modules = new Map();
  const parentById = new Map();
  for (const root of queue) {
    assert.equal(root.parentId, null);
    assert.equal(root.depth, 0);
  }
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    assert(!modules.has(node.id), 'A module was placed under multiple parents.');
    modules.set(node.id, node);
    assert(['module', 'subsystem'].includes(node.nodeKind));
    assert(node.refinement?.reason && ['leaf', 'split', 'deferred'].includes(node.refinement.state));
    const children = await allChildren(node.id);
    assert.equal(children.length, node.childrenTotal);
    const childModules = children.filter((child) => child.kind === 'module');
    if (node.refinement.state === 'split') {
      assert(childModules.length >= 2, 'A split cannot create a fake single-child hierarchy.');
      assert.equal(childModules.length, children.length, 'Parent nodes must own children rather than duplicate leaf files.');
      for (const child of childModules) {
        assert.equal(child.parentId, node.moduleId);
        assert.equal(child.depth, node.depth + 1);
        parentById.set(child.id, node.id);
        queue.push(child);
      }
    } else assert.equal(childModules.length, 0, 'Leaf/deferred nodes cannot claim completed child splits.');
    for (const field of ['files', 'types', 'methods']) {
      assert.equal(children.reduce((sum, child) => sum + child.contents[field], 0), node.contents[field], `${node.name}: incorrect aggregate ${field}`);
    }
  }
  const values = [...modules.values()];
  assert.equal(modules.size, workspace.stats.modules);
  const hierarchy = workspace.analysis.hierarchy;
  assert.equal(hierarchy.nodeCount, modules.size);
  assert.equal(hierarchy.rootCount, roots.filter((node) => node.kind === 'module').length);
  assert.equal(hierarchy.subsystemCount, values.filter((node) => node.nodeKind === 'subsystem').length);
  for (const state of ['leaf', 'split', 'deferred']) assert.equal(hierarchy[`${state}Count`], values.filter((node) => node.refinement.state === state).length);
  const maximumDepth = values.reduce((maximum, node) => Math.max(maximum, node.depth), 0);
  const terminalDepths = [...new Set(values.filter((node) => node.refinement.state !== 'split').map((node) => node.depth))].sort((a, b) => a - b);
  assert.equal(hierarchy.maxDepth, maximumDepth);
  if (profile === 'large') assert(hierarchy.splitCount > 0 && modules.size > hierarchy.rootCount, 'The large project still has only a flat module list.');
  if (process.env.ADAPTIVE_UI_EXPECT_MAX_DEPTH !== undefined) assert(maximumDepth <= Number(process.env.ADAPTIVE_UI_EXPECT_MAX_DEPTH));
  if (process.env.ADAPTIVE_UI_EXPECT_MODEL === '1') assert(workspace.analysis.proposal.hierarchy.modelDecisionCount > 0, 'No real model decision was recorded.');
  if (process.env.ADAPTIVE_UI_EXPECT_UNEVEN === '1') assert(terminalDepths.length > 1, 'The selected corpus did not produce branches with different depths.');
  report.hierarchy = { ...hierarchy, terminalDepths, decisions: workspace.analysis.proposal.hierarchy,
    roots: roots.filter((node) => node.kind === 'module').map((node) => ({ id: node.id, name: node.name, files: node.contents.files, refinement: node.refinement })),
    decisionSources: Object.fromEntries(['model', 'structural', 'budget'].map((source) => [source, values.filter((node) => node.refinement.decisionSource === source).length])),
    fullModuleTraversal: true, aggregateCountsMatch: true, requests };

  const leaves = values.filter((node) => node.refinement.state !== 'split' && node.contents.methods > 0);
  if (profile === 'large') leaves.sort((left, right) => Math.abs(left.depth - 3) - Math.abs(right.depth - 3));
  const leaf = leaves[0];
  assert(leaf, 'No actual leaf with callable source symbols exists.');
  const chain = [leaf];
  while (parentById.has(chain[0].id)) chain.unshift(modules.get(parentById.get(chain[0].id)));
  let currentNode = leaf;
  for (let depth = 0; depth < 64 && currentNode.kind !== 'file'; depth++) {
    const candidates = await allChildren(currentNode.id);
    const next = candidates.find((node) => ['folder', 'file'].includes(node.kind) && node.contents.methods > 0);
    assert(next, 'A module with methods has no matching directory/file descendants.');
    chain.push(next); currentNode = next;
  }
  assert.equal(currentNode.kind, 'file');
  const sourceFileId = currentNode.id;
  const symbols = await allChildren(currentNode.id);
  const declarationIds = symbols.map((node) => node.id);
  const symbol = symbols.find((node) => node.childrenTotal > 0) ?? symbols.find((node) => ['function', 'method'].includes(node.kind));
  assert(symbol, 'The actual source file has no visible declaration.');
  chain.push(symbol);
  if (symbol.childrenTotal > 0) chain.push((await allChildren(symbol.id))[0]);
  if (profile === 'large') assert(chain.filter((node) => node.kind === 'module').length > 1,
    'The large-corpus screenshot must demonstrate actual nested module nodes.');
  report.navigation = { leaf: { id: leaf.id, name: leaf.name, refinement: leaf.refinement },
    chain: chain.map((node) => ({ id: node.id, name: node.name, kind: node.nodeKind ?? node.kind, path: node.path, depth: node.depth })) };

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(40_000);
  page.on('pageerror', (error) => report.browserErrors.push(error.message));
  const nodeLocator = (node) => page.locator(`[data-node-id=${JSON.stringify(node.id)}]`);
  async function openChain() {
    for (let index = 0; index < chain.length; index++) {
      const node = chain[index];
      const parent = chain[index - 1];
      for (let count = 0; await nodeLocator(node).count() === 0; count++) {
        assert(count < 128, 'Unable to reveal the real descendant through bounded pages.');
        const list = parent ? nodeLocator(parent).locator(':scope > [role="group"]') : page.locator('.module-tree');
        const items = list.locator(':scope > [role="treeitem"]');
        const previousCount = await items.count();
        const response = page.waitForResponse((response) => response.url().endsWith('/v1/workbench/message') &&
          response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'LOAD_MODULE_CHILDREN' &&
          response.request().postDataJSON().request.nodeId === (parent?.id ?? '$root'));
        await list.locator(':scope > .tree-more').click();
        await response;
        await expect(items).not.toHaveCount(previousCount);
      }
      if (index < chain.length - 1) {
        const row = nodeLocator(node);
        if (await row.getAttribute('aria-expanded') !== 'true') await row.locator(':scope > .tree-row > .tree-toggle').click();
        await expect(row.locator(':scope > [role="group"] > .tree-node').first()).toBeAttached();
      }
    }
    await expect(nodeLocator(chain.at(-1))).toBeAttached();
    await nodeLocator(chain.at(-1)).scrollIntoViewIfNeeded();
  }
  report.stage = 'browser';
  report.measurements.viewports = [];
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin.href);
    await page.getByLabel('开发需求', { exact: true }).waitFor();
    await expect(page.locator('.module-tree > [role="treeitem"]')).toHaveCount(workspace.tree.length);
    const granularity = page.getByLabel('检索粒度', { exact: true });
    assert.equal(await granularity.locator('option[value="subsystem"]').evaluate((option) => option.disabled), hierarchy.subsystemCount === 0);
    await screenshot(`${name}-initial`);
    await openChain();
    await screenshot(`${name}-hierarchy`);
    await nodeLocator(leaf).locator(':scope > .tree-row > .tree-select').click();
    const preview = page.getByLabel('当前选择', { exact: true });
    await expect(preview.getByLabel('模块细化状态', { exact: true })).toContainText(leaf.refinement.reason);
    await preview.scrollIntoViewIfNeeded();
    await ready();
    childrenCache.delete(sourceFileId);
    assert.deepEqual((await allChildren(sourceFileId)).map((node) => node.id), declarationIds,
      'Selecting a module inserted a non-source declaration into its representative file.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal page overflow`);
    await screenshot(`${name}-decision`);
    report.measurements.viewports.push({ name, width, height, originalRoots: workspace.tree.length,
      expandedPathNodes: chain.length, moduleToSourceNavigation: true, refinementReasonVisible: true,
      moduleSelectionPreservesDeclarations: true, subsystemOptionMatchesPublishedNodes: true });
  }
  assert.deepEqual(report.browserErrors, []);
  report.stage = 'complete';
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (page) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
