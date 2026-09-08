import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectAnalysisResult, ProjectAnalysisScope, StructuralIndex } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from './index.js';
import { ProjectAnalysisCoordinator, projectAnalysisObjective, projectPlanHash } from './project-analysis.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function result(index: StructuralIndex, scope: ProjectAnalysisScope): ProjectAnalysisResult {
  const files = index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath);
  const symbols = index.symbols.filter((symbol) => symbol.projectId === scope.projectId);
  const proposal = {
    ...scope,
    analysisHash: index.analysisHash,
    objective: projectAnalysisObjective,
    summary: 'Payment processing modules',
    unassignedFiles: [],
    modules: [{
      id: 'payments',
      kind: 'feature',
      name: 'Payment processing',
      description: 'Submits and confirms customer payments.',
      purpose: 'Handle payment submission',
      coreApis: ['submitPayment'],
      sourceFiles: files,
      symbolKeys: symbols.map((symbol) => symbol.symbolKey),
      dependsOn: [],
      evidenceIds: [`project:${scope.projectId}`],
    }],
  };
  return {
    proposal,
    evidence: {
      ...scope,
      analysisHash: index.analysisHash,
      planHash: projectPlanHash(proposal),
      evidenceIds: [`project:${scope.projectId}`],
    },
  };
}

describe('module implementation search', () => {
  it('retrieves a reviewed module before returning only symbols owned by that module', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-module-search-'));
    roots.push(root);
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'package.json'), '{"name":"payments"}');
    await writeFile(path.join(root, 'src/payment.ts'), [
      'export class PaymentService {',
      '  submitPayment(amount: number) { return amount > 0; }',
      '}',
    ].join('\n'));

    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await runtime.registry.register({
      repositoryId: 'history-payments',
      displayName: 'payments-history',
      localPath: root,
      role: 'history',
    });
    const run = await runtime.coordinator.run({ repositoryId: 'history-payments' });
    const index = (await runtime.store.getStructuralIndex(run.scope))!;
    const project = index.projects[0]!;
    const scope = { ...run.scope, projectId: project.projectId };
    const analysis = new ProjectAnalysisCoordinator({ store: runtime.store, plan: async () => result(index, scope) });
    await analysis.ensure(scope);

    const candidates = await runtime.moduleImplementationSearch.search({
      target: {
        id: 'target-submit',
        name: 'submitPayment',
        kind: 'function',
        path: 'src/PaymentService.cs',
        language: 'C#',
        signature: 'bool SubmitPayment(decimal amount)',
      },
      requirement: 'submit and confirm a payment',
      topK: 3,
      repositoryIds: ['history-payments'],
    });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repository: 'payments-history',
        title: expect.stringContaining('submitPayment'),
        preview: expect.stringContaining('submitPayment'),
        sourceModule: expect.objectContaining({ moduleId: 'payments', name: 'Payment processing' }),
      }),
    ]));
    expect(candidates.every((candidate) => candidate.sourceModule?.analysisRevision === run.scope.analysisRevision)).toBe(true);
  });

  it('rejects searches without an explicitly scoped historical corpus', async () => {
    const runtime = await createCodeIntelligenceRuntime({ store: new InMemoryIndexStore() });
    await expect(runtime.moduleImplementationSearch.search({
      target: { id: 'target', name: 'run', kind: 'function', path: 'run.ts', language: 'TypeScript', signature: 'run()' },
      requirement: '',
      topK: 1,
      repositoryIds: [],
    })).rejects.toThrow(/参考工程/);
  });
});
