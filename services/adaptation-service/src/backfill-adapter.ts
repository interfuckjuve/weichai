/**
 * Safe local write-back implementation.
 *
 * All files are preflighted before any write. The adapter keeps a durable
 * snapshot manifest, writes each replacement through a sibling temporary file
 * and restores previously written files when a commit step fails. It is still
 * intentionally a local adapter: the HTTP endpoint is disabled until it can
 * authenticate an opaque, host-owned migration run.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ApplyResult,
  BackfillTransactionState,
  FilePatch,
  WorkspaceCheckpoint,
} from "@forexplore/contracts";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import type { CodeBackfillPort } from "@forexplore/workflow-core";

export interface BackfillAdapterOptions {
  /** Filesystem root containing the authorized target project. */
  projectRoot: string;
  /** Durable checkpoint location. Defaults to <projectRoot>/.forexplore/checkpoints. */
  checkpointRoot?: string;
}

/**
 * A caller-owned identifier lets a higher-level wave manifest refer to the
 * durable checkpoint before it writes the managed summary file.
 */
export interface BackfillTransactionOptions {
  transactionId?: string;
  signal?: AbortSignal;
}

export interface BackfillRecoveryResult {
  checkpointId: string;
  state: "rolled-back";
}

interface PreparedFile {
  patch: FilePatch;
  fullPath: string;
  nextContent: Buffer;
  beforeContent: Buffer | null;
  afterSha256: string;
}

interface StoredCheckpointFile {
  path: string;
  status: FilePatch["status"];
  beforeSha256: string | null;
  afterSha256: string;
  beforeContentBase64: string | null;
}

interface StoredCheckpoint extends Omit<WorkspaceCheckpoint, "files"> {
  state: BackfillTransactionState;
  files: StoredCheckpointFile[];
}

interface RestoreFile {
  snapshot: StoredCheckpointFile;
  fullPath: string;
  shouldRestore: boolean;
}

interface WorkspaceLock {
  path: string;
  token: string;
}

export class BackfillAdapter implements CodeBackfillPort {
  #projectRoot: string;
  #checkpointRoot: string;
  #lockRoot: string;

