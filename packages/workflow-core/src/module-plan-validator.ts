import type {
  DependencyEdge,
  FunctionalModule,
  ModuleDependency,
  ModuleFileAssignment,
  ModuleMigrationPlan,
  ModuleMigrationProposal,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import { isValidModuleId, moduleMigrationSchemaVersion } from '@forexplore/contracts';
import { calculateModuleMigrationPlanHash, canonicalJson, sortedUnique } from './module-plan-utils';
import { scheduleModuleMigration } from './module-scheduler';

export type ModulePlanIssueSeverity = 'error' | 'warning';

export interface ModulePlanIssue {
  code: string;
  severity: ModulePlanIssueSeverity;
  message: string;
  moduleIds?: string[];
  edgeIds?: string[];
  paths?: string[];
}

export interface ModulePlanValidationResult {
  valid: boolean;
  issues: ModulePlanIssue[];
  /** The declared module edges, canonicalized but not safety-rewritten. */
  dependencies: ModuleDependency[];
  /** Static hard edges whose direct module edge is mandatory. */
  hardDependencies: ModuleDependency[];
  /** Cycles are valid only because scheduling turns them into atomic SCC groups. */
  cycles: string[][];
}

export interface ModuleOwnershipIndex {
  moduleById: Map<string, FunctionalModule>;
  moduleIdByPath: Map<string, string>;
  moduleIdBySymbol: Map<string, string>;
  ambiguousPaths: Set<string>;
  ambiguousSymbols: Set<string>;
}

export interface DependencyModuleEndpoints {
  sourceModuleId?: string;
  targetModuleId?: string;
  sourceAmbiguous: boolean;
  targetAmbiguous: boolean;
}

function canonicalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isHardInternalDependency(edge: DependencyEdge): boolean {
  return (
    edge.internal &&
    edge.resolution === 'resolved' &&
    (edge.evidence === 'semantic' || edge.evidence === 'syntactic')
  );
}

export function isUncertainInternalDependency(edge: DependencyEdge): boolean {
  return (
    edge.internal &&
    (edge.resolution === 'ambiguous' ||
      edge.resolution === 'unresolved' ||
      edge.evidence === 'ambiguous' ||
      edge.evidence === 'unresolved')
  );
}

export function buildModuleOwnershipIndex(
  modules: readonly FunctionalModule[],
  fileAssignments: readonly ModuleFileAssignment[] = [],
): ModuleOwnershipIndex {
  const moduleById = new Map<string, FunctionalModule>();
  const moduleIdByPath = new Map<string, string>();
  const moduleIdBySymbol = new Map<string, string>();
  const ambiguousPaths = new Set<string>();
  const ambiguousSymbols = new Set<string>();

  const assignPath = (path: string, moduleId: string): void => {
    const key = canonicalPath(path);
    const previous = moduleIdByPath.get(key);
    if (previous !== undefined && previous !== moduleId) {
      ambiguousPaths.add(key);
    } else {
      moduleIdByPath.set(key, moduleId);
    }
  };

  for (const module of modules) {
    moduleById.set(module.id, module);
    for (const path of module.sourceFiles) {
      assignPath(path, module.id);
    }
    for (const path of module.testFiles ?? []) {
      assignPath(path, module.id);
    }
    for (const path of module.generatedFiles ?? []) {
      assignPath(path, module.id);
    }
    for (const symbolId of module.symbolIds) {
      const previous = moduleIdBySymbol.get(symbolId);
      if (previous !== undefined && previous !== module.id) {
        ambiguousSymbols.add(symbolId);
      } else {
        moduleIdBySymbol.set(symbolId, module.id);
      }
    }
  }
  // Project files and other non-source evidence do not belong in a module's
  // sourceFiles list. An explicit excluded assignment can nevertheless bind
  // one to its owning module so a resolved project reference remains
  // schedulable. Never reinterpret an excluded source file as module-owned.
  for (const assignment of fileAssignments) {
    if (assignment.moduleId === undefined || assignment.kind === 'module') continue;
    assignPath(assignment.path, assignment.moduleId);
  }
  return {
    moduleById,
    moduleIdByPath,
    moduleIdBySymbol,
    ambiguousPaths,
    ambiguousSymbols,
  };
}

export function resolveDependencyModuleEndpoints(
  edge: DependencyEdge,
  ownership: ModuleOwnershipIndex,
): DependencyModuleEndpoints {
  const sourcePath = canonicalPath(edge.sourcePath);
  const targetPath = edge.targetPath === undefined ? undefined : canonicalPath(edge.targetPath);
  const sourceByPath = ownership.moduleIdByPath.get(sourcePath);
  const targetByPath = targetPath === undefined ? undefined : ownership.moduleIdByPath.get(targetPath);
  const sourceBySymbol = edge.sourceSymbolId === undefined
    ? undefined
    : ownership.moduleIdBySymbol.get(edge.sourceSymbolId);
  const targetBySymbol = edge.targetSymbolId === undefined
    ? undefined
    : ownership.moduleIdBySymbol.get(edge.targetSymbolId);
  return {
    // File ownership is the trusted partition boundary. A model-supplied
    // symbol list may supplement a project-level edge but must never override
    // the source file that contains a resolved code reference.
    sourceModuleId: sourceByPath ?? sourceBySymbol,
    targetModuleId: targetByPath ?? targetBySymbol,
    sourceAmbiguous:
      (edge.sourceSymbolId !== undefined && ownership.ambiguousSymbols.has(edge.sourceSymbolId)) ||
      ownership.ambiguousPaths.has(sourcePath) ||
      (sourceByPath !== undefined && sourceBySymbol !== undefined && sourceByPath !== sourceBySymbol),
    targetAmbiguous:
      (edge.targetSymbolId !== undefined && ownership.ambiguousSymbols.has(edge.targetSymbolId)) ||
      (targetPath !== undefined && ownership.ambiguousPaths.has(targetPath)) ||
      (targetByPath !== undefined && targetBySymbol !== undefined && targetByPath !== targetBySymbol),
  };
}

/**
 * An injective, length-prefixed key for graph identities.  Do not concatenate
 * untrusted IDs with a delimiter: even a NUL delimiter can occur in a JSON
 * string supplied by a model or direct API caller.
 */
export function moduleIdTupleKey(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join('');
}

export function moduleDependencyKey(
  dependency: Pick<ModuleDependency, 'moduleId' | 'dependsOnModuleId'>,
): string {
  return moduleIdTupleKey([dependency.moduleId, dependency.dependsOnModuleId]);
}

function sourcePriority(source: ModuleDependency['source']): number {
  if (source === 'static') return 0;
  if (source === 'human') return 1;
  return 2;
}

/** Combines module-local and proposal-level dependencies without changing direction. */
export function collectDeclaredModuleDependencies(
  proposal: Pick<ModuleMigrationProposal, 'modules' | 'dependencies'>,
): ModuleDependency[] {
  const candidates: ModuleDependency[] = [];
  for (const module of proposal.modules) {
    for (const prerequisite of module.dependsOn) {
      candidates.push({
        moduleId: module.id,
        dependsOnModuleId: prerequisite,
        source: 'architect',
        evidenceEdgeIds: [],
      });
    }
  }
  candidates.push(...(proposal.dependencies ?? []));

  const byKey = new Map<string, ModuleDependency>();
  for (const dependency of candidates) {
    const key = moduleDependencyKey(dependency);
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, {
        ...dependency,
        evidenceEdgeIds: sortedUnique(dependency.evidenceEdgeIds),
      });
      continue;
    }
    byKey.set(key, {
      ...previous,
      source:
        sourcePriority(dependency.source) < sourcePriority(previous.source)
          ? dependency.source
          : previous.source,
      evidenceEdgeIds: sortedUnique([
        ...previous.evidenceEdgeIds,
        ...dependency.evidenceEdgeIds,
      ]),
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.moduleId.localeCompare(right.moduleId) ||
      left.dependsOnModuleId.localeCompare(right.dependsOnModuleId) ||
      left.source.localeCompare(right.source),
  );
}

function findDependencyCycles(
  moduleIds: readonly string[],
  dependencies: readonly ModuleDependency[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const id of moduleIds) adjacency.set(id, []);
  for (const dependency of dependencies) {
    adjacency.get(dependency.moduleId)?.push(dependency.dependsOnModuleId);
  }
  for (const values of adjacency.values()) values.sort((left, right) => left.localeCompare(right));

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (id: string): void => {
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) {
        visit(next);
      } else if (onStack.has(next)) {
        const start = stack.indexOf(next);
        const cycle = [...stack.slice(start)].sort((left, right) => left.localeCompare(right));
        cycles.set(moduleIdTupleKey(cycle), cycle);
      }
    }
    stack.pop();
    onStack.delete(id);
  };

  for (const id of [...moduleIds].sort((left, right) => left.localeCompare(right))) {
    if (!visited.has(id)) visit(id);
  }
  return [...cycles.values()].sort((left, right) =>
    moduleIdTupleKey(left).localeCompare(moduleIdTupleKey(right)),
  );
}

