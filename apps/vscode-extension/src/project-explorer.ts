import type { ModuleTarget } from '@forexplore/contracts';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { workspacePresentationFromStructuralIndex, type ModuleExplorerBuildResult } from './module-explorer';
import type { ModuleExplorerNode, ModuleWorkspacePresentation } from './ui-types';

/** The live product tree consumes only the registered index and durable module artifacts. */
export async function buildProjectExplorer(host: CodeIntelligenceHost, currentTarget?: ModuleTarget): Promise<ModuleExplorerBuildResult> {
  const data = await host.explorerData();
  const targets = new Map<string, ModuleTarget>();
  let target: ModuleWorkspacePresentation = {
    id: 'target:unselected', mode: 'target', name: '选择目标项目', rootLabel: '',
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
      ...(currentTarget && paths.has(currentTarget.path) && mode === 'target' ? { currentTarget } : {}),
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
    workspace.analysis = analysis;
    workspace.dependencies = scoped.dependencyEdges;
    workspace.diagnostics = scoped.diagnostics;
    if (analysis?.proposal) {
      const byPath = new Map<string, ModuleExplorerNode>();
      const visit = (nodes: ModuleExplorerNode[]) => nodes.forEach((node) => {
        if (node.kind === 'file' && node.path) byPath.set(node.path, node);
        visit(node.children);
      });
      visit(workspace.tree);
      workspace.tree = analysis.proposal.modules.map((module) => ({
        id: `module:${module.id}`, kind: 'module', name: module.name,
        description: module.description, purpose: module.purpose, coreApis: module.coreApis,
        domain: module.domain, language: module.language,
        children: module.sourceFiles.flatMap((path) => byPath.get(path) ? [byPath.get(path)!] : []),
      }));
      const assigned = new Set(analysis.proposal.modules.flatMap((module) => module.sourceFiles));
      const unassigned = [...byPath].filter(([path]) => !assigned.has(path)).map(([, node]) => node);
      if (unassigned.length) workspace.tree.push({ id: 'unassigned', kind: 'folder', name: '未归属文件', children: unassigned });
      workspace.stats.modules = analysis.proposal.modules.length;
    } else {
      workspace.tree = workspace.tree.map((node) => ({ ...node, kind: 'folder', name: `${node.name}（文件视图）` }));
      workspace.stats.modules = 0;
    }
    if (entry.selectedTarget) {
      target = workspace;
      for (const [key, value] of result.targets) targets.set(key, value);
    } else if (repository.role === 'history') history.push(workspace);
  }
  return { presentation: { generatedAt: new Date().toISOString(), target, history }, targets };
}
