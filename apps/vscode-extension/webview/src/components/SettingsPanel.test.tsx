import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

describe('SettingsPanel', () => {
  it('renders the configured top K and multiple repository paths', () => {
    const markup = renderToStaticMarkup(
      <SettingsPanel
        topK={6}
        repositoryPaths={['D:/history/one', 'D:/history/two']}
        repositoryStatuses={[]}
        saving={false}
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
        onCheckRepositories={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('尚未添加历史仓路径');
    expect(markup).toContain('添加第一个路径');
  });
});
