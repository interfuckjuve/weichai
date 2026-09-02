import type {
  AdaptationResultV2,
  ApplyResult,
  MigrationRunManifestV2,
  MigrationTargetRef,
  SearchCandidateV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';

export type WorkflowStageV2 =
  | 'target'
  | 'requirement'
  | 'candidates'
  | 'adaptation'
  | 'patch'
  | 'complete';

export interface WorkflowStateV2 {
  stage: WorkflowStageV2;
  target: MigrationTargetRef | null;
  requirement: string;
  topK: number;
  candidates: SearchCandidateV2[];
  selectedCandidateId: string | null;
  sourceBundle: SourceImplementationBundleV2 | null;
  decisionNotes: string;
  adaptation: AdaptationResultV2 | null;
  applyResult: ApplyResult | null;
  manifest: MigrationRunManifestV2 | null;
  pending: 'search' | 'resolve' | 'adapt' | 'apply' | null;
}

export type WorkflowEventV2 =
  | { type: 'RESET' }
  | { type: 'SELECT_TARGET'; target: MigrationTargetRef }
  | { type: 'SET_REQUIREMENT'; value: string }
  | { type: 'SET_TOP_K'; value: number }
  | { type: 'SEARCH_START' }
  | { type: 'SEARCH_SUCCESS'; candidates: SearchCandidateV2[] }
  | { type: 'SEARCH_FAILURE'; message: string }
  | { type: 'CANDIDATE_RESOLVE_START'; candidateId: string }
  | {
      type: 'CANDIDATE_RESOLVE_SUCCESS';
      candidateId: string;
      sourceBundle: SourceImplementationBundleV2;
    }
  | { type: 'CANDIDATE_RESOLVE_FAILURE'; message: string }
  | { type: 'SET_DECISION_NOTES'; value: string }
  | { type: 'ADAPT_START' }
  | { type: 'ADAPT_SUCCESS'; result: AdaptationResultV2 }
  | { type: 'ADAPT_FAILURE'; message: string }
  | { type: 'APPLY_START' }
  | { type: 'APPLY_SUCCESS'; result: ApplyResult; manifest: MigrationRunManifestV2 }
  | { type: 'APPLY_FAILURE'; message: string }
  | { type: 'RETURN_TO_CANDIDATES' };

export const initialWorkflowStateV2: WorkflowStateV2 = {
  stage: 'target',
  target: null,
  requirement: '',
  topK: 5,
  candidates: [],
  selectedCandidateId: null,
  sourceBundle: null,
  decisionNotes: '',
  adaptation: null,
  applyResult: null,
  manifest: null,
  pending: null,
};

export function workflowReducerV2(
  state: WorkflowStateV2,
  event: WorkflowEventV2,
): WorkflowStateV2 {
  switch (event.type) {
    case 'RESET':
      return initialWorkflowStateV2;
    case 'SELECT_TARGET':
      return { ...initialWorkflowStateV2, stage: 'requirement', target: event.target };
    case 'SET_REQUIREMENT':
      return { ...state, requirement: event.value };
    case 'SET_TOP_K':
      return { ...state, topK: Math.max(1, Math.min(10, Math.floor(event.value))) };
    case 'SEARCH_START':
      return {
        ...state,
        pending: 'search',
        candidates: [],
        selectedCandidateId: null,
        sourceBundle: null,
        adaptation: null,
        applyResult: null,
        manifest: null,
      };
    case 'SEARCH_SUCCESS':
      return { ...state, stage: 'candidates', pending: null, candidates: event.candidates };
    case 'SEARCH_FAILURE':
      return { ...state, pending: null };
    case 'CANDIDATE_RESOLVE_START':
      return {
        ...state,
        selectedCandidateId: event.candidateId,
        sourceBundle: null,
        adaptation: null,
        applyResult: null,
        manifest: null,
        pending: 'resolve',
      };
    case 'CANDIDATE_RESOLVE_SUCCESS':
      if (state.selectedCandidateId !== event.candidateId) return state;
      return { ...state, sourceBundle: event.sourceBundle, pending: null };
    case 'CANDIDATE_RESOLVE_FAILURE':
      return { ...state, selectedCandidateId: null, sourceBundle: null, pending: null };
    case 'SET_DECISION_NOTES':
      return { ...state, decisionNotes: event.value };
    case 'ADAPT_START':
      return { ...state, stage: 'adaptation', pending: 'adapt', adaptation: null };
    case 'ADAPT_SUCCESS':
      return { ...state, stage: 'patch', pending: null, adaptation: event.result };
    case 'ADAPT_FAILURE':
      return { ...state, stage: 'candidates', pending: null };
    case 'APPLY_START':
      return { ...state, pending: 'apply' };
    case 'APPLY_SUCCESS':
      return {
        ...state,
        stage: 'complete',
        pending: null,
        applyResult: event.result,
        manifest: event.manifest,
      };
    case 'APPLY_FAILURE':
      return { ...state, pending: null };
    case 'RETURN_TO_CANDIDATES':
      return { ...state, stage: 'candidates', adaptation: null, applyResult: null, manifest: null };
  }
}

export function selectedCandidateV2(state: WorkflowStateV2): SearchCandidateV2 | null {
  if (!state.selectedCandidateId) return null;
  return state.candidates.find((candidate) => candidate.id === state.selectedCandidateId) ?? null;
}
