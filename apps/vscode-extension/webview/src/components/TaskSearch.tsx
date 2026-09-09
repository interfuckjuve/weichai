import { WorkspaceTranslation } from './WorkspaceTranslation';
import type { TranslationProvider } from '../workspace-translation-provider';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Download, FileCode2, GitBranch, Search, X } from 'lucide-react';
import { formatContextMarkdown, type ContextPacket } from '@forexplore/contracts';
import type { TaskSearchIntent } from '../../../src/protocol/messages';
import type { TaskSearchProvider } from '../task-search-provider';

export type TaskSearchRequest = TaskSearchIntent;
export type ContextEvidence = ContextPacket['evidence'][number];
export type { TaskSearchProvider } from '../task-search-provider';
const labels = { implementation: '实现', interface: '接口', dependency: '调用依赖', configuration: '配置' };
const granularities = { auto: '自动', function: '函数 / 方法', class: '类 / 接口', module: '功能模块', subsystem: '子系统' };

export function TaskSearch({ project, search, availableGranularities, onMigrate, translation }: {
  translation?: TranslationProvider;
  project: string;
  search?: TaskSearchProvider;
  availableGranularities?: Record<TaskSearchIntent['scope'], readonly TaskSearchIntent['granularity'][]>;
  onMigrate(requirement: string): void;
}) {
  const [showTranslation, setShowTranslation] = useState(false);
  const [requirement, setRequirement] = useState('');
  const [scope, setScope] = useState<TaskSearchRequest['scope']>('target');
  const [granularity, setGranularity] = useState<TaskSearchRequest['granularity']>('auto');
  const [packet, setPacket] = useState<ContextPacket | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const available = availableGranularities?.[scope] ?? ['auto', 'function', 'class', 'module'];
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const results = packet?.evidence ?? null;
  const active = results?.find((item) => item.evidenceId === activeId);
  const chosen = results?.filter((item) => selected.includes(item.evidenceId)) ?? [];
  const filtered = packet !== null && chosen.length !== packet.evidence.length;
  const markdown = packet ? filtered
    ? formatContextMarkdown({ ...packet, evidence: chosen, relations: [], gaps: [...packet.gaps,
      { code: 'USER_SELECTION', message: '用户已筛选证据；原始关系及部分源码未包含在此导出中。' }] })
    : packet.markdown : '';
  const canExport = chosen.length > 0 && packet?.status !== 'unavailable' && !pending;
  const repositoryName = (id: string) => packet?.snapshots.find((item) => item.repositoryId === id)?.repositoryName ?? id;

  function invalidate() {
    controller.current?.abort();
    controller.current = null;
    setPending(false);
    setPacket(null);
    setShowTranslation(false);
    setSelected([]);
    setActiveId(null);
    setError('');
    setCopied(false);
  }

  async function submit() {
    if (!search || !requirement.trim() || !available.includes(granularity)) return;
    invalidate();
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    try {
      const response = await search({ requirement: requirement.trim(), scope, granularity }, abort.signal);
      if (abort.signal.aborted) return;
      setPacket(response);
      setSelected(response.evidence.map((item) => item.evidenceId));
      setActiveId(response.evidence[0]?.evidenceId ?? null);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '检索失败，请重试。');
    } finally {
      if (controller.current === abort) setPending(false);
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(markdown); setCopied(true); }
    catch { setError('复制失败，请下载上下文文件。'); }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'code-context.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="task-search" aria-label="任务检索">
    <header className="task-search-heading">
      <div><span className="section-kicker">代码上下文</span><h1>你要修改或迁移什么功能？</h1></div>
      <span className={`engine-status${search ? ' is-connected' : ''}`}><i />{search ? '检索已连接' : '待接入任务检索'}</span>
    </header>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="task-query-label" htmlFor="task-query">开发需求</label>
      <textarea id="task-query" className="task-query" value={requirement} maxLength={8000} rows={4}
        placeholder="例如：为文件上传增加大小限制，定位解析入口、流读取和异常处理的相关实现。"
        onChange={(event) => { invalidate(); setRequirement(event.target.value); }} />
      <div className="task-search-controls">
        <label>检索范围<select aria-label="检索范围" value={scope} onChange={(event) => { invalidate(); setScope(event.target.value as TaskSearchRequest['scope']); }}>
          <option value="target">目标工程</option><option value="all">目标与参考工程</option>
        </select></label>
        <label>检索粒度<select aria-label="检索粒度" value={granularity} onChange={(event) => { invalidate(); setGranularity(event.target.value as TaskSearchRequest['granularity']); }}>
          {Object.entries(granularities).map(([value, label]) => {
            const enabled = available.includes(value as TaskSearchIntent['granularity']);
            return <option key={value} value={value} disabled={!enabled}>{label}{enabled ? '' : '（未建索引）'}</option>;
          })}
        </select></label>
        {pending ? <button type="button" className="secondary-action" onClick={invalidate}><X size={14} />取消</button> : null}
        <button className="primary-action" type="submit" disabled={!search || !requirement.trim() || pending || !available.includes(granularity)}>
          {pending ? <span className="spinner" /> : <Search size={15} />}{pending ? '正在检索' : '检索相关代码'}
        </button>
      </div>
    </form>
    <div className="search-scope-line"><FileCode2 size={13} /><span>{project}</span><span>{scope === 'all' ? '包含参考工程' : '当前目标工程'}</span></div>
    {error ? <p role="alert" className="task-search-error">{error}</p> : null}
    {results === null ? <div className="context-empty" role="status"><Search size={25} strokeWidth={1.3} /><strong>{pending ? '正在定位相关实现与依赖' : '等待检索'}</strong></div> : <>
      {packet ? <div className="context-result-status" role="status">
        <span className={packet.status === 'complete' ? '' : 'context-partial'}>{packet.status === 'unavailable' ? '当前粒度不可用' : packet.status === 'partial' ? '部分上下文' : '检索完成'}</span>
        <span>{packet.routing.resolvedGranularities.map((value) => granularities[value]).join(' · ') || granularities[granularity]}</span>
        <span>{packet.usage.latencyMs.toLocaleString()} ms</span>
      </div> : null}
      <div className="context-heading"><h2>相关代码 <small>{results.length}</small></h2><span>已选 {chosen.length} 项</span></div>
      {!results.length ? <div className="context-empty" role="status"><Search size={25} /><strong>未找到相关代码</strong></div> :
        <div className="context-evidence">
          <div className="context-list" aria-label="相关代码列表">{results.map((item) => <div className={`context-row${item.evidenceId === activeId ? ' is-active' : ''}`} key={item.evidenceId}>
            <input type="checkbox" aria-label={`包含 ${item.name}`} checked={selected.includes(item.evidenceId)} onChange={(event) => {
              setSelected((ids) => event.target.checked ? [...ids, item.evidenceId] : ids.filter((id) => id !== item.evidenceId)); setCopied(false);
            }} />
            <button type="button" aria-pressed={item.evidenceId === activeId} onClick={() => setActiveId(item.evidenceId)}>
              <span className="context-row-title"><strong>{item.name}</strong><small>{labels[item.role]}</small></span>
              <code>{item.relativePath}:{item.sourceRange.startLine}</code><span>{item.reason}</span>
            </button>
          </div>)}</div>
          {active ? <section className="context-detail" aria-label="代码证据">
            <header><FileCode2 size={14} /><strong>{active.name}</strong></header>
            <div className="context-source"><span>{repositoryName(active.repositoryId)}</span><code>{active.relativePath}:{active.sourceRange.startLine}</code><small>版本 {active.analysisRevision}</small></div>
            <pre><code>{active.content}</code></pre>
          </section> : null}
        </div>}
      <footer className="context-export">
        <div><strong>上下文包{filtered ? ' · 已筛选' : ''}</strong></div>
        <div className="context-export-actions">
          <button type="button" className="icon-button" title={copied ? '已复制' : '复制上下文'} aria-label="复制上下文" disabled={!canExport} onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
          <button type="button" className="secondary-action" disabled={!canExport} onClick={download}><Download size={14} />导出上下文</button>
          {translation ? <button type="button" className="primary-action" disabled={!canExport} onClick={() => setShowTranslation(true)}>生成与验收</button> : null}
          <button type="button" className="secondary-action" title="带入当前需求，继续选择复用方案"
            disabled={!canExport} onClick={() => onMigrate(requirement)}>
            <GitBranch size={14} />带入需求并选择参考方案<ArrowRight size={13} />
          </button>
        </div>
      </footer>
      {showTranslation && translation && packet ? <WorkspaceTranslation provider={translation} packetId={packet.packetId} evidenceIds={selected} /> : null}
      {packet?.gaps.length ? <details className="context-gaps" open={packet.status === 'unavailable'}>
        <summary>证据缺口与检索诊断 · {packet.gaps.length}</summary>
        <ul>{packet.gaps.map((gap, index) => <li key={`${gap.code}:${index}`}>{gap.message}{gap.relativePath ? <code>{gap.relativePath}</code> : null}</li>)}</ul>
      </details> : null}
    </>}
  </section>;
}
