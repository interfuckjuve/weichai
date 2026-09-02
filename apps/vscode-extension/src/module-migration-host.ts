import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  type ExecutionWave,
  type MigrationRunManifest,
  type ModuleDiscoveryProposal,
  type ModuleMigrationPlan,
  type ModuleSummary,
  type PlanDecision,
  type RepositoryIngestionArtifactRef,
  type RepositoryIngestionManifest,
  type RepositoryKnowledgePublicationScope,
  type RepositoryModuleCatalog,
  type RepositoryModuleEvidenceBundle,
  type RepositoryModuleKnowledgeReview,
  type RepositoryModuleKnowledgeReviewDecision,
  type RepositoryModuleWikiProposal,
  type RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  arePlanApprovalsCurrent,
  areWaveApprovalsCurrent,
  calculateModuleMigrationPlanHash,
  invalidatePlanForSnapshot,
  materializeModuleSummary,
  recordModulePlanDecision,
  selectCurrentRepositoryKnowledgePublicationArtifactRefs,
  selectCurrentRepositoryModuleSummaryArtifactRefs,
  validateModuleMigrationPlan,
} from '@forexplore/workflow-core';
import type { PreparedModuleWave } from '@forexplore/adaptation-service/module-wave-execution';
import {
  analyzeRepository,
  readRepositoryAnalysisArtifact,
  writeRepositoryAnalysisArtifact,
  type RepositoryLanguageRegistry,
} from '@forexplore/code-indexer';
import { requestRepositoryModuleDiscovery } from './module-discovery-client';
import {
  HttpModuleKnowledgeIndexPublisher,
  type ModuleKnowledgeIndexPublisher,
} from './module-knowledge-index-client';
import {
  initializeRepositoryAfterStaticAnalysis,
  repositoryIngestionInitializationPreview,
  type InitializeRepositoryAfterStaticAnalysisInput,
  type RepositoryIngestionInitializationResult,
} from './repository-ingestion-coordinator';
import {
  readRepositoryIngestionArtifactContent,
  readRepositoryIngestionManifest,
} from './repository-ingestion-store';
import { RepositoryKnowledgePublicationStore } from './repository-knowledge-publication-store';
import {
  reviewAndPublishRepositoryModuleKnowledge,
  type RepositoryModuleKnowledgeReviewSubmission,
} from './repository-module-knowledge-publication';
import { withdrawRepositoryModuleKnowledgePublication } from './repository-module-knowledge-withdrawal';
import { reviewRepositoryModulePublication } from './repository-module-publication';
import { generateRepositoryModuleSummaries } from './repository-module-summary';
import { requestRepositoryModuleSummary } from './module-summary-client';
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
  loadModuleKnowledgeIndexWriterToken,
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
const reviewStorageVersion = 4;
const reviewStoragePrefix = 'forexplore.moduleMigration.review';

export type ModuleMigrationHostStage =
  | 'idle'
  | 'indexing'
  | 'indexed'
  | 'initializing-modules'
  | 'awaiting-module-review'
  | 'summarizing-modules'
  | 'awaiting-summary-review'
  | 'publishing-knowledge'
  | 'modules-ready'
  | 'module-ingestion-closed'
  | 'analysis-partial'
  | 'initialization-failed'
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
  ingestionId?: string;
  ingestionStatus?: RepositoryIngestionManifest['status'];
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
  repositoryIngestion?: StoredRepositoryIngestionInitialization;
}

interface StoredModuleMigrationReview {
  version: number;
  workspaceUri: string;
  snapshotId: string;
  plan?: ModuleMigrationPlan;
  manifest?: MigrationRunManifest;
  prepared?: StoredPreparedModuleWave;
  recoveryEvents?: ModuleMigrationRecoveryEvent[];
  repositoryIngestion?: StoredRepositoryIngestionInitialization;
}

interface StoredRepositoryIngestionInitialization {
  ingestionId: string;
  status: RepositoryIngestionManifest['status'];
  manifestPath: string;
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
  /** Test/host seam for the automatic post-index dynamic initialization. */
  repositoryInitializer?: (
    input: InitializeRepositoryAfterStaticAnalysisInput,
  ) => Promise<RepositoryIngestionInitializationResult>;
  /** Runtime extension point for repository-analysis languages; migration support is separate. */
  repositoryLanguageRegistry?: RepositoryLanguageRegistry;
  /** Test/host seam for the repository-local SQLite publication control plane. */
  repositoryKnowledgePublicationStore?: RepositoryKnowledgePublicationStore;
  /** Test/host seam for the separately deployed module-knowledge index writer. */
  moduleKnowledgeIndexPublisher?: ModuleKnowledgeIndexPublisher;
}

