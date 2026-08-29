import type {
  ExecutionGroup,
  ExecutionWave,
  FunctionalModule,
  ModuleDependency,
  ModuleMigrationProposal,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  buildModuleOwnershipIndex,
  isUncertainInternalDependency,
  moduleDependencyKey,
  moduleIdTupleKey,
  resolveDependencyModuleEndpoints,
  validateModuleMigrationProposal,
  type ModulePlanValidationResult,
} from './module-plan-validator';
import { sortedUnique } from './module-plan-utils';

export interface ModuleScheduleOptions {
  /** Default is deliberately small; parallelism only applies to preparation. */
  maxParallelism?: number;
}

export interface ModuleSchedule {
  dependencies: ModuleDependency[];
  executionGroups: ExecutionGroup[];
  executionWaves: ExecutionWave[];
}

export class ModulePlanValidationError extends Error {
  readonly validation: ModulePlanValidationResult;

  constructor(validation: ModulePlanValidationResult) {
    super(
      `Module migration plan is invalid: ${validation.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code)
        .join(', ')}`,
    );
    this.name = 'ModulePlanValidationError';
    this.validation = validation;
  }
}

interface GroupDraft {
  id: string;
  moduleIds: string[];
  kind: ExecutionGroup['kind'];
  dependsOnGroupIds: Set<string>;
  writeSet: Set<string>;
  resourceLocks: Set<string>;
  reasons: Set<string>;
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  const values: string[] = [];
  for (const value of left) {
    if (right.has(value)) values.push(value);
  }
  return sortedUnique(values);
}

function pairKey(left: string, right: string): string {
  return left.localeCompare(right) < 0
    ? moduleIdTupleKey([left, right])
    : moduleIdTupleKey([right, left]);
}

function addConflict(
  conflicts: Map<string, Set<string>>,
  left: string,
  right: string,
  reason: string,
): void {
  if (left === right) return;
  const key = pairKey(left, right);
  const reasons = conflicts.get(key) ?? new Set<string>();
  reasons.add(reason);
  conflicts.set(key, reasons);
}

function conflictReasons(
  conflicts: ReadonlyMap<string, ReadonlySet<string>>,
  left: string,
  right: string,
): string[] {
  return sortedUnique([...(conflicts.get(pairKey(left, right)) ?? [])]);
}

