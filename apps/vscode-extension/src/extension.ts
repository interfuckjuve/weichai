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
import { requestSemanticModuleMigrationProposal } from './module-plan-client';
import { HttpModuleHierarchyPlanner } from './module-hierarchy-client';
import {
  applyHunksStrict,
  canApplyAdaptation,
  evaluateValidationGate,
} from '@forexplore/workflow-core';
import { WorkspaceBackfill } from './backfill';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
} from './code-intelligence-host';
import { canonicalWorkspacePath } from './diff-apply';
import {
  ModuleMigrationHost,
  ModuleMigrationPreviewProvider,
  moduleMigrationPreviewScheme,
} from './module-migration-host';
import type { ModuleWaveExecutionPort } from './module-wave-execution-host';
import type { ModuleMigrationWaveRecoveryPort } from './module-migration-recovery';
import { TranslationPanel } from './panel';
import { buildProjectExplorer, readExplorerChildren, type ExplorerChildrenIndex } from './project-explorer';
import type {
  HostToWebviewMessage,
  WebviewToHostMessage,
} from './protocol/messages';
import { RepositoryHealthCheck } from './repository-health';
import { decorateRepositoryStatuses } from './repository-status';
import { ServiceManager } from './service-manager';
import { loadSettings, savePanelSettings } from './settings';
import { addTargetWorkspace, selectedTargetWorkspaceFolders } from './target-workspace';
import type { CodeIntelligencePresentation, RepositoryStatus } from './ui-types';

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
  codeIntelligence: CodeIntelligenceHost;
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
let moduleExplorerChildren: ExplorerChildrenIndex = new Map();
let activeCodeIntelligenceHost: CodeIntelligenceHost | null = null;
let activeTaskSearch: { requestId: string; controller: AbortController } | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('ForeXplore');
  const services = new ServiceManager(output);
  const health = new RepositoryHealthCheck();
  let codeIntelligence: CodeIntelligenceHost;
  try {
    const runtimeOptions = codeIntelligenceRuntimeOptionsFromEnvironment(process.env, {
      // A packaged extension must use durable SeekDB. The only memory path is
      // an explicitly non-production VS Code development/test host.
      allowInMemory: context.extensionMode !== vscode.ExtensionMode.Production,
    });
    codeIntelligence = new CodeIntelligenceHost({
      runtimeOptions,
      planProject: async (scope) => {
        await codeIntelligence.startSemanticQueryServer({
          port: positiveEnvironmentPort(process.env.FOREXPLORE_SEMANTIC_QUERY_PORT, 8790),
          bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
        });
        return requestSemanticModuleMigrationProposal(loadSettings().adaptationApiUrl, scope, undefined, AbortSignal.timeout(300_000));
      },
      hierarchyPlanner: process.env.FOREXPLORE_MODULE_HIERARCHY_URL
        ? new HttpModuleHierarchyPlanner(process.env.FOREXPLORE_MODULE_HIERARCHY_URL) : undefined,
      onChange: () => { void publishProjectView(codeIntelligence).catch((error) => output.appendLine(String(error))); },
      identityStore: context.globalState,
      output,
    });
  } catch (error) {
    const startupError = error instanceof Error ? error : new Error(String(error));
    output.appendLine(`[forexplore] invalid code intelligence configuration: ${startupError.message}`);
    codeIntelligence = new CodeIntelligenceHost({
      runtimeFactory: async () => Promise.reject(startupError),
      identityStore: context.globalState,
      output,
      storageKind: 'seekdb',
    });
  }
  activeCodeIntelligenceHost = codeIntelligence;
  const moduleMigrationPreviews = new ModuleMigrationPreviewProvider();
  const moduleMigration = new ModuleMigrationHost({
    context,
    services,
    output,
    previews: moduleMigrationPreviews,
    waveRecovery: new GitWaveTransaction(),
    waveExecution: new ModuleWaveExecutionCoordinator(),
    onCompilerProbeAnalysisReady: async ({ workspaceFolder, analysis }) => {
      // The compatibility analyzer remains the producer of this snapshot.
      // Only the trusted host can bind its compiler-confirmed subset to the
      // already-active structural revision; Agent/MCP/Webview code receives
      // the resulting semantic evidence through SemanticQueryPort only.
      const binding = await codeIntelligence.bindJavaCsharpCompilerProbeEvidence({
        localPath: workspaceFolder.uri.fsPath,
        analysis,
      });
      output.appendLine(
        binding.status === 'bound'
          ? `[forexplore] Java/C# compiler-probe evidence bound to ${binding.repositoryId}/${binding.analysisRevision}.`
          : '[forexplore] Java/C# compiler-probe evidence was not bound to the active structural revision.',
      );
      publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await codeIntelligence.presentation() });
    },
    semanticPlan: async ({ workspaceFolder, objective, immutableConstraints }) => {
      const scope = await codeIntelligence.activeScopeForPath(workspaceFolder.uri.fsPath);
      const projectId = await codeIntelligence.selectedProjectForPath(workspaceFolder.uri.fsPath);
      await codeIntelligence.startSemanticQueryServer({
        port: positiveEnvironmentPort(process.env.FOREXPLORE_SEMANTIC_QUERY_PORT, 8790),
        bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
      });
      const settings = loadSettings();
      return requestSemanticModuleMigrationProposal(settings.adaptationApiUrl, {
        ...scope,
        ...(projectId ? { projectId } : {}),
        objective,
        ...(immutableConstraints.length ? { immutableConstraints } : {}),
      });
    },
    onSemanticPlanApproved: async ({ workspaceFolder, result }) => {
      const scope = await codeIntelligence.activeScopeForPath(workspaceFolder.uri.fsPath);
      await codeIntelligence.publishModuleSummary({
        ...scope,
        analysisHash: result.evidence.analysisHash,
        planHash: result.evidence.planHash,
        payload: result.proposal,
      });
      publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await codeIntelligence.presentation() });
    },
  });

  context.subscriptions.push(
    output,
    services,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshModuleExplorer(codeIntelligence, { scanNewOnly: true }).catch((error) => output.appendLine(String(error)));
    }),
    vscode.window.registerTreeDataProvider<vscode.TreeItem>('forexplore.launcher', {
      getTreeItem: (item) => item,
      getChildren: () => [],
    }),
    { dispose: () => codeIntelligence.dispose() },
    vscode.workspace.registerTextDocumentContentProvider(
      moduleMigrationPreviewScheme,
      moduleMigrationPreviews,
    ),
    vscode.commands.registerCommand('forexplore.showPanel', () =>
      showPanel(context, services, health, codeIntelligence),
    ),
    vscode.commands.registerCommand('forexplore.checkRepositories', async () => {
      const index = await synchronizeCodeIntelligence(codeIntelligence, { scan: false });
      const statuses = await refreshRepositoryStatus(services, health);
      const summary = summarizeRepositoryStatus(statuses);
      void vscode.window.showInformationMessage(
        [summary, summarizeCodeIntelligence(index)].filter(Boolean).join('；') || '未配置本地仓库路径。',
      );
    }),
    vscode.commands.registerCommand('forexplore.reindex', async () => {
      await services.refresh();
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在刷新版本化代码智能索引',
        },
        () => synchronizeCodeIntelligence(codeIntelligence, { forceFull: true }),
      );
      const repositories = await refreshRepositoryStatus(services, health);
      void vscode.window.showInformationMessage(
        summarizeCodeIntelligence(result) ?? '代码智能索引未发现可注册仓库。',
      );
      void repositories;
    }),
    vscode.commands.registerCommand('forexplore.refreshCodeIntelligence', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在增量刷新代码智能索引',
        },
        () => synchronizeCodeIntelligence(codeIntelligence),
      );
      void vscode.window.showInformationMessage(
        summarizeCodeIntelligence(result) ?? '代码智能索引未发现可注册仓库。',
      );
    }),
    vscode.commands.registerCommand('forexplore.restoreLastCheckpoint', () =>
      restoreLastCheckpoint(context),
    ),
    vscode.commands.registerCommand('forexplore.indexModuleMigrationRepository', async () => {
      // Keep the compatibility RepositoryStaticAnalysis artifact, but ensure
      // the target first traverses the shared structural-index chain.
      await synchronizeCodeIntelligence(codeIntelligence);
      await moduleMigration.indexRepository();
    }),
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

  // The trusted host starts the shared local indexing chain; services used for
  // translation remain independently health-checked and are never replaced.
  void Promise.all([
    services.refresh(),
    synchronizeCodeIntelligence(codeIntelligence),
    codeIntelligence.startSemanticQueryServer({
      port: positiveEnvironmentPort(process.env.FOREXPLORE_SEMANTIC_QUERY_PORT, 8790),
      bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
    }),
  ])
    .then(() => refreshRepositoryStatus(services, health))
    .catch((error) => {
      output.appendLine(`[forexplore] preflight failed: ${String(error)}`);
    });
}

