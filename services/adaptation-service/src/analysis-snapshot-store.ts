import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  verifyRepositoryStaticAnalysis,
} from '@forexplore/code-indexer';
import type { RepositoryStaticAnalysis } from '@forexplore/contracts';
import type { StaticAnalysisSnapshotStore } from './http-server';

export interface FileStaticAnalysisSnapshotStoreOptions {
  /** Server-owned `.forexplore/analysis` directory, never browser supplied. */
  analysisRoot: string;
}

/**
 * Read-only filesystem store for immutable static-analysis snapshots. The
 * HTTP layer receives only a snapshot ID; this class constructs the path and
 * refuses traversal or mismatched artifact identities.
 */
export class FileStaticAnalysisSnapshotStore implements StaticAnalysisSnapshotStore {
  readonly #analysisRoot: string;

  constructor(options: FileStaticAnalysisSnapshotStoreOptions) {
    this.#analysisRoot = resolve(options.analysisRoot);
  }

  async getSnapshot(
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryStaticAnalysis | null> {
    signal?.throwIfAborted();
    const snapshotPath = this.snapshotPath(snapshotId);
    let raw: string;
    try {
      raw = await readFile(snapshotPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    signal?.throwIfAborted();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Static analysis snapshot is invalid JSON: ${snapshotId}`);
    }
    const analysis = verifyRepositoryStaticAnalysis(parsed);
    if (analysis.snapshotId !== snapshotId) {
      throw new Error(`Static analysis snapshot has an invalid identity: ${snapshotId}`);
    }
    return analysis;
  }

  private snapshotPath(snapshotId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(snapshotId)) {
      throw new Error('Static analysis snapshot ID is invalid.');
    }
    const candidate = resolve(this.#analysisRoot, `${snapshotId}.json`);
    const rel = relative(this.#analysisRoot, candidate);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Static analysis snapshot path escapes the configured store.');
    }
    return candidate;
  }
}
