import type {
  AnalysisRevisionStatus,
  LanguageCapabilityLevel,
  RepositoryAnalysisStatus,
  RepositoryId,
  RepositoryRole,
} from '@forexplore/contracts';

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

/**
 * Path-free view of the shared code-intelligence index.  This type is kept
 * separate from the host implementation so it is safe for the Webview build.
 */
export interface CodeIntelligenceSummaryPresentation {
  status: 'missing' | 'current' | 'stale';
  analysisRevision?: string;
  analysisHash?: string;
  planHash?: string;
  updatedAt?: string;
}

export interface CodeIntelligenceLanguagePresentation {
  languageId: string;
  capabilityLevel: LanguageCapabilityLevel;
  fileCount: number;
}

export interface CodeIntelligenceProjectPresentation {
  analysis?: import('@forexplore/contracts').ProjectAnalysisRecord;
  projectId: string;
  displayName: string;
  kind: string;
  relativePath: string;
  languageIds: string[];
}

/**
 * A revision that remains available through the read-only SemanticQueryPort.
 * It intentionally contains metadata only: no local paths, database details,
 * source text, or mutable repository state cross into the Webview.
 */
export interface CodeIntelligenceRevisionPresentation {
  analysisRevision: string;
  analysisHash: string;
  status: Extract<AnalysisRevisionStatus, 'ready' | 'superseded'>;
  createdAt: string;
  completedAt?: string;
  isActive: boolean;
  isSelected: boolean;
}

export interface CodeIntelligenceRepositoryPresentation {
  repositoryId: RepositoryId;
  displayName: string;
  role: RepositoryRole;
  analysisStatus: RepositoryAnalysisStatus;
  /** The repository's immutable active revision; selection never changes it. */
  activeRevision: string | null;
  /** The revision currently shown by this read-only Webview presentation. */
  selectedRevision: string | null;
  /** All revisions which the host verified are safe for read-only queries. */
  revisions: CodeIntelligenceRevisionPresentation[];
  languages: CodeIntelligenceLanguagePresentation[];
  projects: CodeIntelligenceProjectPresentation[];
  selectedProjectId: string | null;
  summary: CodeIntelligenceSummaryPresentation;
}

export interface CodeIntelligencePresentation {
  status: 'ready' | 'initializing' | 'error';
  storage: 'seekdb' | 'memory';
  repositories: CodeIntelligenceRepositoryPresentation[];
  message?: string;
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

export type ModuleImplementationStatus = 'implemented' | 'unimplemented' | 'unknown';

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
  description?: string;
  purpose?: string;
  coreApis?: string[];
  domain?: string;
  children: ModuleExplorerNode[];
}

export interface ModuleExplorerStats {
  modules: number;
  files: number;
  types: number;
  methods: number;
  implemented: number;
  unimplemented: number;
  unknown: number;
  dependencies: number;
}

export interface ModuleSummaryPresentation {
  exists: boolean;
  path: '.forexplore/module-summary.json';
  error?: string;
  planId?: string;
  status?: string;
  approvalsCurrent?: boolean;
  moduleCount?: number;
  waveCount?: number;
}

export interface ModuleWorkspacePresentation {
  repositoryId?: string;
  projectId?: string;
  analysis?: import('@forexplore/contracts').ProjectAnalysisRecord;
  dependencies?: import('@forexplore/contracts').DependencyEdgeRecord[];
  diagnostics?: import('@forexplore/contracts').IndexDiagnosticRecord[];
  id: string;
  mode: ModuleExplorerMode;
  name: string;
  rootLabel: string;
  snapshotId?: string;
  revision?: string;
  loading?: boolean;
  error?: string;
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