  constructor(options: BackfillAdapterOptions) {
    const configuredRoot = resolve(options.projectRoot);
    if (!existsSync(configuredRoot)) {
      throw new Error(`Project root does not exist: ${configuredRoot}`);
    }
    this.#projectRoot = realpathSync(configuredRoot);
    this.#checkpointRoot = resolve(
      options.checkpointRoot ?? join(this.#projectRoot, ".forexplore", "checkpoints"),
    );
    if (!isInsideRoot(this.#projectRoot, this.#checkpointRoot)) {
      throw new Error("Checkpoint root must stay inside the configured project root.");
    }
    this.#lockRoot = resolve(this.#projectRoot, ".forexplore", "locks");
    if (!isInsideRoot(this.#projectRoot, this.#lockRoot)) {
      throw new Error("Backfill lock root must stay inside the configured project root.");
    }
  }

  async apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult> {
    return this.applyTransaction(files, { signal });
  }

  async applyTransaction(
    files: FilePatch[],
    options: BackfillTransactionOptions = {},
  ): Promise<ApplyResult> {
    const lock = this.acquireWorkspaceLock();
    try {
      return this.applyTransactionLocked(files, options);
    } finally {
      this.releaseWorkspaceLock(lock);
    }
  }

  private applyTransactionLocked(
    files: FilePatch[],
    options: BackfillTransactionOptions,
  ): ApplyResult {
    const { signal } = options;
    throwIfAborted(signal);
    if (files.length === 0) throw new Error("A backfill transaction must contain at least one patch.");
    const prepared = files.map((file) => this.prepare(file));
    assertDistinctPaths(prepared);
    throwIfAborted(signal);

    const checkpoint = this.writeCheckpoint(prepared, options.transactionId);
    const temporaryPaths: string[] = [];
    try {
      // Write every temporary file before replacing a single target. A failure
      // here leaves the project untouched.
      for (const file of prepared) {
        const temporaryPath = temporarySibling(file.fullPath, checkpoint.id);
        writeFileSync(temporaryPath, file.nextContent, { mode: 0o600, flag: "wx" });
        temporaryPaths.push(temporaryPath);
      }

      throwIfAborted(signal);
      this.assertPreparedFilesStillCurrent(prepared);
      this.setCheckpointState(checkpoint, "committing");
      for (let index = 0; index < prepared.length; index += 1) {
        const file = prepared[index];
        const temporaryPath = temporaryPaths[index];
        if (!file || !temporaryPath) throw new Error("Backfill transaction state is incomplete.");
        this.assertPreparedFileStillCurrent(file);
        renameSync(temporaryPath, file.fullPath);
      }

      this.setCheckpointState(checkpoint, "committed");

      return {
        appliedFiles: prepared.map((file) => file.patch.path),
        checkpointId: checkpoint.id,
        rollbackAvailable: true,
      };
    } catch (error) {
      for (const temporaryPath of temporaryPaths) rmSync(temporaryPath, { force: true });
      try {
        this.restoreStoredCheckpoint(checkpoint, false);
        this.setCheckpointState(checkpoint, "rolled-back");
      } catch (restoreError) {
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `Backfill failed and automatic restore was incomplete. Checkpoint ${checkpoint.id}: ${detail}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Restores durable transactions that were interrupted after their checkpoint
   * had been written but before every replacement was committed. It is safe to
   * call before starting a new wave and deliberately fails rather than hiding
   * a concurrent user edit.
   */
  recoverIncompleteTransactions(): BackfillRecoveryResult[] {
    const lock = this.acquireWorkspaceLock();
    try {
      if (!existsSync(this.#checkpointRoot)) return [];
      const recovered: BackfillRecoveryResult[] = [];
      for (const entry of readdirSync(this.#checkpointRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !/^checkpoint-[0-9A-Za-z-]+\.json$/.test(entry.name)) continue;
        const checkpointId = entry.name.slice(0, -".json".length);
        const checkpoint = this.readCheckpoint(checkpointId);
        if (checkpoint.state !== "prepared" && checkpoint.state !== "committing") continue;
        this.restoreStoredCheckpoint(checkpoint, false);
        this.setCheckpointState(checkpoint, "rolled-back");
        recovered.push({ checkpointId, state: "rolled-back" });
      }
      return recovered;
    } finally {
      this.releaseWorkspaceLock(lock);
    }
  }

  /** Restores a durable checkpoint after checking no later user edit is lost. */
  async restore(checkpointId: string): Promise<ApplyResult> {
    const lock = this.acquireWorkspaceLock();
    try {
      const checkpoint = this.readCheckpoint(checkpointId);
      this.restoreStoredCheckpoint(checkpoint, true);
      this.setCheckpointState(checkpoint, "rolled-back");
      return {
        appliedFiles: checkpoint.files.map((file) => file.path),
        checkpointId,
        rollbackAvailable: false,
      };
    } finally {
      this.releaseWorkspaceLock(lock);
    }
  }

  private prepare(patch: FilePatch): PreparedFile {
    const fullPath = this.resolvePatchPath(patch.path);
    if (patch.status === "created") {
      if (existsSync(fullPath)) {
        throw new Error(`Cannot create "${patch.path}": the file already exists.`);
      }
      // The demo contract is intentionally conservative: callers may create a
      // file only in an already-authorized directory, never by recursively
      // materializing arbitrary paths.
      const parent = dirname(fullPath);
      if (!existsSync(parent)) {
        throw new Error(`Cannot create "${patch.path}": parent directory is outside the project root.`);
      }
      const realParent = realpathSync(parent);
      if (!isSameOrInsideRoot(this.#projectRoot, realParent)) {
        throw new Error(`Cannot create "${patch.path}": parent directory is outside the project root.`);
      }
      return {
        patch,
        fullPath: join(realParent, basename(fullPath)),
        beforeContent: null,
        nextContent: Buffer.from(newFileContent(patch.hunks), "utf8"),
        afterSha256: sha256(Buffer.from(newFileContent(patch.hunks), "utf8")),
      };
    }

    const realFile = this.resolveExistingPatchPath(patch.path, "modify");
    const beforeContent = readFileSync(realFile);
    const actualHash = sha256(beforeContent);
    if (actualHash !== patch.expectedOriginalSha256) {
      throw new Error(
        `Target file changed since this migration run: "${patch.path}". Regenerate the patch before applying it.`,
      );
    }
    const nextContent = Buffer.from(
      applyHunksStrict(beforeContent.toString("utf8"), patch.hunks),
      "utf8",
    );
    return {
      patch,
      fullPath: realFile,
      beforeContent,
      nextContent,
      afterSha256: sha256(nextContent),
    };
  }

  private resolvePatchPath(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath)) {
      throw new Error("Patch paths must be non-empty project-relative paths.");
    }
    const fullPath = resolve(this.#projectRoot, relativePath);
    if (!isInsideRoot(this.#projectRoot, fullPath)) {
      throw new Error(`Patch path escapes the project root: "${relativePath}".`);
    }
    return fullPath;
  }

  private resolveExistingPatchPath(relativePath: string, action: "modify" | "restore"): string {
    const fullPath = this.resolvePatchPath(relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`Cannot ${action} "${relativePath}": file does not exist.`);
    }
    const realFile = realpathSync(fullPath);
    if (!isInsideRoot(this.#projectRoot, realFile)) {
      throw new Error(`Patch path escapes the project root: "${relativePath}".`);
    }
    return realFile;
  }

  private assertPreparedFilesStillCurrent(files: PreparedFile[]): void {
    for (const file of files) this.assertPreparedFileStillCurrent(file);
  }

  private assertPreparedFileStillCurrent(file: PreparedFile): void {
    if (file.patch.status === "created") {
      if (existsSync(file.fullPath)) {
        throw new Error(`Cannot create "${file.patch.path}": the file appeared during this transaction.`);
      }
      return;
    }
    if (!existsSync(file.fullPath) || realpathSync(file.fullPath) !== file.fullPath) {
      throw new Error(`Target file changed during this migration run: "${file.patch.path}".`);
    }
    const expected = file.beforeContent;
    if (!expected || sha256(readFileSync(file.fullPath)) !== sha256(expected)) {
      throw new Error(`Target file changed during this migration run: "${file.patch.path}".`);
    }
  }

  private writeCheckpoint(
    prepared: PreparedFile[],
    transactionId: string | undefined,
  ): StoredCheckpoint {
    mkdirSync(this.#checkpointRoot, { recursive: true, mode: 0o700 });
    const realCheckpointRoot = realpathSync(this.#checkpointRoot);
    if (!isInsideRoot(this.#projectRoot, realCheckpointRoot)) {
      throw new Error("Checkpoint directory resolves outside the configured project root.");
    }
    const id = checkpointId(transactionId);
    if (existsSync(this.checkpointPath(id))) {
      throw new Error(`Checkpoint already exists: ${id}`);
    }
    const checkpoint: StoredCheckpoint = {
      id,
      createdAt: new Date().toISOString(),
      recoverable: true,
      state: "prepared",
      files: prepared.map((file) => ({
        path: file.patch.path,
        status: file.patch.status,
        beforeSha256: file.beforeContent ? sha256(file.beforeContent) : null,
        afterSha256: file.afterSha256,
        beforeContentBase64: file.beforeContent?.toString("base64") ?? null,
      })),
    };
    this.persistCheckpoint(checkpoint);
    return checkpoint;
  }

  private readCheckpoint(checkpointId: string): StoredCheckpoint {
    if (!/^checkpoint-[0-9A-Za-z-]+$/.test(checkpointId)) {
      throw new Error("Invalid checkpoint id.");
    }
    const path = this.checkpointPath(checkpointId);
    if (!existsSync(path)) throw new Error(`Checkpoint not found: ${checkpointId}`);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isStoredCheckpoint(parsed)) throw new Error(`Checkpoint is malformed: ${checkpointId}`);
    return {
      ...parsed,
      // Checkpoints created before durable transaction states were introduced
      // have already returned successfully, so treat them as committed.
      state: parsed.state ?? "committed",
    };
  }

  private checkpointPath(checkpointId: string): string {
    return join(this.#checkpointRoot, `${checkpointId}.json`);
  }

  private setCheckpointState(
    checkpoint: StoredCheckpoint,
    state: BackfillTransactionState,
  ): void {
    checkpoint.state = state;
    this.persistCheckpoint(checkpoint);
  }

  private persistCheckpoint(checkpoint: StoredCheckpoint): void {
    writeFileSync(this.checkpointPath(checkpoint.id), JSON.stringify(checkpoint, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private acquireWorkspaceLock(): WorkspaceLock {
    mkdirSync(this.#lockRoot, { recursive: true, mode: 0o700 });
    const realLockRoot = realpathSync(this.#lockRoot);
    if (!isInsideRoot(this.#projectRoot, realLockRoot)) {
      throw new Error("Backfill lock directory resolves outside the configured project root.");
    }
    const path = join(realLockRoot, "backfill.lock");
    const token = randomUUID();
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
      writeFileSync(join(path, "owner"), token, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { path, token };
    } catch (error) {
      // If creating the marker failed after mkdir, the empty directory is ours
      // and can be cleaned safely. A non-empty/existing lock belongs to another
      // process and must remain untouched.
      const ownerPath = join(path, "owner");
      if (created && existsSync(path) && !existsSync(ownerPath)) {
        try {
          rmSync(path, { force: true, recursive: true });
        } catch {
          // Preserve the lock when its ownership cannot be established.
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Another backfill transaction is active or its lock is unavailable: ${detail}`);
    }
  }

  private releaseWorkspaceLock(lock: WorkspaceLock): void {
    const ownerPath = join(lock.path, "owner");
    try {
      if (!existsSync(ownerPath) || readFileSync(ownerPath, "utf8") !== lock.token) return;
      rmSync(lock.path, { force: true, recursive: true });
    } catch {
      // Keeping an uncertain lock is safer than deleting another process's
      // lease. An operator can inspect the durable checkpoint before recovery.
    }
  }

  private restoreStoredCheckpoint(checkpoint: StoredCheckpoint, verifyAfterHash: boolean): void {
    const restoreFiles: RestoreFile[] = checkpoint.files.map((snapshot) => {
      if (snapshot.status === "modified") {
        return {
          snapshot,
          fullPath: this.resolveExistingPatchPath(snapshot.path, "restore"),
          shouldRestore: true,
        };
      }
      const lexicalPath = this.resolvePatchPath(snapshot.path);
      if (!existsSync(lexicalPath)) {
        if (!verifyAfterHash) return { snapshot, fullPath: lexicalPath, shouldRestore: false };
        throw new Error(`Cannot restore "${snapshot.path}": target no longer exists.`);
      }
      const realFile = realpathSync(lexicalPath);
      if (!isInsideRoot(this.#projectRoot, realFile)) {
        throw new Error(`Patch path escapes the project root: "${snapshot.path}".`);
      }
      return { snapshot, fullPath: realFile, shouldRestore: true };
    });

    for (const file of restoreFiles) {
      if (!file.shouldRestore) continue;
      const currentHash = sha256(readFileSync(file.fullPath));
      if (verifyAfterHash) {
        if (currentHash !== file.snapshot.afterSha256) {
          throw new Error(
            `Cannot restore "${file.snapshot.path}": it changed after the migration was applied.`,
          );
        }
        continue;
      }

      // In a partially committed transaction, untouched files still contain
      // their before hash and must be left alone. A third hash means another
      // writer intervened, so never overwrite it during automatic recovery.
      if (file.snapshot.status === "modified" && currentHash === file.snapshot.beforeSha256) {
        file.shouldRestore = false;
      } else if (currentHash !== file.snapshot.afterSha256) {
        throw new Error(
          `Cannot safely roll back "${file.snapshot.path}": it changed during the transaction.`,
        );
      }
    }

    for (const file of restoreFiles) {
      if (!file.shouldRestore) continue;
      if (file.snapshot.status === "created") {
        if (existsSync(file.fullPath)) unlinkSync(file.fullPath);
        continue;
      }
      const before = file.snapshot.beforeContentBase64;
      if (before === null) throw new Error(`Checkpoint lacks original content for "${file.snapshot.path}".`);
      atomicWrite(file.fullPath, Buffer.from(before, "base64"), checkpoint.id);
    }
  }
}

function assertDistinctPaths(files: PreparedFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.fullPath)) {
      throw new Error(`A migration run contains duplicate target paths: "${file.patch.path}".`);
    }
    seen.add(file.fullPath);
  }
}

