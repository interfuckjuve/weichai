import { createHash } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type {
  AdaptationResult,
  FilePatch,
  ModuleTarget,
  SearchCandidate,
  ValidationRecord,
} from '@forexplore/contracts';
import {
  analyzeRepository,
  writeRepositoryAnalysisArtifact,
} from '@forexplore/code-indexer';
import {
  applyHunksStrict,
  canApplyAdaptation,
  evaluateValidationGate,
} from '@forexplore/workflow-core';
import { WorkspaceBackfill } from './backfill';
import { canonicalWorkspacePath } from './diff-apply';
import {
  ModuleMigrationHost,
  ModuleMigrationPreviewProvider,
  moduleMigrationPreviewScheme,
} from './module-migration-host';
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
import { loadSettings } from './settings';
import { buildModuleTarget } from './target-builder';
import {
  TargetWorkspaceHost,
  type TargetWorkspaceHostRecord,
} from './target-workspace-host';
import { LocalTargetWorkspaceImplementationInventory } from './target-workspace-implementation-inventory';
import { FileSystemTargetWorkspaceHostStore } from './target-workspace-store';
import {
  assertTargetWorkspaceSelection,
  moduleTargetFromTargetWorkspaceContext,
  projectTargetWorkspace,
} from './target-workspace-projection';
import type {
  TargetWorkspaceSelectionIdentity,
  TargetWorkspaceSnapshot,
} from './protocol/messages';
import type { RepositoryStatus } from './ui-types';

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
}

interface ActiveMigrationRun {
  workspaceFolder: vscode.WorkspaceFolder;
  targetUri: vscode.Uri;
  target: ModuleTarget;
  /** Exact bytes read before retrieval / adaptation began. */
  originalSha256: string;
  originalContent: string;
  requirement: string;
  candidates: SearchCandidate[];
  /** Null until the user expressly clicks a candidate in this run. */
  selectedCandidateId: string | null;
  adaptation: AdaptationResult | null;
  /** Present only when 01B, rather than an editor selection, chose this target. */
  targetWorkspaceSelection?: TargetWorkspaceSelectionIdentity & { workspaceId: string };
}

interface ActiveTargetWorkspacePanel {
  workspaceFolder: vscode.WorkspaceFolder;
  projection: TargetWorkspaceSnapshot;
}

interface LastCheckpoint {
  checkpointId: string;
  workspaceUri: string;
  targetPath: string;
}

