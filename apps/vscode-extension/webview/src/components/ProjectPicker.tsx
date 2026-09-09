import { useEffect, useRef } from 'react';
import { Check, ChevronDown, FolderOpen, FolderPlus, RefreshCw, Settings2, TextCursorInput } from 'lucide-react';
import type { CodeIntelligencePresentation, ModuleExplorerMode, ModuleWorkspacePresentation } from '../../../src/ui-types';

export interface ProjectPickerProps {
  mode: ModuleExplorerMode;
  workspace: ModuleWorkspacePresentation;
  repositories: CodeIntelligencePresentation['repositories'];
  open: boolean;
  refreshing: boolean;
  onOpenChange(open: boolean): void;
  onSelect(repositoryId: string, analysisRevision: string, projectId: string): void;
  onRefresh(repositoryId: string): void;
  onAdd(mode: 'browse' | 'input' | 'workspace'): void;
  onOpenSettings(): void;
}

export function ProjectPicker(props: ProjectPickerProps) {
  const { mode, workspace, open, onOpenChange } = props;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const repositories = props.repositories.filter((repository) => repository.role === mode);
  const current = repositories.find((repository) => repository.repositoryId === workspace.repositoryId);
  const label = current?.displayName ?? (workspace.projectId ? workspace.name : mode === 'target' ? '选择目标工程' : '选择参考工程');

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, onOpenChange]);

  const choose = (action: () => void) => {
    onOpenChange(false);
    trigger.current?.focus();
    action();
  };

  return (
    <div className="workspace-picker" ref={container} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); trigger.current?.focus(); }
      if (event.key === 'Tab') onOpenChange(false);
      if (!open && event.key === 'ArrowDown') { event.preventDefault(); onOpenChange(true); return; }
      if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div className="workspace-picker-row">
        <button ref={trigger} type="button" className="workspace-picker-trigger" aria-haspopup="menu"
          aria-expanded={open} aria-label={mode === 'target' ? '选择目标工程' : '选择参考工程'}
          title={workspace.projectId ? workspace.name : label} onClick={() => onOpenChange(!open)}>
          <FolderOpen size={14} />
          <span><strong>{label}</strong><small>{workspace.projectId ? workspace.rootLabel || '.' : '未选择项目'}</small></span>
          <ChevronDown size={13} />
        </button>
        <button type="button" className="icon-button" title="刷新此仓库" aria-label="刷新此仓库"
          disabled={!current || props.refreshing} onClick={() => current && props.onRefresh(current.repositoryId)}>
          <RefreshCw size={14} className={props.refreshing ? 'is-spinning' : ''} />
        </button>
      </div>
      {open ? (
        <div className="workspace-picker-menu" role="menu" aria-label={mode === 'target' ? '目标工程列表' : '参考工程列表'} ref={menu}>
          <div className="workspace-picker-options">
            {repositories.map((repository) => (
              <div key={repository.repositoryId} role="group" aria-label={repository.displayName}>
                <div className="workspace-picker-group">{repository.displayName}</div>
                {repository.projects.map((project) => {
                  const selected = repository.repositoryId === workspace.repositoryId && project.projectId === workspace.projectId;
                  return <button type="button" role="menuitemradio" aria-checked={selected} key={project.projectId}
                    className="workspace-picker-option" disabled={!repository.selectedRevision}
                    onClick={() => choose(() => props.onSelect(repository.repositoryId, repository.selectedRevision!, project.projectId))}>
                    <span><strong>{project.displayName}</strong><small>{project.relativePath || '.'}</small></span>
                    {selected ? <Check size={14} /> : null}
                  </button>;
                })}
                {!repository.projects.length ? <button type="button" role="menuitem" className="workspace-picker-option"
                  disabled={props.refreshing || repository.analysisStatus === 'indexing'}
                  onClick={() => choose(() => props.onRefresh(repository.repositoryId))}>
                  <RefreshCw size={13} />{repository.analysisStatus === 'indexing' ? '正在建立索引…' : '初始化项目索引'}
                </button> : null}
              </div>
            ))}
            {!repositories.length ? <div className="workspace-picker-empty">{mode === 'target' ? '尚未选择目标工程' : '尚未添加参考工程'}</div> : null}
          </div>
          <div className="workspace-picker-commands">
            {mode === 'target' ? <>
              <button type="button" role="menuitem" onClick={() => choose(() => props.onAdd('workspace'))}><FolderOpen size={14} />从已打开工作区选择…</button>
              <button type="button" role="menuitem" onClick={() => choose(() => props.onAdd('browse'))}><FolderPlus size={14} />浏览本地项目…</button>
              <button type="button" role="menuitem" onClick={() => choose(() => props.onAdd('input'))}><TextCursorInput size={14} />输入项目路径…</button>
            </> : <button type="button" role="menuitem" onClick={() => choose(props.onOpenSettings)}><Settings2 size={14} />管理参考工程…</button>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
