import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  IndexedFileRecord, ProjectAnalysisScope, ProjectModule, ProjectModuleProposal, StructuralIndex,
} from '@forexplore/contracts';

export const moduleModelingAlgorithm = 'directory-dependency/v1';
export const defaultModuleFileLimit = 64;

interface Group {
  key: string;
  directory: string;
  role: string;
  files: IndexedFileRecord[];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function category(file: IndexedFileRecord): string {
  return file.role === 'test' ? 'test' : file.role === 'configuration' ? 'configuration' : 'source';
}

/** Directory boundaries establish ownership; resolved dependency affinity merges small sibling groups. */
export function buildProjectModuleProposal(
  index: StructuralIndex,
  scope: ProjectAnalysisScope,
  objective: string,
  maxFilesPerModule = defaultModuleFileLimit,
): ProjectModuleProposal {
  if (!Number.isInteger(maxFilesPerModule) || maxFilesPerModule < 2 || maxFilesPerModule > 512) {
    throw new Error('Module file limit must be an integer between 2 and 512.');
  }
  const project = index.projects.find((value) => value.projectId === scope.projectId);
  if (!project) throw new Error('Project is not part of the indexed revision.');
  const files = index.files.filter((file) => file.projectId === scope.projectId)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const groups = new Map<string, Group>();
  const owner = new Map<string, string>();
  for (const file of files) {
    const directory = path.posix.dirname(file.relativePath);
    const role = category(file);
    const base = `${directory}\u0000${role}`;
    const previous = groups.get(base);
    const page = Math.floor((previous?.files.length ?? 0) / maxFilesPerModule);
    // The directory counter is separate from individual pages to keep a flat directory bounded.
    if (!previous) groups.set(base, { key: base, directory, role, files: [] });
    const counter = groups.get(base)!;
    counter.files.push(file);
    const key = `${base}\u0000${page}`;
    const group = groups.get(key) ?? { key, directory, role, files: [] };
    group.files.push(file);
    groups.set(key, group);
    owner.set(file.relativePath, key);
  }
  for (const [key] of groups) if (key.split('\u0000').length === 2) groups.delete(key);

  const affinity = new Map<string, Map<string, number>>();
  for (const edge of index.dependencyEdges) {
    if (!edge.internal || edge.resolution !== 'resolved' || !edge.targetRelativePath) continue;
    const left = owner.get(edge.sourceRelativePath);
    const right = owner.get(edge.targetRelativePath);
    if (!left || !right || left === right) continue;
    for (const [from, to] of [[left, right], [right, left]] as const) {
      const neighbors = affinity.get(from) ?? new Map<string, number>();
      neighbors.set(to, (neighbors.get(to) ?? 0) + 1);
      affinity.set(from, neighbors);
    }
  }
  const redirects = new Map<string, string>();
  const resolve = (key: string): string => {
    const visited: string[] = [];
    while (redirects.has(key)) { visited.push(key); key = redirects.get(key)!; }
    for (const value of visited) redirects.set(value, key);
    return key;
  };
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (!group || group.files.length >= Math.min(8, maxFilesPerModule)) continue;
    const candidates = [...(affinity.get(key) ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [neighbor] of candidates) {
      const targetKey = resolve(neighbor);
      const target = groups.get(targetKey);
      if (!target || target === group || target.role !== group.role ||
          path.posix.dirname(target.directory) !== path.posix.dirname(group.directory) ||
          target.files.length + group.files.length > maxFilesPerModule) continue;
      target.files.push(...group.files);
      groups.delete(key);
      redirects.set(key, targetKey);
      for (const file of group.files) owner.set(file.relativePath, targetKey);
      break;
    }
  }

  const symbolsByPath = new Map<string, StructuralIndex['symbols']>();
  for (const symbol of index.symbols) {
    if (!owner.has(symbol.relativePath)) continue;
    const values = symbolsByPath.get(symbol.relativePath) ?? [];
    values.push(symbol);
    symbolsByPath.set(symbol.relativePath, values);
  }
  const moduleByGroup = new Map<string, ProjectModule>();
  const suffix: Record<string, string> = { test: 'Tests', configuration: 'Configuration', source: 'Implementation' };
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    group.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const symbols = group.files.flatMap((file) => symbolsByPath.get(file.relativePath) ?? []);
    const coreApis = [...new Set(symbols.filter((symbol) => symbol.exported || !symbol.containerSymbolKey)
      .map((symbol) => symbol.signature || symbol.qualifiedName || symbol.name))].slice(0, 24);
    const relative = path.posix.relative(project.relativePath || '.', group.directory) || project.displayName;
    const name = `${relative} / ${suffix[group.role]}${group.key.endsWith('\u00000') ? '' : ` ${Number(group.key.split('\u0000').at(-1)) + 1}`}`;
    const module: ProjectModule = {
      id: `module-${digest(`${scope.projectId}\u0000${group.key}`)}`,
      name,
      kind: group.role === 'source' ? 'feature' : group.role,
      description: `${relative}: ${group.files.length} files, ${symbols.length} declarations. ${coreApis.slice(0, 8).join('; ')}`,
      purpose: `Indexed ${group.role} group under ${relative}; ownership follows directories and resolved dependencies.`,
      coreApis,
      sourceFiles: group.files.map((file) => file.relativePath),
      symbolKeys: symbols.map((symbol) => symbol.symbolKey),
      dependsOn: [],
      evidenceIds: group.files.map((file) => `file:${file.fileId}`),
    };
    const languages = [...new Set(group.files.flatMap((file) => file.languageId ? [file.languageId] : []))];
    if (languages.length === 1) module.language = languages[0];
    moduleByGroup.set(group.key, module);
  }

  const connections = new Map<string, { moduleId: string; dependsOnModuleId: string; evidenceIds: string[] }>();
  let unresolved = 0;
  for (const edge of index.dependencyEdges) {
    const sourceGroup = owner.get(edge.sourceRelativePath);
    if (!sourceGroup) continue;
    if (edge.resolution !== 'resolved') { unresolved++; continue; }
    const targetGroup = edge.targetRelativePath ? owner.get(edge.targetRelativePath) : undefined;
    if (!targetGroup || sourceGroup === targetGroup) continue;
    const sourceModule = moduleByGroup.get(sourceGroup)!;
    const targetModule = moduleByGroup.get(targetGroup)!;
    const key = `${sourceModule.id}\u0000${targetModule.id}`;
    const connection = connections.get(key) ?? {
      moduleId: sourceModule.id, dependsOnModuleId: targetModule.id, evidenceIds: [],
    };
    connection.evidenceIds.push(`dependency:${edge.dependencyEdgeId}`);
    connections.set(key, connection);
  }
  const modules = [...moduleByGroup.values()];
  const modulesById = new Map(modules.map((module) => [module.id, module]));
  for (const connection of connections.values()) modulesById.get(connection.moduleId)!.dependsOn.push(connection.dependsOnModuleId);
  for (const module of modules) module.dependsOn.sort();
  const failed = files.filter((file) => file.parseStatus === 'failed' || file.parseStatus === 'partial').length;
  return {
    repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, analysisHash: index.analysisHash,
    objective,
    summary: `${project.displayName}: ${modules.length} modules, ${files.length} indexed files, ${connections.size} resolved module dependencies.`,
    modules,
    dependencies: [...connections.values()],
    unassignedFiles: [],
    risks: [
      ...(failed ? [`${failed} files have partial or failed parsing; their ownership is structural.`] : []),
      ...(unresolved ? [`${unresolved} dependency records remain unresolved.`] : []),
    ],
  };
}
