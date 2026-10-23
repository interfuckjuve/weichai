// @vitest-environment node
/**
 * Integration check for the extension's LangChain verification path.
 *
 * The extension module is bundled exactly like the shipped extension (esbuild,
 * CommonJS, native grammars external) and loaded from that bundle, so the
 * framework dependencies used by the verifier are resolved and exercised from a
 * packaged artifact. Model requests are scripted by a local HTTP server; the
 * LangChain Host, its tools and its revalidation loop are the real ones.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectPipelineModule } from './project-pipeline-types';

type Verifier = typeof import('./project-module-verifier');
type Completion = { content?: string; status?: number; body?: unknown; beforeReply?: () => void };

const roots: string[] = [];
let bundleDirectory = '';
let verifier: Verifier;

beforeAll(async () => {
  bundleDirectory = await mkdtemp(path.join(tmpdir(), 'recast-verifier-bundle-'));
  const nativeRequire = createRequire(path.resolve(import.meta.dirname, '../../../services/code-indexer/package.json'));
  const source = path.join(import.meta.dirname, 'project-module-verifier.ts');
  await build({
    stdin: { contents: `export * from ${JSON.stringify(source)};`, resolveDir: import.meta.dirname },
    outfile: path.join(bundleDirectory, 'verifier.cjs'),
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
    plugins: [{ name: 'native-grammars', setup: context => {
      context.onResolve({ filter: /^(tree-sitter|@tree-sitter-grammars)/ }, args => ({ path: nativeRequire.resolve(args.path), external: true }));
    } }],
  });
  verifier = createRequire(import.meta.url)(path.join(bundleDirectory, 'verifier.cjs')) as Verifier;
  const shim = await createMavenShim();
  process.env.PATH = `${shim}${path.delimiter}${process.env.PATH ?? ''}`;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
  if (shimDirectory) await rm(shimDirectory, { recursive: true, force: true });
});

const RUNNER = `const fs = require('node:fs');
const mode = fs.readFileSync('.fixture-mode', 'utf8').trim() || 'pass';
fs.rmSync('target', { recursive: true, force: true });
fs.mkdirSync('target/surefire-reports', { recursive: true });
fs.mkdirSync('target/site/jacoco', { recursive: true });
const method = (name, desc, missed, covered, branch) => '<method name="' + name + '" desc="' + desc + '"><counter type="METHOD" missed="0" covered="1"/><counter type="LINE" missed="' + missed + '" covered="' + covered + '"/>' + branch + '</method>';
const methods = [method('calculatePrice', '(I)I', 0, 4, '<counter type="BRANCH" missed="1" covered="1"/>')];
if (mode === 'pass') methods.push(method('applyDiscount', '(I)I', 1, 3, ''));
fs.writeFileSync('target/site/jacoco/jacoco.xml', '<report><package name=""><class name="Order" sourcefilename="Order.java">' + methods.join('') + '</class></package></report>');
const surefire = 'target/surefire-reports/TEST-OrderTest.xml';
if (mode === 'compile') {
  process.stdout.write('[ERROR] OrderTest.java:[12,5] cannot find symbol');
  fs.writeFileSync(surefire, '<testsuite name="OrderTest" tests="1" failures="0" errors="1" skipped="0"><testcase classname="OrderTest" name="compile"><error message="cannot find symbol"/></testcase></testsuite>');
  process.exitCode = 1;
} else if (mode === 'bug') {
  fs.writeFileSync(surefire, '<testsuite name="OrderTest" tests="1" failures="1" errors="0" skipped="0"><testcase classname="OrderTest" name="discount"><failure message="expected rejection">trace</failure></testcase></testsuite>');
  process.exitCode = 1;
} else {
  fs.writeFileSync(surefire, '<testsuite name="OrderTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="OrderTest" name="requirement"/></testsuite>');
}
`;

const ORDER = [
  'public class Order {',
  '  public int calculatePrice(int quantity) { return quantity * 2; }',
  '  public int applyDiscount(int total) { return total - 1; }',
  '}',
].join('\n');

async function createProject(mode: 'pass' | 'partial' | 'bug' | 'compile' = 'pass'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-verifier-module-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  // The default resolver discovers this Maven project and its dedicated test
  // folder; the Agent-visible test file below is what the Host revalidates.
  await mkdir(path.join(root, 'src/test/java/translation-verifier'), { recursive: true });
  await writeFile(path.join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion><artifactId>order</artifactId><version>1.0.0</version></project>');
  await writeFile(path.join(root, 'src/Order.java'), ORDER);
  await writeFile(path.join(root, 'src/test/java/translation-verifier/OrderTest.java'), 'class OrderTest {}');
  await writeFile(path.join(root, 'fake-runner.cjs'), RUNNER);
  await writeFile(path.join(root, '.fixture-mode'), mode);
  return root;
}

/** Deterministic `mvn` placed on PATH: it emits fresh Surefire and JaCoCo reports. */
let shimDirectory = '';
async function createMavenShim() {
  const directory = await mkdtemp(path.join(tmpdir(), 'recast-verifier-bin-'));
  shimDirectory = directory;
  const runner = path.join(bundleDirectory, 'fake-runner.cjs');
  if (process.platform === 'win32') {
    await writeFile(path.join(directory, 'mvn.cmd'), `@echo off\r\n"${process.execPath.replace(/%/g, '%%')}" "${runner.replace(/%/g, '%%')}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    await writeFile(path.join(directory, 'mvn'), `#!${process.execPath}\nrequire(${JSON.stringify(runner)});\nif (process.exitCode) process.exit(process.exitCode);\n`, { mode: 0o755 });
  }
  await writeFile(runner, RUNNER);
  return directory;
}

/** Scripted OpenAI-compatible endpoint; records the requests the framework actually sent. */
async function startModelServer(replies: Completion[]) {
  const requests: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += String(chunk); });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', headers: request.headers, body: JSON.parse(raw || '{}') as Record<string, unknown> });
      const reply = replies.shift() ?? { content: '{"verdict":"no-bug","summary":"done"}' };
      reply.beforeReply?.();
      if (reply.body !== undefined) {
        response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(reply.body));
        return;
      }
      response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        id: `completion-${requests.length}`, object: 'chat.completion', created: 0, model: 'deepseek-test',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    apiBase: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

