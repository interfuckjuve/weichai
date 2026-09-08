import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getEncoding } from 'js-tiktoken';
import type { ListProjectsResult, ListRepositoriesResult, ReadSourceExcerptResult, SearchSymbolsResult, TaskRetrievalRequest, TaskRetrievalScope } from '@forexplore/contracts';
import { HttpTaskRetrievalPort } from '../services/semantic-index-mcp-server/src/http-task-retrieval-port.js';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:4041' },
  'output-dir': { type: 'string', default: 'logs' },
} });
const endpoint = new URL(values.endpoint!);
assert(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
  && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password,
'MCP verification requires the existing local HTTP semantic host.');
const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.resolve(values['output-dir']!);
const tokenizer = getEncoding('cl100k_base');
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = { startedAt, endpoint: endpoint.origin, provider: 'Real MCP SDK stdio client and local HTTP host; no provider mocks', passed: false, checks: [] };
const checks = report.checks as Array<Record<string, unknown>>;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', path.join(root, 'services/semantic-index-mcp-server/src/server.ts')],
  cwd: root,
  env: { ...getDefaultEnvironment(), SEMANTIC_QUERY_PORT_URL: endpoint.origin,
    ...(process.env.SEMANTIC_QUERY_PORT_TOKEN ? { SEMANTIC_QUERY_PORT_TOKEN: process.env.SEMANTIC_QUERY_PORT_TOKEN } : {}) },
  stderr: 'pipe',
});
let stderrBytes = 0;
let stderrText = '';
transport.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; stderrText = `${stderrText}${chunk.toString()}`.slice(-4096); });
const client = new Client({ name: 'task-context-live-verifier', version: '0.1.0' });
const protocolErrors: string[] = [];
client.onerror = (error) => { protocolErrors.push(error.message); };
let serverPid: number | null = null;

