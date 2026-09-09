import { describe, expect, it } from 'vitest';
import { isWebviewToHostMessage } from './messages';

describe('Webview message boundary', () => {
  it('accepts only scoped bounded module page intent without filesystem overrides', () => {
    const message = { type: 'LOAD_MODULE_CHILDREN', requestId: 'page-1', request: {
      repositoryId: 'repo-1', analysisRevision: 'revision-1', projectId: 'project-1', nodeId: 'file:src/index.ts', offset: 80,
    } };
    expect(isWebviewToHostMessage(message)).toBe(true);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, nodeId: '$search', query: 'run', status: 'all' } })).toBe(true);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, path: '/private' } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, offset: -1 } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, query: 'x'.repeat(201) } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, status: 'unsupported' } })).toBe(false);
  });

  it('accepts version-bound task intent and rejects extra roots, invalid granularity and client budgets', () => {
    const message = { type: 'START_TASK_SEARCH', requestId: 'request-1',
      targetScope: { repositoryId: 'repo-1', analysisRevision: 'analysis-1', projectId: 'project-1' },
      request: { requirement: '限制上传大小', scope: 'target', granularity: 'function' } };
    expect(isWebviewToHostMessage(message)).toBe(true);
    expect(isWebviewToHostMessage({ ...message, targetScope: { ...message.targetScope, localPath: '/tmp/private' } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, granularity: 'directory' } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, budget: { maxTokens: 4000 } } })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, request: { ...message.request, requirement: ' ' } })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'CANCEL_TASK_SEARCH', requestId: 'request-1' })).toBe(true);
  });
  it('accepts bounded intent messages', () => {
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'browse' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'input' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'workspace' })).toBe(true);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: ['workspace'] })).toBe(false);
    expect(isWebviewToHostMessage({ type: 'ADD_TARGET_WORKSPACE', mode: 'input', path: '/tmp' })).toBe(false);
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
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: 'revision-33b87b6a',
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
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: 'revision-33b87b6a',
        localPath: 'C:\\private\\repository',
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'C:\\private\\repository',
        analysisRevision: 'revision-33b87b6a',
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
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: '',
      }),
    ).toBe(false);
    expect(
      isWebviewToHostMessage({
        type: 'SELECT_CODE_INTELLIGENCE_REVISION',
        repositoryId: 'repo-2dd9d4a2',
        analysisRevision: '../revision',
      }),
    ).toBe(false);
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