function moduleInput(root: string): ProjectPipelineModule {
  return {
    id: 'order', name: 'Order pricing', dependsOn: [], candidates: [], changedFiles: [],
    target: { language: 'Java', module: { sourceFiles: ['src/Order.java'] } },
  } as unknown as ProjectPipelineModule;
}

function verify(input: {
  root: string;
  apiBase: string;
  signal?: AbortSignal;
  log?: string[];
  candidates?: unknown[];
  historyView?: unknown;
}) {
  return verifier.verifyPipelineModule({
    root: input.root,
    module: moduleInput(input.root),
    requirement: 'Discounts must be strictly monotonic.',
    model: { apiKey: 'sk-test-key', apiBase: input.apiBase, model: 'deepseek-test' },
    candidates: (input.candidates ?? []) as never,
    ...(input.historyView ? { historyView: input.historyView as never } : {}),
    signal: input.signal ?? new AbortController().signal,
    log: message => { input.log?.push(message); },
  });
}

/** A direct-read history view whose single selected module sits under `source/candidate-1`. */
async function createHistoryView(): Promise<{ historyView: unknown; candidates: unknown[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-verifier-history-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  await mkdir(path.join(sourceRoot, 'candidate-1'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'candidate-1/Order.cs'), [
    'public class Order {',
    '  public int calculatePrice(int quantity) { return quantity * 2; }',
    '  public int applyDiscount(int total) { return total - 1; }',
    '}',
  ].join('\n'));
  const historyView = {
    root,
    files: ['candidate-1/Order.cs'],
    repositoryId: 'repo-1',
    analysisRevision: 'revision-1',
    moduleId: 'orders',
    manifestHash: 'manifest-1',
    candidates: [{
      prefix: 'candidate-1',
      repositoryId: 'repo-1',
      analysisRevision: 'revision-1',
      moduleId: 'orders',
      language: 'Java',
    }],
  };
  const candidates = [{
    id: 'candidate-1',
    title: 'Order',
    repository: 'repo-1',
    license: 'MIT',
    language: 'Java',
    kind: 'module',
    path: 'candidate-1/Order.cs',
    signature: 'Order',
    summary: 'Order pricing',
    score: {},
    preview: 'Order pricing',
    dependencies: [],
    compatibility: [],
    risks: [],
    sourceModule: {
      repositoryId: 'repo-1',
      analysisRevision: 'revision-1',
      projectId: 'project-1',
      moduleId: 'orders',
      name: 'Order',
      projectPath: 'source',
      sourceFiles: ['Order.cs'],
      coreApis: ['calculatePrice(int quantity)', 'applyDiscount(int total)'],
    },
  }];
  return { historyView, candidates };
}

const report = (value: Record<string, unknown>) => JSON.stringify(value);

describe('extension LangChain verification path', () => {
  it('verifies a module through the bundled framework Host and maps the model configuration', async () => {
    const root = await createProject('pass');
    const server = await startModelServer([{
      content: report({ verdict: 'no-bug', summary: 'Pricing and discounts behave as required.' }),
    }]);
    const log: string[] = [];
    try {
      const verification = await verify({ root, apiBase: server.apiBase, log });
            expect(verification.disposition).toBe('verified');
      expect(verification.mode).toBe('requirement');
      expect(verification.result?.status).toBe('success');
      expect(verification.result?.functions.map(item => item.target.name)).toEqual(['calculatePrice', 'applyDiscount']);
      expect(verification.result?.functions[0]).toMatchObject({ executed: true, status: 'passed', lineCoverage: 100, branchCoverage: 50 });
      expect(verification.result?.functions[1]).toMatchObject({ executed: true, lineCoverage: 75, branchCoverage: null });
      expect(verification.attempts).toHaveLength(1);

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.url).toBe('/v1/chat/completions');
      expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-test-key');
      expect(server.requests[0]!.body).toMatchObject({ model: 'deepseek-test', max_tokens: 16_384, thinking: { type: 'disabled' } });
      expect(JSON.stringify(server.requests[0]!.body)).not.toContain('sk-test-key');

      expect(log).toContain('Verifier：验证运行开始');
      expect(log.some(line => line.startsWith('Verifier：Agent 调用完成'))).toBe(true);
      expect(log.some(line => line.includes('Host 复验') && line.includes('接受候选结论'))).toBe(true);
      expect(log.some(line => line.startsWith('Verifier：验证运行完成'))).toBe(true);
      expect(log.some(line => line.includes('验证运行失败'))).toBe(false);
    } finally { await server.close(); }
  });

  it('keeps every requested target when an evidenced production defect is found early', async () => {
    const root = await createProject('bug');
    const server = await startModelServer([{
      content: report({
        verdict: 'bug-found',
        summary: 'Discounts are not applied to the reported totals.',
        issue: { kind: 'translation', description: 'Discounts must be strictly monotonic, but the failing assertion shows they are not.' },
        affectedTargets: [{ path: 'src/Order.java', name: 'calculatePrice', signature: 'Order.calculatePrice' }],
      }),
    }]);
    try {
      const verification = await verify({ root, apiBase: server.apiBase });
      expect(verification.disposition).toBe('production-defect');
      expect(verification.result?.status).toBe('failure');
      expect(verification.result?.issue?.kind).toBe('translation');
      expect(verification.result?.functions.map(item => [item.target.name, item.executed, item.status, item.reason])).toEqual([
        ['calculatePrice', true, 'unverified', 'test-failed'],
        ['applyDiscount', false, 'unverified', 'test-failed'],
      ]);
      expect(verification.result?.functions[1]).toMatchObject({ lineCoverage: null, branchCoverage: null });
    } finally { await server.close(); }
  });

  it('classifies an accepted uncertain report as agent-uncertain instead of verified', async () => {
    const root = await createProject('pass');
    const server = await startModelServer([{
      content: report({
        verdict: 'uncertain',
        summary: 'The required rounding contract is missing from the requirement.',
        issue: { kind: 'unknown', description: 'No source or protocol rule defines half-up versus half-even rounding.' },
      }),
    }]);
    try {
      const verification = await verify({ root, apiBase: server.apiBase });
      expect(verification.result?.status).toBe('failure');
      expect(verification.result?.issue?.kind).toBe('unknown');
      expect(verification.disposition).toBe('agent-uncertain');
      expect(verification.disposition).not.toBe('verified');
      expect(verification.disposition).not.toBe('production-defect');
      expect(verification.result?.functions.every(item => item.executed)).toBe(true);
    } finally { await server.close(); }
  });

  it('repairs a rejected report through the same Agent session and Host revalidation', async () => {
    const root = await createProject('pass');
    const server = await startModelServer([
      { content: 'The pricing code looks reasonable to me.' },
      { content: report({ verdict: 'no-bug', summary: 'Pricing and discounts behave as required.' }) },
    ]);
    const log: string[] = [];
    try {
      const verification = await verify({ root, apiBase: server.apiBase, log });
      expect(verification.disposition).toBe('verified');
      expect(server.requests).toHaveLength(2);
      const first = JSON.stringify(server.requests[0]!.body.messages);
      const second = JSON.stringify(server.requests[1]!.body.messages);
      expect(second.length).toBeGreaterThan(first.length);
      expect(second).toContain('pricing code looks reasonable');
      expect(second).toContain('final report');
      expect(log.some(line => line.startsWith('Verifier：向同一 Agent 追加反馈'))).toBe(true);
      expect(log.filter(line => line.startsWith('Verifier：Host 复验'))).toHaveLength(2);
    } finally { await server.close(); }
  });

  it('stops on cancellation without starting another feedback round', async () => {
    const root = await createProject('pass');
    const controller = new AbortController();
    const server = await startModelServer([{
      content: 'The pricing code looks reasonable to me.',
      beforeReply: () => controller.abort(new DOMException('Verification cancelled.', 'AbortError')),
    }]);
    try {
      await expect(verify({ root, apiBase: server.apiBase, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(server.requests).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('verifies a selected history module in translation-fidelity mode with real source mapping', async () => {
    const root = await createProject('pass');
    const { historyView, candidates } = await createHistoryView();
    const server = await startModelServer([{
      content: report({ verdict: 'no-bug', summary: 'The translated pricing behavior matches the source module.' }),
    }]);
    try {
      const verification = await verify({ root, apiBase: server.apiBase, candidates, historyView });
      // A trusted mapping with a history view selects the fidelity strategy.
      expect(verification.mode).toBe('translation-fidelity');
      expect(verification.disposition).toBe('verified');
      expect(verification.result?.status).toBe('success');
      // The Host assembles the source project under the view root and keeps the
      // selected module prefix, so the Agent can read the historical source.
      expect(verification.result?.functions.map(item => item.source?.path)).toEqual([
        'candidate-1/Order.cs',
        'candidate-1/Order.cs',
      ]);
      expect(verification.result?.functions.map(item => item.target.name)).toEqual(['calculatePrice', 'applyDiscount']);
      // The task the framework sent names the historical source file, which only
      // exists once sourceProjectPath was joined to the view root.
      expect(JSON.stringify(server.requests[0]!.body.messages)).toContain('candidate-1/Order.cs');
      expect(verification.attempts).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('reports a fidelity-mode production defect for the affected source target', async () => {
    const root = await createProject('bug');
    const { historyView, candidates } = await createHistoryView();
    const server = await startModelServer([{
      content: report({
        verdict: 'bug-found',
        summary: 'The translated discount is not monotonic.',
        issue: { kind: 'translation', description: 'Discounts must be strictly monotonic, but the failing assertion shows they are not.' },
        affectedTargets: [{ path: 'src/Order.java', name: 'calculatePrice', signature: 'Order.calculatePrice' }],
      }),
    }]);
    try {
      const verification = await verify({ root, apiBase: server.apiBase, candidates, historyView });
      expect(verification.mode).toBe('translation-fidelity');
      expect(verification.disposition).toBe('production-defect');
      expect(verification.result?.status).toBe('failure');
      expect(verification.result?.issue?.kind).toBe('translation');
      expect(verification.result?.functions[0]).toMatchObject({
        source: { path: 'candidate-1/Order.cs' },
        target: { path: 'src/Order.java', name: 'calculatePrice' },
        executed: true,
      });
    } finally { await server.close(); }
  });

  it('classifies a model failure as an unfinished verification, not a production defect', async () => {
    const root = await createProject('pass');
    const server = await startModelServer([{
      status: 401,
      body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } },
    }]);
    const log: string[] = [];
    try {
      const verification = await verify({ root, apiBase: server.apiBase, log });
      expect(verification.result?.status).toBe('failure');
      expect(verification.result?.reason).toBe('model-failure');
      expect(verification.result?.issue?.kind).toBe('unknown');
      expect(verification.result?.functions.every(item => !item.executed && item.status === 'unverified')).toBe(true);
      expect(verification.disposition).toBe('agent-uncertain');
      expect(log.some(line => line.includes('验证运行失败'))).toBe(true);
    } finally { await server.close(); }
  });
});
