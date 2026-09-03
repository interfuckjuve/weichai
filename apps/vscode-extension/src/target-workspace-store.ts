import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  TargetWorkspaceHostRecord,
  TargetWorkspaceHostStore,
  TargetWorkspaceHostStage,
} from './target-workspace-host';

const persistedTargetWorkspaceSchemaVersion = 1 as const;
const maximumRecordBytes = 64 * 1024 * 1024;
const recordLockTimeoutMs = 5_000;
const staleRecordLockMs = 30_000;
const stages = new Set<TargetWorkspaceHostStage>([
  'analysis-partial',
  'awaiting-module-review',
  'revision-required',
  'rejected',
  'status-inventory-failed',
  'reviewed',
  'body-only-compatible',
  'stale',
]);

interface PersistedTargetWorkspaceRecord {
  schemaVersion: typeof persistedTargetWorkspaceSchemaVersion;
  workspaceId: string;
  recordContentHash: string;
  record: TargetWorkspaceHostRecord;
}

export interface FileSystemTargetWorkspaceHostStoreOptions {
  /**
   * Host-owned local storage directory, normally a child of
   * `ExtensionContext.globalStorageUri.fsPath`. It must never originate from
   * a Webview message.
   */
  storageDirectory: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeWorkspaceId(value: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new Error('Target workspace store requires a normalized workspace ID.');
  }
  return value;
}

function recordContent(record: TargetWorkspaceHostRecord): string {
  const content = JSON.stringify(record);
  if (content === undefined) {
    throw new Error('Target workspace record is not JSON serializable.');
  }
  return content;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A full SHA-256 mapping keeps arbitrary logical workspace IDs out of file
 * paths. The ID is also stored inside the integrity-checked envelope so an
 * (extraordinarily unlikely) collision fails closed rather than crossing
 * workspace boundaries.
 */
export function targetWorkspaceRecordFileName(workspaceIdInput: string): string {
  const workspaceId = normalizeWorkspaceId(workspaceIdInput);
  const digest = sha256(`forexplore-target-workspace\0${workspaceId}`);
  return `target-workspace-${digest}.json`;
}

function assertArtifactIdentity(
  value: unknown,
  label: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isObject(value) || keys.some((key) => !isNonEmptyString(value[key]))) {
    throw new Error(`Persisted target workspace ${label} is malformed.`);
  }
}

function assertReadiness(value: unknown): void {
  if (
    !isObject(value) ||
    typeof value.ready !== 'boolean' ||
    !isStringArray(value.requiredCapabilities) ||
    !Array.isArray(value.blockingIssues) ||
    !isStringArray(value.missingOptionalCapabilities)
  ) {
    throw new Error('Persisted target workspace readiness is malformed.');
  }
}

function assertConstraints(value: unknown): void {
  if (!Array.isArray(value) || value.some((constraint) => (
    !isObject(constraint) ||
    !isNonEmptyString(constraint.id) ||
    !isNonEmptyString(constraint.description) ||
    typeof constraint.required !== 'boolean'
  ))) {
    throw new Error('Persisted target workspace constraints are malformed.');
  }
}

function assertAnalysisState(value: unknown, label: string): void {
  if (!isObject(value)) {
    throw new Error(`Persisted target workspace ${label} is malformed.`);
  }
  assertArtifactIdentity(value.analysis, `${label} analysis`, ['snapshotId', 'contentHash']);
  assertArtifactIdentity(value.ir, `${label} IR`, [
    'id',
    'repositoryId',
    'repositoryContentHash',
    'contentHash',
  ]);
}

function assertDiscovery(value: unknown): void {
  if (!isObject(value)) {
    throw new Error('Persisted target workspace discovery is malformed.');
  }
  assertArtifactIdentity(value.proposal, 'module proposal', [
    'id',
    'repositoryId',
    'sourceIrId',
    'sourceIrHash',
    'contentHash',
  ]);
  assertArtifactIdentity(value.draftCatalog, 'draft module catalog', [
    'id',
    'repositoryId',
    'sourceIrId',
    'sourceIrHash',
    'contentHash',
  ]);
}