function appendIssue(
  issues: ModulePlanIssue[],
  issue: ModulePlanIssue,
): void {
  issues.push({
    ...issue,
    moduleIds: issue.moduleIds === undefined ? undefined : sortedUnique(issue.moduleIds),
    edgeIds: issue.edgeIds === undefined ? undefined : sortedUnique(issue.edgeIds),
    paths: issue.paths === undefined ? undefined : sortedUnique(issue.paths.map(canonicalPath)),
  });
}

function validateFileAssignments(
  analysis: RepositoryStaticAnalysis,
  proposal: ModuleMigrationProposal,
  ownership: ModuleOwnershipIndex,
  issues: ModulePlanIssue[],
): void {
  const analysisPaths = new Set(analysis.files.map((file) => canonicalPath(file.path)));
  const byPath = new Map<string, typeof proposal.fileAssignments[number]>();
  for (const assignment of proposal.fileAssignments) {
    const path = canonicalPath(assignment.path);
    if (byPath.has(path)) {
      appendIssue(issues, {
        code: 'file-assignment-duplicate',
        severity: 'error',
        message: `File ${path} has more than one assignment.`,
        paths: [path],
      });
      continue;
    }
    byPath.set(path, assignment);
    if (!analysisPaths.has(path)) {
      appendIssue(issues, {
        code: 'file-assignment-unknown',
        severity: 'error',
        message: `File assignment references ${path}, which is not in the analysis snapshot.`,
        paths: [path],
      });
    }
    if (assignment.kind === 'module') {
      if (assignment.moduleId === undefined || !ownership.moduleById.has(assignment.moduleId)) {
        appendIssue(issues, {
          code: 'file-assignment-module-missing',
          severity: 'error',
          message: `Module assignment for ${path} does not identify a known module.`,
          paths: [path],
        });
      } else if (ownership.moduleIdByPath.get(path) !== assignment.moduleId) {
        appendIssue(issues, {
          code: 'file-assignment-ownership-mismatch',
          severity: 'error',
          message: `Module assignment for ${path} does not match its exclusive source owner.`,
          moduleIds: [assignment.moduleId],
          paths: [path],
        });
      }
    } else if (assignment.moduleId !== undefined) {
      const owner = ownership.moduleById.get(assignment.moduleId);
      if (owner === undefined) {
        appendIssue(issues, {
          code: 'file-assignment-module-missing',
          severity: 'error',
          message: `File assignment for ${path} names an unknown module.`,
          paths: [path],
        });
      } else if (
        (assignment.kind === 'test' && !owner.testFiles?.map(canonicalPath).includes(path)) ||
        (assignment.kind === 'generated' && !owner.generatedFiles?.map(canonicalPath).includes(path))
      ) {
        appendIssue(issues, {
          code: 'file-assignment-ownership-mismatch',
          severity: 'error',
          message: `File assignment for ${path} does not match the named module's ${assignment.kind} files.`,
          moduleIds: [assignment.moduleId],
          paths: [path],
        });
      }
    }
  }
  for (const path of analysisPaths) {
    if (!byPath.has(path)) {
      appendIssue(issues, {
        code: 'file-assignment-missing',
        severity: 'error',
        message: `File ${path} is not assigned to a module, test, generated, or explicit exclusion.`,
        paths: [path],
      });
    }
  }
  for (const module of proposal.modules) {
    for (const path of module.sourceFiles) {
      const assignment = byPath.get(canonicalPath(path));
      if (assignment?.kind !== 'module' || assignment.moduleId !== module.id) {
        appendIssue(issues, {
          code: 'module-source-unassigned',
          severity: 'error',
          message: `Source file ${path} owned by ${module.id} must have a matching module assignment.`,
          moduleIds: [module.id],
          paths: [path],
        });
      }
    }
    for (const symbolId of module.symbolIds) {
      const symbol = analysis.symbols.find((item) => item.id === symbolId);
      if (symbol === undefined) {
        appendIssue(issues, {
          code: 'module-symbol-unknown',
          severity: 'error',
          message: `Module ${module.id} references unknown static symbol ${symbolId}.`,
          moduleIds: [module.id],
        });
      } else if (!module.sourceFiles.map(canonicalPath).includes(canonicalPath(symbol.path))) {
        appendIssue(issues, {
          code: 'module-symbol-ownership-mismatch',
          severity: 'error',
          message: `Static symbol ${symbolId} is not declared in a source file owned by module ${module.id}.`,
          moduleIds: [module.id],
          paths: [symbol.path],
        });
      }
    }
  }
}

