import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import mysql from 'mysql2/promise';
import type { AnalysisRevisionRecord, ModuleArtifactRecord, ProjectAnalysisRecord, RepositoryRecord, StructuralIndex } from '@forexplore/contracts';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { SeekDbProjection } from '../services/code-intelligence-service/src/seekdb-projection.js';
import { projectPlanHash, validateProjectResult } from '../services/code-intelligence-service/src/project-analysis.js';

const { values } = parseArgs({ options: {
  'source-database': { type: 'string', default: 'forexplore_code_intelligence' },
  'target-database': { type: 'string', default: 'forexplore_agent_restore_20260908' },
  'output-dir': { type: 'string', default: 'logs' },
} });
const sourceDatabase = values['source-database']!;
const targetDatabase = values['target-database']!;
assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceDatabase));
assert(/^forexplore_agent_restore_[A-Za-z0-9_]+$/.test(targetDatabase), 'Restoration requires an isolated forexplore_agent_restore_* database.');
assert.notEqual(sourceDatabase, targetDatabase, 'The original database is read-only.');
const legacy = parseEnv(await readFile('services/retrieval-service/.env', 'utf8'));
const connection = { host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? legacy.SEEKDB_HOST ?? '127.0.0.1',
  port: Number(process.env.CODE_INTELLIGENCE_SEEKDB_PORT ?? legacy.SEEKDB_PORT ?? 2881),
  user: process.env.CODE_INTELLIGENCE_SEEKDB_USER ?? legacy.SEEKDB_USER ?? 'root',
  password: process.env.CODE_INTELLIGENCE_SEEKDB_PASSWORD ?? legacy.SEEKDB_PASSWORD ?? '', connectionLimit: 3 };
assert(['localhost', '127.0.0.1', '::1'].includes(connection.host), 'Restoration is restricted to the local database.');
const originalPool = mysql.createPool(connection);
// Block mutations even if a later edit accidentally initializes the source store.
const readPool = new Proxy(originalPool, { get(target, property) {
  if (property === 'query') return (sql: string, ...parameters: unknown[]) => {
    assert(typeof sql === 'string' && /^\s*(SELECT|SHOW)\b/i.test(sql), 'Only read-only SQL is allowed on the source database.');
    return (target.query as (...args: unknown[]) => unknown).call(target, sql, ...parameters);
  };
  if (property === 'getConnection' || property === 'execute') return () => { throw new Error('Source database transactions and mutations are disabled.'); };
  const value = Reflect.get(target, property);
  return typeof value === 'function' ? value.bind(target) : value;
} });
const source = new SeekDbIndexStore({ ...connection, database: sourceDatabase, vectorDimension: 384 }, readPool);
const admin = mysql.createPool(connection);
let target: SeekDbIndexStore | undefined;
const startedAt = new Date().toISOString();
const report: Record<string, unknown> = { startedAt, sourceDatabase, targetDatabase, passed: false,
  sourceAccess: 'Read-only SELECT/SHOW; no source initialization, registration, reparse, model request or database write',
  embedding: { provider: 'hash-v1', dimension: 384, modelRequests: 0, semanticQualityMeasured: false }, repositories: [] };
const entries = report.repositories as Array<Record<string, unknown>>;
const mappings = new Map([
  ['account-stream-rs', 'fixtures/code-corpus/account-stream-rs'],
  ['commons-fileupload-java-skeleton', 'fixtures/target-system/commons-fileupload-java-skeleton'],
]);
interface Snapshot {
  repository: RepositoryRecord; revision: AnalysisRevisionRecord; index: StructuralIndex; artifacts: ModuleArtifactRecord[];
  localPath: string; sources: Map<string, string>;
  workingTreeDifferences: Array<{ relativePath: string; diskHash: string; snapshotHash: string; onlyLineEndings: boolean }>;
}

function validateArtifact(artifact: ModuleArtifactRecord, index: StructuralIndex) {
  assert.equal(artifact.repositoryId, index.repositoryId); assert.equal(artifact.analysisRevision, index.analysisRevision);
  assert.equal(artifact.analysisHash, index.analysisHash); assert.equal(artifact.status, 'current');
  const record = artifact.payload as ProjectAnalysisRecord;
  assert(record.proposal && record.state === 'ready');
  assert.equal(projectPlanHash(record.proposal), artifact.planHash, 'Original raw proposal no longer matches its plan hash.');
  assert.equal(record.repositoryId, index.repositoryId); assert.equal(record.analysisRevision, index.analysisRevision);
  const evidenceIds = [...new Set([...record.proposal.modules.flatMap((module) => module.evidenceIds),
    ...(record.proposal.dependencies ?? []).flatMap((edge) => edge.evidenceIds)])];
  const coverage = validateProjectResult(index, record, { proposal: record.proposal,
    evidence: { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, analysisHash: index.analysisHash, planHash: artifact.planHash!, evidenceIds } });
  assert.deepEqual(coverage, record.coverage, 'Original coverage differs from validated file ownership.');
}

