import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  repositoryIngestionSchemaVersion,
  type AnalysisCapability,
  type AnalysisShard,
  type LanguageId,
  type RepositoryArtifactProducer,
  type RepositoryApiExposure,
  type RepositoryApiSurface,
  type RepositoryDiagnostic,
  type RepositoryEvidenceRef,
  type RepositoryFileInventory,
  type RepositoryFileRole,
  type RepositoryIRDependency,
  type RepositoryIREntity,
  type RepositoryIREntityKind,
  type RepositoryIRFile,
  type RepositoryLanguageProfile,
  type RepositoryProfile,
  type RepositoryProjectProfile,
  type RepositoryStructureIdentity,
  type RepositoryContainerCapability,
  type RepositoryStaticAnalysis,
  type RepositoryStaticAnalysisAdapterDescriptor,
  type StaticAnalysisDiagnostic,
  type StaticAnalysisFile,
  type StaticSymbol,
  type UnifiedRepositoryIR,
} from '@forexplore/contracts';
import { verifyRepositoryStaticAnalysis } from './repository-analysis.js';

export const repositoryIngestionBridgeVersion = '1.2.0-structure-identity';

const bridgeProducerId = 'forexplore-code-indexer/repository-ingestion-bridge';
const inventoryAdapterId = 'repository-file-inventory';

export interface RepositoryStaticAnalysisBridgeArtifacts {
  profile: RepositoryProfile;
  shards: AnalysisShard[];
  unifiedIr: UnifiedRepositoryIR;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Canonical SHA-256 used for every artifact and evidence identity emitted by the bridge. */
export function repositoryIngestionBridgeHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function addressedId(prefix: string, payload: unknown): string {
  return `${prefix}:${repositoryIngestionBridgeHash(payload).slice(0, 32)}`;
}

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compareText);
}

const canonicalLegacyLanguageIds: Readonly<Record<string, LanguageId>> = {
  TypeScript: 'typescript',
  Python: 'python',
  Java: 'java',
  'C#': 'csharp',
  Rust: 'rust',
  Go: 'go',
};

function canonicalLanguageId(languageId: LanguageId): LanguageId {
  return canonicalLegacyLanguageIds[languageId] ?? languageId;
}

function legacyAdapterId(languageId: LanguageId): string {
  const slug = languageId
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 160) || 'language';
  return `repository-static-analysis:${slug}-${repositoryIngestionBridgeHash(languageId).slice(0, 12)}`;
}

function adapterDescriptor(
  analysis: RepositoryStaticAnalysis,
  languageId: LanguageId,
): RepositoryStaticAnalysisAdapterDescriptor | undefined {
  return analysis.analysisAdapters?.find(
    (adapter) => canonicalLanguageId(adapter.languageId) === languageId,
  );
}

function adapterId(analysis: RepositoryStaticAnalysis, languageId: LanguageId): string {
  return adapterDescriptor(analysis, languageId)?.id ?? legacyAdapterId(languageId);
}

function structureIdentityForSymbol(
  analysis: RepositoryStaticAnalysis,
  symbol: StaticSymbol,
): RepositoryStructureIdentity {
  const languageId = canonicalLanguageId(symbol.language);
  const descriptor = adapterDescriptor(analysis, languageId);
  const identity: RepositoryStructureIdentity = {
    basis: 'declaration-shape',
    contentHash: repositoryIngestionBridgeHash({
      languageId,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      containerSymbolId: symbol.containerSymbolId,
      signature: symbol.signature,
      visibility: symbol.visibility,
      exported: symbol.exported,
      parameters: symbol.parameters,
      returnShape: symbol.returnShape,
    }),
    schemaVersion: 'repository-static-symbol-declaration-shape-v1',
    adapterId: descriptor?.id ?? legacyAdapterId(languageId),
    adapterVersion: descriptor?.version ?? analysis.analyzerVersion,
    ...(descriptor?.configurationHash
      ? { configurationHash: descriptor.configurationHash }
      : {}),
  };
  return identity;
}

