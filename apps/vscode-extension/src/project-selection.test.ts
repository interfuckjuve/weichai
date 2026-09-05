// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from '@forexplore/code-intelligence-service';
import { CodeIntelligenceHost } from './code-intelligence-host';

it('waits for an explicit project choice in a target directory containing multiple projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-project-choice-'));
  const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
  const ensure = vi.fn(async () => {});
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => runtime,
    planProject: async () => { throw new Error('The test must not invoke a model.'); },
    projectAnalysisPort: { ensure, idle: async () => {}, read: async (scope) => ({ ...scope,
      state: 'missing', projection: 'pending', analysisProfile: 'code-understanding/v1', updatedAt: '' }) },
  });
  try {
    for (const name of ['first-project', 'second-project']) {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name }));
      await writeFile(path.join(directory, 'index.ts'), 'export function run() { return 1; }');
    }
    const result = await host.synchronize({ repositories: [{ localPath: root, role: 'target' }] });
    const repository = result.presentation.repositories[0]!;
    expect(repository.projects).toHaveLength(2);
    expect(repository.selectedProjectId).toBeNull();
    expect(await host.explorerData()).toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
    const selected = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision!,
      projectId: repository.projects[1]!.projectId };
    await host.selectProjectForDisplay(selected);
    await host.waitForProjects();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(selected, false);
    expect((await host.explorerData())[0]!.projectId).toBe(selected.projectId);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
