import { Sparkles } from 'lucide-react';
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
  const sourceLanguageId = candidate?.candidate.entity.languageId ?? null;
  const routeOption = sourceLanguageId === null ? null : migrationSelection?.routeOptions.find(
    ({ route }) =>
      route.sourceLanguageId === sourceLanguageId &&
      route.targetLanguageId === migrationSelection.target.entity.languageId,
  ) ?? null;
  const canAdapt = candidate !== null && routeOption !== null && state.sourceBundle !== null;

  return (
    <div className="stage-stack">
      <div className="card-heading candidates-heading">
        <span>03 · 候选方案</span>
        <span className="card-heading-meta">Top {state.candidates.length}</span>
      </div>

      <div className="candidate-list">
        {state.candidates.map((item, index) => {
          const active = item.id === state.selectedCandidateId;
          return (
            <button
              type="button"
              key={item.id}
              className={`candidate-item ${active ? 'is-active' : ''}`}
              onClick={() => onSelectCandidate(item.id)}
            >
              <span className="candidate-rank">{String(index + 1).padStart(2, '0')}</span>
              <span className="candidate-copy">
                <strong>{item.title}</strong>
                <span>
                  {item.candidate.entity.languageId} · {item.candidate.lineage.repositoryId}
                  {' · '}{item.candidate.entity.kind}
                </span>
              </span>
              <span className="candidate-score" title="用于候选排序，不是正确率或兼容概率">
                排序 {Math.round(item.score.overall * 100)}
              </span>
            </button>
          );
        })}
      </div>

      {candidate ? (
        <section className="card candidate-detail">
          <div className="candidate-detail-header">
            <h3>{candidate.title}</h3>
            <strong title="用于排序，不代表正确率">排序分 {Math.round(candidate.score.overall * 100)}</strong>
          </div>
          <p className="candidate-summary">{candidate.summary}</p>
          <div className="score-bars">
            {(['semantic', 'symbol', 'contract'] as const).map((key) => (
              <div className="score-row" key={key}>
                <span>{key}</span>
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
          {candidate.preview ? <pre className="code-preview">{candidate.preview}</pre> : null}
          <details className="detail-fold">
            <summary>目录、兼容性与风险</summary>
            <dl className="risk-list">
              <div>
                <dt>来源目录</dt>
                <dd>{candidate.indexGeneration.sourceCatalogId}@{candidate.indexGeneration.generation}</dd>
              </div>
              <div>
                <dt>兼容性</dt>
                <dd>{candidate.compatibility.join('；') || '—'}</dd>
              </div>
              <div>
                <dt>风险</dt>
                <dd>{candidate.risks.join('；') || '—'}</dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}

      <section className="card decision-card">
        <div className="decision-fields">
          <div className="decision-static">
            <span>迁移路线</span>
            <strong>
              {candidate?.candidate.entity.languageId ?? '?'} → {migrationSelection?.target.entity.languageId ?? state.target?.entity.languageId ?? '?'}
            </strong>
            {routeOption ? (
              <>
                <small>
                  {routeOption.route.strategy} · {routeOption.route.id}@{routeOption.route.version}
                  {' · '}{routeOption.route.stages.map((stage) =>
                    `${stage.stage}:${stage.availability.status}`,
                  ).join('、') || '未列出阶段'}
                  {' · '}{adaptationProvider}
                </small>
                <small>
                  {state.sourceBundle
                    ? `完整来源 bundle 已解析：${state.sourceBundle.id}`
                    : resolving
                      ? '正在按 active index generation 解析完整来源 bundle…'
                      : '必须先解析并复验完整来源 bundle，预览不能作为迁移输入。'}
                </small>
                <small>
                  已审映射 {migrationSelection!.moduleMapping.mappingProposalId}
                  {' · review '}{migrationSelection!.moduleMapping.mappingReviewId}
                  {' · overlay '}{migrationSelection!.moduleMapping.executionOverlayId}
                  {' · runtime '}{migrationSelection!.moduleMapping.runtimeCapabilitySnapshot.id}
                </small>
              </>
            ) : (
              <small>没有与当前源/目标语言精确匹配的可执行路线；默认禁止生成。</small>
            )}
          </div>
          <label>
            <span>人工备注 / 额外约束</span>
            <input
              type="text"
              value={state.decisionNotes}
              onChange={(event) =>
                dispatch({ type: 'SET_DECISION_NOTES', value: event.target.value })
              }
              placeholder="例如：缓存必须通过构造函数注入；禁止新增全局状态。"
            />
          </label>
        </div>
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
              ? '正在解析完整来源实现…'
              : !candidate
              ? '请先明确选择一个候选'
              : !state.sourceBundle
                ? '完整来源实现尚未复验'
              : !routeOption
                ? '当前语言对无可执行路线'
                : '确认此路线并生成实现'}
      </button>
      </section>
    </div>
  );
}