function containerCapabilityForSymbol(
  analysis: RepositoryStaticAnalysis,
  symbol: StaticSymbol,
  referencedContainerIds: ReadonlySet<string>,
): RepositoryContainerCapability | undefined {
  const isNativeContainer = [
    'project',
    'package',
    'namespace',
    'class',
    'interface',
    'record',
    'struct',
    'enum',
  ].includes(symbol.kind);
  if (!isNativeContainer && !referencedContainerIds.has(symbol.id)) return undefined;
  const languageId = canonicalLanguageId(symbol.language);
  const descriptor = adapterDescriptor(analysis, languageId);
  return {
    canContainCallables: true,
    nativeKind: symbol.kind,
    adapterId: descriptor?.id ?? legacyAdapterId(languageId),
    adapterVersion: descriptor?.version ?? analysis.analyzerVersion,
  };
}

function bridgeProducer(): RepositoryArtifactProducer {
  return {
    kind: 'ingestion-host',
    id: bridgeProducerId,
    version: repositoryIngestionBridgeVersion,
  };
}

function analysisProducer(
  analysis: RepositoryStaticAnalysis,
  languageId: LanguageId,
): RepositoryArtifactProducer {
  const descriptor = adapterDescriptor(analysis, languageId);
  return {
    kind: 'analysis-adapter',
    id: descriptor?.id ?? legacyAdapterId(languageId),
    version: descriptor?.version ?? analysis.analyzerVersion,
  };
}

function fileRole(role: StaticAnalysisFile['role']): RepositoryFileRole {
  return role;
}

function fileId(snapshotId: string, file: StaticAnalysisFile): string {
  return addressedId('file', {
    snapshotId,
    path: file.path,
    contentHash: file.sha256,
  });
}

function entityKind(symbol: StaticSymbol): RepositoryIREntityKind {
  if (symbol.kind === 'project') return 'project';
  if (symbol.kind === 'package') return 'package';
  if (symbol.kind === 'namespace') return 'namespace';
  if (['class', 'interface', 'record', 'struct', 'enum'].includes(symbol.kind)) return 'type';
  if (['method', 'constructor', 'function'].includes(symbol.kind)) return 'callable';
  if (['field', 'property'].includes(symbol.kind)) return 'member';
  return 'unknown';
}

function inventory(files: readonly StaticAnalysisFile[]): RepositoryFileInventory {
  const result: RepositoryFileInventory = {
    total: files.length,
    source: 0,
    test: 0,
    generated: 0,
    configuration: 0,
    documentation: 0,
    asset: 0,
    other: 0,
  };
  for (const file of files) result[fileRole(file.role)] += 1;
  return result;
}

function extension(filePath: string): string {
  return path.posix.extname(filePath).toLowerCase();
}

function languageProfiles(
  files: readonly StaticAnalysisFile[],
  projectIdByManifest: ReadonlyMap<string, string>,
): RepositoryLanguageProfile[] {
  const languageIds = sortedUnique(files.flatMap((file) =>
    file.language ? [canonicalLanguageId(file.language)] : [],
  ));
  return languageIds.map((languageId) => {
    const languageFiles = files.filter(
      (file) => file.language !== undefined && canonicalLanguageId(file.language) === languageId,
    );
    return {
      languageId,
      fileExtensions: sortedUnique(languageFiles.map((file) => extension(file.path)).filter(Boolean)),
      fileCount: languageFiles.length,
      sourceFileCount: languageFiles.filter((file) => file.role === 'source').length,
      testFileCount: languageFiles.filter((file) => file.role === 'test').length,
      projectIds: sortedUnique(languageFiles.flatMap((file) => {
        if (!file.project) return [];
        return [projectIdByManifest.get(file.project) ?? file.project];
      })),
    };
  });
}

