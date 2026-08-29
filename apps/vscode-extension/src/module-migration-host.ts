import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  type ExecutionWave,
  type MigrationRunManifest,
  type ModuleMigrationPlan,
  type ModuleSummary,
  type PlanDecision,
  type RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  arePlanApprovalsCurrent,
  areWaveApprovalsCurrent,
  calculateModuleMigrationPlanHash,
  invalidatePlanForSnapshot,
  materializeModuleSummary,
  recordModulePlanDecision,
  validateModuleMigrationPlan,
} from '@forexplore/workflow-core';
import type { PreparedModuleWave } from '@forexplore/adaptation-service/module-wave-execution';
import {
  analyzeRepository,
  readRepositoryAnalysisArtifact,
  writeRepositoryAnalysisArtifact,
} from '@forexplore/code-indexer';
import {
  buildTrustedModuleMigrationPlan,
  requestModuleMigrationProposal,
} from './module-plan-client';
import { nextWaveForReadOnlyReview } from './module-wave-review';
import {
  approvePreparedLocalModuleWave,
  commitPreparedLocalModuleWave,
  prepareLocalModuleWave,
  restoreCommittedLocalModuleWave,
  rollbackPreparedLocalModuleWave,
  type ModuleWaveExecutionPort,
  type StoredPreparedModuleWave,
} from './module-wave-execution-host';
import {
  parseModuleWavePatchBundle,
  type ModuleWavePatchBundle,
} from './module-wave-patch-bundle';
import {
  recoverIncompleteModuleTransactions,
  type ModuleMigrationWaveRecoveryPort,
  type ModuleMigrationWaveRecoveryResult,
} from './module-migration-recovery';
import {
  loadModuleWaveValidationCommands,
  loadSettings,
} from './settings';
import {
  GitModuleWaveRunManifestReader,
  type ModuleWaveRunManifestReader,
} from './module-wave-run-manifest';
import { CommandModuleWaveValidator, type ModuleWaveValidator } from './module-wave-validation';
import type { ServiceManager } from './service-manager';

export const moduleMigrationPreviewScheme = 'forexplore-module-migration';
const reviewStorageVersion = 3;
const reviewStoragePrefix = 'forexplore.moduleMigration.review';

export type ModuleMigrationHostStage =
  | 'idle'
  | 'indexing'
  | 'indexed'
  | 'planning'
  | 'plan-review'
  | 'approved'
  | 'wave-review'
  | 'preparing'
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'recovered'
  | 'invalidated';

export interface ModuleMigrationHostState {
  stage: ModuleMigrationHostStage;
  workspaceUri?: string;
  snapshotId?: string;
  planId?: string;
  waveId?: string;
}

interface ModuleMigrationReviewSession {
  workspaceFolder: vscode.WorkspaceFolder;
  analysis: RepositoryStaticAnalysis;
  artifactPath: string;
  plan?: ModuleMigrationPlan;
  manifest?: MigrationRunManifest;
  /** Never persisted: a restart must force fresh validation and approval. */
  prepared?: PreparedModuleWave;
  storedPrepared?: StoredPreparedModuleWave;
  recoveryEvents: ModuleMigrationRecoveryEvent[];
}

interface StoredModuleMigrationReview {
  version: number;
  workspaceUri: string;
  snapshotId: string;
  plan?: ModuleMigrationPlan;
  manifest?: MigrationRunManifest;
  prepared?: StoredPreparedModuleWave;
  recoveryEvents?: ModuleMigrationRecoveryEvent[];
}

interface ModuleMigrationRecoveryEvent {
  transactionId: string;
  waveId: string;
  state: 'rolled-back' | 'committed';
  recoveredAt: string;
  commit?: string;
}

/**
 * Provides plan and evidence documents through a private read-only URI
 * scheme. Webviews never receive module-plan control messages or write paths.
 */
export class ModuleMigrationPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contentByUri = new Map<string, string>();

  async show(title: string, value: unknown): Promise<void> {
    const uri = vscode.Uri.from({
      scheme: moduleMigrationPreviewScheme,
      path: `/${randomUUID()}.json`,
      query: `title=${encodeURIComponent(title)}`,
    });
    this.contentByUri.set(uri.toString(), `${JSON.stringify(value, null, 2)}\n`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentByUri.get(uri.toString()) ?? '{"error":"Preview is no longer available."}\n';
  }
}

export interface ModuleMigrationHostOptions {
  context: vscode.ExtensionContext;
  services: ServiceManager;
  output: vscode.OutputChannel;
  previews: ModuleMigrationPreviewProvider;
  /** Optional for hosts that only provide planning/review functionality. */
  waveRecovery?: ModuleMigrationWaveRecoveryPort;
  /** Optional for hosts that only provide planning/review functionality. */
  waveExecution?: ModuleWaveExecutionPort;
  /** Uses explicit trusted local commands when no test host overrides it. */
  waveValidator?: ModuleWaveValidator;
  /** Test/automation seam; the default opens a local JSON file picker. */
  pickWaveBundle?: (workspaceFolder: vscode.WorkspaceFolder) => Promise<ModuleWavePatchBundle | undefined>;
  /** Reads only a managed run artifact after Git proves publication. */
  runManifestReader?: ModuleWaveRunManifestReader;
}

