import type { HostToWebviewMessage } from '../../src/protocol/messages';
import type { TranslationIntent } from '../../src/workspace-translation-host';
import type { MessageBus } from './vscode-api';

export type TranslationResult = Extract<HostToWebviewMessage, { type: 'WORKSPACE_TRANSLATION_RESULT' }>;
export type TranslationProvider = (intent: Omit<TranslationIntent, 'type' | 'requestId'>) => Promise<TranslationResult>;
export function createTranslationProvider(bus: MessageBus): TranslationProvider {
  return intent => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('操作响应超时；请按运行编号刷新状态，避免重复启动。')); }, 65000);
    const unsubscribe = bus.subscribe(message => {
      if ((message.type !== 'WORKSPACE_TRANSLATION_RESULT' && message.type !== 'WORKSPACE_TRANSLATION_ERROR') || message.requestId !== requestId) return;
      clearTimeout(timer); unsubscribe();
      if (message.type === 'WORKSPACE_TRANSLATION_ERROR') reject(new Error(message.message));
      else resolve(message);
    });
    bus.post({ type: 'WORKSPACE_TRANSLATION', requestId, ...intent });
  });
}
