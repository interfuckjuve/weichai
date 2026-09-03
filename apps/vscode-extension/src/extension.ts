import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type {
  AdaptationRequestV2,
  AdaptationResultV2,
  MigrationRouteDescriptor,
  MigrationRouteResolution,
  MigrationCheckpointRefV2,
  MigrationRunManifestV2,
  MigrationRouteStage,
  ModuleMappingEntry,
} from '@forexplore/contracts';
import { normalizeLanguageId } from '@forexplore/contracts';
import {
  writeRepositoryAnalysisArtifact,
} from '@forexplore/code-indexer';
import {
  applyHunksStrict,
  canApplyAdaptationForRoute,
  evaluateValidationPolicyGate,
  materializeMigrationRunManifestV2,
  validateMigrationRunManifestV2,
  type MigrationExecutionGroupDraft,
  type MigrationExecutionV2ValidationContext,
} from '@forexplore/workflow-core';
import { WorkspaceBackfill } from './backfill';
import { canonicalWorkspacePath } from './diff-apply';
import {
  HostOwnedRepositoryAnalyzer,
} from './host-owned-repository-analyzer';
import {
  ModuleMigrationHost,
  ModuleMigrationPreviewProvider,
  moduleMigrationPreviewScheme,
} from './module-migration-host';
import {
  createModuleExplorerPresentation,
  emptyTargetWorkspace,
  projectHistoryRepository,
  projectReviewedTargetWorkspace,
  projectTargetWorkspaceRecord,
  type HistoryRepositoryInspection,
} from './module-explorer';
import {
  ModuleMappingHost,
  type ModuleMappingHostRecord,
  type ModuleMappingRouteProvider,
} from './module-mapping-host';
import { VSCodeModuleMappingHostStore } from './module-mapping-store';
import { requestRepositoryModuleDiscovery } from './module-discovery-client';
import type { ModuleWaveExecutionPort } from './module-wave-execution-host';
import type { ModuleMigrationWaveRecoveryPort } from './module-migration-recovery';
import { TranslationPanel } from './panel';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import {
  combineHostRuntimeCapabilities,
  runtimeCapabilityView,
} from './runtime-capability-host';
import { loadSettings, savePanelSettings } from './settings';
import {
  TargetWorkspaceHost,
  type TargetWorkspaceHostRecord,
} from './target-workspace-host';
import { LocalTargetWorkspaceImplementationInventory } from './target-workspace-implementation-inventory';
import { FileSystemTargetWorkspaceHostStore } from './target-workspace-store';
import {
  assertTargetWorkspaceSelection,
  migrationSelectionFromTargetWorkspaceContext,
  projectTargetWorkspace,
} from './target-workspace-projection';
import {
  adaptRunV2,
  assertRunContextCurrent,
  createActiveMigrationRunV2,
  selectCandidateV2,
  selectedCandidateV2,
  startSearchV2,
  type ActiveMigrationRunV2,
} from './migration-workflow-v2-host';
import { collectTargetContextV2 } from './target-context-v2';
import { MigrationRunV2Store } from './migration-run-v2-store';
import type {
  TargetWorkspaceSelectionIdentity,
  TargetWorkspaceMigrationSelection,
  TargetWorkspaceSnapshot,
} from './protocol/messages';
import type {
  HistoryModuleSelectionIdentity,
  ModuleExplorerPresentation,
  ModuleWorkspaceAction,
  RepositoryStatus,
} from './ui-types';

// Keep the transaction implementation bundled by esbuild without making the
// extension's strict typecheck re-check the service's broader source tree.
const GitWaveTransaction = require('@forexplore/adaptation-service/git-wave-transaction').GitWaveTransaction as {
  new (): ModuleMigrationWaveRecoveryPort;
};

// The narrow service entrypoint keeps the trusted wave coordinator available
// to the extension without bundling the HTTP/model service composition.
const ModuleWaveExecutionCoordinator = require('@forexplore/adaptation-service/module-wave-execution').ModuleWaveExecutionCoordinator as {
  new (): ModuleWaveExecutionPort;
};

interface ExtensionHost {
  context: vscode.ExtensionContext;
  services: ServiceManager;
  health: RepositoryHealthCheck;
  targetWorkspaces: TargetWorkspaceHost;
  moduleMappings: ModuleMappingHost;
  moduleMigration: ModuleMigrationHost;
  previews: ModuleMigrationPreviewProvider;
  repositoryAnalyzer: HostOwnedRepositoryAnalyzer;
}

interface ActiveMigrationRun extends ActiveMigrationRunV2 {
  workspaceFolder: vscode.WorkspaceFolder;
  targetUri: vscode.Uri;
  /** Exact bytes read before retrieval / adaptation began. */
  originalSha256: string;
  originalContent: string;
}

interface ActiveTargetWorkspacePanel {
  workspaceFolder: vscode.WorkspaceFolder;
  projection: TargetWorkspaceSnapshot;
}

interface LastCheckpoint {
  checkpointId: string;
  workspaceUri: string;
  allowedTargetPaths: string[];
  runId: string;
  manifestId: string;
  manifestHash: string;
  manifestPath: string;
}

interface ActiveHistoryModuleBinding {
  selection: HistoryModuleSelectionIdentity;
  sourceWorkspaceId: string;
}

let activeRun: ActiveMigrationRun | null = null;
let activeTargetWorkspacePanel: ActiveTargetWorkspacePanel | null = null;
let panelWorkspaceFolder: vscode.WorkspaceFolder | null = null;
let activeHistoryRepositoryId: string | null = null;
let activeHistoryModuleSelection: ActiveHistoryModuleBinding | null = null;
let targetSelectionEpoch = 0;
let repositoryPathPickerOpen = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('ForeXplore');
  const services = new ServiceManager(output);
  const health = new RepositoryHealthCheck();
  const repositoryAnalyzer = new HostOwnedRepositoryAnalyzer();
  const moduleMigrationPreviews = new ModuleMigrationPreviewProvider();
  const moduleMigration = new ModuleMigrationHost({
    context,
    services,
    output,
    previews: moduleMigrationPreviews,
    waveRecovery: new GitWaveTransaction(),
    waveExecution: new ModuleWaveExecutionCoordinator(),
    repositoryAnalyzer: (request) => repositoryAnalyzer.analyze(request),
  });
  const targetWorkspaces = new TargetWorkspaceHost({
    store: new FileSystemTargetWorkspaceHostStore({
      storageDirectory: path.join(context.globalStorageUri.fsPath, 'target-workspaces'),
    }),
    implementationInventory: new LocalTargetWorkspaceImplementationInventory(),
    analyze: async (request) => {
      const analysis = await repositoryAnalyzer.analyze(request);
      // The separately deployed Module Discovery service reads the same
      // immutable sidecar by snapshot ID. Persist before sending that ID.
      await writeRepositoryAnalysisArtifact(request.root, analysis);
      return analysis;
    },
    discoverModules: async (request, signal) => {
      const status = await services.refresh();
      if (status.adaptation !== 'connected') {
        throw new Error(status.message ?? '模块发现服务尚未就绪。');
      }
      return requestRepositoryModuleDiscovery(
        loadSettings().adaptationApiUrl,
        request,
        undefined,
        signal,
      );
    },
  });
  const listModuleMappingRoutes: NonNullable<ModuleMappingRouteProvider['list']> = async (heads) => {
    const combined = combineHostRuntimeCapabilities(
      services.runtimeCapabilityState.snapshot,
      {
        source: heads.source,
        target: heads.target,
        analyzerDescriptors: repositoryAnalyzer.descriptors(),
        workspaceMutationAvailable: true,
      },
    );
    return runtimeCapabilityView(combined).resolutions
      .filter((resolution): resolution is Extract<MigrationRouteResolution, { status: 'supported' }> =>
        resolution.status === 'supported')
      .map((resolution) => ({ resolution, runtimeCapabilitySnapshot: combined }));
  };
  const moduleMappings = new ModuleMappingHost({
    store: new VSCodeModuleMappingHostStore(context.workspaceState),
    catalogs: {
      async load(side, workspaceId) {
        const workspaceFolder = [
          ...(vscode.workspace.workspaceFolders ?? []),
          ...historyWorkspaceFolders().map(({ folder }) => folder),
        ].find((folder) => folder.uri.toString() === workspaceId);
        if (!workspaceFolder) return null;
        if (side === 'source') {
          try {
            return await moduleMigration.getReviewedCatalogHead(workspaceFolder);
          } catch {
            return null;
          }
        }
        const record = await targetWorkspaces.refresh(workspaceId).catch(() => null);
        if (record?.stage !== 'reviewed' || !record.accepted?.snapshot) return null;
        return {
          workspaceId,
          ir: record.accepted.ir,
          catalog: record.accepted.catalog,
          analysisSnapshotId: record.accepted.analysis.snapshotId,
          analysisContentHash: record.accepted.analysis.contentHash,
          analysisAdapters: [...(record.accepted.analysis.analysisAdapters ?? [])],
        };
      },
    },
    routes: {
      list: listModuleMappingRoutes,
      async resolve(routeId, routeVersion, heads) {
        const capabilities = await listModuleMappingRoutes(heads);
        return capabilities.find(({ resolution }) =>
          resolution.route.id === routeId &&
          resolution.route.version === routeVersion,
        );
      },
    },
  });
  const extensionHost: ExtensionHost = {
    context,
    services,
    health,
    targetWorkspaces,
    moduleMappings,
    moduleMigration,
    previews: moduleMigrationPreviews,
    repositoryAnalyzer,
  };
  // Recovery completes before mutation commands become reachable. This avoids
  // a startup race between journal replay and a newly requested write-back.
  await recoverInterruptedBackfills(context, output);

  context.subscriptions.push(
    output,
    services,
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    vscode.commands.registerCommand('forexplore.startLegacyTranslation', () =>
      startLegacyTranslation(),
    ),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(extensionHost),
    ),
    vscode.commands.registerCommand('forexplore.checkRepositories', async () => {
      const statuses = await refreshRepositoryStatus(services, health);
      const summary = summarizeRepositoryStatus(statuses);
      void vscode.window.showInformationMessage(
        summary ?? '未配置本地仓库路径；检索范围由当前运行模式决定。',
      );
    }),
    vscode.commands.registerCommand('forexplore.reindex', async () => {
      await services.refresh();
      const repositories = await refreshRepositoryStatus(services, health);
      void vscode.window.showInformationMessage(
        '扩展不会把本地目录误标为已索引。请在检索服务部署环境运行索引器，然后重新检查服务状态。',
      );
      void repositories;
    }),
    vscode.commands.registerCommand('forexplore.restoreLastCheckpoint', () =>
      restoreLastCheckpoint(extensionHost),
    ),
    vscode.commands.registerCommand('forexplore.initializeTargetWorkspace', () =>
      initializeTargetWorkspace(extensionHost, moduleMigrationPreviews),
    ),
    vscode.commands.registerCommand('forexplore.reviewTargetWorkspaceModules', () =>
      reviewTargetWorkspaceModules(extensionHost, moduleMigrationPreviews),
    ),
    vscode.commands.registerCommand('forexplore.openTargetWorkspace', () =>
      openTargetWorkspace(extensionHost),
    ),
    vscode.commands.registerCommand('forexplore.rebaseTargetWorkspaceBodyOnly', () =>
      rebaseTargetWorkspaceBodyOnly(extensionHost, moduleMigrationPreviews),
    ),
    vscode.commands.registerCommand('forexplore.retryTargetWorkspaceInventory', () =>
      retryTargetWorkspaceInventory(extensionHost),
    ),
    vscode.commands.registerCommand('forexplore.indexModuleMigrationRepository', () =>
      moduleMigration.indexRepository(),
    ),
    vscode.commands.registerCommand('forexplore.reviewRepositoryModuleBoundaries', () =>
      moduleMigration.reviewRepositoryModuleBoundaries(),
    ),
    vscode.commands.registerCommand('forexplore.generateRepositoryModuleSummaries', () =>
      moduleMigration.generateRepositoryModuleSummaries(),
    ),
    vscode.commands.registerCommand('forexplore.reviewRepositoryModuleKnowledge', () =>
      moduleMigration.reviewRepositoryModuleKnowledge(),
    ),
    vscode.commands.registerCommand('forexplore.withdrawRepositoryModuleKnowledge', () =>
      moduleMigration.withdrawRepositoryModuleKnowledge(),
    ),
    vscode.commands.registerCommand('forexplore.proposeModuleMapping', () =>
      proposeModuleMapping(extensionHost, moduleMigrationPreviews),
    ),
    vscode.commands.registerCommand('forexplore.reviewModuleMapping', () =>
      reviewModuleMapping(extensionHost, moduleMigrationPreviews),
    ),
    vscode.commands.registerCommand('forexplore.reviewLegacyModuleMigrationPlan', () =>
      moduleMigration.reviewLegacyPlan(),
    ),
    vscode.commands.registerCommand('forexplore.reviewLegacyModuleMigrationWave', () =>
      moduleMigration.reviewNextWave(),
    ),
    vscode.commands.registerCommand('forexplore.prepareLegacyModuleMigrationWave', () =>
      moduleMigration.prepareNextWaveFromLocalBundle(),
    ),
    vscode.commands.registerCommand('forexplore.approveLegacyModuleMigrationWave', () =>
      moduleMigration.approveAndCommitPreparedWave(),
    ),
    vscode.commands.registerCommand('forexplore.recoverLegacyModuleMigrationReview', () =>
      moduleMigration.recoverReviewState(),
    ),
  );

  // Keep status informative, but never start servers or silently switch modes.
  void services
    .refresh()
    .then(() => refreshRepositoryStatus(services, health))
    .catch((error) => {
      output.appendLine(`[forexplore] preflight failed: ${String(error)}`);
    });
}

