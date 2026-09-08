import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  FileJson2,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  RotateCcw,
} from 'lucide-react';
import { ProjectPicker, type ProjectPickerProps } from './ProjectPicker';
import type { ModuleChildrenProvider } from '../module-children-provider';
import type {
  ModuleExplorerMode,
  ModuleExplorerNode,
  ModuleExplorerPresentation,
  ModuleImplementationStatus,
  ModuleWorkspacePresentation,
} from '../../../src/ui-types';

type StatusFilter = 'all' | 'implemented' | 'unimplemented' | 'unknown';

interface ModuleWorkspaceProps {
  primaryContent?: boolean;
  repositories?: ProjectPickerProps['repositories'];
  onSelectProject?: ProjectPickerProps['onSelect'];
  onRefreshRepository?: ProjectPickerProps['onRefresh'];
  onAddTarget?: ProjectPickerProps['onAdd'];
  onRetry?(scope: import('@forexplore/contracts').ProjectAnalysisScope, force: boolean): void;
  onLoadChildren?: ModuleChildrenProvider;
  explorer: ModuleExplorerPresentation;
  mode: ModuleExplorerMode;
  historyId: string | null;
  currentTargetId: string;
  selectedNodeId: string | null;
  refreshing: boolean;
  onModeChange(mode: ModuleExplorerMode): void;
  onHistoryChange(id: string): void;
  onNodeSelect(node: ModuleExplorerNode): void;
  onTargetSelect(targetId: string): void;
  onRefresh(): void;
  onOpenSettings(): void;
  settingsOpen: boolean;
  children: React.ReactNode;
}

