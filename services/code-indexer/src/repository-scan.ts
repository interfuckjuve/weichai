import { lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  AnalysisRevisionId,
  RepositoryId,
  StructuralIndex,
} from '@forexplore/contracts';
import {
  createDefaultLanguageRegistry,
  type LanguageRegistry,
} from './language-registry.js';
import {
  buildStructuralIndex,
  type StructuralIndexBuild,
  type StructuralSourceFile,
} from './structural-index.js';
import type { TreeSitterFileIndex, TreeSitterIndexRequest } from './tree-sitter-indexer.js';
import { parseSourceFiles } from './structural-parse-pool.js';

/**
 * Host-only input for a repository snapshot. `repositoryRoot` never crosses
 * the structural-index result boundary: every emitted path is relative to it.
 */
export interface RepositoryStructuralScanRequest {
  analysisRevision: AnalysisRevisionId;
  changedPaths?: readonly string[];
  /** Optional host-owned parse seam, primarily for deterministic tests. */
  indexFile?: (request: TreeSitterIndexRequest) => TreeSitterFileIndex;
  languageRegistry?: LanguageRegistry;
  /** Host parsing limit; oversized files retain metadata and a visible diagnostic. */
  maxFileBytes?: number;
  previousIndex?: StructuralIndex;
  repositoryId: RepositoryId;
  repositoryRoot: string;
  retainSourceTexts?: boolean;
  signal?: AbortSignal;
  isolatedParsing?: boolean;
}

/** A narrow adapter shape suitable for `AnalysisCoordinator` injection. */
export interface RepositoryStructuralScanner {
  scan(request: RepositoryStructuralScanRequest): Promise<StructuralIndexBuild>;
}

const ignoredDirectoryNames = new Set([
  '.git',
  '.forexplore',
  '.gradle',
  '.idea',
  '.next',
  '.svn',
  '.vscode',
  '__pycache__',
  'bin',
  'build',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
]);

const projectManifestNames = new Set([
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
  'go.mod',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRelativePath(repositoryRoot: string, absolutePath: string): string {
  const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)) {
    throw new Error('Repository scan discovered a path outside its registered root.');
  }
  return relativePath;
}

function isProjectManifest(relativePath: string): boolean {
  const name = path.posix.basename(relativePath).toLowerCase();
  return projectManifestNames.has(name) || /\.(?:csproj|sln)$/i.test(relativePath);
}

function shouldReadFile(relativePath: string, registry: LanguageRegistry): boolean {
  return Boolean(registry.resolvePath(relativePath)) || isProjectManifest(relativePath) ||
    /\.(?:c|h|cpp|hpp|cc|swift|kt|kts|rb|php|scala|lua|ex|exs|sh|sql)$/i.test(relativePath);
}

async function collectSourceFiles(
  repositoryRoot: string,
  registry: LanguageRegistry,
  maxFileBytes: number,
): Promise<Array<{ content: string; relativePath: string }>> {
  const files: Array<{ content: string; relativePath: string }> = [];

  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new Error('Repository scan could not enumerate repository contents.');
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      // Symlinks can escape a registered repository root. Do not follow them
      // and do not permit them to make the source snapshot nondeterministic.
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toRelativePath(repositoryRoot, absolutePath);
      if (!shouldReadFile(relativePath, registry)) continue;
      try {
        const status = await lstat(absolutePath);
        if (status.size > maxFileBytes) continue;
        const bytes = await readFile(absolutePath);
        // Never turn binary data into source excerpts/full-text documents.
        if (bytes.includes(0)) continue;
        files.push({ relativePath, content: bytes.toString('utf8') });
      } catch {
        // Keep host paths out of a failure record that can later be queried
        // by an agent or webview; the relative path is sufficient to repair
        // a repository permission/encoding problem.
        throw new Error(`Repository scan could not read ${relativePath}.`);
      }
    }
  };

  await visit(repositoryRoot);
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

