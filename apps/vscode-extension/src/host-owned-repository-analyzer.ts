import type { RepositoryStaticAnalysis } from '@forexplore/contracts';
import {
  analyzeRepository,
  createDefaultRepositoryLanguageRegistry,
  type AnalyzeRepositoryRequest,
  type RepositoryLanguageAdapterDescriptor,
  type RepositoryLanguageRegistry,
} from '@forexplore/code-indexer';

export type RepositoryAnalysisFunction = (
  request: AnalyzeRepositoryRequest,
) => Promise<RepositoryStaticAnalysis>;

export interface HostOwnedRepositoryAnalyzerOptions {
  languageRegistry?: RepositoryLanguageRegistry;
  analyze?: RepositoryAnalysisFunction;
  semanticEnrichment?: boolean;
  allowDirtyWorktreeForPlanning?: boolean;
}

/**
 * One trusted analysis composition shared by initial indexing, refresh and
 * review gates. Call sites cannot silently replace its registry or analysis
 * mode, so custom-language evidence is reverified by the same adapter set.
 */
export class HostOwnedRepositoryAnalyzer {
  readonly #languageRegistry: RepositoryLanguageRegistry;
  readonly #analyze: RepositoryAnalysisFunction;
  readonly #semanticEnrichment: boolean;
  readonly #allowDirtyWorktreeForPlanning: boolean;

  constructor(options: HostOwnedRepositoryAnalyzerOptions = {}) {
    this.#languageRegistry = options.languageRegistry ?? createDefaultRepositoryLanguageRegistry();
    this.#analyze = options.analyze ?? analyzeRepository;
    this.#semanticEnrichment = options.semanticEnrichment ?? true;
    this.#allowDirtyWorktreeForPlanning = options.allowDirtyWorktreeForPlanning ?? true;
  }

  analyze(request: AnalyzeRepositoryRequest): Promise<RepositoryStaticAnalysis> {
    return this.#analyze({
      ...request,
      semanticEnrichment: this.#semanticEnrichment,
      allowDirtyWorktreeForPlanning: this.#allowDirtyWorktreeForPlanning,
      languageRegistry: this.#languageRegistry,
    });
  }

  descriptors(): RepositoryLanguageAdapterDescriptor[] {
    return this.#languageRegistry.descriptors();
  }

  fingerprint(): string {
    return this.#languageRegistry.fingerprint();
  }
}
