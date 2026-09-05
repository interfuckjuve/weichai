import type {
  DefinitionLocation,
  FindDefinitionRequest,
  FindReferencesRequest,
  ReferenceLocation,
  RepositoryRevisionScope,
  SemanticEvidenceResult,
} from '@forexplore/contracts';
import type { SemanticProvider } from './semantic-query-service.js';

/**
 * Host-created LSP session pinned to one immutable index revision. The Agent
 * never sees this API: it can query through SemanticQueryPort only.
 */
export interface LspSemanticSession extends RepositoryRevisionScope {
  sessionId: string;
  findDefinition?(
    request: FindDefinitionRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<DefinitionLocation>>>;
  findReferences?(
    request: FindReferencesRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<ReferenceLocation>>>;
  dispose?(): Promise<void> | void;
}

function scopeKey(scope: RepositoryRevisionScope): string {
  return `${scope.repositoryId}\u0000${scope.analysisRevision}`;
}

function assertSession(session: LspSemanticSession): void {
  if (!session.sessionId?.trim()) throw new Error('LSP sessions require a stable sessionId.');
  if (!session.repositoryId?.trim() || !session.analysisRevision?.trim()) {
    throw new Error('LSP sessions must be pinned to a repositoryId and analysisRevision.');
  }
}

/**
 * Host-owned session registry and SemanticProvider adapter. It deliberately
 * does not spawn a language server when queried, avoiding an Agent-controlled
 * process launch and preventing an unpinned current-worktree response from
 * being presented as revision evidence.
 */
export class LspSessionManager implements SemanticProvider {
  readonly provider = 'lsp' as const;
  readonly #sessions = new Map<string, Map<string, LspSemanticSession>>();

  register(session: LspSemanticSession): void {
    assertSession(session);
    const key = scopeKey(session);
    const byId = this.#sessions.get(key) ?? new Map<string, LspSemanticSession>();
    const existing = byId.get(session.sessionId);
    if (existing && existing !== session) {
      throw new Error(`An LSP session named ${session.sessionId} is already registered for this revision.`);
    }
    byId.set(session.sessionId, session);
    this.#sessions.set(key, byId);
  }

  async close(scope: RepositoryRevisionScope, sessionId?: string): Promise<void> {
    const key = scopeKey(scope);
    const sessions = this.#sessions.get(key);
    if (!sessions) return;
    const targets = sessionId ? [sessions.get(sessionId)].filter((value): value is LspSemanticSession => Boolean(value)) : [...sessions.values()];
    for (const session of targets) {
      await session.dispose?.();
      sessions.delete(session.sessionId);
    }
    if (sessions.size === 0) this.#sessions.delete(key);
  }

  async isAvailable(scope: RepositoryRevisionScope): Promise<{ available: boolean; reason?: string }> {
    const sessions = this.#sessions.get(scopeKey(scope));
    return sessions && sessions.size > 0
      ? { available: true }
      : { available: false, reason: 'No host-pinned LSP session is available for this analysis revision.' };
  }

  async findDefinition(
    request: FindDefinitionRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<DefinitionLocation>>> {
    return this.#collect(request, (session) => session.findDefinition?.(request, signal));
  }

  async findReferences(
    request: FindReferencesRequest,
    signal?: AbortSignal,
  ): Promise<Array<SemanticEvidenceResult<ReferenceLocation>>> {
    return this.#collect(request, (session) => session.findReferences?.(request, signal));
  }

  async #collect<T>(
    scope: RepositoryRevisionScope,
    call: (session: LspSemanticSession) => Promise<Array<SemanticEvidenceResult<T>>> | undefined,
  ): Promise<Array<SemanticEvidenceResult<T>>> {
    const sessions = this.#sessions.get(scopeKey(scope));
    if (!sessions) return [];
    const results = await Promise.all([...sessions.values()].map(async (session) => call(session) ?? []));
    return results.flat();
  }
}

export const lspSessionManagerInternals = { scopeKey };
