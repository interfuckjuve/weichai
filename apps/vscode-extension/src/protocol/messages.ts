import type {
  AdaptationResultV2,
  ApplyResult,
  EntityImplementationAssessment,
  ImplementationState,
  LanguageId,
  MigrationRouteDescriptor,
  MigrationRuntimeCapabilitySnapshot,
  MigrationRunManifestV2,
  MigrationRouteSnapshotRef,
  RepositoryModuleCatalogRef,
  MigrationTargetRef,
  SearchCandidateV2,
  SourceImplementationBundleV2,
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
  | 'container'
  | 'member'
  | 'callable';

export interface TargetWorkspaceMigrationRouteOption {
  /** Exact source x target x strategy capability selected by the trusted host. */
  route: MigrationRouteDescriptor;
  /** Degraded-but-runnable capability evidence returned by route resolution. */
  warnings: string[];
}

export interface TargetWorkspaceMigrationEligibility {
  status: 'eligible' | 'blocked';
  /** Canonical, open-ended target language. Absence always blocks execution. */
  targetLanguageId?: LanguageId;
  /** Supported exact routes. An empty set is fail-closed, never "any source". */
  routeOptions: TargetWorkspaceMigrationRouteOption[];
  reasonCodes: string[];
  summary?: string;
}

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
  /** Adapter-native symbol kind (for example function, method, trait, impl). */
  nativeKind?: string;
  /** Human-facing native/entity label; old snapshots fall back to `kind`. */
  kindLabel?: string;
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
  /** Host-derived implementation + route capability decision. */
  migrationEligibility: TargetWorkspaceMigrationEligibility;
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
  /** Combined Host-owned runtime truth used to derive route eligibility. */
  runtimeCapabilitySnapshot?: MigrationRuntimeCapabilitySnapshot;
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

/**
 * Host-owned binding retained from 01A/01B selection through the active run.
 * It prevents the migration workflow from collapsing reviewed catalog/module
 * identity into only a path and signature.
 */
export interface TargetWorkspaceMigrationSelection {
  workspaceId: string;
  targetWorkspaceSnapshotId: string;
  targetWorkspaceSnapshotHash: string;
  selection: TargetWorkspaceSelectionIdentity;
  target: MigrationTargetRef;
  module?: {
    catalogId: string;
    catalogHash: string;
    moduleId: string;
    moduleName: string;
  };
  /** Reviewed source/target catalog mapping approved before this run. */
  moduleMapping: ModuleMappingRunBinding;
  routeOptions: TargetWorkspaceMigrationRouteOption[];
}

export interface ModuleMappingRunBinding {
  mappingRunId: string;
  sourceCatalog: RepositoryModuleCatalogRef;
  targetCatalog: RepositoryModuleCatalogRef;
  mappingProposalId: string;
  mappingProposalHash: string;
  mappingReviewId: string;
  mappingReviewHash: string;
  executionOverlayId: string;
  executionOverlayHash: string;
  runtimeCapabilitySnapshot: MigrationRuntimeCapabilitySnapshot;
  route: MigrationRouteSnapshotRef;
  groupIds: string[];
  mappingIds: string[];
  sourceModuleIds: string[];
  targetModuleIds: string[];
  sourceEntityIds: string[];
  targetEntityIds: string[];
}

/** Re-exported for UI filter declarations without duplicating canonical values. */
export type TargetWorkspaceImplementationState = ImplementationState;

/** Snapshot sent by the trusted extension host when the panel is created. */
export interface PanelInitPayload {
  /** Current V2 target. It is present only after a reviewed 01B selection. */
  target?: MigrationTargetRef;
  /** Present only when a reviewed target and explicit route capabilities are bound. */
  migrationSelection?: TargetWorkspaceMigrationSelection;
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
      target: MigrationTargetRef;
      migrationSelection: TargetWorkspaceMigrationSelection;
      /** Only an explicit start intent may leave the 01B browser. */
      activateWorkflow: boolean;
    }
  | { type: 'SEARCH_RESULT'; candidates: SearchCandidateV2[] }
  | {
      type: 'CANDIDATE_SELECTED';
      candidateId: string;
      sourceBundle: SourceImplementationBundleV2;
    }
  | { type: 'ADAPT_RESULT'; result: AdaptationResultV2 }
  | { type: 'APPLY_RESULT'; result: ApplyResult; manifest: MigrationRunManifestV2 }
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
  'CANDIDATE_SELECTED',
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
  const message = value as { type?: unknown; payload?: unknown; candidates?: unknown; result?: unknown };
  if (typeof message.type !== 'string' || !hostMessageTypes.has(message.type)) return false;
  if (message.type === 'INIT' && isRecord(message.payload)) {
    const target = message.payload.target;
    if (target !== undefined && (!isRecord(target) || target.schemaVersion !== '2.0')) return false;
  }
  if (message.type === 'TARGET_ENTITY_SELECTED') {
    const target = (message as Record<string, unknown>).target;
    return isRecord(target) && target.schemaVersion === '2.0';
  }
  if (message.type === 'SEARCH_RESULT') {
    return Array.isArray(message.candidates) && message.candidates.every((candidate) =>
      isRecord(candidate) && candidate.schemaVersion === '2.0');
  }
  if (message.type === 'ADAPT_RESULT') {
    return isRecord(message.result) && message.result.schemaVersion === '2.0';
  }
  if (message.type === 'CANDIDATE_SELECTED') {
    const sourceBundle = (message as Record<string, unknown>).sourceBundle;
    return isRecord(sourceBundle) && sourceBundle.schemaVersion === '2.0';
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