/**
 * Trusted VS Code host flow for repository ingestion and module planning. It
 * owns immutable analysis artifacts, deterministic validation, and local plan
 * review state; discovery and architecture HTTP endpoints can only return
 * untrusted proposals.
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
    let session: ModuleMigrationReviewSession | undefined;
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
          ...(this.options.repositoryLanguageRegistry === undefined
            ? {}
            : { languageRegistry: this.options.repositoryLanguageRegistry }),
        }),
      );
      const artifactPath = await writeRepositoryAnalysisArtifact(workspaceFolder.uri.fsPath, analysis);
      session = {
        workspaceFolder,
        analysis,
        artifactPath,
        recoveryEvents: [],
      };
      this.sessions.set(workspaceFolder.uri.toString(), session);
      await this.persistSession(session);
      this.setState({ stage: 'indexed', session });
    } catch (error) {
      this.reportError(error, '模块静态分析失败');
      return;
    }

    try {
      this.setState({ stage: 'initializing-modules', session });
      const result = await vscode.window.withProgress<RepositoryIngestionInitializationResult>(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在初始化仓库模块知识',
        },
        () => this.initializeRepository(session!),
      );
      session.repositoryIngestion = {
        ingestionId: result.ingestionId,
        status: result.status,
        manifestPath: result.manifestPath,
      };
      await this.persistSession(session);
      this.setState({
        stage: result.status === 'awaiting-module-review'
          ? 'awaiting-module-review'
          : result.status === 'ready'
            ? 'modules-ready'
            : result.status === 'summarizing-modules'
              ? 'summarizing-modules'
              : result.status === 'awaiting-summary-review'
                ? 'awaiting-summary-review'
                : result.status === 'publishing-knowledge'
                  ? 'publishing-knowledge'
            : result.status === 'partial'
              ? 'analysis-partial'
              : result.status === 'failed'
                ? 'initialization-failed'
                : 'initialization-failed',
        session,
      });
      await this.options.previews.show('Repository module initialization', {
        staticSnapshot: staticAnalysisPreview(session),
        dynamicInitialization: repositoryIngestionInitializationPreview(result),
      });
      if (result.status === 'awaiting-module-review') {
        void vscode.window.showInformationMessage(
          `已创建静态分析快照 ${session.analysis.snapshotId}，并完成动态模块初始化 ${result.ingestionId}。当前停在“等待模块人工审阅”；模块目录尚未批准，检索投影也尚未写入 SeekDB。`,
        );
      } else if (result.status === 'ready') {
        void vscode.window.showInformationMessage(
          `仓库模块处理已完成；已复用人工审阅后的 RepositoryModuleBundle。`,
        );
      } else if (
        result.status === 'summarizing-modules' ||
        result.status === 'awaiting-summary-review' ||
        result.status === 'publishing-knowledge'
      ) {
        void vscode.window.showInformationMessage(
          `模块边界已接受，知识处理当前处于 ${result.status}；尚未激活为可检索知识。`,
        );
      } else if (result.status === 'partial') {
        this.options.output.appendLine(
          `[forexplore] 仓库分析证据不足，未调用模块 Agent: ${result.manifestPath}`,
        );
        void vscode.window.showWarningMessage(
          `静态分析快照 ${session.analysis.snapshotId} 已保留，但缺少模块划分所需的符号/API 证据。未调用模块 Agent；请注册对应语言分析适配器后重新入库。`,
        );
      } else {
        this.options.output.appendLine(
          `[forexplore] 动态模块初始化失败（静态快照已保留）: ${result.failureMessage ?? result.manifestPath}`,
        );
        void vscode.window.showErrorMessage(
          `静态分析快照 ${session.analysis.snapshotId} 已保留，但动态模块初始化失败：${result.failureMessage ?? '请查看初始化清单。'} 清单：${result.manifestPath}`,
        );
      }
    } catch (error) {
      this.setState({ stage: 'initialization-failed', session });
      await this.options.previews.show('Static analysis snapshot (module initialization failed)', {
        staticSnapshot: staticAnalysisPreview(session),
        dynamicInitialization: {
          status: 'failed',
          committed: false,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      this.reportError(error, '动态模块初始化失败（静态分析快照已保留）');
    }
  }

  /** First human gate: accept only the proposed module ownership/boundaries. */
  async reviewRepositoryModuleBoundaries(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      const ingestion = requireRepositoryIngestion(session);
      const manifest = await requireRepositoryIngestionManifest(
        workspaceFolder.uri.fsPath,
        ingestion.ingestionId,
      );
      if (manifest.status !== 'awaiting-module-review') {
        throw new Error(`当前入库不在模块边界审阅阶段：${manifest.status}。`);
      }
      const proposal = await readManifestJson<ModuleDiscoveryProposal>(
        workspaceFolder.uri.fsPath,
        manifest,
        requiredIngestionArtifact(manifest.artifacts.moduleDiscoveryProposal, '模块发现提案'),
      );
      const catalog = await readManifestJson<RepositoryModuleCatalog>(
        workspaceFolder.uri.fsPath,
        manifest,
        requiredIngestionArtifact(manifest.artifacts.moduleCatalog, '草稿模块目录'),
      );
      await this.options.previews.show('Repository module boundary review', {
        warning: '本次决定只审批模块边界，不审批 Agent 叙述，也不会直接进入正式检索。',
        proposal,
        catalog,
      });
      const choice = await vscode.window.showWarningMessage(
        '请在只读文档中核对模块归属、重叠、未分配文件、依赖和风险。该决定不会把摘要叙述标为已审阅。',
        { modal: true },
        '接受模块边界',
        '要求重新划分',
        '拒绝本次入库',
      );
      if (!choice) return;
      const reviewerId = await requestReviewActor('模块边界审批人');
      if (!reviewerId) return;
      const comment = await vscode.window.showInputBox({
        title: '模块边界审阅备注（可选）',
        prompt: '记录接受依据、修订要求或拒绝原因。',
      });
      if (comment === undefined) return;
      const decision = choice === '接受模块边界'
        ? 'accept' as const
        : choice === '要求重新划分'
          ? 'revise' as const
          : 'reject' as const;
      const result = await reviewRepositoryModulePublication({
        repositoryRoot: workspaceFolder.uri.fsPath,
        ingestionId: manifest.id,
        decision,
        reviewerId,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      updateStoredRepositoryIngestion(session, result.manifest, result.manifestPath);
      await this.persistSession(session);
      if (result.outcome !== 'summarizing-modules') {
        this.setState({ stage: 'module-ingestion-closed', session });
        void vscode.window.showInformationMessage(
          result.outcome === 'revision-required'
            ? '本轮模块提案已关闭，必须生成新的提案后才能继续。未发布任何模块知识。'
            : '本轮仓库入库已拒绝。未发布任何模块知识。',
        );
        return;
      }

      this.setState({ stage: 'summarizing-modules', session });
      try {
        await this.runRepositoryModuleSummaryGeneration(session);
      } catch (error) {
        this.reportError(error, '模块边界已接受，但 Summary Agent 未完成；可运行“生成模块知识摘要提案”重试');
      }
    } catch (error) {
      this.reportError(error, '模块边界审阅失败');
    }
  }

  /** Retryable Agent stage; it always stops at the independent summary gate. */
  async generateRepositoryModuleSummaries(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      await this.runRepositoryModuleSummaryGeneration(session);
    } catch (error) {
      this.reportError(error, '模块摘要生成失败');
    }
  }

  /** Second human gate followed by immutable staging and dual-head activation. */
  async reviewRepositoryModuleKnowledge(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      const ingestion = requireRepositoryIngestion(session);
      const manifest = await requireRepositoryIngestionManifest(
        workspaceFolder.uri.fsPath,
        ingestion.ingestionId,
      );
      updateStoredRepositoryIngestion(session, manifest, ingestion.manifestPath);
      if (
        manifest.status !== 'awaiting-summary-review' &&
        manifest.status !== 'publishing-knowledge' &&
        manifest.status !== 'ready'
      ) {
        throw new Error(`当前入库不在模块知识审阅/发布阶段：${manifest.status}。`);
      }
      const summaryRefs = selectCurrentRepositoryModuleSummaryArtifactRefs(manifest);
      const [evidenceBundles, wikiProposals, currentReviews] = await Promise.all([
        Promise.all(summaryRefs.evidenceBundles.map((artifact) =>
          readManifestJson<RepositoryModuleEvidenceBundle>(workspaceFolder.uri.fsPath, manifest, artifact),
        )),
        Promise.all(summaryRefs.wikiProposals.map((artifact) =>
          readManifestJson<RepositoryModuleWikiProposal>(workspaceFolder.uri.fsPath, manifest, artifact),
        )),
        Promise.all(summaryRefs.knowledgeReviews.map((artifact) =>
          readManifestJson<RepositoryModuleKnowledgeReview>(workspaceFolder.uri.fsPath, manifest, artifact),
        )),
      ]);
      await this.options.previews.show('Repository module knowledge review', {
        warning: '这是独立于模块边界审批的第二道人审。只有全部当前摘要被明确接受，才会进入本地不可变发布和独立模块索引。',
        evidenceBundles,
        wikiProposals,
        carriedAcceptedReviews: currentReviews.filter((review) => review.decision === 'accept'),
      });

      const reviews = manifest.status !== 'awaiting-summary-review'
        ? []
        : await collectPendingModuleKnowledgeReviews(wikiProposals, currentReviews);
      if (reviews === undefined) return;

      const settings = loadSettings();
      const publicationContext = manifest.status !== 'awaiting-summary-review'
        ? requirePersistedPublicationContext(manifest)
        : await requestPublicationContext(manifest.repositoryId, settings.repositoryKnowledgeChannel);
      if (publicationContext === undefined) return;
      const indexPublisher = this.options.moduleKnowledgeIndexPublisher ??
        createFailClosedModuleKnowledgeIndexPublisher(settings.retrievalApiUrl);
      this.setState({ stage: manifest.status === 'ready' ? 'modules-ready' : 'publishing-knowledge', session });
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在提交模块知识审阅并发布独立索引',
        },
        () => reviewAndPublishRepositoryModuleKnowledge(
          {
            repositoryRoot: workspaceFolder.uri.fsPath,
            ingestionId: manifest.id,
            scope: publicationContext.scope,
            repositoryScopes: publicationContext.repositoryScopes,
            reviews,
          },
          {
            publicationStore: this.options.repositoryKnowledgePublicationStore ??
              new RepositoryKnowledgePublicationStore(),
            indexPublisher,
          },
        ),
      );
      updateStoredRepositoryIngestion(session, result.manifest, result.manifestPath);
      await this.persistSession(session);
      if (result.outcome === 'revision-required') {
        this.setState({ stage: 'summarizing-modules', session });
        void vscode.window.showInformationMessage(
          '已保留接受项并记录修订意见；只会为要求修订的模块重新运行 Summary Agent。',
        );
        await this.runRepositoryModuleSummaryGeneration(session);
        return;
      }
      if (result.outcome === 'rejected') {
        this.setState({ stage: 'module-ingestion-closed', session });
        void vscode.window.showInformationMessage('本轮模块知识已拒绝并关闭，未发布到正式检索。');
        return;
      }
      this.setState({ stage: 'modules-ready', session });
      void vscode.window.showInformationMessage(
        result.outcome === 'reused'
          ? '已确认现有本地与模块索引发布状态；未创建重复发布。'
          : `模块知识已在 ${publicationContext.scope.channel} 通道完成双头激活，可进入正式模块检索。`,
      );
    } catch (error) {
      this.reportError(error, '模块知识审阅或发布失败');
    }
  }

  /** Explicit logical revocation; history is retained and the predecessor is restored when available. */
  async withdrawRepositoryModuleKnowledge(): Promise<void> {
    try {
      const workspaceFolder = await selectWorkspaceFolder();
      if (!workspaceFolder) return;
      const session = await this.loadSession(workspaceFolder);
      const ingestion = requireRepositoryIngestion(session);
      const manifest = await requireRepositoryIngestionManifest(
        workspaceFolder.uri.fsPath,
        ingestion.ingestionId,
      );
      if (manifest.status !== 'ready') {
        throw new Error(`只有 ready 的当前模块知识可以撤销：${manifest.status}。`);
      }
      const refs = selectCurrentRepositoryKnowledgePublicationArtifactRefs(manifest);
      await this.options.previews.show('Repository module knowledge withdrawal', {
        warning: '撤销是逻辑操作：正式模块检索会移除当前发布代，并在可用时恢复前一代；历史制品和审计记录不会删除。',
        scope: requirePersistedPublicationContext(manifest).scope,
        activePublicationArtifacts: refs,
      });
      const confirmation = await vscode.window.showWarningMessage(
        '确认撤销当前 active 模块知识发布？此操作不会删除历史，但会改变正式检索的 active head。',
        { modal: true },
        '确认撤销',
      );
      if (confirmation !== '确认撤销') return;
      const actorId = await requestReviewActor('模块知识撤销人');
      if (!actorId) return;
      const reason = await vscode.window.showInputBox({
        title: '模块知识撤销原因',
        prompt: '必填；该原因会写入不可变 ingestion 审计账本。',
        validateInput: (value) => value.trim() ? undefined : '撤销原因不能为空。',
      });
      if (reason === undefined || !reason.trim()) return;
      const context = requirePersistedPublicationContext(manifest);
      const settings = loadSettings();
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ForeXplore: 正在撤销模块知识发布',
        },
        () => withdrawRepositoryModuleKnowledgePublication(
          {
            repositoryRoot: workspaceFolder.uri.fsPath,
            ingestionId: manifest.id,
            scope: context.scope,
            reason: reason.trim(),
            actorId,
          },
          {
            publicationStore: this.options.repositoryKnowledgePublicationStore ??
              new RepositoryKnowledgePublicationStore(),
            indexPublisher: this.options.moduleKnowledgeIndexPublisher ??
              createFailClosedModuleKnowledgeIndexPublisher(settings.retrievalApiUrl),
          },
        ),
      );
      updateStoredRepositoryIngestion(session, result.manifest, result.manifestPath);
      await this.persistSession(session);
      this.setState({ stage: 'module-ingestion-closed', session });
      void vscode.window.showInformationMessage(
        result.restoredHead === undefined
          ? '当前模块知识发布已撤销；该作用域现在没有 active 模块发布。'
          : `当前模块知识发布已撤销，并恢复 generation ${result.restoredHead.generation}。`,
      );
    } catch (error) {
      this.reportError(error, '模块知识撤销失败');
    }
  }

  private async runRepositoryModuleSummaryGeneration(
    session: ModuleMigrationReviewSession,
  ): Promise<void> {
    const ingestion = requireRepositoryIngestion(session);
    const currentManifest = await requireRepositoryIngestionManifest(
      session.workspaceFolder.uri.fsPath,
      ingestion.ingestionId,
    );
    updateStoredRepositoryIngestion(session, currentManifest, ingestion.manifestPath);
    if (
      currentManifest.status !== 'summarizing-modules' &&
      currentManifest.status !== 'awaiting-summary-review'
    ) {
      throw new Error(`当前入库不在模块摘要生成阶段：${currentManifest.status}。`);
    }
    const serviceStatus = await this.options.services.refresh();
    if (serviceStatus.adaptation !== 'connected') {
      throw new Error(serviceStatus.message ?? '模块摘要服务尚未就绪。');
    }
    const settings = loadSettings();
    this.setState({ stage: 'summarizing-modules', session });
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ForeXplore: Summary Agent 正在生成证据绑定的模块 Wiki 提案',
      },
      () => generateRepositoryModuleSummaries(
        {
          repositoryRoot: session.workspaceFolder.uri.fsPath,
          ingestionId: ingestion.ingestionId,
        },
        {
          summarizeModule: (request) => requestRepositoryModuleSummary(
            settings.adaptationApiUrl,
            request,
          ),
        },
      ),
    );
    updateStoredRepositoryIngestion(session, result.manifest, result.manifestPath);
    await this.persistSession(session);
    this.setState({ stage: 'awaiting-summary-review', session });
    await this.options.previews.show('Repository module summary review', {
      warning: '以下叙述由 Agent 生成，尚未通过第二道人审；当前仍不可进入正式检索。',
      evidenceBundles: result.evidenceBundles,
      wikiProposals: result.wikiProposals,
    });
    void vscode.window.showInformationMessage(
      `已生成 ${result.wikiProposals.length} 个证据绑定的模块摘要提案；当前停在第二道人审，尚未发布。`,
    );
  }

  private async initializeRepository(
    session: ModuleMigrationReviewSession,
  ): Promise<RepositoryIngestionInitializationResult> {
    if (this.options.repositoryInitializer) {
      return this.options.repositoryInitializer({
        repositoryRoot: session.workspaceFolder.uri.fsPath,
        analysis: session.analysis,
      });
    }
    const settings = loadSettings();
    return initializeRepositoryAfterStaticAnalysis(
      {
        repositoryRoot: session.workspaceFolder.uri.fsPath,
        analysis: session.analysis,
      },
      {
        discoverModules: async (request) => {
          const status = await this.options.services.refresh();
          if (status.adaptation !== 'connected') {
            throw new Error(status.message ?? '模块发现服务尚未就绪。');
          }
          return requestRepositoryModuleDiscovery(settings.adaptationApiUrl, request);
        },
      },
    );
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
      ...(stored.repositoryIngestion === undefined
        ? {}
        : { repositoryIngestion: { ...stored.repositoryIngestion } }),
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
      ...(session.repositoryIngestion === undefined
        ? {}
        : { repositoryIngestion: { ...session.repositoryIngestion } }),
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
      ...(session?.repositoryIngestion === undefined
        ? {}
        : {
          ingestionId: session.repositoryIngestion.ingestionId,
          ingestionStatus: session.repositoryIngestion.status,
        }),
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

function requireRepositoryIngestion(
  session: ModuleMigrationReviewSession,
): StoredRepositoryIngestionInitialization {
  if (!session.repositoryIngestion) {
    throw new Error('当前工作区没有可审阅的仓库入库记录；请先运行“索引模块迁移仓库”。');
  }
  return session.repositoryIngestion;
}

async function requireRepositoryIngestionManifest(
  repositoryRoot: string,
  ingestionId: string,
): Promise<RepositoryIngestionManifest> {
  const manifest = await readRepositoryIngestionManifest(repositoryRoot, ingestionId);
  if (!manifest) throw new Error(`仓库入库清单不存在：${ingestionId}。`);
  return manifest;
}

function requiredIngestionArtifact(
  artifact: RepositoryIngestionArtifactRef | undefined,
  label: string,
): RepositoryIngestionArtifactRef {
  if (!artifact) throw new Error(`仓库入库缺少${label}。`);
  return artifact;
}

async function readManifestJson<T>(
  repositoryRoot: string,
  manifest: RepositoryIngestionManifest,
  artifact: RepositoryIngestionArtifactRef,
): Promise<T> {
  const content = await readRepositoryIngestionArtifactContent(
    repositoryRoot,
    manifest.id,
    artifact,
  );
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`仓库入库制品不是有效 JSON：${artifact.id}。`);
  }
}

