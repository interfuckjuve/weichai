import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ModuleSummary,
  ModuleTarget,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { buildModuleExplorer, workspacePresentationFromAnalysis } from './module-explorer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

const analysis: RepositoryStaticAnalysis = {
  schemaVersion: '1.0',
  snapshotId: 'snapshot-module-ui',
  contentHash: 'analysis-hash',
  analyzerVersion: 'test',
  createdAt: '2026-09-01T00:00:00.000Z',
  repository: { revision: '0123456789abcdef' },
  files: [
    { path: 'src/Payments/PaymentService.cs', sha256: 'a', role: 'source', language: 'C#', project: 'Payments.csproj' },
    { path: 'src/Orders/OrderService.cs', sha256: 'b', role: 'source', language: 'C#', project: 'Orders.csproj' },
  ],
  symbols: [
    {
      id: 'payment-class',
      name: 'PaymentService',
      qualifiedName: 'Payments.PaymentService',
      kind: 'class',
      language: 'C#',
      path: 'src/Payments/PaymentService.cs',
      range: { path: 'src/Payments/PaymentService.cs', startLine: 3, endLine: 12 },
      signature: 'public class PaymentService',
      project: 'Payments.csproj',
    },
    {
      id: 'payment-method',
      name: 'Pay',
      qualifiedName: 'Payments.PaymentService.Pay',
      kind: 'method',
      language: 'C#',
      path: 'src/Payments/PaymentService.cs',
      range: { path: 'src/Payments/PaymentService.cs', startLine: 5, endLine: 9 },
      signature: 'public void Pay()',
      project: 'Payments.csproj',
    },
    {
      id: 'order-method',
      name: 'Create',
      qualifiedName: 'Orders.OrderService.Create',
      kind: 'method',
      language: 'C#',
      path: 'src/Orders/OrderService.cs',
      range: { path: 'src/Orders/OrderService.cs', startLine: 4, endLine: 7 },
      signature: 'public void Create()',
      project: 'Orders.csproj',
    },
  ],
  dependencies: [
    {
      id: 'dep-1',
      sourcePath: 'src/Payments/PaymentService.cs',
      targetPath: 'src/Orders/OrderService.cs',
      kind: 'invocation',
      internal: true,
      resolution: 'resolved',
      evidence: 'syntactic',
      evidenceRanges: [],
      snapshotId: 'snapshot-module-ui',
    },
  ],
  diagnostics: [],
};

const currentTarget: ModuleTarget = {
  id: 'workspace://src/Payments/PaymentService.cs#L5',
  name: 'Pay',
  kind: 'function',
  path: 'src/Payments/PaymentService.cs',
  language: 'C#',
  signature: 'public void Pay()',
  line: 5,
  implementationStatus: 'unimplemented',
};

