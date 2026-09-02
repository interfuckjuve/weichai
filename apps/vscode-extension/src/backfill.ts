import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import type {
  ApplyResult,
  FilePatch,
  MigrationCheckpointRefV2,
  WorkspaceCheckpoint,
  BackfillTransactionState,
} from '@forexplore/contracts';
import type { PatchHunk } from '@forexplore/contracts';
import { applyHunks } from './diff-apply';
import {
  canonicalWorkspacePath,
  resolvePatchPath,
  resolveRealWorkspaceFile,
} from './diff-apply';
import {
  interruptedRecoveryDecision,
  type InterruptedFileObservation,
} from './backfill-transaction';

interface StoredCheckpoint extends WorkspaceCheckpoint {
  workspaceUri: string;
  files: Array<
    WorkspaceCheckpoint['files'][number] & {
      beforeContentBase64: string | null;
    }
  >;
}

interface StoredTransactionMarker {
  checkpointId: string;
  workspaceUri: string;
  state: BackfillTransactionState;
  updatedAt: string;
}

export interface WorkspaceBackfillOptions {
  workspaceFolder: vscode.WorkspaceFolder;
  storageUri: vscode.Uri;
  /** Exact reviewed authorization set. Every patch path must be a member. */
  allowedTargetPaths: string[];
}

/**
 * Trusted local write-back. The Webview cannot provide its input directly:
 * callers pass an already-reviewed result held by the extension host.
 */
export class WorkspaceBackfill {
  constructor(private readonly options: WorkspaceBackfillOptions) {}

  async apply(files: FilePatch[]): Promise<ApplyResult> {
    await this.recoverInterrupted();
    if (files.length === 0) throw new Error('迁移补丁不包含任何文件。');
    const workspaceRoot = this.options.workspaceFolder.uri.fsPath;
    const allowed = new Set(this.options.allowedTargetPaths.map((item) =>
      canonicalWorkspacePath(workspaceRoot, item)));
    if (allowed.size !== this.options.allowedTargetPaths.length || allowed.size === 0) {
      throw new Error('迁移写回授权路径必须非空且唯一。');
    }
    const seen = new Set<string>();
    const prepared: Array<{
      patch: FilePatch;
      path: string;
      uri: vscode.Uri;
      beforeContentBase64: string | null;
      beforeSha256: string | null;
      afterSha256: string;
      nextContent: string;
      document?: vscode.TextDocument;
    }> = [];
    // Complete every hash, realpath, absence, dirty-document and hunk preflight
    // before creating a checkpoint or mutating any editor buffer.
    for (const patch of files) {
      const canonicalPath = canonicalWorkspacePath(workspaceRoot, patch.path);
      if (!allowed.has(canonicalPath) || seen.has(canonicalPath)) {
        throw new Error(`补丁路径未授权或重复：${canonicalPath}。`);
      }
      seen.add(canonicalPath);
      if (patch.status === 'modified') {
        const uri = vscode.Uri.file(resolveRealWorkspaceFile(workspaceRoot, patch.path));
        const originalBytes = await vscode.workspace.fs.readFile(uri);
        const originalHash = sha256(originalBytes);
        if (originalHash !== patch.expectedOriginalSha256) {
          throw new Error(`目标文件已变化：${canonicalPath}。`);
        }
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty) throw new Error(`目标文件有未保存编辑：${canonicalPath}。`);
        const nextContent = applyHunks(Buffer.from(originalBytes).toString('utf8'), patch.hunks);
        prepared.push({
          patch,
          path: canonicalPath,
          uri,
          beforeContentBase64: Buffer.from(originalBytes).toString('base64'),
          beforeSha256: originalHash,
          afterSha256: sha256(Buffer.from(nextContent, 'utf8')),
          nextContent,
          document,
        });
      } else {
        const uri = vscode.Uri.file(resolveAuthorizedCreatePath(workspaceRoot, patch.path));
        const nextContent = createdFileContent(patch.hunks);
        prepared.push({
          patch,
          path: canonicalPath,
          uri,
          beforeContentBase64: null,
          beforeSha256: null,
          afterSha256: sha256(Buffer.from(nextContent, 'utf8')),
          nextContent,
        });
      }
    }
    const checkpoint = await this.writeCheckpoint(prepared.map((item) => ({
      path: item.path,
      status: item.patch.status,
      beforeSha256: item.beforeSha256,
      afterSha256: item.afterSha256,
      beforeContentBase64: item.beforeContentBase64,
    })));