function temporarySibling(filePath: string, transactionId: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${transactionId}.tmp`);
}

function atomicWrite(filePath: string, content: Buffer, transactionId: string): void {
  const temporaryPath = temporarySibling(filePath, transactionId);
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isSameOrInsideRoot(root: string, candidate: string): boolean {
  return root === candidate || isInsideRoot(root, candidate);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
}

function checkpointId(transactionId: string | undefined): string {
  if (!transactionId) return `checkpoint-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(transactionId)) {
    throw new Error("Transaction id must contain only letters, digits, and hyphens.");
  }
  return `checkpoint-${transactionId}`;
}

function isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<StoredCheckpoint>;
  return (
    typeof checkpoint.id === "string" &&
    typeof checkpoint.createdAt === "string" &&
    typeof checkpoint.recoverable === "boolean" &&
    (checkpoint.state === undefined ||
      checkpoint.state === "prepared" ||
      checkpoint.state === "committing" ||
      checkpoint.state === "committed" ||
      checkpoint.state === "rolled-back") &&
    Array.isArray(checkpoint.files) &&
    checkpoint.files.length > 0 &&
    checkpoint.files.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as StoredCheckpointFile).path === "string" &&
        ((file as StoredCheckpointFile).status === "modified" ||
          (file as StoredCheckpointFile).status === "created") &&
        ((file as StoredCheckpointFile).status === "created"
          ? (file as StoredCheckpointFile).beforeSha256 === null &&
            (file as StoredCheckpointFile).beforeContentBase64 === null
          : typeof (file as StoredCheckpointFile).beforeSha256 === "string" &&
            typeof (file as StoredCheckpointFile).beforeContentBase64 === "string") &&
        typeof (file as StoredCheckpointFile).afterSha256 === "string",
    )
  );
}
