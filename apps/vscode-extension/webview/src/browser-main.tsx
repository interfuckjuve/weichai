import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import './styles.css';

const pending = new Map<string, AbortController>();
const dispatch = (data: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
let state: unknown;
window.acquireVsCodeApi = () => ({
  getState: () => state,
  setState: (value) => { state = value; },
  postMessage: (value) => {
    const message = value as WebviewToHostMessage;
    if (message.type === 'CANCEL_TASK_SEARCH') {
      pending.get(message.requestId)?.abort();
      pending.delete(message.requestId);
      return;
    }
    const controller = new AbortController();
    if (message.type === 'START_TASK_SEARCH') pending.set(message.requestId, controller);
    void fetch('/v1/workbench/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('工作台请求失败。');
      const messages = await response.json() as HostToWebviewMessage[];
      if (!controller.signal.aborted) messages.forEach(dispatch);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      dispatch(message.type === 'WORKSPACE_TRANSLATION'
        ? { type: 'WORKSPACE_TRANSLATION_ERROR', requestId: message.requestId, message: error.message }
        : message.type === 'START_TASK_SEARCH'
        ? { type: 'TASK_SEARCH_ERROR', requestId: message.requestId, message: error.message }
        : message.type === 'LOAD_MODULE_CHILDREN'
        ? { type: 'MODULE_CHILDREN_ERROR', requestId: message.requestId, message: error.message }
        : { type: 'ERROR', message: error.message });
    }).finally(() => { if (message.type === 'START_TASK_SEARCH') pending.delete(message.requestId); });
  },
});

let refreshing = false;
let refreshAgain = false;
async function refresh(): Promise<void> {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const response = await fetch('/v1/workbench');
    if (response.ok) (await response.json() as HostToWebviewMessage[]).forEach(dispatch);
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}
const events = new EventSource('/v1/workbench/events');
events.onmessage = () => { void refresh().catch(() => undefined); };
window.addEventListener('pagehide', () => { events.close(); for (const controller of pending.values()) controller.abort(); });

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
