import { createHash } from 'node:crypto';
import type {
  ModuleArtifactRecord, ProjectAnalysisPort, ProjectAnalysisRecord, ProjectAnalysisResult,
  ProjectAnalysisScope, StructuralIndex,
} from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';
import { SeekDbProjection } from './seekdb-projection.js';

export const projectAnalysisProfile = 'code-understanding/v1';
export const projectAnalysisObjective = '解释所选项目的功能模块、用途、核心 API 和依赖。提供项目 summary，并在 unassignedFiles 中逐一说明未归属的项目文件。仅分析代码，不制定迁移或写回计划。';

export interface ProjectAnalysisOptions {
  store: IndexStore;
  plan(scope: ProjectAnalysisScope & { objective: string }): Promise<ProjectAnalysisResult>;
  onChange?(): void;
  project?(index: StructuralIndex): Promise<void>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined)
    .sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export function projectPlanHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function identity(scope: ProjectAnalysisScope, kind: 'job' | 'summary'): string {
  return `project-${kind}:${scope.projectId}:${projectAnalysisProfile}`;
}

/** Independent host validation after the tool runtime has validated its evidence receipt. */
export function validateProjectResult(index: StructuralIndex, scope: ProjectAnalysisScope, result: ProjectAnalysisResult): ProjectAnalysisRecord['coverage'] {
  const { proposal, evidence } = result;
  if (!index.projects.some((project) => project.projectId === scope.projectId)) throw new Error('项目不属于当前索引。');
  for (const value of [proposal, evidence]) {
    if (value.repositoryId !== scope.repositoryId || value.analysisRevision !== scope.analysisRevision || value.analysisHash !== index.analysisHash) {
      throw new Error('模块结果与索引版本不一致。');
    }
  }
  if (proposal.objective !== projectAnalysisObjective || !proposal.summary?.trim()) throw new Error('模块结果缺少项目摘要或解析目标不匹配。');
  if (projectPlanHash(proposal) !== evidence.planHash) throw new Error('模块提案哈希不一致。');
  const receipt = new Set(evidence.evidenceIds);
  const knownEvidence = new Set([
    `revision:${scope.repositoryId}:${scope.analysisRevision}`,
    ...index.projects.map((p) => `project:${p.projectId}`),
    ...index.files.map((f) => `file:${f.fileId}`),
    ...index.symbols.map((s) => `symbol:${s.symbolId}`),
    ...index.dependencyEdges.map((e) => `dependency:${e.dependencyEdgeId}`),
    ...index.diagnostics.map((d) => `diagnostic:${d.diagnosticId}`),
  ]);
  const cite = (ids: string[]) => {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !receipt.has(id) || !knownEvidence.has(id))) {
      throw new Error('模块结果引用了未验证的索引证据。');
    }
  };
  const files = new Set(index.files.filter((file) => file.projectId === scope.projectId).map((file) => file.relativePath));
  const owned = new Set<string>();
  const moduleIds = new Set<string>();
  if (!Array.isArray(proposal.modules)) throw new Error('无效的模块列表。');
  for (const module of proposal.modules) {
    if (!module.id || !module.name?.trim() || !module.description?.trim() || moduleIds.has(module.id)) throw new Error('模块名称、说明或标识无效。');
    moduleIds.add(module.id);
    cite(module.evidenceIds);
    if (!Array.isArray(module.sourceFiles) || !Array.isArray(module.symbolKeys) || !Array.isArray(module.dependsOn)) throw new Error('模块结构无效。');
    for (const file of module.sourceFiles) {
      if (!files.has(file) || owned.has(file)) throw new Error('模块文件越过项目边界或重复归属。');
      owned.add(file);
    }
    for (const key of module.symbolKeys) {
      if (!index.symbols.some((symbol) => symbol.symbolKey === key && module.sourceFiles.includes(symbol.relativePath))) {
        throw new Error('模块符号不属于其声明的文件。');
      }
    }
  }
  for (const module of proposal.modules) {
    if (module.dependsOn.some((id) => id === module.id || !moduleIds.has(id))) throw new Error('模块依赖不存在。');
  }
  for (const edge of proposal.dependencies ?? []) {
    cite(edge.evidenceIds);
    if (!moduleIds.has(edge.moduleId) || !moduleIds.has(edge.dependsOnModuleId) ||
        !proposal.modules.find((m) => m.id === edge.moduleId)?.dependsOn.includes(edge.dependsOnModuleId)) throw new Error('模块依赖与提案不一致。');
  }
  const unassigned = proposal.unassignedFiles ?? [];
  const covered = new Set(owned);
  for (const item of unassigned) {
    if (!files.has(item.path) || covered.has(item.path) || !item.reason?.trim()) throw new Error('未归属文件声明无效。');
    covered.add(item.path);
  }
  if (covered.size !== files.size) throw new Error('模块解析未说明全部项目文件的归属。');
  return { total: files.size, assigned: owned.size, unassigned };
}

/** A durable job is an artifact of kind other; a published result is a separate module-summary.
 * Per-repository serialization prevents competing summary projection replacements.
 */
