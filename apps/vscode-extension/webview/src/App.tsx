import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { RepositoryStatus, ServiceStatus } from '../../src/ui-types';
import type {
  PanelInitPayload,
  TargetWorkspaceImplementationState,
  TargetWorkspaceInvalidation,
  TargetWorkspaceMigrationRouteOption,
  TargetWorkspaceMigrationSelection,
  TargetWorkspaceSelectionIdentity,
  TargetWorkspaceSnapshot,
  TargetWorkspaceTreeNode,
} from '../../src/protocol/messages';
import { AdaptationStage } from './components/AdaptationStage';
import { CandidatesStage } from './components/CandidatesStage';
import { FooterStatus } from './components/FooterStatus';
import { PatchStage } from './components/PatchStage';
import { RequirementStage } from './components/RequirementStage';
import { StepRail } from './components/StepRail';
import { errorEvent } from './errors';
import { createMessageBus, type MessageBus } from './vscode-api';
import {
  initialWorkflowStateV2,
  selectedCandidateV2,
  workflowReducerV2,
  type WorkflowStateV2,
} from './v2-workflow';

type TargetWorkspaceFilter = 'all' | TargetWorkspaceImplementationState;

const implementationStates: TargetWorkspaceImplementationState[] = [
  'implemented',
  'unimplemented',
  'partial',
  'unknown',
  'not-applicable',
];

const implementationStateLabels: Record<TargetWorkspaceImplementationState, string> = {
  implemented: '检测到实现',
  unimplemented: '待实现',
  partial: '部分实现',
  unknown: '未知',
  'not-applicable': '不适用',
};

const nodeKindLabels: Record<TargetWorkspaceTreeNode['kind'], string> = {
  workspace: '工作区',
  module: '模块',
  file: '文件',
  type: '类型',
  container: '容器',
  member: '成员',
  callable: '可调用实体',
};

function nodeKindLabel(node: TargetWorkspaceTreeNode): string {
  return node.kindLabel?.trim() || node.nativeKind?.trim() || nodeKindLabels[node.kind];
}

function nodeGlyph(node: TargetWorkspaceTreeNode): string {
  return nodeKindLabel(node).slice(0, 1).toLocaleUpperCase();
}

function routeForCandidate(
  selection: TargetWorkspaceMigrationSelection | null,
  candidateLanguage: string | undefined,
): TargetWorkspaceMigrationRouteOption | null {
  if (!selection || !candidateLanguage) return null;
  return selection.routeOptions.find(({ route }) =>
    route.sourceLanguageId === candidateLanguage &&
    route.targetLanguageId === selection.target.entity.languageId,
  ) ?? null;
}

function implementationState(node: TargetWorkspaceTreeNode): TargetWorkspaceImplementationState {
  return node.assessment?.state ?? node.rollup?.state ?? 'unknown';
}

