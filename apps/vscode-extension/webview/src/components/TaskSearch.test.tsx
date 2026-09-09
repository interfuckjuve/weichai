import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { formatContextMarkdown, type ContextPacket } from '@forexplore/contracts';
import { TaskSearch } from './TaskSearch';
import { createTaskSearchProvider } from '../task-search-provider';
import type { MessageBus } from '../vscode-api';
import type { HostToWebviewMessage, TaskSearchIntent, WebviewToHostMessage } from '../../../src/protocol/messages';

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function packet(): ContextPacket {
  const scope = { repositoryId: 'repo-upload', analysisRevision: 'analysis-1' };
  const value: ContextPacket = {
    packetId: 'packet-1', requestId: 'request-1', requirement: '限制上传大小', status: 'partial',
    snapshots: [{ ...scope, repositoryName: 'Upload', analysisHash: 'hash-1' }],
    routing: { requestedGranularity: 'function', resolvedGranularities: ['function'], source: 'user', reason: '指定函数' },
    results: [{ ...scope, id: 'parse', name: 'parseRequest', granularity: 'function', score: .8, reason: '上传入口' }],
    evidence: [
      { ...scope, evidenceId: 'evidence-parse', name: 'parseRequest', role: 'implementation', relativePath: 'src/upload.ts',
        sourceRange: { startLine: 30, startColumn: 1, endLine: 31, endColumn: 1 }, contentHash: 'content-1', fileHash: 'file-1',
        content: 'function parseRequest() { return checkLimit(); }', reason: '上传入口', provider: 'tree-sitter', evidenceLevel: 'structural', truncated: false },
      { ...scope, evidenceId: 'evidence-item', name: 'FileItem', role: 'interface', relativePath: 'src/item.ts',
        sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, contentHash: 'content-2', fileHash: 'file-2',
        content: 'interface FileItem { size: number }', reason: '文件类型契约', provider: 'tree-sitter', evidenceLevel: 'structural', truncated: false },
    ],
    relations: [], gaps: [{ code: 'UNRESOLVED', message: '外部依赖未解析' }], markdown: '',
    usage: { tokenizer: 'cl100k_base', tokens: 555, maxTokens: 4000, characters: 1800, files: 2, sourceLines: 2, latencyMs: 85 },
  };
  value.markdown = formatContextMarkdown(value);
  return value;
}

async function render(search: Parameters<typeof TaskSearch>[0]['search']) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<TaskSearch project="Upload" search={search} onMigrate={() => {}} />));
  return container;
}

async function enterRequirement(container: HTMLElement, value = '限制上传大小') {
  await act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('sends only task intent, shows evidence without token controls, and exports selected evidence', async () => {
  const response = packet();
  const search = vi.fn(async () => response);
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const container = await render(search);
  expect(container.querySelector('input[type="number"], input[type="range"]')).toBeNull();
  expect(container.textContent).not.toMatch(/token|上下文预算/i);
  expect(container.querySelector<HTMLOptionElement>('option[value="subsystem"]')?.disabled).toBe(true);
  await enterRequirement(container);
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="检索粒度"]')!;
    select.value = 'function';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(search).toHaveBeenCalledWith({ requirement: '限制上传大小', scope: 'target', granularity: 'function' }, expect.any(AbortSignal));
  expect(container.querySelector('.context-export')?.textContent).not.toMatch(/token|预算|555|4,000/i);
  expect(container.textContent).toContain('部分上下文');
  expect(container.querySelector('.context-detail')?.textContent).toContain('function parseRequest');
  expect(container.querySelector('.context-gaps')?.textContent).toContain('外部依赖未解析');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="复制上下文"]')!.click());
  expect(writeText).toHaveBeenLastCalledWith(response.markdown);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="包含 FileItem"]')!.click());
  expect(container.textContent).toContain('已筛选');
  expect(container.querySelector('.context-export')?.textContent).not.toMatch(/token|预算|字符/i);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="复制上下文"]')!.click());
  expect(writeText.mock.calls.at(-1)?.[0]).toContain('function parseRequest');
  expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('interface FileItem');
});

