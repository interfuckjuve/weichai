import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import type { MigrationBehaviorVerificationInputV2 } from "./adaptation-adapter-v2";
import {
  resolveVerificationPolicy,
  type VerificationAssessment,
  type VerificationInput,
} from "@forexplore/translation-verifier";
import {
  migrationExecutionV2SchemaVersion,
  migrationReferenceSchemaVersion,
  repositoryIngestionSchemaVersion,
  type MigrationRuntimeCapabilitySnapshot,
  type RepositoryModuleCatalog,
  type UnifiedRepositoryIR,
} from "@forexplore/contracts";
import {
  calculatePatchSubjectHashV2,
  createMigrationRouteSnapshotRef,
  createRepositoryModuleCatalogRef,
  materializeAdaptationRequestV2,
  materializeImplementationCandidateRefV2,
  materializeMigrationExecutionOverlay,
  materializeMigrationTargetRefV2,
  materializeModuleMappingProposal,
  materializeModuleMappingReview,
  materializeSourceImplementationBundleV2,
  materializeTargetContextSnapshotV2,
  sha256Hex,
} from "@forexplore/workflow-core";
import {
  createAdaptationRuntimeCapabilitySnapshot,
  routeByExactPair,
} from "./runtime-capability-snapshot";
import type { MigrationExecutionV2ServerArtifacts } from "./http-server";

export function fixtureVerificationInput(
  input: MigrationBehaviorVerificationInputV2,
): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: input.request,
    // SAFETY: these typed artifacts contain only JSON fields; the result factory validates the input.
    analysisReport: input.analysis as unknown as RepositoryIngestionJsonValue,
    // SAFETY: the plan has only typed JSON fields and is validated by the result factory.
    migrationPlan: input.plan as unknown as RepositoryIngestionJsonValue,
    translation: {
      round: input.round,
      generatedContent: input.translation.generatedContent,
      files: input.files,
      patchHash: input.patchHash,
    },
  };
}

export function fixtureVerificationAssessment(
  input: Pick<VerificationInput, "verificationPolicy">,
  status: "pass" | "fail" | "unverified" = "pass",
): VerificationAssessment {
  const { testBasis: _basis, ...policy } = resolveVerificationPolicy(input);
  return {
    ...policy,
    executionStatus: status === "unverified" ? "failed" : "completed",
    sourceAssessment:
      policy.mode === "target_only"
        ? "not_checked"
        : status === "unverified"
          ? "inconclusive"
          : "no_bug_observed",
    targetAssessment:
      status === "fail"
        ? "bug_found"
        : status === "pass"
          ? "no_bug_observed"
          : "inconclusive",
    problems:
      status === "unverified"
        ? [
            {
              code: "insufficient_test_basis",
              message: "Fixture evidence unavailable.",
            },
          ]
        : [],
  };
}

export const adaptationV2TestNow = "2026-09-02T12:00:00.000Z";
export const adaptationV2SourceContent = [
  "export function normalize(value: string): string {",
  "  const trimmed = value.trim();",
  "  return trimmed.toUpperCase();",
  "}",
  "",
  "export function untouched(value: string): string {",
  "  return value;",
  "}",
  "",
].join("\n");
export const adaptationV2TargetContent = [
  "def normalize(value: str) -> str:",
  "    raise NotImplementedError()",
  "",
  "def keep(value: str) -> str:",
  "    return value",
  "",
].join("\n");
export const adaptationV2GeneratedContent = [
  "def normalize(value: str) -> str:",
  "    trimmed = value.strip()",
  "    return trimmed.upper()",
].join("\n");

