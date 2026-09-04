import type {
  FindDefinitionRequest,
  FindDefinitionResult,
  FindReferencesRequest,
  FindReferencesResult,
  GetDependenciesRequest,
  GetDependenciesResult,
  GetDiagnosticsRequest,
  GetDiagnosticsResult,
  GetFileStructureRequest,
  GetFileStructureResult,
  GetRepositoryOverviewRequest,
  GetRepositoryOverviewResult,
  GetSymbolRequest,
  GetSymbolResult,
  ListProjectsRequest,
  ListProjectsResult,
  ListRepositoriesRequest,
  ListRepositoriesResult,
  ReadSourceExcerptRequest,
  ReadSourceExcerptResult,
  SearchSymbolsRequest,
  SearchSymbolsResult,
} from '@forexplore/contracts';

/**
 * Read-only, revision-scoped boundary for agents, MCP facades, and UI code.
 * Implementations own repository registration, storage, Tree-sitter, and LSP
 * sessions; callers can never pass an absolute path or mutate an index.
 */
export interface SemanticQueryPort {
  listRepositories(
    request?: ListRepositoriesRequest,
    signal?: AbortSignal,
  ): Promise<ListRepositoriesResult>;
  getRepositoryOverview(
    request: GetRepositoryOverviewRequest,
    signal?: AbortSignal,
  ): Promise<GetRepositoryOverviewResult>;
  listProjects(
    request: ListProjectsRequest,
    signal?: AbortSignal,
  ): Promise<ListProjectsResult>;
  getFileStructure(
    request: GetFileStructureRequest,
    signal?: AbortSignal,
  ): Promise<GetFileStructureResult>;
  searchSymbols(
    request: SearchSymbolsRequest,
    signal?: AbortSignal,
  ): Promise<SearchSymbolsResult>;
  getSymbol(
    request: GetSymbolRequest,
    signal?: AbortSignal,
  ): Promise<GetSymbolResult>;
  findDefinition(
    request: FindDefinitionRequest,
    signal?: AbortSignal,
  ): Promise<FindDefinitionResult>;
  findReferences(
    request: FindReferencesRequest,
    signal?: AbortSignal,
  ): Promise<FindReferencesResult>;
  getDependencies(
    request: GetDependenciesRequest,
    signal?: AbortSignal,
  ): Promise<GetDependenciesResult>;
  getDiagnostics(
    request: GetDiagnosticsRequest,
    signal?: AbortSignal,
  ): Promise<GetDiagnosticsResult>;
  readSourceExcerpt(
    request: ReadSourceExcerptRequest,
    signal?: AbortSignal,
  ): Promise<ReadSourceExcerptResult>;
}
