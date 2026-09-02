import { Check, FilePlus2, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  canApplyAdaptationForRoute,
  evaluateValidationPolicyGate,
} from '@forexplore/workflow-core';
import type { WorkflowStateV2 } from '../v2-workflow';

interface PatchStageProps {
  state: WorkflowStateV2;
  onApply: () => void;
  onBack: () => void;
  onOpenTarget: () => void;
}

export function PatchStage({ state, onApply, onBack, onOpenTarget }: PatchStageProps) {
  const result = state.adaptation;
  if (!result) return null;
  const applying = state.pending === 'apply';
  const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);
  const gate = evaluateValidationPolicyGate(
    result.validationPolicy,
    result.validation,
    { subjectHash: result.patchHash },
  );
  const canApply = canApplyAdaptationForRoute(
    result,
    result.validationPolicy,
    { subjectHash: result.patchHash },
  );
  const visibleValidation = result.validation;

  return (
    <div className="stage-stack">
      <div className="card-heading">
        <span>05 · 校验与回填预览</span>
        <span className="card-heading-meta">
          {result.files.length} files · +{additions} / −{deletions} · {result.route.strategy}
        </span>
      </div>

      {state.applyResult ? (
        <section className="card apply-success" role="status">
          <span className="success-mark">
            <Check size={20} />
          </span>
          <div>
            <h3>补丁已应用到当前目标</h3>
            <p>
              已处理 {state.applyResult.appliedFiles.length} 个文件；检查点：
              <code>{state.applyResult.checkpointId}</code>
              {state.applyResult.rollbackAvailable ? '（可通过命令恢复）' : '（不可恢复）'}
            </p>
            {state.manifest ? <p>V2 清单：<code>{state.manifest.id}</code></p> : null}
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3 className="section-title">
          <ShieldCheck size={14} /> 验证证据
        </h3>
        <ul className="validation-list">
          {visibleValidation.map((item) => (
            <li key={item.id} className={`validation is-${item.status}`}>
              {item.status === 'pass' ? <Check size={13} /> : <TriangleAlert size={13} />}
              <span>
                <strong>{item.label} {item.required ? '（必需）' : '（可选）'}</strong>
                <small>{item.summary}</small>
                {item.command ? <small>命令：<code>{item.command}</code></small> : null}
                {item.failureReason ? <small>原因：{item.failureReason}</small> : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted-copy">
          编译或集成编译通过仅表示相应工程检查通过，尚不证明业务行为、并发、超时或取消语义正确。
        </p>
        {!gate.allowed ? (
          <p className="validation-blocker" role="alert">
            写回已阻止：{gate.blockers.map((item) => item.label).join('、')} 尚未满足。
          </p>
        ) : null}
      </section>

      <section className="card">
        <h3 className="section-title">V2 执行 lineage</h3>
        <p className="muted-copy">
          request <code>{result.requestId}</code> · target <code>{result.targetId}</code>
          {' · '}bundle <code>{result.sourceBundleId}</code> · context <code>{result.targetContextId}</code>
          {' · '}overlay <code>{result.executionLineage.executionOverlayId}</code>
        </p>
      </section>

      {result.files.map((file) => (
        <section className="card file-diff" key={file.path}>
          <header className="file-diff-heading">
            <span>
              <FilePlus2 size={13} /> {file.path}
            </span>
            <span>
              +{file.additions} −{file.deletions}
              <button
                type="button"
                className="text-button"
                onClick={onOpenTarget}
              >
                打开文件
              </button>
            </span>
          </header>
          {file.hunks.map((hunk) => (
            <div className="diff-hunk" key={hunk.header}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, index) => (
                <div className={`diff-line is-${line.type}`} key={`${index}-${line.content}`}>
                  <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                  <code>{line.content || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}

      {!state.applyResult ? (
        <div className="action-row">
          <button type="button" className="secondary-action" onClick={onBack} disabled={applying}>
            返回方案选择
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={onApply}
            disabled={applying || !canApply}
            title={canApply ? '应用已审阅、已验证的当前补丁' : '必需验证尚未通过或尚未验证，不能写回'}
          >
            {applying ? <span className="spinner" /> : <Check size={15} />}
            {applying ? '正在写入工作区…' : '应用补丁到工作区'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