it('shows an unsupported explicit granularity without relabeling a fallback as a subsystem', async () => {
  const response = { ...packet(), status: 'unavailable' as const, evidence: [], results: [],
    routing: { requestedGranularity: 'subsystem' as const, resolvedGranularities: [], source: 'user' as const, reason: '未建立子系统索引' },
    gaps: [{ code: 'GRANULARITY_UNAVAILABLE', message: '未建立子系统索引' }] };
  const container = await render(async () => response);
  await enterRequirement(container);
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain('当前粒度不可用');
  expect(container.querySelector<HTMLDetailsElement>('.context-gaps')?.open).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="复制上下文"]')!.disabled).toBe(true);
});

it('cancels an in-flight request and ignores its late response', async () => {
  let resolve!: (packet: ContextPacket) => void;
  const search = vi.fn((_request: TaskSearchIntent, _signal: AbortSignal) => new Promise<ContextPacket>((done) => { resolve = done; }));
  const container = await render(search);
  await enterRequirement(container);
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '取消')!.click());
  expect(search.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => resolve(packet()));
  expect(container.querySelector('.context-evidence')).toBeNull();
  expect(container.textContent).toContain('等待检索');
});

it('correlates bridge responses and propagates cancellation without leaking subscriptions', async () => {
  const listeners = new Set<(message: HostToWebviewMessage) => void>();
  const sent: WebviewToHostMessage[] = [];
  const bus: MessageBus = { post: (message) => sent.push(message), subscribe: (listener) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const search = createTaskSearchProvider(bus, { repositoryId: 'repo-upload', analysisRevision: 'analysis-old', projectId: 'project-1' });
  const request: TaskSearchIntent = { requirement: '限制上传大小', scope: 'target', granularity: 'function' };
  const abort = new AbortController();
  const pending = search(request, abort.signal);
  const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const started = sent[0] as Extract<WebviewToHostMessage, { type: 'START_TASK_SEARCH' }>;
  expect(started.targetScope.analysisRevision).toBe('analysis-old');
  listeners.forEach((listener) => listener({ type: 'TASK_SEARCH_RESULT', requestId: 'another-request', packet: packet() }));
  expect(listeners.size).toBe(1);
  abort.abort();
  await failure;
  expect(sent.at(-1)).toEqual({ type: 'CANCEL_TASK_SEARCH', requestId: started.requestId });
  expect(listeners.size).toBe(0);
  const next = search(request, new AbortController().signal);
  const nextStarted = sent.at(-1) as Extract<WebviewToHostMessage, { type: 'START_TASK_SEARCH' }>;
  listeners.forEach((listener) => listener({ type: 'TASK_SEARCH_RESULT', requestId: nextStarted.requestId, packet: packet() }));
  expect(await next).toMatchObject({ packetId: 'packet-1' });
  expect(listeners.size).toBe(0);
});

it('allows the host deadline, times out at 40 seconds, and ignores an expired response during the next request', async () => {
  vi.useFakeTimers();
  const listeners = new Set<(message: HostToWebviewMessage) => void>();
  const sent: WebviewToHostMessage[] = [];
  const bus: MessageBus = { post: (message) => sent.push(message), subscribe: (listener) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const search = createTaskSearchProvider(bus, { repositoryId: 'repo-upload', analysisRevision: 'analysis-1' });
  const request: TaskSearchIntent = { requirement: '限制上传大小', scope: 'target', granularity: 'function' };
  const expired = search(request, new AbortController().signal);
  const failure = expect(expired).rejects.toThrow('任务检索超时');
  const oldStart = sent[0] as Extract<WebviewToHostMessage, { type: 'START_TASK_SEARCH' }>;
  await vi.advanceTimersByTimeAsync(35_000);
  expect(listeners.size).toBe(1);
  expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  await failure;
  expect(sent.at(-1)).toEqual({ type: 'CANCEL_TASK_SEARCH', requestId: oldStart.requestId });
  expect(listeners.size).toBe(0);
  let accepted = false;
  const next = search(request, new AbortController().signal).then((result) => { accepted = true; return result; });
  const nextStart = sent.at(-1) as Extract<WebviewToHostMessage, { type: 'START_TASK_SEARCH' }>;
  listeners.forEach((listener) => listener({ type: 'TASK_SEARCH_RESULT', requestId: oldStart.requestId, packet: packet() }));
  await Promise.resolve();
  expect(accepted).toBe(false);
  expect(listeners.size).toBe(1);
  listeners.forEach((listener) => listener({ type: 'TASK_SEARCH_RESULT', requestId: nextStart.requestId, packet: packet() }));
  expect(await next).toMatchObject({ packetId: 'packet-1' });
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