export function deactivate(): void {
  activeTaskSearch?.controller.abort();
  activeTaskSearch = null;
  activeRun = null;
  moduleExplorerTargets = new Map();
  moduleExplorerChildren = new Map();
  activeCodeIntelligenceHost?.dispose();
  activeCodeIntelligenceHost = null;
}

async function showPanel(
  context: vscode.ExtensionContext,
  services: ServiceManager,
  health: RepositoryHealthCheck,
  codeIntelligence: CodeIntelligenceHost,
): Promise<void> {
  if (TranslationPanel.current) {
    TranslationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  const settings = loadSettings();
  const panel = await TranslationPanel.createOrShow(context, {
    target: null, workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    settings, repositoryStatuses: [],
    codeIntelligence: { status: 'initializing', storage: 'seekdb', repositories: [] },
    serviceStatus: services.serviceStatus,
    moduleExplorer: {
      generatedAt: new Date().toISOString(), history: [],
      target: {
        id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '', tree: [],
        stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
        summary: { exists: false, path: '.forexplore/module-summary.json' },
      },
    }, searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek',
  }, { onMessage: (message) => { void handlePanelMessage({ context, services, health, codeIntelligence }, message); } });
  void (async () => {
    try {
      // Published indexing results are readable while another repository scans.
      // Opening a panel must not enqueue a status read behind that scan.
      await publishProjectView(codeIntelligence);
      const [status, statuses] = await Promise.all([
        services.refresh(),
        refreshRepositoryStatus(services, health),
      ]);
      if (TranslationPanel.current !== panel) return;
      panel.post({ type: 'SERVICE_STATUS', status });
      panel.post({ type: 'REPOSITORY_STATUS', statuses });
    } catch (error) {
      if (TranslationPanel.current === panel) panel.post({ type: 'ERROR', message: errorMessage(error, '面板数据加载失败') });
    }
  })();
}

async function handlePanelMessage(
  host: ExtensionHost,
  message: WebviewToHostMessage,
): Promise<void> {
  switch (message.type) {
    case 'LOAD_MODULE_CHILDREN':
      try {
        TranslationPanel.current?.post({ type: 'MODULE_CHILDREN', requestId: message.requestId,
          page: readExplorerChildren(moduleExplorerChildren, message.request) });
      } catch (error) {
        TranslationPanel.current?.post({ type: 'MODULE_CHILDREN_ERROR', requestId: message.requestId,
          message: errorMessage(error, '模块节点读取失败') });
      }
      return;
    case 'ADD_TARGET_WORKSPACE':
      try {
        if (await addTargetWorkspace(message.mode)) await refreshModuleExplorer(host.codeIntelligence, { scanNewOnly: true });
      } catch (error) {
        publishError(errorMessage(error, '添加目标工程失败'));
      }
      return;
    case 'READY':
      return;
    case 'START_SEARCH':
      await startSearch(host, message);
      return;
    case 'START_TASK_SEARCH':
      await startTaskSearch(host, message);
      return;
    case 'CANCEL_TASK_SEARCH':
      if (activeTaskSearch?.requestId === message.requestId) activeTaskSearch.controller.abort();
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
      await refreshModuleExplorer(host.codeIntelligence);
      return;
    case 'REFRESH_REPOSITORY':
      await synchronizeCodeIntelligence(host.codeIntelligence, { scanRepositoryIds: [message.repositoryId] });
      await publishProjectView(host.codeIntelligence);
      return;
    case 'SAVE_SETTINGS':
      await updatePanelSettings(host, message.settings);
      return;
    case 'SELECT_CODE_INTELLIGENCE_REVISION':
      await selectCodeIntelligenceRevision(host.codeIntelligence, message);
      return;
    case 'RETRY_PROJECT_ANALYSIS':
      await host.codeIntelligence.retryProject(message, message.force);
      return;
    case 'SELECT_CODE_INTELLIGENCE_PROJECT':
      await selectCodeIntelligenceProject(host.codeIntelligence, message);
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

async function startTaskSearch(host: ExtensionHost, message: Extract<WebviewToHostMessage, { type: 'START_TASK_SEARCH' }>): Promise<void> {
  activeTaskSearch?.controller.abort();
  const run = { requestId: message.requestId, controller: new AbortController() };
  activeTaskSearch = run;
  const panel = TranslationPanel.current;
  const disposed = panel?.panel.onDidDispose(() => run.controller.abort());
  const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(35_000)]);
  try {
    const packet = await host.codeIntelligence.searchTaskContext(message.requestId, message.targetScope, message.request, signal);
    signal.throwIfAborted();
    if (activeTaskSearch === run && TranslationPanel.current === panel) {
      panel?.post({ type: 'TASK_SEARCH_RESULT', requestId: message.requestId, packet });
    }
  } catch (error) {
    if (!run.controller.signal.aborted && activeTaskSearch === run && TranslationPanel.current === panel) {
      panel?.post({ type: 'TASK_SEARCH_ERROR', requestId: message.requestId, message: errorMessage(error, '任务检索失败') });
    }
  } finally {
    disposed?.dispose();
    if (activeTaskSearch === run) activeTaskSearch = null;
  }
}

/**
 * A Webview can choose only an existing opaque repository/revision pair for
 * read-only display. CodeIntelligenceHost validates both IDs and never alters
 * the repository's active revision for this operation.
 */
async function selectCodeIntelligenceRevision(
  codeIntelligence: CodeIntelligenceHost,
  selection: Extract<WebviewToHostMessage, { type: 'SELECT_CODE_INTELLIGENCE_REVISION' }>,
): Promise<void> {
  try {
    const presentation = await codeIntelligence.selectRevisionForDisplay({
      repositoryId: selection.repositoryId,
      analysisRevision: selection.analysisRevision,
    });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
    await publishProjectView(codeIntelligence);
  } catch (error) {
    publishError(errorMessage(error, '切换代码智能 revision 失败'));
  }
}

async function selectCodeIntelligenceProject(
  codeIntelligence: CodeIntelligenceHost,
  selection: Extract<WebviewToHostMessage, { type: 'SELECT_CODE_INTELLIGENCE_PROJECT' }>,
): Promise<void> {
  try {
    const presentation = await codeIntelligence.selectProjectForDisplay(selection);
    if (presentation.repositories.some((r) => r.repositoryId === selection.repositoryId && r.role === 'target')) {
      activeRun = null;
      publish({ type: 'TARGET_CLEARED' });
    }
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
    await publishProjectView(codeIntelligence);
  } catch (error) {
    publishError(errorMessage(error, '切换目标工程失败'));
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
    const codeIntelligence = await synchronizeCodeIntelligence(host.codeIntelligence, { scanNewOnly: true, scanRoles: ['history'] });
    const [statuses, explorer] = await Promise.all([
      refreshRepositoryStatus(host.services, host.health),
      buildProjectExplorer(host.codeIntelligence, activeRun?.target),
    ]);
    moduleExplorerTargets = explorer.targets;
    moduleExplorerChildren = explorer.childrenByNodeId;
    publish({ type: 'REPOSITORY_STATUS', statuses });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: codeIntelligence });
    publish({ type: 'MODULE_EXPLORER', explorer: explorer.presentation });
  } catch (error) {
    publishError(errorMessage(error, '设置已保存，但刷新仓库状态失败'));
  }
}

