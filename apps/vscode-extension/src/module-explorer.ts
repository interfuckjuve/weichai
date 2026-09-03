import path from 'node:path';
import type {
  RepositoryIngestionManifest,
  RepositoryModuleCatalog,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import type { TargetWorkspaceHostRecord } from './target-workspace-host';
import type {
  TargetWorkspaceSnapshot,
  TargetWorkspaceTreeNode,
} from './protocol/messages';
import type {
  HistoryModuleSelectionIdentity,
  ModuleExplorerNode,
  ModuleExplorerPresentation,
  ModuleExplorerStats,
  ModuleImplementationStatus,
  ModuleWorkspaceLifecyclePresentation,
  ModuleWorkspacePresentation,
} from './ui-types';

export interface HistoryRepositoryInspection {
  registrationId: string;
  root: string;
  name: string;
  analysisSnapshotId?: string;
  manifest?: RepositoryIngestionManifest;
  ir?: UnifiedRepositoryIR;
  catalog?: RepositoryModuleCatalog;
  error?: string;
}

export function createModuleExplorerPresentation(input: {
  target: ModuleWorkspacePresentation;
  history: HistoryRepositoryInspection[];
  generatedAt?: string;
}): ModuleExplorerPresentation {
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    target: input.target,
    history: input.history.map(projectHistoryRepository),
  };
}

export function projectReviewedTargetWorkspace(
  snapshot: TargetWorkspaceSnapshot,
  rootLabel: string,
): ModuleWorkspacePresentation {
  const tree = snapshot.root.children.map(projectTargetNode);
  const counts = countTree(tree);
  const workspaceCounts = snapshot.moduleSnapshot.workspaceCounts;
  const current = snapshot.freshness === 'current';
  return {
    id: snapshot.workspaceId,
    mode: 'target',
    name: snapshot.workspaceName,
    rootLabel,
    snapshotId: snapshot.snapshotId,
    lifecycle: {
      stage: snapshot.freshness,
      label: current ? '已审目标目录' : '目标快照已失效',
      message: current
        ? '模块边界、实现状态和精确迁移路线均绑定当前 01B 快照。'
        : snapshot.staleReason ?? '必须刷新并重新完成目标模块边界审阅。',
      ready: current,
      publicationActive: false,
    },
    stats: {
      ...counts,
      implemented: workspaceCounts.implemented,
      unimplemented: workspaceCounts.unimplemented,
      partial: workspaceCounts.partial,
      unknown: workspaceCounts.unknown,
      notApplicable: workspaceCounts.notApplicable,
    },
    summary: { exists: false, path: '.forexplore/target-workspaces' },
    tree,
  };
}

export function projectTargetWorkspaceRecord(
  record: TargetWorkspaceHostRecord | null,
  workspaceName: string,
  rootLabel: string,
  workspaceId = `target:${rootLabel}`,
): ModuleWorkspacePresentation {
  if (!record) {
    return emptyWorkspace({
      id: workspaceId,
      mode: 'target',
      name: workspaceName,
      rootLabel,
      lifecycle: {
        stage: 'not-initialized',
        label: '尚未划分 01B',
        message: '初始化后先生成模块边界提案；人审通过前不能选择迁移目标。',
        ready: false,
        publicationActive: false,
        nextAction: 'initialize-target',
        nextActionLabel: '初始化目标工作区',
      },
    });
  }
  const catalog = record.accepted?.catalog ?? record.discovery?.draftCatalog;
  const ir = record.accepted?.ir ?? record.latest.ir;
  const tree = catalog ? projectCatalogTree(ir, catalog) : [];
  return {
    id: record.workspaceId,
    mode: 'target',
    name: workspaceName,
    rootLabel,
    snapshotId: record.accepted?.snapshot?.id ?? record.latest.analysis.snapshotId,
    error: record.failure,
    lifecycle: targetLifecycle(record),
    ...(catalog ? { catalog: catalogIdentity(catalog) } : {}),
    stats: statsFor(ir, catalog, tree),
    summary: { exists: false, path: '.forexplore/target-workspaces' },
    tree,
  };
}

export function emptyTargetWorkspace(
  workspaceName: string,
  rootLabel: string,
  actionable = true,
): ModuleWorkspacePresentation {
  if (!actionable) {
    return emptyWorkspace({
      id: 'target:not-open',
      mode: 'target',
      name: workspaceName,
      rootLabel,
      lifecycle: {
        stage: 'not-open',
        label: '未打开目标工作区',
        message: '请先在 VS Code 中打开要处理的目标工作区。',
        ready: false,
        publicationActive: false,
      },
    });
  }
  return projectTargetWorkspaceRecord(null, workspaceName, rootLabel);
}