function updateStoredRepositoryIngestion(
  session: ModuleMigrationReviewSession,
  manifest: RepositoryIngestionManifest,
  manifestPath: string,
): void {
  session.repositoryIngestion = {
    ingestionId: manifest.id,
    status: manifest.status,
    manifestPath,
  };
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

async function collectPendingModuleKnowledgeReviews(
  proposals: readonly RepositoryModuleWikiProposal[],
  currentReviews: readonly RepositoryModuleKnowledgeReview[],
): Promise<RepositoryModuleKnowledgeReviewSubmission[] | undefined> {
  const acceptedByModule = new Map(currentReviews
    .filter((review) => review.decision === 'accept')
    .map((review) => [review.moduleId, review]));
  const pending = proposals.filter((proposal) => {
    const review = acceptedByModule.get(proposal.moduleId);
    return review === undefined ||
      review.wikiProposalId !== proposal.id ||
      review.wikiProposalHash !== proposal.contentHash;
  });
  if (pending.length === 0) return [];
  const reviewerId = await requestReviewActor('模块知识审批人');
  if (!reviewerId) return undefined;
  const submissions: RepositoryModuleKnowledgeReviewSubmission[] = [];
  for (const proposal of pending) {
    const choice = await vscode.window.showWarningMessage(
      `审阅模块 ${proposal.moduleId}。接受只表示该摘要与所列证据一致，不证明迁移行为正确。`,
      { modal: true },
      '接受当前摘要',
      '要求修订摘要',
      '拒绝本次入库',
    );
    if (!choice) return undefined;
    const decision: RepositoryModuleKnowledgeReviewDecision = choice === '接受当前摘要'
      ? 'accept'
      : choice === '要求修订摘要'
        ? 'revise'
        : 'reject';
    const comment = await vscode.window.showInputBox({
      title: `模块知识审阅备注：${proposal.moduleId}`,
      prompt: decision === 'accept'
        ? '可选：记录接受依据。'
        : '必填：给出可审计的修订要求或拒绝原因。',
      validateInput: (value) => decision === 'accept' || value.trim()
        ? undefined
        : '修订或拒绝必须填写原因。',
    });
    if (comment === undefined) return undefined;
    submissions.push({
      moduleId: proposal.moduleId,
      decision,
      reviewerId,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
  }
  return submissions;
}

async function requestPublicationContext(
  repositoryId: string,
  defaultChannel: string,
): Promise<{
  scope: RepositoryKnowledgePublicationScope;
  repositoryScopes: string[];
} | undefined> {
  const channel = await vscode.window.showInputBox({
    title: '模块知识发布通道',
    prompt: '激活头以 (repositoryId, channel) 为作用域；同一作用域每次只激活一个发布代。',
    value: defaultChannel,
    validateInput: (value) => value.trim() ? undefined : '发布通道不能为空。',
  });
  if (channel === undefined) return undefined;
  const scope = { repositoryId, channel: channel.trim() };
  const confirmation = await vscode.window.showWarningMessage(
    `全部当前模块摘要通过后，将发布到 ${repositoryId} / ${scope.channel}；ACL 仅包含当前仓库。确认继续？`,
    { modal: true },
    '确认审阅并发布',
  );
  if (confirmation !== '确认审阅并发布') return undefined;
  return { scope, repositoryScopes: [repositoryId] };
}

function requirePersistedPublicationContext(manifest: RepositoryIngestionManifest): {
  scope: RepositoryKnowledgePublicationScope;
  repositoryScopes: string[];
} {
  for (const event of [...manifest.events].reverse()) {
    if (
      event.type !== 'knowledge-publication-staged' &&
      !(event.type === 'module-knowledge-review-recorded' && event.toStatus === 'publishing-knowledge')
    ) continue;
    if (!isRecord(event.details) || !isRecord(event.details.update)) continue;
    const update = event.details.update;
    const context = isRecord(update.publicationContext) ? update.publicationContext : update;
    if (
      !isRecord(context.scope) ||
      typeof context.scope.repositoryId !== 'string' ||
      typeof context.scope.channel !== 'string' ||
      !Array.isArray(context.repositoryScopes) ||
      !context.repositoryScopes.every((value) => typeof value === 'string' && value.trim())
    ) continue;
    const repositoryScopes = [...new Set(context.repositoryScopes.map((value) => String(value).trim()))].sort();
    if (!repositoryScopes.includes(context.scope.repositoryId)) continue;
    return {
      scope: {
        repositoryId: context.scope.repositoryId,
        channel: context.scope.channel,
      },
      repositoryScopes,
    };
  }
  throw new Error('发布恢复缺少已持久化的仓库、通道或 ACL 上下文。');
}

function createFailClosedModuleKnowledgeIndexPublisher(
  retrievalApiUrl: string,
): ModuleKnowledgeIndexPublisher {
  try {
    return new HttpModuleKnowledgeIndexPublisher(
      retrievalApiUrl,
      loadModuleKnowledgeIndexWriterToken(),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unavailable = async (): Promise<never> => {
      throw new Error(`模块知识索引写入不可用：${detail}`);
    };
    return {
      stage: unavailable,
      validate: unavailable,
      readHead: unavailable,
      activate: unavailable,
      withdraw: unavailable,
    };
  }
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
    ([2, 3, reviewStorageVersion] as unknown[]).includes(value.version) &&
    value.workspaceUri === workspaceFolder.uri.toString() &&
    typeof value.snapshotId === 'string' &&
    value.snapshotId.length > 0 &&
    (value.plan === undefined || isRecord(value.plan)) &&
    (value.manifest === undefined || isRecord(value.manifest)) &&
    (value.prepared === undefined || isRecord(value.prepared)) &&
    (value.recoveryEvents === undefined || Array.isArray(value.recoveryEvents)) &&
    (value.repositoryIngestion === undefined || isStoredRepositoryIngestion(value.repositoryIngestion))
  );
}

function isStoredRepositoryIngestion(value: unknown): value is StoredRepositoryIngestionInitialization {
  return isRecord(value) &&
    typeof value.ingestionId === 'string' &&
    (
      value.status === 'awaiting-module-review' ||
      value.status === 'summarizing-modules' ||
      value.status === 'awaiting-summary-review' ||
      value.status === 'publishing-knowledge' ||
      value.status === 'ready' ||
      value.status === 'partial' ||
      value.status === 'failed' ||
      value.status === 'superseded'
    ) &&
    typeof value.manifestPath === 'string';
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