async function snapshot(repository: RepositoryRecord): Promise<Snapshot> {
  assert(repository.activeRevision, 'Original repository has no active revision.');
  const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision };
  const revision = await source.getRevision(scope);
  assert(revision?.status === 'ready');
  const index = await source.getStructuralIndex(scope);
  assert(index && index.analysisHash === revision.analysisHash);
  assert(index.files.length <= 1000 && index.symbols.length <= 10000, 'Restoration is bounded to the requested small legacy repositories.');
  const artifacts = (await source.listModuleArtifacts(scope)).filter((artifact) => artifact.status === 'current' &&
    (artifact.kind === 'module-summary' || artifact.moduleArtifactId.startsWith('project-job:')));
  assert.equal(artifacts.filter((artifact) => artifact.kind === 'module-summary').length, index.projects.length);
  for (const artifact of artifacts) validateArtifact(artifact, index);
  const localPath = await realpath(mappings.get(repository.displayName)!);
  const sources = new Map<string, string>();
  const workingTreeDifferences: Snapshot['workingTreeDifferences'] = [];
  for (const file of index.files) {
    assert(!path.isAbsolute(file.relativePath) && !file.relativePath.split('/').includes('..'));
    const filename = await realpath(path.resolve(localPath, file.relativePath));
    assert(filename.startsWith(`${localPath}${path.sep}`), 'Source symlink escaped the mapped fixture.');
    const bytes = await readFile(filename);
    const diskHash = createHash('sha256').update(bytes).digest('hex');
    let text = bytes.toString('utf8');
    if (diskHash !== file.sha256) {
      const original = await source.getSourceText(scope, file.relativePath);
      assert(original !== null, `${repository.displayName}/${file.relativePath}: disk differs and the original snapshot is absent.`);
      assert.equal(createHash('sha256').update(original).digest('hex'), file.sha256, 'Original database snapshot does not match its recorded file hash.');
      workingTreeDifferences.push({ relativePath: file.relativePath, diskHash, snapshotHash: file.sha256,
        onlyLineEndings: original.replaceAll('\r\n', '\n') === text.replaceAll('\r\n', '\n') });
      text = original;
    }
    assert.equal(createHash('sha256').update(text).digest('hex'), file.sha256, 'Source is not lossless UTF-8.');
    sources.set(file.relativePath, text);
  }
  return { repository, revision, index, artifacts, localPath, sources, workingTreeDifferences };
}

async function verifyCopied(original: Snapshot) {
  const { repository, revision, index, artifacts, sources, localPath } = original;
  const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision };
  const copiedRepository = await target!.getRepository(repository.repositoryId);
  assert(copiedRepository); assert.equal(copiedRepository.localPath, localPath);
  assert.equal(copiedRepository.activeRevision, revision.analysisRevision); assert.equal(copiedRepository.role, repository.role);
  const copiedRevision = await target!.getRevision(index);
  assert.equal(copiedRevision?.status, 'ready'); assert.equal(copiedRevision.analysisHash, revision.analysisHash);
  assert.equal(copiedRevision.indexerVersion, revision.indexerVersion); assert.equal(copiedRevision.sourceRevision, revision.sourceRevision);
  assert.deepEqual(await target!.getStructuralIndex(index), index, 'Copied structural facts or identifiers changed.');
  const copiedArtifacts = await target!.getModuleArtifacts(scope, artifacts.map((artifact) => artifact.moduleArtifactId));
  assert.equal(copiedArtifacts.length, artifacts.length);
  for (const artifact of artifacts) assert.deepEqual(copiedArtifacts.find((item) => item.moduleArtifactId === artifact.moduleArtifactId), artifact, 'Copied module artifact changed.');
  for (const [relativePath, text] of sources) assert.equal(await target!.getSourceText(index, relativePath), text, 'Copied source snapshot changed.');
  const documents = await target!.listSearchDocuments(index);
  assert.equal(documents.filter((document) => document.kind === 'symbol').length, index.symbols.length);
  assert(documents.some((document) => document.kind === 'source-fragment' && document.sourceRange), 'New source projection has no precise ranges.');
  const summaries = documents.filter((document) => document.kind === 'summary');
  assert.equal(summaries.length, artifacts.filter((artifact) => artifact.kind === 'module-summary').reduce((sum, artifact) => sum + (artifact.payload as ProjectAnalysisRecord).proposal!.modules.length * 3, 0));
  for (const document of summaries) {
    const identity = JSON.parse(document.text);
    assert.equal(identity.planHash, artifacts.find((artifact) => artifact.moduleArtifactId === document.moduleArtifactId)!.planHash);
  }
  return { symbols: documents.filter((document) => document.kind === 'symbol').length,
    sourceFragments: documents.filter((document) => document.kind === 'source-fragment').length, summaryViews: summaries.length };
}

