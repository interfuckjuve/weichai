import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import mysql from 'mysql2/promise';
import { getEncoding } from 'js-tiktoken';
import { indexModuleHierarchy, type ContextPacket, type ProjectAnalysisRecord, type ProjectModule, type TaskRetrievalRequest, type TaskRetrievalScope } from '@forexplore/contracts';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { projectAnalysisProfile, projectPlanHash } from '../services/code-intelligence-service/src/project-analysis.js';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:4042' },
  database: { type: 'string', default: 'forexplore_task_scale_20260908' },
  repository: { type: 'string', default: 'vscode-scale' },
  revision: { type: 'string', default: 'scale-1788853146362' },
  project: { type: 'string', default: 'project-1133a0288d95fd93d6132ebf' },
  'source-root': { type: 'string' }, 'subsystem-id': { type: 'string' }, 'module-id': { type: 'string' },
  'max-tokens': { type: 'string', default: '4000' }, 'output-dir': { type: 'string', default: 'logs' },
} });
const endpoint = new URL(values.endpoint!);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Verification requires the local HTTP service.');
assert(/^[a-zA-Z0-9_]+$/.test(values.database!), 'Invalid database identifier.');
const maxTokens = Number(values['max-tokens']);
assert(Number.isInteger(maxTokens) && maxTokens >= 1000 && maxTokens <= 32000);
const legacy = parseEnv(await readFile('services/retrieval-service/.env', 'utf8'));
const config = { host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? legacy.SEEKDB_HOST ?? '127.0.0.1',
  port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? legacy.SEEKDB_PORT ?? 2881),
  user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? legacy.SEEKDB_USER ?? 'root',
  password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? legacy.SEEKDB_PASSWORD ?? '', database: values.database!, vectorDimension: 64 };
assert(['127.0.0.1', 'localhost', '::1'].includes(config.host), 'Verification requires the local index database.');
const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database, connectionLimit: 2, connectTimeout: 10000 });
const store = new SeekDbIndexStore(config, pool);
const scope: TaskRetrievalScope = { repositoryId: values.repository!, analysisRevision: values.revision!, projectId: values.project!, role: 'target' };
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = { startedAt, endpoint: endpoint.origin, database: config.database, scope,
  mode: 'Read-only persisted hierarchy and real HTTP retrieval; no provider mocks or model construction calls', cases: [], passed: false };
const cases = report.cases as Array<Record<string, unknown>>;
const output = path.resolve(values['output-dir']!);
const tokenizer = getEncoding('cl100k_base');
let representative: ContextPacket | undefined;

