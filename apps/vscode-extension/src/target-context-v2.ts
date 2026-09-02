import { createHash } from 'node:crypto';
import type {
  MigrationProviderRefV2,
  MigrationRuntimeCapabilitySnapshot,
  MigrationTargetRef,
  TargetContextFactV2,
  TargetContextSnapshotV2,
} from '@forexplore/contracts';
import {
  materializeTargetContextSnapshotV2,
  validateMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';
import type { TargetWorkspaceEntityContext } from './target-workspace-host';

export interface CollectTargetContextV2Input {
  target: MigrationTargetRef;
  runtimeCapabilities: MigrationRuntimeCapabilitySnapshot;
  context: TargetWorkspaceEntityContext;
  /** Exact full target file bytes read by the trusted Host after freshness checks. */
  targetFileContent: string;
  createdAt?: string;
}

/**
 * Materializes adapter-owned IR facts directly into the V2 target context.
 * This deliberately has no dependency on the syntax-shaped V1
 * `TargetModuleContext` bridge.
 */
export function collectTargetContextV2(
  input: CollectTargetContextV2Input,
): TargetContextSnapshotV2 {
  const runtime = validateMigrationRuntimeCapabilitySnapshot(input.runtimeCapabilities);
  const route = runtime.routes.find((candidate) =>
    candidate.id === input.target.route.routeId &&
    candidate.version === input.target.route.routeVersion &&
    candidate.contentHash === input.target.route.routeContentHash,
  );
  if (!route) throw new Error('V2 target context route is absent from the exact runtime snapshot.');
  const stage = route.stages.find((candidate) =>
    candidate.stage === 'context-collection' &&
    candidate.availability.status !== 'unavailable',
  ) ?? route.stages.find((candidate) =>
    candidate.stage === 'target-analysis' &&
    candidate.availability.status !== 'unavailable',
  );
  if (!stage) {
    throw new Error('The exact route has no available target context or target analysis provider.');
  }
  const provider: MigrationProviderRefV2 = {
    providerId: stage.providerId,
    providerVersion: stage.providerVersion,
  };
  const entity = input.context.entity;
  const file = input.context.file;
  if (
    entity.id !== input.target.entity.entityId ||
    file?.id !== input.target.entity.fileId ||
    file.path !== input.target.entity.path ||
    file.contentHash !== input.target.entity.fileContentHash
  ) {
    throw new Error('Target context IR entity/file facts do not match the selected V2 target.');
  }
  const declarationText = entity.signature?.trim() || entity.qualifiedName?.trim() || entity.name;
  if (sha256(input.targetFileContent) !== input.target.entity.fileContentHash) {
    throw new Error('Host-read target file content does not match the selected V2 file hash.');
  }
  const declaration = contextFact({
    id: `target-declaration:${entity.id}`,
    role: 'declaration',
    languageId: input.target.entity.languageId,
    entityId: entity.id,
    fileId: file.id,
    path: file.path,
    content: declarationText,
    provider,
    attributes: {
      nativeKind: entity.kind,
      ...(entity.qualifiedName === undefined ? {} : { qualifiedName: entity.qualifiedName }),
      ...(entity.signature === undefined ? {} : { signature: entity.signature }),
      ...(entity.range === undefined ? {} : {
        rangeStartLine: entity.range.startLine,
        ...(entity.range.startColumn === undefined ? {} : { rangeStartColumn: entity.range.startColumn }),
        ...(entity.range.endLine === undefined ? {} : { rangeEndLine: entity.range.endLine }),
        ...(entity.range.endColumn === undefined ? {} : { rangeEndColumn: entity.range.endColumn }),
      }),
      declarationIdentitySchema: input.target.entity.declarationIdentity.schemaVersion,
      declarationIdentityHash: input.target.entity.declarationIdentity.contentHash,
    },
  });
  const container = entity.containerEntityId === undefined
    ? []
    : input.context.ir.entities
      .filter((candidate) => candidate.id === entity.containerEntityId)
      .map((candidate) => contextFact({
        id: `target-container:${candidate.id}`,
        role: 'container',
        languageId: candidate.languageId,
        entityId: candidate.id,
        ...(candidate.fileId === undefined ? {} : { fileId: candidate.fileId }),
        path: file.path,
        content: candidate.signature?.trim() || candidate.qualifiedName?.trim() || candidate.name,
        provider,
        attributes: {
          nativeKind: candidate.kind,
          ...(candidate.qualifiedName === undefined ? {} : { qualifiedName: candidate.qualifiedName }),
        },
      }));

  return materializeTargetContextSnapshotV2({
    schemaVersion: '2.0',
    target: input.target,
    route: input.target.route,
    declarations: [declaration],
    containers: container,
    imports: [],
    dependencies: [],
    references: [],
    callers: [],
    tests: [],
    sourceFiles: [contextFact({
      id: `target-file:${file.id}`,
      role: 'source-file',
      languageId: input.target.entity.languageId,
      fileId: file.id,
      path: file.path,
      content: input.targetFileContent,
      provider,
      attributes: {
        factKind: 'full-target-file',
        authoritativeForPatchSubject: true,
      },
    })],
    buildFacts: [],
    allowedModifications: input.target.allowedModificationPaths.map((allowedPath) => {
      if (allowedPath !== input.target.entity.path) {
        throw new Error(`Target context cannot prove the current hash for allowed path ${allowedPath}.`);
      }
      return {
        path: allowedPath,
        operation: 'modify' as const,
        expectedContentHash: input.target.entity.fileContentHash,
      };
    }),
    constraints: [],
    producer: { ...provider },
    createdAt: input.createdAt ?? new Date().toISOString(),
  }, runtime);
}

function contextFact(
  input: Omit<TargetContextFactV2, 'contentHash'> & { content: string },
): TargetContextFactV2 {
  return {
    ...input,
    contentHash: sha256(input.content),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
