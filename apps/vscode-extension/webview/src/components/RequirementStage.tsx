import { RefreshCw, Search } from 'lucide-react';
import type { ModuleTarget } from '@forexplore/contracts';
import type { WorkflowEvent, WorkflowState } from '@forexplore/workflow-core';
import type { RepositoryStatus } from '../../../src/ui-types';

interface RequirementStageProps {
  state: WorkflowState;
  target: ModuleTarget;
  dispatch: React.Dispatch<WorkflowEvent>;
  repositoryStatuses: RepositoryStatus[];
  onSearch: () => void;
  onCheckRepositories: () => void;
}

export function RequirementStage({
  state,
  target,
  dispatch,
  repositoryStatuses,
  onSearch,
  onCheckRepositories,
}: RequirementStageProps) {
  const searching = state.pending === 'search';
  const repositorySummary = summarizeRepositories(repositoryStatuses);

  return (
    <div className="stage-stack">
      <section className="card target-edit-card">
        <div className="card-heading">
          <span>01 · 迁移目标</span>
          <span className="card-heading-meta">
            {target.language} · {target.kind}
          </span>
        </div>
        <div className="target-edit-fields target-readonly-fields">
          <div>
            <span>符号名</span>
            <strong>{target.name}</strong>
          </div>
          <div>
            <span>类型</span>
            <strong>{target.kind}</strong>
          </div>
          <div className="target-signature-field">
            <span>签名</span>
            <code>{target.signature}</code>
          </div>
        </div>
        <div className="target-location">
          <code>{target.path}</code>
          <span>第 {target.line} 行</span>
        </div>
        <p className="muted-copy">
          目标由扩展宿主从已保存的编辑器选择建立快照。若要更换目标，请返回编辑器重新启动迁移。
        </p>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>02 · 描述需求</span>
          <span className="card-heading-meta">可选</span>
        </div>
        <textarea
          className="requirement-input"
          value={state.requirement}
          onChange={(event) =>
            dispatch({ type: 'SET_REQUIREMENT', value: event.target.value })
          }
          placeholder="例如：解析 multipart 请求并保留字段顺序、文件阈值和大小限制；保持现有接口不变。留空时按目标名称、签名与注释检索。"
          rows={4}
        />
        <div className="requirement-meta">
          <span>{state.requirement.length} 字符</span>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>混合检索</span>
        </div>
        <label className="range-field">
          <span>
            返回方案数 <strong>Top {state.topK}</strong>
          </span>
          <input
            type="range"
            min="2"
            max="5"
            value={state.topK}
            onChange={(event) =>
              dispatch({ type: 'SET_TOP_K', value: Number(event.target.value) })
            }
          />
        </label>
      </section>

      <section className="card">
        <div className="card-heading">
          <span>检索仓库</span>
          <button
            type="button"
            className="text-button"
            onClick={onCheckRepositories}
            disabled={searching}
          >
            <RefreshCw size={12} /> 重新检查
          </button>
        </div>
        {repositoryStatuses.length === 0 ? (
          <p className="muted-copy">
            未配置本地路径。检索范围由真实服务端已有索引决定。
          </p>
        ) : (
          <ul className="repository-list">
            {repositoryStatuses.map((status) => (
              <li
                key={status.path}
                className={`repository-item is-${statusClass(status)}`}
                title={status.message}
              >
                <span className="repository-dot" />
                <code>{status.path}</code>
                <span className="repository-state">{status.message}</span>
              </li>
            ))}
          </ul>
        )}
        {repositorySummary ? <p className="muted-copy">{repositorySummary}</p> : null}
      </section>

      <button
        type="button"
        className="primary-action"
        onClick={onSearch}
        disabled={searching}
      >
        {searching ? <span className="spinner" /> : <Search size={15} />}
        {searching ? '正在检索相似实现…' : '检索相似实现'}
      </button>
    </div>
  );
}

function statusClass(status: RepositoryStatus): string {
  if (!status.exists || !status.readable) return 'error';
  if (status.stale) return 'stale';
  if (!status.indexed) return 'pending';
  return 'ok';
}

function summarizeRepositories(statuses: RepositoryStatus[]): string | null {
  if (statuses.length === 0) return null;
  const unavailable = statuses.filter((status) => !status.exists || !status.readable).length;
  const stale = statuses.filter((status) => status.stale).length;
  const pending = statuses.filter((status) => !status.indexed && !status.stale).length;
  const parts: string[] = [];
  if (unavailable > 0) parts.push(`${unavailable} 个不可用`);
  if (stale > 0) parts.push(`${stale} 个索引过期`);
  if (pending > 0) parts.push(`${pending} 个本地路径尚未由服务端确认索引`);
  return parts.length > 0 ? `仓库提示：${parts.join('、')}。` : '本地路径可读；服务端索引范围另行确认。';
}
