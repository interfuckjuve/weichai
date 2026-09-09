import type { ContextPacket } from '@forexplore/contracts';
import type { TaskSearchIntent, TaskSearchTargetScope } from '../../src/protocol/messages';
import type { MessageBus } from './vscode-api';

export type TaskSearchProvider = (request: TaskSearchIntent, signal: AbortSignal) => Promise<ContextPacket>;

export function createTaskSearchProvider(bus: MessageBus, targetScope: TaskSearchTargetScope): TaskSearchProvider {
  return (request, signal) => new Promise<ContextPacket>((resolve, reject) => {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      finished = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const cancel = (reason: unknown) => {
      if (finished) return;
      cleanup();
      bus.post({ type: 'CANCEL_TASK_SEARCH', requestId });
      reject(reason);
    };
    const onAbort = () => cancel(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    unsubscribe = bus.subscribe((message) => {
      if ((message.type !== 'TASK_SEARCH_RESULT' && message.type !== 'TASK_SEARCH_ERROR') || message.requestId !== requestId) return;
      cleanup();
      if (message.type === 'TASK_SEARCH_RESULT') resolve(message.packet);
      else reject(new Error(message.message));
    });
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => cancel(new Error('任务检索超时，请重试。')), 40_000);
    bus.post({ type: 'START_TASK_SEARCH', requestId, targetScope, request });
  });
}
