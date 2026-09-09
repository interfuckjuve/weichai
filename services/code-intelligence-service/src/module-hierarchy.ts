import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  indexModuleHierarchy, type IndexedFileRecord, type ModuleHierarchyCandidate,
  type ModuleHierarchyDecision, type ModuleHierarchyDecisionRequest, type ModuleHierarchyPlanner,
  type ModuleRefinement, type ProjectAnalysisScope, type ProjectModule, type ProjectModuleProposal,
  type StructuralIndex, type SymbolRecord,
} from '@forexplore/contracts';
import { parseModuleHierarchyDecision } from './module-hierarchy-planner.js';
import type { IndexStore } from './index-store.js';

export const adaptiveModuleAlgorithm = 'adaptive-module-tree/v1' as const;
export interface AdaptiveModuleOptions {
  planner?: ModuleHierarchyPlanner;
  /** Independent sibling decisions; parents are validated before children run. */
  maxConcurrentDecisions?: number;
  decisionCache?: {
    read(key: string): Promise<unknown | undefined>;
    write(key: string, decision: ModuleHierarchyDecision): Promise<void>;
  };
  requireModel?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  maxModelCalls?: number;
  modelTimeoutMs?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  readSource?: IndexStore['getSourceSlice'];
}
interface Candidate { id: string; name: string; relativePath: string; files: IndexedFileRecord[] }
interface Work { files: IndexedFileRecord[]; node?: ProjectModule; depth: number }

function digest(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24); }
function commonDirectory(files: IndexedFileRecord[]): string {
  let pieces = path.posix.dirname(files[0]?.relativePath ?? '').split('/').filter(value => value !== '.');
  for (const file of files.slice(1)) {
    const next = path.posix.dirname(file.relativePath).split('/');
    let index = 0;
    while (index < pieces.length && pieces[index] === next[index]) index++;
    pieces = pieces.slice(0, index);
    if (!pieces.length) break;
  }
  return pieces.join('/');
}

/** Directories propose boundaries; processing batches never become visible modules. */
function candidatesFor(files: IndexedFileRecord[]): Candidate[] {
  if (!files.length) return [];
  const prefix = commonDirectory(files);
  const groups = new Map<string, IndexedFileRecord[]>();
  for (const file of files) {
    const relative = path.posix.relative(prefix || '.', file.relativePath);
    const slash = relative.indexOf('/');
    const group = slash < 0 ? '.' : relative.slice(0, slash);
    const members = groups.get(group) ?? [];
    members.push(file); groups.set(group, members);
  }
  let values = [...groups].map(([name, members]) => ({
    id: `group-${digest(members.map(file => file.fileId).sort())}`,
    name: name === '.' ? 'Local files' : name,
    relativePath: name === '.' ? prefix : path.posix.join(prefix, name), files: members,
  }));
  // Bypass a source wrapper next to a few root manifests without adding a synthetic hierarchy level.
  const directories = values.filter(value => value.name !== 'Local files');
  const local = values.find(value => value.name === 'Local files');
  if (directories.length === 1 && local && local.files.every(file => file.role !== 'source')) {
    const nested = candidatesFor(directories[0]!.files);
    if (nested.length > 1) values = [...nested, local];
  }
  if (values.length <= 1) {
    if (files.length > 64) return [];
    values = files.map(file => ({ id: `group-${digest([file.fileId])}`, name: path.posix.basename(file.relativePath),
      relativePath: file.relativePath, files: [file] }));
  }
  return values.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.id.localeCompare(b.id));
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error('Invalid adaptive module budget.');
  return result;
}

