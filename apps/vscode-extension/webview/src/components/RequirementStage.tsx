import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FolderOpen,
  Search,
  Target as TargetIcon,
} from 'lucide-react';
import type { ModuleTarget } from '@forexplore/contracts';
import type { WorkflowEvent, WorkflowState } from '@forexplore/workflow-core';

interface RequirementStageProps {
  state: WorkflowState;
  target: ModuleTarget;
  dispatch: React.Dispatch<WorkflowEvent>;
  onSearch: () => void;
  onCopyTargetPath: () => void;
  onRevealTarget: () => void;
}

export function RequirementStage({
  state,
  target,
  dispatch,
  onSearch,
  onCopyTargetPath,
  onRevealTarget,
}: RequirementStageProps) {
  const searching = state.pending === 'search';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pathExpanded, setPathExpanded] = useState(false);

  return (
    <form
      className="stage-stack task-definition-stage"
      onSubmit={(event) => {
        event.preventDefault();
        if (!searching) onSearch();
      }}
    >
      <section className="task-composer" aria-labelledby="task-definition-title">
        <header className="task-composer-header">
          <span>01 · 定义任务</span>
          <h1 id="task-definition-title">选择目标，补充你想完成的需求</h1>
          <p>从左侧模块树选择类或方法；需求说明可选，留空时将按代码上下文检索。</p>
        </header>

        <div className="task-composer-content">
          <section className="task-target" aria-label="已选目标">
            <div className="task-section-heading">
              <span>已选目标</span>
              <button
                type="button"
                className="text-button task-detail-toggle"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                {detailsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {detailsOpen ? '收起详情' : '展开详情'}
              </button>
            </div>

            <div className="task-target-summary">
              <span className="task-target-icon"><TargetIcon size={17} /></span>
              <div>
                <strong>{target.name}</strong>
                <span>{target.language} · {target.kind === 'class' ? '类' : '函数'}</span>
              </div>
              <span className={`task-target-status is-${target.implementationStatus ?? 'unknown'}`}>
                {target.implementationStatus === 'implemented'
                  ? '已完成'
                  : target.implementationStatus === 'unimplemented' ? '待实现' : '待确认'}
              </span>
            </div>

            <div className={`task-target-path${pathExpanded ? ' is-expanded' : ''}`}>
              <div className="task-target-path-heading">
                <span>目标路径</span>
                <span className="task-target-path-actions">
                  <button
                    type="button"
                    className="text-button"
                    aria-expanded={pathExpanded}
                    onClick={() => setPathExpanded((expanded) => !expanded)}
                  >
                    {pathExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {pathExpanded ? '收起' : '展开'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label="复制目标路径"
                    title="复制目标路径"
                    onClick={onCopyTargetPath}
                  >
                    <Copy size={12} />复制
                  </button>
                </span>
              </div>
              <button
                type="button"
                className="task-target-location"
                title="在左侧资源管理器中定位"
                onClick={onRevealTarget}
              >
                <FileCode2 size={13} />
                <code>{target.path}{target.line ? `:${target.line}` : ''}</code>
                <FolderOpen size={13} />
              </button>
            </div>

            {detailsOpen ? (
              <div className="task-target-details">
                {target.documentation ? <p>{target.documentation}</p> : null}
                <pre><code>{target.signature}</code></pre>
                <small>从左侧切换目标会重置下游方案和补丁。</small>
              </div>
            ) : null}
          </section>

          <label className="task-requirement">
            <span className="task-section-heading">
              <span>需求补充</span>
              <small>可选</small>
            </span>
            <textarea
              className="requirement-input"
              value={state.requirement}
              onChange={(event) =>
                dispatch({ type: 'SET_REQUIREMENT', value: event.target.value })
              }
              placeholder="例如：保留现有接口，增加文件大小限制和异常处理。"
              rows={6}
              maxLength={8000}
            />
            <span className="requirement-meta">
              <span>用业务目标和约束补充代码上下文</span>
              <span>{state.requirement.length} / 8000</span>
            </span>
          </label>
        </div>

        <footer className="task-composer-footer">
          <span>目标与需求将一起用于历史模块检索</span>
          <button type="submit" className="primary-action" disabled={searching}>
            {searching ? <span className="spinner" /> : <Search size={15} />}
            {searching ? '正在检索相似实现…' : `查找 ${state.topK} 个候选方案`}
          </button>
        </footer>
      </section>
    </form>
  );
}
