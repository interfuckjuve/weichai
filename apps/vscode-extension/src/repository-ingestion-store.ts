import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoryIngestionArtifactRef,
  RepositoryIngestionManifest,
} from '@forexplore/contracts';

export interface RepositoryIngestionStoredArtifact {
  /** Repository-relative POSIX path. */
  path: string;
  content: string;
  /**
   * Immutable run artifacts are create-only. Derived wiki views are replaceable,
   * except for the lifecycle log whose existing bytes must remain a prefix.
   */
  mode: 'immutable' | 'derived' | 'append-only-derived' | 'manifest';
  /**
   * Required when replacing an existing manifest. The hash is calculated from
   * the exact UTF-8 bytes previously read by the caller, which gives review
   * publication a small compare-and-swap boundary instead of a last-writer-wins
   * overwrite.
   */
  expectedContentHash?: string;
}

export interface PersistRepositoryIngestionArtifactsRequest {
  repositoryRoot: string;
  ingestionId: string;
  artifacts: readonly RepositoryIngestionStoredArtifact[];
}

const safeIngestionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const immutablePrefix = '.forexplore/ingestion/';
const derivedPrefix = '.forexplore/modules/';

export function repositoryIngestionManifestPath(ingestionId: string): string {
  if (!safeIngestionId.test(ingestionId)) {
    throw new Error('Repository ingestion ID is unsafe.');
  }
  return `${immutablePrefix}${ingestionId}/manifest.json`;
}

export async function readRepositoryIngestionManifest(
  repositoryRoot: string,
  ingestionId: string,
): Promise<RepositoryIngestionManifest | null> {
  const root = path.resolve(repositoryRoot);
  const relativePath = repositoryIngestionManifestPath(ingestionId);
  const absolutePath = resolveInside(root, relativePath);
  await assertSafeParents(root, absolutePath);
  await assertSafeTarget(absolutePath, true);
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(content) as RepositoryIngestionManifest;
  } catch {
    throw new Error(`Repository ingestion manifest is invalid JSON: ${absolutePath}`);
  }
}

export async function readRepositoryModuleKnowledgeLog(repositoryRoot: string): Promise<string> {
  const root = path.resolve(repositoryRoot);
  const absolutePath = resolveInside(root, '.forexplore/modules/log.md');
  await assertSafeParents(root, absolutePath);
  await assertSafeTarget(absolutePath, true);
  try {
    return await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Read and hash-check one artifact already authorized by an ingestion manifest. */
export async function readRepositoryIngestionArtifactContent(
  repositoryRoot: string,
  ingestionId: string,
  artifact: RepositoryIngestionArtifactRef,
): Promise<string> {
  if (!artifact.path) {
    throw new Error(`Repository ingestion artifact has no persisted path: ${artifact.id}`);
  }
  const root = path.resolve(repositoryRoot);
  const normalized = normalizeArtifactPath(artifact.path);
  const mode = normalized.startsWith(`${immutablePrefix}${ingestionId}/`)
    ? 'immutable' as const
    : normalized === `${derivedPrefix}log.md`
      ? 'append-only-derived' as const
      : 'derived' as const;
  assertArtifactNamespace(normalized, mode, ingestionId);
  const absolutePath = resolveInside(root, normalized);
  await assertSafeParents(root, absolutePath);
  await assertSafeTarget(absolutePath, false);
  const bytes = await readFile(absolutePath);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== artifact.contentHash) {
    throw new Error(`Repository ingestion artifact hash mismatch: ${normalized}`);
  }
  if (artifact.byteLength !== undefined && artifact.byteLength !== bytes.byteLength) {
    throw new Error(`Repository ingestion artifact byte length mismatch: ${normalized}`);
  }
  return bytes.toString('utf8');
}

/**
 * A manifest is only a commit marker when every referenced artifact is still
 * present at its trusted path and matches the recorded bytes. Reuse callers
 * must run this check before returning cached ingestion state.
 */
export async function verifyRepositoryIngestionStoredArtifacts(
  repositoryRoot: string,
  manifest: RepositoryIngestionManifest,
): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const seenPaths = new Set<string>();
  for (const artifact of manifestArtifactRefs(manifest)) {
    if (!artifact.path) {
      throw new Error(`Repository ingestion artifact has no persisted path: ${artifact.id}`);
    }
    const normalized = normalizeArtifactPath(artifact.path);
    if (seenPaths.has(normalized)) {
      throw new Error(`Repository ingestion manifest reuses an artifact path: ${normalized}`);
    }
    seenPaths.add(normalized);
    const mode = normalized.startsWith(`${immutablePrefix}${manifest.id}/`)
      ? 'immutable' as const
      : normalized === `${derivedPrefix}log.md`
        ? 'append-only-derived' as const
        : 'derived' as const;
    assertArtifactNamespace(normalized, mode, manifest.id);
    const absolutePath = resolveInside(root, normalized);
    await assertSafeParents(root, absolutePath);
    await assertSafeTarget(absolutePath, false);
    const bytes = await readFile(absolutePath);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== artifact.contentHash) {
      throw new Error(`Repository ingestion artifact hash mismatch: ${normalized}`);
    }
    if (artifact.byteLength !== undefined && artifact.byteLength !== bytes.byteLength) {
      throw new Error(`Repository ingestion artifact byte length mismatch: ${normalized}`);
    }
  }
}