function projectProfiles(
  analysis: RepositoryStaticAnalysis,
  projectSymbols: readonly StaticSymbol[],
): RepositoryProjectProfile[] {
  const idByManifest = new Map(projectSymbols.map((symbol) => [symbol.path, symbol.id]));
  return projectSymbols.map((symbol) => {
    const rootPath = symbol.path.includes('/')
      ? symbol.path.slice(0, symbol.path.lastIndexOf('/'))
      : '';
    const projectFiles = analysis.files.filter(
      (file) => file.path === symbol.path || file.project === symbol.path,
    );
    const dependencyProjectIds = analysis.dependencies.flatMap((dependency) => {
      if (dependency.kind !== 'project-reference' || dependency.sourcePath !== symbol.path) return [];
      if (!dependency.targetPath) return [];
      const targetId = idByManifest.get(dependency.targetPath);
      return targetId ? [targetId] : [];
    });
    return {
      id: symbol.id,
      name: symbol.name,
      rootPath,
      languageIds: sortedUnique(projectFiles.flatMap((file) =>
        file.language ? [canonicalLanguageId(file.language)] : [],
      )),
      manifestPaths: [symbol.path],
      dependencyProjectIds: sortedUnique(dependencyProjectIds),
    };
  }).sort((left, right) => compareText(left.id, right.id));
}

function repositoryDiagnostic(
  analysis: RepositoryStaticAnalysis,
  source: StaticAnalysisDiagnostic,
  languageByPath: ReadonlyMap<string, LanguageId>,
): RepositoryDiagnostic {
  const languageId = source.path ? languageByPath.get(source.path) : undefined;
  return {
    id: addressedId('diagnostic', {
      sourceArtifactId: analysis.snapshotId,
      sourceDiagnosticId: source.id,
    }),
    severity: source.severity,
    code: source.code ?? 'STATIC_ANALYSIS_DIAGNOSTIC',
    message: source.message,
    adapterId: languageId ? adapterId(analysis, languageId) : bridgeProducerId,
    ...(languageId ? { languageId } : {}),
    ...(source.path ? { path: source.path } : {}),
    ...(source.range ? { range: source.range } : {}),
    details: { sourceDiagnosticId: source.id },
  };
}

function dependencyEvidenceRefs(
  analysis: RepositoryStaticAnalysis,
  dependency: RepositoryStaticAnalysis['dependencies'][number],
): RepositoryEvidenceRef[] {
  const ranges = dependency.evidenceRanges.length > 0
    ? dependency.evidenceRanges.map((range) => ({ range, path: range.path }))
    : [{ path: dependency.sourcePath }];
  return ranges.map((entry, index) => {
    const range = 'range' in entry ? entry.range : undefined;
    return {
      id: addressedId('evidence', {
        sourceArtifactId: analysis.snapshotId,
        sourceDependencyId: dependency.id,
        range,
        index,
      }),
      kind: dependency.evidence === 'semantic' ? 'semantic-analysis' : 'syntactic-analysis',
      path: entry.path,
      ...(range ? { range } : {}),
      summary: `${dependency.evidence} ${dependency.kind} evidence from repository static analysis`,
    };
  });
}

function apiExposure(symbol: StaticSymbol): RepositoryApiExposure {
  if (
    symbol.visibility &&
    symbol.visibility !== 'unknown' &&
    ['public', 'protected', 'internal', 'package', 'private'].includes(symbol.visibility)
  ) {
    return symbol.visibility;
  }
  if (symbol.exported === true) return 'exported';
  if (symbol.exported === false) return 'not-exported';
  return 'unknown';
}

