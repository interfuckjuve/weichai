import type {
  AdaptationResult,
  ApplyResult,
  ModuleTarget,
  SearchCandidate,
  ContextPacket,
  TaskRetrievalRequest,
  RepositoryRevisionScope,
} from '@forexplore/contracts';
import type {
  ModuleExplorerPresentation,
  RepositoryStatus,
  ServiceStatus,
  CodeIntelligencePresentation,
  ModuleChildrenPage,
  ModuleChildrenRequest,
} from '../ui-types';

/** Snapshot sent by the trusted extension host when the panel is created. */
export interface PanelInitPayload {
  target: ModuleTarget | null;
  workspaceRoot: string;
  settings: PanelSettingsPresentation;
  repositoryStatuses: RepositoryStatus[];
  /** Path-free status for the shared versioned structural/semantic index. */
  codeIntelligence: CodeIntelligencePresentation;
  serviceStatus: ServiceStatus;
  moduleExplorer: ModuleExplorerPresentation;
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
}

export interface PanelSettingsPresentation {
  repositoryPaths: string[];
  topK: number;
}

export interface TaskSearchIntent {
  requirement: string;
  scope: 'target' | 'all';
  granularity: NonNullable<TaskRetrievalRequest['granularity']>;
}

export type TaskSearchTargetScope = RepositoryRevisionScope & { projectId?: string };

/** Messages the extension host posts into the Webview. */
export type HostToWebviewMessage =
  | { type: 'INIT'; payload: PanelInitPayload }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidate[] }
  | { type: 'TASK_SEARCH_RESULT'; requestId: string; packet: ContextPacket }
  | { type: 'TASK_SEARCH_ERROR'; requestId: string; message: string }
  | { type: 'ADAPT_RESULT'; result: AdaptationResult }
  | { type: 'APPLY_RESULT'; result: ApplyResult }
  | { type: 'REPOSITORY_STATUS'; statuses: RepositoryStatus[] }
  | { type: 'CODE_INTELLIGENCE_STATUS'; presentation: CodeIntelligencePresentation }
  | { type: 'SERVICE_STATUS'; status: ServiceStatus }
  | { type: 'MODULE_EXPLORER'; explorer: ModuleExplorerPresentation }
  | { type: 'MODULE_CHILDREN'; requestId: string; page: ModuleChildrenPage }
  | { type: 'MODULE_CHILDREN_ERROR'; requestId: string; message: string }
  | { type: 'TARGET_SELECTED'; target: ModuleTarget }
  | { type: 'TARGET_CLEARED' }
  | { type: 'SETTINGS_UPDATED'; settings: PanelSettingsPresentation }
  | { type: 'ERROR'; message: string };

/**
 * The Webview can express intent only. It never controls target paths,
 * candidate objects, validation evidence, or patches to be written.
 */
export type WebviewToHostMessage =
  | { type: 'READY' }
  | { type: 'START_TASK_SEARCH'; requestId: string; targetScope: TaskSearchTargetScope; request: TaskSearchIntent }
  | { type: 'CANCEL_TASK_SEARCH'; requestId: string }
  | { type: 'LOAD_MODULE_CHILDREN'; requestId: string; request: ModuleChildrenRequest }
  | { type: 'ADD_TARGET_WORKSPACE'; mode: 'browse' | 'input' | 'workspace' }
  | {
      type: 'START_SEARCH';
      requirement: string;
      topK: number;
    }
  | { type: 'SELECT_CANDIDATE'; candidateId: string }
  | { type: 'START_ADAPT'; decisionNotes: string }
  | { type: 'APPLY_CURRENT_RUN' }
  | { type: 'CHECK_REPOSITORIES' }
  | { type: 'REFRESH_MODULE_EXPLORER' }
  | { type: 'REFRESH_REPOSITORY'; repositoryId: string }
  | { type: 'SAVE_SETTINGS'; settings: PanelSettingsPresentation }
  /**
   * Opaque IDs only. The extension host verifies that the exact revision
   * already belongs to the registered repository before using it read-only.
   */
  | { type: 'SELECT_CODE_INTELLIGENCE_REVISION'; repositoryId: string; analysisRevision: string }
  | { type: 'SELECT_CODE_INTELLIGENCE_PROJECT'; repositoryId: string; analysisRevision: string; projectId: string }
  | { type: 'RETRY_PROJECT_ANALYSIS'; repositoryId: string; analysisRevision: string; projectId: string; force: boolean }
  | { type: 'SELECT_WORKSPACE_TARGET'; targetId: string }
  | { type: 'COPY_TARGET_PATH' }
  | { type: 'REVEAL_TARGET_IN_EXPLORER' }
  | { type: 'OPEN_TARGET' };

const hostMessageTypes = new Set<string>([
  'INIT',
  'SEARCH_RESULT',
  'TASK_SEARCH_RESULT',
  'TASK_SEARCH_ERROR',
  'ADAPT_RESULT',
  'APPLY_RESULT',
  'REPOSITORY_STATUS',
  'CODE_INTELLIGENCE_STATUS',
  'SERVICE_STATUS',
  'MODULE_EXPLORER',
  'MODULE_CHILDREN',
  'MODULE_CHILDREN_ERROR',
  'TARGET_SELECTED',
  'TARGET_CLEARED',
  'SETTINGS_UPDATED',
  'ERROR',
]);