async function recoverInterruptedBackfills(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const recovered = await new WorkspaceBackfill({
        workspaceFolder,
        storageUri: context.globalStorageUri,
        // Recovery authorization is rehydrated from the Host-owned checkpoint
        // only when its journal binds this exact workspace identity.
        allowedTargetPaths: [],
      }).recoverInterrupted();
      if (recovered.length > 0) {
        output.appendLine(
          `[forexplore] recovered interrupted backfill transactions: ${recovered.join(', ')}`,
        );
        void vscode.window.showWarningMessage(
          `ForeXplore 已安全恢复 ${recovered.length} 个中断的写回事务。`,
        );
      }
    } catch (error) {
      output.appendLine(`[forexplore] interrupted backfill recovery blocked: ${errorMessage(error, 'unknown')}`);
      void vscode.window.showErrorMessage(
        'ForeXplore 检测到无法自动恢复的中断写回事务；在人工检查前将阻止新的写回。',
      );
    }
  }
}

export function deactivate(): void {
  targetSelectionEpoch += 1;
  activeRun = null;
  activeTargetWorkspacePanel = null;
  panelWorkspaceFolder = null;
  activeHistoryRepositoryId = null;
  activeHistoryModuleSelection = null;
}

interface ModuleMappingImportDocument {
  mappings: ModuleMappingEntry[];
  executionGroups: MigrationExecutionGroupDraft[];
  assumptions?: string[];
  risks?: string[];
}

/**
 * Canonical LA-04 proposal entrypoint. The Host imports references selected by
 * a human/tooling artifact and lets workflow-core validate every module/entity
 * ID against the two reviewed catalogs. No static-analysis Agent is allowed to
 * create or replace ownership facts here.
 */
async function proposeModuleMapping(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
): Promise<void> {
  try {
    const pair = await selectModuleMappingWorkspacePair();
    if (!pair) return;
    const objective = await vscode.window.showInputBox({
      title: 'ForeXplore: 创建跨目录模块映射提案',
      prompt: '描述这两个已审模块目录之间的迁移目标。',
      validateInput: (value) => value.trim() ? undefined : '映射目标不能为空。',
    });
    if (objective === undefined) return;
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: '选择模块映射 JSON（仅引用已审 module/entity ID）',
      filters: { JSON: ['json'] },
    });
    if (!picked?.[0]) return;
    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    const imported = parseModuleMappingImport(Buffer.from(bytes).toString('utf8'));
    const record = await host.moduleMappings.propose({
      sourceWorkspaceId: pair.source.uri.toString(),
      targetWorkspaceId: pair.target.uri.toString(),
      objective: objective.trim(),
      mappings: imported.mappings,
      executionGroups: imported.executionGroups,
      ...(imported.assumptions ? { assumptions: imported.assumptions } : {}),
      ...(imported.risks ? { risks: imported.risks } : {}),
    });
    await previews.show('Canonical module mapping proposal', {
      warning: '此提案只引用两侧已审 RepositoryModuleCatalog；尚未接受，不能用于迁移运行。',
      record,
    });
    void vscode.window.showInformationMessage(
      `模块映射提案 ${record.proposal.id} 已保存，等待独立人工审阅。`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '创建模块映射提案失败'));
  }
}

async function reviewModuleMapping(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
): Promise<void> {
  try {
    await host.services.refresh();
    const records = (await host.moduleMappings.list(true)).filter(
      (record) => record.stage === 'awaiting-review',
    );
    if (records.length === 0) {
      void vscode.window.showInformationMessage('没有仍然 current 且等待审阅的模块映射提案。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      records.map((record) => ({
        label: record.proposal.objective,
        description: `${record.sourceWorkspaceId} → ${record.targetWorkspaceId}`,
        detail: `${record.proposal.id} · ${record.proposal.mappings.length} mapping(s)`,
        record,
      })),
      { title: '选择待审模块映射提案', placeHolder: '审阅只决定映射；不会改写两侧模块目录。' },
    );
    if (!picked) return;
    const record: ModuleMappingHostRecord = picked.record;
    await previews.show('Module mapping proposal review', {
      warning: '核对 1:1、1:N、N:1 对应关系及执行分组；映射不得声明新的模块或实体归属。',
      sourceCatalog: record.proposal.sourceCatalog,
      targetCatalog: record.proposal.targetCatalog,
      proposal: record.proposal,
      executionGroups: record.executionGroupDrafts,
    });
    const action = await vscode.window.showInformationMessage(
      '请在只读预览中核对模块映射及执行分组。',
      { modal: true },
      '接受并物化 Overlay',
      '要求修订',
      '拒绝',
    );
    if (!action) return;
    const reviewerId = await vscode.window.showInputBox({
      title: 'ForeXplore: 模块映射审阅身份',
      prompt: '输入可审计的审阅者标识。',
      validateInput: (value) => value.trim() ? undefined : '审阅者标识不能为空。',
    });
    if (reviewerId === undefined) return;
    const comment = await vscode.window.showInputBox({
      title: 'ForeXplore: 模块映射审阅说明（可选）',
      prompt: '记录接受、修订或拒绝的依据。',
    });
    if (comment === undefined) return;

    const decision = action === '接受并物化 Overlay'
      ? 'accept' as const
      : action === '要求修订'
        ? 'revise' as const
        : 'reject' as const;
    let selectedRoute: Extract<MigrationRouteResolution, { status: 'supported' }> | undefined;
    if (decision === 'accept') {
      const supportedRoutes = (await host.moduleMappings.listRoutes(record.id))
        .map(({ resolution }) => resolution);
      if (supportedRoutes.length === 0) {
        throw new Error('当前没有来自能力注册表的 supported route；接受操作已 fail closed。');
      }
      const routePick = await vscode.window.showQuickPick(
        supportedRoutes.map((resolution) => ({
          label: `${resolution.route.sourceLanguageId} → ${resolution.route.targetLanguageId}`,
          description: `${resolution.route.strategy} · ${resolution.route.id}@${resolution.route.version}`,
          resolution,
        })),
        { title: '选择并绑定已解析的执行路线' },
      );
      if (!routePick) return;
      selectedRoute = routePick.resolution;
    }
    const reviewed = await host.moduleMappings.review({
      recordId: record.id,
      expectedProposalId: record.proposal.id,
      expectedProposalHash: record.proposal.contentHash,
      decision,
      reviewerId: reviewerId.trim(),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(selectedRoute ? {
        routeId: selectedRoute.route.id,
        routeVersion: selectedRoute.route.version,
      } : {}),
    });
    await previews.show('Module mapping review result', {
      stage: reviewed.stage,
      review: reviewed.review,
      overlay: reviewed.overlay,
      route: reviewed.routeResolution?.route,
    });
    void vscode.window.showInformationMessage(
      reviewed.stage === 'ready'
        ? `映射已接受并物化执行 Overlay：${reviewed.overlay!.id}`
        : `映射审阅已记录为 ${reviewed.stage}。`,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '审阅模块映射失败'));
  }
}

async function selectModuleMappingWorkspacePair(): Promise<{
  source: vscode.WorkspaceFolder;
  target: vscode.WorkspaceFolder;
} | undefined> {
  const targetFolders = vscode.workspace.workspaceFolders ?? [];
  const sourceByUri = new Map<string, vscode.WorkspaceFolder>();
  for (const folder of [
    ...historyWorkspaceFolders().map(({ folder }) => folder),
    ...targetFolders,
  ]) sourceByUri.set(folder.uri.toString(), folder);
  const sourceFolders = [...sourceByUri.values()];
  if (sourceFolders.length === 0 || targetFolders.length === 0) {
    void vscode.window.showInformationMessage('请打开目标工作区，并在设置中注册至少一个历史源仓。');
    return undefined;
  }
  const sourceItems = sourceFolders.map((folder) => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder,
  }));
  const source = await vscode.window.showQuickPick(sourceItems, {
    title: '选择已发布模块目录的历史源仓库',
  });
  if (!source) return undefined;
  const targetItems = targetFolders
    .filter((folder) => folder.uri.toString() !== source.folder.uri.toString())
    .map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    }));
  if (targetItems.length === 0) {
    void vscode.window.showInformationMessage('历史源仓与目标工作区必须是不同目录。');
    return undefined;
  }
  const target = await vscode.window.showQuickPick(targetItems, {
    title: '选择已审模块目录的目标仓库',
  });
  return target ? { source: source.folder, target: target.folder } : undefined;
}