function apiSurfaceForSymbol(
  analysis: RepositoryStaticAnalysis,
  symbol: StaticSymbol,
): RepositoryApiSurface | undefined {
  const kind = entityKind(symbol);
  if (!['type', 'callable', 'member'].includes(kind)) return undefined;
  const exposure = apiExposure(symbol);
  const missingFeatures: string[] = [];
  if (exposure === 'unknown') missingFeatures.push('exposure');
  if (!symbol.signature?.trim()) missingFeatures.push('signature');
  if (kind === 'callable' && symbol.parameters === undefined) missingFeatures.push('parameters');
  if ((kind === 'callable' || kind === 'member') && !symbol.returnShape?.trim()) {
    missingFeatures.push('return-shape');
  }
  if (canonicalLanguageId(symbol.language) === 'python') {
    missingFeatures.push('exposure-derived-from-naming-convention');
  }
  const canonicalMissingFeatures = sortedUnique(missingFeatures);
  const completeness = exposure === 'unknown'
    ? 'unknown' as const
    : canonicalMissingFeatures.length === 0
      ? 'complete' as const
      : 'partial' as const;
  const visibility = symbol.visibility ?? (
    symbol.exported === true ? 'exported' : symbol.exported === false ? 'not-exported' : 'unknown'
  );
  const evidenceRefs: RepositoryEvidenceRef[] = [{
    // Cite an existing IR fact. A shard ID cannot be embedded here without
    // making the content-addressed shard identity circular.
    id: symbol.id,
    kind: 'syntactic-analysis',
    path: symbol.path,
    ...(symbol.range ? { range: symbol.range } : {}),
    summary: `Declaration evidence for ${symbol.qualifiedName}`,
  }];
  const payload: Omit<RepositoryApiSurface, 'id'> = {
    entityId: symbol.id,
    languageId: canonicalLanguageId(symbol.language),
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    signature: symbol.signature ?? '',
    visibility,
    exposure,
    ...(symbol.parameters
      ? {
          parameters: symbol.parameters.map((parameter, position) => ({
            name: parameter.name,
            position,
            ...(parameter.type ? { type: parameter.type } : {}),
            ...(parameter.required !== undefined ? { required: parameter.required } : {}),
            ...(parameter.variadic !== undefined ? { variadic: parameter.variadic } : {}),
          })),
        }
      : {}),
    ...(symbol.returnShape ? { returnShape: { type: symbol.returnShape } } : {}),
    completeness,
    missingFeatures: canonicalMissingFeatures,
    structureIdentity: structureIdentityForSymbol(analysis, symbol),
    evidenceRefs,
  };
  return { ...payload, id: addressedId('api-surface', payload) };
}

function capabilitiesForShard(
  files: readonly RepositoryIRFile[],
  entities: readonly RepositoryIREntity[],
  apiSurfaces: readonly RepositoryApiSurface[],
  dependencies: readonly RepositoryIRDependency[],
  descriptor: RepositoryStaticAnalysisAdapterDescriptor | undefined,
): AnalysisCapability[] {
  const capabilities = new Set<AnalysisCapability>(['file-inventory']);
  const declared = new Set<AnalysisCapability>(descriptor?.capabilities ?? ['file-inventory']);
  const executed = files.some((file) =>
    file.role === 'source' || file.role === 'test' || file.role === 'generated',
  );
  for (const capability of declared) {
    if (capability === 'file-inventory') continue;
    if (capability === 'project-model') {
      if (entities.some((entity) => entity.kind === 'project')) capabilities.add(capability);
      continue;
    }
    if (capability === 'semantic-binding') {
      if (dependencies.some((dependency) => dependency.evidenceLevel === 'semantic')) {
        capabilities.add(capability);
      }
      continue;
    }
    if (capability === 'api-surface') {
      if (executed && apiSurfaces.every((surface) => surface.completeness !== 'unknown')) {
        capabilities.add(capability);
      }
      continue;
    }
    if (executed) capabilities.add(capability);
  }
  return [...capabilities].sort(compareText);
}

const baselineAnalysisCapabilities: readonly AnalysisCapability[] = [
  'file-inventory',
  'symbol-index',
  'api-surface',
  'dependency-graph',
  'semantic-binding',
];

function repositoryId(analysis: RepositoryStaticAnalysis): string {
  if (analysis.repository.id?.trim()) return analysis.repository.id.trim();
  return addressedId('repository', {
    identity:
      analysis.repository.remote?.trim() ||
      analysis.repository.root?.trim() ||
      analysis.snapshotId,
  });
}

/**
 * Deterministically project the legacy static graph into the language-neutral
 * repository-ingestion artifacts. No new semantic evidence is inferred.
 */
