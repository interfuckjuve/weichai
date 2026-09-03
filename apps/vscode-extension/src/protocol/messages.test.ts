import { describe, expect, it } from 'vitest';
import { isWebviewToHostMessage } from './messages';

describe('Webview message boundary', () => {
  it('accepts bounded intent messages', () => {
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '迁移报价缓存',
        topK: 4,
      }),
    ).toBe(true);
    expect(isWebviewToHostMessage({ type: 'SELECT_CANDIDATE', candidateId: 'java-quote-cache' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'APPLY_CURRENT_RUN' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'REFRESH_MODULE_EXPLORER' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'PICK_REPOSITORY_PATH' })).toBe(true);
    expect(isWebviewToHostMessage({
      type: 'SELECT_HISTORY_REPOSITORY',
      repositoryRegistrationId: 'history:one',
    })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'COPY_TARGET_PATH' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'REVEAL_TARGET_IN_EXPLORER' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'OPEN_TARGET' })).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 6, repositoryPaths: ['D:/history/one', 'D:/history/two'] },
      }),
    ).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_TARGET_ENTITY',
        snapshotId: 'snapshot-1',
        contentHash: 'a'.repeat(64),
        nodeId: 'node:callable:pay',
        entityId: 'callable:pay',
      }),
    ).toBe(true);
    expect(isWebviewToHostMessage({
      type: 'SELECT_HISTORY_MODULE',
      repositoryRegistrationId: 'history:one',
      repositoryId: 'repo-1',
      catalogId: 'catalog-1',
      catalogHash: 'b'.repeat(64),
      moduleId: 'payments',
    })).toBe(true);
    expect(isWebviewToHostMessage({
      type: 'RUN_MODULE_WORKSPACE_ACTION',
      workspaceId: 'history:one',
      action: 'withdraw-history-publication',
    })).toBe(true);
  });

  it('rejects a Webview-supplied target, patch, file path, or old protocol action', () => {
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '',
        topK: 4,
        request: { target: { path: '../../outside.cs' } },
      }),
    ).toBe(false);
    expect(isWebviewToHostMessage({ type: 'APPLY_PATCHES', files: [] })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'OPEN_FILE', path: '/tmp/secret', line: 1 })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'COPY_TARGET_PATH', path: '../../outside.cs' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'REVEAL_TARGET_IN_EXPLORER', path: '../../outside.cs' })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_WORKSPACE_TARGET',
        targetId: 'workspace://safe.cs#L1',
        path: '../../outside.cs',
      }),
    ).toBe(false);
  });

  it('rejects unbounded or malformed intent payloads', () => {
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: 'x'.repeat(8_001),
        topK: 4,
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'START_SEARCH',
        requirement: '',
        topK: 11,
      }),
    ).toBe(false);
    expect(isWebviewToHostMessage({ type: 'SELECT_CANDIDATE', candidateId: '' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'SELECT_WORKSPACE_TARGET', targetId: '' })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'OPEN_REPOSITORY_SETTINGS' })).toBe(false);
    expect(isWebviewToHostMessage({
      type: 'SELECT_HISTORY_REPOSITORY',
      repositoryRegistrationId: '',
    })).toBe(false);
    expect(isWebviewToHostMessage({
      type: 'SELECT_HISTORY_MODULE',
      repositoryRegistrationId: 'history:one',
      repositoryId: 'repo-1',
      catalogId: 'catalog-1',
      catalogHash: 'not-a-hash',
      moduleId: 'payments',
    })).toBe(false);
    expect(isWebviewToHostMessage({
      type: 'RUN_MODULE_WORKSPACE_ACTION',
      workspaceId: 'history:one',
      action: 'delete-history-repository',
    })).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 0, repositoryPaths: [] },
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 4, repositoryPaths: Array.from({ length: 21 }, (_, index) => `D:/repo-${index}`) },
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 4, repositoryPaths: [''] },
      }),
    ).toBe(false);
  });
});
