import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireTools = createRequire(path.resolve(process.env.FOREXPLORE_UI_TOOLS ?? process.cwd(), 'package.json'));
const esbuild = requireTools('esbuild');
const { chromium } = requireTools('@playwright/test');
const candidate = {
  id: 'module-payment', title: 'Payment processing', kind: 'module', repository: 'history/payments', license: 'Unknown', language: 'Java',
  path: 'src/main/java/payments/PaymentService.java', signature: 'submitPayment', summary: 'Payment processing with durable receipts',
  score: { overall: 0.81, semantic: 0.81, symbol: 0, contract: 0.5 }, preview: '// PaymentService.java\nclass PaymentService {}',
  dependencies: ['storage'], compatibility: [], risks: ['Behavior requires validation'],
  sourceModule: { repositoryId: 'history', analysisRevision: 'revision', projectId: 'project', moduleId: 'payments', name: 'Payment processing', projectPath: 'services/payments',
    sourceFiles: ['src/main/java/payments/PaymentService.java', 'src/main/java/payments/ReceiptRepository.java', 'src/main/java/payments/validation/PaymentRequestValidator.java'],
    coreApis: ['submitPayment'], dependsOn: ['storage'], evidenceIds: ['project:payments'] },
  moduleMatch: { requiredApis: ['SubmitPayment', 'RecoverPayment'], matchedApis: ['SubmitPayment'], missingApis: ['RecoverPayment'], verification: 'interface-only',
    previewFiles: ['src/main/java/payments/PaymentService.java'], previewTruncated: true },
};
const source = `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialWorkflowState } from '@forexplore/workflow-core';
import { CandidatesStage } from './apps/vscode-extension/webview/src/components/CandidatesStage';
import './apps/vscode-extension/webview/src/styles.css';
const candidate = ${JSON.stringify(candidate)};
function Fixture() {
  const [selected, select] = useState(null);
  return <CandidatesStage state={{...initialWorkflowState, stage:'candidates', target: {id:'target',name:'Payments',kind:'module',path:'Payments.cs',language:'C#',signature:''},
    candidates:[candidate],selectedCandidateId:selected}} dispatch={()=>{}} adaptationProvider="DeepSeek" onSelectCandidate={select} onAdapt={()=>{throw new Error('Module passed to single-file adaptation');}} />;
}
createRoot(document.getElementById('root')).render(<Fixture />);`;
const build = await esbuild.build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false,
  outfile: 'module-preview.js', platform: 'browser', format: 'iife', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = build.outputFiles.find((file) => file.path.endsWith('.css')).text;
const js = build.outputFiles.find((file) => file.path.endsWith('.js')).text;
await mkdir('logs', { recursive: true });
const preview = path.resolve('logs/module-matching-preview.html');
await writeFile(preview, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Module Matching Acceptance</title><style>${css}</style><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`);
const browser = await chromium.launch({ headless: true, ...(process.env.FOREXPLORE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FOREXPLORE_CHROMIUM_EXECUTABLE } : {}) });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [name, width, height] of [['desktop', 1100, 780], ['narrow', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(pathToFileURL(preview).href);
    await page.locator('.candidate-item').click();
    await page.getByLabel('已选候选详情').waitFor();
    assert(await page.getByRole('button', { name: '多文件适配暂不可用' }).isDisabled());
    assert(await page.getByLabel('已选候选详情').getByText('src/main/java/payments/ReceiptRepository.java', { exact: true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} page overflows horizontally`);
    assert.equal(await page.locator('.candidate-module-files').evaluate((list) => list.scrollWidth > list.clientWidth), false, `${name} source manifest is clipped`);
    await page.screenshot({ path: `logs/module-matching-${name}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: ['1100x780', '390x844'], preview, screenshots: 2 }));
} finally { await browser.close(); }
