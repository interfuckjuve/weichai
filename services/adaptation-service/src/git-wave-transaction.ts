import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApplyResult, FilePatch } from "@forexplore/contracts";
import { BackfillAdapter } from "./backfill-adapter";

const ZERO_OID = "0".repeat(40);
const BRANCH_PREFIX = "codex/forexplore-migration/";
const TRANSACTION_TRAILER = "ForeXplore-Wave-Transaction";

export interface GitWaveTransactionRequest {
  repositoryRoot: string;
  branchName: string;
  transactionId: string;
  files: FilePatch[];
  /** Reject commit if a branch or source change moved the reviewed baseline. */
  expectedBaseCommit?: string;
  commitMessage: string;
  /** Required validation runs in the isolated worktree after every patch is applied. */
  validate?: (worktreeRoot: string) => Promise<void> | void;
  /**
   * Adds trusted ForeXplore artifacts after joint validation.  This keeps the
   * run manifest's validation evidence in the same commit as the approved
   * code without allowing a callback to add arbitrary source writes.
   */
  finalize?: (worktreeRoot: string) => Promise<FilePatch[]> | FilePatch[];
}

export interface GitWaveTransactionResult extends ApplyResult {
  branchName: string;
  baseCommit: string;
  commit: string;
}

export interface GitWavePreparationRequest {
  repositoryRoot: string;
  branchName: string;
  transactionId: string;
  files: FilePatch[];
  expectedBaseCommit?: string;
  /** Joint validation runs against the fully combined, isolated patch set. */
  validate?: (worktreeRoot: string) => Promise<void> | void;
}

export interface GitWavePreparationResult {
  branchName: string;
  baseCommit: string;
}

export interface GitWaveRecoveryResult {
  transactionId: string;
  state: "rolled-back";
}

export interface GitWavePublicationEvidence {
  transactionId: string;
  branchName: string;
  baseCommit: string;
  /** Optional live result; recovery can prove publication from the trailer alone. */
  commit?: string;
}

interface GitWaveJournal {
  version: 1;
  transactionId: string;
  branchName: string;
  baseCommit: string;
  state: "prepared" | "committing" | "committed" | "rolled-back";
  createdAt: string;
  updatedAt: string;
  temporaryRoot?: string;
  worktreeRoot?: string;
  checkpointIds?: string[];
  commit?: string;
  failureReason?: string;
}

/**
 * Commits one reviewed migration wave without ever partially changing the
 * caller's worktree. The resulting branch ref is the publication point; a
 * later wave starts from that ref and a failed wave leaves it untouched.
 */
export class GitWaveTransaction {
  /**
   * Resolves a durable transaction commit from the managed branch. This is
   * read-only and deliberately works even when the run manifest inside that
   * commit cannot contain its own object ID yet.
   */
  findPublishedTransactionCommit(
    repositoryRoot: string,
    evidence: GitWavePublicationEvidence,
  ): string | undefined {
    const root = resolve(repositoryRoot);
    assertGitRepository(root);
    assertSafeTransactionId(evidence.transactionId);
    assertManagedBranchName(root, evidence.branchName);
    if (!isCommitHash(evidence.baseCommit)) {
      throw new Error("Wave transaction base commit must be a full Git object ID.");
    }
    if (evidence.commit !== undefined && !isCommitHash(evidence.commit)) {
      throw new Error("Wave transaction commit must be a full Git object ID.");
    }
    return findPublishedCommit(root, evidence);
  }

  /**
   * Applies a wave only inside a disposable detached worktree and returns its
   * exact Git baseline after validation. Nothing is staged or published. The
   * caller can present the returned patch bundle and validation evidence for
   * human approval before calling `commit`.
   */
  async prepare(request: GitWavePreparationRequest): Promise<GitWavePreparationResult> {
    assertPreparationRequest(request);
    const repositoryRoot = resolve(request.repositoryRoot);
    assertGitRepository(repositoryRoot);
    assertNoTrackedChanges(repositoryRoot);
    this.recoverIncompleteTransactions(repositoryRoot);

    const existingTip = branchTip(repositoryRoot, request.branchName);
    const baseCommit = (existingTip ?? git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    assertExpectedBaseCommit(request.expectedBaseCommit, baseCommit);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "forexplore-wave-prepare-"));
    const worktreeRoot = join(temporaryRoot, "worktree");
    let journal = createJournal(request, baseCommit, temporaryRoot, worktreeRoot, "committing");
    writeJournal(repositoryRoot, journal);
    let worktreeAdded = false;
    let backfill: BackfillAdapter | undefined;
    let applied: ApplyResult | undefined;

