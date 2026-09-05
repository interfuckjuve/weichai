import type {
  Language,
  ModuleArtifactRecord,
  ModuleTarget,
  ProjectAnalysisRecord,
  ProjectModule,
  RepositoryId,
  SearchCandidate,
  SearchDocumentRecord,
  StructuralIndex,
  SymbolRecord,
} from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';

export interface ModuleImplementationSearchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryIds: readonly RepositoryId[];
}

export interface ModuleImplementationSearchPort {
  search(request: ModuleImplementationSearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]>;
}

interface RankedModule {
  repositoryId: RepositoryId;
  repositoryName: string;
  analysisRevision: string;
  projectId: string;
  projectPath: string;
  module: ProjectModule;
  record: ProjectAnalysisRecord;
  index: StructuralIndex;
  score: number;
}

const languageNames: Record<string, Language> = {
  typescript: 'TypeScript',
  javascript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  csharp: 'C#',
  rust: 'Rust',
  go: 'Go',
};

function terms(value: string): Set<string> {
  return new Set(value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

function overlap(left: string, right: string): number {
  const a = terms(left);
  const b = terms(right);
  if (a.size === 0 || b.size === 0) return 0;
  const common = [...a].filter((term) => b.has(term)).length;
  return common / Math.max(a.size, b.size);
}

function moduleText(module: ProjectModule): string {
  return [
    module.name,
    module.kind,
    module.description,
    module.purpose ?? '',
    module.domain ?? '',
    module.language ?? '',
    ...(module.coreApis ?? []),
    ...module.dependsOn,
  ].join('\n');
}

function moduleIdentity(document: SearchDocumentRecord): { projectId: string; moduleId: string } | null {
  try {
    const value = JSON.parse(document.text) as { projectId?: unknown; moduleId?: unknown };
    return typeof value.projectId === 'string' && typeof value.moduleId === 'string'
      ? { projectId: value.projectId, moduleId: value.moduleId }
      : null;
  } catch {
    return null;
  }
}

function projectRecord(artifact: ModuleArtifactRecord): ProjectAnalysisRecord | null {
  if (artifact.kind !== 'module-summary' || artifact.status !== 'current' || !artifact.payload) return null;
  const value = artifact.payload as Partial<ProjectAnalysisRecord>;
  if (value.state !== 'ready' || !value.proposal || !Array.isArray(value.proposal.modules)) {
    return null;
  }
  return value as ProjectAnalysisRecord;
}

function supportsTarget(symbol: SymbolRecord, target: ModuleTarget): boolean {
  if (!languageNames[symbol.languageId]) return false;
  return target.kind === 'class'
    ? ['class', 'record', 'struct', 'interface'].includes(symbol.kind)
    : ['function', 'method', 'constructor'].includes(symbol.kind);
}

function sourceExcerpt(source: string, symbol: SymbolRecord): string {
  const lines = source.split(/\r?\n/);
  const startLine = Math.max(0, symbol.sourceRange.startLine - 1);
  const endLine = Math.min(lines.length - 1, Math.max(startLine, symbol.sourceRange.endLine - 1));
  const selected = lines.slice(startLine, endLine + 1);
  if (selected.length === 0) return '';
  selected[0] = selected[0]?.slice(Math.max(0, symbol.sourceRange.startColumn - 1)) ?? '';
  if (selected.length === 1) {
    const width = Math.max(0, symbol.sourceRange.endColumn - symbol.sourceRange.startColumn);
    selected[0] = selected[0]?.slice(0, width) ?? '';
  } else {
    selected[selected.length - 1] = selected.at(-1)?.slice(0, Math.max(0, symbol.sourceRange.endColumn - 1)) ?? '';
  }
  return selected.join('\n').trim();
}

function dependencies(index: StructuralIndex, symbol: SymbolRecord): string[] {
  return [...new Set(index.dependencyEdges
    .filter((edge) => edge.sourceSymbolKey === symbol.symbolKey || edge.sourceRelativePath === symbol.relativePath)
    .flatMap((edge) => edge.targetReference ?? edge.targetSymbolKey ?? edge.targetRelativePath
      ? [edge.targetReference ?? edge.targetSymbolKey ?? edge.targetRelativePath!]
      : []))]
    .slice(0, 32);
}

function queryText(request: ModuleImplementationSearchRequest): string {
  return [request.target.name, request.target.signature, request.target.documentation ?? '', request.requirement].join('\n');
}

/** Searches current reviewed project summaries first, then ranks symbols owned by the selected modules. */
export class ModuleImplementationSearchService implements ModuleImplementationSearchPort {
  constructor(private readonly store: IndexStore) {}

  async search(request: ModuleImplementationSearchRequest, signal?: AbortSignal): Promise<SearchCandidate[]> {
    if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) {
      throw new Error('Module implementation search topK must be between 1 and 10.');
    }
    const repositoryIds = [...new Set(request.repositoryIds.filter(Boolean))];
    if (repositoryIds.length === 0) throw new Error('至少需要一个已解析的历史仓库才能执行模块检索。');
    const query = queryText(request);
    const rankedModules = new Map<string, RankedModule>();

    for (const repositoryId of repositoryIds) {
      signal?.throwIfAborted();
      const repository = await this.store.getRepository(repositoryId);
      if (!repository?.activeRevision || repository.role !== 'history') continue;
      const scope = { repositoryId, analysisRevision: repository.activeRevision };
      const [index, artifacts, projectedDocuments] = await Promise.all([
        this.store.getStructuralIndex(scope),
        this.store.listModuleArtifacts(scope),
        this.store.searchSearchDocuments?.(scope, query, Math.max(12, request.topK * 4), 'summary') ?? [],
      ]);
      if (!index) continue;
      const documents = projectedDocuments.length > 0
        ? projectedDocuments
        : (await this.store.listSearchDocuments(scope)).filter((document) => document.kind === 'summary');
      const artifactsById = new Map(artifacts.map((artifact) => [artifact.moduleArtifactId, artifact]));
      documents.forEach((document, rank) => {
        const identity = moduleIdentity(document);
        const artifact = document.moduleArtifactId ? artifactsById.get(document.moduleArtifactId) : undefined;
        const record = artifact ? projectRecord(artifact) : null;
        if (!record || (identity && record.projectId !== identity.projectId)) return;
        const project = index.projects.find((candidate) => candidate.projectId === record.projectId);
        if (!project) return;
        const matchingModules = identity
          ? record.proposal!.modules.filter((candidate) => candidate.id === identity.moduleId)
          : record.proposal!.modules;
        matchingModules.forEach((module) => {
          const lexical = overlap(query, moduleText(module));
          const api = overlap(request.target.signature, (module.coreApis ?? []).join('\n'));
          const recall = 1 - rank / Math.max(1, documents.length);
          const candidate = {
            repositoryId,
            repositoryName: repository.displayName,
            analysisRevision: repository.activeRevision!,
            projectId: project.projectId,
            projectPath: project.relativePath,
            module,
            record,
            index,
            score: 0.5 * recall + 0.3 * lexical + 0.2 * api,
          } satisfies RankedModule;
          const key = `${repositoryId}\u0000${repository.activeRevision}\u0000${project.projectId}\u0000${module.id}`;
          const existing = rankedModules.get(key);
          if (!existing || candidate.score > existing.score) rankedModules.set(key, candidate);
        });
      });
    }

    const modules = [...rankedModules.values()]
      .sort((left, right) => right.score - left.score || left.module.id.localeCompare(right.module.id))
      .slice(0, Math.max(4, request.topK * 2));
    const candidates = (await Promise.all(modules.map((module) => this.symbolCandidates(module, request, signal)))).flat()
      .sort((left, right) => right.score.overall - left.score.overall || left.id.localeCompare(right.id));

    const selected: SearchCandidate[] = [];
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const moduleId = candidate.sourceModule
        ? `${candidate.sourceModule.repositoryId}/${candidate.sourceModule.analysisRevision}/${candidate.sourceModule.moduleId}`
        : '';
      if ((counts.get(moduleId) ?? 0) >= 2) continue;
      selected.push(candidate);
      counts.set(moduleId, (counts.get(moduleId) ?? 0) + 1);
      if (selected.length === request.topK) break;
    }
    if (selected.length < request.topK) {
      for (const candidate of candidates) {
        if (!selected.some((entry) => entry.id === candidate.id)) selected.push(candidate);
        if (selected.length === request.topK) break;
      }
    }
    return selected;
  }

  private async symbolCandidates(
    ranked: RankedModule,
    request: ModuleImplementationSearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchCandidate[]> {
    const ownedKeys = new Set(ranked.module.symbolKeys);
    const ownedPaths = new Set(ranked.module.sourceFiles);
    const symbols = ranked.index.symbols.filter((symbol) =>
      (ownedKeys.has(symbol.symbolKey) || ownedPaths.has(symbol.relativePath)) && supportsTarget(symbol, request.target),
    );
    return Promise.all(symbols.map(async (symbol) => {
      signal?.throwIfAborted();
      const source = await this.store.getSourceText(ranked.index, symbol.relativePath) ?? '';
      const symbolMatch = overlap(queryText(request), [symbol.name, symbol.qualifiedName, symbol.signature ?? ''].join('\n'));
      const kindMatch = request.target.kind === 'class'
        ? ['class', 'record', 'struct'].includes(symbol.kind) ? 1 : 0.65
        : symbol.kind === 'constructor' ? 0.7 : 1;
      const overall = Math.min(1, 0.45 * ranked.score + 0.4 * symbolMatch + 0.15 * kindMatch);
      return {
        id: symbol.symbolId,
        title: symbol.qualifiedName || symbol.name,
        repository: ranked.repositoryName,
        license: 'Unknown',
        language: languageNames[symbol.languageId]!,
        kind: request.target.kind,
        path: symbol.relativePath,
        signature: symbol.signature ?? symbol.name,
        summary: ranked.module.description || ranked.module.purpose || `来自模块 ${ranked.module.name} 的索引符号。`,
        score: {
          overall,
          semantic: ranked.score,
          symbol: symbolMatch,
          contract: kindMatch,
          hybrid: ranked.score,
        },
        preview: sourceExcerpt(source, symbol),
        dependencies: dependencies(ranked.index, symbol),
        compatibility: ['来自当前 revision 的已验证模块 Summary'],
        risks: [
          ...(ranked.record.proposal?.risks ?? []),
          '许可证尚未由代码智能索引确认',
        ],
        sourceModule: {
          repositoryId: ranked.repositoryId,
          analysisRevision: ranked.analysisRevision,
          projectId: ranked.projectId,
          moduleId: ranked.module.id,
          name: ranked.module.name,
          projectPath: ranked.projectPath,
          ...(ranked.module.purpose ? { purpose: ranked.module.purpose } : {}),
        },
      } satisfies SearchCandidate;
    }));
  }
}

export const moduleImplementationSearchInternals = {
  moduleIdentity,
  overlap,
  sourceExcerpt,
  supportsTarget,
  terms,
};
