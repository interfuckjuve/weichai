import path from 'node:path';
import type {
  EntityImplementationAssessment,
  RepositoryModuleAssignment,
  TargetImplementationRollup,
  TargetWorkspaceModuleSnapshot,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import type {
  TargetWorkspaceSnapshot,
  TargetWorkspaceTreeNode,
} from './protocol/messages';
import type {
  TargetWorkspaceEntityContext,
  TargetWorkspaceHostRecord,
} from './target-workspace-host';

export interface ProjectTargetWorkspaceInput {
  record: TargetWorkspaceHostRecord;
  workspaceName?: string;
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
      eligibleForTranslation: false,
      ineligibilityReason: '请选择模块中的具体待实现方法。',
      children: moduleFiles.map((file) => projectFile({
        ir,
        snapshot,
        file,
        assignment: assignments.get(file.id),
        moduleId: module.id,
        indexes,
        registerAlias,
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
    }));
  const root: TargetWorkspaceTreeNode = {
    nodeId: `workspace:${input.record.workspaceId}`,
    entityId: input.record.workspaceId,
    kind: 'workspace',
    name: input.workspaceName?.trim() || path.basename(input.record.repositoryRoot),
    path: input.record.repositoryRoot,
    eligibleForTranslation: false,
    ineligibilityReason: '请选择模块中的具体待实现方法。',
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
}): TargetWorkspaceTreeNode {
  const prefix = input.moduleId ? `module:${input.moduleId}:` : 'outside:';
  const nodeId = `${prefix}file:${input.file.id}`;
  const entities = input.ir.entities.filter((entity) => entity.fileId === input.file.id);
  const types = entities
    .filter((entity) => entity.kind === 'type')
    .sort((left, right) => compareEntity(left, right));
  const topLevelCallables = entities
    .filter((entity) => entity.kind === 'callable' && !entity.containerEntityId)
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
    eligibleForTranslation: false,
    ineligibilityReason: '请选择文件中的具体待实现方法。',
    children: [
      ...types.map((entity) => projectType({
        ...input,
        entity,
        prefix: nodeId,
      })),
      ...topLevelCallables.map((entity) => projectCallable({
        ...input,
        entity,
        prefix: nodeId,
      })),
    ],
  };
}

function projectType(input: {
  ir: UnifiedRepositoryIR;
  snapshot: TargetWorkspaceModuleSnapshot;
  file: UnifiedRepositoryIR['files'][number];
  assignment?: RepositoryModuleAssignment;
  moduleId?: string;
  indexes: ProjectionIndexes;
  registerAlias(identity: string, nodeId: string): Pick<TargetWorkspaceTreeNode, 'aliasOfNodeId'>;
  entity: UnifiedRepositoryIR['entities'][number];
  prefix: string;
}): TargetWorkspaceTreeNode {
  const nodeId = `${input.prefix}:type:${input.entity.id}`;
  const callables = input.ir.entities
    .filter((entity) => entity.kind === 'callable' && entity.containerEntityId === input.entity.id)
    .sort((left, right) => compareEntity(left, right));
  return {
    nodeId,
    entityId: input.entity.id,
    ...(input.moduleId ? { moduleId: input.moduleId } : {}),
    ...input.registerAlias(`entity:${input.entity.id}`, nodeId),
    kind: 'type',
    name: input.entity.name,
    qualifiedName: input.entity.qualifiedName,
    path: input.file.path,
    languageId: input.entity.languageId ?? input.file.languageId,
    signature: input.entity.signature,
    ...(input.entity.range ? { range: displayRange(input.entity.range) } : {}),
    rollup: input.indexes.classRollups.get(input.entity.id),
    eligibleForTranslation: false,
    ineligibilityReason: '01B 当前只把 concrete callable 交给符号级翻译流程。',
    children: callables.map((entity) => projectCallable({ ...input, entity, prefix: nodeId })),
  };
}

