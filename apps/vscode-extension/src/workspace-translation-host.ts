import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { formatContextMarkdown, type ContextPacket, type WorkspaceTranslationRequest, type WorkspaceTranslationRun } from '@forexplore/contracts';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol/messages';

export interface TranslationProfile {
  workspaceRoot: string;
  sourceLanguage: string;
  targetLanguage: string;
  workspaceFiles: string[];
  writeFiles: string[];
}
export type TranslationIntent = Extract<WebviewToHostMessage, { type: 'WORKSPACE_TRANSLATION' }>;

/** Credentials, paths and retrieved source stay in the host. The page supplies opaque IDs only. */
export class WorkspaceTranslationHost {
  private readonly packets = new Map<string, ContextPacket>();
  private readonly starts = new Map<string, Promise<WorkspaceTranslationRun>>();
  constructor(private readonly configuration: () => { url: string; token?: string; profile?: string }) {}

  remember(packet: ContextPacket): void {
    this.packets.set(packet.packetId, structuredClone(packet));
    while (this.packets.size > 16) this.packets.delete(this.packets.keys().next().value!);
  }

  async handle(intent: TranslationIntent): Promise<HostToWebviewMessage> {
    try {
      const { url, token, profile: raw } = this.configuration();
      if (!token || !raw) throw new Error('请在宿主配置 FOREXPLORE_TRANSLATION_PROFILE 和 ADAPTATION_WORKSPACE_TRANSLATION_TOKEN。');
      const profile = JSON.parse(raw) as TranslationProfile;
      if (!profile || typeof profile.workspaceRoot !== 'string' || !path.isAbsolute(profile.workspaceRoot) ||
          ![profile.sourceLanguage, profile.targetLanguage].every(value => typeof value === 'string' && value.trim()) ||
          ![profile.workspaceFiles, profile.writeFiles].every(files => Array.isArray(files) && files.length > 0 && files.length <= 100 && files.every(file => typeof file === 'string' && file.length > 0))) {
        throw new Error('宿主翻译配置无效。');
      }
      const endpoint = new URL(url);
      const base = endpoint.pathname.replace(/\/+$/, '');
      endpoint.search = ''; endpoint.hash = '';
      const request = async <T>(suffix: string, body?: unknown): Promise<T> => {
        const target = new URL(endpoint); target.pathname = `${base}/v1/workspace-translations${suffix}`;
        const response = await fetch(target, { method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
        const value = await response.json() as T & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `翻译服务返回 ${response.status}`);
        return value;
      };
      const configured = await request<{ workspaceRoot: string; behavioralVerification: boolean }>('/configuration');
      if (await realpath(configured.workspaceRoot) !== await realpath(profile.workspaceRoot)) throw new Error('翻译服务的工作区与宿主配置不一致。');
      const profileId = createHash('sha256').update(JSON.stringify([url, profile])).digest('hex');
      if (intent.action === 'describe') return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId,
        profile: { ...profile, profileId, behavioralVerification: configured.behavioralVerification } };

      let run: WorkspaceTranslationRun;
      if (intent.action === 'start') {
        if (intent.profileId !== profileId) throw new Error('翻译配置已变化，请重新打开生成与验收面板。');
        const packet = this.packets.get(intent.packetId!);
        if (!packet || packet.status === 'unavailable') throw new Error('任务证据已失效，请重新检索。');
        const selected = new Set(intent.evidenceIds);
        const evidence = packet.evidence.filter(item => selected.has(item.evidenceId));
        if (!evidence.length || evidence.length !== selected.size) throw new Error('选择的证据不属于当前任务。');
        const context: WorkspaceTranslationRequest['context'] = evidence.map(item => ({ id: item.evidenceId,
          kind: item.role === 'implementation' ? 'source' : item.role, content: item.content,
          path: item.relativePath, repository: item.repositoryId, revision: item.analysisRevision }));
        // Preserve snapshots, relations and gaps without duplicating source text.
        context.push({ id: `${packet.packetId}:provenance`, kind: 'summary', content: formatContextMarkdown({ ...packet, evidence: [],
          gaps: [...packet.gaps, ...(evidence.length < packet.evidence.length ? [{ code: 'USER_SELECTION', message: 'Only user-selected evidence is included; task coverage may be incomplete.' }] : [])] }) });
        const input = { spec: packet.requirement, sourceLanguage: profile.sourceLanguage, targetLanguage: profile.targetLanguage,
          workspaceFiles: profile.workspaceFiles, writeFiles: profile.writeFiles, context };
        // Do not repeat a write request if the UI delivers the same operation twice.
        const startKey = JSON.stringify([profile, packet.packetId, [...selected].sort()]);
        let pending = this.starts.get(startKey);
        if (!pending) {
          if (this.starts.size >= 100) throw new Error('本次会话的翻译任务已达上限，请重启宿主。');
          pending = request<WorkspaceTranslationRun>('', input);
          this.starts.set(startKey, pending);
        }
        run = await pending;
      } else {
        if (!intent.runId || !/^[a-f0-9-]{36}$/.test(intent.runId)) throw new Error('无效的运行编号。');
        // Check the durable run before any action, including after host restart.
        run = await request<WorkspaceTranslationRun>(`/${intent.runId}`);
        if (await realpath(run.workspaceRoot) !== await realpath(profile.workspaceRoot)) throw new Error('运行不属于配置的工作区。');
        if (intent.action !== 'read') run = await request<WorkspaceTranslationRun>(`/${intent.runId}/${intent.action}`, {});
      }
      return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId, run };
    } catch (error) {
      return { type: 'WORKSPACE_TRANSLATION_ERROR', requestId: intent.requestId,
        message: error instanceof Error ? error.message : '翻译操作失败。' };
    }
  }
}
