import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPicker, type ProjectPickerProps } from './ProjectPicker';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ''; });

const repository = {
  repositoryId: 'repo-history', displayName: 'account-stream-rs', role: 'history', selectedRevision: 'revision-one',
  projects: [{ projectId: 'cargo-project', displayName: 'Cargo', relativePath: '' }],
} as ProjectPickerProps['repositories'][number];
const workspace = { id: 'repo-history', repositoryId: 'repo-history', projectId: 'cargo-project',
  name: 'account-stream-rs / Cargo', rootLabel: '.',
} as ProjectPickerProps['workspace'];

async function mount(mode: ProjectPickerProps['mode'] = 'history') {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = { onSelect: vi.fn(), onRefresh: vi.fn(), onAdd: vi.fn(), onOpenSettings: vi.fn() };
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ProjectPicker mode={mode} workspace={workspace} repositories={[repository]} open={open}
      onOpenChange={setOpen} refreshing={false} {...callbacks} />;
  }
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  return callbacks;
}

it('selects a revision-bound project and closes the menu', async () => {
  const callbacks = await mount();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click());
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('account-stream-rs');
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
  expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith('repo-history', 'revision-one', 'cargo-project');
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('supports keyboard opening, navigation and escape with restored focus', async () => {
  await mount();
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement?.textContent).toContain('管理参考工程');
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps target commands in the target menu and dismisses an outside click', async () => {
  const callbacks = await mount('target');
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  await act(async () => trigger.click());
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('account-stream-rs');
  const browse = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('浏览本地项目'))!;
  await act(async () => browse.click());
  expect(callbacks.onAdd).toHaveBeenCalledExactlyOnceWith('browse');
  await act(async () => trigger.click());
  await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