function parseModuleMappingImport(text: string): ModuleMappingImportDocument {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('模块映射文件不是有效 JSON。');
  }
  if (!isRecord(value) || !Array.isArray(value.mappings) || !Array.isArray(value.executionGroups)) {
    throw new Error('模块映射 JSON 必须包含 mappings 与 executionGroups 数组。');
  }
  if (value.assumptions !== undefined && !isStringArray(value.assumptions)) {
    throw new Error('模块映射 assumptions 必须是字符串数组。');
  }
  if (value.risks !== undefined && !isStringArray(value.risks)) {
    throw new Error('模块映射 risks 必须是字符串数组。');
  }
  return {
    mappings: value.mappings as ModuleMappingEntry[],
    executionGroups: value.executionGroups as MigrationExecutionGroupDraft[],
    ...(value.assumptions === undefined ? {} : { assumptions: value.assumptions }),
    ...(value.risks === undefined ? {} : { risks: value.risks }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

async function startLegacyTranslation(): Promise<void> {
  void vscode.window.showWarningMessage(
    'Legacy V1 编辑器迁移入口不会进入生产工作流。请从已审 01B 目标工作区选择实体，并使用 V2 路线、目录映射和验证证据。',
  );
}

async function showPanel(
  host: ExtensionHost,
): Promise<void> {
  if (TranslationPanel.current) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  if (activeTargetWorkspacePanel) {
    await showTargetWorkspacePanel(host, activeTargetWorkspacePanel);
    return;
  }
  const workspaceFolder = await selectTargetWorkspaceFolder(false);
  panelWorkspaceFolder = workspaceFolder ?? null;
  if (workspaceFolder) {
    const record = await host.targetWorkspaces.get(workspaceFolder.uri.toString());
    if (record?.stage === 'reviewed' && record.accepted?.snapshot) {
      await openReviewedTargetWorkspace(host, workspaceFolder, record);
      return;
    }
  }
  await showWorkspacePanel(host, workspaceFolder);
}

async function initializeTargetWorkspace(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
  workspaceFolderInput?: vscode.WorkspaceFolder,
): Promise<void> {
  try {
    const workspaceFolder = workspaceFolderInput ?? await selectTargetWorkspaceFolder();
    if (!workspaceFolder) return;
    const workspaceId = workspaceFolder.uri.toString();
    const record = await vscode.window.withProgress<TargetWorkspaceHostRecord>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ForeXplore: 正在分析 01B 目标工作区并提出模块边界',
      },
      () => host.targetWorkspaces.initialize({
        workspaceId,
        repositoryRoot: workspaceFolder.uri.fsPath,
        repositoryId: `target-${sha256(Buffer.from(workspaceId, 'utf8')).slice(0, 24)}`,
      }),
    );
    await previews.show('01B target workspace module discovery', {
      role: record.role,
      stage: record.stage,
      workspaceId: record.workspaceId,
      readiness: record.readiness,
      analysis: {
        snapshotId: record.latest.analysis.snapshotId,
        contentHash: record.latest.analysis.contentHash,
        analyzerVersion: record.latest.analysis.analyzerVersion,
      },
      unifiedIr: {
        id: record.latest.ir.id,
        contentHash: record.latest.ir.contentHash,
        fileCount: record.latest.ir.files.length,
        entityCount: record.latest.ir.entities.length,
      },
      proposal: record.discovery?.proposal,
      draftCatalog: record.discovery?.draftCatalog,
      boundary: '01B stops after Gate 1 and implementation inventory; it never publishes target skeletons to SeekDB.',
    });
    if (record.stage === 'awaiting-module-review') {
      void vscode.window.showInformationMessage(
        '01B 已复用 01A 分析和模块发现，当前停在目标模块边界人审；尚未生成可用目标树。',
      );
    } else if (record.stage === 'analysis-partial') {
      void vscode.window.showWarningMessage(
        '目标工作区分析证据不足，未调用模块 Agent。请检查语言 adapter/readiness 诊断。',
      );
    } else if (record.stage === 'reviewed') {
      await openReviewedTargetWorkspace(host, workspaceFolder, record);
    } else if (record.stage === 'status-inventory-failed') {
      void vscode.window.showWarningMessage(
        '模块边界已接受，但实现状态检测失败。请运行“ForeXplore: 重试 01B 实现状态检测”。',
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '01B 目标工作区初始化失败'));
  }
}

async function reviewTargetWorkspaceModules(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
  workspaceFolderInput?: vscode.WorkspaceFolder,
): Promise<void> {
  try {
    const workspaceFolder = workspaceFolderInput ?? await selectTargetWorkspaceFolder();
    if (!workspaceFolder) return;
    const workspaceId = workspaceFolder.uri.toString();
    const record = await host.targetWorkspaces.get(workspaceId);
    if (!record?.discovery || record.stage !== 'awaiting-module-review') {
      throw new Error(`目标工作区不在 Gate 1 审阅阶段：${record?.stage ?? 'not-initialized'}。`);
    }
    await previews.show('01B target workspace Gate 1 review', {
      warning: '本次只审批目标模块边界；不会生成 Summary、不会进入 SQLite registry 或 SeekDB active head。',
      proposal: record.discovery.proposal,
      draftCatalog: record.discovery.draftCatalog,
      unassignedFileIds: record.discovery.draftCatalog.unassignedFileIds,
      overlappingFileIds: record.discovery.draftCatalog.overlappingFileIds,
    });
    const choice = await vscode.window.showWarningMessage(
      '请核对目标模块、文件归属、shared/unassigned、API 与依赖。接受后才会生成实现状态目录。',
      { modal: true },
      '接受目标模块边界',
      '要求重新划分',
      '拒绝目标模块边界',
    );
    if (!choice) return;
    const reviewerId = await vscode.window.showInputBox({
      title: '01B Gate 1 审批人',
      prompt: '输入可审计的审批人标识。',
      validateInput: (value) => value.trim() ? undefined : '审批人标识不能为空。',
    });
    if (reviewerId === undefined) return;
    const comment = await vscode.window.showInputBox({
      title: '01B Gate 1 审阅备注（可选）',
      prompt: '记录接受依据、修订要求或拒绝原因。',
    });
    if (comment === undefined) return;
    const proposal = record.discovery.proposal;
    const reviewed = await host.targetWorkspaces.submitGate1({
      workspaceId,
      expectedProposalId: proposal.id,
      expectedProposalHash: proposal.contentHash,
      expectedIrId: record.latest.ir.id,
      expectedIrHash: record.latest.ir.contentHash,
      decision: choice === '接受目标模块边界'
        ? 'accept'
        : choice === '要求重新划分'
          ? 'revise'
          : 'reject',
      reviewerId: reviewerId.trim(),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
    if (reviewed.stage === 'reviewed') {
      await openReviewedTargetWorkspace(host, workspaceFolder, reviewed);
      return;
    }
    activeTargetWorkspacePanel = null;
    void vscode.window.showInformationMessage(
      reviewed.stage === 'revision-required'
        ? '本轮目标模块提案已关闭。请调整代码/约束并重新初始化；旧边界和 assessment 不会继续使用。'
        : '本轮目标模块提案已拒绝，未生成目标树。',
    );
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '01B Gate 1 审阅失败'));
  }
}

async function openTargetWorkspace(host: ExtensionHost): Promise<void> {
  try {
    const workspaceFolder = await selectTargetWorkspaceFolder();
    if (!workspaceFolder) return;
    const workspaceId = workspaceFolder.uri.toString();
    const stored = await host.targetWorkspaces.get(workspaceId);
    if (!stored) {
      throw new Error('目标工作区尚未初始化。请先运行“ForeXplore: 初始化 01B 目标工作区”。');
    }
    const record = await host.targetWorkspaces.refresh(workspaceId);
    if (record.stage !== 'reviewed' || !record.accepted?.snapshot) {
      const previous = activeTargetWorkspacePanel;
      if (previous?.projection.workspaceId === workspaceId) {
        publishTargetWorkspaceInvalidation(
          previous.projection,
          record.failure ?? `目标工作区已经变为 ${record.stage}。`,
        );
      }
      throw new Error(`目标工作区尚无 current 目录：${record.stage}。`);
    }
    await openReviewedTargetWorkspace(host, workspaceFolder, record);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '无法打开 01B 目标工作区'));
  }
}

async function retryTargetWorkspaceInventory(
  host: ExtensionHost,
  workspaceFolderInput?: vscode.WorkspaceFolder,
): Promise<void> {
  try {
    const workspaceFolder = workspaceFolderInput ?? await selectTargetWorkspaceFolder();
    if (!workspaceFolder) return;
    const workspaceId = workspaceFolder.uri.toString();
    const stored = await host.targetWorkspaces.get(workspaceId);
    if (!stored || stored.stage !== 'status-inventory-failed') {
      throw new Error(`目标工作区没有可重试的实现状态检测：${stored?.stage ?? 'not-initialized'}。`);
    }
    const refreshed = await host.targetWorkspaces.refresh(workspaceId);
    if (refreshed.stage !== 'status-inventory-failed') {
      throw new Error(`重试前工作区快照已变化，当前状态为 ${refreshed.stage}；不能沿用旧 Gate 1。`);
    }
    const reviewed = await vscode.window.withProgress<TargetWorkspaceHostRecord>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ForeXplore: 正在重试 01B 实现状态检测',
      },
      () => host.targetWorkspaces.rebuildImplementationInventory(workspaceId),
    );
    await openReviewedTargetWorkspace(host, workspaceFolder, reviewed);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '01B 实现状态检测重试失败'));
  }
}

