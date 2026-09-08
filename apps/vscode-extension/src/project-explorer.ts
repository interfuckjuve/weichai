import { indexModuleHierarchy, type ModuleTarget, type ProjectModule } from '@forexplore/contracts';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { folderTree, workspacePresentationFromStructuralIndex, type ModuleExplorerBuildResult } from './module-explorer';
import type { ModuleChildrenPage, ModuleChildrenRequest, ModuleExplorerNode, ModuleWorkspacePresentation } from './ui-types';
import { projectAnalysisDetailLimit as detailLimit, projectAnalysisPresentation } from './project-analysis-presentation';

export type ExplorerChildrenIndex = Map<string, Map<string, ModuleExplorerNode[]>>;
export interface ProjectExplorerBuildResult extends ModuleExplorerBuildResult {
  childrenByNodeId: ExplorerChildrenIndex;
}
const childrenPageSize = 80;

/** The live product tree consumes only the registered index and durable module artifacts. */
export async function buildProjectExplorer(host: Pick<CodeIntelligenceHost, 'explorerData'>, currentTarget?: ModuleTarget): Promise<ProjectExplorerBuildResult> {
  const data = await host.explorerData();
  const targets = new Map<string, ModuleTarget>();
  const childrenByNodeId: ExplorerChildrenIndex = new Map();
  let target: ModuleWorkspacePresentation = {
    id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '',
    tree: [], stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' },
  };
  const history: ModuleWorkspacePresentation[] = [];
  for (const entry of data) {
    const { index, projectId, repository, analysis } = entry;
    const project = index.projects.find((p) => p.projectId === projectId)!;
    const files = index.files.filter((file) => file.projectId === projectId);
    const paths = new Set(files.map((file) => file.relativePath));
    const scoped = {
      ...index, projects: [project], files,
      symbols: index.symbols.filter((symbol) => paths.has(symbol.relativePath)),
      dependencyEdges: index.dependencyEdges.filter((edge) => paths.has(edge.sourceRelativePath)),
      diagnostics: index.diagnostics.filter((diagnostic) => !diagnostic.relativePath || paths.has(diagnostic.relativePath)),
    };
    const mode = entry.selectedTarget ? 'target' : 'history';
    const result = workspacePresentationFromStructuralIndex({
      index: scoped, mode, name: `${repository.displayName} / ${project.displayName}`,
      rootLabel: project.relativePath || '.', presentationId: repository.repositoryId,
      ...(currentTarget && currentTarget.kind !== 'module' && paths.has(currentTarget.path) && mode === 'target' ? { currentTarget } : {}),
    });
    const workspace = result.presentation;
    const historical = index.analysisRevision !== repository.activeRevision;
    if (historical) {
      const makeReadOnly = (nodes: ModuleExplorerNode[]) => nodes.forEach((node) => {
        delete node.targetId;
        makeReadOnly(node.children);
      });
      makeReadOnly(workspace.tree);
      result.targets.clear();
    }
    workspace.repositoryId = repository.repositoryId;
    workspace.projectId = projectId;
    if (analysis) workspace.analysis = projectAnalysisPresentation(analysis);
    workspace.dependencies = scoped.dependencyEdges.slice(0, detailLimit);
    workspace.diagnostics = scoped.diagnostics.slice(0, detailLimit);
    workspace.detailCounts = { dependencies: scoped.dependencyEdges.length, diagnostics: scoped.diagnostics.length,
      unassigned: analysis?.coverage?.unassigned.length ?? 0 };
    if (analysis?.proposal) {
      const byPath = new Map<string, ModuleExplorerNode>();
      const visit = (nodes: ModuleExplorerNode[]) => nodes.forEach((node) => {
        if (node.kind === 'file' && node.path) byPath.set(node.path, node);
        visit(node.children);
      });
      visit(workspace.tree);
      const targetByPath = new Map<string, ModuleTarget>();
      for (const item of result.targets.values()) if (!targetByPath.has(item.path)) targetByPath.set(item.path, item);
      const hierarchy = indexModuleHierarchy(analysis.proposal.modules);
      const moduleNode = (module: ProjectModule): ModuleExplorerNode => {
        const sourceFiles = hierarchy.sourceFiles(module.id).files;
        const representativePath = sourceFiles.find((file) => targetByPath.has(file));
        const representative = representativePath ? targetByPath.get(representativePath) : undefined;
        const targetId = mode === 'target' && !historical && analysis.state === 'ready' && representative
          ? `module://${encodeURIComponent(JSON.stringify([repository.repositoryId, index.analysisRevision, projectId, module.id]))}` : undefined;
        if (targetId && representative) result.targets.set(targetId, {
          id: targetId, name: module.name, kind: 'module', path: representative.path, language: representative.language,
          signature: (module.coreApis ?? []).join('\n'), documentation: module.purpose ?? module.description,
          module: { repositoryId: repository.repositoryId, analysisRevision: index.analysisRevision, projectId,
            sourceFiles, coreApis: module.coreApis ?? [], dependsOn: [...module.dependsOn] },
        });
        return {
          id: `module:${module.id}`, kind: 'module', name: module.name,
          description: module.description, purpose: module.purpose, coreApis: module.coreApis,
          domain: module.domain, language: module.language,
          moduleId: module.id, parentId: module.parentId ?? null, nodeKind: module.nodeKind ?? 'module',
          depth: hierarchy.depthById.get(module.id), refinement: module.refinement,
          ...(targetId ? { targetId } : {}),
          children: hierarchy.childrenById.get(module.id)!.length
            ? hierarchy.childrenById.get(module.id)!.map(moduleNode)
            : folderTree(module.sourceFiles.flatMap((path) => byPath.get(path) ? [byPath.get(path)!] : []), module.id),
        };
      };
      workspace.tree = hierarchy.roots.map(moduleNode);
      const assigned = new Set(analysis.proposal.modules.flatMap((module) => module.sourceFiles));
      const unassigned = [...byPath].filter(([path]) => !assigned.has(path)).map(([, node]) => node);
      if (unassigned.length) workspace.tree.push({ id: 'unassigned', kind: 'folder', name: '未归属文件', children: folderTree(unassigned, '$unassigned') });
      workspace.stats.modules = analysis.proposal.modules.length;
    } else {
      workspace.tree = workspace.tree.map((node) => ({ ...node, kind: 'folder', name: `${node.name}（文件视图）` }));
      workspace.stats.modules = 0;
    }
    const childIndex = new Map<string, ModuleExplorerNode[]>();
    const roots = indexChildren(workspace.tree, childIndex);
    childIndex.set('$root', roots);
    workspace.rootTotal = roots.length;
    workspace.tree = roots.slice(0, childrenPageSize);
    childrenByNodeId.set(scopeKey({ repositoryId: repository.repositoryId, analysisRevision: index.analysisRevision, projectId }), childIndex);
    if (entry.selectedTarget) {
      target = workspace;
      for (const [key, value] of result.targets) targets.set(key, value);
    } else if (repository.role === 'history') history.push(workspace);
  }
  return { presentation: { generatedAt: new Date().toISOString(), target, history }, targets, childrenByNodeId };
}