/**
 * Persists raw evidence as create-only run artifacts and wiki files as
 * atomically replaced, replayable views. Callers put the manifest last so its
 * existence is the run commit marker.
 */
export async function persistRepositoryIngestionArtifacts(
  request: PersistRepositoryIngestionArtifactsRequest,
): Promise<string[]> {
  if (!safeIngestionId.test(request.ingestionId)) {
    throw new Error('Repository ingestion ID is unsafe.');
  }
  const root = path.resolve(request.repositoryRoot);
  const seen = new Set<string>();
  const resolved = request.artifacts.map((artifact) => {
    const normalized = normalizeArtifactPath(artifact.path);
    if (seen.has(normalized)) throw new Error(`Duplicate repository ingestion artifact path: ${normalized}`);
    seen.add(normalized);
    assertArtifactNamespace(normalized, artifact.mode, request.ingestionId);
    return { ...artifact, normalized, absolutePath: resolveInside(root, normalized) };
  });
  const manifestIndex = resolved.findIndex((artifact) => artifact.mode === 'manifest');
  if (manifestIndex !== -1 && manifestIndex !== resolved.length - 1) {
    throw new Error('Repository ingestion manifest must be persisted last as the commit marker.');
  }
  if (resolved.filter((artifact) => artifact.mode === 'manifest').length > 1) {
    throw new Error('Repository ingestion persistence accepts at most one manifest commit marker.');
  }
  for (const artifact of resolved) {
    if (artifact.mode !== 'manifest' && artifact.expectedContentHash !== undefined) {
      throw new Error('Only a repository ingestion manifest may use compare-and-swap persistence.');
    }
  }

  const written: string[] = [];
  for (const artifact of resolved) {
    await assertSafeParents(root, artifact.absolutePath);
    await mkdir(path.dirname(artifact.absolutePath), { recursive: true });
    await assertSafeParents(root, artifact.absolutePath);
    await assertSafeTarget(artifact.absolutePath, true);
    if (artifact.mode === 'immutable') {
      await writeCreateOnly(artifact.absolutePath, artifact.content);
    } else if (artifact.mode === 'manifest') {
      await writeManifestCommitMarker(
        artifact.absolutePath,
        artifact.content,
        artifact.expectedContentHash,
      );
    } else if (artifact.mode === 'append-only-derived') {
      await writeAppendOnlyView(artifact.absolutePath, artifact.content);
    } else {
      await writeAtomicView(artifact.absolutePath, artifact.content);
    }
    written.push(artifact.absolutePath);
  }
  return written;
}

function normalizeArtifactPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Repository ingestion artifact path is unsafe: ${value}`);
  }
  return normalized;
}

function assertArtifactNamespace(
  artifactPath: string,
  mode: RepositoryIngestionStoredArtifact['mode'],
  ingestionId: string,
): void {
  if (mode === 'manifest') {
    const expected = repositoryIngestionManifestPath(ingestionId);
    if (artifactPath !== expected) {
      throw new Error(`Repository ingestion manifest must use ${expected}`);
    }
    return;
  }
  if (mode === 'immutable') {
    const runPrefix = `${immutablePrefix}${ingestionId}/`;
    if (!artifactPath.startsWith(runPrefix)) {
      throw new Error(`Immutable ingestion artifact must be inside ${runPrefix}`);
    }
    return;
  }
  if (!artifactPath.startsWith(derivedPrefix)) {
    throw new Error(`Derived repository knowledge must be inside ${derivedPrefix}`);
  }
  if (mode === 'append-only-derived' && artifactPath !== `${derivedPrefix}log.md`) {
    throw new Error(`Only ${derivedPrefix}log.md may use append-only derived storage.`);
  }
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Repository ingestion artifact escapes the repository root.');
  }
  return target;
}

async function assertSafeParents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Repository ingestion artifact parent is a symbolic link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Repository ingestion artifact parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertSafeTarget(target: string, allowMissing: boolean): Promise<void> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`Repository ingestion artifact target is a symbolic link: ${target}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Repository ingestion artifact target is not a regular file: ${target}`);
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function writeCreateOnly(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await assertSafeTarget(destination, false);
      const existing = await readFile(destination, 'utf8');
      if (!sameContent(existing, content)) {
        throw new Error(`Immutable repository ingestion artifact already exists with different content: ${destination}`);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeAtomicView(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeManifestCommitMarker(
  destination: string,
  content: string,
  expectedContentHash: string | undefined,
): Promise<void> {
  let existing: string | undefined;
  try {
    await assertSafeTarget(destination, true);
    existing = await readFile(destination, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (existing === undefined) {
    if (expectedContentHash !== undefined) {
      throw new Error('Repository ingestion manifest compare-and-swap expected an existing commit marker.');
    }
    await writeAtomicView(destination, content);
    return;
  }
  if (sameContent(existing, content)) return;
  if (expectedContentHash === undefined) {
    throw new Error('Repository ingestion manifest already exists with different content.');
  }
  const actualHash = createHash('sha256').update(existing, 'utf8').digest('hex');
  if (actualHash !== expectedContentHash) {
    throw new Error('Repository ingestion manifest compare-and-swap conflict.');
  }
  await writeAtomicView(destination, content);
}

async function writeAppendOnlyView(destination: string, content: string): Promise<void> {
  let existing = '';
  try {
    await assertSafeTarget(destination, true);
    existing = await readFile(destination, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!content.startsWith(existing)) {
    throw new Error(`Repository knowledge log update is not append-only: ${destination}`);
  }
  if (content === existing) return;
  await writeAtomicView(destination, content);
}

function sameContent(left: string, right: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  return hash(left) === hash(right);
}

function manifestArtifactRefs(
  manifest: RepositoryIngestionManifest,
): RepositoryIngestionArtifactRef[] {
  return [
    ...(manifest.artifacts.profile ? [manifest.artifacts.profile] : []),
    ...manifest.artifacts.shards,
    ...(manifest.artifacts.unifiedRepositoryIr ? [manifest.artifacts.unifiedRepositoryIr] : []),
    ...(manifest.artifacts.moduleDiscoveryProposal
      ? [manifest.artifacts.moduleDiscoveryProposal]
      : []),
    ...(manifest.artifacts.moduleReview ? [manifest.artifacts.moduleReview] : []),
    ...(manifest.artifacts.moduleCatalog ? [manifest.artifacts.moduleCatalog] : []),
    ...(manifest.artifacts.activeModuleCatalog
      ? [manifest.artifacts.activeModuleCatalog]
      : []),
    ...(manifest.artifacts.moduleBundle ? [manifest.artifacts.moduleBundle] : []),
    ...manifest.artifacts.moduleEvidenceBundles,
    ...manifest.artifacts.moduleWikiProposals,
    ...manifest.artifacts.moduleKnowledgeReviews,
    ...manifest.artifacts.knowledgePublications,
    ...manifest.artifacts.moduleIndexReceipts,
    ...manifest.artifacts.publicationHeads,
    ...(manifest.artifacts.incrementalImpactSet
      ? [manifest.artifacts.incrementalImpactSet]
      : []),
    ...manifest.artifacts.knowledge.map((knowledge) => knowledge.artifact),
  ];
}