describe('module explorer host transform', () => {
  it('builds module/file/type/method hierarchy and a host-owned target catalog', () => {
    const result = workspacePresentationFromAnalysis({
      analysis,
      contents: new Map([
        ['src/Payments/PaymentService.cs', 'namespace Payments;\n\nclass PaymentService {\n\n void Pay() { throw new NotImplementedException(); }\n}'],
        ['src/Orders/OrderService.cs', 'namespace Orders;\nclass OrderService {\n void Create() { Save(); }\n}'],
      ]),
      currentTarget,
      mode: 'target',
      name: 'Target Workspace',
      rootLabel: 'target',
    });

    expect(result.presentation.stats).toMatchObject({
      modules: 2,
      files: 2,
      types: 1,
      methods: 2,
      dependencies: 1,
      unimplemented: 2,
      implemented: 1,
    });
    expect(result.targets.get(currentTarget.id)).toMatchObject({
      name: 'Pay',
      path: currentTarget.path,
      implementationStatus: 'unimplemented',
    });
    const payments = result.presentation.tree.find((node) => node.name === 'Payments');
    expect(payments?.kind).toBe('module');
    expect(JSON.stringify(payments)).toContain('PaymentService.cs');
    expect(JSON.stringify(payments)).toContain('Pay');
  });

  it('uses a committed module summary as the functional module boundary', () => {
    const summary = moduleSummary();
    const result = workspacePresentationFromAnalysis({
      analysis,
      mode: 'history',
      name: 'History',
      rootLabel: 'history',
      summary,
    });

    expect(result.presentation.tree.map((node) => node.name)).toEqual([
      '支付模块',
      '订单模块',
    ]);
    expect(result.presentation.tree[0]?.description).toBe('支付业务边界');
    expect(result.presentation.tree[0]).toMatchObject({
      purpose: '负责支付发起、确认与退款复用入口',
      coreApis: ['PaymentService.Pay'],
      language: 'C#',
      domain: '支付',
    });
    expect(result.presentation.summary).toMatchObject({
      exists: true,
      planId: 'plan-ui',
      status: 'approved',
      approvalsCurrent: true,
      moduleCount: 2,
      waveCount: 1,
    });
    expect(result.targets.size).toBe(0);
  });

  it('keeps the file tree usable when module-summary.json is malformed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-explorer-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.forexplore'), { recursive: true });
    await writeFile(path.join(root, 'src', 'Target.java'), 'class Target { void run() {} }');
    await writeFile(path.join(root, '.forexplore', 'module-summary.json'), '{ invalid json');

    const result = await buildModuleExplorer({
      workspaceRoot: root,
      workspaceName: 'Target',
      currentTarget: {
        id: 'editor-target',
        name: 'run',
        kind: 'function',
        path: 'src/Target.java',
        language: 'Java',
        signature: 'void run()',
        line: 1,
      },
      historyRoots: [],
    });

    expect(result.presentation.target.error).toBeUndefined();
    expect(result.presentation.target.stats.files).toBe(1);
    expect(result.presentation.target.tree).not.toHaveLength(0);
    expect(result.presentation.target.summary).toMatchObject({
      exists: false,
      error: expect.stringContaining('JSON'),
    });
  });

  it('keeps same-named history repository paths distinct before and after analysis', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-explorer-'));
    temporaryDirectories.push(root);
    const targetRoot = path.join(root, 'target');
    const firstHistory = path.join(root, 'first', 'legacy');
    const secondHistory = path.join(root, 'second', 'legacy');
    await mkdir(path.join(targetRoot, 'src'), { recursive: true });
    await mkdir(firstHistory, { recursive: true });
    await mkdir(secondHistory, { recursive: true });
    await writeFile(path.join(targetRoot, 'src', 'Target.cs'), 'class Target { void Run() {} }\n');

    const request = {
      workspaceRoot: targetRoot,
      workspaceName: 'Target',
      currentTarget: {
        id: 'workspace://src/Target.cs#L1',
        name: 'Run',
        kind: 'function' as const,
        path: 'src/Target.cs',
        language: 'C#' as const,
        signature: 'void Run()',
        line: 1,
      },
      historyRoots: [firstHistory, secondHistory, firstHistory],
    };
    const pending = await buildModuleExplorer(request, { includeHistory: false });
    const refreshed = await buildModuleExplorer(request);

    expect(pending.presentation.history).toHaveLength(2);
    expect(new Set(pending.presentation.history.map((repository) => repository.id)).size).toBe(2);
    expect(refreshed.presentation.history.map((repository) => repository.id)).toEqual(
      pending.presentation.history.map((repository) => repository.id),
    );
  });

  it('keeps the file tree usable when optional module summary metadata is malformed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forexplore-explorer-'));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.forexplore'), { recursive: true });
    await writeFile(path.join(root, 'src', 'Target.java'), 'class Target { void run() {} }');
    await writeFile(path.join(root, '.forexplore', 'module-summary.json'), JSON.stringify({
      schemaVersion: '1.0',
      generated: {
        snapshotId: 'snapshot',
        planId: 'plan',
        status: 'approved',
        modules: [{
          id: 'target',
          name: '目标模块',
          description: '目标模块边界',
          coreApis: 'Target.run',
          sourceFiles: ['src/Target.java'],
        }],
        executionWaves: [],
      },
      human: { approvalsCurrent: true },
    }));

    const result = await buildModuleExplorer({
      workspaceRoot: root,
      workspaceName: 'Target',
      currentTarget: {
        id: 'editor-target',
        name: 'run',
        kind: 'function',
        path: 'src/Target.java',
        language: 'Java',
        signature: 'void run()',
        line: 1,
      },
      historyRoots: [],
    });

    expect(result.presentation.target.error).toBeUndefined();
    expect(result.presentation.target.tree).not.toHaveLength(0);
    expect(result.presentation.target.summary).toMatchObject({
      exists: false,
      error: expect.stringContaining('结构无效'),
    });
  });
});

function moduleSummary(): ModuleSummary {
  const moduleBase = {
    kind: 'feature' as const,
    testFiles: [],
    generatedFiles: [],
    symbolIds: [],
    dependsOn: [],
    writeSet: [],
    resourceLocks: [],
    evidenceIds: [],
  };
  return {
    schemaVersion: '1.0',
    generated: {
      snapshotId: analysis.snapshotId,
      analysisHash: analysis.contentHash,
      planId: 'plan-ui',
      planHash: 'sha256:plan',
      status: 'approved',
      modules: [
        {
          ...moduleBase,
          id: 'payments',
          name: '支付模块',
          description: '支付业务边界',
          purpose: '负责支付发起、确认与退款复用入口',
          coreApis: ['PaymentService.Pay'],
          language: 'C#',
          domain: '支付',
          sourceFiles: ['src/Payments/PaymentService.cs'],
        },
        {
          ...moduleBase,
          id: 'orders',
          name: '订单模块',
          description: '订单业务边界',
          sourceFiles: ['src/Orders/OrderService.cs'],
        },
      ],
      dependencies: [],
      executionGroups: [],
      executionWaves: [{
        id: 'wave-01',
        order: 1,
        groupIds: [],
        moduleIds: ['payments', 'orders'],
        dependsOnWaveIds: [],
        maxParallelism: 1,
        requiresApproval: true,
        status: 'pending',
        parallelismBlockedBy: [],
      }],
      risks: [],
    },
    human: {
      approvalsCurrent: true,
      decisions: [],
      notes: [],
      acceptedRisks: [],
    },
  };
}