async function rebaseTargetWorkspaceBodyOnly(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
  workspaceFolderInput?: vscode.WorkspaceFolder,
): Promise<void> {
  try {
    const workspaceFolder = workspaceFolderInput ?? await selectTargetWorkspaceFolder();
    if (!workspaceFolder) return;
    const workspaceId = workspaceFolder.uri.toString();
    const existing = await host.targetWorkspaces.get(workspaceId);
    if (!existing) {
      throw new Error('目标工作区尚未初始化。');
    }
    // Re-read the real workspace before presenting the rebase confirmation. The
    // Host repeats the binding checks during the mutation, so a concurrent edit
    // still fails closed after the modal is opened.
    const record = await host.targetWorkspaces.refresh(workspaceId);
    const accepted = record?.accepted;
    if (
      !record ||
      record.stage !== 'body-only-compatible' ||
      record.freshness?.status !== 'body-only-compatible' ||
      !accepted?.snapshot
    ) {
      throw new Error(`目标工作区不满足实现体兼容 rebase 条件：${record?.stage ?? 'not-initialized'}。`);
    }
    const choice = await vscode.window.showWarningMessage(
      '声明结构未变化，但旧实现状态已经过期。将旧模块边界映射到新 IR 并产生一份新的 Gate 1 提案；必须再次人审后才会重算状态。',
      { modal: true },
      '生成 rebase 提案',
    );
    if (choice !== '生成 rebase 提案') return;
    const rebased = await host.targetWorkspaces.rebaseBodyOnly({
      workspaceId,
      expectedModuleSnapshotId: accepted.snapshot.id,
      expectedModuleSnapshotHash: accepted.snapshot.contentHash,
      expectedCatalogId: accepted.catalog.id,
      expectedCatalogHash: accepted.catalog.contentHash,
      expectedLatestAnalysisSnapshotId: record.latest.analysis.snapshotId,
      expectedLatestIrId: record.latest.ir.id,
      expectedLatestIrHash: record.latest.ir.contentHash,
    });
    activeRun = null;
    activeTargetWorkspacePanel = null;
    await previews.show('01B target workspace body-only rebase proposal', {
      warning: 'rebase 只复用边界意图，不复用旧 assessment；本提案仍需 Gate 1 人审。',
      freshness: record.freshness,
      proposal: rebased.discovery?.proposal,
      draftCatalog: rebased.discovery?.draftCatalog,
    });
    void vscode.window.showInformationMessage(
      '已生成绑定新 IR 的模块边界提案。请运行“ForeXplore: 审阅 01B 目标模块边界”。',
    );
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '01B 实现体兼容 rebase 失败'));
  }
}

async function openReviewedTargetWorkspace(
  host: ExtensionHost,
  workspaceFolder: vscode.WorkspaceFolder,
  record: TargetWorkspaceHostRecord,
): Promise<void> {
  targetSelectionEpoch += 1;
  await host.services.refresh();
  const capabilities = await targetWorkspaceCapabilityView(host, record);
  const projection = projectTargetWorkspace({
    record,
    workspaceName: workspaceFolder.name,
    routeResolutions: capabilities.resolutions,
    runtimeCapabilitySnapshot: capabilities.snapshot,
  });
  const panelState = { workspaceFolder, projection };
  activeTargetWorkspacePanel = panelState;
  panelWorkspaceFolder = workspaceFolder;
  activeRun = null;
  await showTargetWorkspacePanel(host, panelState);
}

async function targetWorkspaceCapabilityView(
  host: ExtensionHost,
  record: TargetWorkspaceHostRecord,
) {
  const accepted = record.accepted;
  if (record.stage !== 'reviewed' || !accepted?.snapshot) {
    throw new Error('目标工作区没有 current reviewed catalog，不能解析迁移能力。');
  }
  const combined = combineHostRuntimeCapabilities(
    host.services.runtimeCapabilityState.snapshot,
    {
      target: {
        workspaceId: record.workspaceId,
        ir: accepted.ir,
        catalog: accepted.catalog,
        analysisSnapshotId: accepted.analysis.snapshotId,
        analysisContentHash: accepted.analysis.contentHash,
        analysisAdapters: [...(accepted.analysis.analysisAdapters ?? [])],
      },
      analyzerDescriptors: host.repositoryAnalyzer.descriptors(),
      workspaceMutationAvailable: true,
    },
  );
  const base = runtimeCapabilityView(combined);
  const acceptedMappingRoutes = await host.moduleMappings.listTargetRouteResolutions(
    record.workspaceId,
  );
  const byKey = new Map(base.resolutions.map((resolution) => [
    routeResolutionKey(resolution),
    resolution,
  ]));
  for (const resolution of acceptedMappingRoutes) {
    if (resolution.status === 'supported') byKey.set(routeResolutionKey(resolution), resolution);
  }
  return { snapshot: combined, resolutions: [...byKey.values()] };
}

function routeResolutionKey(resolution: MigrationRouteResolution): string {
  return JSON.stringify([
    resolution.key.sourceLanguageId,
    resolution.key.targetLanguageId,
    resolution.key.strategy,
  ]);
}

async function showWorkspacePanel(
  host: ExtensionHost,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
  activeRun = null;
  activeTargetWorkspacePanel = null;
  const [repositoryStatuses, moduleExplorer] = await Promise.all([
    refreshRepositoryStatus(host.services, host.health),
    buildModuleExplorerPresentation(host, workspaceFolder),
  ]);
  const settings = loadSettings();
  const runtime = host.services.getRuntimePresentation();
  await TranslationPanel.createOrShow(
    host.context,
    {
      workspaceRoot: workspaceFolder?.uri.fsPath ?? '',
      settings: { repositoryPaths: settings.repositoryPaths, topK: settings.topK },
      repositoryStatuses,
      serviceStatus: host.services.serviceStatus,
      moduleExplorer,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    { onMessage: (message) => void handlePanelMessage(host, message) },
  );
}

async function buildModuleExplorerPresentation(
  host: ExtensionHost,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  targetProjection?: TargetWorkspaceSnapshot,
): Promise<ModuleExplorerPresentation> {
  let target;
  if (targetProjection && workspaceFolder) {
    target = projectReviewedTargetWorkspace(targetProjection, workspaceFolder.uri.fsPath);
  } else if (workspaceFolder) {
    const record = await host.targetWorkspaces.get(workspaceFolder.uri.toString());
    target = projectTargetWorkspaceRecord(
      record,
      workspaceFolder.name,
      workspaceFolder.uri.fsPath,
      workspaceFolder.uri.toString(),
    );
  } else {
    target = emptyTargetWorkspace(
      '未打开目标工作区',
      '请先在 VS Code 中打开一个工作区',
      false,
    );
  }
  const history = await Promise.all(historyWorkspaceFolders().map(async ({ registrationId, folder }) => {
    const base = {
      registrationId,
      root: folder.uri.fsPath,
      name: folder.name,
    };
    try {
      const inspection = await host.moduleMigration.inspectRepository(folder);
      return { ...base, ...inspection } satisfies HistoryRepositoryInspection;
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : String(error),
      } satisfies HistoryRepositoryInspection;
    }
  }));
  return createModuleExplorerPresentation({ target, history });
}

function historyWorkspaceFolders(): Array<{
  registrationId: string;
  folder: vscode.WorkspaceFolder;
}> {
  return loadSettings().repositoryPaths.map((root, index) => {
    const uri = vscode.Uri.file(path.resolve(root));
    return {
      registrationId: historyRepositoryRegistrationId(uri),
      folder: {
        uri,
        name: path.basename(uri.fsPath) || uri.fsPath,
        index,
      },
    };
  });
}

function historyRepositoryRegistrationId(uri: vscode.Uri): string {
  const canonicalUri = process.platform === 'win32'
    ? uri.toString().toLowerCase()
    : uri.toString();
  return `history:${sha256(Buffer.from(canonicalUri, 'utf8')).slice(0, 32)}`;
}

function requireHistoryWorkspaceFolder(registrationId: string): vscode.WorkspaceFolder {
  const registration = historyWorkspaceFolders().find(
    (candidate) => candidate.registrationId === registrationId,
  );
  if (!registration) throw new Error('该历史仓注册不属于当前 Host 设置。');
  return registration.folder;
}

async function publishModuleExplorer(host: ExtensionHost): Promise<void> {
  const explorer = await buildModuleExplorerPresentation(
    host,
    panelWorkspaceFolder ?? undefined,
    activeTargetWorkspacePanel?.projection,
  );
  publish({ type: 'MODULE_EXPLORER', explorer });
}

