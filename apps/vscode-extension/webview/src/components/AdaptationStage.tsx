import type { SearchCandidate } from '@forexplore/contracts';
import type { WorkflowState } from '@forexplore/workflow-core';
import type { TargetWorkspaceMigrationRouteOption } from '../../../src/protocol/messages';

export function AdaptationStage({
  state,
  candidate,
  routeOption,
}: {
  state: WorkflowState;
  candidate: SearchCandidate | null;
  routeOption: TargetWorkspaceMigrationRouteOption | null;
}) {
  const logs = [
    '已读取目标契约与候选实现',
    '正在生成接口映射（参数 / 返回 / 错误语义）',
    '正在按已声明路线生成目标实现',
    '执行编译与集成编译（如服务已配置）',
    '生成工作区补丁预览',
  ];
  const current = Math.min(logs.length - 1, state.pending === 'adapt' ? 3 : logs.length - 1);

  return (
    <div className="processing">
      <div className="processing-ring" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">CodeAdaptationPort</div>
      <h2>正在生成接口映射与目标实现</h2>
      <p>
        路线：{routeOption
          ? `${routeOption.route.strategy} · ${routeOption.route.id}@${routeOption.route.version}`
          : '未声明（已禁止执行）'}
        {' · '}{candidate?.language ?? '?'} → {routeOption?.route.targetLanguageId ?? state.target?.language}
      </p>
      <p className="muted-copy">编译结果是工程检查证据，不等同于业务行为正确性。</p>
      <ol className="processing-log">
        {logs.map((log, index) => (
          <li key={log} className={index <= current ? 'is-active' : ''}>
            {log}
          </li>
        ))}
      </ol>
    </div>
  );
}