type ToolResponse = Awaited<ReturnType<Client['callTool']>>;
function textContent(response: ToolResponse): string {
  assert(Array.isArray(response.content) && response.content.length === 1, 'Tool must return exactly one content block.');
  const content = response.content[0];
  assert(content?.type === 'text' && typeof content.text === 'string', 'Tool must return one text block.');
  return content.text;
}
async function call(name: string, arguments_: Record<string, unknown>): Promise<ToolResponse> {
  return client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 65000 });
}
async function jsonTool<T>(name: string, arguments_: Record<string, unknown>): Promise<T> {
  const response = await call(name, arguments_);
  assert.notEqual(response.isError, true, `${name} returned a tool error.`);
  return JSON.parse(textContent(response)) as T;
}
async function check(name: string, action: () => Promise<Record<string, unknown>>): Promise<void> {
  const started = performance.now();
  const entry: Record<string, unknown> = { name, passed: false };
  checks.push(entry);
  try { Object.assign(entry, await action()); entry.passed = true; }
  catch (error) { entry.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { entry.elapsedMs = Math.round(performance.now() - started); console.info(`${name}: ${entry.passed ? 'passed' : 'failed'}, ${entry.elapsedMs} ms`); }
}

try {
  await client.connect(transport, { timeout: 15000 });
  serverPid = transport.pid;
  report.serverPid = serverPid;
  await check('tool-discovery', async () => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    const legacy = ['list_repositories', 'get_repository_overview', 'list_projects', 'get_file_structure', 'search_symbols', 'get_symbol',
      'find_definition', 'find_references', 'get_dependencies', 'get_diagnostics', 'read_source_excerpt'];
    for (const name of [...legacy, 'search_task_context']) assert(names.includes(name), `Missing expected tool: ${name}.`);
    assert.equal(names.length, 12, 'The expected toolset is eleven existing tools plus task context.');
    assert(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    return { tools: names, readOnly: true };
  });
  let scopes: TaskRetrievalScope[] = [];
  await check('repository-project-discovery', async () => {
    const repositories = await jsonTool<ListRepositoriesResult>('list_repositories', {});
    const target = repositories.repositories.find((repository) => repository.role === 'target' && repository.displayName === 'commons-fileupload-ts');
    const reference = repositories.repositories.find((repository) => repository.role === 'history' && repository.displayName === 'commons-fileupload');
    assert(target?.analysisRevision && reference?.analysisRevision, 'Live target and Java reference revisions must be discoverable by the CLI.');
    for (const [index, repository] of [target, reference].entries()) {
      const revisionScope = { repositoryId: repository.repositoryId, analysisRevision: repository.analysisRevision! };
      const projects = await jsonTool<ListProjectsResult>('list_projects', revisionScope);
      const project = projects.projects.find((item) => item.value.relativePath === '');
      assert(project, 'The root project was not discoverable.');
      assert.equal(project.repositoryId, revisionScope.repositoryId);
      assert.equal(project.analysisRevision, revisionScope.analysisRevision);
      scopes.push({ ...revisionScope, projectId: project.value.projectId, role: index === 0 ? 'target' : 'reference' });
    }
    report.scopes = scopes;
    return { repositories: repositories.repositories.length, selectedScopes: scopes.length, source: 'list_repositories -> list_projects' };
  });
  let expectedSource = '';
  await check('legacy-source-read', async () => {
    const target = scopes[0]!;
    const revisionScope = { repositoryId: target.repositoryId, analysisRevision: target.analysisRevision };
    const symbols = await jsonTool<SearchSymbolsResult>('search_symbols', { ...revisionScope, query: 'parseRequest', projectIds: [target.projectId!], kinds: ['method', 'function'], limit: 10 });
    const symbol = symbols.symbols.find((item) => item.value.name === 'parseRequest' && item.value.relativePath === 'src/file-upload.ts');
    assert(symbol, 'The existing symbol tool did not locate the actual parseRequest declaration.');
    const source = await jsonTool<ReadSourceExcerptResult>('read_source_excerpt', { ...revisionScope,
      relativePath: symbol.value.relativePath, sourceRange: symbol.value.sourceRange, maxChars: 12000 });
    assert(source.excerpt && !source.excerpt.value.truncated, 'The exact parseRequest source range is unavailable.');
    assert.equal(source.excerpt.repositoryId, target.repositoryId);
    assert.equal(source.excerpt.analysisRevision, target.analysisRevision);
    assert.deepEqual(source.excerpt.sourceRange, symbol.value.sourceRange);
    expectedSource = source.excerpt.value.text;
    assert(/if\s*\([^\n]*sizeMax/.test(expectedSource) && /if\s*\([^\n]*fileSizeMax/.test(expectedSource));
    return { relativePath: symbol.value.relativePath, sourceRange: symbol.value.sourceRange, sourceHash: createHash('sha256').update(expectedSource).digest('hex') };
  });
  const request: TaskRetrievalRequest = { requestId: `mcp-default-${randomUUID()}`, requirement: '修改文件上传总大小限制和单个文件大小限制',
    granularity: 'function', scopes, budget: { maxTokens: 4000, maxLatencyMs: 60000 } };
  await check('task-markdown-default-budget', async () => {
    const response = await call('search_task_context', { ...request });
    assert.notEqual(response.isError, true, 'Task context returned an MCP error.');
    const markdown = textContent(response);
    assert(!Object.hasOwn(response, 'structuredContent'), 'Task context must not duplicate the source packet as structured JSON.');
    assert(markdown.startsWith('# Code Context\n'), 'Task tool returned a JSON packet instead of Markdown.');
    assert(markdown.includes('function -> function (user)'), 'MCP did not preserve the user-selected granularity.');
    for (const scope of scopes) assert(markdown.includes(`${scope.repositoryId}@${scope.analysisRevision}`), 'Markdown changed the discovered fixed revision.');
    assert.equal(markdown.split(expectedSource).length - 1, 1, 'The complete primary implementation must occur exactly once.');
    assert(/throw new SizeLimitExceededException/.test(markdown) && /throw new FileSizeLimitExceededException/.test(markdown));
    const tokens = tokenizer.encode(markdown, [], []).length;
    assert(tokens <= request.budget.maxTokens, 'MCP text exceeds the complete exported token budget.');
    return { requestId: request.requestId, granularity: request.granularity, maxTokens: request.budget.maxTokens, tokenizer: 'cl100k_base', tokens,
      characters: markdown.length, markdownHash: createHash('sha256').update(markdown).digest('hex'), textBlocks: 1, sourceOccurrences: 1, structuredSourcePacket: false };
  });
  await check('mcp-strict-request-scope', async () => {
    const failures = [
      { name: 'foreign-revision', arguments: { ...request, scopes: [{ ...scopes[0], analysisRevision: scopes[1]!.analysisRevision }] } },
      { name: 'unknown-project', arguments: { ...request, scopes: [{ ...scopes[0], projectId: 'missing-project-for-mcp-verification' }] } },
      { name: 'unknown-repository', arguments: { ...request, scopes: [{ ...scopes[0], repositoryId: 'unregistered-mcp-verification-repository' }] } },
      { name: 'arbitrary-local-path', arguments: { ...request, localPath: '/tmp/mcp-verification-outside-scope' } },
    ];
    for (const item of failures) {
      const response = await call('search_task_context', item.arguments);
      assert.equal(response.isError, true, `${item.name} was accepted or silently substituted.`);
      assert(!textContent(response).includes('# Code Context'), `${item.name} returned source context.`);
    }
    return { rejected: failures.map((item) => item.name), noSilentScopeSubstitution: true };
  });
  await check('local-http-adapter-scope', async () => {
    const adapter = new HttpTaskRetrievalPort({ endpoint: endpoint.origin, bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN });
    await assert.rejects(adapter.search({ ...request, scopes: [{ ...scopes[0]!, analysisRevision: scopes[1]!.analysisRevision }] }, AbortSignal.timeout(10000)),
      /Local task retrieval failed with status 400/);
    for (const invalidEndpoint of ['https://127.0.0.1:4041', 'http://localhost:4041', `${endpoint.origin}/unexpected-path`]) {
      assert.throws(() => new HttpTaskRetrievalPort({ endpoint: invalidEndpoint }), /Task retrieval requires an existing HTTP host/);
    }
    return { foreignRevisionHttpStatus: 400, strictLoopbackConstructor: true, realHostRequest: true };
  });
  assert.deepEqual(protocolErrors, [], 'MCP stdout contained invalid protocol output.');
  assert(stderrText.includes('ForeXplore semantic-index MCP server is running on stdio.'), 'The ready log was not emitted on stderr.');
  report.stdoutProtocolErrors = protocolErrors.length;
  report.readyLogOnStderr = true;
  report.clientQuietOverride = false;
  report.passed = checks.every((entry) => entry.passed === true);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(report.error);
} finally {
  try {
    await client.close();
    await transport.close();
    if (serverPid !== null) {
      assert.throws(() => process.kill(serverPid!, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', 'The MCP server process is still running.');
    }
    report.clientClosed = true;
    report.serverProcessExited = serverPid !== null;
  } catch (error) {
    report.passed = false;
    report.shutdownError = error instanceof Error ? error.message : String(error);
  }
  report.stderrBytes = stderrBytes;
  report.finishedAt = new Date().toISOString();
  report.interpretation = 'Live MCP integration and exact output budgeting only; this does not establish large-repository latency or no-match accuracy.';
  await mkdir(outputDirectory, { recursive: true });
  const reportPath = path.join(outputDirectory, 'task-context-mcp.json');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, json);
  await writeFile(path.join(outputDirectory, `task-context-mcp-${startedAt.replace(/[:.]/g, '-')}.json`), json);
  console.info(`Report: ${reportPath}`);
  if (!report.passed) process.exitCode = 1;
}