/**
 * Trusted VS Code host flow for static module planning. It owns immutable
 * analysis artifacts, deterministic validation, and local plan review state;
 * the architecture HTTP endpoint can only return an untrusted proposal.
 * Source changes, run manifests, and module summaries belong to the wave
 * transaction coordinator and are never written by this planning host.
 */
export class ModuleMigrationHost {
  private readonly sessions = new Map<string, ModuleMigrationReviewSession>();
  private currentState: ModuleMigrationHostState = { stage: 'idle' };

  constructor(private readonly options: ModuleMigrationHostOptions) {}

  get state(): ModuleMigrationHostState {
    return { ...this.currentState };
  }

  async indexRepository(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      this.setState({ stage: 'indexing', workspaceFolder });
      const analysis: RepositoryStaticAnalysis = await vscode.window.withProgress<RepositoryStaticAnalysis>(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在收集模块迁移静态证据',
        },
        () => analyzeRepository({
          root: workspaceFolder.uri.fsPath,
          semanticEnrichment: true,
          allowDirtyWorktreeForPlanning: true,
        }),
      );
      const artifactPath = await writeRepositoryAnalysisArtifact(workspaceFolder.uri.fsPath, analysis);
      const session: ModuleMigrationReviewSession = {
        workspaceFolder,
        analysis,
        artifactPath,
        recoveryEvents: [],
      };
      this.sessions.set(workspaceFolder.uri.toString(), session);
      await this.persistSession(session);
      this.setState({ stage: 'indexed', session });
      await this.options.previews.show('Static analysis snapshot', staticAnalysisPreview(session));
      void vscode.window.showInformationMessage(
        `已创建静态分析快照 ${analysis.snapshotId}；模块规划服务只会接收该快照标识。`,
      );
    } catch (error) {
      this.reportError(error, '模块静态分析失败');
    }
  }

  async reviewPlan(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      await this.assertSnapshotCurrent(session);
      if (session.manifest?.transactions.length) {
        throw new Error('当前模块计划已有迁移运行记录；不能在运行期间替换计划。请先完成或恢复该运行。');
      }

      const objective = await vscode.window.showInputBox({
        title: 'ForeXplore: 模块迁移目标',
        prompt: '描述本次模块级迁移要完成的目标。',
        validateInput: (value) => value.trim() ? undefined : '迁移目标不能为空。',
      });
      if (objective === undefined) return;
      const constraintsText = await vscode.window.showInputBox({
        title: 'ForeXplore: 不可变约束（可选）',
        prompt: '用分号分隔。例如：保持公开接口；不得修改构建配置。',
      });
      if (constraintsText === undefined) return;
      const immutableConstraints = splitConstraints(constraintsText);

      this.setState({ stage: 'planning', session });
      const status = await this.options.services.refresh();
      if (status.adaptation !== 'connected') {
        throw new Error(status.message ?? '模块规划服务尚未就绪。');
      }
      const settings = loadSettings();
      const proposal = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: Agenticodex 正在提出模块边界',
        },
        () => requestModuleMigrationProposal(settings.adaptationApiUrl, {
          snapshotId: session.analysis.snapshotId,
          objective: objective.trim(),
          ...(immutableConstraints.length === 0 ? {} : { immutableConstraints }),
        }),
      );
      const plan = buildTrustedModuleMigrationPlan(session.analysis, proposal);
      const validation = validateModuleMigrationPlan(plan, session.analysis);
      if (!validation.valid) {
        throw new Error('模块提案未通过宿主确定性校验。');
      }

      session.plan = plan;
      session.manifest = undefined;
      session.prepared = undefined;
      session.storedPrepared = undefined;
      session.recoveryEvents = [];
      await this.persistSession(session);
      this.setState({ stage: 'plan-review', session });
      await this.options.previews.show('Module migration plan review', planPreview(
        session,
        materializeModuleSummary(plan),
        validation.issues,
      ));

      const approved = await vscode.window.showWarningMessage(
        '模块计划已在只读审阅文档中打开。审批会绑定当前静态快照和计划哈希，并仅记录在扩展的可信审阅状态中；受管摘要只能随波次事务提交。',
        { modal: true },
        '批准计划',
      );
      if (approved !== '批准计划') return;
      await this.approvePlan(session);
    } catch (error) {
      this.reportError(error, '模块计划审阅失败');
    }
  }

  async reviewNextWave(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      await this.assertSnapshotCurrent(session);
      const plan = requirePlan(session);
      if (!arePlanApprovalsCurrent(plan, session.analysis.snapshotId)) {
        throw new Error('必须先审批当前快照绑定的完整模块计划，才能审阅执行波次。');
      }

      const wave = nextWaveForReadOnlyReview(plan);
      if (!wave) {
        void vscode.window.showInformationMessage(
          '没有依赖已提交且可供预览的后续波次。可信执行协调器必须先完成前序波次的联合验证和原子提交。',
        );
        return;
      }
      this.setState({ stage: 'wave-review', session, waveId: wave.id });
      await this.options.previews.show('Execution wave schedule preview', wavePreview(session, wave));
      void vscode.window.showInformationMessage(
        session.prepared?.transaction.waveId === wave.id
          ? `波次 ${wave.id} 的已准备补丁、验证证据和 preparedHash 已在只读文档中打开。请在审阅后运行“审批并提交已准备迁移波次”。`
          : `波次 ${wave.id} 已在只读审阅文档中打开。导入本地补丁包后，宿主会在隔离 worktree 中重新执行联合验证并生成 preparedHash。`,
      );
    } catch (error) {
      this.reportError(error, '执行波次审阅失败');
    }
  }

  /**
   * Import a patch-only JSON artifact from the local filesystem. The bundle is
   * previewed before it reaches the coordinator; it never arrives from a
   * webview and cannot claim validation evidence.
   */
  async prepareNextWaveFromLocalBundle(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      await this.assertSnapshotCurrent(session);
      await this.recoverStoredPreparedWave(session);
      const plan = requirePlan(session);
      if (session.prepared || session.storedPrepared) {
        throw new Error('已有已准备的波次补丁；请先审阅并提交，或运行恢复命令放弃该补丁。');
      }
      if (!arePlanApprovalsCurrent(plan, session.analysis.snapshotId)) {
        throw new Error('必须先审批当前静态快照绑定的完整模块计划。');
      }
      const bundle = await this.pickWaveBundle(workspaceFolder);
      if (!bundle) return;
      const wave = nextWaveForReadOnlyReview(plan);
      if (!wave) {
        throw new Error('没有依赖已提交且可准备的后续波次。');
      }
      await this.options.previews.show('Local module wave patch bundle review', localBundlePreview(session, bundle, wave));
      const confirmed = await vscode.window.showWarningMessage(
        `本地补丁包将为波次 ${wave.id} 在隔离 Git worktree 中应用并执行受信任的联合验证。补丁包内的验证声明会被丢弃。确认在审阅后准备该波次？`,
        { modal: true },
        '准备波次',
      );
      if (confirmed !== '准备波次') return;

      this.setState({ stage: 'preparing', session, waveId: wave.id });
      const prepared = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ForeXplore: 正在准备模块迁移波次 ${wave.id}`,
        },
        () => prepareLocalModuleWave({
          repositoryRoot: workspaceFolder.uri.fsPath,
          analysis: session.analysis,
          plan,
          ...(session.manifest === undefined ? {} : { manifest: session.manifest }),
          bundle,
          validator: this.waveValidator(),
          coordinator: this.waveExecution(),
        }),
      );
      session.plan = prepared.prepared.plan;
      session.manifest = prepared.prepared.manifest;
      session.prepared = prepared.prepared;
      session.storedPrepared = prepared.storedPrepared;
      await this.persistSession(session);
      this.setState({ stage: 'prepared', session, waveId: wave.id });
      await this.options.previews.show('Prepared module migration wave review', preparedWavePreview(session, prepared.prepared));
      void vscode.window.showInformationMessage(
        `波次 ${wave.id} 已在隔离 worktree 中准备完成。请审阅 preparedHash、补丁和联合验证证据后，再运行“审批并提交已准备迁移波次”。`,
      );
    } catch (error) {
      this.reportError(error, '准备模块迁移波次失败');
    }
  }

  /** Approve exactly one prepared bundle, then publish its atomic Git transaction. */
  async approveAndCommitPreparedWave(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      await this.assertSnapshotCurrent(session);
      const plan = requirePlan(session);
      const prepared = session.prepared;
      if (!prepared || !session.manifest) {
        if (session.storedPrepared) {
          throw new Error('扩展重启后已准备补丁必须重新生成、重新验证并重新审批。请先运行恢复命令。');
        }
        throw new Error('没有可审批并提交的已准备波次。');
      }
      if (prepared.transaction.waveId !== session.storedPrepared?.waveId) {
        throw new Error('内存补丁与持久化波次状态不一致；请运行恢复命令。');
      }
      await this.options.previews.show('Prepared module migration wave review', preparedWavePreview(session, prepared));
      const confirmed = await vscode.window.showWarningMessage(
        `将审批并提交波次 ${prepared.transaction.waveId} 的精确 preparedHash ${prepared.transaction.preparedHash}。此操作会更新受管迁移分支，不会直接写入当前工作区。确认继续？`,
        { modal: true },
        '审批并提交波次',
      );
      if (confirmed !== '审批并提交波次') return;
      const actor = await requestReviewActor('波次补丁审批人');
      if (!actor) return;

      const approved = approvePreparedLocalModuleWave(plan, prepared, actor);
      session.plan = approved;
      session.manifest = {
        ...session.manifest,
        updatedAt: approved.updatedAt,
        decisions: approved.decisions.map((decision) => ({ ...decision })),
      };
      await this.persistSession(session);
      this.setState({ stage: 'committing', session, waveId: prepared.transaction.waveId });
      const committed = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ForeXplore: 正在原子提交模块迁移波次 ${prepared.transaction.waveId}`,
        },
        () => commitPreparedLocalModuleWave({
          repositoryRoot: workspaceFolder.uri.fsPath,
          analysis: session.analysis,
          plan: approved,
          manifest: session.manifest!,
          prepared,
          coordinator: this.waveExecution(),
        }),
      );
      session.plan = committed.plan;
      session.manifest = committed.manifest;
      session.prepared = undefined;
      session.storedPrepared = undefined;
      await this.persistSession(session);
      this.setState({ stage: 'committed', session, waveId: committed.transaction.waveId });
      await this.options.previews.show('Committed module migration wave', committedWavePreview(session, committed));
      void vscode.window.showInformationMessage(
        `波次 ${committed.transaction.waveId} 已原子提交到 ${committed.branchName}（${committed.commit}）。`,
      );
    } catch (error) {
      this.reportError(error, '审批并提交模块迁移波次失败');
    }
  }

  /** Restore trusted local review state after an extension restart; it never writes source files. */
  async recoverReviewState(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const recoveredTransactions = this.recoverGitTransactions(workspaceFolder.uri.fsPath);
      const session = await this.loadSession(workspaceFolder);
      await this.recoverStoredPreparedWave(session, recoveredTransactions);
      await this.assertSnapshotCurrent(session);
      this.setState({ stage: 'recovered', session });
      await this.options.previews.show(
        'Recovered module migration review',
        recoveryPreview(session, recoveredTransactions),
      );
      void vscode.window.showInformationMessage(
        recoveryMessage(session, recoveredTransactions),
      );
    } catch (error) {
      this.reportError(error, '恢复模块迁移审阅状态失败');
    }
  }

  private waveExecution(): ModuleWaveExecutionPort {
    if (!this.options.waveExecution) {
      throw new Error('当前扩展宿主未配置可信模块波次执行协调器。');
    }
    return this.options.waveExecution;
  }

  private waveValidator(): ModuleWaveValidator {
    return this.options.waveValidator ?? new CommandModuleWaveValidator(loadModuleWaveValidationCommands());
  }

  private recoverGitTransactions(repositoryRoot: string): ModuleMigrationWaveRecoveryResult[] {
    if (!this.options.waveRecovery) return [];
    return recoverIncompleteModuleTransactions(repositoryRoot, this.options.waveRecovery);
  }

  /** Reconcile persisted review state after Git has recovered the disposable transaction. */
  private async recoverStoredPreparedWave(
    session: ModuleMigrationReviewSession,
    recoveredTransactions = this.recoverGitTransactions(session.workspaceFolder.uri.fsPath),
  ): Promise<void> {
    const storedPrepared = session.storedPrepared;
    if (!storedPrepared) return;
    const manifest = session.manifest;
    if (!manifest) {
      throw new Error('已准备波次缺少迁移运行清单；无法安全恢复。');
    }
    const transaction = manifest.transactions.find((item) => item.id === storedPrepared.transactionId);
    if (!transaction) {
      throw new Error('已准备波次不在迁移运行清单中；无法安全恢复。');
    }
    const recovery = this.options.waveRecovery;
    const published = recovery?.findPublishedTransactionCommit?.(
      session.workspaceFolder.uri.fsPath,
      {
        transactionId: transaction.id,
        branchName: transaction.branchName,
        baseCommit: transaction.baseCommit,
        ...(transaction.commit === undefined ? {} : { commit: transaction.commit }),
      },
    );
    const recoveredAt = new Date().toISOString();
    if (published) {
      const reader = this.options.runManifestReader ?? new GitModuleWaveRunManifestReader();
      const restored = restoreCommittedLocalModuleWave({
        plan: requirePlan(session),
        expectedManifest: manifest,
        recoveredManifest: reader.read(
          session.workspaceFolder.uri.fsPath,
          transaction.branchName,
          manifest.id,
          published,
        ),
        transactionId: transaction.id,
        commit: published,
        updatedAt: recoveredAt,
      });
      session.plan = restored.plan;
      session.manifest = restored.manifest;
      session.prepared = undefined;
      session.storedPrepared = undefined;
      session.recoveryEvents = appendRecoveryEvent(session.recoveryEvents, {
        transactionId: transaction.id,
        waveId: transaction.waveId,
        state: 'committed',
        recoveredAt,
        commit: published,
      });
      await this.persistSession(session);
      return;
    }
    const rolledBack = rollbackPreparedLocalModuleWave({
      plan: requirePlan(session),
      manifest,
      prepared: storedPrepared,
      updatedAt: recoveredAt,
    });
    session.plan = rolledBack.plan;
    session.manifest = rolledBack.manifest;
    session.prepared = undefined;
    session.storedPrepared = undefined;
    session.recoveryEvents = appendRecoveryEvent(session.recoveryEvents, {
      transactionId: transaction.id,
      waveId: transaction.waveId,
      state: 'rolled-back',
      recoveredAt,
    });
    await this.persistSession(session);
  }

  private async pickWaveBundle(
    workspaceFolder: vscode.WorkspaceFolder,
  ): Promise<ModuleWavePatchBundle | undefined> {
    if (this.options.pickWaveBundle) return this.options.pickWaveBundle(workspaceFolder);
    const selected = await vscode.window.showOpenDialog({
      title: '选择本地模块波次补丁包',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Module wave patch bundle': ['json'] },
      defaultUri: vscode.Uri.joinPath(workspaceFolder.uri, '.forexplore'),
    });
    const uri = selected?.[0];
    if (!uri) return undefined;
    if (uri.scheme !== 'file') {
      throw new Error('模块波次补丁包必须是本地 file JSON 文件。');
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > 10 * 1024 * 1_024) {
      throw new Error('模块波次补丁包超过 10 MiB 限制。');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new Error('模块波次补丁包不是有效 JSON。');
    }
    return parseModuleWavePatchBundle(payload);
  }

  private async approvePlan(session: ModuleMigrationReviewSession): Promise<void> {
    const actor = await requestReviewActor('计划审批人');
    if (!actor) return;
    await this.assertSnapshotCurrent(session);
    const plan = requirePlan(session);
    const now = new Date().toISOString();
    const decision = createPlanApprovalDecision(plan, actor, now);
    const approved = recordModulePlanDecision(plan, decision, session.analysis.snapshotId, now);
    session.plan = approved;
    await this.persistSession(session);
    this.setState({ stage: 'approved', session });
    void vscode.window.showInformationMessage(`模块计划 ${approved.id} 已批准。`);
  }

  private async loadSession(workspaceFolder: vscode.WorkspaceFolder): Promise<ModuleMigrationReviewSession> {
    const inMemory = this.sessions.get(workspaceFolder.uri.toString());
    if (inMemory) return inMemory;

    const stored = this.options.context.workspaceState.get<unknown>(storageKey(workspaceFolder));
    if (!isStoredReview(stored, workspaceFolder)) {
      throw new Error('没有可恢复的模块静态分析快照。请先运行“索引模块迁移仓库”。');
    }
    const analysis = await readRepositoryAnalysisArtifact(
      workspaceFolder.uri.fsPath,
      stored.snapshotId,
    );
    if (!analysis) {
      throw new Error('已记录的静态分析快照不存在或已被移除。请重新索引。');
    }
    const session: ModuleMigrationReviewSession = {
      workspaceFolder,
      analysis,
      artifactPath: path.join(workspaceFolder.uri.fsPath, '.forexplore', 'analysis', `${stored.snapshotId}.json`),
      recoveryEvents: stored.recoveryEvents === undefined ? [] : copyRecoveryEvents(stored.recoveryEvents),
    };
    if (stored.plan !== undefined) {
      const plan = stored.plan;
      if (plan.snapshotId !== analysis.snapshotId ||
        plan.planHash !== calculateModuleMigrationPlanHash(plan) ||
        !validateModuleMigrationPlan(plan, analysis).valid) {
        throw new Error('已保存的模块计划未通过当前快照校验；请重新生成计划。');
      }
      session.plan = plan;
    }
    if (stored.manifest !== undefined) {
      if (!isStoredManifest(stored.manifest)) {
        throw new Error('已保存的模块迁移运行清单结构无效；请恢复或重新开始该运行。');
      }
      session.manifest = stored.manifest;
    }
    if (stored.prepared !== undefined) {
      if (!isStoredPreparedWave(stored.prepared)) {
        throw new Error('已保存的已准备波次状态无效；请恢复模块迁移运行。');
      }
      session.storedPrepared = {
        ...stored.prepared,
        validationIds: [...stored.prepared.validationIds],
      };
    }
    if (session.manifest && session.plan && (
      session.manifest.snapshotId !== session.plan.snapshotId ||
      session.manifest.analysisHash !== session.plan.analysisHash ||
      session.manifest.planId !== session.plan.id ||
      session.manifest.planHash !== session.plan.planHash
    )) {
      throw new Error('已保存的迁移运行清单不属于当前模块计划；请恢复或重新索引。');
    }
    if (session.storedPrepared && !session.manifest) {
      throw new Error('已保存的已准备波次缺少迁移运行清单；请恢复模块迁移运行。');
    }
    this.sessions.set(workspaceFolder.uri.toString(), session);
    return session;
  }

  private async assertSnapshotCurrent(session: ModuleMigrationReviewSession): Promise<void> {
    const current = await analyzeRepository({
      root: session.workspaceFolder.uri.fsPath,
      semanticEnrichment: true,
      allowDirtyWorktreeForPlanning: true,
    });
    if (current.snapshotId === session.analysis.snapshotId) return;
    if (session.plan) {
      session.plan = invalidatePlanForSnapshot(session.plan, current.snapshotId);
      await this.persistSession(session);
    }
    this.setState({ stage: 'invalidated', session });
    throw new Error('工作区静态分析快照已变化；原有审批已失效。请先重新索引并重新审阅计划。');
  }

  private async persistSession(session: ModuleMigrationReviewSession): Promise<void> {
    const stored: StoredModuleMigrationReview = {
      version: reviewStorageVersion,
      workspaceUri: session.workspaceFolder.uri.toString(),
      snapshotId: session.analysis.snapshotId,
      ...(session.plan === undefined ? {} : { plan: session.plan }),
      ...(session.manifest === undefined ? {} : { manifest: session.manifest }),
      ...(session.storedPrepared === undefined
        ? {}
        : {
          prepared: {
            ...session.storedPrepared,
            validationIds: [...session.storedPrepared.validationIds],
          },
        }),
      ...(session.recoveryEvents.length === 0
        ? {}
        : { recoveryEvents: copyRecoveryEvents(session.recoveryEvents) }),
    };
    await this.options.context.workspaceState.update(storageKey(session.workspaceFolder), stored);
  }

  private setState(input: {
    stage: ModuleMigrationHostStage;
    session?: ModuleMigrationReviewSession;
    workspaceFolder?: vscode.WorkspaceFolder;
    waveId?: string;
  }): void {
    const session = input.session;
    const workspaceFolder = input.workspaceFolder ?? session?.workspaceFolder;
    this.currentState = {
      stage: input.stage,
      ...(workspaceFolder === undefined ? {} : { workspaceUri: workspaceFolder.uri.toString() }),
      ...(session === undefined ? {} : { snapshotId: session.analysis.snapshotId }),
      ...(session?.plan === undefined ? {} : { planId: session.plan.id }),
      ...(input.waveId === undefined ? {} : { waveId: input.waveId }),
    };
  }

  private reportError(error: unknown, prefix: string): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.options.output.appendLine(`[forexplore] ${prefix}: ${detail}`);
    void vscode.window.showErrorMessage(`${prefix}：${detail}`);
  }
}