async function showTargetWorkspacePanel(
  host: ExtensionHost,
  panelState: ActiveTargetWorkspacePanel,
): Promise<void> {
  const serviceStatus = host.services.serviceStatus;
  const repositoryStatuses = await refreshRepositoryStatus(host.services, host.health);
  const runtime = host.services.getRuntimePresentation();
  const settings = loadSettings();
  const moduleExplorer = await buildModuleExplorerPresentation(
    host,
    panelState.workspaceFolder,
    panelState.projection,
  );
  await TranslationPanel.createOrShow(
    host.context,
    {
      targetWorkspace: panelState.projection,
      workspaceRoot: panelState.workspaceFolder.uri.fsPath,
      settings: { repositoryPaths: settings.repositoryPaths, topK: settings.topK },
      moduleExplorer,
      repositoryStatuses,
      serviceStatus,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    { onMessage: (message) => void handlePanelMessage(host, message) },
  );
}

async function refreshTargetWorkspace(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, { type: 'REFRESH_TARGET_WORKSPACE' }>,
): Promise<void> {
  try {
    const panelState = activeTargetWorkspacePanel;
    if (!panelState) throw new Error('当前面板没有已审的 01B 目标工作区。');
    if (
      message.expectedSnapshotId &&
      (message.expectedSnapshotId !== panelState.projection.snapshotId ||
        message.expectedContentHash !== panelState.projection.contentHash)
    ) {
      throw new Error('目标工作区刷新请求基于旧快照。');
    }
    publish({
      type: 'TARGET_WORKSPACE_REFRESHING',
      previousSnapshotId: panelState.projection.snapshotId,
      previousContentHash: panelState.projection.contentHash,
    });
    await host.services.refresh();
    const refreshed = await host.targetWorkspaces.refresh(panelState.projection.workspaceId);
    if (refreshed.stage === 'reviewed' && refreshed.accepted?.snapshot) {
      const capabilities = await targetWorkspaceCapabilityView(host, refreshed);
      const projection = projectTargetWorkspace({
        record: refreshed,
        workspaceName: panelState.workspaceFolder.name,
        routeResolutions: capabilities.resolutions,
        runtimeCapabilitySnapshot: capabilities.snapshot,
      });
      activeTargetWorkspacePanel = { ...panelState, projection };
      publish({ type: 'TARGET_WORKSPACE_SNAPSHOT', snapshot: projection });
      await publishModuleExplorer(host);
      return;
    }
    const reason = refreshed.freshness?.reasonCodes.join('、') ||
      refreshed.failure ||
      `目标工作区处于 ${refreshed.stage}`;
    publishTargetWorkspaceInvalidation(panelState.projection, reason);
    activeTargetWorkspacePanel = null;
    await publishModuleExplorer(host);
  } catch (error) {
    publishError(errorMessage(error, '刷新 01B 目标工作区失败'));
  }
}

async function selectTargetWorkspaceEntity(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, {
    type: 'SELECT_TARGET_ENTITY' | 'START_TARGET_TRANSLATION';
  }>,
  activateWorkflow: boolean,
): Promise<void> {
  const requestEpoch = ++targetSelectionEpoch;
  if (!activateWorkflow && activeRun) {
    publishError('当前迁移已经绑定目标实体；请勿在运行中切换 01B 目标。');
    return;
  }
  if (activateWorkflow) activeRun = null;
  try {
    const panelState = activeTargetWorkspacePanel;
    if (!panelState) throw new Error('当前面板没有已审的 01B 目标工作区。');
    await host.services.refresh();
    const selectedNode = assertTargetWorkspaceSelection(panelState.projection, message);
    if (activateWorkflow) {
      await refreshTargetWorkspaceBinding(host, {
        workspaceId: panelState.projection.workspaceId,
        snapshotId: message.snapshotId,
        contentHash: message.contentHash,
      });
      if (requestEpoch !== targetSelectionEpoch) return;
    }
    const context = await host.targetWorkspaces.getTargetContext({
      workspaceId: panelState.projection.workspaceId,
      snapshotId: message.snapshotId,
      snapshotHash: message.contentHash,
      entityId: message.entityId,
    });
    if (requestEpoch !== targetSelectionEpoch) return;
    if (!selectedNode.moduleId) {
      throw new Error('目标实体没有已审模块归属，不能绑定模块映射。');
    }
    const selectedSource = activeHistoryModuleSelection
      ? await assertHistoryModuleBindingCurrent(host, activeHistoryModuleSelection)
      : null;
    const moduleMapping = await host.moduleMappings.bindTarget({
      targetWorkspaceId: panelState.projection.workspaceId,
      targetModuleId: selectedNode.moduleId,
      targetEntityId: selectedNode.entityId,
      allowedRouteIds: selectedNode.migrationEligibility.routeOptions.map(({ route }) => route.id),
      ...(selectedSource ? {
        sourceWorkspaceId: selectedSource.sourceWorkspaceId,
        sourceRepositoryId: selectedSource.selection.repositoryId,
        sourceCatalogId: selectedSource.selection.catalogId,
        sourceCatalogHash: selectedSource.selection.catalogHash,
        sourceModuleId: selectedSource.selection.moduleId,
      } : {}),
    });
    const boundRouteOptions = selectedNode.migrationEligibility.routeOptions.filter(({ route }) =>
      route.id === moduleMapping.route.routeId &&
      route.version === moduleMapping.route.routeVersion &&
      route.contentHash === moduleMapping.route.routeContentHash,
    );
    if (boundRouteOptions.length !== 1) {
      throw new Error('已审模块映射的 route lineage 与当前能力快照不一致。');
    }
    const migrationSelection = migrationSelectionFromTargetWorkspaceContext(
      context,
      message,
      boundRouteOptions,
      moduleMapping,
      selectedNode.moduleId,
    );
    if (activateWorkflow) {
      const relativeParts = migrationSelection.target.entity.path
        .replaceAll('\\', '/')
        .split('/')
        .filter(Boolean);
      const targetUri = vscode.Uri.joinPath(panelState.workspaceFolder.uri, ...relativeParts);
      const openDocument = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === targetUri.toString(),
      );
      if (openDocument?.isDirty) {
        throw new Error('目标文件有未保存编辑；请保存并刷新目标工作区。');
      }
      const originalBytes = await vscode.workspace.fs.readFile(targetUri);
      if (!context.file || sha256(originalBytes) !== context.file.contentHash) {
        throw new Error('目标文件在刷新与启动之间发生变化；请刷新 01B 目标工作区后重试。');
      }
      if (requestEpoch !== targetSelectionEpoch) return;
      activeRun = {
        ...createActiveMigrationRunV2(migrationSelection),
        workspaceFolder: panelState.workspaceFolder,
        targetUri,
        originalSha256: sha256(originalBytes),
        originalContent: Buffer.from(originalBytes).toString('utf8'),
      };
    }
    publish({
      type: 'TARGET_ENTITY_SELECTED',
      selection: message,
      target: migrationSelection.target,
      migrationSelection,
      activateWorkflow,
    });
  } catch (error) {
    publishError(errorMessage(error, '01B 目标选择无效'));
  }
}

async function selectTargetWorkspaceFolder(
  notifyWhenMissing = true,
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    if (notifyWhenMissing) void vscode.window.showInformationMessage('请先打开目标工作区。');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { title: '选择 01B 目标工作区', placeHolder: '目标工作区只生成本次迁移目录，不发布到 SeekDB。' },
  );
  return selected?.folder;
}

async function handlePanelMessage(
  host: ExtensionHost,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'READY':
      return;
    case 'START_SEARCH':
      await startSearch(host, message);
      return;
    case 'REFRESH_TARGET_WORKSPACE':
      await refreshTargetWorkspace(host, message);
      return;
    case 'SELECT_TARGET_ENTITY':
      await selectTargetWorkspaceEntity(host, message, false);
      return;
    case 'START_TARGET_TRANSLATION':
      await selectTargetWorkspaceEntity(host, message, true);
      return;
    case 'SELECT_CANDIDATE':
      await selectCandidate(host, message.candidateId);
      return;
    case 'START_ADAPT':
      await startAdaptation(host, message.decisionNotes);
      return;
    case 'APPLY_CURRENT_RUN':
      await applyCurrentRun(host);
      return;
    case 'CHECK_REPOSITORIES':
      await refreshPanelStatus(host);
      return;
    case 'REFRESH_MODULE_EXPLORER':
      await publishModuleExplorer(host).catch((error) =>
        publishError(errorMessage(error, '刷新模块工作区失败')));
      return;
    case 'PICK_REPOSITORY_PATH':
      await pickRepositoryPath();
      return;
    case 'SAVE_SETTINGS':
      await updatePanelSettings(host, message.settings);
      return;
    case 'SELECT_HISTORY_REPOSITORY':
      await selectHistoryRepository(message.repositoryRegistrationId);
      return;
    case 'SELECT_HISTORY_MODULE':
      await selectHistoryModule(host, message);
      return;
    case 'RUN_MODULE_WORKSPACE_ACTION':
      await runModuleWorkspaceAction(host, message.workspaceId, message.action);
      return;
    case 'COPY_TARGET_PATH':
      await copyTargetPath();
      return;
    case 'REVEAL_TARGET_IN_EXPLORER':
      await revealTargetInExplorer();
      return;
    case 'OPEN_TARGET':
      await openTarget();
      return;
  }
}

async function pickRepositoryPath(): Promise<void> {
  if (repositoryPathPickerOpen) return;
  repositoryPathPickerOpen = true;
  try {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: '选择要注册为 01A 历史仓的本地目录',
      openLabel: '添加历史仓路径',
    });
    const uri = picked?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('历史仓必须是本地 file 目录。');
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) === 0) throw new Error('请选择目录而不是文件。');
    publish({ type: 'REPOSITORY_PATH_PICKED', path: path.normalize(path.resolve(uri.fsPath)) });
  } catch (error) {
    publishError(errorMessage(error, '添加历史仓路径失败'));
  } finally {
    repositoryPathPickerOpen = false;
  }
}

async function updatePanelSettings(
  host: ExtensionHost,
  settings: Extract<WebviewToHostMessage, { type: 'SAVE_SETTINGS' }>['settings'],
): Promise<void> {
  try {
    const saved = await savePanelSettings(settings);
    const configuredIds = new Set(historyWorkspaceFolders().map((item) => item.registrationId));
    if (activeHistoryRepositoryId && !configuredIds.has(activeHistoryRepositoryId)) {
      activeHistoryRepositoryId = null;
      activeHistoryModuleSelection = null;
    }
    publish({ type: 'SETTINGS_UPDATED', settings: saved });
    await Promise.all([
      refreshPanelStatus(host),
      publishModuleExplorer(host),
    ]);
  } catch (error) {
    publishError(errorMessage(error, '保存设置失败'));
  }
}

async function selectHistoryRepository(registrationId: string): Promise<void> {
  try {
    requireHistoryWorkspaceFolder(registrationId);
    activeHistoryRepositoryId = registrationId;
    activeHistoryModuleSelection = null;
    publish({ type: 'HISTORY_REPOSITORY_SELECTED', repositoryRegistrationId: registrationId });
  } catch (error) {
    publishError(errorMessage(error, '历史仓选择无效'));
  }
}

async function selectHistoryModule(
  host: ExtensionHost,
  selection: Extract<WebviewToHostMessage, { type: 'SELECT_HISTORY_MODULE' }>,
): Promise<void> {
  try {
    const folder = requireHistoryWorkspaceFolder(selection.repositoryRegistrationId);
    const binding: ActiveHistoryModuleBinding = {
      sourceWorkspaceId: folder.uri.toString(),
      selection: {
        repositoryRegistrationId: selection.repositoryRegistrationId,
        repositoryId: selection.repositoryId,
        catalogId: selection.catalogId,
        catalogHash: selection.catalogHash,
        moduleId: selection.moduleId,
      },
    };
    await assertHistoryModuleBindingCurrent(host, binding);
    activeHistoryRepositoryId = selection.repositoryRegistrationId;
    activeHistoryModuleSelection = binding;
    publish({ type: 'HISTORY_MODULE_SELECTED', selection: activeHistoryModuleSelection.selection });
  } catch (error) {
    publishError(errorMessage(error, '历史模块选择无效'));
  }
}

async function assertHistoryModuleBindingCurrent(
  host: ExtensionHost,
  binding: ActiveHistoryModuleBinding,
): Promise<ActiveHistoryModuleBinding> {
  const folder = requireHistoryWorkspaceFolder(binding.selection.repositoryRegistrationId);
  if (folder.uri.toString() !== binding.sourceWorkspaceId) {
    throw new Error('历史仓注册已经指向不同的 Host 工作区。');
  }
  const inspection = await host.moduleMigration.inspectRepository(folder);
  if (inspection.manifest?.status !== 'ready') {
    throw new Error('该历史仓没有当前有效的模块知识发布。');
  }
  // This re-analyzes the repository and rejects a catalog whose source
  // snapshot is no longer current; the cached Webview projection is never an
  // authorization source.
  const catalog = (await host.moduleMigration.getReviewedCatalogHead(folder)).catalog;
  const selection = binding.selection;
  if (
    catalog.status !== 'active' ||
    !catalog.reviewId ||
    !catalog.reviewHash ||
    catalog.repositoryId !== selection.repositoryId ||
    catalog.id !== selection.catalogId ||
    catalog.contentHash !== selection.catalogHash ||
    !catalog.modules.some((module) => module.id === selection.moduleId)
  ) {
    throw new Error('模块选择不属于当前已审且已发布的 active catalog。');
  }
  return binding;
}