export class ProjectAnalysisCoordinator implements ProjectAnalysisPort {
  private readonly running = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly options: ProjectAnalysisOptions) {}

  async read(scope: ProjectAnalysisScope): Promise<ProjectAnalysisRecord> {
    const artifacts = await this.options.store.listModuleArtifacts(scope);
    const job = artifacts.find((artifact) => artifact.moduleArtifactId === identity(scope, 'job'));
    const summary = artifacts.find((artifact) => artifact.moduleArtifactId === identity(scope, 'summary'));
    const repository = await this.options.store.getRepository(scope.repositoryId);
    let record = (job?.payload ?? summary?.payload) as ProjectAnalysisRecord | undefined;
    if (!record) return { ...scope, analysisProfile: projectAnalysisProfile, state: 'missing', projection: 'pending', updatedAt: '' };
    record = structuredClone(record);
    if (repository?.activeRevision !== scope.analysisRevision) return { ...record, state: 'stale' };
    if (['queued', 'analyzing', 'validating'].includes(record.state) && !this.running.has(this.key(scope))) {
      return { ...record, state: 'failed', error: '上次解析已中断，可重试。' };
    }
    // A failed forced reanalysis never hides the last valid result.
    if (!record.proposal && summary?.status === 'current') {
      const previous = summary.payload as ProjectAnalysisRecord;
      record.proposal = previous.proposal;
      record.coverage = previous.coverage;
    }
    return record;
  }

  ensure(scope: ProjectAnalysisScope, force = false): Promise<void> {
    const key = this.key(scope);
    const existing = this.running.get(key);
    if (existing) return existing;
    const prior = this.queues.get(scope.repositoryId) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.run(scope, force)).finally(() => {
      this.running.delete(key);
      if (this.queues.get(scope.repositoryId) === operation) this.queues.delete(scope.repositoryId);
      this.options.onChange?.();
    });
    this.running.set(key, operation);
    this.queues.set(scope.repositoryId, operation);
    return operation;
  }

  async idle(): Promise<void> { await Promise.all([...this.running.values()]); }
  private key(scope: ProjectAnalysisScope): string { return `${scope.repositoryId}/${scope.analysisRevision}/${scope.projectId}`; }

  private async run(scope: ProjectAnalysisScope, force: boolean): Promise<void> {
    const store = this.options.store;
    const index = await store.getStructuralIndex(scope);
    if (!index || !index.projects.some((p) => p.projectId === scope.projectId)) return;
    const active = async () => (await store.getRepository(scope.repositoryId))?.activeRevision === scope.analysisRevision;
    if (!await active()) return;
    let record = await this.read(scope);
    if (!force && record.state === 'ready' && record.projection === 'ready') return;
    const persist = async () => {
      record.updatedAt = new Date().toISOString();
      await store.putModuleArtifact(this.artifact(index, record, 'job'));
      this.options.onChange?.();
    };
    try {
      // Projection-only retries do not call the model again.
      if (force || record.state !== 'ready' || !record.proposal) {
        record = { ...scope, analysisProfile: projectAnalysisProfile, state: 'queued', projection: 'pending', updatedAt: '' };
        await persist();
        record.state = 'analyzing';
        await persist();
        const planStarted = performance.now();
        const result = await this.options.plan({ ...scope, objective: projectAnalysisObjective });
        console.info('[forexplore:performance]', JSON.stringify({ stage: 'agent-analysis', ...scope,
          durationMs: Math.round(performance.now() - planStarted) }));
        record.state = 'validating';
        await persist();
        record.coverage = validateProjectResult(index, scope, result);
        if (!await active()) throw new Error('解析期间仓库已更新或移除，请使用最新版本。');
        record.proposal = result.proposal;
        record.planHash = result.evidence.planHash;
        record.state = 'ready';
        // IndexStore performs the active-revision check under the publication lock.
        await store.putModuleArtifact(this.artifact(index, record, 'summary'));
        await persist();
      }
      try {
        const projectionStarted = performance.now();
        await (this.options.project ?? ((value) => new SeekDbProjection(store).projectModuleArtifacts(value, undefined, identity(scope, 'summary'))))(index);
        console.info('[forexplore:performance]', JSON.stringify({ stage: 'summary-projection', ...scope,
          durationMs: Math.round(performance.now() - projectionStarted) }));
        record.projection = 'ready';
        delete record.error;
      } catch (error) {
        record.projection = 'failed';
        record.error = `检索同步失败：${error instanceof Error ? error.message : String(error)}`;
      }
      await persist();
    } catch (error) {
      record.state = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      // Unregistered repositories have been removed; never recreate them from a late result.
      if (await store.getRevision(scope)) await persist();
    }
  }

  private artifact(index: StructuralIndex, record: ProjectAnalysisRecord, kind: 'job' | 'summary'): ModuleArtifactRecord {
    const now = new Date().toISOString();
    return {
      repositoryId: record.repositoryId, analysisRevision: record.analysisRevision,
      moduleArtifactId: identity(record, kind), kind: kind === 'summary' ? 'module-summary' : 'other',
      status: 'current', analysisHash: index.analysisHash, planHash: record.planHash,
      contentHash: createHash('sha256').update(canonical(record)).digest('hex'),
      createdAt: now, updatedAt: now, payload: structuredClone(record),
    };
  }
}
