import type {
  AdaptationResult,
  ApplyResult,
  EntityImplementationAssessment,
  ImplementationState,
  LanguageId,
  ModuleTarget,
  SearchCandidate,
  TargetImplementationRollup,
  TargetWorkspaceModuleSnapshot,
  TargetWorkspaceSnapshotFreshness,
} from '@forexplore/contracts';
import type { RepositoryStatus, ServiceStatus } from '../ui-types';

/**
 * A presentation-only projection of the reviewed target-workspace module
 * snapshot. Canonical ownership and implementation evidence remain in
 * `TargetWorkspaceModuleSnapshot`; the Webview receives stable IDs and never
 * supplies a path back to the trusted host.
 */
export type TargetWorkspaceNodeKind =
  | 'workspace'
  | 'module'
  | 'file'
  | 'type'
  | 'callable';

export interface TargetWorkspaceTreeNode {
  /** Unique within this tree projection. Aliases of a shared entity use different node IDs. */
  nodeId: string;
  /** Canonical IR entity/file/module identity used by the trusted host. */
  entityId: string;
  /** Reviewed functional module identity, when this node is projected under one. */
  moduleId?: string;
  /** Points at the primary projection node when a shared entity is shown more than once. */
  aliasOfNodeId?: string;
  kind: TargetWorkspaceNodeKind;
  name: string;
  qualifiedName?: string;
  /** Repository-relative display path only. It is never accepted in a Webview intent. */
  path?: string;
  languageId?: LanguageId;
  signature?: string;
  range?: {
    startLine: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
  };
  assessment?: EntityImplementationAssessment;
  rollup?: TargetImplementationRollup;
  /** Only a concrete callable with a host-resolvable target contract may be selected. */
  eligibleForTranslation: boolean;
  ineligibilityReason?: string;
  children: TargetWorkspaceTreeNode[];
}

export interface TargetWorkspaceDiagnostic {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  entityId?: string;
}

export interface TargetWorkspaceSnapshot {
  schemaVersion: '1.0';
  workspaceId: string;
  workspaceName: string;
  /** Stable UI identity for this exact materialized target snapshot. */
  snapshotId: string;
  /** Must equal the canonical module snapshot content hash. */
  contentHash: string;
  moduleSnapshot: TargetWorkspaceModuleSnapshot;
  languageIds: LanguageId[];
  freshness: TargetWorkspaceSnapshotFreshness;
  staleReason?: string;
  root: TargetWorkspaceTreeNode;
  diagnostics: TargetWorkspaceDiagnostic[];
}

export interface TargetWorkspaceInvalidation {
  snapshotId: string;
  contentHash: string;
  reason: string;
  detectedAt: string;
}

export interface TargetWorkspaceSelectionIdentity {
  snapshotId: string;
  contentHash: string;
  nodeId: string;
  entityId: string;
}

/** Re-exported for UI filter declarations without duplicating canonical values. */
export type TargetWorkspaceImplementationState = ImplementationState;

/** Snapshot sent by the trusted extension host when the panel is created. */
export interface PanelInitPayload {
  /** Legacy single-symbol entrypoint. New target-workspace panels may omit it. */
  target?: ModuleTarget;
  /** Optional first 01B snapshot; later refreshes use TARGET_WORKSPACE_SNAPSHOT. */
  targetWorkspace?: TargetWorkspaceSnapshot;
  workspaceRoot: string;
  repositoryStatuses: RepositoryStatus[];
  serviceStatus: ServiceStatus;
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
}

/** Messages the extension host posts into the Webview. */
export type HostToWebviewMessage =
  | { type: 'INIT'; payload: PanelInitPayload }
  | { type: 'TARGET_WORKSPACE_SNAPSHOT'; snapshot: TargetWorkspaceSnapshot }
  | {
      type: 'TARGET_WORKSPACE_REFRESHING';
      previousSnapshotId?: string;
      previousContentHash?: string;
    }
  | { type: 'TARGET_WORKSPACE_INVALIDATED'; invalidation: TargetWorkspaceInvalidation }
  | {
      type: 'TARGET_ENTITY_SELECTED';
      selection: TargetWorkspaceSelectionIdentity;
      target: ModuleTarget;
      /** Only an explicit start intent may leave the 01B browser. */
      activateWorkflow: boolean;
    }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidate[] }
  | { type: 'ADAPT_RESULT'; result: AdaptationResult }
  | { type: 'APPLY_RESULT'; result: ApplyResult }
  | { type: 'REPOSITORY_STATUS'; statuses: RepositoryStatus[] }
  | { type: 'SERVICE_STATUS'; status: ServiceStatus }
  | { type: 'ERROR'; message: string };

/**
 * The Webview can express intent only. It never controls target paths,
 * candidate objects, validation evidence, or patches to be written.
 */
export type WebviewToHostMessage =
  | { type: 'READY' }
  | {
      type: 'REFRESH_TARGET_WORKSPACE';
      expectedSnapshotId?: string;
      expectedContentHash?: string;
    }
  | ({ type: 'SELECT_TARGET_ENTITY' } & TargetWorkspaceSelectionIdentity)
  | ({ type: 'START_TARGET_TRANSLATION' } & TargetWorkspaceSelectionIdentity)
  | {
      type: 'START_SEARCH';
      requirement: string;
      topK: number;
    }
  | { type: 'SELECT_CANDIDATE'; candidateId: string }
  | { type: 'START_ADAPT'; decisionNotes: string }
  | { type: 'APPLY_CURRENT_RUN' }
  | { type: 'CHECK_REPOSITORIES' }
  | { type: 'OPEN_TARGET' };

const hostMessageTypes = new Set<string>([
  'INIT',
  'TARGET_WORKSPACE_SNAPSHOT',
  'TARGET_WORKSPACE_REFRESHING',
  'TARGET_WORKSPACE_INVALIDATED',
  'TARGET_ENTITY_SELECTED',
  'SEARCH_RESULT',
  'ADAPT_RESULT',
  'APPLY_RESULT',
  'REPOSITORY_STATUS',
  'SERVICE_STATUS',
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
    case 'OPEN_TARGET':
      return hasOnlyKeys(message, ['type']);
    case 'REFRESH_TARGET_WORKSPACE': {
      if (hasOnlyKeys(message, ['type'])) return true;
      return (
        hasOnlyKeys(message, ['type', 'expectedSnapshotId', 'expectedContentHash']) &&
        isBoundedOpaqueId(message.expectedSnapshotId, 256) &&
        isContentHash(message.expectedContentHash)
      );
    }
    case 'SELECT_TARGET_ENTITY':
    case 'START_TARGET_TRANSLATION':
      return (
        hasOnlyKeys(message, ['type', 'snapshotId', 'contentHash', 'nodeId', 'entityId']) &&
        isBoundedOpaqueId(message.snapshotId, 256) &&
        isContentHash(message.contentHash) &&
        isBoundedOpaqueId(message.nodeId, 512) &&
        isBoundedOpaqueId(message.entityId, 512)
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

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const received = Object.keys(value);
  return received.length === keys.length && received.every((key) => keys.includes(key));
}

function isBoundedOpaqueId(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value);
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { type?: unknown };
  return typeof message.type === 'string' && hostMessageTypes.has(message.type);
}
