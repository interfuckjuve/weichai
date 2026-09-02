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
    expect(isWebviewToHostMessage({ type: 'COPY_TARGET_PATH' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'REVEAL_TARGET_IN_EXPLORER' })).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SAVE_SETTINGS',
        settings: { topK: 6, repositoryPaths: ['D:/history/one', 'D:/history/two'] },
      }),
    ).toBe(true);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_WORKSPACE_TARGET',
        targetId: 'workspace://src/PaymentService.cs#L42',
      }),
    ).toBe(true);
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