/**
 * A write set is an execution permission, not a model hint. Keep it within
 * the module's explicit ownership so one wave cannot edit another module's
 * files merely by naming them in an untrusted architecture proposal.
 */
function validateModuleWriteSets(
  analysis: RepositoryStaticAnalysis,
  proposal: ModuleMigrationProposal,
  issues: ModulePlanIssue[],
): void {
  const filesByPath = new Map(analysis.files.map((file) => [canonicalPath(file.path), file]));
  const assignmentsByPath = new Map(
    proposal.fileAssignments.map((assignment) => [canonicalPath(assignment.path), assignment]),
  );
  for (const module of proposal.modules) {
    const directOwnership = new Set([
      ...module.sourceFiles,
      ...(module.testFiles ?? []),
      ...(module.generatedFiles ?? []),
    ].map(canonicalPath));
    for (const configuredPath of module.writeSet) {
      const path = canonicalPath(configuredPath);
      const file = filesByPath.get(path);
      const assignment = assignmentsByPath.get(path);
      if (!file) {
        appendIssue(issues, {
          code: 'module-write-set-unknown',
          severity: 'error',
          message: `Module ${module.id} write set includes ${path}, which is not in the analysis snapshot.`,
          moduleIds: [module.id],
          paths: [path],
        });
        continue;
      }
      if (directOwnership.has(path)) continue;
      const explicitlyOwnedSharedConfiguration =
        module.kind === 'shared-contract' &&
        file.role === 'configuration' &&
        assignment?.kind === 'excluded' &&
        assignment.moduleId === module.id &&
        Boolean(assignment.reason?.trim()) &&
        module.resourceLocks.length > 0;
      if (!explicitlyOwnedSharedConfiguration) {
        appendIssue(issues, {
          code: 'module-write-set-ownership-mismatch',
          severity: 'error',
          message: `Module ${module.id} write set includes ${path}, outside its explicit file ownership.`,
          moduleIds: [module.id],
          paths: [path],
        });
      }
    }
  }
}

