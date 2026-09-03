import type {
  IndexedModuleKnowledgeDocument,
  RepositoryKnowledgePublication,
  RepositoryModuleCatalog,
  RepositoryModuleKnowledgePage,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { materializeIndexedModuleKnowledgeDocument } from '@forexplore/workflow-core';
import { requireRepositoryScopes } from './repository-scope.js';

/**
 * Builds the searchable projection for one reviewed module knowledge page.
 * The page remains the source artifact; this projection can always be rebuilt
 * from its content hash, catalog, and unified repository IR.
 */
export function buildIndexedModuleKnowledgeDocument(
  page: RepositoryModuleKnowledgePage,
  ir: UnifiedRepositoryIR,
  catalog: RepositoryModuleCatalog,
  repositoryScopes: readonly string[],
  publication: Pick<
    RepositoryKnowledgePublication,
    | 'id'
    | 'payloadHash'
    | 'scope'
    | 'repositoryScopes'
    | 'generation'
    | 'status'
    | 'source'
  >,
): IndexedModuleKnowledgeDocument {
  const scopes = requireRepositoryScopes(repositoryScopes, 'Module knowledge repository scope');
  return materializeIndexedModuleKnowledgeDocument(page, catalog, ir, scopes, publication);
}