export function projectHistoryRepository(
  inspection: HistoryRepositoryInspection,
): ModuleWorkspacePresentation {
  const { manifest, ir, catalog } = inspection;
  const lifecycle = historyLifecycle(inspection);
  const reviewed = manifest?.status === 'ready' &&
    catalog?.status === 'active' &&
    Boolean(catalog.reviewId && catalog.reviewHash);
  const historyIdentity = reviewed && catalog
    ? (moduleId: string): HistoryModuleSelectionIdentity => ({
        repositoryRegistrationId: inspection.registrationId,
        repositoryId: catalog.repositoryId,
        catalogId: catalog.id,
        catalogHash: catalog.contentHash,
        moduleId,
      })
    : undefined;
  const tree = ir && catalog ? projectCatalogTree(ir, catalog, historyIdentity) : [];
  const summaryCount = manifest?.artifacts.moduleWikiProposals.length ?? 0;
  return {
    id: inspection.registrationId,
    mode: 'history',
    name: inspection.name,
    rootLabel: inspection.root,
    snapshotId: inspection.analysisSnapshotId ?? ir?.id,
    ...(manifest?.repositoryRevision ? { revision: manifest.repositoryRevision } : {}),
    error: inspection.error ?? manifest?.failure?.message,
    lifecycle,
    ...(catalog ? { catalog: catalogIdentity(catalog) } : {}),
    stats: statsFor(ir, catalog, tree),
    summary: {
      exists: summaryCount > 0,
      path: manifest ? `.forexplore/ingestion/${manifest.id}` : '.forexplore/ingestion',
      status: manifest?.status,
      approvalsCurrent: manifest?.status === 'ready',
      moduleCount: catalog?.modules.length,
    },
    tree,
  };
}

function targetLifecycle(record: TargetWorkspaceHostRecord): ModuleWorkspaceLifecyclePresentation {
  switch (record.stage) {
    case 'awaiting-module-review':
      return lifecycle('awaiting-module-review', '等待目标边界审阅',
        '当前树来自草稿目录；接受 Gate 1 后才会生成实现状态清单。',
        'review-target-boundaries', '审阅目标模块边界');
    case 'status-inventory-failed':
      return lifecycle('status-inventory-failed', '实现状态检测失败',
        record.failure ?? '已审边界仍保留，可单独重试实现状态检测。',
        'retry-target-inventory', '重试实现状态检测');
    case 'body-only-compatible':
      return lifecycle('body-only-compatible', '实现体已变化',
        record.failure ?? '声明结构兼容，但必须显式 rebase 并再次审阅。',
        'rebase-target', '生成 rebase 提案');
    case 'reviewed':
      return {
        stage: 'reviewed',
        label: '已审目标目录',
        message: '只有 Host 校验过的 callable 与精确路线可以进入迁移。',
        ready: true,
        publicationActive: false,
      };
    default:
      return lifecycle(record.stage, '目标目录不可用',
        record.failure ?? '重新初始化会生成绑定当前工程快照的新提案。',
        'initialize-target', '重新初始化目标工作区');
  }
}

function historyLifecycle(
  inspection: HistoryRepositoryInspection,
): ModuleWorkspaceLifecyclePresentation {
  const status = inspection.manifest?.status;
  if (!status) {
    return lifecycle('not-imported', '尚未导入 01A',
      inspection.error ?? '路径已经注册，但尚未建立仓库分析与模块目录。',
      'import-history', '导入历史仓');
  }
  switch (status) {
    case 'awaiting-module-review':
      return lifecycle(status, '等待模块边界审阅',
        '草稿模块可以浏览，但不能作为正式检索或迁移来源。',
        'review-history-boundaries', '审阅模块边界');
    case 'summarizing-modules':
      return lifecycle(status, '等待生成知识摘要',
        '模块边界已接受；摘要生成与边界审批保持独立。',
        'generate-history-summaries', '生成知识摘要');
    case 'awaiting-summary-review':
    case 'publishing-knowledge':
      return lifecycle(status, '等待知识审阅与发布',
        '摘要尚未成为正式检索知识。',
        'review-history-knowledge', '审阅并发布知识');
    case 'ready':
      return {
        stage: status,
        label: '模块知识已发布',
        message: '当前 active catalog 与发布代可用于正式模块检索。',
        ready: true,
        publicationActive: true,
        nextAction: 'withdraw-history-publication',
        nextActionLabel: '撤回检索发布',
      };
    case 'superseded':
      return lifecycle(status, '当前入库已撤回',
        '路径与不可变制品仍保留；若存在前代，检索控制面会恢复前代发布。当前入库不能再被选择。',
        'import-history', '重新导入');
    default:
      return lifecycle(status, '仓库处理未就绪',
        inspection.manifest?.failure?.message ?? `当前阶段：${status}。`,
        'import-history', '重新导入');
  }
}

