import type {
  CodeIntelligencePresentation,
  RepositoryStatus,
  ServiceConnection,
  ServiceStatus,
} from '../../../src/ui-types';

export function FooterStatus({
  serviceStatus,
  repositoryStatuses,
  codeIntelligence,
  workspaceRoot,
}: {
  serviceStatus: ServiceStatus | null;
  repositoryStatuses: RepositoryStatus[];
  codeIntelligence: CodeIntelligencePresentation | null;
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
  const indexLabel = codeIntelligenceLabel(codeIntelligence);

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
        翻译 {serviceLabel(serviceStatus?.adaptation)}
      </span>
      <span className="footer-repo" title="forexplore.repositoryPaths">
        {repoLabel}
      </span>
      <span
        className={codeIntelligenceDot(codeIntelligence)}
        title={codeIntelligence?.message ?? '版本化代码智能索引'}
      >
        {indexLabel}
      </span>
      {workspaceRoot ? <code className="footer-workspace">{workspaceRoot}</code> : null}
    </footer>
  );
}

function codeIntelligenceLabel(presentation: CodeIntelligencePresentation | null): string {
  if (!presentation) return '代码索引 初始化中';
  if (presentation.status === 'initializing') return '代码索引 初始化中';
  if (presentation.status === 'error') return '代码索引 异常';
  const staleSummaries = presentation.repositories.filter((repository) => repository.summary.status === 'stale').length;
  const semanticLanguages = presentation.repositories.flatMap((repository) => repository.languages)
    .filter((language) => language.capabilityLevel === 'semantic').length;
  return `${presentation.storage === 'seekdb' ? 'SeekDB' : '内存'} 索引 ${presentation.repositories.length} 仓库`
    + (semanticLanguages > 0 ? ` · ${semanticLanguages} 语义语言` : '')
    + (staleSummaries > 0 ? ` · ${staleSummaries} Summary 过期` : '');
}

function codeIntelligenceDot(presentation: CodeIntelligencePresentation | null): string {
  if (!presentation || presentation.status === 'initializing') return 'status-dot is-unconfigured';
  if (presentation.status === 'error') return 'status-dot is-error';
  return 'status-dot is-connected';
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
