import path from 'node:path';
import type {
  EntityImplementationAssessment,
  MigrationTargetRef,
  MigrationRouteResolution,
  RepositoryModuleAssignment,
  TargetImplementationRollup,
  TargetWorkspaceModuleSnapshot,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { migrationReferenceSchemaVersion, normalizeLanguageId } from '@forexplore/contracts';
import { materializeMigrationTargetRefV2 } from '@forexplore/workflow-core';
import type {
  TargetWorkspaceMigrationEligibility,
  ModuleMappingRunBinding,
  TargetWorkspaceMigrationRouteOption,
  TargetWorkspaceMigrationSelection,
  TargetWorkspaceSelectionIdentity,
  TargetWorkspaceSnapshot,
  TargetWorkspaceTreeNode,
} from './protocol/messages';
import type {
  TargetWorkspaceEntityContext,
  TargetWorkspaceHostRecord,
} from './target-workspace-host';
import { languageFromLanguageId } from './target-builder';

export interface ProjectTargetWorkspaceInput {
  record: TargetWorkspaceHostRecord;
  workspaceName?: string;
  /**
   * Exact route resolutions supplied by the runtime capability registry.
   * Omission means no executable migration capability, not "all languages".
   */
  routeResolutions?: readonly MigrationRouteResolution[];
}

interface ProjectionIndexes {
  assessments: Map<string, EntityImplementationAssessment>;
  classRollups: Map<string, TargetImplementationRollup>;
  fileRollups: Map<string, TargetImplementationRollup>;
  moduleRollups: Map<string, TargetImplementationRollup>;
}

/**
 * Build the presentation tree exclusively from the reviewed catalog, bound IR,
 * and deterministic implementation snapshot. It never scans the filesystem or
 * accepts a Webview-supplied path.
 */
export function projectTargetWorkspace(
  input: ProjectTargetWorkspaceInput,
): TargetWorkspaceSnapshot {
  const accepted = input.record.accepted;
  if (!accepted?.snapshot) {
    throw new Error(`Target workspace has no reviewed implementation snapshot: ${input.record.stage}.`);
  }
  const { ir, catalog, snapshot } = accepted;
  if (input.record.stage !== 'reviewed') {
    throw new Error(`Target workspace snapshot is not current: ${input.record.stage}.`);
  }
  const files = new Map(ir.files.map((file) => [file.id, file]));
  const assignments = new Map(catalog.assignments.map((assignment) => [assignment.fileId, assignment]));
  const indexes: ProjectionIndexes = {
    assessments: new Map(snapshot.assessments.map((assessment) => [assessment.entityId, assessment])),
    classRollups: new Map(snapshot.classRollups.map((rollup) => [rollup.scopeId, rollup])),
    fileRollups: new Map(snapshot.fileRollups.map((rollup) => [rollup.scopeId, rollup])),
    moduleRollups: new Map(snapshot.moduleRollups.map((rollup) => [rollup.scopeId, rollup])),
  };
  const primaryNodes = new Map<string, string>();
  const registerAlias = (
    identity: string,
    nodeId: string,
  ): Pick<TargetWorkspaceTreeNode, 'aliasOfNodeId'> => {
    const primary = primaryNodes.get(identity);
    if (primary) return { aliasOfNodeId: primary };
    primaryNodes.set(identity, nodeId);
    return {};
  };
  const modules = [...catalog.modules].sort((left, right) => compareNode(
    left.name,
    left.id,
    right.name,
    right.id,
  ));
  const moduleNodes = modules.map((module): TargetWorkspaceTreeNode => {
    const nodeId = `module:${module.id}`;
    const moduleFiles = [...new Set(module.fileIds)]
      .map((fileId) => files.get(fileId))
      .filter((file): file is UnifiedRepositoryIR['files'][number] => file !== undefined)
      .sort((left, right) => compareNode(left.path, left.id, right.path, right.id));
    return {
      nodeId,
      entityId: module.id,
      moduleId: module.id,
      kind: 'module',
      name: module.name,
      qualifiedName: module.id,
      rollup: indexes.moduleRollups.get(module.id),
      migrationEligibility: blockedEligibility(
        '请选择模块中的具体可调用实体。',
        'aggregate-node',
      ),
      children: moduleFiles.map((file) => projectFile({
        ir,
        snapshot,
        file,
        assignment: assignments.get(file.id),
        moduleId: module.id,
        indexes,
        registerAlias,
        routeResolutions: input.routeResolutions ?? [],
      })),
    };
  });

  const moduleFileIds = new Set(modules.flatMap((module) => module.fileIds));
  const outsideModuleFiles = ir.files
    .filter((file) => !moduleFileIds.has(file.id))
    .sort((left, right) => compareNode(left.path, left.id, right.path, right.id))
    .map((file) => projectFile({
      ir,
      snapshot,
      file,
      assignment: assignments.get(file.id),
      indexes,
      registerAlias,
      routeResolutions: input.routeResolutions ?? [],
    }));
  const root: TargetWorkspaceTreeNode = {
    nodeId: `workspace:${input.record.workspaceId}`,
    entityId: input.record.workspaceId,
    kind: 'workspace',
    name: input.workspaceName?.trim() || path.basename(input.record.repositoryRoot),
    path: input.record.repositoryRoot,
    migrationEligibility: blockedEligibility(
      '请选择模块中的具体可调用实体。',
      'aggregate-node',
    ),
    children: [...moduleNodes, ...outsideModuleFiles],
  };
  return {
    schemaVersion: '1.0',
    workspaceId: input.record.workspaceId,
    workspaceName: root.name,
    snapshotId: snapshot.id,
    contentHash: snapshot.contentHash,
    moduleSnapshot: snapshot,
    languageIds: [...new Set(ir.files.flatMap((file) => file.languageId ? [file.languageId] : []))]
      .sort(),
    freshness: 'current',
    root,
    diagnostics: ir.diagnostics.map((diagnostic) => ({
      id: diagnostic.id,
      severity: diagnostic.severity === 'warn' ? 'warning' : diagnostic.severity,
      message: diagnostic.message,
    })),
  };
}

function projectFile(input: {
  ir: UnifiedRepositoryIR;
  snapshot: TargetWorkspaceModuleSnapshot;
  file: UnifiedRepositoryIR['files'][number];
  assignment?: RepositoryModuleAssignment;
  moduleId?: string;
  indexes: ProjectionIndexes;
  registerAlias(identity: string, nodeId: string): Pick<TargetWorkspaceTreeNode, 'aliasOfNodeId'>;
  routeResolutions: readonly MigrationRouteResolution[];
}): TargetWorkspaceTreeNode {
  const prefix = input.moduleId ? `module:${input.moduleId}:` : 'outside:';
  const nodeId = `${prefix}file:${input.file.id}`;
  const entities = input.ir.entities.filter((entity) => entity.fileId === input.file.id);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const roots = entities
    .filter((entity) => !entity.containerEntityId || !entityIds.has(entity.containerEntityId))
    .sort((left, right) => compareEntity(left, right));
  return {
    nodeId,
    entityId: input.file.id,
    ...(input.moduleId ? { moduleId: input.moduleId } : {}),
    ...input.registerAlias(`file:${input.file.id}`, nodeId),
    kind: 'file',
    name: input.file.path.split('/').at(-1) ?? input.file.path,
    path: input.file.path,
    languageId: input.file.languageId,
    rollup: input.indexes.fileRollups.get(input.file.id),
    migrationEligibility: blockedEligibility(
      '请选择文件中的具体可调用实体。',
      'aggregate-node',
    ),
    children: roots.map((entity) => projectEntity({ ...input, entity, prefix: nodeId })),
  };
}

function projectEntity(input: {
  ir: UnifiedRepositoryIR;
  snapshot: TargetWorkspaceModuleSnapshot;
  file: UnifiedRepositoryIR['files'][number];
  assignment?: RepositoryModuleAssignment;
  moduleId?: string;
  indexes: ProjectionIndexes;
  registerAlias(identity: string, nodeId: string): Pick<TargetWorkspaceTreeNode, 'aliasOfNodeId'>;
  routeResolutions: readonly MigrationRouteResolution[];
  entity: UnifiedRepositoryIR['entities'][number];
  prefix: string;
}): TargetWorkspaceTreeNode {
  const kind = projectedEntityKind(input.entity.kind);
  const nodeId = `${input.prefix}:${kind}:${input.entity.id}`;
  const children = input.ir.entities
    .filter((entity) =>
      entity.fileId === input.file.id && entity.containerEntityId === input.entity.id,
    )
    .sort((left, right) => compareEntity(left, right));
  const assessment = kind === 'callable'
    ? input.indexes.assessments.get(input.entity.id)
    : undefined;
  const eligibility = kind === 'callable'
    ? callableEligibility(
        input.entity,
        input.file,
        input.assignment,
        assessment,
        input.routeResolutions,
      )
    : blockedEligibility(
        '请选择具体可调用实体。',
        'aggregate-node',
      );
  const nativeKind = nativeEntityKind(input.entity);
  return {
    nodeId,
    entityId: input.entity.id,
    ...(input.moduleId ? { moduleId: input.moduleId } : {}),
    ...input.registerAlias(`entity:${input.entity.id}`, nodeId),
    kind,
    nativeKind,
    kindLabel: nativeKindLabel(nativeKind, input.entity.kind),
    name: input.entity.name,
    qualifiedName: input.entity.qualifiedName,
    path: input.file.path,
    languageId: input.entity.languageId ?? input.file.languageId,
    signature: input.entity.signature,
    ...(input.entity.range ? { range: displayRange(input.entity.range) } : {}),
    ...(kind === 'type' ? { rollup: input.indexes.classRollups.get(input.entity.id) } : {}),
    ...(assessment ? { assessment } : {}),
    migrationEligibility: eligibility,
    children: children.map((entity) => projectEntity({ ...input, entity, prefix: nodeId })),
  };
}

function callableEligibility(
  entity: UnifiedRepositoryIR['entities'][number],
  file: UnifiedRepositoryIR['files'][number],
  assignment: RepositoryModuleAssignment | undefined,
  assessment: EntityImplementationAssessment | undefined,
  routeResolutions: readonly MigrationRouteResolution[],
): TargetWorkspaceMigrationEligibility {
  if (!assessment) {
    return blockedEligibility('缺少当前快照绑定的实现状态证据。', 'assessment-missing');
  }
  if (file.role !== 'source' || file.generated) {
    return blockedEligibility(
      '测试、生成或非源码文件不进入目标迁移分母。',
      'file-not-migratable',
    );
  }
  if (!assignment || ['test', 'generated', 'excluded', 'unassigned'].includes(assignment.kind)) {
    return blockedEligibility(
      '该文件未归属于可迁移的已审模块。',
      'module-assignment-ineligible',
    );
  }
  if (assessment.state === 'implemented') {
    return blockedEligibility(
      '静态证据已检测到实现；如需替换应走显式重迁移策略。',
      'implementation-already-present',
    );
  }
  if (assessment.state === 'not-applicable') {
    return blockedEligibility(
      '当前实体被实现目录标记为不适用。',
      'implementation-not-applicable',
    );
  }
  if (assessment.state === 'unknown') {
    return blockedEligibility(
      '实现状态未知；必须先获得可归因的 detector 证据。',
      'implementation-state-unknown',
    );
  }
  if (entity.structureIdentity?.basis !== 'declaration-shape') {
    return blockedEligibility(
      '目标 adapter 未提供可归因的声明身份；不能建立 V2 目标引用。',
      'target-declaration-identity-missing',
    );
  }
  const rawLanguageId = entity.languageId ?? file.languageId;
  if (!rawLanguageId) {
    return blockedEligibility('目标实体没有语言标识。', 'target-language-missing');
  }
  let targetLanguageId: string;
  try {
    targetLanguageId = normalizeLanguageId(rawLanguageId);
  } catch {
    return blockedEligibility('目标语言标识无法规范化。', 'target-language-invalid');
  }
  const routeOptions = supportedRouteOptions(routeResolutions, targetLanguageId);
  if (routeOptions.length === 0) {
    const matchingFailures = routeResolutions.filter(
      (resolution): resolution is Extract<MigrationRouteResolution, { status: 'unsupported' }> =>
      resolution.status === 'unsupported' &&
      resolution.key.targetLanguageId === targetLanguageId,
    );
    const reasonCodes = matchingFailures.flatMap((resolution) => resolution.reasonCodes);
    return {
      status: 'blocked',
      targetLanguageId,
      routeOptions: [],
      reasonCodes: reasonCodes.length > 0
        ? [...new Set(reasonCodes)].sort()
        : ['migration-route-unavailable'],
      summary: `未声明任何可执行的源语言 → ${targetLanguageId} 迁移路线。`,
    };
  }
  return {
    status: 'eligible',
    targetLanguageId,
    routeOptions,
    reasonCodes: [],
  };
}

export function findTargetWorkspaceTreeNode(
  root: TargetWorkspaceTreeNode,
  nodeId: string,
): TargetWorkspaceTreeNode | undefined {
  if (root.nodeId === nodeId) return root;
  for (const child of root.children) {
    const match = findTargetWorkspaceTreeNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

/** Re-check a Webview selection against the Host-owned projected node. */
export function assertTargetWorkspaceSelection(
  projection: TargetWorkspaceSnapshot,
  input: { snapshotId: string; contentHash: string; nodeId: string; entityId: string },
): TargetWorkspaceTreeNode {
  if (
    projection.snapshotId !== input.snapshotId ||
    projection.contentHash !== input.contentHash
  ) {
    throw new Error('Target workspace selection is stale.');
  }
  const node = findTargetWorkspaceTreeNode(projection.root, input.nodeId);
  if (!node || node.entityId !== input.entityId) {
    throw new Error('Target workspace selection does not match the Host-owned tree.');
  }
  if (node.kind !== 'callable' || node.migrationEligibility.status !== 'eligible') {
    throw new Error(
      node.migrationEligibility.summary ??
      'Target workspace node is not eligible for migration.',
    );
  }
  return node;
}

/** Convert a revalidated 01B callable for the V1 workflow compatibility port. */
export function moduleTargetFromTargetWorkspaceContext(
  context: TargetWorkspaceEntityContext,
) {
  const { entity, file, assessment } = context;
  if (entity.kind !== 'callable' || !file || !entity.signature) {
    throw new Error('Target workspace entity cannot be represented as a symbol-level target.');
  }
  const languageId = entity.languageId ?? file.languageId;
  const language = languageId ? languageFromLanguageId(languageId) : null;
  if (!language) {
    throw new Error(
      `The V1 symbol workflow cannot represent target language ${languageId ?? '<missing>'}; ` +
      'use MigrationTargetRef at the adaptation boundary.',
    );
  }
  return {
    id: entity.id,
    name: entity.name,
    kind: 'function' as const,
    path: file.path,
    language,
    signature: entity.signature,
    ...(entity.range ? { line: entity.range.startLine } : {}),
    ...(assessment?.state === 'unimplemented'
      ? { implementationStatus: 'unimplemented' as const }
      : {}),
  };
}

/** Build the language-open, lineage-complete selection carried by the active run. */
export function migrationSelectionFromTargetWorkspaceContext(
  context: TargetWorkspaceEntityContext,
  selection: TargetWorkspaceSelectionIdentity,
  routeOptions: readonly TargetWorkspaceMigrationRouteOption[],
  moduleMapping: ModuleMappingRunBinding,
  selectedModuleId?: string,
): TargetWorkspaceMigrationSelection {
  const { entity, file, snapshot, catalog, assessment } = context;
  const selectedModule = selectedModuleId
    ? catalog.modules.find((candidate) => candidate.id === selectedModuleId)
    : context.module;
  if (selectedModuleId && !selectedModule) {
    throw new Error('Selected target module is absent from the reviewed catalog.');
  }
  const languageId = entity.languageId ?? file?.languageId;
  if (entity.kind !== 'callable' || !file || !languageId) {
    throw new Error('Target workspace entity cannot be represented as a migration target.');
  }
  const canonicalLanguageId = normalizeLanguageId(languageId);
  const structureIdentity = entity.structureIdentity;
  if (structureIdentity?.basis !== 'declaration-shape') {
    throw new Error('Target entity has no adapter-owned declaration identity.');
  }
  const target: MigrationTargetRef = materializeMigrationTargetRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    workspaceId: context.workspaceId,
    targetWorkspaceSnapshotId: snapshot.id,
    targetWorkspaceSnapshotHash: snapshot.contentHash,
    lineage: {
      repositoryId: snapshot.lineage.repositoryId,
      ...(snapshot.lineage.repositoryRevision
        ? { repositoryRevision: snapshot.lineage.repositoryRevision }
        : {}),
      repositoryContentHash: snapshot.lineage.repositoryContentHash,
      unifiedRepositoryIrId: snapshot.lineage.unifiedRepositoryIrId,
      unifiedRepositoryIrHash: snapshot.lineage.unifiedRepositoryIrHash,
      moduleCatalogId: snapshot.lineage.moduleCatalogId,
      moduleCatalogHash: snapshot.lineage.moduleCatalogHash,
      moduleReviewId: snapshot.lineage.moduleReviewId,
      moduleReviewHash: snapshot.lineage.moduleReviewHash,
    },
    entity: {
      entityId: entity.id,
      fileId: file.id,
      languageId: canonicalLanguageId,
      kind: nativeEntityKind(entity),
      name: entity.name,
      ...(entity.qualifiedName ? { qualifiedName: entity.qualifiedName } : {}),
      path: file.path,
      ...(entity.signature ? { signature: entity.signature } : {}),
      fileContentHash: file.contentHash,
      declarationIdentity: {
        kind: 'declaration',
        contentHash: structureIdentity.contentHash,
        schemaVersion: structureIdentity.schemaVersion,
        providerId: structureIdentity.adapterId,
        providerVersion: structureIdentity.adapterVersion,
        ...(structureIdentity.configurationHash
          ? { configurationHash: structureIdentity.configurationHash }
          : {}),
      },
      ...(assessment?.bodyHash ? {
        bodyIdentity: {
          kind: 'body' as const,
          contentHash: assessment.bodyHash,
          schemaVersion: 'target-workspace-implementation-assessment/v1',
          providerId: assessment.detector.id,
          providerVersion: assessment.detector.version,
          ...(assessment.detector.configurationHash
            ? { configurationHash: assessment.detector.configurationHash }
            : {}),
        },
      } : {}),
    },
    route: moduleMapping.route,
    allowedModificationPaths: [file.path],
  }, moduleMapping.runtimeCapabilitySnapshot);
  return {
    workspaceId: context.workspaceId,
    targetWorkspaceSnapshotId: snapshot.id,
    targetWorkspaceSnapshotHash: snapshot.contentHash,
    selection: { ...selection },
    target,
    ...(selectedModule ? {
      module: {
        catalogId: catalog.id,
        catalogHash: catalog.contentHash,
        moduleId: selectedModule.id,
        moduleName: selectedModule.name,
      },
    } : {}),
    moduleMapping,
    routeOptions: routeOptions.map((option) => ({
      route: option.route,
      warnings: [...option.warnings],
    })),
  };
}

function supportedRouteOptions(
  resolutions: readonly MigrationRouteResolution[],
  targetLanguageId: string,
): TargetWorkspaceMigrationRouteOption[] {
  return resolutions
    .filter((resolution): resolution is Extract<MigrationRouteResolution, { status: 'supported' }> =>
      resolution.status === 'supported' &&
      resolution.key.targetLanguageId === targetLanguageId &&
      resolution.route.targetLanguageId === targetLanguageId,
    )
    .map((resolution) => ({ route: resolution.route, warnings: [...resolution.warnings] }))
    .sort((left, right) =>
      left.route.sourceLanguageId.localeCompare(right.route.sourceLanguageId) ||
      left.route.strategy.localeCompare(right.route.strategy) ||
      left.route.id.localeCompare(right.route.id),
    );
}

function blockedEligibility(
  summary: string,
  reasonCode: string,
): TargetWorkspaceMigrationEligibility {
  return { status: 'blocked', routeOptions: [], reasonCodes: [reasonCode], summary };
}

function projectedEntityKind(
  kind: UnifiedRepositoryIR['entities'][number]['kind'],
): TargetWorkspaceTreeNode['kind'] {
  if (kind === 'callable') return 'callable';
  if (kind === 'type') return 'type';
  if (kind === 'member') return 'member';
  return 'container';
}

function nativeEntityKind(entity: UnifiedRepositoryIR['entities'][number]): string {
  const nativeKind = entity.attributes?.staticSymbolKind;
  return typeof nativeKind === 'string' && nativeKind.trim()
    ? nativeKind.trim()
    : entity.kind;
}

function nativeKindLabel(nativeKind: string, entityKind: string): string {
  const labels: Record<string, string> = {
    callable: '可调用实体',
    function: '函数',
    method: '方法',
    constructor: '构造器',
    class: '类',
    interface: '接口',
    record: '记录',
    struct: '结构体',
    enum: '枚举',
    trait: 'Trait',
    impl: 'Impl',
    module: '模块',
    namespace: '命名空间',
    package: '包',
    property: '属性',
    field: '字段',
    member: '成员',
    type: '类型',
  };
  return labels[nativeKind.toLowerCase()] ?? labels[entityKind] ?? nativeKind;
}

function displayRange(range: NonNullable<UnifiedRepositoryIR['entities'][number]['range']>) {
  return {
    startLine: range.startLine,
    ...(range.startColumn === undefined ? {} : { startColumn: range.startColumn }),
    ...(range.endLine === undefined ? {} : { endLine: range.endLine }),
    ...(range.endColumn === undefined ? {} : { endColumn: range.endColumn }),
  };
}

function compareEntity(
  left: UnifiedRepositoryIR['entities'][number],
  right: UnifiedRepositoryIR['entities'][number],
): number {
  return compareNode(
    left.qualifiedName ?? left.name,
    left.id,
    right.qualifiedName ?? right.name,
    right.id,
  );
}

function compareNode(leftName: string, leftId: string, rightName: string, rightId: string): number {
  return leftName.localeCompare(rightName) || leftId.localeCompare(rightId);
}
