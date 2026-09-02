import {
  migrationExecutionV2SchemaVersion,
  migrationReferenceSchemaVersion,
  migrationRouteSchemaVersion,
  repositoryIngestionSchemaVersion,
  validationPolicySchemaVersion,
  type MigrationRouteDescriptor,
  type RepositoryModuleCatalog,
  type UnifiedRepositoryIR,
  type ValidationRecord,
} from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';
import {
  calculatePatchHashV2,
  calculatePatchSubjectHashV2,
  createMigrationRouteSnapshotRef,
  materializeAdaptationRequestV2,
  materializeAdaptationResultV2,
  materializeImplementationCandidateRefV2,
  materializeIndexedImplementationDocumentV2,
  materializeLegacyMigrationExecutionCompatibilityRecordV2,
  materializeMigrationRunManifestV2,
  materializeMigrationRuntimeCapabilitySnapshot,
  materializeMigrationTargetRefV2,
  materializeSearchCandidateV2,
  materializeSearchRequestV2,
  materializeSourceImplementationBundleV2,
  materializeTargetContextSnapshotV2,
  validateAdaptationRequestV2,
  validateAdaptationResultV2,
  validateMigrationRunManifestV2,
  validateMigrationRuntimeCapabilitySnapshot,
  validateSearchCandidateV2,
  validateSearchRequestV2,
} from './migration-execution-v2';
import {
  createRepositoryModuleCatalogRef,
  materializeMigrationExecutionOverlay,
  materializeModuleMappingProposal,
  materializeModuleMappingReview,
} from './module-mapping';
import { sha256Hex } from './module-plan-utils';

const NOW = '2026-09-02T12:00:00.000Z';

function route(): MigrationRouteDescriptor {
  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'research-x-to-python-translate',
    name: 'Research X to Python',
    version: '2.1.0',
    sourceLanguageId: 'research-lang-x',
    targetLanguageId: 'python',
    strategy: 'translate',
    stages: [
      {
        stage: 'context-collection',
        providerId: 'python-context-adapter',
        providerVersion: '3.0.0',
        capabilities: ['target-context'],
        availability: { status: 'available', reasonCodes: [] },
      },
      {
        stage: 'translation',
        providerId: 'open-language-translator',
        providerVersion: '4.0.0',
        capabilities: ['code-translation'],
        availability: { status: 'available', reasonCodes: [] },
      },
      {
        stage: 'behavior-validation',
        providerId: 'python-behavior-verifier',
        providerVersion: '5.0.0',
        capabilities: ['migration-validation'],
        availability: { status: 'available', reasonCodes: [] },
      },
    ],
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'research-x-python-policy',
      routeId: 'research-x-to-python-translate',
      routeVersion: '2.1.0',
      checks: [{
        id: 'python-behavior',
        label: 'Python behavior parity',
        phase: 'behavior',
        required: true,
        verifierId: 'python-behavior-verifier',
        verifierVersion: '5.0.0',
      }],
      createdAt: NOW,
    },
  };
}