function findTargetWorkspaceNode(
  node: TargetWorkspaceTreeNode,
  nodeId: string,
): TargetWorkspaceTreeNode | null {
  if (node.nodeId === nodeId) return node;
  for (const child of node.children) {
    const found = findTargetWorkspaceNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function collectInitiallyExpanded(
  node: TargetWorkspaceTreeNode,
  depth = 0,
  result = new Set<string>(),
): Set<string> {
  if (node.children.length > 0 && depth < 2) result.add(node.nodeId);
  if (depth < 2) {
    for (const child of node.children) collectInitiallyExpanded(child, depth + 1, result);
  }
  return result;
}

function targetNodeSearchText(node: TargetWorkspaceTreeNode): string {
  return [
    node.name,
    node.qualifiedName,
    node.path,
    node.signature,
    node.languageId,
    node.moduleId,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLocaleLowerCase();
}

function filterTargetWorkspaceTree(
  node: TargetWorkspaceTreeNode,
  query: string,
  filter: TargetWorkspaceFilter,
): TargetWorkspaceTreeNode | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredChildren = node.children
    .map((child) => filterTargetWorkspaceTree(child, query, filter))
    .filter((child): child is TargetWorkspaceTreeNode => child !== null);
  const queryMatches = normalizedQuery.length === 0 || targetNodeSearchText(node).includes(normalizedQuery);
  const stateMatches = filter === 'all' || implementationState(node) === filter;
  if (!queryMatches || !stateMatches) {
    return filteredChildren.length > 0 ? { ...node, children: filteredChildren } : null;
  }
  if (normalizedQuery.length > 0 && filter === 'all') return node;
  return { ...node, children: filteredChildren };
}

interface TargetWorkspaceStatistics {
  modules: number;
  files: number;
  types: number;
  callables: number;
  eligibleCallables: number;
  byState: Record<TargetWorkspaceImplementationState, number>;
}

function targetWorkspaceStatistics(root: TargetWorkspaceTreeNode): TargetWorkspaceStatistics {
  const statistics: TargetWorkspaceStatistics = {
    modules: 0,
    files: 0,
    types: 0,
    callables: 0,
    eligibleCallables: 0,
    byState: {
      implemented: 0,
      unimplemented: 0,
      partial: 0,
      unknown: 0,
      'not-applicable': 0,
    },
  };
  const seen = new Set<string>();

  function visit(node: TargetWorkspaceTreeNode): void {
    const identity = `${node.kind}:${node.entityId}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      if (node.kind === 'module') statistics.modules += 1;
      if (node.kind === 'file') statistics.files += 1;
      if (node.kind === 'type') statistics.types += 1;
      if (node.kind === 'callable') {
        statistics.callables += 1;
        if (node.migrationEligibility.status === 'eligible') statistics.eligibleCallables += 1;
        statistics.byState[implementationState(node)] += 1;
      }
    }
    node.children.forEach(visit);
  }

  visit(root);
  return statistics;
}

function callableSummary(
  node: TargetWorkspaceTreeNode,
  snapshot: TargetWorkspaceSnapshot,
): { implemented: number; total: number } {
  if (node.rollup) {
    return {
      implemented: node.rollup.counts.implemented,
      total: node.rollup.counts.eligible,
    };
  }
  if (node.kind === 'workspace') {
    return {
      implemented: snapshot.moduleSnapshot.workspaceCounts.implemented,
      total: snapshot.moduleSnapshot.workspaceCounts.eligible,
    };
  }
  const seen = new Set<string>();
  let implemented = 0;
  let total = 0;
  function visit(current: TargetWorkspaceTreeNode): void {
    if (current.kind === 'callable' && !seen.has(current.entityId)) {
      seen.add(current.entityId);
      const state = implementationState(current);
      if (state !== 'not-applicable') {
        total += 1;
        if (state === 'implemented') implemented += 1;
      }
    }
    current.children.forEach(visit);
  }
  visit(node);
  return { implemented, total };
}

function selectionIdentity(
  snapshot: TargetWorkspaceSnapshot,
  node: TargetWorkspaceTreeNode,
): TargetWorkspaceSelectionIdentity {
  return {
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    nodeId: node.nodeId,
    entityId: node.entityId,
  };
}

function isCoherentTargetWorkspaceSnapshot(snapshot: TargetWorkspaceSnapshot): boolean {
  return (
    snapshot.snapshotId === snapshot.moduleSnapshot.id &&
    snapshot.contentHash === snapshot.moduleSnapshot.contentHash
  );
}

function isArtifactHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function hasCompleteCatalogRef(
  catalog: TargetWorkspaceMigrationSelection['moduleMapping']['sourceCatalog'],
): boolean {
  return (
    catalog.repositoryId.length > 0 &&
    catalog.unifiedRepositoryIrId.length > 0 &&
    catalog.moduleCatalogId.length > 0 &&
    catalog.moduleReviewId.length > 0 &&
    isArtifactHash(catalog.repositoryContentHash) &&
    isArtifactHash(catalog.unifiedRepositoryIrHash) &&
    isArtifactHash(catalog.moduleCatalogHash) &&
    isArtifactHash(catalog.moduleReviewHash)
  );
}

function isCoherentMigrationSelection(
  snapshot: TargetWorkspaceSnapshot,
  selection: TargetWorkspaceMigrationSelection,
  node: TargetWorkspaceTreeNode,
): boolean {
  const lineage = snapshot.moduleSnapshot.lineage;
  const targetLineage = selection.target.lineage;
  const mapping = selection.moduleMapping;
  const mappedTarget = mapping.targetCatalog;
  const mappedRuntimeRoute = mapping.runtimeCapabilitySnapshot.routes.find(
    (route) => route.id === mapping.route.routeId,
  );
  const routeIds = new Set(node.migrationEligibility.routeOptions.map(({ route }) => route.id));
  const routeOption = selection.routeOptions[0]?.route;
  return (
    selection.workspaceId === snapshot.workspaceId &&
    selection.targetWorkspaceSnapshotId === snapshot.snapshotId &&
    selection.targetWorkspaceSnapshotHash === snapshot.contentHash &&
    selection.selection.snapshotId === snapshot.snapshotId &&
    selection.selection.contentHash === snapshot.contentHash &&
    selection.selection.nodeId === node.nodeId &&
    selection.selection.entityId === node.entityId &&
    selection.target.workspaceId === snapshot.workspaceId &&
    selection.target.targetWorkspaceSnapshotId === snapshot.snapshotId &&
    selection.target.targetWorkspaceSnapshotHash === snapshot.contentHash &&
    isArtifactHash(selection.target.contentHash) &&
    selection.target.entity.entityId === node.entityId &&
    selection.target.entity.languageId === node.migrationEligibility.targetLanguageId &&
    selection.target.entity.path === node.path &&
    isArtifactHash(selection.target.entity.fileContentHash) &&
    selection.target.entity.declarationIdentity.providerId.length > 0 &&
    selection.target.entity.declarationIdentity.providerVersion.length > 0 &&
    isArtifactHash(selection.target.entity.declarationIdentity.contentHash) &&
    targetLineage.repositoryId === lineage.repositoryId &&
    targetLineage.repositoryContentHash === lineage.repositoryContentHash &&
    targetLineage.unifiedRepositoryIrId === lineage.unifiedRepositoryIrId &&
    targetLineage.unifiedRepositoryIrHash === lineage.unifiedRepositoryIrHash &&
    targetLineage.moduleCatalogId === lineage.moduleCatalogId &&
    targetLineage.moduleCatalogHash === lineage.moduleCatalogHash &&
    targetLineage.moduleReviewId === lineage.moduleReviewId &&
    targetLineage.moduleReviewHash === lineage.moduleReviewHash &&
    hasCompleteCatalogRef(mapping.sourceCatalog) &&
    hasCompleteCatalogRef(mappedTarget) &&
    mappedTarget.repositoryId === lineage.repositoryId &&
    (mappedTarget.repositoryRevision ?? null) === (lineage.repositoryRevision ?? null) &&
    mappedTarget.repositoryContentHash === lineage.repositoryContentHash &&
    mappedTarget.unifiedRepositoryIrId === lineage.unifiedRepositoryIrId &&
    mappedTarget.unifiedRepositoryIrHash === lineage.unifiedRepositoryIrHash &&
    mappedTarget.moduleCatalogId === lineage.moduleCatalogId &&
    mappedTarget.moduleCatalogHash === lineage.moduleCatalogHash &&
    mappedTarget.moduleReviewId === lineage.moduleReviewId &&
    mappedTarget.moduleReviewHash === lineage.moduleReviewHash &&
    mapping.mappingRunId.length > 0 &&
    mapping.mappingProposalId.length > 0 &&
    isArtifactHash(mapping.mappingProposalHash) &&
    mapping.mappingReviewId.length > 0 &&
    isArtifactHash(mapping.mappingReviewHash) &&
    mapping.executionOverlayId.length > 0 &&
    isArtifactHash(mapping.executionOverlayHash) &&
    mapping.runtimeCapabilitySnapshot.id === mapping.route.runtimeCapabilitySnapshotId &&
    mapping.runtimeCapabilitySnapshot.contentHash === mapping.route.runtimeCapabilitySnapshotHash &&
    isArtifactHash(mapping.runtimeCapabilitySnapshot.contentHash) &&
    mappedRuntimeRoute?.version === mapping.route.routeVersion &&
    mappedRuntimeRoute.contentHash === mapping.route.routeContentHash &&
    mappedRuntimeRoute.validationPolicy.id === mapping.route.validationPolicyId &&
    mappedRuntimeRoute.validationPolicy.contentHash === mapping.route.validationPolicyHash &&
    mapping.groupIds.length > 0 &&
    mapping.mappingIds.length > 0 &&
    mapping.sourceModuleIds.length > 0 &&
    mapping.targetModuleIds.length > 0 &&
    mapping.targetModuleIds.includes(node.moduleId ?? '') &&
    (mapping.targetEntityIds.length === 0 || mapping.targetEntityIds.includes(node.entityId)) &&
    (node.moduleId
      ? selection.module?.moduleId === node.moduleId &&
        selection.module.catalogId === lineage.moduleCatalogId &&
        selection.module.catalogHash === lineage.moduleCatalogHash
      : selection.module === undefined) &&
    selection.routeOptions.length === 1 &&
    routeOption !== undefined &&
    routeIds.has(routeOption.id) &&
    routeOption.id === mapping.route.routeId &&
    routeOption.version === mapping.route.routeVersion &&
    routeOption.sourceLanguageId === mapping.route.sourceLanguageId &&
    routeOption.targetLanguageId === mapping.route.targetLanguageId &&
    routeOption.strategy === mapping.route.strategy &&
    routeOption.contentHash === mapping.route.routeContentHash &&
    JSON.stringify(selection.target.route) === JSON.stringify(mapping.route) &&
    routeOption.targetLanguageId === selection.target.entity.languageId
  );
}

function TargetWorkspaceBrowser({
  snapshot,
  selectedNodeId,
  refreshing,
  invalidation,
  onRefresh,
  onSelect,
  onStartMigration,
}: {
  snapshot: TargetWorkspaceSnapshot;
  selectedNodeId: string | null;
  refreshing: boolean;
  invalidation: TargetWorkspaceInvalidation | null;
  onRefresh: () => void;
  onSelect: (node: TargetWorkspaceTreeNode) => void;
  onStartMigration: (node: TargetWorkspaceTreeNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TargetWorkspaceFilter>('all');
  const [expanded, setExpanded] = useState(() => collectInitiallyExpanded(snapshot.root));

  useEffect(() => {
    setExpanded(collectInitiallyExpanded(snapshot.root));
    setQuery('');
    setFilter('all');
  }, [snapshot.snapshotId, snapshot.contentHash, snapshot.root]);

  const statistics = useMemo(() => targetWorkspaceStatistics(snapshot.root), [snapshot.root]);
  const visibleRoot = useMemo(
    () => filterTargetWorkspaceTree(snapshot.root, query, filter),
    [snapshot.root, query, filter],
  );
  const selectedNode = selectedNodeId
    ? findTargetWorkspaceNode(snapshot.root, selectedNodeId)
    : null;
  const stale = snapshot.freshness !== 'current' || invalidation !== null;

  function toggle(nodeId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function renderTreeNode(node: TargetWorkspaceTreeNode, depth: number) {
    const hasChildren = node.children.length > 0;
    const isExpanded = expanded.has(node.nodeId);
    const state = implementationState(node);
    const summary = callableSummary(node, snapshot);
    return (
      <li key={node.nodeId} className="target-workspace-tree-item">
        <div
          className={`target-workspace-tree-row ${selectedNodeId === node.nodeId ? 'is-selected' : ''}`}
          style={{ paddingInlineStart: 6 + depth * 16 }}
          data-node-id={node.nodeId}
        >
          <button
            type="button"
            className="target-workspace-tree-toggle"
            aria-label={hasChildren ? `${isExpanded ? '收起' : '展开'} ${node.name}` : undefined}
            disabled={!hasChildren}
            onClick={() => toggle(node.nodeId)}
          >
            {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
          </button>
          <button
            type="button"
            className="target-workspace-tree-main"
            onClick={() => onSelect(node)}
            aria-current={selectedNodeId === node.nodeId ? 'true' : undefined}
          >
            <span className={`target-node-glyph is-${node.kind}`}>{nodeGlyph(node)}</span>
            <span className="target-node-name">{node.name}</span>
            {node.aliasOfNodeId ? <span className="target-node-alias">共享</span> : null}
            <span className="target-node-kind">{nodeKindLabel(node)}</span>
            {node.kind !== 'callable' && summary.total > 0 ? (
              <span className="target-node-rollup">{summary.implemented}/{summary.total}</span>
            ) : null}
            <span className={`implementation-pill is-${state}`}>{implementationStateLabels[state]}</span>
          </button>
        </div>
        {hasChildren && isExpanded ? (
          <ul>{node.children.map((child) => renderTreeNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <div className="target-workspace-browser">
      <section className="target-workspace-toolbar" aria-label="目标工作区筛选">
        <label className="target-workspace-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块、文件、容器或可调用实体"
            aria-label="搜索目标工作区"
          />
        </label>
        <button
          type="button"
          className="secondary-action target-refresh-action"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? 'is-spinning' : ''} />
          {refreshing ? '刷新中…' : '刷新快照'}
        </button>
      </section>

      {stale ? (
        <div className="target-workspace-stale" role="alert">
          <strong>目标工作区快照已失效</strong>
          <span>{invalidation?.reason ?? snapshot.staleReason ?? '工作区内容已变化，请刷新后重新选择。'}</span>
        </div>
      ) : null}

      <section className="target-workspace-statistics" aria-label="目标工作区统计">
        {[
          ['模块', statistics.modules],
          ['文件', statistics.files],
          ['类型', statistics.types],
          ['可调用实体', statistics.callables],
          ['可迁移目标', statistics.eligibleCallables],
        ].map(([label, value]) => (
          <div className="target-stat-card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <section className="target-workspace-state-filters" aria-label="实现状态筛选">
        <button
          type="button"
          className={filter === 'all' ? 'is-active' : ''}
          onClick={() => setFilter('all')}
        >
          全部 <strong>{statistics.callables}</strong>
        </button>
        {implementationStates.map((state) => (
          <button
            type="button"
            className={`${filter === state ? 'is-active' : ''} is-${state}`}
            onClick={() => setFilter(state)}
            key={state}
          >
            {implementationStateLabels[state]} <strong>{statistics.byState[state]}</strong>
          </button>
        ))}
      </section>

      {snapshot.runtimeCapabilitySnapshot ? (
        <section className="target-workspace-capabilities" aria-label="运行时迁移能力">
          <h3>运行时迁移能力</h3>
          <ul className="target-reason-list">
            {snapshot.runtimeCapabilitySnapshot.routes.map((route) => (
              <li key={route.id}>
                <code>{route.sourceLanguageId} → {route.targetLanguageId}</code>
                <span>{route.strategy} · {route.availability.status}</span>
                <small>
                  {route.availability.reasonCodes.length > 0
                    ? route.availability.reasonCodes.join('、')
                    : '全部必需阶段可用'}
                </small>
              </li>
            ))}
          </ul>
          {snapshot.runtimeCapabilitySnapshot.routes.length === 0 ? (
            <p className="muted-copy">适配服务未提供可验证的精确语言路线；执行保持关闭。</p>
          ) : null}
        </section>
      ) : null}

      <div className="target-workspace-content">
        <section className="target-workspace-tree-panel" aria-label="目标工作区模块树">
          <div className="target-workspace-panel-heading">
            <div>
              <strong>{snapshot.workspaceName}</strong>
              <span>{snapshot.languageIds.join(' · ') || '语言未知'}</span>
            </div>
            <code title={snapshot.contentHash}>{snapshot.snapshotId}</code>
          </div>
          {visibleRoot ? (
            <ul className="target-workspace-tree">{renderTreeNode(visibleRoot, 0)}</ul>
          ) : (
            <div className="target-workspace-empty">没有符合当前搜索和状态筛选的节点。</div>
          )}
        </section>

        <aside className="target-workspace-detail" aria-label="目标对象详情">
          {selectedNode ? (
            <>
              <div className="target-detail-heading">
                <span className={`target-node-glyph is-${selectedNode.kind}`}>
                  {nodeGlyph(selectedNode)}
                </span>
                <div>
                  <strong>{selectedNode.name}</strong>
                  <span>{nodeKindLabel(selectedNode)} · {implementationStateLabels[implementationState(selectedNode)]}</span>
                </div>
              </div>
              <dl className="target-detail-fields">
                {selectedNode.moduleId ? <div><dt>所属模块</dt><dd>{selectedNode.moduleId}</dd></div> : null}
                {selectedNode.qualifiedName ? <div><dt>限定名称</dt><dd>{selectedNode.qualifiedName}</dd></div> : null}
                {selectedNode.path ? <div><dt>文件</dt><dd>{selectedNode.path}</dd></div> : null}
                {selectedNode.languageId ? <div><dt>语言</dt><dd>{selectedNode.languageId}</dd></div> : null}
                {selectedNode.range ? <div><dt>位置</dt><dd>第 {selectedNode.range.startLine} 行</dd></div> : null}
              </dl>
              {selectedNode.signature ? <code className="target-detail-signature">{selectedNode.signature}</code> : null}
              <section className="target-detail-evidence">
                <h3>实现状态依据</h3>
                {selectedNode.assessment ? (
                  <>
                    <p>{selectedNode.assessment.basis}</p>
                    {selectedNode.assessment.reasonCodes.length > 0 ? (
                      <ul className="target-reason-list">
                        {selectedNode.assessment.reasonCodes.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    ) : null}
                    {selectedNode.assessment.evidenceRefs.length > 0 ? (
                      <ul className="target-evidence-list">
                        {selectedNode.assessment.evidenceRefs.map((evidence) => (
                          <li key={evidence.id}>
                            <code>{evidence.kind}</code>
                            <span>{evidence.summary ?? evidence.id}</span>
                            {evidence.path ? <small>{evidence.path}</small> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="muted-copy">没有可展示的证据引用。</p>}
                  </>
                ) : (
                  <p className="muted-copy">该聚合节点没有独立实现判定；状态来自子可调用实体汇总。</p>
                )}
              </section>
              {selectedNode.kind === 'callable' ? (
                <section className="target-detail-evidence">
                  <h3>迁移路线与能力</h3>
                  {selectedNode.migrationEligibility.routeOptions.length > 0 ? (
                    <ul className="target-reason-list">
                      {selectedNode.migrationEligibility.routeOptions.map(({ route, warnings }) => (
                        <li key={route.id}>
                          <code>{route.sourceLanguageId} → {route.targetLanguageId}</code>
                          <span>{route.strategy} · {route.id}@{route.version}</span>
                          <small>
                            {route.availability.status}
                            {warnings.length > 0 ? ` · ${warnings.join('、')}` : ''}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      <p className="muted-copy">
                        {selectedNode.migrationEligibility.summary ?? '未声明可执行迁移路线。'}
                      </p>
                      {selectedNode.migrationEligibility.reasonCodes.length > 0 ? (
                        <ul className="target-reason-list">
                          {selectedNode.migrationEligibility.reasonCodes.map((reason) => (
                            <li key={reason}><code>{reason}</code></li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}
              <button
                type="button"
                className="primary-action target-start-action"
                disabled={
                  stale ||
                  refreshing ||
                  selectedNode.kind !== 'callable' ||
                  selectedNode.migrationEligibility.status !== 'eligible'
                }
                onClick={() => onStartMigration(selectedNode)}
              >
                开始迁移
              </button>
              {selectedNode.migrationEligibility.status === 'blocked' && selectedNode.migrationEligibility.summary ? (
                <p className="target-ineligible-reason">{selectedNode.migrationEligibility.summary}</p>
              ) : null}
            </>
          ) : (
            <div className="target-workspace-empty">选择一个节点查看状态依据；只有实现证据与迁移路线均可用的目标才可启动。</div>
          )}
          <p className="target-status-disclaimer">
            “检测到实现”只代表静态证据中存在实现体，不证明业务行为、并发或错误语义正确。
          </p>
        </aside>
      </div>

      {snapshot.diagnostics.length > 0 ? (
        <details className="target-workspace-diagnostics">
          <summary>分析诊断 {snapshot.diagnostics.length}</summary>
          <ul>{snapshot.diagnostics.map((diagnostic) => (
            <li className={`is-${diagnostic.severity}`} key={diagnostic.id}>{diagnostic.message}</li>
          ))}</ul>
        </details>
      ) : null}
    </div>
  );
}

export default function App() {
  const bus: MessageBus = useMemo(() => createMessageBus(), []);
  const [state, dispatch] = useReducer(workflowReducerV2, initialWorkflowStateV2);
  const [payload, setPayload] = useState<PanelInitPayload | null>(null);
  const [repositoryStatuses, setRepositoryStatuses] = useState<RepositoryStatus[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetWorkspace, setTargetWorkspace] = useState<TargetWorkspaceSnapshot | null>(null);
  const [targetWorkspaceRefreshing, setTargetWorkspaceRefreshing] = useState(false);
  const [targetWorkspaceInvalidation, setTargetWorkspaceInvalidation] =
    useState<TargetWorkspaceInvalidation | null>(null);
  const [selectedTargetNodeId, setSelectedTargetNodeId] = useState<string | null>(null);
  const [migrationSelection, setMigrationSelection] =
    useState<TargetWorkspaceMigrationSelection | null>(null);
  const pendingRef = useRef<WorkflowStateV2['pending']>(null);
  const targetWorkspaceRef = useRef<TargetWorkspaceSnapshot | null>(null);
  const invalidationRef = useRef<TargetWorkspaceInvalidation | null>(null);
  const refreshingRef = useRef(false);
  pendingRef.current = state.pending;
  targetWorkspaceRef.current = targetWorkspace;
  invalidationRef.current = targetWorkspaceInvalidation;
  refreshingRef.current = targetWorkspaceRefreshing;

  useEffect(() => {
    bus.post({ type: 'READY' });
    return bus.subscribe((message) => {
      switch (message.type) {
        case 'INIT': {
          const initialTargetWorkspace = message.payload.targetWorkspace ?? null;
          const acceptedTargetWorkspace = initialTargetWorkspace &&
            isCoherentTargetWorkspaceSnapshot(initialTargetWorkspace)
            ? initialTargetWorkspace
            : null;
          setPayload(message.payload);
          setRepositoryStatuses(message.payload.repositoryStatuses);
          setServiceStatus(message.payload.serviceStatus);
          setError(
            initialTargetWorkspace && !acceptedTargetWorkspace
              ? '宿主提供的目标工作区快照标识与规范制品不一致，已拒绝载入。'
              : null,
          );
          setTargetWorkspace(acceptedTargetWorkspace);
          setTargetWorkspaceRefreshing(false);
          setTargetWorkspaceInvalidation(null);
          setSelectedTargetNodeId(null);
          setMigrationSelection(message.payload.migrationSelection ?? null);
          targetWorkspaceRef.current = acceptedTargetWorkspace;
          refreshingRef.current = false;
          invalidationRef.current = null;
          if (message.payload.target) {
            dispatch({ type: 'SELECT_TARGET', target: message.payload.target });
          } else {
            dispatch({ type: 'RESET' });
          }
          break;
        }
        case 'TARGET_WORKSPACE_SNAPSHOT': {
          if (!isCoherentTargetWorkspaceSnapshot(message.snapshot)) {
            setTargetWorkspaceRefreshing(false);
            refreshingRef.current = false;
            setError('宿主提供的目标工作区快照标识与规范制品不一致，已拒绝载入。');
            break;
          }
          setTargetWorkspace(message.snapshot);
          setTargetWorkspaceRefreshing(false);
          setTargetWorkspaceInvalidation(null);
          setSelectedTargetNodeId(null);
          setMigrationSelection(null);
          setError(null);
          targetWorkspaceRef.current = message.snapshot;
          refreshingRef.current = false;
          invalidationRef.current = null;
          dispatch({ type: 'RESET' });
          break;
        }
        case 'TARGET_WORKSPACE_REFRESHING': {
          const current = targetWorkspaceRef.current;
          if (
            (message.previousSnapshotId && current?.snapshotId !== message.previousSnapshotId) ||
            (message.previousContentHash && current?.contentHash !== message.previousContentHash)
          ) {
            break;
          }
          setTargetWorkspaceRefreshing(true);
          refreshingRef.current = true;
          setError(null);
          break;
        }
        case 'TARGET_WORKSPACE_INVALIDATED': {
          const current = targetWorkspaceRef.current;
          if (
            current &&
            current.snapshotId === message.invalidation.snapshotId &&
            current.contentHash === message.invalidation.contentHash
          ) {
            const staleSnapshot: TargetWorkspaceSnapshot = {
              ...current,
              freshness: 'stale',
              staleReason: message.invalidation.reason,
            };
            setTargetWorkspaceInvalidation(message.invalidation);
            setTargetWorkspace(staleSnapshot);
            setMigrationSelection(null);
            invalidationRef.current = message.invalidation;
            targetWorkspaceRef.current = staleSnapshot;
          }
          break;
        }
        case 'TARGET_ENTITY_SELECTED': {
          const current = targetWorkspaceRef.current;
          const selected = current
            ? findTargetWorkspaceNode(current.root, message.selection.nodeId)
            : null;
          if (
            !current ||
            invalidationRef.current ||
            refreshingRef.current ||
            current.freshness !== 'current' ||
            current.snapshotId !== message.selection.snapshotId ||
            current.contentHash !== message.selection.contentHash ||
            !selected ||
            selected.entityId !== message.selection.entityId ||
            selected.kind !== 'callable' ||
            selected.migrationEligibility.status !== 'eligible' ||
            !isCoherentMigrationSelection(current, message.migrationSelection, selected)
          ) {
            setError('宿主返回的目标选择不属于当前有效快照，请刷新后重试。');
            break;
          }
          setSelectedTargetNodeId(selected.nodeId);
          setMigrationSelection(message.migrationSelection);
          setError(null);
          if (message.activateWorkflow) {
            dispatch({ type: 'SELECT_TARGET', target: message.target });
          }
          break;
        }
        case 'SEARCH_RESULT':
          dispatch({ type: 'SEARCH_SUCCESS', candidates: message.candidates });
          break;
        case 'CANDIDATE_SELECTED':
          dispatch({
            type: 'CANDIDATE_RESOLVE_SUCCESS',
            candidateId: message.candidateId,
            sourceBundle: message.sourceBundle,
          });
          break;
        case 'ADAPT_RESULT':
          dispatch({ type: 'ADAPT_SUCCESS', result: message.result });
          break;
        case 'APPLY_RESULT':
          dispatch({ type: 'APPLY_SUCCESS', result: message.result, manifest: message.manifest });
          break;
        case 'REPOSITORY_STATUS':
          setRepositoryStatuses(message.statuses);
          break;
        case 'SERVICE_STATUS':
          setServiceStatus(message.status);
          break;
        case 'ERROR': {
          setError(message.message);
          setTargetWorkspaceRefreshing(false);
          refreshingRef.current = false;
          const event = errorEvent(pendingRef.current, message.message);
          if (event) dispatch(event);
          break;
        }
      }
    });
  }, [bus]);

  function handleSearch(): void {
    if (!state.target) return;
    if ((targetWorkspace && targetWorkspace.freshness !== 'current') || targetWorkspaceInvalidation) {
      setError('目标工作区快照已失效，请刷新并重新选择目标实体。');
      return;
    }
    setError(null);
    dispatch({ type: 'SEARCH_START' });
    bus.post({
      type: 'START_SEARCH',
      requirement: state.requirement.trim(),
      topK: state.topK,
    });
  }

  function handleAdapt(): void {
    const candidate = selectedCandidateV2(state);
    if (!state.target || !candidate) return;
    if ((targetWorkspace && targetWorkspace.freshness !== 'current') || targetWorkspaceInvalidation) {
      setError('目标工作区快照已失效，请刷新并重新选择目标实体。');
      return;
    }
    const routeOption = routeForCandidate(
      migrationSelection,
      candidate.candidate.entity.languageId,
    );
    if (!routeOption) {
      setError(
        `未声明 ${candidate.candidate.entity.languageId} → ${migrationSelection?.target.entity.languageId ?? state.target.entity.languageId} ` +
        '的可执行迁移路线，已按 fail-closed 阻止。',
      );
      return;
    }
    setError(null);
    dispatch({ type: 'ADAPT_START' });
    bus.post({
      type: 'START_ADAPT',
      decisionNotes: state.decisionNotes,
    });
  }

  function handleApply(): void {
    if (!state.adaptation) return;
    if ((targetWorkspace && targetWorkspace.freshness !== 'current') || targetWorkspaceInvalidation) {
      setError('目标工作区快照已失效，禁止基于旧快照应用补丁。');
      return;
    }
    setError(null);
    dispatch({ type: 'APPLY_START' });
    bus.post({ type: 'APPLY_CURRENT_RUN' });
  }

  function handleCheckRepositories(): void {
    setError(null);
    bus.post({ type: 'CHECK_REPOSITORIES' });
  }

  function handleSelectCandidate(candidateId: string): void {
    dispatch({ type: 'CANDIDATE_RESOLVE_START', candidateId });
    bus.post({ type: 'SELECT_CANDIDATE', candidateId });
  }

  function handleOpenTarget(): void {
    bus.post({ type: 'OPEN_TARGET' });
  }

  function handleRefreshTargetWorkspace(): void {
    setError(null);
    setTargetWorkspaceRefreshing(true);
    refreshingRef.current = true;
    if (!targetWorkspace) {
      bus.post({ type: 'REFRESH_TARGET_WORKSPACE' });
      return;
    }
    bus.post({
      type: 'REFRESH_TARGET_WORKSPACE',
      expectedSnapshotId: targetWorkspace.snapshotId,
      expectedContentHash: targetWorkspace.contentHash,
    });
  }

  function handleSelectTargetWorkspaceNode(node: TargetWorkspaceTreeNode): void {
    setSelectedTargetNodeId(node.nodeId);
    setError(null);
    if (
      !targetWorkspace ||
      targetWorkspaceRefreshing ||
      targetWorkspace.freshness !== 'current' ||
      targetWorkspaceInvalidation ||
      node.kind !== 'callable' ||
      node.migrationEligibility.status !== 'eligible'
    ) {
      return;
    }
    bus.post({ type: 'SELECT_TARGET_ENTITY', ...selectionIdentity(targetWorkspace, node) });
  }

  function handleStartTargetMigration(node: TargetWorkspaceTreeNode): void {
    if (
      !targetWorkspace ||
      targetWorkspaceRefreshing ||
      targetWorkspace.freshness !== 'current' ||
      targetWorkspaceInvalidation ||
      node.kind !== 'callable' ||
      node.migrationEligibility.status !== 'eligible'
    ) {
      setError('只有当前有效快照中、已声明完整路线能力的可调用实体才能开始迁移。');
      return;
    }
    bus.post({ type: 'START_TARGET_TRANSLATION', ...selectionIdentity(targetWorkspace, node) });
  }

  if (!payload) {
    return (
      <div className="app">
        <div className="loading-state">正在初始化 ForeXplore 迁移面板…</div>
      </div>
    );
  }

  const candidate = selectedCandidateV2(state);
  const targetWorkspaceStage = state.stage === 'target';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-glyph">FX</span>
          <strong>ForeXplore</strong>
        </div>
        {targetWorkspaceStage ? (
          <div className="target-workspace-title">
            <strong>01B 目标工作区模块划分</strong>
            <span>识别模块、文件、容器与可调用实体的可追溯实现状态</span>
          </div>
        ) : <StepRail stage={state.stage} />}
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <main className={`stage-body ${targetWorkspaceStage ? 'is-target-workspace' : ''}`}>
        {targetWorkspaceStage && targetWorkspace ? (
          <TargetWorkspaceBrowser
            snapshot={targetWorkspace}
            selectedNodeId={selectedTargetNodeId}
            refreshing={targetWorkspaceRefreshing}
            invalidation={targetWorkspaceInvalidation}
            onRefresh={handleRefreshTargetWorkspace}
            onSelect={handleSelectTargetWorkspaceNode}
            onStartMigration={handleStartTargetMigration}
          />
        ) : null}

        {targetWorkspaceStage && !targetWorkspace ? (
          <div className="target-workspace-waiting">
            <strong>等待目标工作区快照</strong>
            <p>宿主尚未提供经过模块边界审阅的目标快照。刷新不会把目标工程发布到 SeekDB。</p>
            <button
              type="button"
              className="secondary-action"
              disabled={targetWorkspaceRefreshing}
              onClick={handleRefreshTargetWorkspace}
            >
              <RefreshCw size={14} className={targetWorkspaceRefreshing ? 'is-spinning' : ''} />
              {targetWorkspaceRefreshing ? '刷新中…' : '刷新目标工作区'}
            </button>
          </div>
        ) : null}

        {state.stage === 'requirement' && state.target ? (
          <RequirementStage
            state={state}
            target={state.target}
            dispatch={dispatch}
            repositoryStatuses={repositoryStatuses}
            onSearch={handleSearch}
            onCheckRepositories={handleCheckRepositories}
          />
        ) : null}

        {state.stage === 'candidates' ? (
          <CandidatesStage
            state={state}
            dispatch={dispatch}
            adaptationProvider={payload.adaptationProvider}
            migrationSelection={migrationSelection}
            onSelectCandidate={handleSelectCandidate}
            onAdapt={handleAdapt}
          />
        ) : null}

        {state.stage === 'adaptation' ? (
          <AdaptationStage
            state={state}
            candidate={candidate}
            routeOption={routeForCandidate(
              migrationSelection,
              candidate?.candidate.entity.languageId,
            )}
          />
        ) : null}

        {(state.stage === 'patch' || state.stage === 'complete') && state.adaptation ? (
          <PatchStage
            state={state}
            onApply={handleApply}
            onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
            onOpenTarget={handleOpenTarget}
          />
        ) : null}
      </main>

      <FooterStatus
        serviceStatus={serviceStatus}
        repositoryStatuses={repositoryStatuses}
        workspaceRoot={payload.workspaceRoot}
      />
    </div>
  );
}