function requirePlan(session: ModuleMigrationReviewSession): ModuleMigrationPlan {
  if (!session.plan) throw new Error('尚未生成模块计划。');
  return session.plan;
}

function createPlanApprovalDecision(
  plan: ModuleMigrationPlan,
  actor: string,
  decidedAt: string,
): PlanDecision {
  return {
    id: `plan-approval:${randomUUID()}`,
    kind: 'plan-approval',
    status: 'approved',
    snapshotId: plan.snapshotId,
    planHash: plan.planHash,
    actor,
    decidedAt,
  };
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const active = vscode.window.activeTextEditor;
  const activeFolder = active === undefined
    ? undefined
    : vscode.workspace.getWorkspaceFolder(active.document.uri);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const selected = activeFolder ?? (folders.length === 1 ? folders[0] : undefined);
  const workspaceFolder = selected ?? await pickWorkspaceFolder(folders);
  if (!workspaceFolder) return undefined;
  if (workspaceFolder.uri.scheme !== 'file') {
    throw new Error('模块静态分析 v1 仅支持本地 file 工作区。');
  }
  return workspaceFolder;
}

async function pickWorkspaceFolder(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<vscode.WorkspaceFolder | undefined> {
  if (folders.length === 0) {
    throw new Error('请先打开一个本地工作区文件夹。');
  }
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { title: '选择要进行模块静态分析的工作区' },
  );
  return selected?.folder;
}

