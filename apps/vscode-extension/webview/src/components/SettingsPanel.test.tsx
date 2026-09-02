import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsPanel', () => {
  it('renders the configured top K and multiple repository paths', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={6}
        repositoryPaths={['D:/history/one', 'D:/history/two']}
        repositoryStatuses={[]}
        saving={false}
        onPickRepositoryPath={vi.fn()}
        onCheckRepositories={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('返回方案数');
    expect(markup).toContain('Top 6');
    expect(markup).toContain('D:/history/one');
    expect(markup).toContain('D:/history/two');
    expect(markup).toContain('添加路径');
    expect(markup).toContain('保存设置');
  });

  it('offers a clear first-path action when no repository is configured', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={4}
        repositoryPaths={[]}
        repositoryStatuses={[]}
        saving={false}
        onPickRepositoryPath={vi.fn()}
        onCheckRepositories={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('尚未添加历史仓路径');
    expect(markup).toContain('添加第一个路径');
  });

  it('delegates repository path selection to the Host folder picker', () => {
    const onPickRepositoryPath = vi.fn();
    const onSave = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <SettingsPanel
          topK={4}
          repositoryPaths={[]}
          repositoryStatuses={[]}
          saving={false}
          onPickRepositoryPath={onPickRepositoryPath}
          onCheckRepositories={vi.fn()}
          onSave={onSave}
          onCancel={vi.fn()}
        />,
      );
    });
    const firstPathButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('添加第一个路径'));

    act(() => firstPathButton?.click());

    expect(onPickRepositoryPath).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('adds the Host-picked path to the draft and persists it only on save', () => {
    const onSave = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <SettingsPanel
          topK={6}
          repositoryPaths={['D:/history/one']}
          repositoryStatuses={[]}
          saving={false}
          pickedRepositoryPath={{ path: 'D:/history/two', token: 1 }}
          onPickRepositoryPath={vi.fn()}
          onCheckRepositories={vi.fn()}
          onSave={onSave}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(onSave).not.toHaveBeenCalled();
    const form = container.querySelector('form');
    act(() => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(onSave).toHaveBeenCalledWith({
      topK: 6,
      repositoryPaths: ['D:/history/one', 'D:/history/two'],
    });
    act(() => root.unmount());
  });
});
