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
import type { ModuleWaveExecutionPort } from './module-wave-execution-host';
import type { ModuleMigrationWaveRecoveryPort } from './module-migration-recovery';
import { TranslationPanel } from './panel';
import { buildModuleExplorer } from './module-explorer';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import { loadSettings, savePanelSettings } from './settings';
import { buildModuleTarget } from './target-builder';
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
}

interface LastCheckpoint {
  checkpointId: string;
  workspaceUri: string;
  targetPath: string;
}

let activeRun: ActiveMigrationRun | null = null;
let moduleExplorerTargets = new Map<string, ModuleTarget>();

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

  context.subscriptions.push(
    output,
    services,
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    vscode.commands.registerCommand('forexplore.startTranslation', () =>
      startTranslation(context, services, health),
    ),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(context, services, health),
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
      restoreLastCheckpoint(context),
    ),
    vscode.commands.registerCommand('forexplore.indexModuleMigrationRepository', () =>
      moduleMigration.indexRepository(),
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
  activeRun = null;
  moduleExplorerTargets = new Map();
}

async function startTranslation(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<void> {
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

  const settings = loadSettings();
  const serviceStatus = await services.refresh();
  const [statuses, moduleExplorer] = await Promise.all([
    refreshRepositoryStatus(services, health),
    buildModuleExplorer({
      workspaceRoot: workspaceFolder.uri.fsPath,
      workspaceName: workspaceFolder.name,
      currentTarget: target,
      historyRoots: settings.repositoryPaths,
    }, { includeHistory: false }),
  ]);
  moduleExplorerTargets = moduleExplorer.targets;
  const runtime = services.getRuntimePresentation();

  await TranslationPanel.createOrShow(
    context,
    {
      target,
      workspaceRoot: workspaceFolder.uri.fsPath,
      settings: {
        repositoryPaths: settings.repositoryPaths,
        topK: settings.topK,
      },
      repositoryStatuses: statuses,
      serviceStatus,
      moduleExplorer: moduleExplorer.presentation,
      searchProvider: runtime.searchProvider,
      adaptationProvider: runtime.adaptationProvider,
    },
    {
      onMessage: (message) => {
        void handlePanelMessage({ context, services, health }, message);
      },
    },
  );
}

async function showPanel(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
): Promise<void> {
  if (TranslationPanel.current && activeRun) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    await startTranslation(context, services, health);
    return;
  }
  void vscode.window.showInformationMessage('请先在受支持语言文件中选中待实现的目标方法。');
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
    case 'SELECT_CANDIDATE':
      selectCandidate(message.candidateId);
      return;
    case 'START_ADAPT':
      await startAdaptation(host, message.decisionNotes);
      return;
    case 'APPLY_CURRENT_RUN':
      await applyCurrentRun(host.context);
      return;
    case 'CHECK_REPOSITORIES':
      await refreshPanelStatus(host);
      return;
    case 'REFRESH_MODULE_EXPLORER':
      await refreshModuleExplorer();
      return;
    case 'SAVE_SETTINGS':
      await updatePanelSettings(host, message.settings);
      return;
    case 'SELECT_WORKSPACE_TARGET':
      await selectWorkspaceTarget(message.targetId);
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

async function updatePanelSettings(
  host: ExtensionHost,
  settings: Extract<WebviewToHostMessage, { type: 'SAVE_SETTINGS' }>['settings'],
): Promise<void> {
  let saved: Awaited<ReturnType<typeof savePanelSettings>>;
  try {
    saved = await savePanelSettings(settings);
  } catch (error) {
    publishError(errorMessage(error, '保存设置失败'));
    return;
  }

  publish({ type: 'SETTINGS_UPDATED', settings: saved });
  try {
    const run = requireActiveRun();
    const [statuses, explorer] = await Promise.all([
      refreshRepositoryStatus(host.services, host.health),
      buildModuleExplorer({
        workspaceRoot: run.workspaceFolder.uri.fsPath,
        workspaceName: run.workspaceFolder.name,
        currentTarget: run.target,
        historyRoots: saved.repositoryPaths,
      }, { includeHistory: false }),
    ]);
    moduleExplorerTargets = explorer.targets;
    publish({ type: 'REPOSITORY_STATUS', statuses });
    publish({ type: 'MODULE_EXPLORER', explorer: explorer.presentation });
  } catch (error) {
    publishError(errorMessage(error, '设置已保存，但刷新仓库状态失败'));
  }
}

async function refreshModuleExplorer(): Promise<void> {
  try {
    const run = requireActiveRun();
    const result = await buildModuleExplorer({
      workspaceRoot: run.workspaceFolder.uri.fsPath,
      workspaceName: run.workspaceFolder.name,
      currentTarget: run.target,
      historyRoots: loadSettings().repositoryPaths,
    });
    moduleExplorerTargets = result.targets;
    publish({ type: 'MODULE_EXPLORER', explorer: result.presentation });
  } catch (error) {
    publishError(errorMessage(error, '刷新模块视图失败'));
  }
}

async function selectWorkspaceTarget(targetId: string): Promise<void> {
  try {
    const run = requireActiveRun();
    const target = moduleExplorerTargets.get(targetId);
    if (!target) throw new Error('该目标不属于当前 Host 静态分析快照。');
    if (target.id === run.target.id) return;
    const canonicalPath = canonicalWorkspacePath(run.workspaceFolder.uri.fsPath, target.path);
    const targetUri = vscode.Uri.joinPath(run.workspaceFolder.uri, ...canonicalPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === targetUri.toString(),
    );
    if (openDocument?.isDirty) {
      throw new Error('新目标文件有未保存的编辑；请先保存后再切换目标。');
    }
    const originalBytes = await vscode.workspace.fs.readFile(targetUri);
    activeRun = {
      workspaceFolder: run.workspaceFolder,
      targetUri,
      target,
      originalSha256: sha256(originalBytes),
      originalContent: Buffer.from(originalBytes).toString('utf8'),
      requirement: '',
      candidates: [],
      selectedCandidateId: null,
      adaptation: null,
    };
    publish({ type: 'TARGET_SELECTED', target });
  } catch (error) {
    publishError(errorMessage(error, '切换目标失败'));
  }
}

async function startSearch(
  host: ExtensionHost,
  message: Extract<WebviewToHostMessage, { type: 'START_SEARCH' }>,
): Promise<void> {
  try {
    const run = requireActiveRun();
    await assertTargetUnchanged(run);
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
    await assertTargetUnchanged(run);
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

async function applyCurrentRun(context: vscode.ExtensionContext): Promise<void> {
  try {
    const run = requireActiveRun();
    const adaptation = run.adaptation;
    if (!adaptation) throw new Error('尚未生成当前迁移运行的补丁。');
    const gate = evaluateValidationGate(adaptation.validation);
    if (!canApplyAdaptation(adaptation)) {
      const labels = gate.blockers.map((record) => record.label).join('、');
      throw new Error(`必需验证未通过或尚未验证：${labels || '缺少可写回补丁'}。`);
    }
    await assertTargetUnchanged(run);
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
  } catch (error) {
    publishError(errorMessage(error, '回填失败'));
  }
}

async function restoreLastCheckpoint(context: vscode.ExtensionContext): Promise<void> {
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

async function copyTargetPath(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.env.clipboard.writeText(run.target.path);
    vscode.window.setStatusBarMessage('ForeXplore: 已复制目标路径', 2_000);
  } catch (error) {
    publishError(errorMessage(error, '无法复制当前目标路径'));
  }
}

async function revealTargetInExplorer(): Promise<void> {
  try {
    const run = requireActiveRun();
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', run.targetUri);
  } catch (error) {
    publishError(errorMessage(error, '无法在资源管理器中定位当前目标文件'));
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

async function assertTargetUnchanged(run: ActiveMigrationRun): Promise<void> {
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