async function requestReviewActor(title: string): Promise<string | undefined> {
  const defaultValue = process.env.USERNAME ?? process.env.USER ?? 'local-reviewer';
  const actor = await vscode.window.showInputBox({
    title,
    prompt: '记录本次人工审批身份。',
    value: defaultValue,
    validateInput: (value) => value.trim() ? undefined : '审批人不能为空。',
  });
  return actor?.trim() || undefined;
}

function splitConstraints(value: string): string[] {
  return [...new Set(value.split(';').map((item) => item.trim()).filter(Boolean))];
}

function storageKey(workspaceFolder: vscode.WorkspaceFolder): string {
  return `${reviewStoragePrefix}:${sha256(Buffer.from(workspaceFolder.uri.toString(), 'utf8'))}`;
}

function isStoredReview(
  value: unknown,
  workspaceFolder: vscode.WorkspaceFolder,
): value is StoredModuleMigrationReview {
  if (!isRecord(value)) return false;
  return (
    (value.version === 2 || value.version === reviewStorageVersion) &&
    value.workspaceUri === workspaceFolder.uri.toString() &&
    typeof value.snapshotId === 'string' &&
    value.snapshotId.length > 0 &&
    (value.plan === undefined || isRecord(value.plan)) &&
    (value.manifest === undefined || isRecord(value.manifest)) &&
    (value.prepared === undefined || isRecord(value.prepared)) &&
    (value.recoveryEvents === undefined || Array.isArray(value.recoveryEvents))
  );
}

