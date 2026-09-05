import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryIndexStore } from './index-store.js';
import { createCodeIntelligenceRuntime } from './index.js';

const temporaryRoots: string[] = [];

async function repositoryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-code-intelligence-'));
  temporaryRoots.push(root);
  return root;
}

async function source(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('versioned repository pipeline', () => {
  it('indexes two registered repositories independently and incrementally reparses only changed files', async () => {
    const firstRoot = await repositoryRoot();
    const secondRoot = await repositoryRoot();
    await source(firstRoot, 'package.json', '{"name":"first","type":"module"}\n');
    await source(firstRoot, 'src/contracts.ts', 'export interface Contract { value: string }\n');
    await source(firstRoot, 'src/service.ts', 'import { Contract } from "./contracts";\nexport class Service { run(value: Contract) { return value.value; } }\n');
    await source(secondRoot, 'src/only.py', 'class Second:\n    pass\n');

    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    const first = await runtime.registry.register({
      repositoryId: 'history-one',
      displayName: 'History one',
      localPath: firstRoot,
      role: 'history',
    });
    const second = await runtime.registry.register({
      repositoryId: 'history-two',
      displayName: 'History two',
      localPath: secondRoot,
      role: 'history',
    });

    const firstRun = await runtime.coordinator.run({ repositoryId: first.repositoryId });
    const secondRun = await runtime.coordinator.run({ repositoryId: second.repositoryId });
    expect(firstRun.status).toBe('ready');
    expect(secondRun.status).toBe('ready');
    expect((await runtime.store.listSearchDocuments(firstRun.scope)).length).toBeGreaterThan(0);
    expect((await runtime.store.listSearchDocuments(secondRun.scope)).length).toBeGreaterThan(0);
    const projectedService = await runtime.store.searchSearchDocuments?.(firstRun.scope, 'Service', 10);
    expect(projectedService).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'symbol', symbolKey: expect.any(String) }),
    ]));

    const firstSymbols = await runtime.queryPort.searchSymbols({
      ...firstRun.scope,
      query: 'Service',
    });
    expect(firstSymbols.symbols.some((symbol) => symbol.value.kind === 'class' && symbol.value.name === 'Service'))
      .toBe(true);
    const secondSymbols = await runtime.queryPort.searchSymbols({
      ...secondRun.scope,
      query: 'Second',
    });
    expect(secondSymbols.symbols).toHaveLength(1);

    await source(firstRoot, 'src/service.ts', 'import { Contract } from "./contracts";\nexport class Service { next(value: Contract) { return value.value.toUpperCase(); } }\n');
    const incremental = await runtime.coordinator.run({
      repositoryId: first.repositoryId,
      mode: 'incremental',
      changedPaths: ['src/service.ts'],
    });
    expect(incremental.scope.analysisRevision).not.toBe(firstRun.scope.analysisRevision);
    expect(incremental.reusedFileCount).toBeGreaterThanOrEqual(1);
    expect((await runtime.registry.get(first.repositoryId))?.activeRevision).toBe(incremental.scope.analysisRevision);
    // The second repository was not reprojected or cleared while the first
    // moved to its replacement revision.
    expect((await runtime.registry.get(second.repositoryId))?.activeRevision).toBe(secondRun.scope.analysisRevision);
    expect((await runtime.store.listSearchDocuments(secondRun.scope)).length).toBeGreaterThan(0);
  });
});
