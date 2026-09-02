import { createHash } from 'node:crypto';
import type {
  ImplementationCandidateRef,
  IndexedImplementationDocumentV2,
  MigrationProviderRefV2,
  ModuleDiscoveryProposal,
  RepositoryIREntity,
  RepositoryIRFile,
  RepositoryModuleCatalog,
  RepositoryModuleReview,
  RepositorySourceRange,
  SourceImplementationBundleV2,
  SourceImplementationFileV2,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';
import {
  createRepositoryModuleCatalogRef,
  materializeImplementationCandidateRefV2,
  materializeIndexedImplementationDocumentV2,
  materializeRepositoryModuleCatalog,
  materializeSourceImplementationBundleV2,
  validateRepositoryModuleReview,
} from '@forexplore/workflow-core';
import { repositoryIngestionBridgeHash } from './repository-ingestion-bridge.js';

export interface ReviewedRepositorySourceFileV2 {
  path: string;
  content: string;
}

export interface MaterializeReviewedImplementationIndexV2Input {
  unifiedIr: UnifiedRepositoryIR;
  proposal: ModuleDiscoveryProposal;
  review: RepositoryModuleReview;
  catalog: RepositoryModuleCatalog;
  sourceFiles: readonly ReviewedRepositorySourceFileV2[];
  /** Omit to index every file-backed entity owned by the reviewed catalog. */
  entityIds?: readonly string[];
  producer: MigrationProviderRefV2;
  createdAt: string;
  licenseByEntityId?: Readonly<Record<string, string>>;
}

export interface ReviewedImplementationIndexArtifactV2 {
  bundle: SourceImplementationBundleV2;
  document: IndexedImplementationDocumentV2;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertContentAddressedIr(ir: UnifiedRepositoryIR): void {
  const { id, contentHash, ...payload } = ir;
  const expectedHash = repositoryIngestionBridgeHash(payload);
  if (
    contentHash !== expectedHash ||
    id !== `unified-repository-ir:${expectedHash.slice(0, 32)}`
  ) {
    throw new Error('Unified repository IR content address is stale or invalid.');
  }
}

function assertReviewedCatalog(
  ir: UnifiedRepositoryIR,
  proposal: ModuleDiscoveryProposal,
  review: RepositoryModuleReview,
  catalog: RepositoryModuleCatalog,
): void {
  assertContentAddressedIr(ir);
  validateRepositoryModuleReview(review, proposal, ir);
  if (
    review.decision !== 'accept' ||
    catalog.status !== 'active' ||
    catalog.reviewId !== review.id ||
    catalog.reviewHash !== review.contentHash ||
    catalog.sourceProposalId !== proposal.id ||
    catalog.sourceProposalHash !== proposal.contentHash
  ) {
    throw new Error('Implementation indexing requires the exact accepted module review and active catalog.');
  }
  const { id, contentHash, ...payload } = catalog;
  const expectedHash = sha256(canonicalJson(payload));
  if (
    contentHash !== expectedHash ||
    id !== `repository-module-catalog:${expectedHash.slice(0, 24)}`
  ) {
    throw new Error('Repository module catalog content address is stale or invalid.');
  }
  const draftProjection = materializeRepositoryModuleCatalog(proposal, ir, {
    producer: catalog.producer,
    createdAt: catalog.createdAt,
    updatedAt: catalog.createdAt,
  });
  const projectedFacts = {
    modules: catalog.modules,
    assignments: catalog.assignments,
    dependencies: catalog.dependencies,
    unassignedFileIds: catalog.unassignedFileIds,
    overlappingFileIds: catalog.overlappingFileIds,
  };
  const expectedFacts = {
    modules: draftProjection.modules,
    assignments: draftProjection.assignments,
    dependencies: draftProjection.dependencies,
    unassignedFileIds: draftProjection.unassignedFileIds,
    overlappingFileIds: draftProjection.overlappingFileIds,
  };
  if (canonicalJson(projectedFacts) !== canonicalJson(expectedFacts)) {
    throw new Error('Active module catalog does not match its reviewed discovery proposal.');
  }
  createRepositoryModuleCatalogRef(ir, catalog);
}

function requireEntityRange(
  entity: RepositoryIREntity,
  file: RepositoryIRFile,
): RepositorySourceRange & Required<Pick<RepositorySourceRange, 'startColumn' | 'endLine' | 'endColumn'>> {
  const range = entity.range;
  if (
    !range ||
    range.path !== file.path ||
    range.startColumn === undefined ||
    range.endLine === undefined ||
    range.endColumn === undefined
  ) {
    throw new Error(`Indexed entity ${entity.id} requires an adapter-owned complete source range.`);
  }
  if (
    !Number.isInteger(range.startLine) || range.startLine < 1 ||
    !Number.isInteger(range.startColumn) || range.startColumn < 1 ||
    !Number.isInteger(range.endLine) || range.endLine < range.startLine ||
    !Number.isInteger(range.endColumn) || range.endColumn < 1
  ) {
    throw new Error(`Indexed entity ${entity.id} has an invalid adapter-owned source range.`);
  }
  return range as RepositorySourceRange & Required<Pick<RepositorySourceRange, 'startColumn' | 'endLine' | 'endColumn'>>;
}

function sourceSlice(content: string, range: ReturnType<typeof requireEntityRange>): string {
  const lines = content.split(/\r?\n/);
  if (range.startLine > lines.length || range.endLine > lines.length) {
    throw new Error(`Adapter-owned source range for ${range.path} exceeds the source file.`);
  }
  const selected = lines.slice(range.startLine - 1, range.endLine);
  if (selected.length === 0) throw new Error(`Adapter-owned source range for ${range.path} is empty.`);
  selected[0] = selected[0]!.slice(range.startColumn - 1);
  const lastIndex = selected.length - 1;
  const endLimit = range.startLine === range.endLine
    ? range.endColumn - range.startColumn + 1
    : range.endColumn;
  selected[lastIndex] = selected[lastIndex]!.slice(0, endLimit);
  const result = selected.join('\n');
  if (!result.trim()) throw new Error(`Adapter-owned source range for ${range.path} selects no source.`);
  return result;
}

function selectedEntityIds(
  input: MaterializeReviewedImplementationIndexV2Input,
  ownedEntityIds: ReadonlySet<string>,
  entities: ReadonlyMap<string, RepositoryIREntity>,
): string[] {
  const selected = input.entityIds === undefined
    ? [...ownedEntityIds].filter((id) => {
        const entity = entities.get(id);
        return entity?.fileId !== undefined && entity.languageId !== undefined && entity.range !== undefined;
      })
    : [...input.entityIds];
  const result = [...new Set(selected)].sort();
  if (result.length !== selected.length || result.length === 0) {
    throw new Error('V2 implementation indexing requires unique owned entity IDs.');
  }
  for (const id of result) {
    if (!ownedEntityIds.has(id) || !entities.has(id)) {
      throw new Error(`V2 implementation index entity is outside the reviewed catalog: ${id}.`);
    }
  }
  return result;
}

function sourceFile(
  file: RepositoryIRFile,
  sources: ReadonlyMap<string, ReviewedRepositorySourceFileV2>,
  fallbackLanguageId: string,
  role: SourceImplementationFileV2['role'],
): SourceImplementationFileV2 {
  const source = sources.get(file.path);
  if (!source) throw new Error(`Source file is unavailable for reviewed IR path: ${file.path}.`);
  const contentHash = sha256(source.content);
  if (contentHash !== file.contentHash) {
    throw new Error(`Source file is stale for reviewed IR path: ${file.path}.`);
  }
  return {
    fileId: file.id,
    path: file.path,
    languageId: file.languageId ?? fallbackLanguageId,
    role,
    content: source.content,
    contentHash,
  };
}

function relatedEntities(
  primary: RepositoryIREntity,
  moduleEntityIds: ReadonlySet<string>,
  ir: UnifiedRepositoryIR,
): { helperIds: string[]; testIds: string[]; dependencyIds: string[] } {
  const adjacent = new Set<string>();
  const dependencyIds: string[] = [];
  for (const dependency of ir.dependencies) {
    if (dependency.sourceEntityId === primary.id || dependency.targetEntityId === primary.id) {
      dependencyIds.push(dependency.id);
      const related = dependency.sourceEntityId === primary.id
        ? dependency.targetEntityId
        : dependency.sourceEntityId;
      if (related && moduleEntityIds.has(related)) adjacent.add(related);
    }
  }
  const entityById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  const testIds = [...moduleEntityIds]
    .filter((id) => id !== primary.id && entityById.get(id)?.testOnly === true)
    .sort();
  const testSet = new Set(testIds);
  const helperIds = [...adjacent]
    .filter((id) => id !== primary.id && !testSet.has(id))
    .sort();
  return { helperIds, testIds, dependencyIds: [...new Set(dependencyIds)].sort() };
}

export function materializeReviewedImplementationIndexV2(
  input: MaterializeReviewedImplementationIndexV2Input,
): ReviewedImplementationIndexArtifactV2[] {
  assertReviewedCatalog(input.unifiedIr, input.proposal, input.review, input.catalog);
  const catalogRef = createRepositoryModuleCatalogRef(input.unifiedIr, input.catalog);
  const entities = new Map(input.unifiedIr.entities.map((entity) => [entity.id, entity]));
  const files = new Map(input.unifiedIr.files.map((file) => [file.id, file]));
  const moduleByEntity = new Map<string, RepositoryModuleCatalog['modules'][number]>();
  for (const module of input.catalog.modules) {
    for (const entityId of module.entityIds) {
      if (moduleByEntity.has(entityId)) {
        throw new Error(`Reviewed catalog entity has more than one module owner: ${entityId}.`);
      }
      moduleByEntity.set(entityId, module);
    }
  }
  const sources = new Map<string, ReviewedRepositorySourceFileV2>();
  for (const source of input.sourceFiles) {
    const normalized = source.path.replaceAll('\\', '/');
    if (normalized !== source.path || sources.has(normalized)) {
      throw new Error(`V2 source file path is not unique and normalized: ${source.path}.`);
    }
    sources.set(normalized, source);
  }
  const entityIds = selectedEntityIds(input, new Set(moduleByEntity.keys()), entities);

  return entityIds.map((entityId) => {
    const entity = entities.get(entityId)!;
    if (!entity.fileId || !entity.languageId) {
      throw new Error(`Indexed entity ${entity.id} requires exact file and language identities.`);
    }
    if (!entity.structureIdentity) {
      throw new Error(`Indexed entity ${entity.id} requires an adapter-owned structure identity.`);
    }
    const primaryFile = files.get(entity.fileId);
    if (!primaryFile) throw new Error(`Indexed entity ${entity.id} references an unknown source file.`);
    const primaryRange = requireEntityRange(entity, primaryFile);
    const primarySource = sourceFile(primaryFile, sources, entity.languageId, 'primary');
    const primarySlice = sourceSlice(primarySource.content, primaryRange);
    const module = moduleByEntity.get(entity.id)!;
    const moduleEntityIds = new Set(module.entityIds);
    const related = relatedEntities(entity, moduleEntityIds, input.unifiedIr);
    const supportingEntityIds = [...related.helperIds, ...related.testIds];
    const fileRoles = new Map<string, SourceImplementationFileV2['role']>([[primaryFile.id, 'primary']]);
    for (const relatedId of supportingEntityIds) {
      const relatedEntity = entities.get(relatedId);
      if (!relatedEntity?.fileId || !relatedEntity.languageId) {
        throw new Error(`Supporting entity ${relatedId} lacks exact file/language identity.`);
      }
      const relatedFile = files.get(relatedEntity.fileId);
      if (!relatedFile) throw new Error(`Supporting entity ${relatedId} references an unknown file.`);
      requireEntityRange(relatedEntity, relatedFile);
      if (!fileRoles.has(relatedFile.id)) {
        fileRoles.set(relatedFile.id, relatedEntity.testOnly ? 'test' : 'helper');
      }
    }
    const bundleFiles = [...fileRoles]
      .map(([fileId, role]) => sourceFile(files.get(fileId)!, sources, entity.languageId!, role))
      .sort((left, right) => left.fileId.localeCompare(right.fileId));
    const lineage = {
      repositoryId: catalogRef.repositoryId,
      ...(catalogRef.repositoryRevision === undefined
        ? {}
        : { repositoryRevision: catalogRef.repositoryRevision }),
      repositoryContentHash: catalogRef.repositoryContentHash,
      unifiedRepositoryIrId: catalogRef.unifiedRepositoryIrId,
      unifiedRepositoryIrHash: catalogRef.unifiedRepositoryIrHash,
      moduleCatalogId: catalogRef.moduleCatalogId,
      moduleCatalogHash: catalogRef.moduleCatalogHash,
      moduleReviewId: catalogRef.moduleReviewId,
      moduleReviewHash: catalogRef.moduleReviewHash,
    };
    const candidate: ImplementationCandidateRef = materializeImplementationCandidateRefV2({
      schemaVersion: '2.0',
      id: `implementation:${input.unifiedIr.repositoryId}:${entity.id}`,
      lineage,
      entity: {
        entityId: entity.id,
        fileId: primaryFile.id,
        languageId: entity.languageId,
        kind: entity.kind,
        name: entity.name,
        ...(entity.qualifiedName ? { qualifiedName: entity.qualifiedName } : {}),
        path: primaryFile.path,
        ...(entity.signature === undefined ? {} : { signature: entity.signature }),
      },
      ...(input.licenseByEntityId?.[entity.id]
        ? { license: input.licenseByEntityId[entity.id] }
        : {}),
    });
    const bundle = materializeSourceImplementationBundleV2({
      candidate,
      primaryEntityId: entity.id,
      helperEntityIds: related.helperIds,
      testEntityIds: related.testIds,
      dependencyIds: related.dependencyIds,
      files: bundleFiles,
      producer: input.producer,
      createdAt: input.createdAt,
    });
    const helperSignatures = related.helperIds.flatMap((id) => {
      const helper = entities.get(id);
      return helper?.signature ? [helper.signature] : helper ? [helper.qualifiedName ?? helper.name] : [];
    });
    const document = materializeIndexedImplementationDocumentV2({
      schemaVersion: '2.0',
      candidate,
      sourceCatalog: catalogRef,
      moduleId: module.id,
      entityId: entity.id,
      fileId: primaryFile.id,
      fileContentHash: primaryFile.contentHash,
      sourceBundle: { id: bundle.id, contentHash: bundle.contentHash },
      title: entity.qualifiedName ?? entity.name,
      summary: [module.description, ...module.responsibilities].filter(Boolean).join(' '),
      searchText: [
        entity.qualifiedName ?? entity.name,
        entity.signature ?? '',
        module.description,
        ...module.responsibilities,
        ...module.businessCapabilities,
        ...helperSignatures,
        primarySlice,
      ].filter(Boolean).join('\n'),
      producer: input.producer,
      createdAt: input.createdAt,
    });
    return { bundle, document };
  });
}
