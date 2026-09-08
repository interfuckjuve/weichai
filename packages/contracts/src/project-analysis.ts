import type { RepositoryRevisionScope } from './code-intelligence';

export interface ProjectAnalysisScope extends RepositoryRevisionScope { projectId: string }

export type ModuleNodeKind = 'module' | 'subsystem';
export interface ModuleRefinement {
  state: 'leaf' | 'split' | 'deferred';
  reason: string;
  decisionSource: 'model' | 'structural' | 'budget';
}

export interface ProjectModule {
  id: string;
  name: string;
  kind: string;
  description: string;
  purpose?: string;
  coreApis?: string[];
  language?: string;
  domain?: string;
  sourceFiles: string[];
  symbolKeys: string[];
  dependsOn: string[];
  evidenceIds: string[];
  /** Legacy proposals omit these fields and remain flat module forests. */
  parentId?: string | null;
  nodeKind?: ModuleNodeKind;
  refinement?: ModuleRefinement;
  metrics?: { fileCount: number; sourceBytes: number; symbolCount: number };
}

export interface ProjectModuleProposal extends RepositoryRevisionScope {
  analysisHash: string;
  objective: string;
  summary?: string;
  unassignedFiles?: Array<{ path: string; reason: string }>;
  modules: ProjectModule[];
  dependencies?: Array<{ moduleId: string; dependsOnModuleId: string; evidenceIds: string[] }>;
  risks?: string[];
  hierarchy?: {
    version: 1;
    algorithm: 'adaptive-module-tree/v1';
    maxDepth: number;
    decisionCount: number;
    modelDecisionCount: number;
    deferredCount: number;
  };
}

export interface ProjectAnalysisResult {
  proposal: ProjectModuleProposal;
  evidence: RepositoryRevisionScope & { analysisHash: string; planHash: string; evidenceIds: string[] };
}

/** Stored as revision-scoped module_artifacts: one job and one current summary per project/profile. */
export interface ProjectAnalysisRecord extends ProjectAnalysisScope {
  analysisProfile: string;
  state: 'missing' | 'queued' | 'analyzing' | 'validating' | 'ready' | 'failed' | 'stale';
  projection: 'pending' | 'ready' | 'failed';
  updatedAt: string;
  error?: string;
  proposal?: ProjectModuleProposal;
  planHash?: string;
  coverage?: { total: number; assigned: number; unassigned: Array<{ path: string; reason: string }> };
  modeling?: {
    strategy: 'structural' | 'agent';
    algorithm: string;
    maxFilesPerModule?: number;
  };
}

export interface ModuleHierarchyCandidate {
  id: string;
  name: string;
  relativePath: string;
  fileCount: number;
  sourceBytes: number;
  symbolCount: number;
  languages: string[];
  samplePaths: string[];
  coreApis: string[];
  evidenceIds: string[];
}

export interface ModuleHierarchyDecisionRequest extends ProjectAnalysisScope {
  analysisHash: string;
  nodeId: string;
  name: string;
  depth: number;
  metrics: { fileCount: number; sourceBytes: number; symbolCount: number };
  candidates: ModuleHierarchyCandidate[];
  dependencies: Array<{ sourceId: string; targetId: string; count: number; evidenceIds: string[] }>;
  excerpts: Array<{ relativePath: string; content: string; evidenceId: string }>;
}

export type ModuleHierarchyDecision = {
  action: 'stop'; name: string; nodeKind: ModuleNodeKind; description: string;
  reason: string; evidenceIds: string[];
  stopReason?: 'cohesive' | 'insufficient-evidence' | 'no-valid-split';
} | {
  action: 'split'; name: string; nodeKind: ModuleNodeKind; description: string;
  reason: string; evidenceIds: string[];
  children: Array<{ name: string; nodeKind: ModuleNodeKind; description: string; groupIds: string[]; evidenceIds: string[] }>;
};

export interface ModuleHierarchyPlanner {
  decide(request: ModuleHierarchyDecisionRequest, signal?: AbortSignal): Promise<ModuleHierarchyDecision>;
}

export interface ProjectAnalysisPort {
  ensure(scope: ProjectAnalysisScope, force?: boolean): Promise<void>;
  read(scope: ProjectAnalysisScope): Promise<ProjectAnalysisRecord>;
  idle(): Promise<void>;
}