async function main() {
  const repositories = (await source.listRepositories()).filter((repository) => mappings.has(repository.displayName));
  assert.equal(repositories.length, mappings.size, 'The original database must contain both requested persisted repositories.');
  // Finish all disk/hash/contract checks before creating or writing the copy.
  const snapshots: Snapshot[] = [];
  for (const repository of repositories) snapshots.push(await snapshot(repository));
  const [existing] = await admin.query<mysql.RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [targetDatabase]);
  const existed = existing.length > 0;
  if (!existed) await admin.query(`CREATE DATABASE \`${targetDatabase}\``);
  target = new SeekDbIndexStore({ ...connection, database: targetDatabase, vectorDimension: 384 });
  if (!existed) await target.initialize();
  const existingRepositories = await target.listRepositories();
  assert(existingRepositories.every((repository) => snapshots.some((snapshot) => snapshot.repository.repositoryId === repository.repositoryId)), 'The restore database contains an unrelated repository.');
  for (const original of snapshots) if (existingRepositories.some((repository) => repository.repositoryId === original.repository.repositoryId)) await verifyCopied(original);
  for (const original of snapshots) {
    const { repository, revision, index, artifacts, localPath, sources } = original;
    const entry: Record<string, unknown> = { name: repository.displayName, role: repository.role, repositoryId: repository.repositoryId,
      analysisRevision: revision.analysisRevision, analysisHash: revision.analysisHash, originalLocalPath: repository.localPath, localPath,
      files: index.files.length, symbols: index.symbols.length, dependencies: index.dependencyEdges.length,
      diskFileHashesVerified: sources.size - original.workingTreeDifferences.length, originalSnapshotsVerified: original.workingTreeDifferences.length,
      workingTreeDifferences: original.workingTreeDifferences, projects: [] };
    entries.push(entry);
    const exists = await target.getRepository(repository.repositoryId);
    if (!exists) {
      await target.putRepository({ ...repository, localPath, activeRevision: null, analysisStatus: 'registered' });
      const { completedAt, activatedAt: _activatedAt, failureReason: _failureReason, ...identity } = revision;
      await target.putRevision({ ...identity, status: 'building' });
      await target.putStructuralIndex(index, sources);
      await new SeekDbProjection(target).project(index, sources);
      await target.putRevision({ ...identity, status: 'ready', completedAt: completedAt! });
      await target.activateRevision(index, repository.analysisStatus === 'degraded' ? 'degraded' : 'ready');
      for (const artifact of artifacts) await target.putModuleArtifact(artifact);
      for (const artifact of artifacts.filter((artifact) => artifact.kind === 'module-summary')) await new SeekDbProjection(target).projectModuleArtifacts(index, undefined, artifact.moduleArtifactId);
    }
    entry.mode = exists ? 'verified-existing-copy' : 'copied-original-snapshot';
    entry.projection = await verifyCopied(original);
    entry.projects = artifacts.filter((artifact) => artifact.kind === 'module-summary').map((artifact) => {
      const record = artifact.payload as ProjectAnalysisRecord;
      return { projectId: record.projectId, planHash: artifact.planHash, artifactContentHash: artifact.contentHash,
        originalHashesAndPayloadUnchanged: true, coverage: record.coverage, summary: record.proposal!.summary,
        modules: record.proposal!.modules.map((module) => ({ id: module.id, name: module.name, sourceFiles: module.sourceFiles })) };
    });
    assert.deepEqual(await source.getRepository(repository.repositoryId), repository, 'Original repository metadata changed during restoration.');
    assert.deepEqual(await source.getRevision(index), revision, 'Original revision metadata changed during restoration.');
    const after = await source.getModuleArtifacts({ repositoryId: index.repositoryId, analysisRevision: index.analysisRevision }, artifacts.map((artifact) => artifact.moduleArtifactId));
    for (const artifact of artifacts) assert.deepEqual(after.find((item) => item.moduleArtifactId === artifact.moduleArtifactId), artifact, 'Original module artifact changed during restoration.');
    entry.originalDatabaseUnchanged = true;
    console.info(JSON.stringify({ restored: repository.displayName, mode: entry.mode, projection: entry.projection }));
  }
  report.passed = true;
}

try { await main(); }
catch (error) { report.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000); process.exitCode = 1; }
finally {
  await target?.close(); await originalPool.end(); await admin.end();
  report.completedAt = new Date().toISOString();
  const output = path.resolve(values['output-dir']!); await mkdir(output, { recursive: true });
  const json = JSON.stringify(report, null, 2), timestamp = startedAt.replace(/[:.]/g, '-');
  await writeFile(path.join(output, `agent-module-restore-${timestamp}.json`), json);
  await writeFile(path.join(output, 'agent-module-restore.json'), json);
  console.info(JSON.stringify({ passed: report.passed, sourceDatabase, targetDatabase, error: report.error }));
}