function assertAccepted(value: unknown): void {
  assertAnalysisState(value, 'accepted state');
  if (!isObject(value)) return;
  assertArtifactIdentity(value.proposal, 'accepted proposal', [
    'id',
    'sourceIrId',
    'sourceIrHash',
    'contentHash',
  ]);
  assertArtifactIdentity(value.review, 'Gate1 review', [
    'id',
    'proposalId',
    'proposalHash',
    'sourceIrId',
    'sourceIrHash',
    'contentHash',
  ]);
  assertArtifactIdentity(value.catalog, 'accepted module catalog', [
    'id',
    'sourceIrId',
    'sourceIrHash',
    'sourceProposalId',
    'sourceProposalHash',
    'contentHash',
  ]);
  if (value.snapshot !== undefined) {
    assertArtifactIdentity(value.snapshot, 'implementation snapshot', [
      'id',
      'structureHash',
      'moduleBoundaryHash',
      'contentHash',
    ]);
  }
}

function assertOptionalFreshness(value: unknown): void {
  if (value === undefined) return;
  if (
    !isObject(value) ||
    !['current', 'body-only-compatible', 'stale'].includes(String(value.status)) ||
    !isStringArray(value.reasonCodes) ||
    !isNonEmptyString(value.currentStructureHash)
  ) {
    throw new Error('Persisted target workspace freshness is malformed.');
  }
}

function assertTimestamp(value: unknown, label: string): void {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Persisted target workspace ${label} is malformed.`);
  }
}

function assertTargetWorkspaceHostRecord(
  value: unknown,
  expectedWorkspaceId?: string,
): asserts value is TargetWorkspaceHostRecord {
  if (!isObject(value) || value.role !== 'target-workspace') {
    throw new Error('Persisted value is not a target workspace Host record.');
  }
  const workspaceId = normalizeWorkspaceId(String(value.workspaceId ?? ''));
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new Error('Persisted target workspace ID does not match its storage key.');
  }
  if (!isNonEmptyString(value.repositoryRoot) || !path.isAbsolute(value.repositoryRoot)) {
    throw new Error('Persisted target workspace repository root is malformed.');
  }
  if (!isNonEmptyString(value.stage) || !stages.has(value.stage as TargetWorkspaceHostStage)) {
    throw new Error('Persisted target workspace stage is malformed.');
  }
  assertAnalysisState(value.latest, 'latest analysis state');
  assertReadiness(value.readiness);
  assertConstraints(value.constraints);
  assertTimestamp(value.createdAt, 'createdAt');
  assertTimestamp(value.updatedAt, 'updatedAt');
  if (value.failure !== undefined && typeof value.failure !== 'string') {
    throw new Error('Persisted target workspace failure is malformed.');
  }
  if (value.discovery !== undefined) assertDiscovery(value.discovery);
  if (value.accepted !== undefined) assertAccepted(value.accepted);
  if (value.gate1Review !== undefined) {
    assertArtifactIdentity(value.gate1Review, 'Gate1 review', [
      'id',
      'proposalId',
      'proposalHash',
      'sourceIrId',
      'sourceIrHash',
      'contentHash',
    ]);
  }
  assertOptionalFreshness(value.freshness);

  if (value.stage === 'awaiting-module-review' && value.discovery === undefined) {
    throw new Error('Persisted target workspace awaiting Gate1 has no discovery proposal.');
  }
  if (
    ['reviewed', 'body-only-compatible'].includes(value.stage) &&
    (!isObject(value.accepted) || !isObject(value.accepted.snapshot))
  ) {
    throw new Error('Persisted current target workspace has no implementation snapshot.');
  }
  if (value.stage === 'status-inventory-failed' && value.accepted === undefined) {
    throw new Error('Persisted target workspace inventory failure has no accepted boundary.');
  }
}

function parseEnvelope(
  serialized: string,
  expectedWorkspaceId: string,
): TargetWorkspaceHostRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(
      `Persisted target workspace record is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !isObject(value) ||
    value.schemaVersion !== persistedTargetWorkspaceSchemaVersion ||
    value.workspaceId !== expectedWorkspaceId ||
    !isNonEmptyString(value.recordContentHash)
  ) {
    throw new Error('Persisted target workspace envelope is malformed or belongs to another workspace.');
  }
  assertTargetWorkspaceHostRecord(value.record, expectedWorkspaceId);
  const content = recordContent(value.record);
  if (sha256(content) !== value.recordContentHash) {
    throw new Error('Persisted target workspace record failed its integrity check.');
  }
  return structuredClone(value.record);
}

