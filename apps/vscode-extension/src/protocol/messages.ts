import type {
  AdaptationResult,
  ApplyResult,
  ModuleTarget,
  SearchCandidate,
} from '@forexplore/contracts';
import type {
  ModuleExplorerPresentation,
  RepositoryStatus,
  ServiceStatus,
} from '../ui-types';

/** Snapshot sent by the trusted extension host when the panel is created. */
export interface PanelInitPayload {
  target: ModuleTarget;
  workspaceRoot: string;
  settings: PanelSettingsPresentation;
  repositoryStatuses: RepositoryStatus[];
  serviceStatus: ServiceStatus;
  moduleExplorer: ModuleExplorerPresentation;
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
}

export interface PanelSettingsPresentation {
  repositoryPaths: string[];
  topK: number;
}

/** Messages the extension host posts into the Webview. */
export type HostToWebviewMessage =
  | { type: 'INIT'; payload: PanelInitPayload }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidate[] }
  | { type: 'ADAPT_RESULT'; result: AdaptationResult }
  | { type: 'APPLY_RESULT'; result: ApplyResult }
  | { type: 'REPOSITORY_STATUS'; statuses: RepositoryStatus[] }
  | { type: 'SERVICE_STATUS'; status: ServiceStatus }
  | { type: 'MODULE_EXPLORER'; explorer: ModuleExplorerPresentation }
  | { type: 'TARGET_SELECTED'; target: ModuleTarget }
  | { type: 'SETTINGS_UPDATED'; settings: PanelSettingsPresentation }
  | { type: 'ERROR'; message: string };

/**
 * The Webview can express intent only. It never controls target paths,
 * candidate objects, validation evidence, or patches to be written.
 */
export type WebviewToHostMessage =
  | { type: 'READY' }
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
  | { type: 'SAVE_SETTINGS'; settings: PanelSettingsPresentation }
  | { type: 'SELECT_WORKSPACE_TARGET'; targetId: string }
  | { type: 'COPY_TARGET_PATH' }
  | { type: 'REVEAL_TARGET_IN_EXPLORER' }
  | { type: 'OPEN_TARGET' };

const hostMessageTypes = new Set<string>([
  'INIT',
  'SEARCH_RESULT',
  'ADAPT_RESULT',
  'APPLY_RESULT',
  'REPOSITORY_STATUS',
  'SERVICE_STATUS',
  'MODULE_EXPLORER',
  'TARGET_SELECTED',
  'SETTINGS_UPDATED',
  'ERROR',
]);

/** Strictly validates every Webview payload before it enters the host. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
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
    case 'SELECT_WORKSPACE_TARGET':
      return (
        hasOnlyKeys(message, ['type', 'targetId']) &&
        typeof message.targetId === 'string' &&
        message.targetId.length > 0 &&
        message.targetId.length <= 512
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
