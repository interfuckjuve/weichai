import { FolderPlus, RefreshCw, Save, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PanelSettingsPresentation } from '../../../src/protocol/messages';
import type { RepositoryStatus } from '../../../src/ui-types';

interface SettingsPanelProps extends PanelSettingsPresentation {
  repositoryStatuses: RepositoryStatus[];
  saving: boolean;
  onCheckRepositories(): void;
  onSave(settings: PanelSettingsPresentation): void;
  onCancel(): void;
}

export function SettingsPanel({
  topK,
  repositoryPaths,
  repositoryStatuses,
  saving,
  onCheckRepositories,
  onSave,
  onCancel,
}: SettingsPanelProps) {
  const [draftTopK, setDraftTopK] = useState(topK);
  const [draftPaths, setDraftPaths] = useState<string[]>(repositoryPaths);

  useEffect(() => {
    setDraftTopK(topK);
    setDraftPaths(repositoryPaths);
  }, [topK, repositoryPaths]);

  const normalizedPaths = useMemo(
    () => [...new Set(draftPaths.map((path) => path.trim()).filter(Boolean))],
    [draftPaths],
  );

  function updatePath(index: number, value: string): void {
    setDraftPaths((current) => current.map((path, itemIndex) => itemIndex === index ? value : path));
  }

  function removePath(index: number): void {
    setDraftPaths((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSave({ topK: draftTopK, repositoryPaths: normalizedPaths });
  }

  return (
    <form className="settings-panel" onSubmit={submit}>
      <div className="settings-heading">
        <span className="settings-glyph"><Settings2 size={18} /></span>
        <div>
          <h1>设置</h1>
          <p>配置候选方案数量和用于模块检索的历史代码仓。</p>
        </div>
      </div>

      <section className="card settings-section">
        <div className="card-heading"><span>返回方案数</span><strong>Top {draftTopK}</strong></div>
        <input
          aria-label="返回方案数"
          type="range"
          min="1"
          max="10"
          value={draftTopK}
          onChange={(event) => setDraftTopK(Number(event.target.value))}
        />
        <div className="settings-range-scale"><span>1</span><span>10</span></div>
        <p className="muted-copy">每次检索展示 {draftTopK} 个候选方案。</p>
      </section>

      <section className="card settings-section">
        <div className="card-heading">
          <span>检索仓库路径</span>
          <button
            type="button"
            className="text-button"
            onClick={() => setDraftPaths((current) => current.length < 20 ? [...current, ''] : current)}
            disabled={draftPaths.length >= 20 || saving}
          >
            <FolderPlus size={13} /> 添加路径
          </button>
        </div>
        <p className="settings-intro">可添加多个本地历史代码仓。保存后，它们会分别出现在左侧“历史仓”列表中。</p>
        {draftPaths.length === 0 ? (
          <div className="settings-empty">
            <span>尚未添加历史仓路径</span>
            <button type="button" className="secondary-action" onClick={() => setDraftPaths([''])}>
              <FolderPlus size={13} /> 添加第一个路径
            </button>
          </div>
        ) : (
          <div className="repository-path-fields">
            {draftPaths.map((path, index) => {
              const status = repositoryStatuses.find((item) => item.path === path.trim());
              return (
                <div className="repository-path-row" key={`${index}-${repositoryPaths[index] ?? 'new'}`}>
                  <label>
                    <span>路径 {index + 1}</span>
                    <input
                      type="text"
                      value={path}
                      maxLength={1000}
                      placeholder="例如 D:\\CodeProjects\\legacy-system"
                      onChange={(event) => updatePath(index, event.target.value)}
                      disabled={saving}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button danger-button"
                    aria-label={`删除路径 ${index + 1}`}
                    title="删除路径"
                    onClick={() => removePath(index)}
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                  {status ? (
                    <span className={`path-status is-${statusClass(status)}`} title={status.message}>
                      <i className="repository-dot" />{status.message}
                    </span>
                  ) : path.trim() ? <span className="path-status">保存后检查</span> : null}
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="text-button settings-check-button"
          onClick={onCheckRepositories}
          disabled={saving || repositoryPaths.length === 0}
          title={repositoryPaths.length === 0 ? '请先保存至少一个仓库路径' : '检查已保存的仓库路径'}
        >
          <RefreshCw size={13} /> 重新检查已保存路径
        </button>
      </section>

      <div className="settings-actions">
        <button type="button" className="secondary-action" onClick={onCancel} disabled={saving}>
          <X size={14} /> 取消
        </button>
        <button type="submit" className="primary-action settings-save" disabled={saving}>
          {saving ? <span className="spinner" /> : <Save size={14} />}
          {saving ? '正在保存…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}

function statusClass(status: RepositoryStatus): string {
  if (!status.exists || !status.readable) return 'error';
  if (status.stale) return 'stale';
  if (!status.indexed) return 'pending';
  return 'ok';
}
