import { lstat, readdir, readFile } from 'node:fs/promises';
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
} from './structural-index.js';
import type { TreeSitterFileIndex, TreeSitterIndexRequest } from './tree-sitter-indexer.js';

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
  /** Host policy limit; oversized files are intentionally outside the v1 structural snapshot. */
  maxFileBytes?: number;
  previousIndex?: StructuralIndex;
  repositoryId: RepositoryId;
  repositoryRoot: string;
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

/**
 * Read a single, deterministic filesystem snapshot and pass it to the pure
 * structural builder. The builder retains that exact source text map, so a
 * later store/projection never needs to re-open a mutable checkout.
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
  const files = await collectSourceFiles(repositoryRoot, languageRegistry, maxFileBytes);
  return buildStructuralIndex({
    repositoryId: request.repositoryId,
    analysisRevision: request.analysisRevision,
    files,
    ...(request.changedPaths ? { changedPaths: request.changedPaths } : {}),
    ...(request.indexFile ? { indexFile: request.indexFile } : {}),
    languageRegistry,
    ...(request.previousIndex ? { previousIndex: request.previousIndex } : {}),
  });
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