export function ModuleWorkspace({
  primaryContent = false,
  repositories = [],
  onSelectProject,
  onRefreshRepository,
  onAddTarget,
  onRetry,
  onLoadChildren,
  explorer,
  mode,
  historyId,
  currentTargetId,
  selectedNodeId,
  refreshing,
  onModeChange,
  onHistoryChange,
  onNodeSelect,
  onTargetSelect,
  onRefresh,
  onOpenSettings,
  settingsOpen,
  children,
}: ModuleWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadedSelection, setLoadedSelection] = useState<{ scope: string; node: ModuleExplorerNode }>();
  const workspace = activeWorkspace(explorer, mode, historyId);
  const workspaceKey = `${workspace.id}:${workspace.projectId}:${workspace.revision}`;
  const rootPageKey = `${workspaceKey}:${workspace.analysis?.updatedAt}:${workspace.rootTotal}`;
  const [rootPage, setRootPage] = useState({ key: '', nodes: [] as ModuleExplorerNode[], loading: false, error: '' });
  const rootData = rootPage.key === rootPageKey ? rootPage : { nodes: workspace.tree, loading: false, error: '' };
  const rootTotal = workspace.rootTotal ?? rootData.nodes.length;
  const noTarget = mode === 'target' && !workspace.projectId && workspace.id === 'target:unselected';
  const analyzing = ['queued', 'analyzing', 'validating'].includes(workspace.analysis?.state ?? '');
  const filteredTree = useMemo(
    () => filterTree(rootData.nodes, query.trim().toLocaleLowerCase(), status),
    [rootData.nodes, query, status],
  );
  const selectedNode = useMemo(() =>
    (selectedNodeId ? findNode(rootData.nodes, (node) => node.id === selectedNodeId) : undefined) ??
    (loadedSelection?.scope === workspaceKey && (loadedSelection.node.id === selectedNodeId ||
      Boolean(currentTargetId && loadedSelection.node.targetId === currentTargetId)) ? loadedSelection.node : undefined) ??
    (currentTargetId ? findNode(rootData.nodes, (node) => node.targetId === currentTargetId) : undefined),
  [rootData.nodes, selectedNodeId, currentTargetId, loadedSelection, workspaceKey]);
  const selectNode = (node: ModuleExplorerNode) => {
    setLoadedSelection({ scope: workspaceKey, node });
    onNodeSelect(node);
  };
  const loadChildren = useCallback((nodeId: string, offset: number, signal?: AbortSignal) => {
    if (!onLoadChildren || !workspace.repositoryId || !workspace.revision || !workspace.projectId) {
      return Promise.reject(new Error('模块快照不可用。'));
    }
    return onLoadChildren({ repositoryId: workspace.repositoryId, analysisRevision: workspace.revision,
      projectId: workspace.projectId, nodeId, offset,
      ...(nodeId === '$search' ? { query: query.trim(), status } : {}) }, signal);
  }, [onLoadChildren, workspace.repositoryId, workspace.revision, workspace.projectId, query, status]);
  async function loadRootPage(): Promise<void> {
    if (!onLoadChildren || rootData.loading || rootData.nodes.length >= rootTotal) return;
    const key = rootPageKey;
    setRootPage({ key, nodes: rootData.nodes, loading: true, error: '' });
    try {
      const page = await loadChildren('$root', rootData.nodes.length);
      if (page.total !== rootTotal || page.nodes.length === 0) throw new Error('模块列表已更新，请刷新工程。');
      setRootPage((current) => current.key === key ? { ...current, nodes: [...current.nodes, ...page.nodes], loading: false } : current);
    } catch (error) {
      setRootPage((current) => current.key === key ? { ...current, loading: false,
        error: error instanceof Error ? error.message : '模块目录读取失败' } : current);
    }
  }
  const remoteFiltering = Boolean(onLoadChildren && workspace.tree.some((node) => node.childrenTotal !== undefined) && (query.trim() || status !== 'all'));
  const [searchPage, setSearchPage] = useState({ nodes: [] as ModuleExplorerNode[], total: 0, loading: false, error: '' });
  const [searchOffset, setSearchOffset] = useState(0);
  useEffect(() => { setSearchOffset(0); }, [query, status, workspaceKey]);
  useEffect(() => {
    if (!remoteFiltering) return;
    const controller = new AbortController();
    setSearchPage((current) => ({ ...current, ...(searchOffset === 0 ? { nodes: [], total: 0 } : {}), loading: true, error: '' }));
    const timer = setTimeout(() => {
      void loadChildren('$search', searchOffset, controller.signal).then((page) => {
        if (!controller.signal.aborted) setSearchPage((current) => ({ ...page,
          nodes: searchOffset === 0 ? page.nodes : [...current.nodes, ...page.nodes], loading: false, error: '' }));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setSearchPage((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : '模块搜索失败' }));
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [remoteFiltering, loadChildren, searchOffset]);
  const visibleTree = remoteFiltering ? searchPage.nodes : filteredTree;

  return (
    <div className="module-layout">
      <aside className="module-sidebar" aria-label="模块工作区导航">
        <div className="workspace-switch" role="tablist" aria-label="模块数据源">
          <button
            type="button"
            className={mode === 'target' ? 'is-active' : ''}
            role="tab" aria-selected={mode === 'target'}
            onClick={() => { setPickerOpen(false); onModeChange('target'); }}
          >
            <Target size={13} />
            目标工程
            <small>01B</small>
          </button>
          <button
            type="button"
            className={mode === 'history' ? 'is-active' : ''}
            role="tab" aria-selected={mode === 'history'}
            onClick={() => { setPickerOpen(false); onModeChange('history'); }}
          >
            <History size={13} />
            参考工程
            <small>01A</small>
          </button>
        </div>

        {onSelectProject ? <ProjectPicker mode={mode} workspace={workspace} repositories={repositories}
          open={pickerOpen} onOpenChange={setPickerOpen} refreshing={refreshing}
          onSelect={(...args) => { setQuery(''); setStatus('all'); onSelectProject(...args); }}
          onRefresh={(id) => onRefreshRepository?.(id)} onAdd={(value) => onAddTarget?.(value)} onOpenSettings={onOpenSettings} /> : null}

        {!onSelectProject && mode === 'history' && explorer.history.length > 1 ? (
          <label className="history-picker">
            <span>参考工程</span>
            <select
              value={workspace.id}
              onChange={(event) => onHistoryChange(event.target.value)}
            >
              {explorer.history.map((repository) => (
                <option key={repository.id} value={repository.id}>{repository.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {!onSelectProject ? <div className="explorer-title-row">
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.rootLabel}</small>
          </div>
          <button
            type="button"
            className="icon-button"
            title="重新分析模块树"
            aria-label="重新分析模块树"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={13} className={refreshing ? 'is-spinning' : ''} />
          </button>
        </div> : null}

        <label className="module-search">
          <Search size={13} />
          <input
            disabled={noTarget}
            type="search"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块、文件、类或方法"
          />
        </label>

        <div className="status-filter" aria-label="实现状态筛选">
          {([
            ['all', '全部'],
            ['implemented', '已完成'],
            ['unimplemented', '未完成'],
            ['unknown', '待确认'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'is-active' : ''}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="module-tree" role="tree" aria-label={`${workspace.name} 模块树`}>
          {workspace.loading ? (
            <div className="tree-empty">
              <RefreshCw size={15} className="is-spinning" />
              <span>切换到参考工程后正在按需分析模块…</span>
            </div>
          ) : workspace.error ? (
            <div className="tree-empty is-error">
              <AlertTriangle size={15} />
              <span>{workspace.error}</span>
            </div>
          ) : visibleTree.length === 0 ? (
            <div className="tree-empty">{noTarget ? '尚未选择目标工程' : remoteFiltering && searchPage.loading ? '正在搜索…' : remoteFiltering && searchPage.error ? searchPage.error : '没有匹配的模块项'}</div>
          ) : (
            <TreeNodes key={`${workspaceKey}:${query}:${status}`} nodes={visibleTree} depth={0}
              currentTargetId={currentTargetId} selectedNodeId={selectedNode?.id ?? null}
              onNodeSelect={selectNode} onTargetSelect={mode === 'target' ? onTargetSelect : undefined}
              loadChildren={onLoadChildren ? loadChildren : undefined}
              showLocation={remoteFiltering}
              total={remoteFiltering ? searchPage.total : workspace.rootTotal ?? visibleTree.length}
              loading={remoteFiltering ? searchPage.loading : rootData.loading}
              onMore={remoteFiltering ? () => setSearchOffset(searchPage.nodes.length) : workspace.rootTotal === undefined ? undefined : () => { void loadRootPage(); }} />
          )}
          {!remoteFiltering && rootData.error ? <div className="tree-load-error" role="alert">{rootData.error}<button type="button" onClick={() => { void loadRootPage(); }}>重试</button></div> : null}
        </div>

        <div className="tree-legend">
          <span><i className="status-mark is-implemented" />已完成</span>
          <span><i className="status-mark is-unimplemented" />未完成</span>
          <span><i className="status-mark is-unknown" />待确认</span>
        </div>
      </aside>

      <section className="module-main">
        <div className="module-main-scroll">
          {!settingsOpen && !primaryContent && noTarget ? <section className="target-empty-state" aria-label="选择目标工程">
            <FolderOpen size={32} strokeWidth={1.25} />
            <h1>选择目标工程</h1>
            <button type="button" className="primary-action" onClick={() => setPickerOpen(true)}><FolderOpen size={15} />选择项目<ChevronDown size={13} /></button>
          </section> : null}
          {!settingsOpen && !primaryContent && !noTarget && explorer.history.length === 0 ? (
            <section className="history-configuration-prompt" role="status">
              <div className="history-configuration-icon"><History size={17} /></div>
              <div>
                <strong>尚未配置参考工程</strong>
                <span>添加至少一个本地参考工程路径，保存后即可从左侧切换并加载 01A。</span>
              </div>
              <button type="button" className="secondary-action" onClick={onOpenSettings}>
                配置路径
              </button>
            </section>
          ) : null}
          {!settingsOpen && !primaryContent && mode === 'history' ? (
            <HistoryOverview
              key={workspaceKey}
              workspace={{ ...workspace, tree: rootData.nodes }}
              selectedNode={selectedNode}
              onNodeSelect={selectNode}
              onMoreModules={() => { void loadRootPage(); }}
              loadingModules={rootData.loading}
            />
          ) : null}
          {settingsOpen || primaryContent || (mode === 'target' && !noTarget) ? children : null}
          {!settingsOpen && selectedNode?.kind === 'module' && (primaryContent || mode === 'target')
            ? <HistorySelectionPreview node={selectedNode} /> : null}
          {!settingsOpen && workspace.projectId ? (
            <section className="project-analysis" aria-label="项目解析结果">
              <h2>{workspace.name}</h2>
              <p role="status">模块解析：{analysisState(workspace.analysis?.state)} · 检索同步：{workspace.analysis?.projection ?? 'pending'}</p>
              {workspace.analysis?.modeling ? <p>模块来源：{workspace.analysis.modeling.strategy === 'structural' ? '离线结构分析' : 'Agent 分析'}</p> : null}
              {workspace.analysis?.hierarchy ? <div className="hierarchy-summary" aria-label="模块层级统计">
                <span>{workspace.analysis.hierarchy.rootCount} 个顶层范围</span>
                <span>{workspace.analysis.hierarchy.moduleCount} 个模块</span>
                {workspace.analysis.hierarchy.subsystemCount > 0 ? <span>{workspace.analysis.hierarchy.subsystemCount} 个子系统</span> : null}
                <span>叶模块 {workspace.analysis.hierarchy.leafCount}</span>
                {workspace.analysis.hierarchy.deferredCount > 0 ? <span className="is-deferred">待细化 {workspace.analysis.hierarchy.deferredCount}</span> : null}
                {workspace.analysis.hierarchy.unknownCount > 0 ? <span>细化状态未标注 {workspace.analysis.hierarchy.unknownCount}</span> : null}
              </div> : null}
              {workspace.analysis?.error ? <p role="alert">{workspace.analysis.error}</p> : null}
              <p className="project-summary">{workspace.analysis?.proposal?.summary ?? '尚无有效模块摘要。可查看结构索引，或重试模块解析。'}</p>
              {workspace.analysis?.state === 'stale' ? <p>正在浏览历史版本，以下结果不代表当前代码。</p> : null}
              {workspace.analysis?.coverage ? <p>文件覆盖：{workspace.analysis.coverage.assigned} / {workspace.analysis.coverage.total}
                {workspace.analysis.coverage.unassigned.map((item) => <span className="unassigned-file" key={item.path}>{item.path}：{item.reason}</span>)}
                {(workspace.detailCounts?.unassigned ?? 0) > workspace.analysis.coverage.unassigned.length ? <span className="detail-preview-count">未归属明细：展示 {workspace.analysis.coverage.unassigned.length} / {workspace.detailCounts!.unassigned}</span> : null}
              </p> : null}
              {workspace.analysis?.proposal?.risks?.map((risk, i) => <p key={i}>{risk}</p>)}
              {workspace.repositoryId && workspace.revision && workspace.analysis?.state !== 'stale' ? (
                <div className="project-actions">
                  <button type="button" className="secondary-action" disabled={analyzing || !onRetry} onClick={() => onRetry?.({ repositoryId: workspace.repositoryId!, analysisRevision: workspace.revision!, projectId: workspace.projectId! }, false)}><RefreshCw size={13} />重试解析 / 同步</button>
                  <button type="button" className="secondary-action" disabled={analyzing || !onRetry} onClick={() => onRetry?.({ repositoryId: workspace.repositoryId!, analysisRevision: workspace.revision!, projectId: workspace.projectId! }, true)}><RotateCcw size={13} />重新解析模块</button>
                </div>
              ) : null}
              <details><summary>依赖关系（{workspace.detailCounts?.dependencies ?? workspace.dependencies?.length ?? 0}）</summary>
                {(workspace.detailCounts?.dependencies ?? 0) > (workspace.dependencies?.length ?? 0) ? <p className="detail-preview-count">展示前 {workspace.dependencies?.length ?? 0} 条 / 共 {workspace.detailCounts!.dependencies} 条</p> : null}
                <ul>{workspace.dependencies?.map((edge) => <li key={edge.dependencyEdgeId}>
                  {edge.sourceRelativePath} → {edge.targetRelativePath ?? edge.targetReference ?? '未知目标'} · {edge.kind} · {edge.resolution}
                </li>)}</ul>
              </details>
              <details><summary>解析诊断（{workspace.detailCounts?.diagnostics ?? workspace.diagnostics?.length ?? 0}）</summary>
                {(workspace.detailCounts?.diagnostics ?? 0) > (workspace.diagnostics?.length ?? 0) ? <p className="detail-preview-count">展示前 {workspace.diagnostics?.length ?? 0} 条 / 共 {workspace.detailCounts!.diagnostics} 条</p> : null}
                <ul>{workspace.diagnostics?.map((diagnostic) => <li key={diagnostic.diagnosticId}>
                  {diagnostic.relativePath} · {diagnostic.severity} · {diagnostic.message}
                </li>)}</ul>
              </details>
              <details><summary>版本信息</summary><code>{workspace.repositoryId} / {workspace.projectId} / {workspace.revision}</code></details>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}

interface TreeNodeProps {
  node: ModuleExplorerNode;
  depth: number;
  currentTargetId: string;
  selectedNodeId: string | null;
  onNodeSelect(node: ModuleExplorerNode): void;
  onTargetSelect?: (targetId: string) => void;
  loadChildren?: (nodeId: string, offset: number, signal?: AbortSignal) => ReturnType<ModuleChildrenProvider>;
  showLocation?: boolean;
}

const treePageSize = 80;

function TreeNodes({ nodes, total = nodes.length, loading = false, onMore, ...props }: Omit<TreeNodeProps, 'node'> & {
  nodes: ModuleExplorerNode[]; total?: number; loading?: boolean; onMore?: () => void;
}) {
  const [visible, setVisible] = useState(treePageSize);
  const shown = Math.min(visible, nodes.length);
  return <>
    {nodes.slice(0, visible).map((node) => <TreeNode key={node.id} {...props} node={node} />)}
    {shown < total ? <button type="button" className="tree-more" disabled={loading} onClick={() => {
      setVisible((value) => value + treePageSize);
      if (shown === nodes.length) onMore?.();
    }}><ChevronDown size={12} />{loading ? '正在读取…' : `更多（${shown} / ${total}）`}</button> : null}
  </>;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth, currentTargetId, selectedNodeId, onNodeSelect, onTargetSelect, loadChildren, showLocation } = props;
  const location = showLocation && node.path ? `${node.path}${node.line === undefined ? '' : `:${node.line}`}` : undefined;
  const directoryEnd = node.path?.lastIndexOf('/') ?? -1;
  const lazy = node.childrenTotal !== undefined;
  const [expanded, setExpanded] = useState(!lazy && depth < 2);
  const [children, setChildren] = useState(node.children);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const total = node.childrenTotal ?? node.children.length;
  const hasChildren = total > 0;
  useEffect(() => {
    if (!expanded || !lazy || !loadChildren || children.length > offset || total === 0) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void loadChildren(node.id, offset, controller.signal).then((page) => {
      if (!controller.signal.aborted) { setChildren((current) => offset === 0 ? page.nodes : [...current, ...page.nodes]); setLoading(false); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '读取失败'); setLoading(false); }
    });
    return () => controller.abort();
  }, [expanded, lazy, loadChildren, node.id, offset, attempt, total]);
  const isCurrent = node.targetId === currentTargetId;
  const isSelected = node.id === selectedNodeId;

  function select(): void {
    onNodeSelect(node);
    if (node.targetId && node.targetId !== currentTargetId && onTargetSelect) {
      onTargetSelect(node.targetId);
    }
  }

  return (
    <div className="tree-node" role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-level={depth + 1}
      data-node-id={node.id} data-node-kind={node.nodeKind ?? node.kind} data-module-depth={node.depth}>
      <div
        className={`tree-row${isSelected ? ' is-selected' : ''}${isCurrent ? ' is-current-target' : ''}${location ? ' is-search-result' : ''}`}
        style={{ paddingLeft: `${6 + depth * 15}px` }}
      >
        <button
          type="button"
          className="tree-toggle"
          aria-label={`${expanded ? '折叠' : '展开'} ${node.name}`}
          onClick={() => setExpanded((value) => !value)}
          disabled={!hasChildren}
        >
          {hasChildren ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </button>
        <button type="button" className="tree-select" onClick={select} title={location ? [node.signature, location].filter(Boolean).join('\n') : node.signature ?? node.path}>
          <NodeIcon node={node} />
          {location ? <span className="tree-item-text">
            <span className="tree-label">{node.name}</span>
            <small className="tree-location" title={location}>
              {directoryEnd >= 0 ? <span className="tree-location-directory">{node.path!.slice(0, directoryEnd + 1)}</span> : null}
              <span className="tree-location-file">{node.path!.slice(directoryEnd + 1)}{node.line === undefined ? '' : `:${node.line}`}</span>
            </small>
          </span> : <span className="tree-label">{node.name}</span>}
          {hasChildren ? <small className="tree-count">{total}</small> : null}
          {node.refinement?.state === 'deferred' ? <span className="tree-refinement-warning"
            aria-label="待细化" title={node.refinement.reason}><AlertTriangle size={11} /></span> : null}
          {node.targetId || !hasChildren ? <StatusMark status={node.implementationStatus} /> : null}
        </button>
      </div>
      {hasChildren && expanded ? (
        <div role="group">
          {error ? <div className="tree-load-error" role="alert">{error}<button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div> : null}
          <TreeNodes {...props} nodes={lazy ? children : node.children} depth={depth + 1} total={total}
            loading={loading} onMore={lazy ? () => setOffset(children.length) : undefined} />
        </div>
      ) : null}
    </div>
  );
}

function NodeIcon({ node }: { node: ModuleExplorerNode }) {
  if (node.kind === 'module' && node.nodeKind === 'subsystem') return <Layers size={13} className="node-icon is-subsystem" />;
  if (node.kind === 'module') return <Box size={13} className="node-icon is-module" />;
  if (node.kind === 'folder') return <Folder size={13} className="node-icon is-folder" />;
  if (node.kind === 'file') return <FileCode2 size={13} className="node-icon is-file" />;
  return <span className={`symbol-icon is-${node.kind}`}>{symbolLetter(node.kind)}</span>;
}

function StatusMark({ status }: { status?: ModuleImplementationStatus }) {
  return <i className={`status-mark is-${status ?? 'unknown'}`} title={statusLabel(status)} />;
}

function HistoryOverview({
  workspace,
  selectedNode,
  onNodeSelect,
  onMoreModules,
  loadingModules,
}: {
  workspace: ModuleWorkspacePresentation;
  selectedNode?: ModuleExplorerNode;
  onNodeSelect(node: ModuleExplorerNode): void;
  onMoreModules?(): void;
  loadingModules?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleModules, setVisibleModules] = useState(24);
  const modules = workspace.tree.filter((node) => node.kind === 'module');
  const catalogTotal = workspace.analysis?.hierarchy?.rootCount ?? (workspace.rootTotal === undefined ? modules.length : workspace.stats.modules);
  const hierarchical = (workspace.analysis?.hierarchy?.maxDepth ?? 0) > 0 || (workspace.analysis?.hierarchy?.subsystemCount ?? 0) > 0;
  const pipeline = [
    { icon: <Database size={15} />, title: '静态索引', detail: `${workspace.stats.files} 文件 / ${workspace.stats.types + workspace.stats.methods} 符号`, complete: Boolean(workspace.snapshotId) },
    { icon: <GitBranch size={15} />, title: '依赖分析', detail: `${workspace.stats.dependencies} 条依赖证据`, complete: Boolean(workspace.snapshotId) },
    { icon: <Sparkles size={15} />, title: workspace.analysis?.modeling?.strategy === 'structural' ? '离线模块划分' : 'Agent 模块划分', detail: `${workspace.stats.modules} 个模块`, complete: workspace.stats.modules > 0 },
    {
      icon: <FileJson2 size={15} />,
      title: 'summary.json',
      detail: workspace.summary.error
        ? '摘要无效'
        : workspace.summary.exists ? `${workspace.summary.moduleCount ?? 0} 个模块摘要` : '尚未生成',
      complete: workspace.summary.exists && !workspace.summary.error,
    },
  ];
  return (
    <div className="module-overview history-overview">
      <section className="history-library-hero">
        <div className="history-library-title">
          <div className="overview-glyph"><History size={17} /></div>
          <div>
            <span className="history-library-code">01A · 参考模块库</span>
            <h1>{workspace.name}</h1>
            <p>浏览可复用模块，并选择本次需求需要参考的代码范围</p>
          </div>
        </div>
        <div className={`history-library-state${workspace.snapshotId ? ' is-ready' : ''}`}>
          <span><i />{workspace.snapshotId ? '模块库已就绪' : '等待分析'}</span>
          <small title={workspace.rootLabel}>{workspace.rootLabel}</small>
        </div>
      </section>

      <HistoryStats workspace={workspace} />

      <section className="history-catalog" aria-label="参考模块目录">
        <div className="history-section-heading">
          <div>
            <h2>模块目录</h2>
            <p>选择模块后，可继续在左侧定位到具体文件、类或方法</p>
          </div>
          <span>{hierarchical ? `${catalogTotal} 个顶层范围 · ${workspace.stats.modules} 个节点` : `${workspace.stats.modules} 个模块`}</span>
        </div>
        {modules.length > 0 ? (
          <div className="history-module-grid">
            {modules.slice(0, visibleModules).map((module) => {
              const summary = summarizeModule(module);
              const selected = selectedNode ? containsNode(module, selectedNode.id) : false;
              return (
                <button
                  key={module.id}
                  type="button"
                  className={`history-module-card${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => onNodeSelect(module)}
                >
                  <span className="history-module-card-top">
                    <span className="history-module-icon"><NodeIcon node={module} /></span>
                    <span className="history-module-languages">
                      {summary.languages.length > 0
                        ? summary.languages.slice(0, 2).map((language) => <small key={language}>{language}</small>)
                        : <small>代码模块</small>}
                    </span>
                  </span>
                  <strong>{module.name}</strong>
                  <span className="history-module-description">
                    {module.purpose ?? module.description ?? `包含 ${summary.files} 个代码文件，可作为需求实现的检索范围。`}
                  </span>
                  <span className="history-module-card-footer">
                    {module.domain ? <span>{module.domain}</span> : null}
                    <span>{summary.files} 文件</span>
                    <span>{summary.types} 类型</span>
                    <span>{summary.methods} 方法</span>
                    <ChevronRight size={13} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="history-catalog-empty">
            <Box size={22} />
            <div>
              <strong>暂无可浏览模块</strong>
              <span>{workspace.error ?? '重新分析该参考工程后，模块会显示在这里。'}</span>
            </div>
          </div>
        )}
        {Math.min(visibleModules, modules.length) < catalogTotal ? <button type="button" className="tree-more" disabled={loadingModules} onClick={() => {
          const next = visibleModules + 24;
          setVisibleModules(next);
          if (next > modules.length) onMoreModules?.();
        }}><ChevronDown size={13} />{loadingModules ? '正在读取…' : `更多${hierarchical ? '顶层范围' : '模块'}（${Math.min(visibleModules, modules.length)} / ${catalogTotal}）`}</button> : null}
      </section>

      <HistorySelectionPreview node={selectedNode} />

      <div className="history-analysis-fold">
        <button type="button" className="overview-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? '收起分析信息' : '查看分析信息'}
        </button>
        {!expanded ? <span>4 项技术状态</span> : null}
      </div>
      {expanded ? (
        <>
          <div className="analysis-pipeline">
            {pipeline.map((step, index) => (
              <div key={step.title} className={`pipeline-step${step.complete ? ' is-complete' : ''}`}>
                <span className="pipeline-number">{index + 1}</span>
                <span className="pipeline-icon">{step.icon}</span>
                <div><strong>{step.title}</strong><small>{step.detail}</small></div>
                {step.complete ? <CheckCircle2 size={14} /> : <span className="pipeline-pending" />}
              </div>
            ))}
          </div>
          <div className="history-grid">
            <section className="card summary-card">
              <div className="card-heading"><span>模块知识摘要</span><FileJson2 size={14} /></div>
              {workspace.summary.error ? (
                <div className="summary-empty is-error">
                  <AlertTriangle size={24} />
                  <strong>module-summary.json 无法读取</strong>
                  <span>{workspace.summary.error}</span>
                </div>
              ) : workspace.summary.exists ? (
                <dl className="compact-definition-list">
                  <div><dt>计划</dt><dd>{workspace.summary.planId}</dd></div>
                  <div><dt>状态</dt><dd>{workspace.summary.status}</dd></div>
                  <div><dt>模块</dt><dd>{workspace.summary.moduleCount}</dd></div>
                  <div><dt>执行波次</dt><dd>{workspace.summary.waveCount}</dd></div>
                  <div><dt>审批</dt><dd>{workspace.summary.approvalsCurrent ? '当前有效' : '需重新确认'}</dd></div>
                </dl>
              ) : (
                <div className="summary-empty">
                  <FileJson2 size={24} />
                  <strong>未发现 module-summary.json</strong>
                  <span>完成 Agent 模块计划和受信任审批后，由 Host 事务生成。</span>
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function HistoryStats({ workspace }: { workspace: ModuleWorkspacePresentation }) {
  const stats = [
    [workspace.analysis?.hierarchy ? '模块树节点' : '可复用模块', workspace.stats.modules, 'M'],
    ['代码文件', workspace.stats.files, 'F'],
    ['类 / 类型', workspace.stats.types, 'C'],
    ['方法 / 函数', workspace.stats.methods, 'ƒ'],
  ] as const;
  return (
    <div className="history-stats" aria-label="参考工程规模">
      {stats.map(([label, value, glyph]) => (
        <div key={label}>
          <span>{glyph}</span>
          <strong>{value}</strong>
          <small>{label}</small>
        </div>
      ))}
    </div>
  );
}

function HistorySelectionPreview({ node }: { node?: ModuleExplorerNode }) {
  if (!node) {
    return (
      <section className="history-selection-preview is-empty">
        <Box size={16} />
        <span>从模块卡片或左侧模块树中选择一项，查看它的检索范围。</span>
      </section>
    );
  }
  const summary = summarizeModule(node);
  const coreApis = node.coreApis?.slice(0, 6) ?? [];
  const description = node.purpose ?? node.description ?? node.signature ?? '该项将作为代码检索与复用的参考范围。';
  return (
    <section className="history-selection-preview" aria-label="当前选择">
      <div className="history-selection-heading">
        <span>当前选择</span>
        <small>{node.nodeKind === 'subsystem' ? '子系统' : kindLabel(node.kind)}</small>
      </div>
      <div className="history-selection-body">
        <span className="history-selection-icon"><NodeIcon node={node} /></span>
        <div>
          <strong>{node.name}</strong>
          {description !== node.refinement?.reason ? <p>{description}</p> : null}
          {node.refinement ? <div className={`module-refinement${node.refinement.state === 'deferred' ? ' is-deferred' : ''}`} aria-label="模块细化状态">
            <span>{({ leaf: '叶模块', split: '已划分子模块', deferred: '待细化' })[node.refinement.state]}</span>
            <span>{({ model: '模型判断', structural: '结构分析', budget: '预算限制' })[node.refinement.decisionSource]}</span>
            <p>{node.refinement.reason}</p>
          </div> : null}
          <div className="history-selection-meta">
            {node.path ? <code title={node.path}>{node.path}</code> : null}
            {node.domain ? <span>{node.domain}</span> : null}
            {node.language ? <span>{node.language}</span> : null}
            {summary.files > 0 ? <span>{summary.files} 文件</span> : null}
            {summary.types > 0 ? <span>{summary.types} 类型</span> : null}
            {summary.methods > 0 ? <span>{summary.methods} 方法</span> : null}
          </div>
          {coreApis.length > 0 ? (
            <div className="history-selection-apis" aria-label="核心 API">
              {coreApis.map((api) => <code key={api}>{api}</code>)}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

interface ModuleContentsSummary {
  files: number;
  types: number;
  methods: number;
  languages: string[];
}

function summarizeModule(node: ModuleExplorerNode): ModuleContentsSummary {
  if (node.contents) return node.contents;
  const summary: ModuleContentsSummary = { files: 0, types: 0, methods: 0, languages: [] };
  const languages = new Set<string>();
  visitNode(node, (current) => {
    if (current.kind === 'file') summary.files += 1;
    if (['class', 'interface', 'record', 'struct', 'enum'].includes(current.kind)) summary.types += 1;
    if (['method', 'constructor', 'function'].includes(current.kind)) summary.methods += 1;
    if (current.language) languages.add(current.language);
  });
  summary.languages = [...languages].sort((left, right) => left.localeCompare(right));
  return summary;
}

function containsNode(root: ModuleExplorerNode, id: string): boolean {
  return root.id === id || root.children.some((node) => containsNode(node, id));
}

function visitNode(node: ModuleExplorerNode, visit: (node: ModuleExplorerNode) => void): void {
  visit(node);
  node.children.forEach((child) => visitNode(child, visit));
}

function activeWorkspace(
  explorer: ModuleExplorerPresentation,
  mode: ModuleExplorerMode,
  historyId: string | null,
): ModuleWorkspacePresentation {
  if (mode === 'target') return explorer.target;
  return explorer.history.find((repository) => repository.id === historyId) ??
    explorer.history[0] ?? emptyHistoryWorkspace();
}

function emptyHistoryWorkspace(): ModuleWorkspacePresentation {
  return {
    id: 'history:empty',
    mode: 'history',
    name: '未配置参考工程',
    rootLabel: '请在 ForeXplore 设置中配置 repositoryPaths',
    error: '未配置可分析的参考工程路径。',
    stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' },
    tree: [],
  };
}

function filterTree(
  nodes: ModuleExplorerNode[],
  query: string,
  status: StatusFilter,
): ModuleExplorerNode[] {
  if (!query && status === 'all') return nodes;
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, query, status);
    const queryMatch = !query || [node.name, node.path, node.signature]
      .filter(Boolean)
      .some((value) => value?.toLocaleLowerCase().includes(query));
    const effectiveStatus = node.implementationStatus ?? (node.children.length === 0 ? 'unknown' : undefined);
    const statusMatch = status === 'all' || effectiveStatus === status;
    if ((queryMatch && statusMatch) || children.length > 0) return [{ ...node, children }];
    return [];
  });
}

export function findNode(
  nodes: ModuleExplorerNode[],
  predicate: (node: ModuleExplorerNode) => boolean,
): ModuleExplorerNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const child = findNode(node.children, predicate);
    if (child) return child;
  }
  return undefined;
}

function symbolLetter(kind: ModuleExplorerNode['kind']): string {
  if (['class', 'interface', 'record', 'struct', 'enum'].includes(kind)) return 'C';
  return 'M';
}

function kindLabel(kind: ModuleExplorerNode['kind']): string {
  const labels: Record<ModuleExplorerNode['kind'], string> = {
    module: '模块', folder: '目录', file: '文件', class: '类', interface: '接口', record: '记录',
    struct: '结构', enum: '枚举', method: '方法', constructor: '构造方法', function: '函数',
  };
  return labels[kind];
}

function statusLabel(status?: ModuleImplementationStatus): string {
  if (status === 'implemented') return '已完成';
  if (status === 'unimplemented') return '未完成';
  return '待确认';
}

function analysisState(state?: import('@forexplore/contracts').ProjectAnalysisRecord['state']): string {
  return ({ missing: '未解析', queued: '排队中', analyzing: '解析中', validating: '校验中', ready: '就绪', failed: '失败，可重试', stale: '历史结果' })[state ?? 'missing'];
}
