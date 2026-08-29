import type {
  ModuleMigrationProposal,
  RepositoryArchitectureRequest,
} from '@forexplore/contracts';

/**
 * The only model-facing boundary for module architecture planning.  It is
 * intentionally read-only: plan validation, scheduling, summary generation,
 * and all writes remain host-controlled operations.
 */
export interface RepositoryArchitecturePort {
  proposeModulePlan(
    request: RepositoryArchitectureRequest,
    signal?: AbortSignal,
  ): Promise<ModuleMigrationProposal>;
}
