// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  showOpenDialog: vi.fn(), showInputBox: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(),
  update: vi.fn(), selectedPaths: [] as string[],
  updateWorkspaceFolders: vi.fn(), folders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
}));
vi.mock('vscode', () => ({
  window: api,
  workspace: { get workspaceFolders() { return api.folders; }, updateWorkspaceFolders: api.updateWorkspaceFolders,
    getConfiguration: () => ({ get: () => api.selectedPaths, update: api.update }) },
  ConfigurationTarget: { Global: 1 },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));
import { addTargetWorkspace, selectedTargetWorkspaceFolders } from './target-workspace';

let root: string;
beforeEach(async () => {
  vi.resetAllMocks(); api.folders = []; api.selectedPaths = [];
  api.update.mockImplementation(async (_key, value) => { api.selectedPaths = value; });
  api.updateWorkspaceFolders.mockReturnValue(true);
  root = await mkdtemp(path.join(tmpdir(), 'forexplore-target-dir-'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('adds the directory selected in the native picker', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  await addTargetWorkspace('browse');
  expect(api.updateWorkspaceFolders).toHaveBeenCalledWith(0, 0, { uri: { scheme: 'file', fsPath: root } });
});

it('accepts an entered path and prevents duplicate folders', async () => {
  api.showInputBox.mockResolvedValue(` ${root} `);
  await addTargetWorkspace('input');
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  await addTargetWorkspace('input');
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
});

it('rejects files and nonexistent directories without changing the workspace', async () => {
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'test');
  for (const value of [file, path.join(root, 'missing')]) {
    api.showInputBox.mockResolvedValue(value);
    await expect(addTargetWorkspace('input')).rejects.toThrow('目标目录');
  }
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('does nothing when the picker is cancelled', async () => {
  api.showOpenDialog.mockResolvedValue(undefined);
  await addTargetWorkspace('browse');
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

it('does not treat an open parent workspace as a selected target', async () => {
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  expect(selectedTargetWorkspaceFolders()).toEqual([]);
  api.showQuickPick.mockResolvedValue({ directory: root });
  expect(await addTargetWorkspace('workspace')).toBe(root);
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('restores target selections when VS Code refuses to add the folder', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  api.updateWorkspaceFolders.mockReturnValue(false);
  await expect(addTargetWorkspace('browse')).rejects.toThrow('无法添加目标目录');
  expect(api.selectedPaths).toEqual([]);
});