async function refreshModuleExplorer(
  codeIntelligence: CodeIntelligenceHost,
  options: { scanNewOnly?: boolean } = {},
): Promise<void> {
  try {
    const presentation = await synchronizeCodeIntelligence(codeIntelligence, options);
    const result = await buildProjectExplorer(codeIntelligence, activeRun?.target);
    moduleExplorerTargets = result.targets;
    moduleExplorerChildren = result.childrenByNodeId;
    publish({ type: 'MODULE_EXPLORER', explorer: result.presentation });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation });
  } catch (error) {
    publishError(errorMessage(error, '刷新模块视图失败'));
  }
}

async function selectWorkspaceTarget(targetId: string): Promise<void> {
  try {
    const target = moduleExplorerTargets.get(targetId);
    if (!target) throw new Error('该目标不属于当前 Host 静态分析快照。');
    if (!activeCodeIntelligenceHost) throw new Error('索引尚未初始化。');
    const selected = (await activeCodeIntelligenceHost.explorerData()).find((item) => item.selectedTarget);
    const workspaceFolder = vscode.workspace.workspaceFolders?.find((folder) =>
      path.resolve(folder.uri.fsPath).toLowerCase() === path.resolve(selected?.repository.localPath ?? '').toLowerCase());
    if (!workspaceFolder) throw new Error('所选工程不属于已打开的 VS Code 工作区。');
    const canonicalPath = canonicalWorkspacePath(workspaceFolder.uri.fsPath, target.path);
    const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...canonicalPath.split('/'));
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === targetUri.toString(),
    );
    if (openDocument?.isDirty) {
      throw new Error('新目标文件有未保存的编辑；请先保存后再切换目标。');
    }
    const originalBytes = await vscode.workspace.fs.readFile(targetUri);
    activeRun = {
      workspaceFolder,
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
    await host.codeIntelligence.waitForProjects();
    const candidates = await host.codeIntelligence.searchHistoricalImplementations({
      target: run.target,
      requirement: message.requirement.trim(),
      topK: message.topK,
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
    if (run.target.kind === 'module' || candidate.kind === 'module') {
      throw new Error('当前模块检索尚未接通多文件适配。');
    }
    await assertTargetUnchanged(run);
    const status = await host.services.refresh();
    publish({ type: 'SERVICE_STATUS', status });
    const rawResult = await host.services.getAdaptationPort().adapt({
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
    const [statuses, codeIntelligence] = await Promise.all([
      refreshRepositoryStatus(host.services, host.health),
      synchronizeCodeIntelligence(host.codeIntelligence, { scan: false }),
    ]);
    publish({ type: 'REPOSITORY_STATUS', statuses });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: codeIntelligence });
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

/**
 * Only the extension host translates configured local roots into registry
 * inputs.  The returned presentation is safe to pass to the Webview because
 * it contains IDs/revisions only, never these local paths.
 */
function codeIntelligenceRepositoryInputs(): Array<{
  localPath: string;
  displayName?: string;
  role: 'history' | 'target';
}> {
  const settings = loadSettings();
  const history = settings.repositoryPaths.map((localPath) => ({
    localPath,
    role: 'history' as const,
  }));
  const targets = selectedTargetWorkspaceFolders()
    .map((folder) => ({
      localPath: folder.uri.fsPath,
      displayName: folder.name,
      role: 'target' as const,
    }));
  return [...history, ...targets];
}

async function synchronizeCodeIntelligence(
  host: CodeIntelligenceHost,
  options: { forceFull?: boolean; scan?: boolean; scanRepositoryIds?: readonly string[]; scanNewOnly?: boolean; scanRoles?: readonly ('history' | 'target')[] } = {},
): Promise<CodeIntelligencePresentation> {
  const result = await host.synchronize({
    repositories: codeIntelligenceRepositoryInputs(),
    ...options,
  });
  return result.presentation;
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
  return `本地参考工程：${statuses.length} 个，${unavailable} 个不可用。`;
}

function summarizeCodeIntelligence(presentation: CodeIntelligencePresentation): string | null {
  if (presentation.status === 'initializing') return '代码智能索引正在初始化。';
  if (presentation.status === 'error') return presentation.message ?? '代码智能索引刷新失败。';
  if (presentation.repositories.length === 0) return null;
  const ready = presentation.repositories.filter((repository) => (
    repository.analysisStatus === 'ready' || repository.analysisStatus === 'degraded'
  )).length;
  const staleSummaries = presentation.repositories.filter(
    (repository) => repository.summary.status === 'stale',
  ).length;
  return `${presentation.storage === 'seekdb' ? 'SeekDB' : '内存'}代码智能索引：${ready}/${presentation.repositories.length} 个仓库就绪`
    + (staleSummaries ? `，${staleSummaries} 个 Summary 已过期。` : '。');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}

function positiveEnvironmentPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

let projectViewQueue: Promise<void> = Promise.resolve();
function publishProjectView(host: CodeIntelligenceHost): Promise<void> {
  projectViewQueue = projectViewQueue.catch(() => {}).then(async () => {
    if (!TranslationPanel.current) return;
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
    const explorer = await buildProjectExplorer(host, activeRun?.target);
    moduleExplorerTargets = explorer.targets;
    moduleExplorerChildren = explorer.childrenByNodeId;
    publish({ type: 'MODULE_EXPLORER', explorer: explorer.presentation });
    publish({ type: 'CODE_INTELLIGENCE_STATUS', presentation: await host.presentation() });
  });
  return projectViewQueue;
}
