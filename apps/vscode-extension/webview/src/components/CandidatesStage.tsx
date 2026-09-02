import { Sparkles } from 'lucide-react';
import type { WorkflowEvent, WorkflowState } from '@forexplore/workflow-core';
import { selectedCandidate } from '@forexplore/workflow-core';
import { normalizeLanguageId } from '@forexplore/contracts';
import type { TargetWorkspaceMigrationSelection } from '../../../src/protocol/messages';

interface CandidatesStageProps {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowEvent>;
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
  const candidate = selectedCandidate(state);
  const adapting = state.pending === 'adapt';
  const sourceLanguageId = candidate ? normalizedLanguageId(candidate.language) : null;
  const routeOption = sourceLanguageId === null ? null : migrationSelection?.routeOptions.find(
    ({ route }) =>
      route.sourceLanguageId === sourceLanguageId &&
      route.targetLanguageId === migrationSelection.target.entity.languageId,
  ) ?? null;
  const canAdapt = candidate !== null && routeOption !== null;

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
                  {item.language} · {item.repository} · {item.kind}
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
          <pre className="code-preview">{candidate.preview}</pre>
          {candidate.rerankReason ? <p className="muted-copy">重排依据：{candidate.rerankReason}</p> : null}
          <details className="detail-fold">
            <summary>依赖与风险</summary>
            <dl className="risk-list">
              <div>
                <dt>依赖</dt>
                <dd>{candidate.dependencies.join('、') || '无'}</dd>
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
              {candidate?.language ?? '?'} → {migrationSelection?.target.entity.languageId ?? state.target?.language ?? '?'}
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
        disabled={adapting || !canAdapt}
      >
        {adapting ? <span className="spinner" /> : <Sparkles size={15} />}
          {adapting
            ? '正在生成迁移实现…'
            : !candidate
              ? '请先明确选择一个候选'
              : !routeOption
                ? '当前语言对无可执行路线'
                : '确认此路线并生成实现'}
      </button>
      </section>
    </div>
  );
}

function normalizedLanguageId(value: string): string | null {
  try {
    return normalizeLanguageId(value);
  } catch {
    return null;
  }
}