    try {
      git(repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit]);
      worktreeAdded = true;
      backfill = new BackfillAdapter({ projectRoot: worktreeRoot });
      backfill.recoverIncompleteTransactions();
      applied = await backfill.applyTransaction(request.files, {
        transactionId: request.transactionId,
      });
      const approvedContent = captureApprovedContent(worktreeRoot, request.files);
      await request.validate?.(worktreeRoot);
      assertApprovedContentUnchanged(worktreeRoot, approvedContent, "Wave validation");
      journal = updateJournal(journal, "prepared", {
        checkpointIds: [applied.checkpointId],
        temporaryRoot: undefined,
        worktreeRoot: undefined,
      });
      writeJournal(repositoryRoot, journal);
      return { branchName: request.branchName, baseCommit };
    } catch (error) {
      if (backfill && applied) {
        try {
          await backfill.restore(applied.checkpointId);
        } catch {
          // This is a disposable detached worktree. If validation deliberately
          // changed a reviewed file, the worktree removal below is the safe
          // rollback; preserve the original validation failure for the host.
        }
      }
      journal = updateJournal(journal, "rolled-back", {
        failureReason: errorMessage(error),
      });
      writeJournal(repositoryRoot, journal);
      throw error;
    } finally {
      if (worktreeAdded) {
        try {
          git(repositoryRoot, ["worktree", "remove", "--force", worktreeRoot]);
        } catch {
          // The uniquely-created temporary root is removed below.
        }
      }
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }

  async commit(request: GitWaveTransactionRequest): Promise<GitWaveTransactionResult> {
    assertRequest(request);
    const repositoryRoot = resolve(request.repositoryRoot);
    assertGitRepository(repositoryRoot);
    assertNoTrackedChanges(repositoryRoot);
    this.recoverIncompleteTransactions(repositoryRoot, request.transactionId);

    const existingTip = branchTip(repositoryRoot, request.branchName);
    const baseCommit = (existingTip ?? git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    assertExpectedBaseCommit(request.expectedBaseCommit, baseCommit);
    const temporaryRoot = mkdtempSync(join(tmpdir(), "forexplore-wave-"));
    const worktreeRoot = join(temporaryRoot, "worktree");
    let journal = beginCommitJournal(repositoryRoot, request, baseCommit, temporaryRoot, worktreeRoot);
    let worktreeAdded = false;
    let backfill: BackfillAdapter | undefined;
    let applied: ApplyResult | undefined;
    let finalized: ApplyResult | undefined;
    let finalFiles: FilePatch[] = [];
    let commit: string | undefined;

    try {
      git(repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit]);
      worktreeAdded = true;
      backfill = new BackfillAdapter({ projectRoot: worktreeRoot });
      backfill.recoverIncompleteTransactions();
      applied = await backfill.applyTransaction(request.files, {
        transactionId: request.transactionId,
      });
      const approvedContent = captureApprovedContent(worktreeRoot, request.files);
      await request.validate?.(worktreeRoot);
      assertApprovedContentUnchanged(worktreeRoot, approvedContent, "Wave validation");

      finalFiles = await request.finalize?.(worktreeRoot) ?? [];
      assertManagedArtifactPatches(finalFiles);
      assertDistinctPaths([...request.files, ...finalFiles]);
      if (finalFiles.length > 0) {
        ensureManagedArtifactParents(worktreeRoot, finalFiles);
        finalized = await backfill.applyTransaction(finalFiles);
      }

      assertApprovedContentUnchanged(worktreeRoot, approvedContent, "Wave finalization");

      const expectedPaths = [...request.files, ...finalFiles]
        .map((file) => file.path)
        .sort();
      git(worktreeRoot, ["add", "--force", "--", ...expectedPaths]);
      assertOnlyExpectedPaths(worktreeRoot, expectedPaths);
      assertNoUnexpectedTrackedChanges(worktreeRoot);
      assertApprovedContentUnchanged(worktreeRoot, approvedContent, "Wave staging");
      git(worktreeRoot, [
        "commit",
        "--no-gpg-sign",
        "-m",
        request.commitMessage,
        "-m",
        `${TRANSACTION_TRAILER}: ${request.transactionId}`,
      ]);
      commit = git(worktreeRoot, ["rev-parse", "HEAD"]).trim();
      // Persist the commit candidate before publishing the branch ref. If the
      // process stops in the tiny interval after update-ref, recovery can
      // recognize the already-published commit instead of labelling it rolled
      // back and leaving the audit state contradictory.
      journal = updateJournal(journal, "committing", {
        checkpointIds: [
          applied.checkpointId,
          ...(finalized ? [finalized.checkpointId] : []),
        ],
        commit,
      });
      writeJournal(repositoryRoot, journal);
      git(repositoryRoot, [
        "update-ref",
        `refs/heads/${request.branchName}`,
        commit,
        existingTip ? baseCommit : ZERO_OID,
      ]);

      try {
        journal = updateJournal(journal, "committed", {
          commit,
          temporaryRoot: undefined,
          worktreeRoot: undefined,
        });
        writeJournal(repositoryRoot, journal);
      } catch {
        // The already-durable `committing` journal includes this commit hash.
        // A later startup will observe the published branch and complete the
        // journal transition without rolling the branch back.
      }

      return {
        ...applied,
        appliedFiles: [...applied.appliedFiles, ...(finalized?.appliedFiles ?? [])],
        branchName: request.branchName,
        baseCommit,
        commit,
      };
    } catch (error) {
      if (backfill && (applied || finalized)) {
        try {
          if (finalized) await backfill.restore(finalized.checkpointId);
          if (applied) await backfill.restore(applied.checkpointId);
        } catch {
          // The source repository is never written by this transaction. The
          // isolated worktree is removed in `finally`, so retain the original
          // error instead of masking it with a disposable-worktree restore.
        }
      }

      // `update-ref` and the final journal transition are separate durable
      // writes. Treat a published, transaction-marked commit as authoritative
      // even if an exception was raised after the ref update; otherwise this
      // catch path could write "rolled-back" while leaving the branch moved.
      let publishedCommit: string | undefined;
      let publicationCheckFailed = false;
      try {
        publishedCommit = findPublishedCommit(repositoryRoot, journal);
      } catch {
        publicationCheckFailed = true;
      }
      if (publishedCommit) {
        const matchesCurrentCommit = journal.commit === publishedCommit;
        journal = updateJournal(journal, "committed", {
          commit: publishedCommit,
          temporaryRoot: undefined,
          worktreeRoot: undefined,
        });
        try {
          writeJournal(repositoryRoot, journal);
        } catch {
          // The commit trailer lets the next startup finish this transition.
        }
        if (matchesCurrentCommit && applied) {
          return {
            ...applied,
            appliedFiles: [...applied.appliedFiles, ...(finalized?.appliedFiles ?? [])],
            branchName: request.branchName,
            baseCommit,
            commit: publishedCommit,
          };
        }
      } else if (publicationCheckFailed) {
        // A failed ref inspection is not evidence that publication failed.
        // Preserve a recoverable journal rather than claiming rollback.
        try {
          writeJournal(repositoryRoot, updateJournal(journal, "committing", {
            failureReason: `Could not determine branch publication after failure: ${errorMessage(error)}`,
          }));
        } catch {
          // Retain the original operation error; recovery will retry later.
        }
      } else {
        journal = updateJournal(journal, "rolled-back", {
          failureReason: errorMessage(error),
        });
        writeJournal(repositoryRoot, journal);
      }
      throw error;
    } finally {
      if (worktreeAdded) {
        try {
          git(repositoryRoot, ["worktree", "remove", "--force", worktreeRoot]);
        } catch {
          // The uniquely-created temporary root is removed below. A failed
          // worktree cleanup does not alter the caller's repository ref.
        }
      }
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }

  /**
   * An interrupted wave never writes the caller's worktree, but Git can retain
   * a disposable linked worktree after a process crash.  The journal lives in
   * Git metadata (not the repository) so recovery neither stages nor edits
   * application files.  Prepared bundles are intentionally invalidated on
   * restart: a host must regenerate, revalidate, and obtain a fresh approval.
   */
  recoverIncompleteTransactions(
    repositoryRoot: string,
    exceptTransactionId?: string,
  ): GitWaveRecoveryResult[] {
    const root = resolve(repositoryRoot);
    assertGitRepository(root);
    const recovered: GitWaveRecoveryResult[] = [];
    for (const journal of readJournals(root)) {
      if (journal.transactionId === exceptTransactionId) continue;
      if (journal.state !== "prepared" && journal.state !== "committing") continue;

      const publishedCommit = findPublishedCommit(root, journal);
      if (publishedCommit) {
        removeJournalWorktree(root, journal);
        writeJournal(root, updateJournal(journal, "committed", {
          commit: publishedCommit,
          temporaryRoot: undefined,
          worktreeRoot: undefined,
        }));
        continue;
      }

      removeJournalWorktree(root, journal);
      writeJournal(root, updateJournal(journal, "rolled-back", {
        failureReason: "Recovered an interrupted or uncommitted disposable wave transaction.",
        temporaryRoot: undefined,
        worktreeRoot: undefined,
      }));
      recovered.push({ transactionId: journal.transactionId, state: "rolled-back" });
    }
    return recovered;
  }
}

