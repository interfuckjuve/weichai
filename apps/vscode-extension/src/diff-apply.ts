import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { PatchHunk } from '@forexplore/contracts';
import { applyHunksStrict } from '@forexplore/workflow-core';

export function parseHunkHeader(header: string): { oldStart: number } | null {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+/);
  return match?.[1] ? { oldStart: Number(match[1]) } : null;
}

/** Compatibility export with strict source-content preconditions. */
export function applyHunks(content: string, hunks: PatchHunk[]): string {
  return applyHunksStrict(content, hunks);
}

/**
 * Resolves only a relative path that remains inside the opened workspace.
 * Absolute paths and traversal are rejected instead of being treated as an
 * implementation detail supplied by a remote service or Webview.
 */
export function resolvePatchPath(workspaceRoot: string | undefined, filePath: string): string {
  if (!workspaceRoot) throw new Error('请先打开一个工作区文件夹，再应用迁移补丁。');
  if (!filePath || path.isAbsolute(filePath)) {
    throw new Error('补丁路径必须是工作区内的相对路径。');
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, filePath);
  const relativePath = path.relative(root, resolved);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('补丁路径超出当前工作区，已拒绝写入。');
  }
  return resolved;
}

export function canonicalWorkspacePath(workspaceRoot: string, filePath: string): string {
  return path.relative(path.resolve(workspaceRoot), resolvePatchPath(workspaceRoot, filePath)).replace(/\\/g, '/');
}

/**
 * A lexical `..` check is insufficient when a workspace contains symlinks.
 * Resolve both ends before a local write so a symlink cannot redirect the
 * approved relative target outside the opened workspace.
 */
export function resolveRealWorkspaceFile(workspaceRoot: string, filePath: string): string {
  const lexicalPath = resolvePatchPath(workspaceRoot, filePath);
  const realRoot = realpathSync(path.resolve(workspaceRoot));
  const realFile = realpathSync(lexicalPath);
  const relativePath = path.relative(realRoot, realFile);
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('补丁目标经符号链接解析后超出当前工作区，已拒绝写入。');
  }
  return realFile;
}
