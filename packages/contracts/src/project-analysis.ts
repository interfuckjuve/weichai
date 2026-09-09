import type { RepositoryRevisionScope } from './code-intelligence';

export interface ProjectAnalysisScope extends RepositoryRevisionScope { projectId: string }

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
}

export interface ProjectModuleProposal extends RepositoryRevisionScope {
  analysisHash: string;
  objective: string;
  summary?: string;
  unassignedFiles?: Array<{ path: string; reason: string }>;
  modules: ProjectModule[];
  dependencies?: Array<{ moduleId: string; dependsOnModuleId: string; evidenceIds: string[] }>;
  risks?: string[];
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
}

export interface ProjectAnalysisPort {
  ensure(scope: ProjectAnalysisScope, force?: boolean): Promise<void>;
  read(scope: ProjectAnalysisScope): Promise<ProjectAnalysisRecord>;
  idle(): Promise<void>;
}
