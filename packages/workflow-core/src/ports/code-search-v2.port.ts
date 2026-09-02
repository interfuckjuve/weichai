import type { SearchCandidateV2, SearchRequestV2 } from '@forexplore/contracts';

/**
 * Production V2 retrieval boundary. Requests and candidates retain their
 * content-addressed target, route, catalog and source-bundle lineage.
 */
export interface SearchPortV2 {
  search(request: SearchRequestV2, signal?: AbortSignal): Promise<SearchCandidateV2[]>;
}

/** @deprecated Prefer the neutral `SearchPortV2` name in new composition roots. */
export type CodeSearchPortV2 = SearchPortV2;