function isStoredManifest(value: unknown): value is MigrationRunManifest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.snapshotId === 'string' &&
    typeof value.analysisHash === 'string' &&
    typeof value.planId === 'string' &&
    typeof value.planHash === 'string' &&
    Array.isArray(value.transactions) &&
    Array.isArray(value.validation) &&
    Array.isArray(value.decisions)
  );
}

function isStoredPreparedWave(value: unknown): value is StoredPreparedModuleWave {
  if (!isRecord(value)) return false;
  return (
    typeof value.transactionId === 'string' &&
    typeof value.waveId === 'string' &&
    typeof value.preparedHash === 'string' &&
    Array.isArray(value.validationIds) &&
    value.validationIds.every((id) => typeof id === 'string')
  );
}

function copyRecoveryEvents(value: readonly ModuleMigrationRecoveryEvent[]): ModuleMigrationRecoveryEvent[] {
  return value
    .filter((event) => (
      typeof event.transactionId === 'string' &&
      typeof event.waveId === 'string' &&
      (event.state === 'rolled-back' || event.state === 'committed') &&
      typeof event.recoveredAt === 'string' &&
      (event.commit === undefined || typeof event.commit === 'string')
    ))
    .map((event) => ({ ...event }))
    .slice(-32);
}

function appendRecoveryEvent(
  events: readonly ModuleMigrationRecoveryEvent[],
  event: ModuleMigrationRecoveryEvent,
): ModuleMigrationRecoveryEvent[] {
  return copyRecoveryEvents([...events, event]);
}

