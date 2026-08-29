import type {
  Language,
  SearchCandidate,
  SearchRequest,
} from '@forexplore/contracts';
import type {
  EmbeddingProvider,
  IndexedCodeDocument,
  RetrievedCodeDocument,
  SearchEngine,
  SearchFilters,
  SearchStore,
} from './types.js';
import { expandedSearchText, overlap } from './text-analysis.js';
import { requireRepositoryScopes } from './repository-scope.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function repositoryScopes(values: string[] | undefined): string[] {
  return requireRepositoryScopes(values);
}

function candidateLanguages(values: Language[] | undefined): Language[] {
  return [...new Set(values ?? [])];
}

function expandedLimit(topK: number): number {
  return Math.min(250, Math.max(50, topK * 5));
}

function candidateKinds(
  targetKind: SearchRequest['target']['kind'],
): IndexedCodeDocument['kind'][] {
  return [targetKind];
}

function queryText(request: SearchRequest): string {
  const raw = [
    request.target.name,
    request.target.signature,
    request.target.documentation ?? '',
    request.target.kind,
    request.target.language,
    request.target.path,
    request.requirement,
  ].join('\n');
  return `${raw}\n${expandedSearchText(raw)}`;
}

function documentText(document: IndexedCodeDocument): string {
  return [
    document.title,
    document.repository,
    document.path,
    document.signature,
    document.summary,
    document.content || document.preview,
    ...document.dependencies,
  ].join('\n');
}

function mergeResults(
  semantic: RetrievedCodeDocument[],
  text: RetrievedCodeDocument[],
): RetrievedCodeDocument[] {
  const merged = new Map<
    string,
    { document: RetrievedCodeDocument; reciprocalRank: number }
  >();
  const add = (
    documents: RetrievedCodeDocument[],
    weight: number,
    scoreKey: 'semanticScore' | 'textScore',
  ) => {
    documents.forEach((document, index) => {
      const current = merged.get(document.id);
      const reciprocalRank = weight / (60 + index + 1);
      merged.set(document.id, {
        document: {
          ...(current?.document ?? document),
          [scoreKey]: document[scoreKey],
        },
        reciprocalRank: (current?.reciprocalRank ?? 0) + reciprocalRank,
      });
    });
  };
  add(semantic, 0.65, 'semanticScore');
  add(text, 0.35, 'textScore');
  return [...merged.values()]
    .map(({ document, reciprocalRank }) => ({
      ...document,
      hybridScore: reciprocalRank,
    }))
    .sort((left, right) => (right.hybridScore ?? 0) - (left.hybridScore ?? 0));
}

function overallScore(
  semantic: number,
  symbol: number,
  contract: number,
  text: number,
): number {
  return clamp(0.5 * semantic + 0.2 * text + 0.15 * symbol + 0.15 * contract);
}

function candidate(
  document: RetrievedCodeDocument,
  request: SearchRequest,
): SearchCandidate {
  const searchText = queryText(request);
  const semantic = clamp(document.semanticScore ?? overlap(searchText, documentText(document)));
  const lexical = overlap(searchText, documentText(document));
  const text = clamp(
    document.textScore === undefined ? lexical : 0.7 * document.textScore + 0.3 * lexical,
  );
  const targetContext = [
    request.target.name,
    request.target.signature,
    request.target.documentation ?? '',
    request.target.path,
  ].join('\n');
  const candidateSymbol = [document.title, document.signature].join('\n');
  const symbol = clamp(
    0.4 * overlap(request.target.name, candidateSymbol) +
      0.35 * overlap(request.target.signature, candidateSymbol) +
      0.25 * overlap(targetContext, documentText(document)),
  );
  const contract = clamp(
    (request.target.kind === document.kind ? 0.55 : 0.2) +
      (request.target.language === document.language ? 0.3 : 0.15) +
      (document.dependencies.length === 0 ? 0.15 : 0.05),
  );
  return {
    id: document.id,
    title: document.title,
    repository: document.repository,
    license: document.license,
    language: document.language,
    kind: document.kind,
    path: document.path,
    signature: document.signature,
    summary: document.summary,
    score: {
      overall: overallScore(semantic, symbol, contract, text),
      semantic,
      symbol,
      contract,
      hybrid: document.hybridScore,
    },
    preview: document.preview,
    dependencies: document.dependencies,
    compatibility: document.compatibility,
    risks: document.risks,
  };
}

export class SeekDbSearchEngine implements SearchEngine {
  constructor(
    private readonly store: SearchStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly candidateLimitOverride?: number,
  ) {}

  async search(request: SearchRequest): Promise<SearchCandidate[]> {
    const text = queryText(request);
    const languages = candidateLanguages(request.candidateLanguages);
    const filters: SearchFilters = {
      repositories: repositoryScopes(request.repositoryScopes),
      languages,
      kinds: candidateKinds(request.target.kind),
    };
    const candidateLimit = this.candidateLimitOverride ?? expandedLimit(request.topK);
    const [embedding] = await this.embeddings.embed([text]);
    if (!embedding) throw new Error('Embedding provider returned no query vector.');
    const [semantic, fullText] = await Promise.all([
      this.store.semanticSearch(embedding, filters, candidateLimit),
      this.store.textSearch(text, filters, candidateLimit),
    ]);
    const documents = mergeResults(semantic, fullText);

    const allowedLanguages = new Set(languages);
    return documents
      .filter(
        (document) =>
          document.kind === request.target.kind &&
          (allowedLanguages.size === 0 || allowedLanguages.has(document.language)),
      )
      .map((document) => candidate(document, request))
      .sort((left, right) => {
        const hybridDelta = (right.score.hybrid ?? 0) - (left.score.hybrid ?? 0);
        return hybridDelta || right.score.overall - left.score.overall;
      })
      .slice(0, request.topK);
  }
}

export const searchInternals = {
  candidateLanguages,
  candidateKinds,
  expandedLimit,
  mergeResults,
  overlap,
  queryText,
  repositoryScopes,
};