/** Tarjan SCC, with sorted traversal so group identity does not depend on model array order. */
function stronglyConnectedComponents(
  moduleIds: readonly string[],
  dependencies: readonly ModuleDependency[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const id of moduleIds) adjacency.set(id, []);
  for (const dependency of dependencies) {
    adjacency.get(dependency.moduleId)?.push(dependency.dependsOnModuleId);
  }
  for (const entries of adjacency.values()) entries.sort((left, right) => left.localeCompare(right));

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (id: string): void => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const next of adjacency.get(id) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, lowLinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLinks.set(id, Math.min(lowLinks.get(id) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowLinks.get(id) === indices.get(id)) {
      const component: string[] = [];
      let next: string | undefined;
      do {
        next = stack.pop();
        if (next !== undefined) {
          onStack.delete(next);
          component.push(next);
        }
      } while (next !== id && next !== undefined);
      components.push(component.sort((left, right) => left.localeCompare(right)));
    }
  };

  for (const id of [...moduleIds].sort((left, right) => left.localeCompare(right))) {
    if (!indices.has(id)) visit(id);
  }
  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

function groupId(moduleIds: readonly string[], isCycle: boolean): string {
  return `${isCycle ? 'scc' : 'module'}:${moduleIdTupleKey(moduleIds)}`;
}

function toExecutionGroup(group: GroupDraft): ExecutionGroup {
  return {
    id: group.id,
    kind: group.kind,
    moduleIds: sortedUnique(group.moduleIds),
    dependsOnGroupIds: sortedUnique([...group.dependsOnGroupIds]),
    executionMode: 'serial',
    atomic: true,
    writeSet: sortedUnique([...group.writeSet]),
    resourceLocks: sortedUnique([...group.resourceLocks]),
    reasons: sortedUnique([...group.reasons]),
  };
}

function priority(group: GroupDraft): number {
  if (group.kind === 'shared-contract') return 0;
  if (group.kind === 'scc') return 1;
  return 2;
}

/**
 * Computes an execution schedule from validated dependencies. Dependency
 * direction is intentionally preserved: A -> B means B's group is complete
 * before A becomes ready.
 */
export function scheduleModuleMigration(
  proposal: ModuleMigrationProposal,
  analysis: RepositoryStaticAnalysis,
  options: ModuleScheduleOptions = {},
): ModuleSchedule {
  const validation = validateModuleMigrationProposal(proposal, analysis);
  if (!validation.valid) throw new ModulePlanValidationError(validation);

  const maxParallelism = options.maxParallelism ?? 4;
  if (!Number.isInteger(maxParallelism) || maxParallelism < 1) {
    throw new RangeError('maxParallelism must be a positive integer.');
  }

  const modules = new Map(proposal.modules.map((module) => [module.id, module]));
  const moduleIds = [...modules.keys()].sort((left, right) => left.localeCompare(right));
  const dependencyKeys = new Set(
    validation.dependencies.map(moduleDependencyKey),
  );
  const components = stronglyConnectedComponents(moduleIds, validation.dependencies);
  const moduleIdToGroupId = new Map<string, string>();
  const groups = new Map<string, GroupDraft>();

  for (const component of components) {
    const onlyModule = component.length === 1 ? modules.get(component[0]!) : undefined;
    const selfCycle =
      component.length === 1 &&
      dependencyKeys.has(moduleDependencyKey({
        moduleId: component[0]!,
        dependsOnModuleId: component[0]!,
      }));
    const isCycle = component.length > 1 || selfCycle;
    const allSharedContracts = component.every(
      (moduleId) => modules.get(moduleId)?.kind === 'shared-contract',
    );
    const id = groupId(component, isCycle);
    const kind: ExecutionGroup['kind'] = isCycle
      ? 'scc'
      : allSharedContracts
        ? 'shared-contract'
        : 'module';
    const draft: GroupDraft = {
      id,
      moduleIds: component,
      kind,
      dependsOnGroupIds: new Set<string>(),
      writeSet: new Set<string>(),
      resourceLocks: new Set<string>(),
      reasons: new Set<string>(),
    };
    if (isCycle) draft.reasons.add('strongly-connected-component');
    if (allSharedContracts) draft.reasons.add('shared-contract');
    for (const moduleId of component) {
      const module = modules.get(moduleId)!;
      for (const path of module.sourceFiles) draft.writeSet.add(path);
      for (const path of module.writeSet) draft.writeSet.add(path);
      for (const lock of module.resourceLocks) draft.resourceLocks.add(lock);
      moduleIdToGroupId.set(moduleId, id);
    }
    // Keep TypeScript's narrow inference honest for singleton non-cycle groups.
    void onlyModule;
    groups.set(id, draft);
  }

  for (const dependency of validation.dependencies) {
    const group = moduleIdToGroupId.get(dependency.moduleId);
    const prerequisite = moduleIdToGroupId.get(dependency.dependsOnModuleId);
    if (group !== undefined && prerequisite !== undefined && group !== prerequisite) {
      groups.get(group)?.dependsOnGroupIds.add(prerequisite);
    }
  }

  const conflicts = new Map<string, Set<string>>();
  const globalUncertaintyGroups = new Map<string, Set<string>>();
  const globallyBlockingUncertaintyReasons = new Set<string>();
  const ownership = buildModuleOwnershipIndex(proposal.modules, proposal.fileAssignments);
  for (const edge of analysis.dependencies) {
    if (!isUncertainInternalDependency(edge)) continue;
    const endpoints = resolveDependencyModuleEndpoints(edge, ownership);
    const source = endpoints.sourceModuleId === undefined
      ? undefined
      : moduleIdToGroupId.get(endpoints.sourceModuleId);
    const target = endpoints.targetModuleId === undefined
      ? undefined
      : moduleIdToGroupId.get(endpoints.targetModuleId);
    if (source !== undefined && target !== undefined && source !== target) {
      addConflict(conflicts, source, target, `uncertain-internal-dependency:${edge.id}`);
    } else {
      const affected = source ?? target;
      if (affected !== undefined) {
        const reasons = globalUncertaintyGroups.get(affected) ?? new Set<string>();
        reasons.add(`uncertain-internal-dependency:${edge.id}`);
        globalUncertaintyGroups.set(affected, reasons);
      } else {
        // An internal edge with neither endpoint assigned to a module still
        // proves that the static picture is incomplete. No particular group
        // can be trusted as independent, so prevent every pair from preparing
        // concurrently until a later snapshot resolves or excludes it.
        globallyBlockingUncertaintyReasons.add(`uncertain-internal-dependency:${edge.id}`);
      }
    }
  }

  const groupEntries = [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (let leftIndex = 0; leftIndex < groupEntries.length; leftIndex += 1) {
    const left = groupEntries[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < groupEntries.length; rightIndex += 1) {
      const right = groupEntries[rightIndex]!;
      const writes = overlap(left.writeSet, right.writeSet);
      if (writes.length > 0) {
        addConflict(conflicts, left.id, right.id, `write-set-overlap:${writes.join(',')}`);
      }
      const locks = overlap(left.resourceLocks, right.resourceLocks);
      if (locks.length > 0) {
        addConflict(conflicts, left.id, right.id, `resource-lock-overlap:${locks.join(',')}`);
      }
      for (const [unsafeGroupId, reasons] of globalUncertaintyGroups) {
        if (unsafeGroupId === left.id || unsafeGroupId === right.id) {
          const other = unsafeGroupId === left.id ? right.id : left.id;
          for (const reason of reasons) addConflict(conflicts, unsafeGroupId, other, reason);
        }
      }
      for (const reason of globallyBlockingUncertaintyReasons) {
        addConflict(conflicts, left.id, right.id, reason);
      }
    }
  }

  const unscheduled = new Set(groups.keys());
  const groupWaveId = new Map<string, string>();
  const waves: ExecutionWave[] = [];

  while (unscheduled.size > 0) {
    const ready = [...unscheduled]
      .map((id) => groups.get(id)!)
      .filter((group) => [...group.dependsOnGroupIds].every((dependency) => !unscheduled.has(dependency)))
      .sort(
        (left, right) => priority(left) - priority(right) || left.id.localeCompare(right.id),
      );
    if (ready.length === 0) {
      throw new Error('Collapsed module dependency graph contains a cycle.');
    }

    const selected: GroupDraft[] = [ready[0]!];
    const blockedBy = new Set<string>();
    const serializeAfter = (candidate: GroupDraft, predecessors: readonly GroupDraft[]): void => {
      for (const predecessor of predecessors) {
        if (predecessor.id !== candidate.id) candidate.dependsOnGroupIds.add(predecessor.id);
      }
    };
    if (selected[0]!.kind !== 'module') {
      for (const candidate of ready.slice(1)) {
        blockedBy.add(`atomic-group:${selected[0]!.id}`);
        if (candidate.kind !== 'module') blockedBy.add(`atomic-group:${candidate.id}`);
        serializeAfter(candidate, selected);
      }
    } else {
      for (const candidate of ready.slice(1)) {
        if (selected.length >= maxParallelism) {
          blockedBy.add(`max-parallelism:${maxParallelism}`);
          serializeAfter(candidate, selected);
          continue;
        }
        if (candidate.kind !== 'module') {
          blockedBy.add(`atomic-group:${candidate.id}`);
          serializeAfter(candidate, selected);
          continue;
        }
        const reasons = selected.flatMap((existing) => conflictReasons(conflicts, existing.id, candidate.id));
        if (reasons.length > 0) {
          for (const reason of reasons) blockedBy.add(reason);
          serializeAfter(candidate, selected.filter((existing) =>
            conflictReasons(conflicts, existing.id, candidate.id).length > 0,
          ));
          continue;
        }
        selected.push(candidate);
      }
    }

    const order = waves.length;
    const id = `wave:${String(order + 1).padStart(3, '0')}`;
    const prerequisites = sortedUnique(
      selected.flatMap((group) =>
        [...group.dependsOnGroupIds]
          .map((groupId) => groupWaveId.get(groupId))
          .filter((waveId): waveId is string => waveId !== undefined),
      ),
    );
    const groupIds = selected.map((group) => group.id).sort((left, right) => left.localeCompare(right));
    waves.push({
      id,
      order,
      groupIds,
      moduleIds: sortedUnique(selected.flatMap((group) => group.moduleIds)),
      dependsOnWaveIds: prerequisites,
      maxParallelism,
      requiresApproval: true,
      status: 'pending',
      parallelismBlockedBy: sortedUnique([...blockedBy]),
    });
    for (const group of selected) {
      unscheduled.delete(group.id);
      groupWaveId.set(group.id, id);
    }
  }

  return {
    dependencies: validation.dependencies,
    executionGroups: groupEntries.map(toExecutionGroup),
    executionWaves: waves,
  };
}