function ir(side: 'source' | 'target'): UnifiedRepositoryIR {
  const source = side === 'source';
  const languageId = source ? 'research-lang-x' : 'python';
  const fileContent = source ? 'source implementation' : 'def target():\n    pass\n';
  const fileId = `${side}-file`;
  const entities = source
    ? [{
        id: 'source-call',
        kind: 'callable' as const,
        name: 'historical_work',
        qualifiedName: 'history.historical_work',
        languageId,
        fileId,
        signature: 'native historical_work',
        attributes: { staticSymbolKind: 'custom-callable' },
      }]
    : [
        {
          id: 'target-module',
          kind: 'module' as const,
          name: 'target_module',
          qualifiedName: 'target_module',
          languageId,
          fileId,
          signature: 'module target_module',
          attributes: { staticSymbolKind: 'module' },
        },
        {
          id: 'target-call',
          kind: 'callable' as const,
          name: 'target',
          qualifiedName: 'target_module.target',
          languageId,
          fileId,
          containerEntityId: 'target-module',
          signature: 'def target()',
          attributes: { staticSymbolKind: 'top-level-function' },
        },
      ];
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-ir`,
    repositoryId: `${side}-repository`,
    profileId: `${side}-profile`,
    repositoryRevision: `${side}-commit-1`,
    repositoryContentHash: (source ? '1' : '2').repeat(64),
    sourceShardIds: [`${side}-shard`],
    capabilities: ['file-inventory', 'symbol-index'],
    files: [{
      id: fileId,
      path: source ? 'src/history.rx' : 'app/target.py',
      contentHash: sha256Hex(fileContent),
      role: 'source',
      languageId,
      projectIds: [],
    }],
    entities,
    apiSurfaces: [],
    dependencies: [],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: [languageId],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    contentHash: (source ? '3' : '4').repeat(64),
    producer: { kind: 'ingestion-host', id: 'fixture-host', version: '1.0.0' },
    createdAt: NOW,
  };
}

function catalog(side: 'source' | 'target', repositoryIr: UnifiedRepositoryIR): RepositoryModuleCatalog {
  const source = side === 'source';
  const entityIds = source ? ['source-call'] : ['target-module', 'target-call'];
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-catalog`,
    repositoryId: repositoryIr.repositoryId,
    sourceIrId: repositoryIr.id,
    sourceIrHash: repositoryIr.contentHash,
    sourceProposalId: `${side}-proposal`,
    sourceProposalHash: (source ? '5' : '6').repeat(64),
    status: 'active',
    modules: [{
      id: `${side}-module`,
      name: `${side} module`,
      kind: 'application-service',
      description: `${side} fixture module`,
      responsibilities: ['Fixture work'],
      businessCapabilities: [],
      fileIds: [`${side}-file`],
      entityIds,
      entryPointEntityIds: [source ? 'source-call' : 'target-call'],
      publicApiEntityIds: [source ? 'source-call' : 'target-call'],
      boundaryRationale: 'Fixture boundary',
      evidenceRefs: [],
    }],
    assignments: [{
      fileId: `${side}-file`,
      moduleIds: [`${side}-module`],
      kind: 'owned',
      rationale: 'Fixture ownership',
      evidenceRefs: [],
    }],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    reviewId: `${side}-review`,
    reviewHash: (source ? '7' : '8').repeat(64),
    contentHash: (source ? '9' : 'a').repeat(64),
    producer: { kind: 'ingestion-host', id: 'fixture-host', version: '1.0.0' },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function executionFixture() {
  const runtime = materializeMigrationRuntimeCapabilitySnapshot({ routes: [route()], createdAt: NOW });
  const routeRef = createMigrationRouteSnapshotRef(runtime, route().id);
  const sourceIr = ir('source');
  const targetIr = ir('target');
  const sourceCatalog = catalog('source', sourceIr);
  const targetCatalog = catalog('target', targetIr);
  const proposal = materializeModuleMappingProposal({
    sourceIr,
    sourceCatalog,
    targetIr,
    targetCatalog,
    objective: 'Move historical behavior into the Python top-level function.',
    mappings: [{
      id: 'mapping-source-target',
      cardinality: 'one-to-one',
      sourceModuleIds: ['source-module'],
      targetModuleIds: ['target-module'],
      sourceEntityIds: ['source-call'],
      targetEntityIds: ['target-call'],
      rationale: 'Approved behavior destination',
      evidenceIds: [],
    }],
    createdAt: NOW,
  });
  const review = materializeModuleMappingReview({
    proposal,
    sourceIr,
    sourceCatalog,
    targetIr,
    targetCatalog,
    decision: 'accept',
    reviewerId: 'reviewer-1',
    decidedAt: NOW,
  });
  const overlay = materializeMigrationExecutionOverlay({
    proposal,
    review,
    sourceIr,
    sourceCatalog,
    targetIr,
    targetCatalog,
    routeId: routeRef.routeId,
    routeVersion: routeRef.routeVersion,
    groups: [{ id: 'execution-group', mappingIds: ['mapping-source-target'], dependsOnGroupIds: [] }],
    createdAt: NOW,
  });
  const currentSourceCatalog = createRepositoryModuleCatalogRef(sourceIr, sourceCatalog);
  const currentTargetCatalog = createRepositoryModuleCatalogRef(targetIr, targetCatalog);
  const validationContext = {
    runtimeCapabilities: runtime,
    currentSourceCatalog,
    currentTargetCatalog,
    mappingProposal: proposal,
    mappingReview: review,
    executionOverlay: overlay,
  };
  const target = materializeMigrationTargetRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    workspaceId: 'python-workspace',
    targetWorkspaceSnapshotId: 'target-workspace-snapshot',
    targetWorkspaceSnapshotHash: 'b'.repeat(64),
    lineage: currentTargetCatalog,
    entity: {
      entityId: 'target-call',
      fileId: 'target-file',
      languageId: 'python',
      kind: 'top-level-function',
      name: 'target',
      qualifiedName: 'target_module.target',
      path: 'app/target.py',
      signature: 'def target()',
      fileContentHash: targetIr.files[0]!.contentHash,
      declarationIdentity: {
        kind: 'declaration',
        contentHash: 'c'.repeat(64),
        schemaVersion: 'python-ast-v1',
        providerId: 'python-context-adapter',
        providerVersion: '3.0.0',
      },
    },
    route: routeRef,
    allowedModificationPaths: ['app/target.py'],
  }, runtime);
  const candidate = materializeImplementationCandidateRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    id: 'implementation-candidate:research-x',
    lineage: currentSourceCatalog,
    entity: {
      entityId: 'source-call',
      fileId: 'source-file',
      languageId: 'research-lang-x',
      kind: 'custom-callable-form',
      name: 'historical_work',
      qualifiedName: 'history.historical_work',
      path: 'src/history.rx',
      signature: 'native historical_work',
    },
    license: 'Internal',
  });
  const sourceContent = 'source implementation';
  const sourceBundle = materializeSourceImplementationBundleV2({
    candidate,
    primaryEntityId: 'source-call',
    files: [{
      fileId: 'source-file',
      path: 'src/history.rx',
      languageId: 'research-lang-x',
      role: 'primary',
      content: sourceContent,
      contentHash: sha256Hex(sourceContent),
    }],
    producer: { providerId: 'source-bundle-adapter', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const indexedDocument = materializeIndexedImplementationDocumentV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    candidate,
    sourceCatalog: currentSourceCatalog,
    moduleId: 'source-module',
    entityId: 'source-call',
    fileId: 'source-file',
    fileContentHash: sourceIr.files[0]!.contentHash,
    sourceBundle: { id: sourceBundle.id, contentHash: sourceBundle.contentHash },
    title: 'Historical research-language implementation',
    summary: 'Implements the required behavior.',
    searchText: 'historical work behavior',
    producer: { providerId: 'index-publisher', providerVersion: '1.0.0' },
    createdAt: NOW,
  });
  const searchRequest = materializeSearchRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    target,
    route: routeRef,
    requirement: 'Implement the target behavior.',
    topK: 5,
    repositoryScopes: ['source-repository'],
    candidateLanguageIds: ['research-lang-x'],
    rerank: true,
    createdAt: NOW,
  }, runtime);
  const searchCandidate = materializeSearchCandidateV2({
    request: searchRequest,
    indexedDocument,
    score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.85 },
    compatibility: ['Approved source catalog'],
    createdAt: NOW,
  }, runtime);
  const declarationContent = 'def target():\n    pass\n';
  const targetContext = materializeTargetContextSnapshotV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    target,
    route: routeRef,
    declarations: [{
      id: 'target-declaration',
      role: 'declaration',
      languageId: 'python',
      entityId: 'target-call',
      fileId: 'target-file',
      path: 'app/target.py',
      content: declarationContent,
      contentHash: sha256Hex(declarationContent),
      provider: { providerId: 'python-context-adapter', providerVersion: '3.0.0' },
      attributes: { nativeKind: 'top-level-function' },
    }],
    containers: [{
      id: 'target-module-container',
      role: 'container',
      languageId: 'python',
      entityId: 'target-module',
      fileId: 'target-file',
      path: 'app/target.py',
      contentHash: 'd'.repeat(64),
      provider: { providerId: 'python-context-adapter', providerVersion: '3.0.0' },
      attributes: { nativeKind: 'module' },
    }],
    imports: [],
    dependencies: [],
    references: [],
    callers: [],
    tests: [],
    buildFacts: [],
    allowedModifications: [{
      path: 'app/target.py',
      operation: 'modify',
      expectedContentHash: targetIr.files[0]!.contentHash,
    }],
    constraints: ['Preserve public behavior'],
    producer: { providerId: 'python-context-adapter', providerVersion: '3.0.0' },
    createdAt: NOW,
  }, runtime);
  const executionLineage = {
    sourceCatalog: currentSourceCatalog,
    targetCatalog: currentTargetCatalog,
    mappingProposalId: proposal.id,
    mappingProposalHash: proposal.contentHash,
    mappingReviewId: review.id,
    mappingReviewHash: review.contentHash,
    executionOverlayId: overlay.id,
    executionOverlayHash: overlay.contentHash,
  };
  const adaptationRequest = materializeAdaptationRequestV2({
    schemaVersion: migrationExecutionV2SchemaVersion,
    route: routeRef,
    executionLineage,
    target,
    candidate,
    sourceBundle,
    targetContext,
    patchSubjectHash: calculatePatchSubjectHashV2(targetContext),
    validationPolicy: runtime.routes[0]!.validationPolicy,
    requirement: 'Implement the target behavior.',
    strategy: 'translate',
    decisionNotes: ['Candidate explicitly selected by reviewer'],
    createdAt: NOW,
  }, validationContext);
  const files = [{
    path: 'app/target.py',
    status: 'modified' as const,
    expectedOriginalSha256: targetIr.files[0]!.contentHash,
    additions: 1,
    deletions: 1,
    hunks: [{
      header: '@@ target @@',
      lines: [
        { type: 'remove' as const, content: '    pass' },
        { type: 'add' as const, content: '    return historical_behavior()' },
      ],
    }],
  }];
  const patchHash = calculatePatchHashV2(files);
  const validation: ValidationRecord[] = [{
    id: 'validation-python-behavior',
    label: 'Python behavior parity',
    status: 'pass',
    required: true,
    policyCheckId: 'python-behavior',
    routeId: routeRef.routeId,
    routeVersion: routeRef.routeVersion,
    phase: 'behavior',
    verifierId: 'python-behavior-verifier',
    verifierVersion: '5.0.0',
    subjectHash: patchHash,
    summary: 'Behavior evidence passed.',
  }];
  const adaptationResult = materializeAdaptationResultV2({
    request: adaptationRequest,
    files,
    validation,
    producer: { providerId: 'open-language-translator', providerVersion: '4.0.0' },
    createdAt: NOW,
  }, validationContext);
  const providers = runtime.routes[0]!.stages.map((stage) => ({
    stage: stage.stage,
    providerId: stage.providerId,
    providerVersion: stage.providerVersion,
    status: 'completed' as const,
    startedAt: NOW,
    completedAt: NOW,
    artifactRefs: [],
  }));
  const validators = [{
    policyCheckId: 'python-behavior',
    validationRecordId: 'validation-python-behavior',
    subjectHash: adaptationResult.patchHash,
    status: 'pass' as const,
    providerId: 'python-behavior-verifier',
    providerVersion: '5.0.0',
    artifactRefs: [],
  }];
  return {
    runtime,
    routeRef,
    sourceIr,
    targetIr,
    proposal,
    review,
    overlay,
    currentSourceCatalog,
    currentTargetCatalog,
    validationContext,
    target,
    candidate,
    sourceBundle,
    indexedDocument,
    searchRequest,
    searchCandidate,
    targetContext,
    adaptationRequest,
    adaptationResult,
    providers,
    validators,
  };
}

