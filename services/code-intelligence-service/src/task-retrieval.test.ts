import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import type { ProjectModuleProposal, TaskRetrievalRequest } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash } from './index.js';
import { TaskRetrievalService } from './task-retrieval.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const source = `${'// retained context\n'.repeat(800)}export interface PaymentResult { accepted: boolean; }
export function issueReceipt(value: number): PaymentResult { return { accepted: value > 0 }; }
export function submitPayment(value: number): PaymentResult { return issueReceipt(value); }
export class PaymentService { submitPayment(value: number) { return submitPayment(value); } }
`;

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'task-retrieval-')); roots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"name":"payment","version":"1.0.0"}');
  await writeFile(path.join(root, 'payment.ts'), source);
  await writeFile(path.join(root, 'support.ts'), 'export function supportReceipt() { return true; }\n');
  await mkdir(path.join(root, 'other'));
  await writeFile(path.join(root, 'other/package.json'), '{"name":"other"}');
  await writeFile(path.join(root, 'other/other.ts'), 'export function unrelatedFeature() { return "other project"; }');
  const store = new InMemoryIndexStore();
  const runtime = await createCodeIntelligenceRuntime({ store });
  await runtime.registry.register({ repositoryId: 'target', localPath: root, role: 'target', displayName: 'Payment' });
  const run = await runtime.coordinator.run({ repositoryId: 'target' });
  const index = (await store.getStructuralIndex(run.scope))!;
  const project = index.projects.find((item) => item.relativePath === '')!;
  const scope = { ...run.scope, projectId: project.projectId, role: 'target' as const };
  const service = new TaskRetrievalService(store);
  const request: TaskRetrievalRequest = { requestId: 'req-1', requirement: 'submitPayment', scopes: [scope], granularity: 'function', budget: { maxTokens: 4000, maxLatencyMs: 30000 } };
  return { root, runtime, store, service, request, scope, index };
}

async function installHierarchy(context: Awaited<ReturnType<typeof setup>>) {
  const { store, scope, index } = context;
  const sourceFiles = index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath);
  const implementationFiles = sourceFiles.filter((file) => !['package.json', 'support.ts'].includes(file));
  const metrics = (paths: string[]) => ({ fileCount: paths.length,
    sourceBytes: index.files.filter((file) => paths.includes(file.relativePath)).reduce((sum, file) => sum + file.sizeBytes, 0),
    symbolCount: index.symbols.filter((symbol) => paths.includes(symbol.relativePath)).length });
  const base = { kind: 'feature', description: 'Submit payments and issue receipts', symbolKeys: [], dependsOn: [], evidenceIds: [`project:${scope.projectId}`], coreApis: ['submitPayment'] };
  const proposal: ProjectModuleProposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Payment hierarchy',
    modules: [
      { ...base, id: 'root-module', name: 'Payment root module', nodeKind: 'module', parentId: null, sourceFiles: [], metrics: metrics(sourceFiles), refinement: { state: 'split', reason: 'Payment subsystem boundary', decisionSource: 'structural' } },
      { ...base, id: 'subsystem', name: 'Payment subsystem', nodeKind: 'subsystem', parentId: 'root-module', sourceFiles: [], metrics: metrics([...implementationFiles, 'support.ts']), refinement: { state: 'split', reason: 'Implementation boundary', decisionSource: 'structural' } },
      { ...base, id: 'configuration', name: 'Payment configuration', nodeKind: 'module', parentId: 'root-module', sourceFiles: ['package.json'], metrics: metrics(['package.json']), refinement: { state: 'leaf', reason: 'Build configuration', decisionSource: 'structural' } },
      { ...base, id: 'implementation', name: 'Payment implementation', nodeKind: 'module', parentId: 'subsystem', sourceFiles: implementationFiles, metrics: metrics(implementationFiles), refinement: { state: 'leaf', reason: 'Cohesive implementation', decisionSource: 'structural' } },
      { ...base, id: 'support', name: 'Receipt support', nodeKind: 'module', parentId: 'subsystem', sourceFiles: ['support.ts'], metrics: metrics(['support.ts']), refinement: { state: 'leaf', reason: 'Receipt support', decisionSource: 'structural' } },
    ], hierarchy: { version: 1, algorithm: 'adaptive-module-tree/v1', maxDepth: 3, decisionCount: 5, modelDecisionCount: 0, deferredCount: 0 } };
  const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => ({ proposal,
    evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } }) });
  await analysis.ensure(scope);
  const ready = await analysis.read(scope);
  expect(ready.state, ready.error).toBe('ready');
  return proposal;
}

describe('task retrieval and context compilation', () => {
  it('returns actual late-file implementations and dependencies without full index reads', async () => {
    const { store, service, request } = await setup();
    for (const method of ['getStructuralIndex', 'listSymbols', 'listFiles', 'listDependencyEdges', 'listSearchDocuments', 'listModuleArtifacts'] as const) {
      vi.spyOn(store, method).mockRejectedValue(new Error(`Unbounded read: ${method}`));
    }
    const packet = await service.search(request);
    expect(packet.results.length).toBeGreaterThan(0);
    expect(packet.results.every((item) => item.granularity === 'function')).toBe(true);
    expect(packet.routing).toMatchObject({ source: 'user', requestedGranularity: 'function', resolvedGranularities: ['function'] });
    expect(packet.evidence.some((item) => item.content.includes('return issueReceipt(value)') && item.sourceRange.startLine > 800)).toBe(true);
    expect(packet.evidence.some((item) => item.role === 'configuration' && item.relativePath === 'package.json')).toBe(true);
    expect(packet.relations.length).toBeGreaterThan(0);
    const stages = packet.usage.retrieval!.stages!;
    expect(Object.values(stages).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(Object.values(stages).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(packet.usage.latencyMs + 2);
    expect(packet.usage.tokens).toBe(getEncoding('cl100k_base').encode(packet.markdown, [], []).length);
    expect(packet.usage.tokens).toBeLessThanOrEqual(request.budget.maxTokens);
    for (const item of packet.evidence) expect(item.contentHash).toBe(createHash('sha256').update(item.content).digest('hex'));
  });

  it('filters primary results by the selected project even when another project ranks first', async () => {
    const { service, request } = await setup();
    const packet = await service.search({ ...request, requirement: 'unrelatedFeature' });
    expect(packet.results).toEqual([]);
    expect(packet.evidence).toEqual([]);
    expect(packet.routing.resolvedGranularities).toEqual(['function']);
  });

  it('honors manual class selection and does not substitute a function', async () => {
    const { service, request } = await setup();
    const packet = await service.search({ ...request, granularity: 'class', requirement: 'PaymentService' });
    expect(packet.results.length).toBeGreaterThan(0);
    expect(packet.results.every((item) => item.granularity === 'class')).toBe(true);
    expect(packet.routing).not.toHaveProperty('confidence');
  });

  it('reports an unavailable subsystem granularity without substituting primary results', async () => {
    const { store, service, request } = await setup();
    const search = vi.spyOn(store, 'searchSearchDocuments');
    const packet = await service.search({ ...request, granularity: 'subsystem' });
    expect(packet.status).toBe('unavailable');
    expect(packet.routing.resolvedGranularities).toEqual([]);
    expect(packet.results).toEqual([]);
    expect(search).toHaveBeenCalled();
  });

  it('rejects invalid granularity and cancelled queries before reading data', async () => {
    const { store, service, request } = await setup();
    const read = vi.spyOn(store, 'getRepository');
    await expect(service.search({ ...request, granularity: ['function'] } as unknown as TaskRetrievalRequest)).rejects.toThrow('granularity');
    await expect(service.search(request, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps a pinned revision when the active pointer changes during reading', async () => {
    const { store, service, request } = await setup();
    const read = store.getSourceSlice.bind(store);
    vi.spyOn(store, 'getSourceSlice').mockImplementation(async (...args) => {
      const repository = (await store.getRepository('target'))!;
      await store.putRepository({ ...repository, activeRevision: 'another-revision' });
      return read(...args);
    });
    const packet = await service.search(request);
    expect(packet.evidence.length).toBeGreaterThan(0);
    expect(packet.evidence.every((item) => item.analysisRevision === request.scopes[0]!.analysisRevision)).toBe(true);
  });

  it('does not apply a literal query filter to projection-recalled symbols', async () => {
    const { store, service, request, index } = await setup();
    const symbol = index.symbols.find((item) => item.name === 'submitPayment' && item.kind === 'function')!;
    const documents = await store.listSearchDocuments(request.scopes[0]!);
    const document = documents.find((item) => item.kind === 'symbol' && item.symbolKey === symbol.symbolKey)!;
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'symbol' ? [{ ...document, retrievalScore: { semantic: 0.9, fusion: 1 / 61 } }] : []);
    const packet = await service.search({ ...request, requirement: '提交支付并生成收据' });
    expect(packet.results.some((item) => item.symbolKey === symbol.symbolKey)).toBe(true);
  });

  it('reads the matched tail block of a long function and marks the partial implementation', async () => {
    const { root, runtime, store, service, request, scope } = await setup();
    await writeFile(path.join(root, 'payment.ts'), `export function longImplementation(value: number) {\n${'  value += 1;\n'.repeat(1500)}  return "TAIL_PROOF";\n}\n`);
    const run = await runtime.coordinator.run({ repositoryId: scope.repositoryId });
    const documents = await store.listSearchDocuments(run.scope);
    const document = documents.find((item) => item.kind === 'source-fragment' && item.symbolKey && item.text.includes('TAIL_PROOF'))!;
    expect(document?.sourceRange).toBeDefined();
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'source-fragment' ? [document] : []);
    const packet = await service.search({ ...request, requirement: 'TAIL_PROOF', scopes: [{ ...scope, ...run.scope }], budget: { maxTokens: 5000, maxLatencyMs: 30000 } });
    expect(packet.evidence.some((item) => item.content.includes('TAIL_PROOF') && item.sourceRange.startLine > 1)).toBe(true);
    expect(packet.gaps.some((gap) => gap.code === 'IMPLEMENTATION_EXCERPT')).toBe(true);
  });

  it('preserves an exact recalled implementation despite hundreds of same-file declarations', async () => {
    const { root, runtime, store, service, request, scope } = await setup();
    await writeFile(path.join(root, 'payment.ts'), `${Array.from({ length: 220 }, (_, i) => `export function noise${i}() { return ${i}; }`).join('\n')}\nexport function enforceUploadSize(size: number, sizeMax: number, fileSizeMax: number) { return size <= sizeMax && size <= fileSizeMax; }\n`);
    const run = await runtime.coordinator.run({ repositoryId: scope.repositoryId });
    const documents = await store.listSearchDocuments(run.scope);
    const document = documents.find((item) => item.kind === 'source-fragment' && item.title.includes('enforceUploadSize'))!;
    expect(document.symbolKey).toBeDefined();
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'source-fragment' ? [document] : []);
    const query = vi.spyOn(store, 'querySymbols');
    const packet = await service.search({ ...request, requirement: '检查总请求和单个文件的大小限制', scopes: [{ ...scope, ...run.scope }] });
    expect(packet.results.some((item) => item.name === 'enforceUploadSize')).toBe(true);
    expect(packet.evidence.some((item) => item.content.includes('size <= sizeMax && size <= fileSizeMax'))).toBe(true);
    expect(query.mock.calls.some(([, filter]) => filter.symbolKeys?.includes(document.symbolKey!) && !filter.relativePaths)).toBe(true);
  });

  it('does not give every declaration the score of an unrelated file block', async () => {
    const { store, service, request, index } = await setup();
    const symbol = index.symbols.find((item) => item.name === 'issueReceipt')!;
    const documents = await store.listSearchDocuments(request.scopes[0]!);
    const document = documents.find((item) => item.kind === 'source-fragment' && item.symbolKey === symbol.symbolKey)!;
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'source-fragment' ? [{ ...document, symbolKey: undefined }] : []);
    const packet = await service.search({ ...request, requirement: '收据处理' });
    expect(packet.results.map((item) => item.name)).toEqual(['issueReceipt']);
  });

  it('promotes a recalled local variable to its function and preserves that implementation among class hits', async () => {
    const { root, runtime, store, service, request, scope } = await setup();
    await writeFile(path.join(root, 'payment.ts'), `${Array.from({ length: 12 }, (_, i) => `export class Related${i} { value = ${i}; }`).join('\n')}
