import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Code2,
  FileCode2,
  GitBranch,
  PackageSearch,
  Sparkles,
} from 'lucide-react';
import type { SearchCandidate } from '@forexplore/contracts';
import type { WorkflowEvent, WorkflowState } from '@forexplore/workflow-core';
import { selectedCandidate } from '@forexplore/workflow-core';

interface CandidatesStageProps {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowEvent>;
  adaptationProvider: 'DeepSeek';
  onSelectCandidate: (candidateId: string) => void;
  onAdapt: () => void;
}

interface RankedCandidate {
  candidate: SearchCandidate;
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
  onSelectCandidate,
  onAdapt,
}: CandidatesStageProps) {
  const candidate = selectedCandidate(state);
  const adapting = state.pending === 'adapt';
  const modules = groupCandidatesByModule(state.candidates);
  const repositoryCount = new Set(state.candidates.map((item) => item.repository)).size;
  const targetLanguage = state.target?.language ?? '目标语言';

  return (
    <div className="stage-stack candidate-stage">
      <section className="candidate-browser" aria-labelledby="candidate-browser-title">
        <header className="candidate-browser-header">
          <div>
            <span>02 · 检索结果</span>
            <h1 id="candidate-browser-title">选择一个可复用实现</h1>
            <p>候选按仓库和模块路径归组，先判断模块上下文，再选择具体类或函数。</p>
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
                          <code title={item.signature}>{item.signature}</code>
                          <span className="candidate-tags">
                            <small>{item.language}</small>
                            <small>{item.kind === 'class' ? '类' : '函数'}</small>
                            <small>{item.license}</small>
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

      {candidate ? <CandidateDetail candidate={candidate} /> : (
        state.candidates.length > 0 ? (
          <section className="candidate-selection-prompt">
            <CheckCircle2 size={16} />
            <span>从上方模块中选择一个具体实现，再确认适配。</span>
          </section>
        ) : null
      )}

      <section className="candidate-decision">
        <div className="candidate-decision-copy">
          <span>适配目标</span>
          <strong>任意候选语言 → {targetLanguage}</strong>
          <small>由 {adaptationProvider} 根据目标签名、需求和所选实现生成适配代码。</small>
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
          disabled={adapting || !candidate}
        >
          {adapting ? <span className="spinner" /> : <Sparkles size={15} />}
          {adapting ? '正在生成适配…' : !candidate ? '请选择一个具体实现' : '使用所选实现生成适配'}
        </button>
      </section>
    </div>
  );
}

function CandidateDetail({ candidate }: { candidate: SearchCandidate }) {
  const module = moduleIdentity(candidate.path);
  return (
    <section className="candidate-detail" aria-label="已选候选详情">
      <header className="candidate-detail-header">
        <div>
          <span>已选实现</span>
          <h2>{candidate.title}</h2>
        </div>
        <strong title="用于排序，不代表正确率">匹配 {Math.round(candidate.score.overall * 100)}</strong>
      </header>

      <div className="candidate-provenance">
        <span><GitBranch size={12} />{candidate.repository}</span>
        <span><Box size={12} />{module.name}</span>
        <span title={candidate.path}><FileCode2 size={12} />{candidate.path}</span>
      </div>

      <p className="candidate-summary">{candidate.summary}</p>
      <pre className="code-preview"><code>{candidate.preview}</code></pre>

      <details className="candidate-evidence">
        <summary>查看匹配依据、依赖与风险</summary>
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
        {candidate.rerankReason ? (
          <p className="candidate-rerank"><Code2 size={12} />重排依据：{candidate.rerankReason}</p>
        ) : null}
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

function groupCandidatesByModule(candidates: SearchCandidate[]): CandidateModuleGroup[] {
  const groups = new Map<string, CandidateModuleGroup>();
  candidates.forEach((candidate, index) => {
    const module = moduleIdentity(candidate.path);
    const id = JSON.stringify([candidate.repository, module.path]);
    const group = groups.get(id) ?? {
      id,
      name: module.name,
      path: module.path,
      repository: candidate.repository,
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