function repositoryIr(side: "source" | "target"): UnifiedRepositoryIR {
  const source = side === "source";
  const languageId = source ? "typescript" : "python";
  const content = source
    ? adaptationV2SourceContent
    : adaptationV2TargetContent;
  const fileId = `${side}-file`;
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-ir-v2-fixture`,
    repositoryId: `${side}-repository-v2-fixture`,
    profileId: `${side}-profile-v2-fixture`,
    repositoryRevision: `${side}-commit-v2-fixture`,
    repositoryContentHash: (source ? "1" : "2").repeat(64),
    sourceShardIds: [`${side}-shard-v2-fixture`],
    capabilities: ["file-inventory", "symbol-index"],
    files: [
      {
        id: fileId,
        path: source ? "src/normalize.ts" : "app/normalize.py",
        contentHash: sha256Hex(content),
        role: "source",
        languageId,
        projectIds: [],
      },
    ],
    entities: source
      ? [
          {
            id: "source-call",
            kind: "callable",
            name: "normalize",
            qualifiedName: "normalize.normalize",
            languageId,
            fileId,
            signature: "normalize(value: string): string",
            attributes: { staticSymbolKind: "top-level-function" },
          },
        ]
      : [
          {
            id: "target-module-entity",
            kind: "module",
            name: "normalize",
            qualifiedName: "normalize",
            languageId,
            fileId,
            signature: "module normalize",
            attributes: { staticSymbolKind: "module" },
          },
          {
            id: "target-call",
            kind: "callable",
            name: "normalize",
            qualifiedName: "normalize.normalize",
            languageId,
            fileId,
            containerEntityId: "target-module-entity",
            signature: "def normalize(value: str) -> str",
            attributes: { staticSymbolKind: "top-level-function" },
          },
        ],
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
    contentHash: (source ? "3" : "4").repeat(64),
    producer: {
      kind: "ingestion-host",
      id: "v2-fixture-host",
      version: "1.0.0",
    },
    createdAt: adaptationV2TestNow,
  };
}

function moduleCatalog(
  side: "source" | "target",
  repository: UnifiedRepositoryIR,
): RepositoryModuleCatalog {
  const source = side === "source";
  const entityIds = source
    ? ["source-call"]
    : ["target-module-entity", "target-call"];
  return {
    schemaVersion: repositoryIngestionSchemaVersion,
    id: `${side}-catalog-v2-fixture`,
    repositoryId: repository.repositoryId,
    sourceIrId: repository.id,
    sourceIrHash: repository.contentHash,
    sourceProposalId: `${side}-proposal-v2-fixture`,
    sourceProposalHash: (source ? "5" : "6").repeat(64),
    status: "active",
    modules: [
      {
        id: `${side}-module`,
        name: `${side} normalize module`,
        kind: "application-service",
        description: `${side} normalize fixture module`,
        responsibilities: ["Normalize text"],
        businessCapabilities: [],
        fileIds: [`${side}-file`],
        entityIds,
        entryPointEntityIds: [source ? "source-call" : "target-call"],
        publicApiEntityIds: [source ? "source-call" : "target-call"],
        boundaryRationale: "Fixture module boundary",
        evidenceRefs: [],
      },
    ],
    assignments: [
      {
        fileId: `${side}-file`,
        moduleIds: [`${side}-module`],
        kind: "owned",
        rationale: "Fixture ownership",
        evidenceRefs: [],
      },
    ],
    dependencies: [],
    unassignedFileIds: [],
    overlappingFileIds: [],
    reviewId: `${side}-review-v2-fixture`,
    reviewHash: (source ? "7" : "8").repeat(64),
    contentHash: (source ? "9" : "a").repeat(64),
    producer: {
      kind: "ingestion-host",
      id: "v2-fixture-host",
      version: "1.0.0",
    },
    createdAt: adaptationV2TestNow,
    updatedAt: adaptationV2TestNow,
  };
}

export interface AdaptationV2TestFixtureOptions {
  serviceRuntime?: MigrationRuntimeCapabilitySnapshot;
  executionRuntime?: MigrationRuntimeCapabilitySnapshot;
}

export function createAdaptationV2TestFixture(
  options: AdaptationV2TestFixtureOptions = {},
) {
  const serviceRuntime =
    options.serviceRuntime ??
    createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: "disabled",
      verifierExecution: "local-process",
      workspaceMutationExecution: "disabled",
    });
  const runtime =
    options.executionRuntime ??
    createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: "trusted-host",
      verifierExecution: "local-process",
      workspaceMutationExecution: "trusted-host",
    });
  const route = routeByExactPair(runtime, "typescript", "python")!;
  const routeRef = createMigrationRouteSnapshotRef(runtime, route.id);
  const sourceIr = repositoryIr("source");
  const targetIr = repositoryIr("target");
  const sourceCatalog = moduleCatalog("source", sourceIr);
  const targetCatalog = moduleCatalog("target", targetIr);
  const proposal = materializeModuleMappingProposal({
    sourceIr,
    sourceCatalog,
    targetIr,
    targetCatalog,
    objective: "Move the reviewed TypeScript normalize behavior to Python.",
    mappings: [
      {
        id: "mapping-normalize",
        cardinality: "one-to-one",
        sourceModuleIds: ["source-module"],
        targetModuleIds: ["target-module"],
        sourceEntityIds: ["source-call"],
        targetEntityIds: ["target-call"],
        rationale: "Reviewed top-level function destination",
        evidenceIds: [],
      },
    ],
    createdAt: adaptationV2TestNow,
  });
  const review = materializeModuleMappingReview({
    proposal,
    sourceIr,
    sourceCatalog,
    targetIr,
    targetCatalog,
    decision: "accept",
    reviewerId: "v2-test-reviewer",
    decidedAt: adaptationV2TestNow,
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
    groups: [
      {
        id: "execution-normalize",
        mappingIds: ["mapping-normalize"],
        dependsOnGroupIds: [],
      },
    ],
    createdAt: adaptationV2TestNow,
  });
  const currentSourceCatalog = createRepositoryModuleCatalogRef(
    sourceIr,
    sourceCatalog,
  );
  const currentTargetCatalog = createRepositoryModuleCatalogRef(
    targetIr,
    targetCatalog,
  );
  const validationContext = {
    runtimeCapabilities: runtime,
    currentSourceCatalog,
    currentTargetCatalog,
    mappingProposal: proposal,
    mappingReview: review,
    executionOverlay: overlay,
  };
  const declarationContent = [
    "def normalize(value: str) -> str:",
    "    raise NotImplementedError()",
  ].join("\n");
  const target = materializeMigrationTargetRefV2(
    {
      schemaVersion: migrationReferenceSchemaVersion,
      workspaceId: "python-workspace-v2-fixture",
      targetWorkspaceSnapshotId: "target-snapshot-v2-fixture",
      targetWorkspaceSnapshotHash: "b".repeat(64),
      lineage: currentTargetCatalog,
      entity: {
        entityId: "target-call",
        fileId: "target-file",
        languageId: "python",
        kind: "top-level-function",
        name: "normalize",
        qualifiedName: "normalize.normalize",
        path: "app/normalize.py",
        signature: "def normalize(value: str) -> str",
        fileContentHash: sha256Hex(adaptationV2TargetContent),
        declarationIdentity: {
          kind: "declaration",
          contentHash: sha256Hex(declarationContent),
          schemaVersion: "python-lexical-v1",
          providerId: "forexplore.target-engineering.python.lexical",
          providerVersion: "1.0.0",
        },
      },
      route: routeRef,
      allowedModificationPaths: ["app/normalize.py"],
    },
    runtime,
  );
  const candidate = materializeImplementationCandidateRefV2({
    schemaVersion: migrationReferenceSchemaVersion,
    id: "implementation-candidate:typescript-normalize",
    lineage: currentSourceCatalog,
    entity: {
      entityId: "source-call",
      fileId: "source-file",
      languageId: "typescript",
      kind: "top-level-function",
      name: "normalize",
      qualifiedName: "normalize.normalize",
      path: "src/normalize.ts",
      signature: "normalize(value: string): string",
    },
    license: "Internal",
  });
  const sourceBundle = materializeSourceImplementationBundleV2({
    candidate,
    primaryEntityId: "source-call",
    files: [
      {
        fileId: "source-file",
        path: "src/normalize.ts",
        languageId: "typescript",
        role: "primary",
        content: adaptationV2SourceContent,
        contentHash: sha256Hex(adaptationV2SourceContent),
      },
    ],
    producer: {
      providerId: "forexplore.source-bundle.fixture",
      providerVersion: "1.0.0",
    },
    createdAt: adaptationV2TestNow,
  });
  const targetProvider = {
    providerId: "forexplore.target-engineering.python.lexical",
    providerVersion: "1.0.0",
  };
  const targetContext = materializeTargetContextSnapshotV2(
    {
      schemaVersion: migrationExecutionV2SchemaVersion,
      target,
      route: routeRef,
      sourceFiles: [
        {
          id: "target-normalize-source-file",
          role: "source-file",
          languageId: "python",
          entityId: "target-module-entity",
          fileId: "target-file",
          path: "app/normalize.py",
          content: adaptationV2TargetContent,
          contentHash: sha256Hex(adaptationV2TargetContent),
          provider: targetProvider,
          attributes: { nativeKind: "module", wholeFile: true },
        },
      ],
      declarations: [
        {
          id: "target-normalize-declaration",
          role: "declaration",
          languageId: "python",
          entityId: "target-call",
          fileId: "target-file",
          path: "app/normalize.py",
          content: declarationContent,
          contentHash: sha256Hex(declarationContent),
          provider: targetProvider,
          attributes: { nativeKind: "top-level-function", startLine: 1 },
        },
      ],
      containers: [
        {
          id: "target-normalize-full-file",
          role: "container",
          languageId: "python",
          entityId: "target-module-entity",
          fileId: "target-file",
          path: "app/normalize.py",
          content: adaptationV2TargetContent,
          contentHash: sha256Hex(adaptationV2TargetContent),
          provider: targetProvider,
          attributes: { nativeKind: "module", wholeFile: true },
        },
      ],
      imports: [],
      dependencies: [],
      references: [],
      callers: [],
      tests: [],
      buildFacts: [],
      allowedModifications: [
        {
          path: "app/normalize.py",
          operation: "modify",
          expectedContentHash: sha256Hex(adaptationV2TargetContent),
        },
      ],
      constraints: ["Keep the sibling top-level function unchanged."],
      producer: targetProvider,
      createdAt: adaptationV2TestNow,
    },
    runtime,
  );
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
  const request = materializeAdaptationRequestV2(
    {
      schemaVersion: migrationExecutionV2SchemaVersion,
      route: routeRef,
      executionLineage,
      target,
      candidate,
      sourceBundle,
      targetContext,
      patchSubjectHash: calculatePatchSubjectHashV2(targetContext),
      validationPolicy: route.validationPolicy,
      requirement:
        "Normalize text using the approved historical implementation.",
      strategy: "translate",
      decisionNotes: ["Candidate explicitly selected by the reviewer."],
      createdAt: adaptationV2TestNow,
    },
    validationContext,
  );
  const serverArtifacts: MigrationExecutionV2ServerArtifacts = {
    runtimeCapabilities: runtime,
    currentSourceCatalog,
    currentTargetCatalog,
    mappingProposal: proposal,
    mappingReview: review,
    executionOverlay: overlay,
    target,
    candidate,
    sourceBundle,
    targetContext,
  };
  return {
    serviceRuntime,
    runtime,
    route,
    routeRef,
    validationContext,
    request,
    serverArtifacts,
    targetContext,
    sourceBundle,
  };
}
