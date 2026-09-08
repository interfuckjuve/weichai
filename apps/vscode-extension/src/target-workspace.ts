import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

export function selectedTargetWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const selected = new Set(vscode.workspace.getConfiguration('forexplore')
    .get<string[]>('targetRepositoryPaths', []).map(normalize));
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
    folder.uri.scheme === 'file' && selected.has(normalize(folder.uri.fsPath)));
}

export async function addTargetWorkspace(mode: 'browse' | 'input' | 'workspace'): Promise<string | undefined> {
  let directory: string | undefined;
  if (mode === 'workspace') {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name, description: folder.uri.fsPath, directory: folder.uri.fsPath,
    })), { title: '选择目标工程', placeHolder: '选择已打开的工程目录' });
    directory = selected?.directory;
  } else if (mode === 'browse') {
    const selected = await vscode.window.showOpenDialog({
      title: '添加目标工程', openLabel: '添加目标目录',
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    });
    directory = selected?.[0]?.fsPath;
  } else {
    directory = await vscode.window.showInputBox({
      title: '添加目标工程', prompt: '目标工程的绝对目录路径',
      ignoreFocusOut: true,
      validateInput: (value) => path.isAbsolute(value.trim()) ? undefined : '请输入绝对目录路径',
    });
  }
  if (directory === undefined) return;
  directory = directory.trim();
  if (!path.isAbsolute(directory)) throw new Error('请输入目标工程的绝对目录路径。');
  let resolved: string;
  try {
    resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('目标目录不存在或不可访问，请检查路径。');
  }
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const config = vscode.workspace.getConfiguration('forexplore');
  const previous = config.get<string[]>('targetRepositoryPaths', []);
  const remember = async (workspacePath = resolved) => {
    if (!previous.some((entry) => normalize(path.resolve(entry)) === normalize(path.resolve(workspacePath)))) {
      await config.update('targetRepositoryPaths', [...previous, workspacePath], vscode.ConfigurationTarget.Global);
    }
  };
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') continue;
    const existing = await realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath);
    if (normalize(existing) === normalize(resolved)) {
      await remember(folder.uri.fsPath);
      return resolved;
    }
  }
  // Selecting the first folder can restart the extension host. Persist the
  // explicit choice before asking VS Code to change the workspace.
  await remember();
  if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(resolved) })) {
    await config.update('targetRepositoryPaths', previous, vscode.ConfigurationTarget.Global);
    throw new Error('无法添加目标目录，请等待工作区更新完成后重试。');
  }
  return resolved;
}
