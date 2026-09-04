import type {
  DependencyEdge,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { verifyRepositoryStaticAnalysis } from './repository-analysis.js';

/**
 * Compatibility seam for the existing Java/C# compiler-probe chain.
 *
 * The multilingual Tree-sitter index deliberately does not create semantic
 * invocation/type edges. This adapter exposes only the compiler-confirmed
 * subset of the legacy snapshot so a host can bind it to a completed
 * structural revision through the code-intelligence service.
 */
export function compilerConfirmedSemanticEdges(
  analysis: RepositoryStaticAnalysis,
): DependencyEdge[] {
  return verifyRepositoryStaticAnalysis(analysis).dependencies.filter((edge) =>
    edge.evidence === 'semantic' && edge.resolution === 'resolved',
  );
}

/** Verify a legacy snapshot before any host attempts semantic enrichment. */
export function verifyCompilerProbeAnalysis(analysis: RepositoryStaticAnalysis): RepositoryStaticAnalysis {
  return verifyRepositoryStaticAnalysis(analysis);
}