export function bridgeRepositoryStaticAnalysis(
  input: RepositoryStaticAnalysis,
): RepositoryStaticAnalysisBridgeArtifacts {
  const analysis = verifyRepositoryStaticAnalysis(input);
  const resolvedRepositoryId = repositoryId(analysis);
  const projectSymbols = analysis.symbols.filter((symbol) => symbol.kind === 'project');
  const projectIdByManifest = new Map(projectSymbols.map((symbol) => [symbol.path, symbol.id]));
  const languageByPath = new Map(analysis.files.flatMap((file) =>
    file.language ? [[file.path, canonicalLanguageId(file.language)] as const] : [],
  ));
  const diagnostics = analysis.diagnostics
    .map((entry) => repositoryDiagnostic(analysis, entry, languageByPath))
    .sort((left, right) => compareText(left.id, right.id));
  const languageIds = sortedUnique(languageByPath.values());
  const hasUnclassifiedFiles = analysis.files.some((file) => file.language === undefined);
  const adapterIds = [
    ...languageIds.map((languageId) => adapterId(analysis, languageId)),
    ...(hasUnclassifiedFiles ? [inventoryAdapterId] : []),
  ].sort(compareText);
  const projects = projectProfiles(analysis, projectSymbols);

  const profileWithoutId: Omit<RepositoryProfile, 'id'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: resolvedRepositoryId,
    ...(analysis.repository.remote ? { remoteUrl: analysis.repository.remote } : {}),
    ...(analysis.repository.revision ? { revision: analysis.repository.revision } : {}),
    contentHash: analysis.contentHash,
    languages: languageProfiles(analysis.files, projectIdByManifest),
    projects,
    fileInventory: inventory(analysis.files),
    analysisAdapterIds: adapterIds,
    diagnostics,
    producer: bridgeProducer(),
    createdAt: analysis.createdAt,
  };
  const profile: RepositoryProfile = {
    ...profileWithoutId,
    id: addressedId('repository-profile', profileWithoutId),
  };

  const files: RepositoryIRFile[] = analysis.files.map((file) => ({
    id: fileId(analysis.snapshotId, file),
    path: file.path,
    contentHash: file.sha256,
    role: fileRole(file.role),
    ...(file.language ? { languageId: canonicalLanguageId(file.language) } : {}),
    projectIds: file.project
      ? [projectIdByManifest.get(file.project) ?? file.project]
      : [],
    ...(file.role === 'generated' ? { generated: true } : {}),
    attributes: { sourceSnapshotId: analysis.snapshotId },
  })).sort((left, right) => compareText(left.path, right.path));
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  const referencedContainerIds = new Set(
    analysis.symbols.flatMap((symbol) => symbol.containerSymbolId ? [symbol.containerSymbolId] : []),
  );
  const fileContainerByFileId = new Map<string, RepositoryIREntity>();
  for (const file of files) {
    if (!file.languageId || !['source', 'test', 'generated'].includes(file.role)) continue;
    const descriptor = adapterDescriptor(analysis, file.languageId);
    const id = addressedId('entity', {
      snapshotId: analysis.snapshotId,
      fileId: file.id,
      nativeKind: 'source-file-module',
    });
    fileContainerByFileId.set(file.id, {
      id,
      kind: 'module',
      name: `[module] ${file.path.replace(/\.[^/.]+$/, '').split('/').at(-1) ?? file.path}`,
      qualifiedName: `[module] ${file.path.replace(/\.[^/.]+$/, '').replaceAll('/', '.')}`,
      languageId: file.languageId,
      fileId: file.id,
      structureIdentity: {
        basis: 'declaration-shape',
        contentHash: repositoryIngestionBridgeHash({
          languageId: file.languageId,
          path: file.path,
          nativeKind: 'source-file-module',
        }),
        schemaVersion: 'repository-source-file-module-shape-v1',
        adapterId: descriptor?.id ?? legacyAdapterId(file.languageId),
        adapterVersion: descriptor?.version ?? analysis.analyzerVersion,
        ...(descriptor?.configurationHash
          ? { configurationHash: descriptor.configurationHash }
          : {}),
      },
      containerCapability: {
        canContainCallables: true,
        nativeKind: 'source-file-module',
        adapterId: descriptor?.id ?? legacyAdapterId(file.languageId),
        adapterVersion: descriptor?.version ?? analysis.analyzerVersion,
      },
      attributes: {
        sourceSnapshotId: analysis.snapshotId,
        syntheticFileContainer: true,
      },
    });
  }
  const symbolEntities: RepositoryIREntity[] = analysis.symbols.map((symbol) => {
    const boundFile = fileByPath.get(symbol.path);
    const explicitContainer = symbol.containerSymbolId;
    const fileContainer = boundFile ? fileContainerByFileId.get(boundFile.id) : undefined;
    const inferredFileContainer = !explicitContainer &&
      ['type', 'callable', 'member'].includes(entityKind(symbol))
      ? fileContainer?.id
      : undefined;
    const containerCapability = containerCapabilityForSymbol(
      analysis,
      symbol,
      referencedContainerIds,
    );
    return {
    id: symbol.id,
    kind: entityKind(symbol),
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    languageId: canonicalLanguageId(symbol.language),
    ...(fileByPath.get(symbol.path) ? { fileId: fileByPath.get(symbol.path)?.id } : {}),
    ...(symbol.project
      ? { projectId: projectIdByManifest.get(symbol.project) ?? symbol.project }
      : symbol.kind === 'project' ? { projectId: symbol.id } : {}),
    ...(symbol.range ? { range: symbol.range } : {}),
    ...(symbol.signature ? { signature: symbol.signature } : {}),
    ...(symbol.visibility ? { visibility: symbol.visibility } : {}),
    ...(explicitContainer || inferredFileContainer
      ? { containerEntityId: explicitContainer ?? inferredFileContainer }
      : {}),
    ...(symbol.testOnly !== undefined ? { testOnly: symbol.testOnly } : {}),
    structureIdentity: structureIdentityForSymbol(analysis, symbol),
    ...(containerCapability ? { containerCapability } : {}),
    attributes: {
      sourceSnapshotId: analysis.snapshotId,
      staticSymbolKind: symbol.kind,
      ...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
      ...(symbol.returnShape ? { returnShape: symbol.returnShape } : {}),
    },
    };
  });
  const entities: RepositoryIREntity[] = [
    ...fileContainerByFileId.values(),
    ...symbolEntities,
  ].sort((left, right) => compareText(left.id, right.id));
  const entityIds = new Set(entities.map((entity) => entity.id));
  const apiSurfaces = analysis.symbols
    .map((symbol) => apiSurfaceForSymbol(analysis, symbol))
    .filter((surface): surface is RepositoryApiSurface => surface !== undefined)
    .sort((left, right) => compareText(left.id, right.id));

  const dependencies: RepositoryIRDependency[] = analysis.dependencies.map((dependency) => {
    const sourceFile = fileByPath.get(dependency.sourcePath);
    if (!sourceFile) {
      throw new Error(`Static dependency source file is absent from the snapshot: ${dependency.sourcePath}`);
    }
    const targetFile = dependency.targetPath ? fileByPath.get(dependency.targetPath) : undefined;
    const payload: Omit<RepositoryIRDependency, 'id'> = {
      ...(dependency.sourceSymbolId && entityIds.has(dependency.sourceSymbolId)
        ? { sourceEntityId: dependency.sourceSymbolId }
        : {}),
      ...(dependency.targetSymbolId && entityIds.has(dependency.targetSymbolId)
        ? { targetEntityId: dependency.targetSymbolId }
        : {}),
      sourceFileId: sourceFile.id,
      ...(targetFile ? { targetFileId: targetFile.id } : {}),
      kind: dependency.kind,
      internal: dependency.internal,
      resolution: dependency.internal ? dependency.resolution : 'external',
      evidenceLevel: dependency.evidence,
      ...(dependency.targetReference !== undefined
        ? { targetReference: dependency.targetReference }
        : {}),
      evidenceRefs: dependencyEvidenceRefs(analysis, dependency),
    };
    return { ...payload, id: addressedId('dependency', payload) };
  }).sort((left, right) => compareText(left.id, right.id));

  const shards = languageIds.map((languageId): AnalysisShard => {
    const shardFiles = files.filter((file) => file.languageId === languageId);
    const shardFileIds = new Set(shardFiles.map((file) => file.id));
    const shardEntities = entities.filter((entity) =>
      entity.languageId === languageId || (entity.fileId ? shardFileIds.has(entity.fileId) : false),
    );
    const shardEntityIds = new Set(shardEntities.map((entity) => entity.id));
    const shardApiSurfaces = apiSurfaces.filter((surface) => shardEntityIds.has(surface.entityId));
    const shardDependencies = dependencies.filter((dependency) =>
      shardFileIds.has(dependency.sourceFileId),
    );
    const shardDiagnostics = diagnostics.filter((entry) => entry.languageId === languageId);
    const descriptor = adapterDescriptor(analysis, languageId);
    const capabilities = capabilitiesForShard(
      shardFiles,
      shardEntities,
      shardApiSurfaces,
      shardDependencies,
      descriptor,
    );
    const payload: Omit<AnalysisShard, 'id' | 'contentHash'> = {
      schemaVersion: repositoryIngestionSchemaVersion,
      repositoryId: resolvedRepositoryId,
      profileId: profile.id,
      adapterId: descriptor?.id ?? legacyAdapterId(languageId),
      adapterVersion: descriptor?.version ?? analysis.analyzerVersion,
      mode: 'full',
      languageIds: [languageId],
      projectIds: sortedUnique(shardFiles.flatMap((file) => file.projectIds)),
      pathPrefixes: [],
      ...(analysis.repository.revision ? { inputRevision: analysis.repository.revision } : {}),
      inputContentHash: analysis.contentHash,
      capabilities,
      // Surface completeness is an evidence-quality gate, not an execution
      // failure. Consumers inspect capability + missingFeatures for review.
      status: shardDiagnostics.some((entry) => entry.severity === 'error') ? 'partial' : 'completed',
      files: shardFiles,
      entities: shardEntities,
      apiSurfaces: shardApiSurfaces,
      dependencies: shardDependencies,
      diagnostics: shardDiagnostics,
      producer: analysisProducer(analysis, languageId),
      createdAt: analysis.createdAt,
      completedAt: analysis.createdAt,
    };
    const contentHash = repositoryIngestionBridgeHash(payload);
    return {
      ...payload,
      id: `analysis-shard:${contentHash.slice(0, 32)}`,
      contentHash,
    };
  }).sort((left, right) => compareText(left.id, right.id));

  const unclassifiedFiles = files.filter((file) => file.languageId === undefined);
  if (unclassifiedFiles.length > 0) {
    const unclassifiedFileIds = new Set(unclassifiedFiles.map((file) => file.id));
    const inventoryDiagnostics = diagnostics.filter((entry) =>
      entry.languageId === undefined &&
      (entry.path === undefined || unclassifiedFiles.some((file) => file.path === entry.path)),
    );
    const payload: Omit<AnalysisShard, 'id' | 'contentHash'> = {
      schemaVersion: repositoryIngestionSchemaVersion,
      repositoryId: resolvedRepositoryId,
      profileId: profile.id,
      adapterId: inventoryAdapterId,
      adapterVersion: analysis.analyzerVersion,
      mode: 'full',
      languageIds: [],
      projectIds: sortedUnique(unclassifiedFiles.flatMap((file) => file.projectIds)),
      pathPrefixes: [],
      ...(analysis.repository.revision ? { inputRevision: analysis.repository.revision } : {}),
      inputContentHash: analysis.contentHash,
      capabilities: ['file-inventory'],
      status: inventoryDiagnostics.some((entry) => entry.severity === 'error') ? 'partial' : 'completed',
      files: unclassifiedFiles,
      entities: entities.filter((entity) =>
        entity.fileId !== undefined && unclassifiedFileIds.has(entity.fileId),
      ),
      apiSurfaces: [],
      dependencies: dependencies.filter((dependency) =>
        unclassifiedFileIds.has(dependency.sourceFileId),
      ),
      diagnostics: inventoryDiagnostics,
      producer: {
        kind: 'analysis-adapter',
        id: inventoryAdapterId,
        version: analysis.analyzerVersion,
      },
      createdAt: analysis.createdAt,
      completedAt: analysis.createdAt,
    };
    const contentHash = repositoryIngestionBridgeHash(payload);
    shards.push({
      ...payload,
      id: `analysis-shard:${contentHash.slice(0, 32)}`,
      contentHash,
    });
    shards.sort((left, right) => compareText(left.id, right.id));
  }

  const capabilities = sortedUnique<AnalysisCapability>([
    'repository-profile',
    ...shards.flatMap((shard) => shard.capabilities),
  ]);
  const failedPaths = new Set(diagnostics.flatMap((entry) =>
    entry.severity === 'error' && entry.path && fileByPath.has(entry.path) ? [entry.path] : [],
  ));
  const coverageSegments = shards.map((shard) => {
    const shardPaths = new Set(shard.files.map((file) => file.path));
    const failedFileCount = [...failedPaths].filter((failedPath) => shardPaths.has(failedPath)).length;
    // Language-owned configuration files are analysed by the project/reference
    // collector as part of this shard, not silently counted as skipped source.
    const analysableFiles = shard.files.filter((file) => file.languageId !== undefined);
    const analysedFileCount = analysableFiles.filter((file) => !failedPaths.has(file.path)).length;
    const expectedCapabilities = new Set<AnalysisCapability>(baselineAnalysisCapabilities);
    if (shard.files.some((file) => file.role === 'test')) {
      expectedCapabilities.add('test-association');
    }
    if (shard.entities.some((entity) => entity.kind === 'project')) {
      expectedCapabilities.add('project-model');
    }
    const missingCapabilities = [...expectedCapabilities]
      .filter((capability) => !shard.capabilities.includes(capability))
      .sort(compareText);
    const segmentPayload = {
      shardId: shard.id,
      ...(shard.languageIds[0] ? { languageId: shard.languageIds[0] } : {}),
      discoveredFileCount: shard.files.length,
      analysedFileCount,
      failedFileCount,
      skippedFileCount: Math.max(0, shard.files.length - analysedFileCount - failedFileCount),
      capabilities: shard.capabilities,
      missingCapabilities,
      diagnosticIds: shard.diagnostics.map((diagnostic) => diagnostic.id).sort(compareText),
    };
    return {
      id: addressedId('coverage-segment', segmentPayload),
      ...segmentPayload,
    };
  }).sort((left, right) => compareText(left.id, right.id));
  const missingCapabilities = sortedUnique<AnalysisCapability>(
    coverageSegments.flatMap((segment) => segment.missingCapabilities),
  );
  const analysedFileCount = coverageSegments.reduce(
    (total, segment) => total + segment.analysedFileCount,
    0,
  );
  const irPayload: Omit<UnifiedRepositoryIR, 'id' | 'contentHash'> = {
    schemaVersion: repositoryIngestionSchemaVersion,
    repositoryId: resolvedRepositoryId,
    profileId: profile.id,
    ...(analysis.repository.revision ? { repositoryRevision: analysis.repository.revision } : {}),
    repositoryContentHash: analysis.contentHash,
    sourceShardIds: shards.map((shard) => shard.id),
    capabilities,
    files,
    entities,
    apiSurfaces,
    dependencies,
    coverage: {
      discoveredFileCount: files.length,
      analysedFileCount,
      failedFileCount: failedPaths.size,
      skippedFileCount: coverageSegments.reduce(
        (total, segment) => total + segment.skippedFileCount,
        0,
      ),
      languageIds,
      missingCapabilities,
      segments: coverageSegments,
    },
    diagnostics,
    producer: bridgeProducer(),
    createdAt: analysis.createdAt,
  };
  const contentHash = repositoryIngestionBridgeHash(irPayload);
  const unifiedIr: UnifiedRepositoryIR = {
    ...irPayload,
    id: `unified-repository-ir:${contentHash.slice(0, 32)}`,
    contentHash,
  };

  return { profile, shards, unifiedIr };
}

/** Compatibility-friendly projection for consumers that only need the merged IR. */
export function repositoryStaticAnalysisToUnifiedIr(
  analysis: RepositoryStaticAnalysis,
): UnifiedRepositoryIR {
  return bridgeRepositoryStaticAnalysis(analysis).unifiedIr;
}
