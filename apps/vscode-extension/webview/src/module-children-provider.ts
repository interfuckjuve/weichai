import type { ModuleChildrenPage, ModuleChildrenRequest } from '../../src/ui-types';
import type { MessageBus } from './vscode-api';

export type ModuleChildrenProvider = (request: ModuleChildrenRequest, signal?: AbortSignal) => Promise<ModuleChildrenPage>;

export function createModuleChildrenProvider(bus: MessageBus): ModuleChildrenProvider {
  return (request, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
    unsubscribe = bus.subscribe((message) => {
      if ((message.type !== 'MODULE_CHILDREN' && message.type !== 'MODULE_CHILDREN_ERROR') || message.requestId !== requestId) return;
      cleanup();
      if (message.type === 'MODULE_CHILDREN') resolve(message.page);
      else reject(new Error(message.message));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('模块节点读取超时，请重试。')); }, 20_000);
    bus.post({ type: 'LOAD_MODULE_CHILDREN', requestId, request });
  });
}