describe('V2 migration execution contracts', () => {
  it('materializes an empty runtime capability snapshot as explicit no-capability state', () => {
    const snapshot = materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt: NOW });
    expect(snapshot.routes).toEqual([]);
    expect(validateMigrationRuntimeCapabilitySnapshot(snapshot)).toBe(snapshot);
  });

  it('carries an unknown source language and Python top-level target through exact V2 lineage', () => {
    const fixture = executionFixture();
    expect(fixture.routeRef).toMatchObject({
      sourceLanguageId: 'research-lang-x',
      targetLanguageId: 'python',
    });
    expect(fixture.target.entity.kind).toBe('top-level-function');
    expect(fixture.targetContext.containers[0]?.attributes).toEqual({ nativeKind: 'module' });
    expect(fixture.indexedDocument.sourceBundle).toEqual({
      id: fixture.sourceBundle.id,
      contentHash: fixture.sourceBundle.contentHash,
    });
    expect(validateSearchRequestV2(fixture.searchRequest, fixture.runtime)).toBe(fixture.searchRequest);
    expect(validateSearchCandidateV2(
      fixture.searchCandidate,
      fixture.searchRequest,
      fixture.indexedDocument,
      fixture.runtime,
    )).toBe(fixture.searchCandidate);
    expect(validateAdaptationRequestV2(fixture.adaptationRequest, fixture.validationContext))
      .toBe(fixture.adaptationRequest);
    expect(validateAdaptationResultV2(
      fixture.adaptationResult,
      fixture.adaptationRequest,
      fixture.validationContext,
    )).toBe(fixture.adaptationResult);
  });

  it('rejects route hash mismatch and a tampered runtime route hash', () => {
    const fixture = executionFixture();
    expect(() => materializeMigrationTargetRefV2({
      ...fixture.target,
      route: { ...fixture.routeRef, routeContentHash: 'f'.repeat(64) },
    }, fixture.runtime)).toThrow(/route reference hash or lineage/);
    const tamperedRuntime = {
      ...fixture.runtime,
      routes: fixture.runtime.routes.map((item) => ({ ...item, contentHash: 'e'.repeat(64) })),
    };
    expect(() => validateMigrationRuntimeCapabilitySnapshot(tamperedRuntime))
      .toThrow(/hash or canonical structure/);
  });

  it('fails closed when current catalog lineage changes', () => {
    const fixture = executionFixture();
    const staleContext = {
      ...fixture.validationContext,
      currentSourceCatalog: {
        ...fixture.currentSourceCatalog,
        moduleCatalogHash: 'f'.repeat(64),
      },
    };
    expect(() => materializeAdaptationRequestV2({
      ...fixture.adaptationRequest,
    }, staleContext)).toThrow(/catalog lineage is stale or mismatched/);
  });

  it('rejects indexed records without reviewed lineage or a source bundle', () => {
    const fixture = executionFixture();
    expect(() => materializeIndexedImplementationDocumentV2({
      ...fixture.indexedDocument,
      sourceBundle: undefined,
    } as never)).toThrow(/requires an authoritative source bundle/);

    const unreviewedCandidate = materializeImplementationCandidateRefV2({
      ...fixture.candidate,
      lineage: {
        repositoryId: fixture.currentSourceCatalog.repositoryId,
        repositoryContentHash: fixture.currentSourceCatalog.repositoryContentHash,
        unifiedRepositoryIrId: fixture.currentSourceCatalog.unifiedRepositoryIrId,
        unifiedRepositoryIrHash: fixture.currentSourceCatalog.unifiedRepositoryIrHash,
      },
    });
    expect(() => materializeIndexedImplementationDocumentV2({
      ...fixture.indexedDocument,
      candidate: unreviewedCandidate,
    })).toThrow(/lacks exact reviewed catalog lineage/);
  });

  it('rejects missing required verifier evidence and completed runs without checkpoints', () => {
    const fixture = executionFixture();
    expect(() => materializeAdaptationResultV2({
      request: fixture.adaptationRequest,
      files: fixture.adaptationResult.files,
      validation: [],
      producer: { providerId: 'open-language-translator', providerVersion: '4.0.0' },
      createdAt: NOW,
    }, fixture.validationContext)).toThrow(/lacks required verifier records/);

    expect(() => materializeMigrationRunManifestV2({
      status: 'completed',
      request: fixture.adaptationRequest,
      result: fixture.adaptationResult,
      providers: fixture.providers,
      validators: fixture.validators,
      artifactPaths: { manifest: '.forexplore/run-v2.json' },
      createdAt: NOW,
      updatedAt: NOW,
    }, fixture.validationContext)).toThrow(/requires checkpoint and recovery evidence/);
  });

  it('materializes and validates a complete run manifest with checkpoint/recovery', () => {
    const fixture = executionFixture();
    const manifest = materializeMigrationRunManifestV2({
      status: 'completed',
      request: fixture.adaptationRequest,
      result: fixture.adaptationResult,
      providers: fixture.providers,
      validators: fixture.validators,
      checkpoint: {
        id: 'checkpoint-1',
        contentHash: '1'.repeat(64),
        recoverable: true,
        createdAt: NOW,
      },
      recovery: {
        status: 'available',
        checkpointId: 'checkpoint-1',
        provider: { providerId: 'workspace-recovery', providerVersion: '1.0.0' },
        artifactRefs: [],
        updatedAt: NOW,
      },
      artifactPaths: { manifest: '.forexplore/run-v2.json' },
      createdAt: NOW,
      updatedAt: NOW,
    }, fixture.validationContext);
    expect(validateMigrationRunManifestV2(
      manifest,
      fixture.adaptationRequest,
      fixture.adaptationResult,
      fixture.validationContext,
    )).toBe(manifest);
  });

  it('rejects V1-shaped artifacts and keeps the legacy bridge hash-only', () => {
    const fixture = executionFixture();
    expect(() => materializeSearchRequestV2({
      target: { language: 'Python', kind: 'function' },
      requirement: 'legacy',
      topK: 1,
    } as never, fixture.runtime)).toThrow(/legacy search requests are rejected/);

    const compatibility = materializeLegacyMigrationExecutionCompatibilityRecordV2({
      legacyKind: 'adaptation-request',
      legacyArtifactHash: '2'.repeat(64),
      v2Artifact: {
        id: fixture.adaptationRequest.id,
        contentHash: fixture.adaptationRequest.contentHash,
      },
      bridgeProducer: { kind: 'import', id: 'legacy-importer', version: '1.0.0' },
      warnings: ['legacy facts were not imported into V2 lineage'],
      createdAt: NOW,
    });
    expect(compatibility).not.toHaveProperty('legacyArtifact');
    expect(compatibility.v2Artifact.id).toBe(fixture.adaptationRequest.id);
  });
});