async function snapshotSourceFiles(request: RepositoryStructuralScanRequest, registry: LanguageRegistry, maxFileBytes: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forexplore-source-'));
  const storedPaths = new Map<string, string>();
  const files: StructuralSourceFile[] = [];
  const observed: Array<{ absolutePath: string; size: number; mtimeMs: number; ctimeMs: number; ino: number }> = [];
  const dispose = () => rm(directory, { recursive: true, force: true });
  const visit = async (parent: string): Promise<void> => {
    request.signal?.throwIfAborted();
    const directoryStatus = await lstat(parent);
    observed.push({ absolutePath: parent, size: directoryStatus.size, mtimeMs: directoryStatus.mtimeMs, ctimeMs: directoryStatus.ctimeMs, ino: directoryStatus.ino });
    const entries = await readdir(parent, { withFileTypes: true });
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      request.signal?.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(parent, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = toRelativePath(request.repositoryRoot, absolutePath);
      if (!shouldReadFile(relativePath, registry)) continue;
      const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        const digest = createHash('sha256');
        let content: string | undefined;
        let unavailableReason: string | undefined;
        if (before.size > maxFileBytes) {
          for await (const bytes of handle.createReadStream({ autoClose: false })) {
            request.signal?.throwIfAborted();
            digest.update(bytes);
          }
          unavailableReason = `File exceeds the configured source limit of ${maxFileBytes} bytes (${before.size} bytes).`;
        } else {
          const bytes = await handle.readFile();
          digest.update(bytes);
          if (bytes.includes(0)) unavailableReason = 'File contains binary data and cannot be parsed as source.';
          else {
            content = bytes.toString('utf8');
            if (!bytes.equals(Buffer.from(content, 'utf8'))) { unavailableReason = 'Source encoding is not valid UTF-8.'; content = undefined; }
          }
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error(`Source changed during snapshot capture: ${relativePath}`);
        }
        observed.push({ absolutePath, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino });
        const sha256 = digest.digest('hex');
        const contentPath = path.join(directory, String(files.length));
        if (content !== undefined) {
          await writeFile(contentPath, content, 'utf8');
          storedPaths.set(relativePath, contentPath);
          content = undefined;
        }
        files.push({ relativePath, sha256, sizeBytes: before.size,
          ...(unavailableReason ? { unavailableReason } : {}),
          get content() { return unavailableReason ? '' : readFileSync(contentPath, 'utf8'); },
        });
      } finally {
        await handle.close();
      }
    }
  };
  try {
    await visit(request.repositoryRoot);
    for (const previous of observed) {
      request.signal?.throwIfAborted();
      const current = await lstat(previous.absolutePath);
      if (current.isSymbolicLink() || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs || current.ino !== previous.ino) {
        throw new Error('Repository changed during source snapshot capture; retry after the current edits finish.');
      }
    }
    return { files, storedPaths, sourceReader: {
      async read(relativePath: string): Promise<string | null> {
        request.signal?.throwIfAborted();
        const contentPath = storedPaths.get(relativePath);
        return contentPath ? readFile(contentPath, 'utf8') : null;
      },
      dispose,
    } };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Read a single, deterministic filesystem snapshot and pass it to the pure
 * structural builder. Production reads the captured disk spool lazily, so
 * later storage/projection never re-opens a mutable checkout.
 */
export async function scanRepositoryStructuralIndex(
  request: RepositoryStructuralScanRequest,
): Promise<StructuralIndexBuild> {
  const repositoryRoot = path.resolve(request.repositoryRoot);
  let rootStatus;
  try {
    rootStatus = await lstat(repositoryRoot);
  } catch {
    throw new Error('Repository scan root could not be read.');
  }
  if (!rootStatus.isDirectory()) {
    throw new Error('Repository scan root must be a directory.');
  }
  const languageRegistry = request.languageRegistry ?? createDefaultLanguageRegistry();
  const maxFileBytes = request.maxFileBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error('Repository scan maxFileBytes must be a positive integer.');
  }
  const scanStarted = performance.now();
  const snapshot = await snapshotSourceFiles({ ...request, repositoryRoot }, languageRegistry, maxFileBytes);
  console.info('[forexplore:performance]', JSON.stringify({ stage: 'source-snapshot', repositoryId: request.repositoryId,
    durationMs: Math.round(performance.now() - scanStarted), files: snapshot.files.length }));
  const parseStarted = performance.now();
  try {
    let indexFile = request.indexFile;
    let parserResources: { peakWorkerRss: number; peakCombinedRss: number; workers: number } | undefined;
    const requiresIsolation = request.retainSourceTexts === false &&
      (snapshot.files.length > 128 || snapshot.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) > 2 * 1024 * 1024);
    if (!indexFile && (request.isolatedParsing ?? requiresIsolation)) {
      const previous = new Map(request.previousIndex?.files.map(file => [file.relativePath, file]) ?? []);
      const changed = new Set(request.changedPaths ?? []);
      const tasks = snapshot.files.flatMap(file => {
        const sourcePath = snapshot.storedPaths.get(file.relativePath);
        const old = previous.get(file.relativePath);
        if (!sourcePath || !languageRegistry.resolvePath(file.relativePath) || old && old.sha256 === file.sha256 && old.parseStatus !== 'failed' && !changed.has(file.relativePath)) return [];
        return [{ sourcePath, resultPath: `${sourcePath}.parsed.json`, relativePath: file.relativePath, sizeBytes: file.sizeBytes ?? 0 }];
      });
      const stats = await parseSourceFiles(tasks, request.signal);
      parserResources = stats;
      console.info('[forexplore:performance]', JSON.stringify({ stage: 'parser-pool-complete', ...stats, files: tasks.length }));
      indexFile = input => {
        const contentPath = snapshot.storedPaths.get(input.relativePath)!;
        const payload = JSON.parse(readFileSync(`${contentPath}.parsed.json`, 'utf8')) as { result?: TreeSitterFileIndex; error?: string };
        if (!payload.result) throw new Error(payload.error ?? 'Parser worker did not produce a result.');
        return payload.result;
      };
    }
    const result = buildStructuralIndex({
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
      files: snapshot.files,
      retainSourceTexts: request.retainSourceTexts,
      signal: request.signal,
      ...(request.changedPaths ? { changedPaths: request.changedPaths } : {}),
      ...(indexFile ? { indexFile } : {}),
      languageRegistry,
      ...(request.previousIndex ? { previousIndex: request.previousIndex } : {}),
    });
    if (parserResources) result.stats.parserResources = parserResources;
    console.info('[forexplore:performance]', JSON.stringify({ stage: 'structural-parse', repositoryId: request.repositoryId,
      durationMs: Math.round(performance.now() - parseStarted), symbols: result.index.symbols.length,
      dependencies: result.index.dependencyEdges.length }));
    if (request.retainSourceTexts === false) return { ...result, sourceReader: snapshot.sourceReader };
    await snapshot.sourceReader.dispose();
    return result;
  } catch (error) {
    await snapshot.sourceReader.dispose();
    throw error;
  }
}

export const filesystemRepositoryStructuralScanner: RepositoryStructuralScanner = {
  scan: scanRepositoryStructuralIndex,
};

export const repositoryScanInternals = {
  collectSourceFiles,
  isProjectManifest,
  shouldReadFile,
  toRelativePath,
};