function scopeKey(scope: Pick<ModuleChildrenRequest, 'repositoryId' | 'analysisRevision' | 'projectId'>): string {
  return JSON.stringify([scope.repositoryId, scope.analysisRevision, scope.projectId]);
}

/** Only the current authorized presentation index can supply children; requests never access disk. */
export function readExplorerChildren(index: ExplorerChildrenIndex, request: ModuleChildrenRequest): ModuleChildrenPage {
  if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error('Invalid module page offset.');
  const nodesById = index.get(scopeKey(request));
  if (!nodesById) throw new Error('Module snapshot is no longer visible. Refresh the project.');
  let nodes: ModuleExplorerNode[];
  if (request.nodeId === '$search') {
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const status = request.status ?? 'all';
    const matched = new Map<string, ModuleExplorerNode>();
    for (const children of nodesById.values()) for (const node of children) {
      if (matched.has(node.id)) continue;
      const queryMatch = !query || [node.name, node.path, node.signature].some((value) => value?.toLocaleLowerCase().includes(query));
      const effectiveStatus = node.implementationStatus ?? ((node.childrenTotal ?? node.children.length) === 0 ? 'unknown' : undefined);
      if (queryMatch && (status === 'all' || status === effectiveStatus)) matched.set(node.id, node);
    }
    nodes = [...matched.values()];
  } else {
    const children = nodesById.get(request.nodeId);
    if (!children) throw new Error('Module node is no longer available. Refresh the project.');
    nodes = children;
  }
  return { nodes: nodes.slice(request.offset, request.offset + childrenPageSize), total: nodes.length };
}

function indexChildren(nodes: ModuleExplorerNode[], index: Map<string, ModuleExplorerNode[]>): ModuleExplorerNode[] {
  return nodes.map((node) => {
    const children = index.get(node.id) ?? indexChildren(node.children, index);
    if (children.length) index.set(node.id, children);
    const contents = node.contents ?? children.reduce((summary, child) => {
      if (child.contents) {
        summary.files += child.contents.files;
        summary.types += child.contents.types;
        summary.methods += child.contents.methods;
        summary.languages = [...new Set([...summary.languages, ...child.contents.languages])];
      }
      return summary;
    }, { files: node.kind === 'file' ? 1 : 0,
      types: ['class', 'interface', 'record', 'struct', 'enum'].includes(node.kind) ? 1 : 0,
      methods: ['method', 'constructor', 'function'].includes(node.kind) ? 1 : 0,
      languages: node.language ? [node.language] : [] as string[] });
    return { ...node, contents,
      childrenTotal: children.length, children: [] };
  });
}