export function enforceUploadSize(size: number) {
  const requestSize = size;
  const sizeMax = 100;
  const fileSizeMax = 50;
  if (requestSize > sizeMax || requestSize > fileSizeMax) throw new Error('exceeded');
  return requestSize;
}
`);
    const run = await runtime.coordinator.run({ repositoryId: scope.repositoryId });
    const documents = await store.listSearchDocuments(run.scope);
    const local = documents.find((item) => item.kind === 'symbol' && item.title.endsWith('requestSize'))!;
    expect(local).toBeDefined();
    const classes = documents.filter((item) => item.kind === 'symbol' && /^Related\d+$/.test(item.title));
    expect(classes).toHaveLength(12);
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'symbol'
      ? [{ ...local, retrievalScore: { semantic: 0.9, fusion: 1 / 61 } }]
      : kind === 'source-fragment' ? classes.map((item) => ({ ...item, kind: 'source-fragment' as const, retrievalScore: { lexical: 12, semantic: 0.9, fusion: 2 / 61 } })) : []);
    const packet = await service.search({ ...request, granularity: 'auto', requirement: '检查上传文件大小限制', scopes: [{ ...scope, ...run.scope }] });
    expect(packet.results.some((item) => item.name === 'enforceUploadSize' && item.granularity === 'function')).toBe(true);
    expect(packet.results.some((item) => item.granularity === 'class')).toBe(true);
    expect(packet.evidence.some((item) => item.name === 'enforceUploadSize' && item.content.includes('requestSize > sizeMax || requestSize > fileSizeMax'))).toBe(true);
    expect(packet.usage.tokens).toBeLessThanOrEqual(request.budget.maxTokens);
  });

  it('returns validated current-project modules and marks incomplete module context', async () => {
    const { store, service, request, scope, index } = await setup();
    const analysis = new ProjectAnalysisCoordinator({ store, plan: async () => {
      const files = index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath);
      const proposal = { ...scope, analysisHash: index.analysisHash, objective: projectAnalysisObjective, summary: 'Payment processing', modules: [{
        id: 'payments', name: 'Payment processing', kind: 'feature', description: 'submitPayment and issueReceipt', sourceFiles: files, symbolKeys: [], coreApis: ['submitPayment'], dependsOn: [], evidenceIds: [`project:${scope.projectId}`],
      }] };
      return { proposal, evidence: { ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds: [`project:${scope.projectId}`] } };
    } });
    await analysis.ensure(scope);
    const packet = await service.search({ ...request, granularity: 'module' });
    expect(packet.results).toHaveLength(1);
    expect(packet.results[0]).toMatchObject({ moduleId: 'payments', granularity: 'module' });
    expect(packet.evidence.length).toBeGreaterThan(0);
  });

  it('retrieves subsystem descendants even when only a leaf summary was recalled', async () => {
    const context = await setup();
    const { store, service, request, scope } = context;
    const proposal = await installHierarchy(context);
    const before = projectPlanHash(proposal);
    const documents = await store.listSearchDocuments(scope);
    const leaf = documents.find((document) => document.kind === 'summary' && JSON.parse(document.text).moduleId === 'implementation')!;
    const requestedSymbol = context.index.symbols.find(symbol => symbol.kind === 'function' && symbol.name === 'submitPayment')!;
    const implementation = documents.find((document) => document.kind === 'source-fragment' && document.symbolKey === requestedSymbol.symbolKey)!;
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'summary' ? [leaf] : kind === 'source-fragment' ? [implementation] : []);
    for (const method of ['getStructuralIndex', 'listSearchDocuments', 'listModuleArtifacts', 'listSymbols', 'listFiles'] as const) vi.spyOn(store, method).mockRejectedValue(new Error('Unbounded read'));
    const dependencies = vi.spyOn(store, 'queryDependencies');
    const packet = await service.search({ ...request, granularity: 'subsystem' });
    expect(packet.routing.resolvedGranularities).toEqual(['subsystem']);
    expect(packet.results).toHaveLength(1);
    expect(packet.results[0]).toMatchObject({ moduleId: 'subsystem', granularity: 'subsystem', reason: expect.stringContaining('descendant summary') });
    expect(packet.evidence.some((item) => item.content.includes('return issueReceipt(value)'))).toBe(true);
    expect(dependencies.mock.calls.every(([, filter]) => Boolean(filter.relativePaths?.length) && filter.relativePaths!.length <= 20)).toBe(true);
    expect(packet.evidence.every((item) => !item.relativePath.startsWith('other/'))).toBe(true);
    expect(projectPlanHash(proposal)).toBe(before);
    expect(packet.usage.tokens).toBe(getEncoding('cl100k_base').encode(packet.markdown, [], []).length);
    expect(packet.usage.tokens).toBeLessThanOrEqual(4000);
  });

  it('uses node kind independently of depth and deduplicates parent and leaf source', async () => {
    const context = await setup();
    await installHierarchy(context);
    const packet = await context.service.search({ ...context.request, granularity: 'module' });
    expect(packet.results.map((result) => result.moduleId)).toEqual(expect.arrayContaining(['implementation', 'root-module']));
    expect(packet.results.every((result) => result.granularity === 'module')).toBe(true);
    expect(new Set(packet.evidence.map((item) => `${item.repositoryId}:${item.relativePath}:${item.contentHash}`)).size).toBe(packet.evidence.length);
    expect(packet.gaps.some((gap) => gap.code === 'GRANULARITY_UNAVAILABLE')).toBe(false);
  });

  it('distinguishes an available hierarchy with no recalled candidates from absent granularity', async () => {
    const context = await setup();
    await installHierarchy(context);
    vi.spyOn(context.store, 'searchSearchDocuments').mockResolvedValue([]);
    const packet = await context.service.search({ ...context.request, granularity: 'subsystem' });
    expect(packet.status).toBe('partial');
    expect(packet.routing.resolvedGranularities).toEqual(['subsystem']);
    expect(packet.results).toEqual([]);
    expect(packet.gaps.map((gap) => gap.code)).toContain('NO_MODULE_CANDIDATE');
  });

  it('does not reuse summary recall from a different hierarchy plan hash', async () => {
    const context = await setup();
    await installHierarchy(context);
    const documents = (await context.store.listSearchDocuments(context.scope)).filter((document) => document.kind === 'summary');
    vi.spyOn(context.store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'summary'
      ? documents.map((document) => ({ ...document, text: JSON.stringify({ ...JSON.parse(document.text), planHash: 'sha256:another-plan' }) })) : []);
    const packet = await context.service.search({ ...context.request, granularity: 'subsystem' });
    expect(packet.results).toEqual([]);
    expect(packet.gaps.map((gap) => gap.code)).toContain('NO_MODULE_CANDIDATE');
  });

  it('does not fill a manual module result quota with same-kind ancestors of one recalled leaf', async () => {
    const context = await setup();
    await installHierarchy(context);
    const summary = (await context.store.listSearchDocuments(context.scope)).find((document) => document.kind === 'summary' && JSON.parse(document.text).moduleId === 'implementation')!;
    vi.spyOn(context.store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'summary' ? [summary] : []);
    const packet = await context.service.search({ ...context.request, granularity: 'module' });
    expect(packet.results.map((result) => result.moduleId)).toEqual(['implementation']);
  });

  it('prioritizes a recalled descendant beyond the first twenty files without unbounded reads', async () => {
    const context = await setup();
    for (let i = 0; i < 25; i++) await writeFile(path.join(context.root, `branch${String(i).padStart(2, '0')}.ts`), `export function branch${i}() { return ${i}; }\n`);
    await writeFile(path.join(context.root, 'z-matched.ts'), 'export function matchedTail() { return "DESCENDANT_PROOF"; }\n');
    const run = await context.runtime.coordinator.run({ repositoryId: context.scope.repositoryId });
    const index = (await context.store.getStructuralIndex(run.scope))!;
    const scope = { ...context.scope, ...run.scope };
    const updated = { ...context, index, scope, request: { ...context.request, scopes: [scope] } };
    await installHierarchy(updated);
    const documents = await context.store.listSearchDocuments(scope);
    const summary = documents.find((document) => document.kind === 'summary' && JSON.parse(document.text).moduleId === 'subsystem')!;
    const source = documents.find((document) => document.kind === 'source-fragment' && document.relativePath === 'z-matched.ts' && document.symbolKey)!;
    vi.spyOn(context.store, 'searchSearchDocuments').mockImplementation(async (_scope, _query, _limit, kind) => kind === 'summary' ? [summary] : kind === 'source-fragment' ? [source] : []);
    const read = vi.spyOn(context.store, 'querySymbols');
    const deps = vi.spyOn(context.store, 'queryDependencies');
    const packet = await context.service.search({ ...updated.request, requirement: 'DESCENDANT_PROOF', granularity: 'subsystem' });
    expect(packet.evidence.some((item) => item.content.includes('DESCENDANT_PROOF'))).toBe(true);
    expect(packet.gaps.map((gap) => gap.code)).toContain('MODULE_CONTEXT_PARTIAL');
    expect(read.mock.calls.filter(([, filter]) => filter.relativePaths).every(([, filter]) => filter.relativePaths!.length <= 20)).toBe(true);
    expect(deps.mock.calls.some(([, filter]) => filter.relativePaths?.includes('z-matched.ts'))).toBe(true);
  });

  it('reports retired module projections as unavailable while historical function evidence remains readable', async () => {
    const { root, runtime, service, request } = await setup();
    await writeFile(path.join(root, 'payment.ts'), `${source}\nexport function newVersion() { return 1; }\n`);
    await runtime.coordinator.run({ repositoryId: request.scopes[0]!.repositoryId });
    const historical = await service.search({ ...request, granularity: 'module' });
    expect(historical.status).toBe('unavailable');
    expect(historical.routing.resolvedGranularities).toEqual([]);
    expect(historical.gaps.some((gap) => gap.code === 'MODULE_PROJECTION_UNAVAILABLE')).toBe(true);
    const functions = await service.search(request);
    expect(functions.results.some((result) => result.name.includes('submitPayment'))).toBe(true);
    expect(functions.evidence.every((item) => item.analysisRevision === request.scopes[0]!.analysisRevision)).toBe(true);
  });

  it('omits known unchanged excerpts and budgets every serialized token', async () => {
    const { service, request } = await setup();
    const first = await service.search(request);
    const packet = await service.search({ ...request, knownEvidence: first.evidence.map(({ evidenceId, contentHash }) => ({ evidenceId, contentHash })) });
    expect(packet.evidence).toEqual([]);
    expect(packet.usage.tokens).toBeLessThan(first.usage.tokens);
    const small = await service.search({ ...request, budget: { ...request.budget, maxTokens: 1500, maxSourceLines: 1 } });
    expect(small.usage.tokens).toBeLessThanOrEqual(1500);
    expect(small.gaps.some((gap) => gap.code === 'CONTEXT_BUDGET_EXCEEDED')).toBe(true);
  });
});