/**
 * Validates only host-verifiable architecture properties.  It never accepts a
 * model assertion in place of a static edge or file/symbol ownership fact.
 */
export function validateModuleMigrationProposal(
  proposal: ModuleMigrationProposal,
  analysis: RepositoryStaticAnalysis,
): ModulePlanValidationResult {
  const issues: ModulePlanIssue[] = [];
  if (proposal.schemaVersion !== moduleMigrationSchemaVersion) {
    appendIssue(issues, {
      code: 'proposal-schema-version',
      severity: 'error',
      message: `Unsupported proposal schema version: ${proposal.schemaVersion}.`,
    });
  }
  if (analysis.schemaVersion !== moduleMigrationSchemaVersion) {
    appendIssue(issues, {
      code: 'analysis-schema-version',
      severity: 'error',
      message: `Unsupported analysis schema version: ${analysis.schemaVersion}.`,
    });
  }
  if (proposal.snapshotId !== analysis.snapshotId) {
    appendIssue(issues, {
      code: 'snapshot-mismatch',
      severity: 'error',
      message: 'The module proposal was not produced for this static-analysis snapshot.',
    });
  }

  const moduleIdCounts = new Map<string, number>();
  for (const module of proposal.modules) {
    moduleIdCounts.set(module.id, (moduleIdCounts.get(module.id) ?? 0) + 1);
  }
  for (const [id, count] of moduleIdCounts) {
    if (!isValidModuleId(id)) {
      appendIssue(issues, {
        code: 'module-id-invalid',
        severity: 'error',
        message: `Module ID ${JSON.stringify(id)} must start with an ASCII letter or digit and use only letters, digits, ., _, or - (maximum 128 characters).`,
        moduleIds: [id],
      });
    }
    if (count !== 1) {
      appendIssue(issues, {
        code: 'module-id-duplicate',
        severity: 'error',
        message: `Module ID ${JSON.stringify(id)} must be unique.`,
        moduleIds: [id],
      });
    }
  }

  const ownership = buildModuleOwnershipIndex(proposal.modules, proposal.fileAssignments);
  for (const path of ownership.ambiguousPaths) {
    appendIssue(issues, {
      code: 'module-source-overlap',
      severity: 'error',
      message: `Source file ${path} is owned by more than one module.`,
      paths: [path],
    });
  }
  for (const symbolId of ownership.ambiguousSymbols) {
    appendIssue(issues, {
      code: 'module-symbol-overlap',
      severity: 'error',
      message: `Static symbol ${symbolId} is assigned to more than one module.`,
    });
  }

  for (const module of proposal.modules) {
    if (!module.id || !module.name || module.sourceFiles.length === 0) {
      appendIssue(issues, {
        code: 'module-incomplete',
        severity: 'error',
        message: `Module ${module.id || '(unnamed)'} must have an ID, name, and at least one source file.`,
        moduleIds: [module.id],
      });
    }
    for (const path of module.sourceFiles) {
      const snapshotFile = analysis.files.find((file) => canonicalPath(file.path) === canonicalPath(path));
      if (snapshotFile === undefined) {
        appendIssue(issues, {
          code: 'module-source-unknown',
          severity: 'error',
          message: `Module ${module.id} owns ${path}, which is not in the analysis snapshot.`,
          moduleIds: [module.id],
          paths: [path],
        });
      } else if (snapshotFile.role !== 'source') {
        appendIssue(issues, {
          code: 'module-source-role-invalid',
          severity: 'error',
          message: `Module ${module.id} may only own source files, but ${path} is ${snapshotFile.role}.`,
          moduleIds: [module.id],
          paths: [path],
        });
      }
    }
    for (const [role, paths] of [
      ['test', module.testFiles ?? []],
      ['generated', module.generatedFiles ?? []],
    ] as const) {
      for (const path of paths) {
        const snapshotFile = analysis.files.find((file) => canonicalPath(file.path) === canonicalPath(path));
        if (snapshotFile === undefined || snapshotFile.role !== role) {
          appendIssue(issues, {
            code: `module-${role}-role-invalid`,
            severity: 'error',
            message: `Module ${module.id} lists ${path} as ${role}, but the snapshot does not classify it that way.`,
            moduleIds: [module.id],
            paths: [path],
          });
        }
      }
    }
  }
  validateFileAssignments(analysis, proposal, ownership, issues);
  validateModuleWriteSets(analysis, proposal, issues);

  const dependencies = collectDeclaredModuleDependencies(proposal);
  for (const dependency of dependencies) {
    if (!ownership.moduleById.has(dependency.moduleId) || !ownership.moduleById.has(dependency.dependsOnModuleId)) {
      appendIssue(issues, {
        code: 'module-dependency-unknown',
        severity: 'error',
        message: `Module dependency ${dependency.moduleId} -> ${dependency.dependsOnModuleId} references an unknown module.`,
        moduleIds: [dependency.moduleId, dependency.dependsOnModuleId],
      });
    }
    if (dependency.moduleId === dependency.dependsOnModuleId) {
      appendIssue(issues, {
        code: 'module-dependency-self',
        severity: 'warning',
        message: `Module ${dependency.moduleId} has a self dependency and will be an atomic serial group.`,
        moduleIds: [dependency.moduleId],
      });
    }
  }

  for (const edge of analysis.dependencies) {
    if (edge.snapshotId !== analysis.snapshotId) {
      appendIssue(issues, {
        code: 'edge-snapshot-mismatch',
        severity: 'error',
        message: `Dependency edge ${edge.id} belongs to a different snapshot.`,
        edgeIds: [edge.id],
      });
    }
  }

  const dependencyKeys = new Set(dependencies.map(moduleDependencyKey));
  const hardDependencies: ModuleDependency[] = [];
  for (const edge of analysis.dependencies) {
    const endpoints = resolveDependencyModuleEndpoints(edge, ownership);
    if (isHardInternalDependency(edge)) {
      if (
        endpoints.sourceAmbiguous ||
        endpoints.targetAmbiguous ||
        endpoints.sourceModuleId === undefined ||
        endpoints.targetModuleId === undefined
      ) {
        appendIssue(issues, {
          code: 'hard-dependency-unmapped',
          severity: 'error',
          message: `Hard internal dependency ${edge.id} cannot be mapped unambiguously to module ownership.`,
          edgeIds: [edge.id],
        });
        continue;
      }
      if (endpoints.sourceModuleId === endpoints.targetModuleId) continue;
      const dependency: ModuleDependency = {
        moduleId: endpoints.sourceModuleId,
        dependsOnModuleId: endpoints.targetModuleId,
        source: 'static',
        evidenceEdgeIds: [edge.id],
      };
      hardDependencies.push(dependency);
      if (!dependencyKeys.has(moduleDependencyKey(dependency))) {
        appendIssue(issues, {
          code: 'hard-dependency-missing',
          severity: 'error',
          message: `Module ${dependency.moduleId} must explicitly depend on ${dependency.dependsOnModuleId} for static edge ${edge.id}.`,
          moduleIds: [dependency.moduleId, dependency.dependsOnModuleId],
          edgeIds: [edge.id],
        });
      }
    } else if (isUncertainInternalDependency(edge)) {
      appendIssue(issues, {
        code: 'uncertain-internal-dependency',
        severity: 'warning',
        message: `Internal dependency ${edge.id} is ${edge.resolution}/${edge.evidence}; scheduler will not permit unsafe parallel execution.`,
        moduleIds: [endpoints.sourceModuleId, endpoints.targetModuleId].filter(
          (value): value is string => value !== undefined,
        ),
        edgeIds: [edge.id],
      });
    }
  }

  const cycles = findDependencyCycles(
    [...ownership.moduleById.keys()],
    dependencies.filter(
      (dependency) =>
        ownership.moduleById.has(dependency.moduleId) &&
        ownership.moduleById.has(dependency.dependsOnModuleId),
    ),
  );
  for (const cycle of cycles) {
    appendIssue(issues, {
      code: 'module-dependency-cycle',
      severity: 'warning',
      message: `Module dependency cycle will execute as one atomic serial group: ${cycle.join(', ')}.`,
      moduleIds: cycle,
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
    dependencies,
    hardDependencies: collectDeclaredModuleDependencies({
      modules: [],
      dependencies: hardDependencies,
    }),
    cycles,
  };
}

function incrementCount(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const value of left) incrementCount(counts, value);
  for (const value of right) {
    const count = counts.get(value);
    if (count === undefined) return false;
    if (count === 1) counts.delete(value);
    else counts.set(value, count - 1);
  }
  return counts.size === 0;
}

/**
 * Check schedule coverage independently from the scheduler.  Recomputing a
 * schedule is necessary, but insufficient: a scheduler defect must not be
 * able to omit a module and then validate its own incomplete output.
 */
function validateExecutionScheduleCoverage(
  plan: ModuleMigrationPlan,
  issues: ModulePlanIssue[],
): void {
  const expectedModuleIds = new Set(plan.modules.map((module) => module.id));
  const groupsById = new Map<string, ModuleMigrationPlan['executionGroups'][number]>();
  const groupIdCounts = new Map<string, number>();
  const groupModuleCounts = new Map<string, number>();

  for (const group of plan.executionGroups) {
    incrementCount(groupIdCounts, group.id);
    if (!groupsById.has(group.id)) groupsById.set(group.id, group);
    for (const moduleId of group.moduleIds) {
      if (!expectedModuleIds.has(moduleId)) {
        appendIssue(issues, {
          code: 'execution-group-module-unknown',
          severity: 'error',
          message: `Execution group ${JSON.stringify(group.id)} references unknown module ${JSON.stringify(moduleId)}.`,
          moduleIds: [moduleId],
        });
      } else {
        incrementCount(groupModuleCounts, moduleId);
      }
    }
  }
  for (const [groupId, count] of groupIdCounts) {
    if (count !== 1) {
      appendIssue(issues, {
        code: 'execution-group-id-duplicate',
        severity: 'error',
        message: `Execution group ID ${JSON.stringify(groupId)} occurs ${count} times.`,
      });
    }
  }
  for (const moduleId of expectedModuleIds) {
    const count = groupModuleCounts.get(moduleId) ?? 0;
    if (count !== 1) {
      appendIssue(issues, {
        code: 'execution-group-module-coverage',
        severity: 'error',
        message: `Module ${JSON.stringify(moduleId)} must occur in exactly one execution group; found ${count}.`,
        moduleIds: [moduleId],
      });
    }
  }
  for (const group of plan.executionGroups) {
    for (const prerequisiteId of group.dependsOnGroupIds) {
      if (!groupsById.has(prerequisiteId)) {
        appendIssue(issues, {
          code: 'execution-group-dependency-unknown',
          severity: 'error',
          message: `Execution group ${JSON.stringify(group.id)} depends on unknown group ${JSON.stringify(prerequisiteId)}.`,
        });
      }
    }
  }

  const waveIdCounts = new Map<string, number>();
  const waveGroupCounts = new Map<string, number>();
  const waveModuleCounts = new Map<string, number>();
  for (const wave of plan.executionWaves) {
    incrementCount(waveIdCounts, wave.id);
    const expectedWaveModuleIds: string[] = [];
    for (const groupId of wave.groupIds) {
      const group = groupsById.get(groupId);
      if (group === undefined) {
        appendIssue(issues, {
          code: 'execution-wave-group-unknown',
          severity: 'error',
          message: `Execution wave ${JSON.stringify(wave.id)} references unknown group ${JSON.stringify(groupId)}.`,
        });
        continue;
      }
      incrementCount(waveGroupCounts, groupId);
      expectedWaveModuleIds.push(...group.moduleIds);
    }
    for (const moduleId of wave.moduleIds) {
      if (!expectedModuleIds.has(moduleId)) {
        appendIssue(issues, {
          code: 'execution-wave-module-unknown',
          severity: 'error',
          message: `Execution wave ${JSON.stringify(wave.id)} references unknown module ${JSON.stringify(moduleId)}.`,
          moduleIds: [moduleId],
        });
      } else {
        incrementCount(waveModuleCounts, moduleId);
      }
    }
    if (!sameStringMultiset(expectedWaveModuleIds, wave.moduleIds)) {
      appendIssue(issues, {
        code: 'execution-wave-membership-mismatch',
        severity: 'error',
        message: `Execution wave ${JSON.stringify(wave.id)} must contain exactly the modules owned by its declared groups.`,
        moduleIds: sortedUnique([...expectedWaveModuleIds, ...wave.moduleIds]),
      });
    }
  }
  for (const [waveId, count] of waveIdCounts) {
    if (count !== 1) {
      appendIssue(issues, {
        code: 'execution-wave-id-duplicate',
        severity: 'error',
        message: `Execution wave ID ${JSON.stringify(waveId)} occurs ${count} times.`,
      });
    }
  }
  for (const groupId of groupsById.keys()) {
    const count = waveGroupCounts.get(groupId) ?? 0;
    if (count !== 1) {
      appendIssue(issues, {
        code: 'execution-wave-group-coverage',
        severity: 'error',
        message: `Execution group ${JSON.stringify(groupId)} must occur in exactly one execution wave; found ${count}.`,
      });
    }
  }
  for (const moduleId of expectedModuleIds) {
    const count = waveModuleCounts.get(moduleId) ?? 0;
    if (count !== 1) {
      appendIssue(issues, {
        code: 'execution-wave-module-coverage',
        severity: 'error',
        message: `Module ${JSON.stringify(moduleId)} must occur in exactly one execution wave; found ${count}.`,
        moduleIds: [moduleId],
      });
    }
  }
}

export function validateModuleMigrationPlan(
  plan: ModuleMigrationPlan,
  analysis: RepositoryStaticAnalysis,
): ModulePlanValidationResult {
  const base = validateModuleMigrationProposal(plan, analysis);
  const issues = [...base.issues];
  if (plan.analysisHash !== analysis.contentHash) {
    appendIssue(issues, {
      code: 'analysis-hash-mismatch',
      severity: 'error',
      message: 'The module plan does not bind to the supplied static-analysis content hash.',
    });
  }
  if (plan.planHash !== calculateModuleMigrationPlanHash(plan)) {
    appendIssue(issues, {
      code: 'plan-hash-mismatch',
      severity: 'error',
      message: 'The module plan hash does not bind its modules, dependencies, groups, and execution waves.',
    });
  }
  validateExecutionScheduleCoverage(plan, issues);
  // A valid hash only proves which schedule was approved. Recompute the
  // schedule from the proposal so callers cannot edit execution waves/groups,
  // recompute planHash, and bypass hard dependency ordering or SCC atomicity.
  try {
    const expected = scheduleModuleMigration(plan, analysis, {
      maxParallelism: plan.executionWaves[0]?.maxParallelism ?? 4,
    });
    const canonicalSchedule = (schedule: {
      dependencies: ModuleDependency[];
      executionGroups: ModuleMigrationPlan['executionGroups'];
      executionWaves: ModuleMigrationPlan['executionWaves'];
    }): Record<string, unknown> => ({
      dependencies: schedule.dependencies,
      executionGroups: schedule.executionGroups,
      // Lifecycle status is mutable review state, not scheduling identity.
      executionWaves: schedule.executionWaves.map(({ status: _status, ...wave }) => wave),
    });
    const actual = canonicalSchedule({
      dependencies: base.dependencies,
      executionGroups: plan.executionGroups,
      executionWaves: plan.executionWaves,
    });
    const expectedCanonical = canonicalSchedule(expected);
    if (canonicalJson(actual) !== canonicalJson(expectedCanonical)) {
      appendIssue(issues, {
        code: 'execution-schedule-mismatch',
        severity: 'error',
        message: 'Execution groups and waves do not match the trusted deterministic scheduler.',
      });
    }
  } catch (error) {
    appendIssue(issues, {
      code: 'execution-schedule-invalid',
      severity: 'error',
      message: `The execution schedule could not be recomputed: ${error instanceof Error ? error.message : String(error)}.`,
    });
  }
  return {
    ...base,
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
  };
}