function lifecycle(
  stage: string,
  label: string,
  message: string,
  nextAction: ModuleWorkspaceLifecyclePresentation['nextAction'],
  nextActionLabel: string,
): ModuleWorkspaceLifecyclePresentation {
  return {
    stage,
    label,
    message,
    ready: false,
    publicationActive: false,
    nextAction,
    nextActionLabel,
  };
}

function projectTargetNode(node: TargetWorkspaceTreeNode): ModuleExplorerNode {
  const status = implementationStatus(node.assessment?.state ?? node.rollup?.state);
  return {
    id: node.nodeId,
    name: node.name,
    kind: targetNodeKind(node),
    path: node.path,
    language: node.languageId,
    signature: node.signature,
    line: node.range?.startLine,
    description: node.migrationEligibility.summary,
    ...(node.kind === 'callable'
      ? { targetId: node.nodeId, implementationStatus: status }
      : {}),
    children: node.children.map(projectTargetNode),
  };
}

function targetNodeKind(node: TargetWorkspaceTreeNode): ModuleExplorerNode['kind'] {
  if (node.kind === 'module' || node.kind === 'file') return node.kind;
  if (node.kind === 'callable') {
    return node.nativeKind === 'function' ? 'function' :
      node.nativeKind === 'constructor' ? 'constructor' : 'method';
  }
  if (node.kind === 'type' || node.kind === 'container') {
    if (node.nativeKind === 'interface' || node.nativeKind === 'record' ||
        node.nativeKind === 'struct' || node.nativeKind === 'enum') return node.nativeKind;
    return 'class';
  }
  return 'method';
}

function projectCatalogTree(
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
  historyIdentity?: (moduleId: string) => HistoryModuleSelectionIdentity,
): ModuleExplorerNode[] {
  const files = new Map(ir.files.map((file) => [file.id, file]));
  return [...catalog.modules]
    .sort((left, right) => compare(left.name, left.id, right.name, right.id))
    .map((module) => {
      const historyModule = historyIdentity?.(module.id);
      return {
        id: `catalog:${catalog.id}:module:${module.id}`,
        name: module.name,
        kind: 'module' as const,
        description: module.description,
        ...(historyModule ? { historyModule } : {}),
        children: [...new Set(module.fileIds)]
          .map((fileId) => files.get(fileId))
          .filter((file): file is UnifiedRepositoryIR['files'][number] => file !== undefined)
          .sort((left, right) => compare(left.path, left.id, right.path, right.id))
          .map((file) => projectCatalogFile(ir, catalog.id, module.id, file, historyModule)),
      };
    });
}

function projectCatalogFile(
  ir: UnifiedRepositoryIR,
  catalogId: string,
  moduleId: string,
  file: UnifiedRepositoryIR['files'][number],
  historyModule?: HistoryModuleSelectionIdentity,
): ModuleExplorerNode {
  const entities = ir.entities.filter((entity) => entity.fileId === file.id);
  const types = entities
    .filter((entity) => entity.kind === 'type')
    .sort(compareEntity)
    .map((entity) => projectCatalogEntity(ir, catalogId, moduleId, file, entity, historyModule));
  const topLevel = entities
    .filter((entity) => entity.kind === 'callable' && !entity.containerEntityId)
    .sort(compareEntity)
    .map((entity) => projectCatalogEntity(ir, catalogId, moduleId, file, entity, historyModule));
  return {
    id: `catalog:${catalogId}:module:${moduleId}:file:${file.id}`,
    name: path.posix.basename(file.path),
    kind: 'file',
    path: file.path,
    language: file.languageId,
    ...(historyModule ? { historyModule } : {}),
    children: [...types, ...topLevel],
  };
}