function projectCallable(input: {
  file: UnifiedRepositoryIR['files'][number];
  assignment?: RepositoryModuleAssignment;
  moduleId?: string;
  indexes: ProjectionIndexes;
  registerAlias(identity: string, nodeId: string): Pick<TargetWorkspaceTreeNode, 'aliasOfNodeId'>;
  entity: UnifiedRepositoryIR['entities'][number];
  prefix: string;
}): TargetWorkspaceTreeNode {
  const nodeId = `${input.prefix}:callable:${input.entity.id}`;
  const assessment = input.indexes.assessments.get(input.entity.id);
  const eligibility = callableEligibility(input.entity, input.file, input.assignment, assessment);
  return {
    nodeId,
    entityId: input.entity.id,
    ...(input.moduleId ? { moduleId: input.moduleId } : {}),
    ...input.registerAlias(`entity:${input.entity.id}`, nodeId),
    kind: 'callable',
    name: input.entity.name,
    qualifiedName: input.entity.qualifiedName,
    path: input.file.path,
    languageId: input.entity.languageId ?? input.file.languageId,
    signature: input.entity.signature,
    ...(input.entity.range ? { range: displayRange(input.entity.range) } : {}),
    assessment,
    eligibleForTranslation: eligibility.eligible,
    ...(eligibility.reason ? { ineligibilityReason: eligibility.reason } : {}),
    children: [],
  };
}

function callableEligibility(
  entity: UnifiedRepositoryIR['entities'][number],
  file: UnifiedRepositoryIR['files'][number],
  assignment: RepositoryModuleAssignment | undefined,
  assessment: EntityImplementationAssessment | undefined,
): { eligible: boolean; reason?: string } {
  if (!assessment) return { eligible: false, reason: '缺少当前快照绑定的实现状态证据。' };
  if (file.role !== 'source' || file.generated) {
    return { eligible: false, reason: '测试、生成或非源码文件不进入目标翻译分母。' };
  }
  if (!assignment || ['test', 'generated', 'excluded', 'unassigned'].includes(assignment.kind)) {
    return { eligible: false, reason: '该文件未归属于可迁移的已审模块。' };
  }
  const staticKind = entity.attributes?.staticSymbolKind;
  if (staticKind !== 'method' && staticKind !== 'function') {
    return { eligible: false, reason: '构造器或声明型 callable 暂不进入单方法翻译流程。' };
  }
  if ((entity.languageId ?? file.languageId)?.toLowerCase() !== 'csharp') {
    return { eligible: false, reason: '当前真实迁移目标仅支持 C#；分析语言开放不等于迁移语言开放。' };
  }
  if (assessment.state === 'implemented') {
    return { eligible: false, reason: '静态证据已检测到实现；如需替换应走显式重迁移策略。' };
  }
  if (assessment.state === 'not-applicable') {
    return { eligible: false, reason: '接口、abstract/extern 声明或排除对象不适用单方法翻译。' };
  }
  return { eligible: true };
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
  if (node.kind !== 'callable' || !node.eligibleForTranslation) {
    throw new Error(node.ineligibilityReason ?? 'Target workspace node is not eligible for translation.');
  }
  return node;
}

/** Convert a revalidated 01B callable into the legacy symbol-level target. */
export function moduleTargetFromTargetWorkspaceContext(
  context: TargetWorkspaceEntityContext,
) {
  const { entity, file, assessment } = context;
  if (entity.kind !== 'callable' || !file || !entity.signature) {
    throw new Error('Target workspace entity cannot be represented as a symbol-level target.');
  }
  if ((entity.languageId ?? file.languageId)?.toLowerCase() !== 'csharp') {
    throw new Error('Current migration capability only accepts a C# target callable.');
  }
  const staticKind = entity.attributes?.staticSymbolKind;
  if (staticKind !== 'method' && staticKind !== 'function') {
    throw new Error('Current migration capability accepts methods/functions, not constructors or declarations.');
  }
  return {
    id: entity.id,
    name: entity.name,
    kind: 'function' as const,
    path: file.path,
    language: 'C#' as const,
    signature: entity.signature,
    ...(entity.range ? { line: entity.range.startLine } : {}),
    ...(assessment?.state === 'unimplemented'
      ? { implementationStatus: 'unimplemented' as const }
      : {}),
  };
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
