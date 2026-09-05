import { createHash } from 'node:crypto';
import type { ModuleTarget, ProjectAnalysisRecord, ProjectModule, RepositoryRevisionScope, SearchCandidate } from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { projectPlanHash } from './project-analysis.js';
import type { ModuleReranker } from './module-reranker.js';

export interface ModuleMatchRequest {
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryIds: readonly string[];
}

interface ModuleHit extends RepositoryRevisionScope {
  repositoryName: string;
  projectId: string;
  projectPath: string;
  module: ProjectModule;
  score: number;
  semanticScore: number;
}

function normalizedApi(api: string): string {
  return api.replace(/\(.*$/s, '').split(/[\s.:]+/).at(-1)?.replaceAll('_', '').toLowerCase() ?? '';
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

/** Module metadata is fetched only for recalled IDs; no full structural index is hydrated. */
export async function searchModules(store: IndexStore, request: ModuleMatchRequest, parentSignal?: AbortSignal, reranker?: ModuleReranker): Promise<SearchCandidate[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(parentSignal ? [parentSignal] : [])]);
  try {
    return await searchModuleSnapshot(store, request, signal, reranker);
  } finally {
    controller.abort(new Error('Module search finished'));
  }
}

async function searchModuleSnapshot(store: IndexStore, request: ModuleMatchRequest, signal: AbortSignal, reranker?: ModuleReranker): Promise<SearchCandidate[]> {
  if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 10) throw new Error('Module search topK must be between 1 and 10.');
  const repositoryIds = [...new Set(request.repositoryIds)];
  if (repositoryIds.length === 0 || repositoryIds.length > 32) throw new Error('Module search requires between 1 and 32 historical repositories.');
  if (!store.searchSearchDocuments || !store.getModuleArtifacts || !store.getProject || !store.getSourcePreview) throw new Error('Module search requires bounded index-store queries.');
  const query = [request.target.name, request.target.signature, request.target.documentation, request.requirement, ...(request.target.module?.coreApis ?? [])].filter(Boolean).join('\n');
  if (!query.trim() || query.length > 32_000) throw new Error('Module query must contain between 1 and 32000 characters.');
  const requiredApis = [...new Set(request.target.module?.coreApis ?? [])];
  const hits = (await mapBounded(repositoryIds, 4, async (repositoryId) => {
    signal.throwIfAborted();
    const repository = await store.getRepository(repositoryId, signal);
    if (!repository?.activeRevision || repository.role !== 'history') return [];
    const scope = { repositoryId, analysisRevision: repository.activeRevision };
    const revision = await store.getRevision(scope, signal);
    if (revision?.status !== 'ready') return [];
    const documents = await store.searchSearchDocuments!(scope, query, Math.min(120, Math.max(24, request.topK * 12)), 'summary', signal);
    const artifacts = await store.getModuleArtifacts!(scope, [...new Set(documents.flatMap((doc) => doc.moduleArtifactId ? [doc.moduleArtifactId] : []))], signal);
    const records = new Map(artifacts.flatMap((artifact) => {
      const record = artifact.payload as ProjectAnalysisRecord | undefined;
      if (artifact.kind !== 'module-summary' || artifact.status !== 'current' || artifact.analysisHash !== revision.analysisHash ||
        artifact.repositoryId !== repositoryId || artifact.analysisRevision !== scope.analysisRevision ||
        !artifact.planHash || !record?.proposal || record.state !== 'ready' ||
        record.repositoryId !== repositoryId || record.analysisRevision !== scope.analysisRevision ||
        record.proposal.analysisHash !== revision.analysisHash || artifact.planHash !== projectPlanHash(record.proposal)) return [];
      return [[artifact.moduleArtifactId, record] as const];
    }));
    const projects = new Map((await mapBounded([...new Set([...records.values()].map((r) => r.projectId))], 4,
      (id) => store.getProject!(scope, id, signal))).flatMap((project) => project ? [[project.projectId, project] as const] : []));
    const byModule = new Map<string, ModuleHit>();
    documents.forEach((document, rank) => {
      if (document.repositoryId !== repositoryId || document.analysisRevision !== scope.analysisRevision || !document.moduleArtifactId) return;
      const record = records.get(document.moduleArtifactId);
      if (!record) return;
      let identity: { projectId?: string; moduleId?: string };
      try { identity = JSON.parse(document.text); } catch { return; }
      if (!identity || identity.projectId !== record.projectId) return;
      const module = record.proposal!.modules.find((item) => item.id === identity.moduleId);
      const project = projects.get(record.projectId);
      if (!module || !project || module.sourceFiles.length === 0) return;
      const available = new Set((module.coreApis ?? []).map(normalizedApi).filter(Boolean));
      const apiScore = requiredApis.length ? requiredApis.filter((api) => available.has(normalizedApi(api))).length / requiredApis.length : 0;
      const semantic = document.retrievalScore?.semantic;
      const lexical = document.retrievalScore?.lexical ?? 0;
      const relevance = semantic !== undefined && Number.isFinite(semantic) ? Math.max(0, Math.min(1, semantic))
        : lexical > 0 ? lexical / (lexical + 10) : 61 / (61 + rank);
      const score = 0.8 * relevance + 0.2 * apiScore;
      const key = JSON.stringify([record.projectId, module.id]);
      if ((byModule.get(key)?.score ?? -1) < score) byModule.set(key, {
        ...scope, repositoryName: repository.displayName, projectId: project.projectId,
        projectPath: project.relativePath, module, score, semanticScore: relevance,
      });
    });
    return [...byModule.values()];
  })).flat().sort((a, b) => b.score - a.score || JSON.stringify([a.repositoryId, a.projectId, a.module.id]).localeCompare(JSON.stringify([b.repositoryId, b.projectId, b.module.id]))).slice(0, reranker ? Math.min(20, Math.max(8, request.topK * 2)) : request.topK);

  const result = await mapBounded(hits, 4, async (hit): Promise<SearchCandidate> => {
    signal.throwIfAborted();
    const files = [...new Set(hit.module.sourceFiles)];
    const previewFiles = files.slice(0, 3);
    const parts = await mapBounded(previewFiles, 3, async (file) => {
      signal.throwIfAborted();
      const source = await store.getSourcePreview!(hit, file, 4_000, signal);
      if (source === null) throw new Error(`Module source is missing from its revision: ${file}`);
      return { text: `// ${file}\n${source.text}`, truncated: source.truncated };
    });
    const available = new Set((hit.module.coreApis ?? []).map(normalizedApi).filter(Boolean));
    const matchedApis = requiredApis.filter((api) => available.has(normalizedApi(api)));
    return {
      id: `module-${createHash('sha256').update(JSON.stringify([hit.repositoryId, hit.analysisRevision, hit.projectId, hit.module.id])).digest('hex')}`,
      title: hit.module.name, repository: hit.repositoryName, license: 'Unknown', kind: 'module',
      language: moduleLanguage(hit.module.language, files), path: files[0]!,
      signature: (hit.module.coreApis ?? []).join('\n'), summary: hit.module.description,
      score: { overall: hit.score, semantic: hit.semanticScore, symbol: 0, contract: requiredApis.length ? matchedApis.length / requiredApis.length : 0 },
      preview: parts.map((part) => part.text).join('\n\n'), dependencies: [...hit.module.dependsOn],
      compatibility: [], risks: ['模块行为与许可证尚需验证；接口名称匹配不代表功能等价。'],
      sourceModule: { repositoryId: hit.repositoryId, analysisRevision: hit.analysisRevision, projectId: hit.projectId,
        moduleId: hit.module.id, name: hit.module.name, projectPath: hit.projectPath, purpose: hit.module.purpose,
        sourceFiles: files, coreApis: hit.module.coreApis ?? [], dependsOn: [...hit.module.dependsOn], evidenceIds: [...hit.module.evidenceIds] },
      moduleMatch: { requiredApis, matchedApis, missingApis: requiredApis.filter((api) => !matchedApis.includes(api)),
        verification: 'interface-only', previewFiles, previewTruncated: files.length > previewFiles.length || parts.some((part) => part.truncated) },
    };
  });
  let ranked = result;
  if (reranker && result.length > 0) {
    const ordering = await reranker.rank(query, result.map((candidate) => [candidate.title, candidate.summary,
      candidate.signature, candidate.dependencies.join('\n'), candidate.preview].join('\n')), signal);
    ranked = ordering.map(({ index, score }) => ({ ...result[index]!, score: { ...result[index]!.score, overall: score },
      moduleMatch: { ...result[index]!.moduleMatch!, reranker: { model: reranker.model, score } } }));
  }
  for (const hit of hits) {
    signal.throwIfAborted();
    if ((await store.getRepository(hit.repositoryId, signal))?.activeRevision !== hit.analysisRevision) throw new Error('Repository revision changed during module search; retry against the current snapshot.');
  }
  return ranked.slice(0, request.topK);
}

function moduleLanguage(language: string | undefined, files: string[]): ModuleTarget['language'] {
  const names: Record<string, ModuleTarget['language']> = { typescript: 'TypeScript', javascript: 'TypeScript', python: 'Python', java: 'Java', 'c#': 'C#', csharp: 'C#', rust: 'Rust', go: 'Go' };
  if (language && names[language.toLowerCase()]) return names[language.toLowerCase()]!;
  const extensions: Record<string, ModuleTarget['language']> = { ts: 'TypeScript', js: 'TypeScript', py: 'Python', java: 'Java', cs: 'C#', rs: 'Rust', go: 'Go' };
  const found = files.map((file) => extensions[file.split('.').at(-1)?.toLowerCase() ?? '']).find(Boolean);
  if (!found) throw new Error(`Module source language is unsupported: ${language ?? 'unknown'}`);
  return found;
}

export const moduleMatchingInternals = { normalizedApi, mapBounded };