async function runModuleWorkspaceAction(
  host: ExtensionHost,
  workspaceId: string,
  action: ModuleWorkspaceAction,
): Promise<void> {
  try {
    if (action.endsWith('-target') || action.startsWith('review-target') ||
        action.startsWith('retry-target') || action.startsWith('rebase-target')) {
      const folder = panelWorkspaceFolder;
      if (!folder || folder.uri.toString() !== workspaceId) {
        throw new Error('目标工作区操作不属于当前 Host 面板。');
      }
      switch (action) {
        case 'initialize-target':
          await initializeTargetWorkspace(host, host.previews, folder);
          break;
        case 'review-target-boundaries':
          await reviewTargetWorkspaceModules(host, host.previews, folder);
          break;
        case 'retry-target-inventory':
          await retryTargetWorkspaceInventory(host, folder);
          break;
        case 'rebase-target':
          await rebaseTargetWorkspaceBodyOnly(host, host.previews, folder);
          break;
        default:
          throw new Error('该操作不是目标工作区动作。');
      }
      if (TranslationPanel.current) await publishModuleExplorer(host);
      return;
    }

    const folder = requireHistoryWorkspaceFolder(workspaceId);
    const inspection = await host.moduleMigration.inspectRepository(folder).catch(() => undefined);
    const projected = projectHistoryRepository({
      registrationId: workspaceId,
      root: folder.uri.fsPath,
      name: folder.name,
      ...(inspection ?? {}),
    });
    if (projected.lifecycle.nextAction !== action) {
      throw new Error(`历史仓状态已变化；当前动作应为 ${projected.lifecycle.nextAction ?? 'none'}。`);
    }
    switch (action) {
      case 'import-history':
        await host.moduleMigration.indexRepository(folder);
        break;
      case 'review-history-boundaries':
        await host.moduleMigration.reviewRepositoryModuleBoundaries(folder);
        break;
      case 'generate-history-summaries':
        await host.moduleMigration.generateRepositoryModuleSummaries(folder);
        break;
      case 'review-history-knowledge':
        await host.moduleMigration.reviewRepositoryModuleKnowledge(folder);
        break;
      case 'withdraw-history-publication':
        await host.moduleMigration.withdrawRepositoryModuleKnowledge(folder);
        break;
      default:
        throw new Error('该操作不是历史仓动作。');
    }
    if (activeHistoryRepositoryId === workspaceId) activeHistoryModuleSelection = null;
    await publishModuleExplorer(host);
  } catch (error) {
    publishError(errorMessage(error, '模块工作区操作失败'));
  }
}

async function startSearch(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, { type: 'START_SEARCH' }>,
): Promise<void> {
  try {
    const run = requireActiveRun();
    await assertTargetUnchanged(run, host);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const executionContext = await host.moduleMappings.executionContext(
      run.migrationSelection.moduleMapping,
    );
    assertRunContextCurrent(run, executionContext);
    const runtime = host.services.getRuntimePortsV2(executionContext.runtimeCapabilities);
    await startSearchV2(run, runtime.search, {
      requirement: message.requirement,
      topK: message.topK,
      // The current V2 retrieval contract has no lineage-preserving reranker.
      // Fail closed at the client instead of asking the server to ignore it.
      rerank: false,
    });
    publish({ type: 'SEARCH_RESULT', candidates: run.candidates });
  } catch (error) {
    publishError(errorMessage(error, '检索失败'));
  }
}

async function selectCandidate(host: ExtensionHost, candidateId: string): Promise<void> {
  try {
    const run = requireActiveRun();
    await assertTargetUnchanged(run, host);
    const executionContext = await host.moduleMappings.executionContext(
      run.migrationSelection.moduleMapping,
    );
    const runtime = host.services.getRuntimePortsV2(executionContext.runtimeCapabilities);
    const sourceBundle = await selectCandidateV2(
      run,
      candidateId,
      runtime.sourceBundleResolver,
      executionContext,
    );
    publish({ type: 'CANDIDATE_SELECTED', candidateId, sourceBundle });
  } catch (error) {
    publishError(errorMessage(error, '候选选择无效'));
  }
}

async function startAdaptation(host: ExtensionHost, decisionNotes: string): Promise<void> {
  try {
    const run = requireActiveRun();
    selectedCandidateV2(run);
    await assertTargetUnchanged(run, host);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const executionContext = await host.moduleMappings.executionContext(
      run.migrationSelection.moduleMapping,
    );
    assertRunContextCurrent(run, executionContext);
    const targetWorkspaceContext = await host.targetWorkspaces.getTargetContext({
      workspaceId: run.migrationSelection.workspaceId,
      snapshotId: run.migrationSelection.targetWorkspaceSnapshotId,
      snapshotHash: run.migrationSelection.targetWorkspaceSnapshotHash,
      entityId: run.target.entity.entityId,
    });
    const targetContext = collectTargetContextV2({
      target: run.target,
      runtimeCapabilities: executionContext.runtimeCapabilities,
      context: targetWorkspaceContext,
      targetFileContent: run.originalContent,
    });
    const runtime = host.services.getRuntimePortsV2(executionContext.runtimeCapabilities);
    const result = await adaptRunV2(
      run,
      targetContext,
      executionContext,
      runtime.adaptation,
      decisionNotes.trim() ? [decisionNotes.trim()] : [],
    );
    validateHostOwnedPatch(run, result);
    publish({ type: 'ADAPT_RESULT', result });
  } catch (error) {
    publishError(errorMessage(error, '迁移适配失败'));
  }
}

async function applyCurrentRun(host: ExtensionHost): Promise<void> {
  try {
    const { context } = host;
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    if (!adaptation) throw new Error('尚未生成当前迁移运行的补丁。');
    const adaptationRequest = run.adaptationRequest;
    if (!adaptationRequest || !run.sourceBundle || !run.indexedDocument || !run.searchRequest) {
      throw new Error('V2 运行缺少 request/bundle/context lineage，禁止写回。');
    }
    const gate = evaluateValidationPolicyGate(
      adaptation.validationPolicy,
      adaptation.validation,
      { subjectHash: adaptation.patchHash },
    );
    if (!canApplyAdaptationForRoute(
      adaptation,
      adaptation.validationPolicy,
      { subjectHash: adaptation.patchHash },
    )) {
      const labels = gate.blockers.map((record) => record.label).join('、');
      throw new Error(`必需验证未通过或尚未验证：${labels || '缺少可写回补丁'}。`);
    }
    await assertTargetUnchanged(run, host);
    const executionContext = await host.moduleMappings.executionContext(
      run.migrationSelection.moduleMapping,
    );
    assertRunContextCurrent(run, executionContext);
    validateHostOwnedPatch(run, adaptation);
    const confirmation =
      `将把已预览、并通过路线策略验证的补丁写入当前 ${run.target.entity.languageId} 目标，` +
      '同时创建可恢复检查点与 V2 审计清单。确认继续？';
    const choice = await vscode.window.showWarningMessage(
      confirmation,
      { modal: true },
      '应用补丁',
    );
    if (choice !== '应用补丁') {
      publishError('已取消应用补丁。');
      return;
    }

    const now = new Date().toISOString();
    const artifactStore = new MigrationRunV2Store(context.globalStorageUri);
    const artifactPaths = await artifactStore.writeArtifacts(adaptationRequest.id, {
      searchRequest: run.searchRequest,
      searchCandidate: selectedCandidateV2(run),
      indexedDocument: run.indexedDocument,
      sourceBundle: run.sourceBundle,
      targetContext: run.targetContext,
      adaptationRequest,
      adaptationResult: adaptation,
      executionContext,
    });
    const approvedManifest = materializeMigrationRunManifestV2({
      status: 'approved',
      request: adaptationRequest,
      result: adaptation,
      providers: manifestProviderExecutions(
        executionContext.runtimeCapabilities,
        run,
        adaptation,
        now,
        false,
      ),
      validators: manifestValidatorExecutions(adaptation),
      artifactPaths,
      createdAt: adaptation.createdAt,
      updatedAt: now,
    }, executionContext);
    await artifactStore.writeManifest(adaptationRequest.id, approvedManifest);

    const backfill = new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPaths: [...run.target.allowedModificationPaths],
    });
    let result: Awaited<ReturnType<WorkspaceBackfill['apply']>> | null = null;
    try {
      result = await backfill.apply(adaptation.files);
      const checkpoint = await backfill.checkpointRef(result.checkpointId);
      const pendingRecoveryHead = await artifactStore.writeManifest(
        adaptationRequest.id,
        materializeMigrationRunManifestV2({
          status: 'executing',
          request: adaptationRequest,
          result: adaptation,
          providers: manifestProviderExecutions(
            executionContext.runtimeCapabilities,
            run,
            adaptation,
            new Date().toISOString(),
            true,
          ),
          validators: manifestValidatorExecutions(adaptation),
          checkpoint,
          recovery: recoveryRecord(
            executionContext,
            run.target.route.routeId,
            checkpoint,
            'available',
          ),
          artifactPaths,
          createdAt: adaptation.createdAt,
          updatedAt: new Date().toISOString(),
        }, executionContext),
      );
      await context.workspaceState.update('forexplore.lastCheckpoint', {
        checkpointId: result.checkpointId,
        workspaceUri: run.workspaceFolder.uri.toString(),
        allowedTargetPaths: [...run.target.allowedModificationPaths],
        runId: adaptationRequest.id,
        manifestId: pendingRecoveryHead.manifestId,
        manifestHash: pendingRecoveryHead.manifestHash,
        manifestPath: pendingRecoveryHead.path,
      } satisfies LastCheckpoint);
      const completedAt = new Date().toISOString();
      const manifest = materializeMigrationRunManifestV2({
        status: 'completed',
        request: adaptationRequest,
        result: adaptation,
        providers: manifestProviderExecutions(
          executionContext.runtimeCapabilities,
          run,
          adaptation,
          completedAt,
          true,
        ),
        validators: manifestValidatorExecutions(adaptation),
        checkpoint,
        recovery: recoveryRecord(
          executionContext,
          run.target.route.routeId,
          checkpoint,
          'available',
        ),
        artifactPaths,
        createdAt: adaptation.createdAt,
        updatedAt: completedAt,
      }, executionContext);
      run.manifest = manifest;
      const completedHead = await artifactStore.writeManifest(adaptationRequest.id, manifest);
      await context.workspaceState.update('forexplore.lastCheckpoint', {
        checkpointId: result.checkpointId,
        workspaceUri: run.workspaceFolder.uri.toString(),
        allowedTargetPaths: [...run.target.allowedModificationPaths],
        runId: adaptationRequest.id,
        manifestId: completedHead.manifestId,
        manifestHash: completedHead.manifestHash,
        manifestPath: completedHead.path,
      } satisfies LastCheckpoint);
      publish({ type: 'APPLY_RESULT', result, manifest });
      await invalidateTargetWorkspaceAfterMutation(host, run, '目标补丁已写回；旧实现状态证据不再是当前状态。');
    } catch (postApplyError) {
      if (!result) throw postApplyError;
      let checkpoint: MigrationCheckpointRefV2;
      try {
        checkpoint = await backfill.checkpointRef(result.checkpointId);
        await backfill.restore(result.checkpointId);
        const rolledBackAt = new Date().toISOString();
        const rolledBack = materializeMigrationRunManifestV2({
          status: 'rolled-back',
          request: adaptationRequest,
          result: adaptation,
          providers: markRollbackProvider(
            manifestProviderExecutions(
              executionContext.runtimeCapabilities,
              run,
              adaptation,
              rolledBackAt,
              true,
            ),
            'completed',
            checkpoint,
            rolledBackAt,
          ),
          validators: manifestValidatorExecutions(adaptation),
          checkpoint,
          recovery: recoveryRecord(
            executionContext,
            run.target.route.routeId,
            checkpoint,
            'completed',
          ),
          artifactPaths,
          createdAt: adaptation.createdAt,
          updatedAt: rolledBackAt,
        }, executionContext);
        await artifactStore.writeManifest(adaptationRequest.id, rolledBack);
        await context.workspaceState.update('forexplore.lastCheckpoint', undefined);
      } catch (rollbackError) {
        await artifactStore.writeRecoveryRecord(adaptationRequest.id, {
          schemaVersion: '1.0',
          status: 'failed',
          checkpointId: result.checkpointId,
          originalError: errorMessage(postApplyError, 'post-apply-audit-failed'),
          recoveryError: errorMessage(rollbackError, 'automatic-recovery-failed'),
          updatedAt: new Date().toISOString(),
        });
        throw new Error('写回后的审计持久化失败，自动恢复也失败；可恢复检查点已保留。', {
          cause: rollbackError,
        });
      }
      throw new Error('写回后的审计持久化失败；Host 已从检查点自动恢复全部文件。', {
        cause: postApplyError,
      });
    }
  } catch (error) {
    publishError(errorMessage(error, '回填失败'));
  }
}