function staticAnalysisPreview(session: ModuleMigrationReviewSession): Record<string, unknown> {
  const { analysis } = session;
  return {
    kind: 'RepositoryStaticAnalysis',
    snapshotId: analysis.snapshotId,
    contentHash: analysis.contentHash,
    analyzerVersion: analysis.analyzerVersion,
    repository: analysis.repository,
    artifactPath: session.artifactPath,
    counts: {
      files: analysis.files.length,
      symbols: analysis.symbols.length,
      dependencies: analysis.dependencies.length,
      diagnostics: analysis.diagnostics.length,
    },
    diagnostics: analysis.diagnostics,
  };
}

function planPreview(
  session: ModuleMigrationReviewSession,
  summary: ModuleSummary,
  validationIssues: unknown,
): Record<string, unknown> {
  const plan = requirePlan(session);
  const referencedEdges = evidenceEdges(session.analysis, plan);
  const referencedSymbols = evidenceSymbols(session.analysis, plan);
  return {
    kind: 'ModuleMigrationPlanReview',
    readOnly: true,
    snapshot: staticAnalysisPreview(session),
    summary,
    validationIssues,
    evidence: {
      dependencies: referencedEdges,
      symbols: referencedSymbols,
    },
  };
}

function wavePreview(
  session: ModuleMigrationReviewSession,
  wave: ExecutionWave,
): Record<string, unknown> {
  const plan = requirePlan(session);
  const moduleIds = new Set(wave.moduleIds);
  const groupIds = new Set(wave.groupIds);
  const modules = plan.modules.filter((module) => moduleIds.has(module.id));
  const groups = plan.executionGroups.filter((group) => groupIds.has(group.id));
  return {
    kind: 'ExecutionWaveSchedulePreview',
    readOnly: true,
    snapshotId: session.analysis.snapshotId,
    planId: plan.id,
    planHash: plan.planHash,
    wave,
    modules,
    groups,
    evidence: {
      dependencies: evidenceEdges(session.analysis, {
        ...plan,
        modules,
      }),
      symbols: evidenceSymbols(session.analysis, { ...plan, modules }),
    },
    executionBoundary: {
      preparedBundle: session.prepared?.transaction.waveId === wave.id
        ? {
          transactionId: session.prepared.transaction.id,
          preparedHash: session.prepared.transaction.preparedHash,
          baseCommit: session.prepared.transaction.baseCommit,
          validation: session.prepared.validation,
        }
        : session.storedPrepared?.waveId === wave.id
          ? {
            transactionId: session.storedPrepared.transactionId,
            preparedHash: session.storedPrepared.preparedHash,
            restartRecoveryRequired: true,
          }
          : null,
      canApprove: session.prepared?.transaction.waveId === wave.id,
      canCommit: session.prepared !== undefined &&
        areWaveApprovalsCurrent(
          plan,
          session.prepared.transaction.waveId,
          session.prepared.transaction.preparedHash,
          session.analysis.snapshotId,
        ) &&
        session.prepared.transaction.waveId === wave.id,
      reason: session.prepared?.transaction.waveId === wave.id
        ? 'The local trusted host prepared this exact patch bundle and joint validation evidence. A human wave approval is still required before commit.'
        : session.storedPrepared?.waveId === wave.id
          ? 'A restart invalidates prepared patch bundles. Recover, regenerate, validate, and approve a new bundle.'
          : 'Import a local patch-only bundle to prepare this wave in an isolated worktree. Bundle-provided validation claims are not accepted.',
    },
  };
}

