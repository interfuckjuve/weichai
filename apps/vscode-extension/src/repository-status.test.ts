import { describe, expect, it } from 'vitest';
import type { RepositoryStatus, ServiceStatus } from './ui-types';
import { decorateRepositoryStatuses } from './repository-status';

const baseStatuses: RepositoryStatus[] = [
  {
    path: '/repo/a',
    exists: true,
    readable: true,
    indexed: false,
    stale: false,
    message: '尚未索引',
  },
  {
    path: '/repo/missing',
    exists: false,
    readable: false,
    indexed: false,
    stale: false,
    message: '路径不存在',
  },
];

describe('decorateRepositoryStatuses', () => {
  it('directs usable paths to the code-intelligence status', () => {
    const serviceStatus: ServiceStatus = {
      retrieval: 'connected',
      adaptation: 'connected',
      executionMode: 'real',
    };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[0]).toMatchObject({
      indexed: false,
      stale: false,
      message: '本地路径可读；索引与模块 Summary 状态请查看代码索引区域',
    });
  });

  it('keeps unusable paths untouched', () => {
    const serviceStatus: ServiceStatus = {
      retrieval: 'connected',
      adaptation: 'error',
      executionMode: 'real',
    };
    const decorated = decorateRepositoryStatuses(baseStatuses, serviceStatus);
    expect(decorated[1]).toEqual(baseStatuses[1]);
  });
});