function branchTip(root: string, branchName: string): string | undefined {
  const tips = git(root, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branchName}`])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (tips.length > 1) {
    throw new Error(`Migration branch has multiple matching refs: ${branchName}`);
  }
  return tips[0];
}

/**
 * Finds durable publication evidence for a journal. A persisted candidate
 * hash is enough; when that write was lost in a crash, the commit trailer and
 * direct parent relationship reconstruct the same evidence from Git itself.
 */
function findPublishedCommit(root: string, evidence: GitWavePublicationEvidence): string | undefined {
  const tip = branchTip(root, evidence.branchName);
  if (!tip || !isCommitReachableFrom(root, evidence.baseCommit, tip)) return undefined;

  if (
    evidence.commit &&
    isCommitDirectChildOf(root, evidence.commit, evidence.baseCommit) &&
    isCommitReachableFrom(root, evidence.commit, tip) &&
    hasTransactionTrailer(root, evidence.commit, evidence.transactionId)
  ) {
    return evidence.commit;
  }

  const commits = git(root, ["rev-list", "--first-parent", `${evidence.baseCommit}..${tip}`])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const commit of commits) {
    if (
      isCommitDirectChildOf(root, commit, evidence.baseCommit) &&
      hasTransactionTrailer(root, commit, evidence.transactionId)
    ) {
      return commit;
    }
  }
  return undefined;
}

function isCommitReachableFrom(root: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const status = gitExitStatus(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error("Git could not determine migration branch ancestry.");
}

function isCommitDirectChildOf(root: string, commit: string, expectedParent: string): boolean {
  const parents = git(root, ["show", "-s", "--format=%P", commit])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parents.length === 1 && parents[0] === expectedParent;
}

function hasTransactionTrailer(root: string, commit: string, transactionId: string): boolean {
  const trailer = `${TRANSACTION_TRAILER}: ${transactionId}`;
  return git(root, ["show", "-s", "--format=%B", commit])
    .split(/\r?\n/)
    .some((line) => line.trimEnd() === trailer);
}

function beginCommitJournal(
  repositoryRoot: string,
  request: GitWaveTransactionRequest,
  baseCommit: string,
  temporaryRoot: string,
  worktreeRoot: string,
): GitWaveJournal {
  const existing = readJournal(repositoryRoot, request.transactionId);
  if (existing) {
    if (
      existing.state !== "prepared" ||
      existing.branchName !== request.branchName ||
      existing.baseCommit !== baseCommit
    ) {
      throw new Error("Wave preparation journal is stale or does not match the reviewed baseline.");
    }
    const journal = updateJournal(existing, "committing", {
      temporaryRoot,
      worktreeRoot,
      failureReason: undefined,
    });
    writeJournal(repositoryRoot, journal);
    return journal;
  }
  const journal = createJournal(request, baseCommit, temporaryRoot, worktreeRoot, "committing");
  writeJournal(repositoryRoot, journal);
  return journal;
}

function createJournal(
  request: Pick<GitWavePreparationRequest, "transactionId" | "branchName">,
  baseCommit: string,
  temporaryRoot: string,
  worktreeRoot: string,
  state: GitWaveJournal["state"],
): GitWaveJournal {
  const now = new Date().toISOString();
  return {
    version: 1,
    transactionId: request.transactionId,
    branchName: request.branchName,
    baseCommit,
    state,
    createdAt: now,
    updatedAt: now,
    temporaryRoot,
    worktreeRoot,
  };
}

function updateJournal(
  journal: GitWaveJournal,
  state: GitWaveJournal["state"],
  changes: Partial<Omit<GitWaveJournal, "version" | "transactionId" | "branchName" | "baseCommit" | "createdAt" | "state" | "updatedAt">> = {},
): GitWaveJournal {
  return {
    ...journal,
    ...changes,
    state,
    updatedAt: new Date().toISOString(),
  };
}

function transactionJournalDirectory(root: string): string {
  const gitDir = git(root, ["rev-parse", "--git-dir"]).trim();
  const directory = resolve(root, gitDir, "forexplore-wave-transactions");
  return directory;
}

function transactionJournalPath(root: string, transactionId: string): string {
  assertSafeTransactionId(transactionId);
  return join(transactionJournalDirectory(root), `${transactionId}.json`);
}

function writeJournal(root: string, journal: GitWaveJournal): void {
  const directory = transactionJournalDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = transactionJournalPath(root, journal.transactionId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(journal), { encoding: "utf8", mode: 0o600 });
  synchronizeFile(temporary);
  try {
    // Persist the candidate journal before Git publishes its branch ref. The
    // commit trailer remains a recovery proof on filesystems that cannot sync
    // a directory entry (notably Windows), but POSIX also flushes the rename.
    renameSync(temporary, target);
    synchronizeFile(target);
    synchronizeDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function synchronizeFile(filePath: string): void {
  const descriptor = openSync(filePath, "r");
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Node's fsync is not supported for regular descriptors on some Windows
      // filesystems. The atomically renamed journal plus Git commit trailer
      // remains the recovery proof there; do not turn a valid transaction
      // into an unrelated EPERM failure.
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL")) throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function synchronizeDirectory(directory: string): void {
  // Windows cannot open a directory descriptor with Node's fs APIs. The
  // copied commit trailer is the portable fallback for a lost rename entry.
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJournal(root: string, transactionId: string): GitWaveJournal | undefined {
  const target = transactionJournalPath(root, transactionId);
  if (!existsSync(target)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new Error(`Wave transaction journal is malformed: ${transactionId}`);
  }
  if (!isGitWaveJournal(value) || value.transactionId !== transactionId) {
    throw new Error(`Wave transaction journal is invalid: ${transactionId}`);
  }
  return value;
}

function readJournals(root: string): GitWaveJournal[] {
  const directory = transactionJournalDirectory(root);
  if (!existsSync(directory)) return [];
  const journals: GitWaveJournal[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const transactionId = entry.name.slice(0, -".json".length);
    assertSafeTransactionId(transactionId);
    const journal = readJournal(root, transactionId);
    if (journal) journals.push(journal);
  }
  return journals.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
}

function isGitWaveJournal(value: unknown): value is GitWaveJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const journal = value as Partial<GitWaveJournal>;
  return (
    journal.version === 1 &&
    typeof journal.transactionId === "string" &&
    isSafeTransactionId(journal.transactionId) &&
    typeof journal.branchName === "string" &&
    typeof journal.baseCommit === "string" &&
    (journal.state === "prepared" ||
      journal.state === "committing" ||
      journal.state === "committed" ||
      journal.state === "rolled-back") &&
    typeof journal.createdAt === "string" &&
    typeof journal.updatedAt === "string" &&
    (journal.temporaryRoot === undefined || typeof journal.temporaryRoot === "string") &&
    (journal.worktreeRoot === undefined || typeof journal.worktreeRoot === "string") &&
    (journal.checkpointIds === undefined ||
      (Array.isArray(journal.checkpointIds) && journal.checkpointIds.every((id) => typeof id === "string"))) &&
    (journal.commit === undefined || typeof journal.commit === "string") &&
    (journal.failureReason === undefined || typeof journal.failureReason === "string")
  );
}

function assertSafeTransactionId(value: string): void {
  if (!isSafeTransactionId(value)) {
    throw new Error("Wave transaction id must contain only letters, digits, and hyphens.");
  }
}

function isSafeTransactionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
}

function removeJournalWorktree(root: string, journal: GitWaveJournal): void {
  if (journal.worktreeRoot && isManagedTemporaryPath(journal.worktreeRoot)) {
    try {
      git(root, ["worktree", "remove", "--force", journal.worktreeRoot]);
    } catch {
      // A removed or never-added worktree is safe to clean from its unique
      // parent directory below. Do not touch any non-managed path.
    }
  }
  if (journal.temporaryRoot && isManagedTemporaryPath(journal.temporaryRoot)) {
    rmSync(journal.temporaryRoot, { force: true, recursive: true });
  }
}

function isManagedTemporaryPath(value: string): boolean {
  const root = resolve(tmpdir());
  const candidate = resolve(value);
  const rel = relative(root, candidate);
  return (
    Boolean(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) &&
    /^(?:forexplore-wave-|forexplore-wave-prepare-)/.test(rel.split(/[\\/]/)[0] ?? "")
  );
}

function captureApprovedContent(root: string, files: readonly FilePatch[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of files) {
    const fullPath = resolveInside(root, file.path);
    if (!existsSync(fullPath)) {
      throw new Error(`Applied wave file is missing before validation: ${file.path}`);
    }
    hashes.set(file.path, sha256(readFileSync(fullPath)));
  }
  return hashes;
}

function assertApprovedContentUnchanged(
  root: string,
  hashes: ReadonlyMap<string, string>,
  phase: string,
): void {
  for (const [filePath, expectedHash] of hashes) {
    const fullPath = resolveInside(root, filePath);
    if (!existsSync(fullPath) || sha256(readFileSync(fullPath)) !== expectedHash) {
      throw new Error(`${phase} modified an approved source path: ${filePath}`);
    }
  }
}

function resolveInside(root: string, filePath: string): string {
  const candidate = resolve(root, filePath);
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Wave patch path escapes its staging worktree: ${filePath}`);
  }
  return candidate;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRequest(request: GitWaveTransactionRequest): void {
  assertPreparationRequest(request);
  if (!request.commitMessage.trim()) throw new Error("Wave commit message is required.");
}