/** Strictly validates every Webview payload before it enters the host. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'LOAD_MODULE_CHILDREN': {
      if (!hasOnlyKeys(message, ['type', 'requestId', 'request']) || !isOpaqueIdentifier(message.requestId) ||
        typeof message.request !== 'object' || message.request === null) return false;
      const request = message.request as Record<string, unknown>;
      return Object.keys(request).every((key) => ['repositoryId', 'analysisRevision', 'projectId', 'nodeId', 'offset', 'query', 'status'].includes(key)) &&
        [request.repositoryId, request.analysisRevision, request.projectId].every(isOpaqueIdentifier) &&
        typeof request.nodeId === 'string' && request.nodeId.length > 0 && request.nodeId.length <= 4096 &&
        Number.isSafeInteger(request.offset) && typeof request.offset === 'number' && request.offset >= 0 &&
        (request.query === undefined || (typeof request.query === 'string' && request.query.length <= 200)) &&
        (request.status === undefined || ['all', 'implemented', 'unimplemented', 'unknown'].includes(request.status as string));
    }
    case 'START_TASK_SEARCH':
      return hasOnlyKeys(message, ['type', 'requestId', 'targetScope', 'request']) &&
        isOpaqueIdentifier(message.requestId) && isTaskSearchScope(message.targetScope) && isTaskSearchIntent(message.request);
    case 'CANCEL_TASK_SEARCH':
      return hasOnlyKeys(message, ['type', 'requestId']) && isOpaqueIdentifier(message.requestId);
    case 'ADD_TARGET_WORKSPACE':
      return hasOnlyKeys(message, ['type', 'mode']) && typeof message.mode === 'string' && ['browse', 'input', 'workspace'].includes(message.mode);
    case 'READY':
    case 'APPLY_CURRENT_RUN':
    case 'CHECK_REPOSITORIES':
    case 'REFRESH_MODULE_EXPLORER':
    case 'COPY_TARGET_PATH':
    case 'REVEAL_TARGET_IN_EXPLORER':
    case 'OPEN_TARGET':
      return hasOnlyKeys(message, ['type']);
    case 'SAVE_SETTINGS':
      return (
        hasOnlyKeys(message, ['type', 'settings']) &&
        isPanelSettings(message.settings)
      );
    case 'START_SEARCH':
      return (
        hasOnlyKeys(message, ['type', 'requirement', 'topK']) &&
        typeof message.requirement === 'string' &&
        message.requirement.length <= 8_000 &&
        Number.isInteger(message.topK) &&
        typeof message.topK === 'number' &&
        message.topK >= 1 &&
        message.topK <= 10
      );
    case 'SELECT_CANDIDATE':
      return (
        hasOnlyKeys(message, ['type', 'candidateId']) &&
        typeof message.candidateId === 'string' &&
        message.candidateId.length > 0 &&
        message.candidateId.length <= 256
      );
    case 'RETRY_PROJECT_ANALYSIS':
      return hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision', 'projectId', 'force']) &&
        [message.repositoryId, message.analysisRevision, message.projectId].every((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(id)) && typeof message.force === 'boolean';
    case 'REFRESH_REPOSITORY':
      return hasOnlyKeys(message, ['type', 'repositoryId']) && typeof message.repositoryId === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(message.repositoryId);
    case 'SELECT_WORKSPACE_TARGET':
      return (
        hasOnlyKeys(message, ['type', 'targetId']) &&
        typeof message.targetId === 'string' &&
        message.targetId.length > 0 &&
        message.targetId.length <= 512
      );
    case 'SELECT_CODE_INTELLIGENCE_REVISION':
      return (
        hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision']) &&
        isOpaqueIdentifier(message.repositoryId) &&
        isOpaqueIdentifier(message.analysisRevision)
      );
    case 'SELECT_CODE_INTELLIGENCE_PROJECT':
      return (
        hasOnlyKeys(message, ['type', 'repositoryId', 'analysisRevision', 'projectId']) &&
        isOpaqueIdentifier(message.repositoryId) &&
        isOpaqueIdentifier(message.analysisRevision) &&
        isOpaqueIdentifier(message.projectId)
      );
    case 'START_ADAPT':
      return (
        hasOnlyKeys(message, ['type', 'decisionNotes']) &&
        typeof message.decisionNotes === 'string' &&
        message.decisionNotes.length <= 8_000
      );
    default:
      return false;
  }
}

function isTaskSearchScope(value: unknown): value is TaskSearchTargetScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).every((key) => ['repositoryId', 'analysisRevision', 'projectId'].includes(key)) &&
    isOpaqueIdentifier(scope.repositoryId) && isOpaqueIdentifier(scope.analysisRevision) &&
    (scope.projectId === undefined || isOpaqueIdentifier(scope.projectId));
}

function isTaskSearchIntent(value: unknown): value is TaskSearchIntent {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return hasOnlyKeys(request, ['requirement', 'scope', 'granularity']) &&
    typeof request.requirement === 'string' && Boolean(request.requirement.trim()) && request.requirement.length <= 8_000 &&
    ['target', 'all'].includes(String(request.scope)) &&
    ['auto', 'function', 'class', 'module', 'subsystem'].includes(String(request.granularity));
}

/** IDs are looked up by the host; this rejects control data, not local paths. */
function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isPanelSettings(value: unknown): value is PanelSettingsPresentation {
  if (typeof value !== 'object' || value === null) return false;
  const settings = value as Record<string, unknown>;
  return (
    hasOnlyKeys(settings, ['repositoryPaths', 'topK']) &&
    Array.isArray(settings.repositoryPaths) &&
    settings.repositoryPaths.length <= 20 &&
    settings.repositoryPaths.every(
      (path) => typeof path === 'string' && path.trim().length > 0 && path.length <= 1_000,
    ) &&
    typeof settings.topK === 'number' &&
    Number.isInteger(settings.topK) &&
    settings.topK >= 1 &&
    settings.topK <= 10
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const received = Object.keys(value);
  return received.length === keys.length && received.every((key) => keys.includes(key));
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown };
  return typeof message.type === 'string' && hostMessageTypes.has(message.type);
}