    let applied = false;
    try {
      await this.writeTransactionMarker(checkpoint.id, 'committing');
      const edit = new vscode.WorkspaceEdit();
      for (const item of prepared) {
        if (item.patch.status === 'created') {
          edit.createFile(item.uri, { ignoreIfExists: false, overwrite: false });
          edit.insert(item.uri, new vscode.Position(0, 0), item.nextContent);
        } else {
          const document = item.document!;
          edit.replace(
            item.uri,
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            item.nextContent,
          );
        }
      }
      applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('工作区编辑被拒绝，未写入任何文件。');
      for (const item of prepared) {
        const document = item.document ?? await vscode.workspace.openTextDocument(item.uri);
        if (!(await document.save())) {
          throw new Error(`补丁保存失败：${item.path}；正在恢复整个事务。`);
        }
      }
      for (const item of prepared) {
        const written = await vscode.workspace.fs.readFile(item.uri);
        if (sha256(written) !== item.afterSha256) {
          throw new Error(`写入后的文件哈希不匹配：${item.path}；正在恢复整个事务。`);
        }
      }
      await this.writeTransactionMarker(checkpoint.id, 'committed');
      return {
        appliedFiles: prepared.map((item) => item.path),
        checkpointId: checkpoint.id,
        rollbackAvailable: true,
      };
    } catch (error) {
      if (applied) {
        await this.restoreCheckpoint(checkpoint, true, true);
      }
      await this.writeTransactionMarker(checkpoint.id, 'rolled-back');
      throw error;
    }
  }

  async restore(checkpointId: string): Promise<ApplyResult> {
    const checkpoint = await this.readCheckpoint(checkpointId);
    await this.restoreCheckpoint(checkpoint, true);
    await this.writeTransactionMarker(checkpoint.id, 'rolled-back');
    return {
      appliedFiles: checkpoint.files.map((file) => file.path),
      checkpointId,
      rollbackAvailable: false,
    };
  }

  async checkpointRef(checkpointId: string): Promise<MigrationCheckpointRefV2> {
    const checkpoint = await this.readCheckpoint(checkpointId);
    return {
      id: checkpoint.id,
      contentHash: createHash('sha256')
        .update(JSON.stringify(checkpoint), 'utf8')
        .digest('hex'),
      recoverable: checkpoint.recoverable,
      createdAt: checkpoint.createdAt,
    };
  }

  /** Scans durable prepared/committing journals before a new mutation. A
   * mixed before/after state is safely rolled back; any third state blocks. */
  async recoverInterrupted(): Promise<string[]> {
    const directory = vscode.Uri.joinPath(this.options.storageUri, 'checkpoints');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }
    const recovered: string[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.state.json')) continue;
      const marker = await this.readTransactionMarker(name.slice(0, -'.state.json'.length));
      if (
        marker.workspaceUri !== this.options.workspaceFolder.uri.toString() ||
        (marker.state !== 'prepared' && marker.state !== 'committing')
      ) continue;
      const checkpoint = await this.readCheckpoint(marker.checkpointId);
      const observations = await this.observeCheckpoint(checkpoint);
      const decision = interruptedRecoveryDecision([...observations.values()]);
      if (decision === 'restore') {
        await this.restoreCheckpoint(checkpoint, false, true, observations);
      }
      await this.writeTransactionMarker(checkpoint.id, 'rolled-back');
      recovered.push(checkpoint.id);
    }
    return recovered;
  }

  private async writeCheckpoint(
    files: StoredCheckpoint['files'],
  ): Promise<StoredCheckpoint> {
    const checkpoint: StoredCheckpoint = {
      id: `ws-${randomUUID()}`,
      workspaceUri: this.options.workspaceFolder.uri.toString(),
      createdAt: new Date().toISOString(),
      recoverable: true,
      files,
    };
    const directory = vscode.Uri.joinPath(this.options.storageUri, 'checkpoints');
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(
      this.checkpointUri(checkpoint.id),
      Buffer.from(JSON.stringify(checkpoint, null, 2), 'utf8'),
    );
    await this.writeTransactionMarker(checkpoint.id, 'prepared');
    return checkpoint;
  }

  private async readCheckpoint(checkpointId: string): Promise<StoredCheckpoint> {
    if (!/^ws-[0-9a-f-]+$/i.test(checkpointId)) throw new Error('恢复点标识无效。');
    const bytes = await vscode.workspace.fs.readFile(this.checkpointUri(checkpointId));
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isStoredCheckpoint(parsed)) throw new Error('恢复点内容无效。');
    return parsed;
  }

  private checkpointUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.options.storageUri, 'checkpoints', `${id}.json`);
  }

  private transactionMarkerUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.options.storageUri, 'checkpoints', `${id}.state.json`);
  }

  private async writeTransactionMarker(
    checkpointId: string,
    state: BackfillTransactionState,
  ): Promise<void> {
    const marker: StoredTransactionMarker = {
      checkpointId,
      workspaceUri: this.options.workspaceFolder.uri.toString(),
      state,
      updatedAt: new Date().toISOString(),
    };
    await vscode.workspace.fs.writeFile(
      this.transactionMarkerUri(checkpointId),
      Buffer.from(JSON.stringify(marker, null, 2), 'utf8'),
    );
  }

  private async readTransactionMarker(checkpointId: string): Promise<StoredTransactionMarker> {
    const bytes = await vscode.workspace.fs.readFile(this.transactionMarkerUri(checkpointId));
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<StoredTransactionMarker>;
    if (
      value.checkpointId !== checkpointId ||
      typeof value.workspaceUri !== 'string' ||
      !['prepared', 'committing', 'committed', 'rolled-back'].includes(value.state ?? '') ||
      typeof value.updatedAt !== 'string'
    ) throw new Error(`Invalid backfill transaction marker: ${checkpointId}.`);
    return value as StoredTransactionMarker;
  }

  private async observeCheckpoint(
    checkpoint: StoredCheckpoint,
  ): Promise<Map<string, InterruptedFileObservation>> {
    this.assertCheckpointWorkspace(checkpoint);
    const workspaceRoot = this.options.workspaceFolder.uri.fsPath;
    const authorization = this.options.allowedTargetPaths.length > 0
      ? this.options.allowedTargetPaths
      : checkpoint.files.map((file) => file.path);
    const allowed = new Set(authorization.map((item) =>
      canonicalWorkspacePath(workspaceRoot, item)));
    const observations = new Map<string, InterruptedFileObservation>();
    for (const file of checkpoint.files) {
      const canonicalPath = canonicalWorkspacePath(workspaceRoot, file.path);
      if (!allowed.has(canonicalPath)) throw new Error('Interrupted checkpoint exceeds current authorization.');
      const uri = vscode.Uri.file(resolvePatchPath(workspaceRoot, file.path));
      let bytes: Uint8Array | null;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
        bytes = null;
      }
      if (file.status === 'created' && bytes === null) {
        observations.set(file.path, 'before');
        continue;
      }
      if (bytes === null) {
        observations.set(file.path, 'unknown');
        continue;
      }
      const hash = sha256(bytes);
      observations.set(
        file.path,
        hash === file.afterSha256
          ? 'after'
          : hash === file.beforeSha256
            ? 'before'
            : 'unknown',
      );
    }
    return observations;
  }

  private async restoreCheckpoint(
    checkpoint: StoredCheckpoint,
    verifyAfterHash: boolean,
    allowDirtyForInternalRecovery = false,
    interruptedStates?: ReadonlyMap<string, InterruptedFileObservation>,
  ): Promise<void> {
    this.assertCheckpointWorkspace(checkpoint);
    const workspaceRoot = this.options.workspaceFolder.uri.fsPath;
    const authorization = this.options.allowedTargetPaths.length > 0
      ? this.options.allowedTargetPaths
      : checkpoint.files.map((file) => file.path);
    const allowed = new Set(authorization.map((item) =>
      canonicalWorkspacePath(workspaceRoot, item)));
    const prepared: Array<{
      file: StoredCheckpoint['files'][number];
      uri: vscode.Uri;
      document?: vscode.TextDocument;
      original?: string;
    }> = [];
    for (const file of checkpoint.files) {
      const canonicalPath = canonicalWorkspacePath(workspaceRoot, file.path);
      if (!allowed.has(canonicalPath)) throw new Error('恢复点的目标超出当前迁移范围。');
      const observed = interruptedStates?.get(file.path);
      if (observed === 'before') continue;
      if (observed === 'unknown') throw new Error(`Interrupted file state is unknown: ${file.path}.`);
      const lexical = resolvePatchPath(workspaceRoot, file.path);
      const uri = vscode.Uri.file(file.status === 'modified'
        ? resolveRealWorkspaceFile(workspaceRoot, file.path)
        : lexical);
      const current = await vscode.workspace.fs.readFile(uri);
      if (verifyAfterHash && sha256(current) !== file.afterSha256) {
        throw new Error(`目标文件在应用后又被修改：${file.path}，拒绝覆盖新修改。`);
      }
      if (file.status === 'modified') {
        if (file.beforeContentBase64 === null) throw new Error('修改文件恢复点缺少原始内容。');
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty && !allowDirtyForInternalRecovery) {
          throw new Error(`目标文件有未保存编辑：${file.path}。`);
        }
        prepared.push({
          file,
          uri,
          document,
          original: Buffer.from(file.beforeContentBase64, 'base64').toString('utf8'),
        });
      } else {
        prepared.push({ file, uri });
      }
    }
    const edit = new vscode.WorkspaceEdit();
    for (const item of prepared) {
      if (item.file.status === 'created') {
        edit.deleteFile(item.uri, { ignoreIfNotExists: false, recursive: false });
      } else {
        const document = item.document!;
        edit.replace(
          item.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          item.original!,
        );
      }
    }
    if (prepared.length > 0) {
      const restored = await vscode.workspace.applyEdit(edit);
      if (!restored) throw new Error('恢复点写入被工作区拒绝。');
    }
    for (const item of prepared) {
      if (item.file.status === 'created') continue;
      if (!(await item.document!.save())) throw new Error(`恢复内容无法保存：${item.file.path}。`);
      const written = await vscode.workspace.fs.readFile(item.uri);
      if (sha256(written) !== item.file.beforeSha256) {
        throw new Error(`恢复后的文件哈希不匹配：${item.file.path}。`);
      }
    }
  }

  private assertCheckpointWorkspace(checkpoint: StoredCheckpoint): void {
    if (checkpoint.workspaceUri !== this.options.workspaceFolder.uri.toString()) {
      throw new Error('恢复点不属于当前工作区。');
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const checkpoint = value as Partial<StoredCheckpoint>;
  const files = checkpoint.files;
  return (
    typeof checkpoint.id === 'string' &&
    typeof checkpoint.workspaceUri === 'string' &&
    checkpoint.workspaceUri.length > 0 &&
    typeof checkpoint.createdAt === 'string' &&
    checkpoint.recoverable === true &&
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((file) =>
      typeof file.path === 'string' &&
      (file.status === 'modified' || file.status === 'created') &&
      (file.beforeSha256 === null || typeof file.beforeSha256 === 'string') &&
      typeof file.afterSha256 === 'string' &&
      (file.beforeContentBase64 === null || typeof file.beforeContentBase64 === 'string'))
  );
}

function resolveAuthorizedCreatePath(workspaceRoot: string, filePath: string): string {
  const lexical = resolvePatchPath(workspaceRoot, filePath);
  if (existsSync(lexical)) throw new Error(`新建文件已存在：${filePath}。`);
  const parent = path.dirname(lexical);
  const realRoot = realpathSync(path.resolve(workspaceRoot));
  const realParent = realpathSync(parent);
  const relativeParent = path.relative(realRoot, realParent);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error('新建文件父目录经符号链接解析后超出工作区。');
  }
  return path.join(realParent, path.basename(lexical));
}

function createdFileContent(hunks: PatchHunk[]): string {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  if (lines.length === 0 || lines.some((line) => line.type !== 'add')) {
    throw new Error('新建文件补丁只能包含有内容的 add 行。');
  }
  return lines.map((line) => line.content).join('\n');
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}