async function main() {
  const health = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(10000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { status: string }).status, 'ready', 'The workbench has not finished construction.');
  const [repository, revision, project, artifacts] = await Promise.all([
    store.getRepository(scope.repositoryId), store.getRevision(scope), store.getProject(scope, scope.projectId!),
    store.getModuleArtifacts(scope, [`project-summary:${scope.projectId}:${projectAnalysisProfile}`]),
  ]);
  assert(repository && revision && project, 'The requested fixed repository/revision/project is absent.');
  assert.equal(revision.status, 'ready', 'Summary projections require the currently published revision.');
  const artifact = artifacts[0];
  assert(artifact?.kind === 'module-summary' && artifact.status === 'current');
  const record = artifact.payload as ProjectAnalysisRecord;
  assert.equal(record.state, 'ready');
  assert(record.proposal?.hierarchy, 'This is still a flat proposal; rebuild the selected project before running hierarchy acceptance.');
  assert.equal(record.proposal.hierarchy.algorithm, 'adaptive-module-tree/v1');
  assert.equal(record.repositoryId, scope.repositoryId);
  assert.equal(record.analysisRevision, scope.analysisRevision);
  assert.equal(record.projectId, scope.projectId);
  assert.equal(artifact.analysisHash, revision.analysisHash);
  assert.equal(record.proposal.analysisHash, revision.analysisHash);
  assert.equal(projectPlanHash(record.proposal), artifact.planHash, 'The persisted raw proposal hash is invalid.');
  const tree = indexModuleHierarchy(record.proposal.modules);
  const owned = record.proposal.modules.flatMap((node) => node.sourceFiles);
  assert.equal(new Set(owned).size, owned.length, 'Source ownership is duplicated across nodes.');
  for (const node of record.proposal.modules) if (tree.childrenById.get(node.id)!.length) {
    assert.deepEqual(node.sourceFiles, [], 'Parents must aggregate descendants without direct file ownership.');
    assert.deepEqual(node.symbolKeys, [], 'Parents must not duplicate leaf symbols.');
  }
  const [fileCount] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM files WHERE repository_id = ? AND analysis_revision = ? AND project_id = ?',
    [scope.repositoryId, scope.analysisRevision, scope.projectId]);
  assert.equal(owned.length + (record.proposal.unassignedFiles?.length ?? 0), Number(fileCount[0]!.count), 'Hierarchy coverage does not match indexed project files.');
  const [documents] = await pool.query<mysql.RowDataPacket[]>('SELECT search_document_id, document_text FROM search_documents WHERE repository_id = ? AND analysis_revision = ? AND kind = ? AND module_artifact_id = ? LIMIT 10000',
    [scope.repositoryId, scope.analysisRevision, 'summary', artifact.moduleArtifactId]);
  assert(documents.length < 10000, 'Projection validation reached its explicit row bound.');
  assert.equal(documents.length, record.proposal.modules.length * 3, 'Every parent and leaf requires all three summary views.');
  const projected = new Map<string, Set<string>>();
  for (const document of documents) {
    const identity = JSON.parse(String(document.document_text));
    const node = tree.byId.get(identity.moduleId);
    assert(node, 'Projection references an absent hierarchy node.');
    assert.equal(identity.projectId, scope.projectId);
    assert.equal(identity.planHash, artifact.planHash);
    assert.equal(identity.nodeKind, node.nodeKind ?? 'module');
    assert.equal(identity.parentId, node.parentId ?? null);
    assert.equal(identity.depth, tree.depthById.get(node.id));
    const views = projected.get(node.id) ?? new Set<string>();
    views.add(identity.view ?? 'summary'); projected.set(node.id, views);
  }
  assert([...projected.values()].every((views) => views.size === 3));
  const choose = (kind: 'module' | 'subsystem', explicit?: string): ProjectModule | undefined => {
    if (explicit) {
      const node = tree.byId.get(explicit);
      assert(node && (node.nodeKind ?? 'module') === kind, `Requested ${kind} node does not exist.`);
      return node;
    }
    const nodes = record.proposal!.modules.filter((node) => (node.nodeKind ?? 'module') === kind && tree.sourceFiles(node.id, 1).files.length > 0);
    nodes.sort((a, b) => Number(tree.childrenById.get(b.id)!.length > 0) - Number(tree.childrenById.get(a.id)!.length > 0)
      || tree.depthById.get(b.id)! - tree.depthById.get(a.id)! || a.id.localeCompare(b.id));
    return nodes[0];
  };
  const subsystem = choose('subsystem', values['subsystem-id']);
  const module = choose('module', values['module-id']);
  assert(module, 'The persisted hierarchy contains no module node.');
  const parent = subsystem && tree.childrenById.get(subsystem.id)!.length ? subsystem : module;
  assert(tree.childrenById.get(parent.id)!.length > 0, 'Hierarchy acceptance must exercise a real parent with descendants.');
  const root = await realpath(values['source-root'] ?? repository.localPath);
  const cached = new Map<string, { text: string; hash: string }>();
  async function verifyPacket(packet: ContextPacket, request: TaskRetrievalRequest) {
    assert.equal(packet.requestId, request.requestId);
    assert.equal(packet.routing.requestedGranularity, request.granularity);
    assert.equal(packet.snapshots.length, 1);
    assert.equal(packet.snapshots[0]!.repositoryId, scope.repositoryId);
    assert.equal(packet.snapshots[0]!.analysisRevision, scope.analysisRevision);
    assert.equal(packet.snapshots[0]!.analysisHash, revision!.analysisHash);
    assert.equal(packet.snapshots[0]!.projectId, scope.projectId);
    assert.equal(packet.usage.tokens, tokenizer.encode(packet.markdown, [], []).length);
    assert(packet.usage.tokens <= maxTokens);
    if (request.granularity === 'subsystem' && !subsystem) {
      assert.equal(packet.status, 'unavailable');
      assert.deepEqual(packet.routing.resolvedGranularities, []);
      assert.deepEqual(packet.results, []); assert.deepEqual(packet.evidence, []);
      assert(packet.gaps.some((gap) => gap.code === 'GRANULARITY_UNAVAILABLE'));
      return;
    }
    const primaryFiles = new Set(packet.results.flatMap((result) => result.moduleId ? tree.sourceFiles(result.moduleId).files : result.relativePath ? [result.relativePath] : []));
    assert.equal(new Set(packet.evidence.map((item) => item.evidenceId)).size, packet.evidence.length);
    const ranges = new Set<string>();
    for (const result of packet.results) {
      assert.equal(result.repositoryId, scope.repositoryId); assert.equal(result.analysisRevision, scope.analysisRevision); assert.equal(result.projectId, scope.projectId);
      if (result.moduleId) assert.equal(result.granularity, tree.byId.get(result.moduleId)!.nodeKind ?? 'module');
    }
    for (const item of packet.evidence) {
      assert.equal(item.repositoryId, scope.repositoryId); assert.equal(item.analysisRevision, scope.analysisRevision);
      assert(!path.isAbsolute(item.relativePath) && !item.relativePath.split('/').includes('..'));
      const filename = path.resolve(root, item.relativePath);
      assert(filename.startsWith(`${root}${path.sep}`));
      if (!cached.has(filename)) { const bytes = await readFile(filename); cached.set(filename, { text: bytes.toString('utf8'), hash: createHash('sha256').update(bytes).digest('hex') }); }
      const file = cached.get(filename)!;
      assert.equal(item.fileHash, file.hash);
      assert.equal(item.contentHash, createHash('sha256').update(item.content).digest('hex'));
      const offsets = [0];
      for (let i = 0; i < file.text.length; i++) if (file.text[i] === '\n') offsets.push(i + 1);
      const position = (line: number, column: number) => {
        assert(Number.isInteger(line) && line >= 1 && Number.isInteger(column) && column >= 1 && offsets[line - 1] !== undefined);
        const value = offsets[line - 1]! + column - 1;
        assert(value <= (offsets[line] === undefined ? file.text.length : offsets[line]! - 1));
        return value;
      };
      const range = item.sourceRange;
      const from = position(range.startLine, range.startColumn), to = position(range.endLine, range.endColumn);
      assert(to > from); assert.equal(item.content, file.text.slice(from, to));
      const key = JSON.stringify([item.relativePath, range]);
      assert(!ranges.has(key), 'Parent and leaf results duplicated an identical source range.'); ranges.add(key);
      if (item.role === 'implementation') assert(primaryFiles.has(item.relativePath), 'Implementation escaped the selected result subtrees.');
    }
    assert(packet.evidence.some((item) => item.role === 'implementation'), 'Context budget retained no primary implementation.');
  }
  report.hierarchy = { ...record.proposal.hierarchy, nodes: tree.byId.size, roots: tree.roots.length, leafFiles: owned.length,
    subsystemNodes: record.proposal.modules.filter((node) => node.nodeKind === 'subsystem').length, projectedViews: documents.length,
    planHash: artifact.planHash, modeling: record.modeling,
    modelBoundaryDecisions: record.proposal.modules.filter((node) => node.refinement?.decisionSource === 'model').length };
  report.subsystemExpectation = subsystem ? 'Real persisted subsystem node must return descendant source' : 'No subsystem node exists; explicit unavailable is required';
  for (const [granularity, node] of [['subsystem', subsystem ?? module], ['module', module], ['auto', parent]] as const) {
    const request: TaskRetrievalRequest = { requestId: `hierarchy-${randomUUID()}`, requirement: `${node.name}\n${(node.coreApis ?? []).slice(0, 2).join('\n')}`.trim(),
      granularity, scopes: [scope], budget: { maxTokens, maxLatencyMs: 60000, maxFiles: 12, maxSourceLines: 1000 } };
    const entry: Record<string, unknown> = { granularity, requestedNode: { id: node.id, name: node.name, depth: tree.depthById.get(node.id) }, request, passed: false };
    cases.push(entry);
    const started = performance.now();
    try {
      const response = await fetch(new URL('/v1/task-search', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(65000) });
      const text = await response.text();
      assert.equal(response.status, 200, `Task HTTP ${response.status}: ${text.slice(0, 600)}`);
      const packet = JSON.parse(text) as ContextPacket;
      Object.assign(entry, { durationMs: Math.round(performance.now() - started), status: packet.status, routing: packet.routing, usage: packet.usage,
        results: packet.results, gaps: packet.gaps, evidenceCount: packet.evidence.length, relationCount: packet.relations.length });
      await verifyPacket(packet, request);
      if (granularity !== 'auto' && !(granularity === 'subsystem' && !subsystem)) {
        assert.deepEqual(packet.routing.resolvedGranularities, [granularity]);
        assert.equal(packet.routing.source, 'user'); assert(!Object.hasOwn(packet.routing, 'confidence'));
        assert(packet.results.every((result) => result.granularity === granularity));
        assert(packet.results.some((result) => result.moduleId === node.id), 'Named node was absent from bounded recall.');
      }
      if (granularity !== 'auto' && node.id === parent.id && !(granularity === 'subsystem' && !subsystem)) {
        const descendants = new Set(tree.sourceFiles(node.id).files);
        assert(packet.evidence.some((item) => item.role === 'implementation' && descendants.has(item.relativePath)), 'Parent result has no actual descendant implementation.');
        representative = packet;
      }
      entry.passed = true;
      console.info(JSON.stringify({ granularity, passed: true, durationMs: entry.durationMs, usage: packet.usage }));
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); console.error(JSON.stringify(entry)); }
  }
  assert(cases.every((entry) => entry.passed), 'One or more real hierarchy retrieval cases failed.');
  report.passed = true;
}

try { await main(); }
catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await pool.end();
  report.completedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  const timestamp = startedAt.replace(/[:.]/g, '-');
  const json = JSON.stringify(report, null, 2);
  await writeFile(path.join(output, `adaptive-hierarchy-retrieval-${timestamp}.json`), json);
  await writeFile(path.join(output, 'adaptive-hierarchy-retrieval.json'), json);
  if (representative) await writeFile(path.join(output, 'adaptive-hierarchy-context.md'), representative.markdown);
  console.info(JSON.stringify({ passed: report.passed, report: path.join(output, 'adaptive-hierarchy-retrieval.json'), error: report.error }));
}
