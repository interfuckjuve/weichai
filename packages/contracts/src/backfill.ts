export interface PatchHunk {
  header: string;
  lines: Array<{ type: 'context' | 'add' | 'remove'; content: string }>;
}

interface BaseFilePatch {
  path: string;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

/**
 * A modification is valid only against the exact source bytes inspected when
 * the patch was produced. Paths are always relative to the authorized root.
 */
export interface ModifiedFilePatch extends BaseFilePatch {
  status: 'modified';
  expectedOriginalSha256: string;
}

/** New-file write-back is explicit about the required absence precondition. */
export interface CreatedFilePatch extends BaseFilePatch {
  status: 'created';
  expectedAbsent: true;
}

export type FilePatch = ModifiedFilePatch | CreatedFilePatch;

export interface CheckpointFile {
  path: string;
  status: FilePatch['status'];
  beforeSha256: string | null;
  afterSha256: string;
}

export interface WorkspaceCheckpoint {
  id: string;
  createdAt: string;
  recoverable: boolean;
  files: CheckpointFile[];
}

/**
 * Durable state for a multi-file write transaction. A filesystem cannot make
 * several renames visible as one operation, so an interrupted commit is
 * recovered from the checkpoint before another migration may proceed.
 */
export type BackfillTransactionState =
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'rolled-back';

export interface ApplyResult {
  appliedFiles: string[];
  checkpointId: string;
  rollbackAvailable: boolean;
}
