/** Types that exist only at the extension presentation boundary. */
export type ExecutionMode = 'real';

export type ServiceConnection = 'connected' | 'unconfigured' | 'error';

export interface ServiceStatus {
  retrieval: ServiceConnection;
  adaptation: ServiceConnection;
  executionMode: ExecutionMode;
  message?: string;
}

export interface RepositoryStatus {
  path: string;
  exists: boolean;
  readable: boolean;
  /** Local paths are not proof of service-side indexing. */
  indexed: boolean;
  stale: boolean;
  message: string;
}

export type ModuleExplorerMode = 'target' | 'history';

export type ModuleExplorerNodeKind =
  | 'module'
  | 'folder'
  | 'file'
  | 'class'
  | 'interface'
  | 'record'
  | 'struct'
  | 'enum'
  | 'method'
  | 'constructor'
  | 'function';

export type ModuleImplementationStatus =
  | 'implemented'
  | 'unimplemented'
  | 'partial'
  | 'unknown'
  | 'not-applicable';

export type ModuleWorkspaceAction =
  | 'initialize-target'
  | 'review-target-boundaries'
  | 'retry-target-inventory'
  | 'rebase-target'
  | 'import-history'
  | 'review-history-boundaries'
  | 'generate-history-summaries'
  | 'review-history-knowledge'
  | 'withdraw-history-publication';

export interface ModuleWorkspaceLifecyclePresentation {
  /** Host-owned lifecycle stage. It is presentation data, not an action token. */
  stage: string;
  label: string;
  message: string;
  ready: boolean;
  publicationActive: boolean;
  nextAction?: ModuleWorkspaceAction;
  nextActionLabel?: string;
}

/** Current reviewed 01A catalog identity. Draft catalogs never receive this identity. */
export interface HistoryModuleSelectionIdentity {
  repositoryRegistrationId: string;
  repositoryId: string;
  catalogId: string;
  catalogHash: string;
  moduleId: string;
}

/** Read-only tree item produced from a trusted host-side static-analysis snapshot. */
export interface ModuleExplorerNode {
  id: string;
  name: string;
  kind: ModuleExplorerNodeKind;
  path?: string;
  language?: string;
  signature?: string;
  line?: number;
  implementationStatus?: ModuleImplementationStatus;
  targetId?: string;
  historyModule?: HistoryModuleSelectionIdentity;
  description?: string;
  children: ModuleExplorerNode[];
}

export interface ModuleExplorerStats {
  modules: number;
  files: number;
  types: number;
  methods: number;
  implemented: number;
  unimplemented: number;
  partial: number;
  unknown: number;
  notApplicable: number;
  dependencies: number;
}

export interface ModuleSummaryPresentation {
  exists: boolean;
  path: string;
  error?: string;
  planId?: string;
  status?: string;
  approvalsCurrent?: boolean;
  moduleCount?: number;
  waveCount?: number;
}

export interface ModuleWorkspacePresentation {
  id: string;
  mode: ModuleExplorerMode;
  name: string;
  rootLabel: string;
  snapshotId?: string;
  revision?: string;
  loading?: boolean;
  error?: string;
  lifecycle: ModuleWorkspaceLifecyclePresentation;
  catalog?: {
    id: string;
    contentHash: string;
    status: string;
  };
  stats: ModuleExplorerStats;
  summary: ModuleSummaryPresentation;
  tree: ModuleExplorerNode[];
}

/** Complete module-navigation snapshot sent by the trusted extension host. */
export interface ModuleExplorerPresentation {
  generatedAt: string;
  target: ModuleWorkspacePresentation;
  history: ModuleWorkspacePresentation[];
}
