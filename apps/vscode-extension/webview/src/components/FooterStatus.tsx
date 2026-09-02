import type { RepositoryStatus, ServiceConnection, ServiceStatus } from '../../../src/ui-types';

export function FooterStatus({
  serviceStatus,
  repositoryStatuses,
  workspaceRoot,
}: {
  serviceStatus: ServiceStatus | null;
  repositoryStatuses: RepositoryStatus[];
  workspaceRoot: string;
}) {
  const unavailable = repositoryStatuses.filter(
    (status) => !status.exists || !status.readable,
  ).length;
  const stale = repositoryStatuses.filter((status) => status.stale).length;
  const repoLabel = repositoryStatuses.length === 0
    ? '未配置仓库'
    : `${repositoryStatuses.length} 仓库`
      + (unavailable > 0 ? ` · ${unavailable} 不可用` : '')
      + (stale > 0 ? ` · ${stale} 过期` : '');

  return (
    <footer className="app-footer">
      <span
        className={serviceDot(serviceStatus?.retrieval)}
        title={serviceStatus?.message ?? ''}
      >
        检索 {serviceLabel(serviceStatus?.retrieval)}
      </span>
      <span
        className={serviceDot(serviceStatus?.adaptation)}
        title={serviceStatus?.message ?? ''}
      >
        迁移适配 {serviceLabel(serviceStatus?.adaptation)}
      </span>
      <span className="footer-repo" title="forexplore.repositoryPaths">
        {repoLabel}
      </span>
      {workspaceRoot ? <code className="footer-workspace">{workspaceRoot}</code> : null}
    </footer>
  );
}

function serviceLabel(availability: ServiceConnection | undefined): string {
  if (availability === 'connected') return '已连接';
  if (availability === 'unconfigured') return '未配置';
  if (availability === 'error') return '异常';
  return '未知';
}

function serviceDot(availability: ServiceConnection | undefined): string {
  if (availability === 'connected') return 'status-dot is-connected';
  if (availability === 'unconfigured') return 'status-dot is-unconfigured';
  if (availability === 'error') return 'status-dot is-error';
  return 'status-dot is-unconfigured';
}