let activeRun: ActiveMigrationRun | null = null;
let activeTargetWorkspacePanel: ActiveTargetWorkspacePanel | null = null;
let targetSelectionEpoch = 0;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForeXplore');
  const services = new ServiceManager(output);
  const health = new RepositoryHealthCheck();
  const moduleMigrationPreviews = new ModuleMigrationPreviewProvider();
  const moduleMigration = new ModuleMigrationHost({
    context,
    services,
    output,
    previews: moduleMigrationPreviews,
    waveRecovery: new GitWaveTransaction(),
    waveExecution: new ModuleWaveExecutionCoordinator(),
  });
  const targetWorkspaces = new TargetWorkspaceHost({
    store: new FileSystemTargetWorkspaceHostStore({
      storageDirectory: path.join(context.globalStorageUri.fsPath, 'target-workspaces'),
    }),
    implementationInventory: new LocalTargetWorkspaceImplementationInventory(),
    analyze: async (request) => {
      const analysis = await analyzeRepository(request);
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
  const extensionHost: ExtensionHost = { context, services, health, targetWorkspaces };

  context.subscriptions.push(
    output,
    services,
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    vscode.commands.registerCommand('forexplore.startTranslation', () =>
      startTranslation(extensionHost),
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
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationPlan', () =>
      moduleMigration.reviewPlan(),
    ),
    vscode.commands.registerCommand('forexplore.reviewModuleMigrationWave', () =>
      moduleMigration.reviewNextWave(),
    ),
    vscode.commands.registerCommand('forexplore.prepareModuleMigrationWave', () =>
      moduleMigration.prepareNextWaveFromLocalBundle(),
    ),
    vscode.commands.registerCommand('forexplore.approveModuleMigrationWave', () =>
      moduleMigration.approveAndCommitPreparedWave(),
    ),
    vscode.commands.registerCommand('forexplore.recoverModuleMigrationReview', () =>
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

export function deactivate(): void {
  targetSelectionEpoch += 1;
  activeRun = null;
  activeTargetWorkspacePanel = null;
}

async function startTranslation(
  host: ExtensionHost,
): Promise<void> {
  targetSelectionEpoch += 1;
  const { context, services, health } = host;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('请先打开并选中一个目标方法。');
    return;
  }
  if (editor.selection.isEmpty) {
    void vscode.window.showWarningMessage('请先选中待实现的目标方法或其签名。');
    return;
  }

  const document = editor.document;
  if (document.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('仅支持工作区中的本地受支持语言文件。');
    return;
  }
  if (document.isDirty) {
    void vscode.window.showWarningMessage('请先保存目标文件，再开始迁移，以便建立可校验的文件快照。');
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage('目标文件必须位于已打开的工作区文件夹中。');
    return;
  }

  const target = buildModuleTarget({
    languageId: document.languageId,
    selectedText: document.getText(editor.selection),
    filePath: document.uri.fsPath,
    fileBaseName: path.basename(document.uri.fsPath),
    workspaceRoot: workspaceFolder.uri.fsPath,
    startLine: editor.selection.start.line,
  });
  if (!target) {
    void vscode.window.showErrorMessage(
      `请在工作区内选择受支持语言的目标方法（当前为 ${document.languageId}）。`,
    );
    return;
  }

  const originalBytes = await vscode.workspace.fs.readFile(document.uri);
  activeRun = {
    workspaceFolder,
    targetUri: document.uri,
    target,
    originalSha256: sha256(originalBytes),
    originalContent: Buffer.from(originalBytes).toString('utf8'),
    requirement: '',
    candidates: [],
    selectedCandidateId: null,
    adaptation: null,
  };

  const serviceStatus = await services.refresh();
  const statuses = await refreshRepositoryStatus(services, health);
  const runtime = services.getRuntimePresentation();

  await TranslationPanel.createOrShow(
    context,
    {
      target,
      workspaceRoot: workspaceFolder.uri.fsPath,
      repositoryStatuses: statuses,
      serviceStatus,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    {
      onMessage: (message) => {
        void handlePanelMessage(host, message);
      },
    },
  );
}

async function showPanel(
  host: ExtensionHost,
): Promise<void> {
  if (TranslationPanel.current && activeRun) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    await startTranslation(host);
    return;
  }
  if (activeTargetWorkspacePanel) {
    await showTargetWorkspacePanel(host, activeTargetWorkspacePanel);
    return;
  }
  void vscode.window.showInformationMessage('请先在受支持语言文件中选中待实现的目标方法。');
}

async function initializeTargetWorkspace(
  host: ExtensionHost,
  previews: ModuleMigrationPreviewProvider,
): Promise<void> {
  try {
    const workspaceFolder = await selectTargetWorkspaceFolder();
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
): Promise<void> {
  try {
    const workspaceFolder = await selectTargetWorkspaceFolder();
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

async function retryTargetWorkspaceInventory(host: ExtensionHost): Promise<void> {
  try {
    const workspaceFolder = await selectTargetWorkspaceFolder();
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
): Promise<void> {
  try {
    const workspaceFolder = await selectTargetWorkspaceFolder();
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
      throw new Error(`目标工作区不满足方法体兼容 rebase 条件：${record?.stage ?? 'not-initialized'}。`);
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
    void vscode.window.showErrorMessage(errorMessage(error, '01B 方法体兼容 rebase 失败'));
  }
}

async function openReviewedTargetWorkspace(
  host: ExtensionHost,
  workspaceFolder: vscode.WorkspaceFolder,
  record: TargetWorkspaceHostRecord,
): Promise<void> {
  targetSelectionEpoch += 1;
  const projection = projectTargetWorkspace({ record, workspaceName: workspaceFolder.name });
  const panelState = { workspaceFolder, projection };
  activeTargetWorkspacePanel = panelState;
  activeRun = null;
  await showTargetWorkspacePanel(host, panelState);
}

async function showTargetWorkspacePanel(
  host: ExtensionHost,
  panelState: ActiveTargetWorkspacePanel,
): Promise<void> {
  const serviceStatus = await host.services.refresh();
  const repositoryStatuses = await refreshRepositoryStatus(host.services, host.health);
  const runtime = host.services.getRuntimePresentation();
  await TranslationPanel.createOrShow(
    host.context,
    {
      targetWorkspace: panelState.projection,
      workspaceRoot: panelState.workspaceFolder.uri.fsPath,
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
    const refreshed = await host.targetWorkspaces.refresh(panelState.projection.workspaceId);
    if (refreshed.stage === 'reviewed' && refreshed.accepted?.snapshot) {
      const projection = projectTargetWorkspace({
        record: refreshed,
        workspaceName: panelState.workspaceFolder.name,
      });
      activeTargetWorkspacePanel = { ...panelState, projection };
      publish({ type: 'TARGET_WORKSPACE_SNAPSHOT', snapshot: projection });
      return;
    }
    const reason = refreshed.freshness?.reasonCodes.join('、') ||
      refreshed.failure ||
      `目标工作区处于 ${refreshed.stage}`;
    publishTargetWorkspaceInvalidation(panelState.projection, reason);
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
  if (activateWorkflow) activeRun = null;
  try {
    const panelState = activeTargetWorkspacePanel;
    if (!panelState) throw new Error('当前面板没有已审的 01B 目标工作区。');
    assertTargetWorkspaceSelection(panelState.projection, message);
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
    const target = moduleTargetFromTargetWorkspaceContext(context);
    if (activateWorkflow) {
      const relativeParts = target.path.replaceAll('\\', '/').split('/').filter(Boolean);
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
        workspaceFolder: panelState.workspaceFolder,
        targetUri,
        target,
        originalSha256: sha256(originalBytes),
        originalContent: Buffer.from(originalBytes).toString('utf8'),
        requirement: '',
        candidates: [],
        selectedCandidateId: null,
        adaptation: null,
        targetWorkspaceSelection: {
          workspaceId: panelState.projection.workspaceId,
          snapshotId: message.snapshotId,
          contentHash: message.contentHash,
          nodeId: message.nodeId,
          entityId: message.entityId,
        },
      };
    }
    publish({
      type: 'TARGET_ENTITY_SELECTED',
      selection: message,
      target,
      activateWorkflow,
    });
  } catch (error) {
    publishError(errorMessage(error, '01B 目标选择无效'));
  }
}

async function selectTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('请先打开目标工作区。');
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
      selectCandidate(message.candidateId);
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
    case 'OPEN_TARGET':
      await openTarget();
      return;
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
    const runtime = host.services.getRuntimePorts();
    const candidates = await runtime.ports.search.search({
      target: run.target,
      requirement: message.requirement.trim(),
      topK: message.topK,
      // Local paths are presentation-only checks; only the server can state
      // which repositories were indexed. An empty scope means its configured
      // authorized index, not a fake "configured-repositories" filter.
      repositoryScopes: [],
    });
    run.requirement = message.requirement.trim();
    run.candidates = candidates;
    run.selectedCandidateId = null;
    run.adaptation = null;
    publish({ type: 'SEARCH_RESULT', candidates: run.candidates });
  } catch (error) {
    publishError(errorMessage(error, '检索失败'));
  }
}

function selectCandidate(candidateId: string): void {
  try {
    const run = requireActiveRun();
    const candidate = run.candidates.find((item) => item.id === candidateId);
    if (!candidate) {
      throw new Error('该候选不属于当前检索结果。');
    }
    // This is deliberately the only operation that changes this field. A
    // retrieval ranking never becomes consent by itself.
    run.selectedCandidateId = candidateId;
    run.adaptation = null;
  } catch (error) {
    publishError(errorMessage(error, '候选选择无效'));
  }
}

async function startAdaptation(host: ExtensionHost, decisionNotes: string): Promise<void> {
  try {
    const run = requireActiveRun();
    const candidate = selectedRunCandidate(run);
    await assertTargetUnchanged(run, host);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const runtime = host.services.getRuntimePorts();
    const rawResult = await runtime.ports.adaptation.adapt({
      target: run.target,
      candidate,
      requirement: run.requirement,
      strategy: 'translate',
      decisionNotes,
    });
    const result = validateHostOwnedResult(run, rawResult);
    run.adaptation = result;
    publish({ type: 'ADAPT_RESULT', result });
  } catch (error) {
    publishError(errorMessage(error, '翻译失败'));
  }
}

async function applyCurrentRun(host: ExtensionHost): Promise<void> {
  try {
    const { context } = host;
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    if (!adaptation) throw new Error('尚未生成当前迁移运行的补丁。');
    const gate = evaluateValidationGate(adaptation.validation);
    if (!canApplyAdaptation(adaptation)) {
      const labels = gate.blockers.map((record) => record.label).join('、');
      throw new Error(`必需验证未通过或尚未验证：${labels || '缺少可写回补丁'}。`);
    }
    await assertTargetUnchanged(run, host);
    const referenceFree = adaptation.validation.some(
      (record) => record.id === 'reference-candidate',
    );
    const confirmation = referenceFree
      ? `Analyzer 已拒绝所选参考实现；当前 ${run.target.language} 代码仅依据目标上下文和需求自主生成。请重点审查后再写入 ${run.target.language} 文件。确认继续？`
      : `将把已预览的补丁写入当前选中的 ${run.target.language} 文件，并创建可恢复检查点。确认继续？`;
    const choice = await vscode.window.showWarningMessage(
      confirmation,
      { modal: true },
      '应用补丁',
    );
    if (choice !== '应用补丁') {
      publishError('已取消应用补丁。');
      return;
    }

    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).apply(adaptation.files);
    await context.workspaceState.update('forexplore.lastCheckpoint', {
      checkpointId: result.checkpointId,
      workspaceUri: run.workspaceFolder.uri.toString(),
      targetPath: run.target.path,
    });
    publish({ type: 'APPLY_RESULT', result });
    await invalidateTargetWorkspaceAfterMutation(host, run, '目标补丁已写回；旧实现状态证据不再是当前状态。');
  } catch (error) {
    publishError(errorMessage(error, '回填失败'));
  }
}

async function restoreLastCheckpoint(host: ExtensionHost): Promise<void> {
  const { context } = host;
  const checkpoint = context.workspaceState.get<LastCheckpoint>('forexplore.lastCheckpoint');
  const run = activeRun;
  if (!checkpoint || !run) {
    void vscode.window.showInformationMessage('没有与当前迁移运行关联的可恢复检查点。');
    return;
  }
  if (
    checkpoint.workspaceUri !== run.workspaceFolder.uri.toString() ||
    checkpoint.targetPath !== run.target.path
  ) {
    void vscode.window.showWarningMessage('恢复点不属于当前选中的迁移目标，已拒绝恢复。');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    '将恢复最近一次 ForeXplore 写入前的文件内容；若文件后来又被编辑，恢复会被拒绝。确认继续？',
    { modal: true },
    '恢复检查点',
  );
  if (choice !== '恢复检查点') return;
  try {
    const result = await new WorkspaceBackfill({
      workspaceFolder: run.workspaceFolder,
      storageUri: context.globalStorageUri,
      allowedTargetPath: run.target.path,
    }).restore(checkpoint.checkpointId);
    await context.workspaceState.update('forexplore.lastCheckpoint', undefined);
    await invalidateTargetWorkspaceAfterMutation(host, run, '目标文件已从检查点恢复；请刷新 01B 快照后继续。');
    void vscode.window.showInformationMessage(`已恢复 ${result.appliedFiles.join('、')}。`);
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
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
        Math.max(0, (run.target.line ?? 1) - 1),
        0,
      ),
    });
  } catch (error) {
    publishError(errorMessage(error, '无法打开当前目标文件'));
  }
}

function validateHostOwnedResult(
  run: ActiveMigrationRun,
  result: AdaptationResult,
): AdaptationResult {
  const validation = [...result.validation];
  const failures: string[] = [];
  let files: FilePatch[] = result.files;

  if (result.strategy !== 'translate' || result.targetLanguage !== run.target.language) {
    failures.push('服务返回的策略或目标语言与当前选中的目标不一致。');
  }
  if (files.length !== 1) {
    failures.push('写回只接受当前目标文件的一个修改补丁。');
  }

  const patch = files[0];
  if (patch) {
    const expectedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, run.target.path);
    let returnedPath: string | undefined;
    try {
      returnedPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, patch.path);
    } catch {
      failures.push('服务返回的补丁路径不是工作区内的相对路径。');
    }
    if (patch.status !== 'modified' || returnedPath !== expectedPath) {
      failures.push('服务返回的补丁不严格对应当前选中的目标文件。');
    }
    if (patch.status === 'modified') {
      if (patch.expectedOriginalSha256 !== run.originalSha256) {
        failures.push('服务补丁的原始文件哈希与扩展宿主快照不一致。');
      }
      try {
        applyHunksStrict(run.originalContent, patch.hunks);
      } catch (error) {
        failures.push(
          `补丁不能精确应用到本次目标快照：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  validation.push({
    id: 'extension-target-snapshot',
    label: '扩展目标快照',
    status: failures.length === 0 ? 'pass' : 'fail',
    required: true,
    command: 'VS Code workspace.fs.readFile + SHA-256',
    summary:
      failures.length === 0
        ? '补丁路径、原始哈希和 hunk 均与本次编辑器目标快照一致。'
        : failures.join(' '),
    failureReason: failures.length === 0 ? undefined : 'host-owned-patch-validation-failed',
  });

  if (failures.length > 0) {
    validation.push({
      id: 'extension-patch-scope',
      label: '补丁范围与前置条件',
      status: 'fail',
      required: true,
      summary: failures.join(' '),
      failureReason: 'unsafe-or-stale-patch',
    });
    files = [];
  }

  return { ...result, validation: deduplicateValidation(validation), files };
}

function deduplicateValidation(records: ValidationRecord[]): ValidationRecord[] {
  const ids = new Set<string>();
  return records.filter((record) => {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
    return true;
  });
}

function requireActiveRun(): ActiveMigrationRun {
  if (!activeRun) throw new Error('请先从已保存的目标方法启动一次迁移。');
  return activeRun;
}

function selectedRunCandidate(run: ActiveMigrationRun): SearchCandidate {
  if (!run.selectedCandidateId) {
    throw new Error('请先明确点击并选择一个候选实现。');
  }
  const candidate = run.candidates.find((item) => item.id === run.selectedCandidateId);
  if (!candidate) {
    throw new Error('当前候选已失效；请重新检索并明确选择。');
  }
  return candidate;
}

async function assertTargetUnchanged(
  run: ActiveMigrationRun,
  host: ExtensionHost,
): Promise<void> {
  if (run.targetWorkspaceSelection) {
    await refreshTargetWorkspaceBinding(host, run.targetWorkspaceSelection);
    await host.targetWorkspaces.getTargetContext({
      workspaceId: run.targetWorkspaceSelection.workspaceId,
      snapshotId: run.targetWorkspaceSelection.snapshotId,
      snapshotHash: run.targetWorkspaceSelection.contentHash,
      entityId: run.targetWorkspaceSelection.entityId,
    });
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
  const selection = run.targetWorkspaceSelection;
  if (!selection) return;
  const panelState = activeTargetWorkspacePanel;
  if (
    panelState &&
    panelState.projection.workspaceId === selection.workspaceId &&
    panelState.projection.snapshotId === selection.snapshotId &&
    panelState.projection.contentHash === selection.contentHash
  ) {
    publishTargetWorkspaceInvalidation(panelState.projection, reason);
  }
  try {
    await host.targetWorkspaces.refresh(selection.workspaceId);
  } catch (error) {
    // The write/restore already succeeded. Keep the UI fail-closed and report
    // refresh failure separately instead of misreporting the mutation itself.
    publishError(errorMessage(error, '目标文件已变化，但 01B 快照刷新失败'));
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}
