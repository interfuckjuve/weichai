import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createDefaultLanguageRegistry,
  scanRepositoryStructuralIndex,
  type LanguageRegistry,
  type StructuralSourceFile,
} from '@forexplore/code-indexer';
import type { StructuralIndex } from '@forexplore/contracts';
import type {
  StructuralScanRequest,
  StructuralScanResult,
  StructuralScanner,
} from './analysis-coordinator.js';

const execFileAsync = promisify(execFile);
const MAX_INDEXED_FILE_BYTES = 4 * 1024 * 1024;

const ignoredDirectories = new Set([
  '.forexplore',
  '.git',
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

const configurationNames = new Set([
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

export interface RepositoryStructuralScannerOptions {
  languageRegistry?: LanguageRegistry;
  maxFileBytes?: number;
  /** Test seam for stable VCS evidence without invoking Git. */
  readSourceRevision?: (root: string) => Promise<string | undefined>;
}

function canonicalPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Repository scan attempted to leave its registered root: ${absolutePath}`);
  }
  return relative;
}

function isConfigurationPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const name = lower.split('/').at(-1) ?? lower;
  return configurationNames.has(name) || /\.(?:csproj|sln)$/i.test(name);
}

function isText(buffer: Buffer): boolean {
  // Tree-sitter receives text only. Skipping binary files avoids inserting
  // opaque payloads into source excerpts or full-text projections.
  return !buffer.includes(0);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function gitRevision(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      windowsHide: true,
    });
    const revision = stdout.trim();
    return revision || undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot only registered-root files supported by a grammar or project discovery. */
export async function snapshotRepositorySources(
  root: string,
  registry: LanguageRegistry = createDefaultLanguageRegistry(),
  maxFileBytes = MAX_INDEXED_FILE_BYTES,
  signal?: AbortSignal,
): Promise<StructuralSourceFile[]> {
  const files: StructuralSourceFile[] = [];
  const resolvedRoot = path.resolve(root);

  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase())) await visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = canonicalPath(resolvedRoot, absolutePath);
      if (!registry.resolvePath(relativePath) && !isConfigurationPath(relativePath)) continue;
      const buffer = await readFile(absolutePath);
      if (buffer.byteLength > maxFileBytes || !isText(buffer)) continue;
      files.push({ relativePath, content: buffer.toString('utf8') });
    }
  };

  await visit(resolvedRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function changedPaths(
  current: readonly StructuralSourceFile[],
  previous: StructuralIndex | undefined,
): string[] {
  if (!previous) return current.map((file) => file.relativePath);
  const currentHashes = new Map(current.map((file) => [file.relativePath, hash(file.content)]));
  const previousHashes = new Map(previous.files.map((file) => [file.relativePath, file.sha256]));
  const paths = new Set([...currentHashes.keys(), ...previousHashes.keys()]);
  return [...paths]
    .filter((relativePath) => currentHashes.get(relativePath) !== previousHashes.get(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Filesystem adapter used only by AnalysisCoordinator after RepositoryRegistry
 * has authorized a root. It never accepts a root from SemanticQueryPort/MCP.
 */
export class RepositoryStructuralScanner implements StructuralScanner {
  readonly #registry: LanguageRegistry;
  readonly #maxFileBytes: number;
  readonly #readSourceRevision: (root: string) => Promise<string | undefined>;

  constructor(options: RepositoryStructuralScannerOptions = {}) {
    this.#registry = options.languageRegistry ?? createDefaultLanguageRegistry();
    this.#maxFileBytes = options.maxFileBytes ?? MAX_INDEXED_FILE_BYTES;
    if (!Number.isInteger(this.#maxFileBytes) || this.#maxFileBytes < 1) {
      throw new Error('maxFileBytes must be a positive integer.');
    }
    this.#readSourceRevision = options.readSourceRevision ?? gitRevision;
  }

  async scan(request: StructuralScanRequest): Promise<StructuralScanResult> {
    request.signal?.throwIfAborted();
    // The code-indexer owns Tree-sitter parsing and incremental reuse. The
    // service supplies only the already-authorized registry root and persists
    // the resulting immutable source snapshot.
    const build = await scanRepositoryStructuralIndex({
      repositoryId: request.repositoryId,
      analysisRevision: request.analysisRevision,
      repositoryRoot: request.root,
      languageRegistry: this.#registry,
      maxFileBytes: this.#maxFileBytes,
      ...(request.mode === 'incremental' && request.previousIndex
        ? { previousIndex: request.previousIndex }
        : {}),
      ...(request.mode === 'incremental' && request.changedPaths
        ? { changedPaths: request.changedPaths }
        : {}),
    });
    const sourceRevision = await this.#readSourceRevision(request.root);
    return {
      index: build.index,
      sourceTexts: build.sourceFiles,
      ...(sourceRevision ? { sourceRevision } : {}),
      changedPaths: build.changedPaths ?? [],
      reusedFileCount: build.stats.reusedFileCount,
    };
  }
}

export const repositoryScannerInternals = {
  canonicalPath,
  changedPaths,
  gitRevision,
  isConfigurationPath,
  isText,
};