function localBundlePreview(
  session: ModuleMigrationReviewSession,
  bundle: ModuleWavePatchBundle,
  wave: ExecutionWave,
): Record<string, unknown> {
  return {
    kind: 'LocalModuleWavePatchBundleReview',
    readOnly: true,
    snapshotId: session.analysis.snapshotId,
    planId: requirePlan(session).id,
    planHash: requirePlan(session).planHash,
    bundle: {
      contentHash: bundle.contentHash,
      waveId: bundle.waveId,
      modules: bundle.modules,
      validationClaimsAccepted: false,
    },
    wave,
  };
}

function preparedWavePreview(
  session: ModuleMigrationReviewSession,
  prepared: PreparedModuleWave,
): Record<string, unknown> {
  return {
    kind: 'PreparedModuleMigrationWaveReview',
    readOnly: true,
    snapshot: staticAnalysisPreview(session),
    plan: {
      id: requirePlan(session).id,
      planHash: requirePlan(session).planHash,
      status: requirePlan(session).status,
    },
    transaction: prepared.transaction,
    branchName: prepared.branchName,
    files: prepared.files,
    modules: prepared.preparedModules,
    validation: prepared.validation,
    executionBoundary: {
      canApprove: true,
      canCommit: areWaveApprovalsCurrent(
        requirePlan(session),
        prepared.transaction.waveId,
        prepared.transaction.preparedHash,
        session.analysis.snapshotId,
      ),
      approvalMustBindPreparedHash: prepared.transaction.preparedHash,
    },
  };
}

