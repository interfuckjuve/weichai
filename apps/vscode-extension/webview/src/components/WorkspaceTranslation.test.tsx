import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslation } from './WorkspaceTranslation';
import type { TranslationProvider } from '../workspace-translation-provider';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); });
it('previews the destination, starts with evidence IDs, reviews failed tests and rolls back', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const run: WorkspaceTranslationRun = { id: '12345678-1234-1234-1234-123456789012', workspaceRoot: '/target', status: 'failed',
    request: { spec: 'Limit', sourceLanguage: 'Java', targetLanguage: 'TypeScript', context: [], workspaceFiles: ['limit.ts'], writeFiles: ['limit.ts'] },
    createdAt: '', updatedAt: '', completedSteps: [], changes: [{ path: 'limit.ts', before: '// old', after: '// wrong', applied: true }], compilations: [], modelTurns: 3,
    acceptance: 'compilation-only', error: 'Negative input test failed' };
  const provider = vi.fn<TranslationProvider>(async intent => ({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: 'reply',
    ...(intent.action === 'describe' ? { profile: { profileId: 'profile-1', workspaceRoot: '/target', sourceLanguage: 'Java', targetLanguage: 'TypeScript', workspaceFiles: ['limit.ts'], writeFiles: ['limit.ts'], behavioralVerification: true } }
      : { run: intent.action === 'rollback' ? { ...run, status: 'rolled-back' } : run }) }));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<WorkspaceTranslation provider={provider} packetId="packet-1" evidenceIds={['source-1']} />));
  expect(container.textContent).toContain('/target');
  expect(container.textContent).toContain('limit.ts');
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
  await act(async () => button('使用所选证据生成代码').click());
  expect(provider).toHaveBeenLastCalledWith({ action: 'start', profileId: 'profile-1', packetId: 'packet-1', evidenceIds: ['source-1'] });
  expect(container.textContent).toContain('Negative input test failed');
  expect(container.textContent).toContain('尚无行为验收通过记录');
  expect(container.textContent).toContain('// old');
  expect(container.textContent).toContain('// wrong');
  await act(async () => button('回滚本次修改').click());
  expect(provider).toHaveBeenLastCalledWith({ action: 'rollback', runId: run.id });
  expect(container.textContent).toContain('已回滚');
});