function projectCatalogEntity(
  ir: UnifiedRepositoryIR,
  catalogId: string,
  moduleId: string,
  file: UnifiedRepositoryIR['files'][number],
  entity: UnifiedRepositoryIR['entities'][number],
  historyModule?: HistoryModuleSelectionIdentity,
): ModuleExplorerNode {
  const nativeKind = typeof entity.attributes?.staticSymbolKind === 'string'
    ? entity.attributes.staticSymbolKind
    : undefined;
  const callable = entity.kind === 'callable';
  const kind: ModuleExplorerNode['kind'] = callable
    ? nativeKind === 'function' ? 'function' : nativeKind === 'constructor' ? 'constructor' : 'method'
    : nativeKind === 'interface' || nativeKind === 'record' || nativeKind === 'struct' || nativeKind === 'enum'
      ? nativeKind
      : 'class';
  const children = callable ? [] : ir.entities
    .filter((candidate) => candidate.kind === 'callable' && candidate.containerEntityId === entity.id)
    .sort(compareEntity)
    .map((candidate) => projectCatalogEntity(
      ir,
      catalogId,
      moduleId,
      file,
      candidate,
      historyModule,
    ));
  return {
    id: `catalog:${catalogId}:module:${moduleId}:entity:${entity.id}`,
    name: entity.name,
    kind,
    path: file.path,
    language: entity.languageId ?? file.languageId,
    signature: entity.signature,
    line: entity.range?.startLine,
    ...(historyModule ? { historyModule } : {}),
    children,
  };
}

function statsFor(
  ir: UnifiedRepositoryIR | undefined,
  catalog: RepositoryModuleCatalog | undefined,
  tree: ModuleExplorerNode[],
): ModuleExplorerStats {
  if (!ir) return emptyStats();
  const counts = countTree(tree);
  return {
    ...counts,
    modules: catalog?.modules.length ?? 0,
    files: catalog ? new Set(catalog.modules.flatMap((module) => module.fileIds)).size : ir.files.length,
    dependencies: catalog?.dependencies.length ?? ir.dependencies.length,
  };
}

function countTree(tree: ModuleExplorerNode[]): ModuleExplorerStats {
  const stats = emptyStats();
  const seenFiles = new Set<string>();
  const seenNodes = new Set<string>();
  const visit = (node: ModuleExplorerNode): void => {
    if (seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    if (node.kind === 'module') stats.modules += 1;
    if (node.kind === 'file') {
      seenFiles.add(node.path ?? node.id);
      stats.files = seenFiles.size;
    }
    if (['class', 'interface', 'record', 'struct', 'enum'].includes(node.kind)) stats.types += 1;
    if (['method', 'constructor', 'function'].includes(node.kind)) stats.methods += 1;
    if (node.implementationStatus === 'not-applicable') stats.notApplicable += 1;
    else if (node.implementationStatus) stats[node.implementationStatus] += 1;
    node.children.forEach(visit);
  };
  tree.forEach(visit);
  return stats;
}

function emptyStats(): ModuleExplorerStats {
  return {
    modules: 0,
    files: 0,
    types: 0,
    methods: 0,
    implemented: 0,
    unimplemented: 0,
    partial: 0,
    unknown: 0,
    notApplicable: 0,
    dependencies: 0,
  };
}

function implementationStatus(state: string | undefined): ModuleImplementationStatus {
  if (
    state === 'implemented' ||
    state === 'unimplemented' ||
    state === 'partial' ||
    state === 'not-applicable'
  ) return state;
  return 'unknown';
}

function catalogIdentity(catalog: RepositoryModuleCatalog) {
  return { id: catalog.id, contentHash: catalog.contentHash, status: catalog.status };
}

function emptyWorkspace(
  input: Pick<ModuleWorkspacePresentation, 'id' | 'mode' | 'name' | 'rootLabel' | 'lifecycle'>,
): ModuleWorkspacePresentation {
  return {
    ...input,
    stats: emptyStats(),
    summary: { exists: false, path: '.forexplore' },
    tree: [],
  };
}

function compare(leftName: string, leftId: string, rightName: string, rightId: string): number {
  return leftName.localeCompare(rightName) || leftId.localeCompare(rightId);
}

function compareEntity(
  left: UnifiedRepositoryIR['entities'][number],
  right: UnifiedRepositoryIR['entities'][number],
): number {
  return (left.range?.startLine ?? Number.MAX_SAFE_INTEGER) -
    (right.range?.startLine ?? Number.MAX_SAFE_INTEGER) ||
    compare(left.name, left.id, right.name, right.id);
}
