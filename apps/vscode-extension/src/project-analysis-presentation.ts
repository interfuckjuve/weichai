import { indexModuleHierarchy, type ProjectAnalysisRecord } from '@forexplore/contracts';
import type { ProjectAnalysisPresentation } from './ui-types';

export const projectAnalysisDetailLimit = 200;

/** Both UI channels share metadata; complete module evidence stays in the host artifact. */
export function projectAnalysisPresentation(record: ProjectAnalysisRecord): ProjectAnalysisPresentation {
  const { proposal, coverage, ...metadata } = record;
  const tree = proposal ? indexModuleHierarchy(proposal.modules) : undefined;
  const modules = proposal?.modules ?? [];
  return {
    ...metadata,
    ...(proposal && tree ? {
      proposal: { summary: proposal.summary, risks: proposal.risks, hierarchy: proposal.hierarchy },
      hierarchy: {
        nodeCount: modules.length,
        rootCount: tree.roots.length,
        moduleCount: modules.filter((module) => module.nodeKind !== 'subsystem').length,
        subsystemCount: modules.filter((module) => module.nodeKind === 'subsystem').length,
        leafCount: modules.filter((module) => module.refinement?.state === 'leaf').length,
        splitCount: modules.filter((module) => module.refinement?.state === 'split').length,
        deferredCount: modules.filter((module) => module.refinement?.state === 'deferred').length,
        unknownCount: modules.filter((module) => !module.refinement).length,
        maxDepth: [...tree.depthById.values()].reduce((maximum, depth) => Math.max(maximum, depth), 0),
      },
    } : {}),
    ...(coverage ? { coverage: { ...coverage, unassigned: coverage.unassigned.slice(0, projectAnalysisDetailLimit),
      unassignedTotal: coverage.unassigned.length } } : {}),
  };
}
