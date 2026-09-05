import type { RepositoryStatus, ServiceStatus } from './ui-types';

/**
 * A readable local directory is not evidence that its current revision and
 * project summaries are ready. Keep that distinction visible in the UI.
 */
export function decorateRepositoryStatuses(
  statuses: RepositoryStatus[],
  _serviceStatus: ServiceStatus,
): RepositoryStatus[] {
  return statuses.map((status) => {
    if (!status.exists || !status.readable) return status;
    return {
      ...status,
      indexed: false,
      stale: false,
      message: '本地路径可读；索引与模块 Summary 状态请查看代码索引区域',
    };
  });
}
