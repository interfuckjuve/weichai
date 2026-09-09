import { useEffect, useRef, useState } from 'react';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import type { TranslationProvider, TranslationResult } from '../workspace-translation-provider';

const statuses: Record<WorkspaceTranslationRun['status'], string> = { analyzing: '制定计划', translating: '生成代码', compiling: '编译检查', testing: '行为测试',
  completed: '执行完成，待审阅', failed: '执行失败', cancelled: '已取消', interrupted: '执行已中断', 'rolling-back': '正在回滚', 'rolled-back': '已回滚' };
const running = new Set(['analyzing', 'translating', 'compiling', 'testing', 'rolling-back']);

export function WorkspaceTranslation({ provider, packetId, evidenceIds }: { provider: TranslationProvider; packetId: string; evidenceIds: string[] }) {
  const [profile, setProfile] = useState<TranslationResult['profile']>();
  const [run, setRun] = useState<WorkspaceTranslationRun>();
  const [resumeId, setResumeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const generation = useRef(0);
  useEffect(() => { let active = true; void provider({ action: 'describe' }).then(result => { if (active) setProfile(result.profile); })
    .catch(cause => { if (active) setError(String(cause.message)); }); return () => { active = false; generation.current++; }; }, [provider]);

  async function action(name: 'start' | 'read' | 'cancel' | 'resume' | 'rollback') {
    const attempt = ++generation.current;
    setBusy(true); setError(''); setReviewed(false);
    try {
      const result = await provider(name === 'start' ? { action: name, profileId: profile?.profileId, packetId, evidenceIds } : { action: name, runId: run?.id ?? resumeId.trim() });
      if (generation.current === attempt) { setRun(result.run); if (result.run) setResumeId(result.run.id); }
    } catch (cause) { if (generation.current === attempt) setError(cause instanceof Error ? cause.message : '翻译操作失败'); }
    finally { if (generation.current === attempt) setBusy(false); }
  }
  useEffect(() => {
    if (!run || !running.has(run.status) || busy || error) return;
    const timer = setTimeout(() => void action('read'), 1500);
    return () => clearTimeout(timer);
  }, [run, busy, error]);

  return <section className="workspace-translation" aria-label="多文件生成与验收">
    <h2>多文件生成与验收</h2>
    {profile ? <><p>{profile.sourceLanguage} → {profile.targetLanguage} · {profile.behavioralVerification ? '已配置行为测试' : '仅编译检查'}</p>
      <p>写入工作区：<code>{profile.workspaceRoot}</code></p><p>允许修改：{profile.writeFiles.join('、')}</p></> : null}
    {!run ? <button type="button" className="primary-action" disabled={!profile || busy || !evidenceIds.length} onClick={() => void action('start')}>使用所选证据生成代码</button> : null}
    <div className="translation-actions"><label>运行编号<input aria-label="运行编号" value={resumeId} onChange={event => { setResumeId(event.target.value); setRun(undefined); }} disabled={busy || Boolean(run && running.has(run.status))} /></label>
      <button type="button" className="secondary-action" disabled={busy || !resumeId.trim()} onClick={() => void action('read')}>读取运行</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {run ? <>
      <p role="status">{statuses[run.status]} · {run.acceptance === 'behavior-verified' ? '行为测试通过' : '尚无行为验收通过记录'}</p>
      {run.error ? <p role="alert">{run.error}</p> : null}
      <div className="translation-actions">
        {running.has(run.status) ? <button type="button" disabled={busy} onClick={() => void action('cancel')}>取消运行</button> : null}
        {['failed', 'cancelled', 'interrupted'].includes(run.status) ? <button type="button" disabled={busy} onClick={() => void action('resume')}>继续执行</button> : null}
        {!running.has(run.status) && run.status !== 'rolled-back' && run.changes.length ? <button type="button" disabled={busy} onClick={() => void action('rollback')}>回滚本次修改</button> : null}
      </div>
      {run.plan ? <details open><summary>适配计划</summary><p>{run.plan.summary}</p><ol>{run.plan.steps.map(step => <li key={step.id}>{run.completedSteps.includes(step.id) ? '✓ ' : ''}{step.description} · {step.files.join('、')}</li>)}</ol></details> : null}
      {run.changes.map(change => <details key={change.path}><summary>{change.path} · {change.rolledBack ? '已回滚' : change.applied ? '已写入' : '待写入'}</summary>
        <h3>修改前</h3><pre>{change.before ?? '（新文件）'}</pre><h3>修改后</h3><pre>{change.after}</pre></details>)}
      {[...run.compilations.map((check, index) => ({ check, label: `编译 ${index + 1}` })), ...(run.verification?.runs ?? []).map((check, index) => ({ check, label: `行为测试 ${index + 1}` }))]
        .map(({ check, label }) => <details key={label}><summary>{label} · {check.success ? '通过' : '失败'}</summary><pre>{check.output || check.diagnostics.join('\n')}</pre></details>)}
      {run.status === 'completed' ? <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />已审阅本次差异与验证记录{reviewed ? '（本页标记）' : ''}</label> : null}
    </> : null}
  </section>;
}