/**
 * Durable Host-only store for 01B target-workspace state. File paths are
 * derived exclusively from a SHA-256 of the Host-owned workspace ID. Webview
 * payloads are therefore neither storage paths nor persisted records.
 */
export class FileSystemTargetWorkspaceHostStore implements TargetWorkspaceHostStore {
  readonly #storageDirectory: string;

  constructor(options: FileSystemTargetWorkspaceHostStoreOptions) {
    if (
      !isNonEmptyString(options.storageDirectory) ||
      options.storageDirectory.includes('\0') ||
      !path.isAbsolute(options.storageDirectory)
    ) {
      throw new Error('Target workspace storage directory must be an explicit absolute path.');
    }
    this.#storageDirectory = path.resolve(options.storageDirectory);
  }

  async load(workspaceIdInput: string): Promise<TargetWorkspaceHostRecord | null> {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput);
    const destination = this.#recordPath(workspaceId);
    try {
      const stats = await lstat(destination);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('Persisted target workspace path is not a regular file.');
      }
      if (stats.size > maximumRecordBytes) {
        throw new Error('Persisted target workspace record exceeds the size limit.');
      }
      const serialized = await readFile(destination, 'utf8');
      if (Buffer.byteLength(serialized, 'utf8') > maximumRecordBytes) {
        throw new Error('Persisted target workspace record exceeds the size limit.');
      }
      return parseEnvelope(serialized, workspaceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(
    recordInput: TargetWorkspaceHostRecord,
    expectedRecord?: TargetWorkspaceHostRecord | null,
  ): Promise<void> {
    assertTargetWorkspaceHostRecord(recordInput);
    const record = structuredClone(recordInput);
    const workspaceId = normalizeWorkspaceId(record.workspaceId);
    if (expectedRecord !== undefined && expectedRecord !== null) {
      assertTargetWorkspaceHostRecord(expectedRecord, workspaceId);
    }
    const recordJson = recordContent(record);
    const envelope: PersistedTargetWorkspaceRecord = {
      schemaVersion: persistedTargetWorkspaceSchemaVersion,
      workspaceId,
      recordContentHash: sha256(recordJson),
      record,
    };
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > maximumRecordBytes) {
      throw new Error('Target workspace record exceeds the size limit.');
    }

    await this.#withRecordLock(workspaceId, async () => {
      if (expectedRecord !== undefined) {
        const current = await this.load(workspaceId);
        if (
          (expectedRecord === null && current !== null) ||
          (expectedRecord !== null && (
            current === null || recordContent(current) !== recordContent(expectedRecord)
          ))
        ) {
          throw new Error('Target workspace store compare-and-swap conflict.');
        }
      }

      const destination = this.#recordPath(workspaceId);
      const temporary = path.join(
        this.#storageDirectory,
        `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    });
  }

  async #withRecordLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#storageDirectory, { recursive: true });
    const lockPath = `${this.#recordPath(workspaceId)}.lock`;
    const deadline = Date.now() + recordLockTimeoutMs;
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stats = await lstat(lockPath).catch(() => undefined);
        if (stats && Date.now() - stats.mtimeMs > staleRecordLockMs) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('Target workspace store lock timed out.');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await lockHandle.writeFile(`${process.pid}\n`, 'utf8');
      await lockHandle.sync();
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  }

  #recordPath(workspaceId: string): string {
    const destination = path.join(
      this.#storageDirectory,
      targetWorkspaceRecordFileName(workspaceId),
    );
    if (path.dirname(destination) !== this.#storageDirectory) {
      throw new Error('Target workspace record path escaped its storage directory.');
    }
    return destination;
  }
}
