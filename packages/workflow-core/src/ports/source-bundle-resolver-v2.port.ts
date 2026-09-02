import type {
  IndexedImplementationDocumentV2,
  SearchCandidateV2,
  SearchRequestV2,
  SourceImplementationBundleV2,
} from '@forexplore/contracts';

export interface ResolveSourceBundleV2Request {
  request: SearchRequestV2;
  candidate: SearchCandidateV2;
}

export interface ResolvedSourceBundleV2 {
  indexedDocument: IndexedImplementationDocumentV2;
  bundle: SourceImplementationBundleV2;
}

/** Fetches full source only after selection; search results carry references, not source bodies. */
export interface SourceBundleResolverPortV2 {
  resolveSourceBundle(
    request: ResolveSourceBundleV2Request,
    signal?: AbortSignal,
  ): Promise<ResolvedSourceBundleV2>;
}