function committedWavePreview(
  session: ModuleMigrationReviewSession,
  committed: {
    branchName: string;
    commit: string;
    transaction: { waveId: string; preparedHash: string };
    summary: ModuleSummary;
  },
): Record<string, unknown> {
  return {
    kind: 'CommittedModuleMigrationWave',
    readOnly: true,
    snapshot: staticAnalysisPreview(session),
    branchName: committed.branchName,
    commit: committed.commit,
    transaction: committed.transaction,
    summary: committed.summary,
  };
}

function recoveryPreview(
  session: ModuleMigrationReviewSession,
  recoveredTransactions: readonly ModuleMigrationWaveRecoveryResult[] = [],
): Record<string, unknown> {
  return {
    kind: 'RecoveredModuleMigrationReview',
    readOnly: true,
    recoveredTransactions,
    lifecycleRecovery: session.recoveryEvents,
    snapshot: staticAnalysisPreview(session),
    ...(session.plan === undefined
      ? { plan: null }
      : {
        plan: {
          id: session.plan.id,
          status: session.plan.status,
          planHash: session.plan.planHash,
          approved: arePlanApprovalsCurrent(session.plan, session.analysis.snapshotId),
          waves: session.plan.executionWaves,
          decisions: session.plan.decisions,
        },
      }),
  };
}

function recoveryMessage(
  session: ModuleMigrationReviewSession,
  recoveredTransactions: readonly ModuleMigrationWaveRecoveryResult[],
): string {
  const transactionMessage = recoveredTransactions.length === 0
    ? '没有发现未完成的波次事务。'
    : `已回滚 ${recoveredTransactions.length} 个未完成的波次事务（${recoveredTransactions.map((item) => item.transactionId).join('、')}）。`;
  const lifecycleMessage = session.recoveryEvents.length === 0
    ? ''
    : ` 已协调 ${session.recoveryEvents.length} 条本地运行生命周期记录。`;
  const reviewMessage = session.plan
    ? `已恢复模块计划 ${session.plan.id} 的可信审阅状态。`
    : `已恢复静态分析快照 ${session.analysis.snapshotId}；尚未生成模块计划。`;
  return `${reviewMessage}${transactionMessage}${lifecycleMessage}`;
}

function evidenceEdges(
  analysis: RepositoryStaticAnalysis,
  plan: Pick<ModuleMigrationPlan, 'modules' | 'dependencies'>,
) {
  const ids = new Set<string>();
  for (const module of plan.modules) {
    for (const id of module.evidenceIds) ids.add(id);
  }
  for (const dependency of plan.dependencies ?? []) {
    for (const id of dependency.evidenceEdgeIds) ids.add(id);
  }
  return analysis.dependencies.filter((edge) => ids.has(edge.id));
}

function evidenceSymbols(
  analysis: RepositoryStaticAnalysis,
  plan: Pick<ModuleMigrationPlan, 'modules'>,
) {
  const ids = new Set(plan.modules.flatMap((module) => module.symbolIds));
  return analysis.symbols.filter((symbol) => ids.has(symbol.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
