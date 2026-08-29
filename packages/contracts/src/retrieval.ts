import type { Language, ModuleTarget } from './module';

export interface SearchRequest {
  target: ModuleTarget;
  /** Optional natural-language context; an empty string searches by target metadata. */
  requirement: string;
  topK: number;
  /**
   * Optional caller-requested subset of repositories. HTTP retrieval services
   * authorize this only against their server-side repository allow-list. UI
   * clients should omit it and let the service apply its configured scope.
   */
  repositoryScopes?: string[];
  /**
   * Hard source-language constraint for retrieved candidates.
   * Omit it when the caller can adapt candidates from any language.
   */
  candidateLanguages?: Language[];
  /** Set to false to skip LLM reranking for this single request. */
  rerank?: boolean;
}

export interface CandidateScore {
  overall: number;
  semantic: number;
  symbol: number;
  contract: number;
  /** Hybrid weighted-RRF score used for recall ordering and tie breaks. */
  hybrid?: number;
  /** LLM reranking score (0–1), only present when reranking is active. */
  rerank?: number;
}

export interface SearchCandidate {
  id: string;
  title: string;
  repository: string;
  license: string;
  language: Language;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  score: CandidateScore;
  preview: string;
  dependencies: string[];
  compatibility: string[];
  risks: string[];
  /** LLM reranking rationale, only present when reranking is active. */
  rerankReason?: string;
}