function assertPreparationRequest(request: GitWavePreparationRequest): void {
  if (!request.repositoryRoot.trim()) throw new Error("Repository root is required.");
  if (!request.transactionId.trim()) throw new Error("Wave transaction id is required.");
  if (request.files.length === 0) throw new Error("A wave must contain at least one patch.");
  assertManagedBranchName(resolve(request.repositoryRoot), request.branchName);
}

function assertManagedBranchName(root: string, branchName: string): void {
  if (!branchName.startsWith(BRANCH_PREFIX)) {
    throw new Error(`Migration branches must start with ${BRANCH_PREFIX}.`);
  }
  try {
    git(root, ["check-ref-format", "--branch", branchName]);
  } catch {
    throw new Error(`Invalid migration branch name: ${branchName}`);
  }
}

function isCommitHash(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function assertExpectedBaseCommit(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error("Wave baseline changed after preparation; regenerate and reapprove the patch bundle.");
  }
}

function assertGitRepository(root: string): void {
  if (tryGit(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    throw new Error("Module migration execution requires a Git worktree.");
  }
}

function assertNoTrackedChanges(root: string): void {
  const changes = git(root, ["status", "--porcelain", "--untracked-files=no"]).trim();
  if (changes) {
    throw new Error("Module migration execution requires no tracked changes in the source worktree.");
  }
}

function assertOnlyExpectedPaths(root: string, expectedPaths: string[]): void {
  const staged = git(root, ["diff", "--cached", "--name-only"])
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  if (
    staged.length !== expectedPaths.length ||
    staged.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error("Wave transaction staged files outside its approved write set.");
  }
}

function assertNoUnexpectedTrackedChanges(root: string): void {
  const unstaged = git(root, ["diff", "--name-only"])
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  if (unstaged.length > 0) {
    throw new Error("Wave validation modified tracked files outside the approved write set.");
  }
}

function assertDistinctPaths(files: readonly FilePatch[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new Error(`Wave transaction has duplicate patch path: ${file.path}`);
    }
    seen.add(file.path);
  }
}

function assertManagedArtifactPatches(files: readonly FilePatch[]): void {
  for (const file of files) {
    if (!isManagedArtifactPath(file.path)) {
      throw new Error(`Finalized wave artifacts must stay in .forexplore: ${file.path}`);
    }
  }
}

function isManagedArtifactPath(value: string): boolean {
  return (
    value === ".forexplore/module-summary.json" ||
    /^\.forexplore\/(?:analysis|runs)\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/.test(value)
  );
}

function ensureManagedArtifactParents(root: string, files: readonly FilePatch[]): void {
  for (const file of files) {
    const parent = resolve(root, dirname(file.path));
    const pathToParent = relative(root, parent);
    if (
      !pathToParent ||
      pathToParent === ".." ||
      pathToParent.startsWith(`..${sep}`) ||
      isAbsolute(pathToParent)
    ) {
      throw new Error(`Managed artifact parent escapes the staging worktree: ${file.path}`);
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed (${args.join(" ")}): ${detail}`, { cause: error });
  }
}

function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

function gitExitStatus(root: string, args: string[]): number {
  try {
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return 0;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      return error.status;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed (${args.join(" ")}): ${detail}`, { cause: error });
  }
}
