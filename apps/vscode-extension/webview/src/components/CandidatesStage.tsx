import {
  AlertTriangle,
  Box,
  CheckCircle2,
  FileCode2,
  GitBranch,
  PackageSearch,
  Sparkles,
} from 'lucide-react';
import type {
  SearchCandidateV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';
import type { TargetWorkspaceMigrationSelection } from '../../../src/protocol/messages';
import {
  selectedCandidateV2,
  type WorkflowEventV2,
  type WorkflowStateV2,
} from '../v2-workflow';

interface CandidatesStageProps {
  state: WorkflowStateV2;
  dispatch: React.Dispatch<WorkflowEventV2>;
  adaptationProvider: 'DeepSeek';
  migrationSelection: TargetWorkspaceMigrationSelection | null;
  onSelectCandidate: (candidateId: string) => void;
  onAdapt: () => void;
}

interface RankedCandidate {
  candidate: SearchCandidateV2;
  rank: number;
}

interface CandidateModuleGroup {
  id: string;
  name: string;
  path: string;
  repository: string;
  candidates: RankedCandidate[];
}

const scoreLabels = {
  semantic: '语义',
  symbol: '符号',
  contract: '契约',
} as const;

export function CandidatesStage({
  state,
  dispatch,
  adaptationProvider,
  migrationSelection,
  onSelectCandidate,
  onAdapt,
}: CandidatesStageProps) {
  const candidate = selectedCandidateV2(state);
  const adapting = state.pending === 'adapt';
  const resolving = state.pending === 'resolve';
  const modules = groupCandidatesByModule(state.candidates);
  const repositoryCount = new Set(
    state.candidates.map((item) => item.candidate.lineage.repositoryId),
  ).size;
  const targetLanguage =
    migrationSelection?.target.entity.languageId ??
    state.target?.entity.languageId ??
    '目标语言';
  const sourceLanguageId = candidate?.candidate.entity.languageId ?? null;
  const routeOption = sourceLanguageId === null ? null : migrationSelection?.routeOptions.find(
    ({ route }) =>
      route.sourceLanguageId === sourceLanguageId &&
      route.targetLanguageId === targetLanguage,
  ) ?? null;
  const canAdapt = candidate !== null && routeOption !== null && state.sourceBundle !== null;

  return (
    <div className="stage-stack candidate-stage">
      <section className="candidate-browser" aria-labelledby="candidate-browser-title">
        <header className="candidate-browser-header">
          <div>
            <span>02 · 检索结果</span>
            <h1 id="candidate-browser-title">选择一个可复用实现</h1>
            <p>候选按仓库和模块路径归组，先判断模块上下文，再选择具体实现。</p>
          </div>
          <div className="candidate-result-stats" aria-label="检索结果规模">
            <span><strong>{repositoryCount}</strong> 仓库</span>
            <span><strong>{modules.length}</strong> 模块</span>
            <span><strong>{state.candidates.length}</strong> 候选</span>
          </div>
        </header>

        {modules.length > 0 ? (
          <div className="candidate-module-list">
            {modules.map((module) => (
              <section className="candidate-module-group" key={module.id}>
                <header className="candidate-module-header">
                  <span className="candidate-module-icon"><Box size={15} /></span>
                  <div>
                    <strong>{module.name}</strong>
                    <span>{module.repository}</span>
                    <code title={module.path}>{module.path}</code>
                  </div>
                  <small>{module.candidates.length} 个实现</small>
                </header>
                <div className="candidate-module-items">
                  {module.candidates.map(({ candidate: item, rank }) => {
                    const active = item.id === state.selectedCandidateId;
                    const entity = item.candidate.entity;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={`candidate-item${active ? ' is-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => onSelectCandidate(item.id)}
                      >
                        <span className="candidate-rank">{String(rank).padStart(2, '0')}</span>
                        <span className="candidate-copy">
                          <strong>{item.title}</strong>
                          <code title={entity.signature ?? entity.qualifiedName ?? entity.name}>
                            {entity.signature ?? entity.qualifiedName ?? entity.name}
                          </code>
                          <span className="candidate-tags">
                            <small>{entity.languageId}</small>
                            <small>{entityKindLabel(entity.kind)}</small>
                            <small>{item.candidate.license ?? '许可证未声明'}</small>
                          </span>
                        </span>
                        <span className="candidate-score" title="用于候选排序，不是正确率或兼容概率">
                          <small>匹配</small>
                          <strong>{Math.round(item.score.overall * 100)}</strong>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="candidate-empty" role="status">
            <PackageSearch size={24} />
            <strong>没有找到可复用实现</strong>
            <span>返回“定义任务”调整目标或需求后重新检索。</span>
          </div>
        )}
      </section>

      {candidate ? (
        <CandidateDetail candidate={candidate} sourceBundle={state.sourceBundle} />
      ) : state.candidates.length > 0 ? (
        <section className="candidate-selection-prompt">
          <CheckCircle2 size={16} />
          <span>从上方模块中选择一个具体实现，系统会自动解析并复验完整源码。</span>
        </section>
      ) : null}

      <section className="candidate-decision card decision-card">
        <div className="candidate-decision-copy">
          <span>迁移路线</span>
          <strong>{sourceLanguageId ?? '?'} → {targetLanguage}</strong>
          {routeOption ? (
            <>
              <small>
                {routeOption.route.strategy} · {routeOption.route.id}@{routeOption.route.version}
                {' · '}{adaptationProvider}
              </small>
              <small>
                {state.sourceBundle
                  ? `完整来源已自动解析：${state.sourceBundle.id}`
                  : resolving
                    ? '系统正在从当前有效索引解析完整来源…'
                    : '选择候选后，系统将自动解析完整来源。'}
              </small>
              {routeOption.warnings.length > 0 ? (
                <small>{routeOption.warnings.join('；')}</small>
              ) : null}
            </>
          ) : (
            <small>
              {candidate
                ? '没有与当前源/目标语言精确匹配的可执行路线；系统已阻止生成。'
                : '选择候选后，系统将自动检查精确迁移路线。'}
            </small>
          )}
        </div>
        <label>
          <span>人工备注 / 额外约束 <small>可选</small></span>
          <input
            type="text"
            value={state.decisionNotes}
            onChange={(event) =>
              dispatch({ type: 'SET_DECISION_NOTES', value: event.target.value })
            }
            placeholder="例如：依赖必须通过构造函数注入；禁止新增全局状态。"
          />
        </label>
        <button
          type="button"
          className="primary-action"
          onClick={onAdapt}
          disabled={adapting || resolving || !canAdapt}
        >
          {adapting ? <span className="spinner" /> : <Sparkles size={15} />}
          {adapting
            ? '正在生成迁移实现…'
            : resolving
              ? '正在解析完整来源…'
              : !candidate
                ? '请选择一个具体实现'
                : !state.sourceBundle
                  ? '完整来源尚未复验'
                  : !routeOption
                    ? '当前语言对不可执行'
                    : '使用所选实现生成适配'}
        </button>
      </section>
    </div>
  );
}

function CandidateDetail({
  candidate,
  sourceBundle,
}: {
  candidate: SearchCandidateV2;
  sourceBundle: SourceImplementationBundleV2 | null;
}) {
  const path = candidate.candidate.entity.path ?? candidate.indexGeneration.sourceCatalogId;
  const module = moduleIdentity(path);
  const dependencies = sourceBundle?.dependencyIds ?? [];
  return (
    <section className="candidate-detail" aria-label="已选候选详情">
      <header className="candidate-detail-header">
        <div>
          <span>已选实现</span>
          <h2>{candidate.title}</h2>
        </div>
        <strong title="用于排序，不代表正确率">
          匹配 {Math.round(candidate.score.overall * 100)}
        </strong>
      </header>

      <div className="candidate-provenance">
        <span><GitBranch size={12} />{candidate.candidate.lineage.repositoryId}</span>
        <span><Box size={12} />{module.name}</span>
        <span title={path}><FileCode2 size={12} />{path}</span>
      </div>

      <p className="candidate-summary">{candidate.summary}</p>
      {candidate.preview ? <pre className="code-preview"><code>{candidate.preview}</code></pre> : null}

      <details className="candidate-evidence">
        <summary>查看匹配依据、来源与风险</summary>
        <div className="score-bars">
          {(['semantic', 'symbol', 'contract'] as const).map((key) => (
            <div className="score-row" key={key}>
              <span>{scoreLabels[key]}</span>
              <span className="score-track">
                <span
                  className="score-fill"
                  style={{ width: `${Math.round(candidate.score[key] * 100)}%` }}
                />
              </span>
              <strong>{Math.round(candidate.score[key] * 100)}</strong>
            </div>
          ))}
        </div>
        <dl className="risk-list">
          <div>
            <dt>索引版本</dt>
            <dd>
              {candidate.indexGeneration.sourceCatalogId}@{candidate.indexGeneration.generation}
            </dd>
          </div>
          <div>
            <dt>依赖</dt>
            <dd>{dependencies.join('、') || (sourceBundle ? '无' : '完整来源解析中')}</dd>
          </div>
          <div>
            <dt>兼容性</dt>
            <dd>{candidate.compatibility.join('；') || '—'}</dd>
          </div>
          <div>
            <dt>风险</dt>
            <dd className={candidate.risks.length > 0 ? 'has-risk' : ''}>
              {candidate.risks.length > 0 ? <AlertTriangle size={12} /> : null}
              {candidate.risks.join('；') || '未发现已知风险'}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function groupCandidatesByModule(candidates: SearchCandidateV2[]): CandidateModuleGroup[] {
  const groups = new Map<string, CandidateModuleGroup>();
  candidates.forEach((candidate, index) => {
    const repository = candidate.candidate.lineage.repositoryId;
    const path = candidate.candidate.entity.path ?? candidate.indexGeneration.sourceCatalogId;
    const module = moduleIdentity(path);
    const id = JSON.stringify([repository, module.path]);
    const group = groups.get(id) ?? {
      id,
      name: module.name,
      path: module.path,
      repository,
      candidates: [],
    };
    group.candidates.push({ candidate, rank: index + 1 });
    groups.set(id, group);
  });
  return [...groups.values()];
}

function moduleIdentity(candidatePath: string): { name: string; path: string } {
  const normalized = candidatePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  const directoryParts = parts.slice(0, -1);
  if (directoryParts.length === 0) return { name: '仓库根模块', path: '/' };
  return {
    name: directoryParts.at(-1) ?? '仓库根模块',
    path: directoryParts.join('/'),
  };
}

function entityKindLabel(kind: string): string {
  if (['class', 'record', 'struct', 'interface'].includes(kind)) return '类型';
  if (['function', 'method', 'callable'].includes(kind)) return '函数';
  return kind;
}