async function restoreLastCheckpoint(host: ExtensionHost): Promise<void> {
  const { context } = host;
  const checkpoint = context.workspaceState.get<LastCheckpoint>('forexplore.lastCheckpoint');
  if (!isLastCheckpoint(checkpoint)) {
    void vscode.window.showInformationMessage('没有可验证的 V2 可恢复检查点。');
    return;
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) =>
    folder.uri.toString() === checkpoint.workspaceUri);
  if (!workspaceFolder) {
    void vscode.window.showWarningMessage('请先重新打开该检查点所属工作区，再执行恢复。');
    return;
  }
  const artifactStore = new MigrationRunV2Store(context.globalStorageUri);
  let request: AdaptationRequestV2;
  let result: AdaptationResultV2;
  let executionContext: MigrationExecutionV2ValidationContext;
  let previousManifest: MigrationRunManifestV2;
  try {
    [request, result, executionContext, previousManifest] = await Promise.all([
      artifactStore.readArtifact<AdaptationRequestV2>(checkpoint.runId, 'adaptationRequest'),
      artifactStore.readArtifact<AdaptationResultV2>(checkpoint.runId, 'adaptationResult'),
      artifactStore.readArtifact<MigrationExecutionV2ValidationContext>(checkpoint.runId, 'executionContext'),
      artifactStore.readManifest<MigrationRunManifestV2>(checkpoint.runId, checkpoint.manifestId),
    ]);
    if (
      previousManifest.contentHash !== checkpoint.manifestHash ||
      previousManifest.id !== checkpoint.manifestId
    ) throw new Error('Persisted manifest head does not match the immutable manifest.');
    validateMigrationRunManifestV2(previousManifest, request, result, executionContext);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '恢复审计制品无效'));
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    '将恢复最近一次 ForeXplore 写入前的文件内容；若文件后来又被编辑，恢复会被拒绝。确认继续？',
    { modal: true },
    '恢复检查点',
  );
  if (choice !== '恢复检查点') return;
  try {
    const backfill = new WorkspaceBackfill({
      workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPaths: [...checkpoint.allowedTargetPaths],
    });
    const checkpointRef = await backfill.checkpointRef(checkpoint.checkpointId);
    const restoreResult = await backfill.restore(checkpoint.checkpointId);
    const restoredAt = new Date().toISOString();
    const rolledBack = materializeMigrationRunManifestV2({
      status: 'rolled-back',
      request,
      result,
      providers: markRollbackProvider(
        previousManifest.providers,
        'completed',
        checkpointRef,
        restoredAt,
      ),
      validators: previousManifest.validators,
      repairRounds: previousManifest.repairRounds,
      checkpoint: checkpointRef,
      recovery: recoveryRecord(
        executionContext,
        request.route.routeId,
        checkpointRef,
        'completed',
      ),
      artifactPaths: previousManifest.artifactPaths,
      createdAt: previousManifest.createdAt,
      updatedAt: restoredAt,
    }, executionContext);
    await artifactStore.writeManifest(checkpoint.runId, rolledBack);
    await context.workspaceState.update('forexplore.lastCheckpoint', undefined);
    const run = activeRun;
    if (run && run.workspaceFolder.uri.toString() === checkpoint.workspaceUri) {
      await invalidateTargetWorkspaceAfterMutation(host, run, '目标文件已从检查点恢复；请刷新 01B 快照后继续。');
    }
    void vscode.window.showInformationMessage(`已恢复 ${restoreResult.appliedFiles.join('、')}。`);
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error, '恢复失败'));
  }
}

async function refreshPanelStatus(host: ExtensionHost): Promise<void> {
  try {
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const statuses = await refreshRepositoryStatus(host.services, host.health);
    publish({ type: 'REPOSITORY_STATUS', statuses });
  } catch (error) {
    publishError(errorMessage(error, '状态检查失败'));
  }
}

async function openTarget(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.window.showTextDocument(run.targetUri, {
      preview: true,
      selection: new vscode.Range(
        0,
        0,
        0,
        0,
      ),
    });
  } catch (error) {
    publishError(errorMessage(error, '无法打开当前目标文件'));
  }
}

async function copyTargetPath(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.env.clipboard.writeText(run.targetUri.fsPath);
  } catch (error) {
    publishError(errorMessage(error, '无法复制当前目标路径'));
  }
}

async function revealTargetInExplorer(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.commands.executeCommand('revealInExplorer', run.targetUri);
  } catch (error) {
    publishError(errorMessage(error, '无法在资源管理器中定位当前目标'));
  }
}

function validateHostOwnedPatch(
  run: ActiveMigrationRun,
  result: AdaptationResultV2,
): void {
  if (result.files.length === 0 || !run.targetContext) {
    throw new Error('Host write-back requires patches and an authoritative V2 target context.');
  }
  const allowed = new Set(run.target.allowedModificationPaths.map((allowedPath) =>
    canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, allowedPath)));
  const seen = new Set<string>();
  for (const patch of result.files) {
    const returnedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, patch.path);
    if (!allowed.has(returnedPath) || seen.has(returnedPath)) {
      throw new Error(`V2 patch path is unauthorized or duplicated: ${returnedPath}.`);
    }
    seen.add(returnedPath);
    if (patch.status === 'created') continue;
    const sourceFile = run.targetContext.sourceFiles.find((fact) =>
      fact.path === patch.path && fact.content !== undefined,
    );
    if (
      !sourceFile ||
      sourceFile.contentHash !== patch.expectedOriginalSha256 ||
      (returnedPath === canonicalWorkspacePath(
        run.workspaceFolder.uri.fsPath,
        run.target.entity.path,
      ) && patch.expectedOriginalSha256 !== run.originalSha256)
    ) {
      throw new Error(`V2 patch original hash lacks a Host-verified source-file fact: ${returnedPath}.`);
    }
    applyHunksStrict(sourceFile.content!, patch.hunks);
  }
}

function manifestProviderExecutions(
  runtimeCapabilities: ActiveMigrationRun['migrationSelection']['moduleMapping']['runtimeCapabilitySnapshot'],
  run: ActiveMigrationRun,
  result: AdaptationResultV2,
  timestamp: string,
  workspaceApplied: boolean,
): MigrationRunManifestV2['providers'] {
  const route = runtimeCapabilities.routes.find((candidate) =>
    candidate.id === run.target.route.routeId &&
    candidate.version === run.target.route.routeVersion &&
    candidate.contentHash === run.target.route.routeContentHash,
  );
  if (!route) throw new Error('Manifest route is absent from the active runtime snapshot.');
  return route.stages
    .filter((stage) => stage.availability.status !== 'unavailable')
    .map((stage) => {
      const records = validationForStage(stage.stage, result);
      const status: MigrationRunManifestV2['providers'][number]['status'] =
        stage.stage === 'workspace-rollback'
          ? 'unverified'
          : records.some((record) => record.status === 'fail')
            ? 'failed'
            : records.some((record) => record.status === 'unverified')
              ? 'unverified'
              : provenProviderStage(stage.stage, run, workspaceApplied)
                ? 'completed'
                : 'unverified';
      const artifactRefs = stageArtifactRefs(stage.stage, run, result);
      return {
        providerId: stage.providerId,
        providerVersion: stage.providerVersion,
        stage: stage.stage,
        status,
        startedAt: timestamp,
        completedAt: timestamp,
        artifactRefs,
      };
    });
}

function manifestValidatorExecutions(
  result: AdaptationResultV2,
): MigrationRunManifestV2['validators'] {
  return result.validation.map((record) => {
    if (!record.verifierId || !record.verifierVersion || !record.policyCheckId) {
      throw new Error(`Validation record ${record.id} lacks durable verifier lineage.`);
    }
    return {
      providerId: record.verifierId,
      providerVersion: record.verifierVersion,
      policyCheckId: record.policyCheckId,
      validationRecordId: record.id,
      subjectHash: result.patchHash,
      status: record.status,
      artifactRefs: [],
    };
  });
}

function validationForStage(
  stage: MigrationRouteStage,
  result: AdaptationResultV2,
): AdaptationResultV2['validation'] {
  if (stage === 'compile-validation') {
    return result.validation.filter((record) => record.phase === 'compile');
  }
  if (stage === 'behavior-validation') {
    return result.validation.filter((record) => record.phase === 'behavior');
  }
  return [];
}

function provenProviderStage(
  stage: MigrationRouteStage,
  run: ActiveMigrationRun,
  workspaceApplied: boolean,
): boolean {
  if (stage === 'source-analysis') return run.sourceBundle !== null && run.indexedDocument !== null;
  if (stage === 'target-analysis' || stage === 'context-collection') return run.targetContext !== null;
  if (stage === 'workspace-apply') return workspaceApplied;
  return stage === 'translation' || stage === 'patch-generation';
}

function stageArtifactRefs(
  stage: MigrationRouteStage,
  run: ActiveMigrationRun,
  result: AdaptationResultV2,
): MigrationRunManifestV2['providers'][number]['artifactRefs'] {
  if (stage === 'source-analysis' && run.sourceBundle && run.indexedDocument) {
    return [
      { id: run.indexedDocument.id, contentHash: run.indexedDocument.contentHash },
      { id: run.sourceBundle.id, contentHash: run.sourceBundle.contentHash },
    ];
  }
  if ((stage === 'target-analysis' || stage === 'context-collection') && run.targetContext) {
    return [{ id: run.targetContext.id, contentHash: run.targetContext.contentHash }];
  }
  return [{ id: result.id, contentHash: result.contentHash }];
}