async function decideWithinDeadline(planner: ModuleHierarchyPlanner, request: ModuleHierarchyDecisionRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([planner.decide(request, signal), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function buildAdaptiveModuleProposal(
  index: StructuralIndex, scope: ProjectAnalysisScope, objective: string, options: AdaptiveModuleOptions = {},
): Promise<ProjectModuleProposal> {
  const project = index.projects.find(value => value.projectId === scope.projectId);
  if (!project || index.repositoryId !== scope.repositoryId || index.analysisRevision !== scope.analysisRevision) throw new Error('Hierarchy scope does not match the indexed project.');
  const concurrency = boundedInteger(options.maxConcurrentDecisions, 3, 16);
  const maxDepth = boundedInteger(options.maxDepth, 8, 32);
  const maxNodes = boundedInteger(options.maxNodes, 2048, 10000);
  const maxModelCalls = boundedInteger(options.maxModelCalls, 24, 1000);
  const modelTimeoutMs = boundedInteger(options.modelTimeoutMs, 45000, 120000);
  const maxDurationMs = boundedInteger(options.maxDurationMs, 300000, 3600000);
  const started = performance.now();
  const files = index.files.filter(file => file.projectId === scope.projectId).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const fileSet = new Set(files.map(file => file.relativePath));
  const symbolsByPath = new Map<string, SymbolRecord[]>();
  for (const symbol of index.symbols) if (fileSet.has(symbol.relativePath)) {
    const symbols = symbolsByPath.get(symbol.relativePath) ?? [];
    symbols.push(symbol); symbolsByPath.set(symbol.relativePath, symbols);
  }
  const edgesByPath = new Map<string, StructuralIndex['dependencyEdges']>();
  for (const edge of index.dependencyEdges) if (fileSet.has(edge.sourceRelativePath)) {
    const edges = edgesByPath.get(edge.sourceRelativePath) ?? [];
    edges.push(edge); edgesByPath.set(edge.sourceRelativePath, edges);
  }
  const metrics = (members: IndexedFileRecord[]) => ({ fileCount: members.length,
    sourceBytes: members.reduce((sum, file) => sum + file.sizeBytes, 0),
    symbolCount: members.reduce((sum, file) => sum + (symbolsByPath.get(file.relativePath)?.length ?? 0), 0) });
  const apis = (members: IndexedFileRecord[], limit: number) => {
    const values: string[] = [];
    for (const file of members) for (const symbol of symbolsByPath.get(file.relativePath) ?? []) {
      if (symbol.exported || !symbol.containerSymbolKey) values.push((symbol.signature || symbol.qualifiedName || symbol.name).slice(0, 220));
      if (values.length === limit) return values;
    }
    return values;
  };
  const modules: ProjectModule[] = [];
  const risks = new Set<string>();
  let projectSummary: string | undefined;
  let modelDecisionCount = 0, modelCalls = 0, decisionCount = 0;
  const makeNode = (members: IndexedFileRecord[], parentId: string | null, name: string, description: string,
    nodeKind: ProjectModule['nodeKind'], evidenceIds: string[]): ProjectModule => {
    const node: ProjectModule = {
      id: `module-${digest([scope.projectId, parentId, ...members.map(file => file.fileId).sort()])}`,
      parentId, nodeKind: nodeKind ?? 'module', name, kind: 'feature', description, purpose: description,
      sourceFiles: [], symbolKeys: [], dependsOn: [], evidenceIds: evidenceIds.length ? evidenceIds : members.slice(0, 8).map(file => `file:${file.fileId}`),
      metrics: metrics(members), coreApis: apis(members, 12),
    };
    const languages = [...new Set(members.flatMap(file => file.languageId ? [file.languageId] : []))];
    if (languages.length === 1) node.language = languages[0];
    modules.push(node); return node;
  };
  const queue: Work[] = files.length ? [{ files, depth: -1 }] : [];
  const evaluate = async (work: Work) => {
    options.signal?.throwIfAborted();
    const candidates = candidatesFor(work.files);
    const facts = metrics(work.files);
    let decision: ModuleHierarchyDecision | undefined;
    let source: ModuleRefinement['decisionSource'] = 'structural';
    let deferredReason: string | undefined;
    decisionCount++;
    const remainingMs = maxDurationMs - (performance.now() - started);
    const canModel = options.planner && remainingMs > 0 && candidates.length > 0 && candidates.length <= 64;
    if (canModel) {
      // Reserve before the first await so siblings cannot oversubscribe the budget.
      const reservedCall = modelCalls < maxModelCalls;
      if (reservedCall) modelCalls++;
      const requestCandidates: ModuleHierarchyCandidate[] = candidates.map(candidate => ({
        id: candidate.id, name: candidate.name.slice(0, 160), relativePath: candidate.relativePath,
        ...metrics(candidate.files), languages: [...new Set(candidate.files.flatMap(file => file.languageId ? [file.languageId] : []))],
        samplePaths: candidate.files.slice(0, 3).map(file => file.relativePath), coreApis: apis(candidate.files, 3),
        evidenceIds: candidate.files.slice(0, 3).map(file => `file:${file.fileId}`),
      }));
      const owner = new Map(candidates.flatMap(candidate => candidate.files.map(file => [file.relativePath, candidate.id] as const)));
      const dependencies = new Map<string, ModuleHierarchyDecisionRequest['dependencies'][number]>();
      for (const file of work.files) for (const edge of edgesByPath.get(file.relativePath) ?? []) {
        if (!edge.internal || edge.resolution !== 'resolved' || !edge.targetRelativePath) continue;
        const sourceId = owner.get(edge.sourceRelativePath), targetId = owner.get(edge.targetRelativePath);
        if (!sourceId || !targetId || sourceId === targetId) continue;
        const key = `${sourceId}\0${targetId}`;
        const entry = dependencies.get(key) ?? { sourceId, targetId, count: 0, evidenceIds: [] };
        entry.count++; if (entry.evidenceIds.length < 2) entry.evidenceIds.push(`dependency:${edge.dependencyEdgeId}`);
        dependencies.set(key, entry);
      }
      const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(modelTimeoutMs, Math.floor(remainingMs)))), ...(options.signal ? [options.signal] : [])]);
      const excerpts: ModuleHierarchyDecisionRequest['excerpts'] = [];
      const representatives = candidates.map(candidate => candidate.files.find(file => file.role === 'source')).filter((file): file is IndexedFileRecord => Boolean(file)).slice(0, 2);
      if (representatives.length < 2) for (const file of work.files) {
        if (file.role === 'source' && !representatives.includes(file)) representatives.push(file);
        if (representatives.length === 2) break;
      }
      if (options.readSource) for (const file of representatives) {
        const symbol = (symbolsByPath.get(file.relativePath) ?? []).find(value => ['function', 'method', 'class', 'interface'].includes(value.kind));
        const slice = await options.readSource(scope, file.relativePath, symbol?.sourceRange, 1800, signal).catch(() => null);
        if (slice) excerpts.push({ relativePath: file.relativePath, content: slice.text, evidenceId: `file:${file.fileId}` });
      }
      const request: ModuleHierarchyDecisionRequest = { ...scope, analysisHash: index.analysisHash,
        nodeId: work.node?.id ?? `project:${project.projectId}`, name: work.node?.name ?? project.displayName,
        depth: work.depth + 1, metrics: facts, candidates: requestCandidates,
        dependencies: [...dependencies.values()].sort((a, b) => b.count - a.count).slice(0, 64), excerpts };
      try {
        const cacheKey = digest([adaptiveModuleAlgorithm, objective, request]);
        const cached = await options.decisionCache?.read(cacheKey);
        signal.throwIfAborted();
        if (cached !== undefined && reservedCall) modelCalls--;
        if (cached === undefined && !reservedCall) {
          deferredReason = 'Model refinement budget reached; further functional refinement remains pending.';
          throw new Error(deferredReason);
        }
        decision = parseModuleHierarchyDecision(cached ?? await decideWithinDeadline(options.planner!, request, signal), request);
        signal.throwIfAborted();
        // Only validated, live attempts reach durable storage. A late model reply
        // cannot write after the deadline race has rejected.
        if (cached === undefined) await options.decisionCache?.write(cacheKey, decision);
        source = 'model'; modelDecisionCount++;
        if (!work.node) projectSummary = decision.description;
        if (decision.action === 'stop' && decision.stopReason === 'insufficient-evidence') deferredReason = decision.reason;
      } catch {
        options.signal?.throwIfAborted();
        decision = undefined;
        deferredReason ??= 'Model decision was unavailable or invalid; further functional refinement remains pending.';
        risks.add(deferredReason);
      }
    } else if (options.planner && (modelCalls >= maxModelCalls || remainingMs <= 0)) {
      deferredReason = 'Model refinement budget reached; further functional refinement remains pending.';
    } else if (options.planner && candidates.length > 64) {
      deferredReason = 'Candidate inventory exceeds the bounded model input; further functional refinement remains pending.';
    } else if (!candidates.length) {
      deferredReason = 'A bounded candidate inventory could not establish smaller boundaries; functional refinement remains pending.';
    }
    if (!decision) {
      const small = facts.fileCount <= 24 && facts.sourceBytes <= 160 * 1024;
      const directorySplit = candidates.length >= 2 && candidates.some(candidate => candidate.files.length > 1);
      const split = !options.requireModel && !small && directorySplit;
      const name = work.node?.name ?? project.displayName;
      const description = work.node?.description ?? `${name}: ${facts.fileCount} files, ${facts.symbolCount} declarations.`;
      const evidenceIds = work.node?.evidenceIds ?? work.files.slice(0, 8).map(file => `file:${file.fileId}`);
      decision = split ? { action: 'split', name, description, nodeKind: work.node?.nodeKind ?? 'module',
        reason: 'Distinct directory boundaries provide smaller structural scopes.', evidenceIds,
        children: candidates.map(candidate => ({ name: candidate.name, description: `${candidate.relativePath || name}: ${candidate.files.length} files.`,
          nodeKind: 'module', groupIds: [candidate.id], evidenceIds: candidate.files.slice(0, 3).map(file => `file:${file.fileId}`) })) } :
        { action: 'stop', name, description, nodeKind: work.node?.nodeKind ?? 'module', evidenceIds,
          reason: small ? 'The source scope is small enough to inspect directly; additional structural levels are unnecessary.' : 'No smaller supported directory boundary was found.' };
      if (options.requireModel || !small && !split) deferredReason ??= 'Further functional refinement requires additional evidence.';
    }
    return { work, candidates, decision, source, deferredReason };
  };
  // Apply each bounded wave in stable queue order even if model replies arrive
  // out of order. Node limits and child identities remain deterministic.
  for (let cursor = 0; cursor < queue.length;) {
    options.signal?.throwIfAborted();
    const wave = queue.slice(cursor, cursor + concurrency);
    cursor += wave.length;
    const outcomes = await Promise.all(wave.map(evaluate));
    for (const outcome of outcomes) {
      const { work, candidates } = outcome;
      let { decision, deferredReason } = outcome;
      let source: ModuleRefinement['decisionSource'] = outcome.source;
      const childrenCount = decision.action === 'split' ? decision.children.length : 0;
      const depthLimited = work.depth >= maxDepth - 1;
      const nodeLimited = modules.length + childrenCount > maxNodes;
      const deadlineReached = performance.now() - started >= maxDurationMs;
      if (decision.action === 'split' && (depthLimited || nodeLimited || deadlineReached)) {
        deferredReason = depthLimited ? 'Maximum module depth reached.' : nodeLimited ? 'Module node budget reached.' : 'Module modeling deadline reached.';
        source = 'budget';
        decision = { ...decision, action: 'stop' };
      }
      let node = work.node;
      if (!node && decision.action === 'stop') node = makeNode(work.files, null, decision.name, decision.description, decision.nodeKind, decision.evidenceIds);
      if (node) {
        node.name = decision.name; node.description = decision.description; node.purpose = decision.description;
        node.nodeKind = decision.nodeKind;
        node.evidenceIds = decision.evidenceIds.length ? decision.evidenceIds : work.files.slice(0, 8).map(file => `file:${file.fileId}`);
        node.refinement = { state: decision.action === 'split' ? 'split' : deferredReason ? 'deferred' : 'leaf',
          reason: deferredReason ?? decision.reason, decisionSource: source };
      }
      if (decision.action === 'split') {
        const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
        for (const child of decision.children) {
          const members = child.groupIds.flatMap(id => byId.get(id)!.files).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
          const next = makeNode(members, node?.id ?? null, child.name, child.description, child.nodeKind, child.evidenceIds);
          queue.push({ files: members, node: next, depth: work.depth + 1 });
        }
      } else if (node) {
        node.sourceFiles = work.files.map(file => file.relativePath);
        node.symbolKeys = work.files.flatMap(file => (symbolsByPath.get(file.relativePath) ?? []).map(symbol => symbol.symbolKey));
      }
    }
  }
  const forest = indexModuleHierarchy(modules);
  const owners = new Map(modules.flatMap(module => module.sourceFiles.map(file => [file, module.id] as const)));
  const connections = new Map<string, NonNullable<ProjectModuleProposal['dependencies']>[number]>();
  const ancestors = (id: string) => {
    const values: string[] = [];
    for (let node = forest.byId.get(id); node; node = node.parentId ? forest.byId.get(node.parentId) : undefined) values.push(node.id);
    return values;
  };
  let unresolved = 0;
  for (const file of files) for (const edge of edgesByPath.get(file.relativePath) ?? []) {
    if (edge.resolution !== 'resolved') { unresolved++; continue; }
    const left = owners.get(edge.sourceRelativePath), right = edge.targetRelativePath ? owners.get(edge.targetRelativePath) : undefined;
    if (!edge.internal || !left || !right || left === right) continue;
    const source = ancestors(left), target = ancestors(right);
    const sourceSet = new Set(source), targetSet = new Set(target);
    for (const from of source) for (const to of target) {
      if (targetSet.has(from) || sourceSet.has(to)) continue;
      const key = `${from}\0${to}`;
      const connection = connections.get(key) ?? { moduleId: from, dependsOnModuleId: to, evidenceIds: [] };
      if (connection.evidenceIds.length < 8) connection.evidenceIds.push(`dependency:${edge.dependencyEdgeId}`);
      connections.set(key, connection);
    }
  }
  for (const connection of connections.values()) forest.byId.get(connection.moduleId)!.dependsOn.push(connection.dependsOnModuleId);
  for (const module of modules) module.dependsOn.sort();
  if (unresolved) risks.add(`${unresolved} dependency records remain unresolved.`);
  const deferredCount = modules.filter(module => module.refinement?.state === 'deferred').length;
  if (deferredCount) risks.add(`${deferredCount} module branches retain unrefined structure.`);
  return { ...scope, analysisHash: index.analysisHash, objective,
    summary: projectSummary ?? `${project.displayName}: ${forest.roots.length} root modules, ${modules.length} module nodes, ${files.length} indexed files.`,
    modules, dependencies: [...connections.values()], unassignedFiles: [], risks: [...risks],
    hierarchy: { version: 1, algorithm: adaptiveModuleAlgorithm, maxDepth: modules.length ? Math.max(...forest.depthById.values()) + 1 : 0,
      decisionCount, modelDecisionCount, deferredCount } };
}
