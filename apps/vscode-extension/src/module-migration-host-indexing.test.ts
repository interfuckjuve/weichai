import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Vscode from 'vscode';
import type { RepositoryIngestionManifest } from '@forexplore/contracts';
import type { RepositoryIngestionInitializationResult } from './repository-ingestion-coordinator';

const mocks = vi.hoisted(() => ({
  workspaceFolders: [] as Vscode.WorkspaceFolder[],
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, task: () => Promise<unknown>) => task()),
}));

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Beside: 2 },
  window: {
    activeTextEditor: undefined,
    withProgress: mocks.withProgress,
    showInformationMessage: mocks.showInformationMessage,
    showErrorMessage: mocks.showErrorMessage,
  },
  workspace: {
    get workspaceFolders() { return mocks.workspaceFolders; },
    getWorkspaceFolder: vi.fn(),
  },
  Uri: {
    joinPath: vi.fn(),
    from: vi.fn(),
  },
}));

import { ModuleMigrationHost } from './module-migration-host';

const roots: string[] = [];

afterEach(async () => {
  mocks.workspaceFolders.splice(0);
  mocks.showInformationMessage.mockClear();
  mocks.showErrorMessage.mockClear();
  mocks.withProgress.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ModuleMigrationHost repository indexing', () => {
  it('automatically invokes dynamic initialization only after the immutable static snapshot is written', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forexplore-host-indexing-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'service.ts'), 'export class Service {}\n', 'utf8');
    const workspaceUri = {
      scheme: 'file',
      fsPath: root,
      toString: () => `file://${root.replaceAll('\\', '/')}`,
    } as Vscode.Uri;
    mocks.workspaceFolders.push({
      name: 'fixture',
      index: 0,
      uri: workspaceUri,
    });
    const workspaceState = {
      get: vi.fn(),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => []),
    };
    const previews = { show: vi.fn(async () => undefined) };
    const repositoryInitializer = vi.fn(async ({ analysis }: { analysis: { snapshotId: string; contentHash: string } }) => {
      await expect(stat(path.join(root, '.forexplore', 'analysis', `${analysis.snapshotId}.json`)))
        .resolves.toBeDefined();
      const manifest = {
        repositoryId: 'repository-fixture',
        repositoryContentHash: analysis.contentHash,
        status: 'awaiting-module-review',
        requestedCapabilities: [],
        completedCapabilities: [],
        artifacts: { knowledge: [] },
      } as unknown as RepositoryIngestionManifest;
      return {
        ingestionId: 'ingestion-fixture',
        manifestPath: '.forexplore/ingestion/ingestion-fixture/manifest.json',
        status: 'awaiting-module-review',
        manifest,
        reused: false,
        searchProjectionCount: 1,
      } satisfies RepositoryIngestionInitializationResult;
    });
    const host = new ModuleMigrationHost({
      context: { workspaceState } as unknown as Vscode.ExtensionContext,
      services: { refresh: vi.fn() } as never,
      output: { appendLine: vi.fn() } as unknown as Vscode.OutputChannel,
      previews: previews as never,
      repositoryInitializer,
    });

    await host.indexRepository();

    expect(repositoryInitializer).toHaveBeenCalledTimes(1);
    expect(host.state).toEqual(expect.objectContaining({
      stage: 'awaiting-module-review',
      ingestionId: 'ingestion-fixture',
      ingestionStatus: 'awaiting-module-review',
    }));
    expect(workspaceState.update).toHaveBeenCalledTimes(2);
    expect(previews.show).toHaveBeenCalledWith(
      'Repository module initialization',
      expect.objectContaining({
        dynamicInitialization: expect.objectContaining({
          humanModuleReviewRequired: true,
          moduleCatalogApproved: false,
          searchDatabaseUpserted: false,
        }),
      }),
    );
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('等待模块人工审阅'));
  });
});