function routeStageProvider(
  runtimeCapabilities: ActiveMigrationRun['migrationSelection']['moduleMapping']['runtimeCapabilitySnapshot'],
  routeId: string,
  stage: MigrationRouteStage,
): { providerId: string; providerVersion: string } {
  const route = runtimeCapabilities.routes.find((candidate) => candidate.id === routeId);
  const capability = route?.stages.find((candidate) =>
    candidate.stage === stage && candidate.availability.status !== 'unavailable',
  );
  if (!capability) throw new Error(`The active route has no available ${stage} provider.`);
  return {
    providerId: capability.providerId,
    providerVersion: capability.providerVersion,
  };
}

function recoveryRecord(
  context: MigrationExecutionV2ValidationContext,
  routeId: string,
  checkpoint: MigrationCheckpointRefV2,
  status: 'available' | 'completed' | 'failed',
  failureReason?: string,
): NonNullable<MigrationRunManifestV2['recovery']> {
  return {
    status,
    checkpointId: checkpoint.id,
    provider: routeStageProvider(context.runtimeCapabilities, routeId, 'workspace-rollback'),
    artifactRefs: [{ id: checkpoint.id, contentHash: checkpoint.contentHash }],
    updatedAt: new Date().toISOString(),
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

function markRollbackProvider(
  providers: MigrationRunManifestV2['providers'],
  status: 'completed' | 'failed',
  checkpoint: MigrationCheckpointRefV2,
  completedAt: string,
): MigrationRunManifestV2['providers'] {
  let found = false;
  const updated = providers.map((provider) => {
    if (provider.stage !== 'workspace-rollback') return provider;
    found = true;
    return {
      ...provider,
      status,
      completedAt,
      artifactRefs: [{ id: checkpoint.id, contentHash: checkpoint.contentHash }],
    };
  });
  if (!found) throw new Error('The V2 route lacks an available workspace rollback provider.');
  return updated;
}

function isLastCheckpoint(value: LastCheckpoint | undefined): value is LastCheckpoint {
  return Boolean(
    value &&
    value.checkpointId &&
    value.workspaceUri &&
    Array.isArray(value.allowedTargetPaths) &&
    value.allowedTargetPaths.length > 0 &&
    value.allowedTargetPaths.every((item) => typeof item === 'string' && item.length > 0) &&
    value.runId &&
    value.manifestId &&
    isSha256(value.manifestHash) &&
    value.manifestPath,
  );
}

function requireActiveRun(): ActiveMigrationRun {
  if (!activeRun) throw new Error('请先从已保存的目标实体启动一次迁移。');
  return activeRun;
}


async function assertTargetUnchanged(
  run: ActiveMigrationRun,
  host: ExtensionHost,
): Promise<void> {
  if (run.migrationSelection) {
    const binding = run.migrationSelection;
    await host.services.refresh();
    await host.moduleMappings.assertBindingCurrent(binding.moduleMapping);
    await refreshTargetWorkspaceBinding(host, {
      workspaceId: binding.workspaceId,
      snapshotId: binding.targetWorkspaceSnapshotId,
      contentHash: binding.targetWorkspaceSnapshotHash,
    });
    const context = await host.targetWorkspaces.getTargetContext({
      workspaceId: binding.workspaceId,
      snapshotId: binding.targetWorkspaceSnapshotId,
      snapshotHash: binding.targetWorkspaceSnapshotHash,
      entityId: binding.target.entity.entityId,
    });
    assertMigrationSelectionLineage(binding, context);
  }
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === run.targetUri.toString(),
  );
  if (openDocument?.isDirty) {
    throw new Error('目标文件有未保存的编辑；请先保存并重新启动迁移以建立新快照。');
  }
  const current = await vscode.workspace.fs.readFile(run.targetUri);
  if (sha256(current) !== run.originalSha256) {
    throw new Error('目标文件已在本次迁移开始后发生变化；请重新启动迁移以生成新快照。');
  }
}

async function refreshTargetWorkspaceBinding(
  host: ExtensionHost,
  selection: { workspaceId: string; snapshotId: string; contentHash: string },
): Promise<TargetWorkspaceHostRecord> {
  const refreshed = await host.targetWorkspaces.refresh(selection.workspaceId);
  const snapshot = refreshed.accepted?.snapshot;
  if (
    refreshed.stage === 'reviewed' &&
    snapshot?.id === selection.snapshotId &&
    snapshot.contentHash === selection.contentHash
  ) {
    return refreshed;
  }
  const reason = refreshed.failure ??
    `目标工作区已经变为 ${refreshed.stage}，旧 snapshot/entity 不再可用。`;
  const panelState = activeTargetWorkspacePanel;
  if (
    panelState?.projection.workspaceId === selection.workspaceId &&
    panelState.projection.snapshotId === selection.snapshotId &&
    panelState.projection.contentHash === selection.contentHash
  ) {
    publishTargetWorkspaceInvalidation(panelState.projection, reason);
    activeTargetWorkspacePanel = null;
    await publishModuleExplorer(host);
  }
  throw new Error(reason);
}

function publishTargetWorkspaceInvalidation(
  snapshot: TargetWorkspaceSnapshot,
  reason: string,
): void {
  const staleProjection: TargetWorkspaceSnapshot = {
    ...snapshot,
    freshness: 'stale',
    staleReason: reason,
  };
  if (
    activeTargetWorkspacePanel?.projection.snapshotId === snapshot.snapshotId &&
    activeTargetWorkspacePanel.projection.contentHash === snapshot.contentHash
  ) {
    activeTargetWorkspacePanel = {
      ...activeTargetWorkspacePanel,
      projection: staleProjection,
    };
  }
  publish({
    type: 'TARGET_WORKSPACE_INVALIDATED',
    invalidation: {
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      reason,
      detectedAt: new Date().toISOString(),
    },
  });
}

async function invalidateTargetWorkspaceAfterMutation(
  host: ExtensionHost,
  run: ActiveMigrationRun,
  reason: string,
): Promise<void> {
  const selection = run.migrationSelection;
  if (!selection) return;
  const panelState = activeTargetWorkspacePanel;
  if (
    panelState &&
    panelState.projection.workspaceId === selection.workspaceId &&
    panelState.projection.snapshotId === selection.targetWorkspaceSnapshotId &&
    panelState.projection.contentHash === selection.targetWorkspaceSnapshotHash
  ) {
    publishTargetWorkspaceInvalidation(panelState.projection, reason);
  }
  try {
    await host.targetWorkspaces.refresh(selection.workspaceId);
    activeTargetWorkspacePanel = null;
    await publishModuleExplorer(host);
  } catch (error) {
    // The write/restore already succeeded. Keep the UI fail-closed and report
    // refresh failure separately instead of misreporting the mutation itself.
    publishError(errorMessage(error, '目标文件已变化，但 01B 快照刷新失败'));
  }
}

function assertMigrationSelectionLineage(
  binding: TargetWorkspaceMigrationSelection,
  context: Awaited<ReturnType<TargetWorkspaceHost['getTargetContext']>>,
): void {
  const lineage = binding.target.lineage;
  const entity = binding.target.entity;
  const snapshotLineage = context.snapshot.lineage;
  const mappedTarget = binding.moduleMapping.targetCatalog;
  const mappedRoute = binding.moduleMapping.route;
  const routeOptions = binding.routeOptions.filter(({ route }) =>
    route.id === mappedRoute.routeId &&
    route.version === mappedRoute.routeVersion &&
    route.sourceLanguageId === mappedRoute.sourceLanguageId &&
    route.targetLanguageId === mappedRoute.targetLanguageId &&
    route.strategy === mappedRoute.strategy &&
    route.contentHash === mappedRoute.routeContentHash,
  );
  const coherent =
    context.workspaceId === binding.workspaceId &&
    context.snapshot.id === binding.targetWorkspaceSnapshotId &&
    context.snapshot.contentHash === binding.targetWorkspaceSnapshotHash &&
    snapshotLineage.repositoryId === lineage.repositoryId &&
    snapshotLineage.repositoryContentHash === lineage.repositoryContentHash &&
    snapshotLineage.unifiedRepositoryIrId === lineage.unifiedRepositoryIrId &&
    snapshotLineage.unifiedRepositoryIrHash === lineage.unifiedRepositoryIrHash &&
    snapshotLineage.moduleCatalogId === lineage.moduleCatalogId &&
    snapshotLineage.moduleCatalogHash === lineage.moduleCatalogHash &&
    snapshotLineage.moduleReviewId === lineage.moduleReviewId &&
    snapshotLineage.moduleReviewHash === lineage.moduleReviewHash &&
    mappedTarget.repositoryId === snapshotLineage.repositoryId &&
    mappedTarget.repositoryContentHash === snapshotLineage.repositoryContentHash &&
    mappedTarget.unifiedRepositoryIrId === snapshotLineage.unifiedRepositoryIrId &&
    mappedTarget.unifiedRepositoryIrHash === snapshotLineage.unifiedRepositoryIrHash &&
    mappedTarget.moduleCatalogId === snapshotLineage.moduleCatalogId &&
    mappedTarget.moduleCatalogHash === snapshotLineage.moduleCatalogHash &&
    mappedTarget.moduleReviewId === snapshotLineage.moduleReviewId &&
    mappedTarget.moduleReviewHash === snapshotLineage.moduleReviewHash &&
    mappedRoute.targetLanguageId === entity.languageId &&
    routeOptions.length === 1 &&
    (!binding.module || (
      context.catalog.id === binding.module.catalogId &&
      context.catalog.contentHash === binding.module.catalogHash &&
      binding.moduleMapping.targetModuleIds.includes(binding.module.moduleId) &&
      context.catalog.modules.some((module) =>
        module.id === binding.module!.moduleId &&
        module.name === binding.module!.moduleName &&
        (context.file ? module.fileIds.includes(context.file.id) : false),
      ) &&
      context.catalog.assignments.some((assignment) =>
        assignment.fileId === context.file?.id &&
        assignment.moduleIds.includes(binding.module!.moduleId),
      )
    )) &&
    (binding.moduleMapping.targetEntityIds.length === 0 ||
      binding.moduleMapping.targetEntityIds.includes(entity.entityId)) &&
    context.entity.id === entity.entityId &&
    context.file?.id === entity.fileId &&
    context.file?.path === entity.path &&
    normalizedLanguageIdOrNull(context.entity.languageId ?? context.file?.languageId) === entity.languageId;
  if (!coherent) {
    throw new Error('目标的 repository/catalog/module/entity lineage 已变化，禁止继续当前迁移运行。');
  }
}

function normalizedLanguageIdOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeLanguageId(value);
  } catch {
    return null;
  }
}

function refreshRepositoryStatus(
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<RepositoryStatus[]> {
  return health
    .checkConfigured()
    .then((statuses) => decorateRepositoryStatuses(statuses, services.serviceStatus));
}

function publish(message: HostToWebviewMessage): void {
  TranslationPanel.current?.post(message);
}

function publishError(message: string): void {
  publish({ type: 'ERROR', message });
}

function summarizeRepositoryStatus(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  return `本地仓库路径：${statuses.length} 个，${unavailable} 个不可用。索引状态由检索服务确认。`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}
