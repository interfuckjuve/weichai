import {
  migrationRouteSchemaVersion,
  normalizeLanguageId,
  validationPolicySchemaVersion,
  type MaterializedMigrationRouteDescriptor,
  type MigrationRouteAvailability,
  type MigrationRouteDescriptor,
  type MigrationRouteStageCapability,
  type MigrationRuntimeCapabilitySnapshot,
} from "@forexplore/contracts";
import {
  materializeMigrationRuntimeCapabilitySnapshot,
  validateMigrationRuntimeCapabilitySnapshot,
} from "@forexplore/workflow-core";
import {
  listCompilerRouteCapabilities,
  type CompilerRouteCapability,
} from "./compiler";
import {
  createDefaultTargetEngineeringAdapterRegistry,
  type TargetEngineeringAdapterRegistry,
  type TargetEngineeringCapabilityDescriptor,
} from "./context-collector";
import {
  resolveTranslationVerifierRoute,
  type TranslationVerifierExecution,
} from "./verification-adapter";

export type WorkspaceMutationExecution = "disabled" | "trusted-host";
export type RepositoryAnalysisExecution = "disabled" | "trusted-host";

export interface AdaptationRuntimeCapabilitySnapshotOptions {
  createdAt: string;
  analysisExecution: RepositoryAnalysisExecution;
  verifierExecution: TranslationVerifierExecution;
  workspaceMutationExecution: WorkspaceMutationExecution;
  targetEngineeringRegistry?: TargetEngineeringAdapterRegistry;
}

interface ExactTranslationRoute {
  id: string;
  name: string;
  sourceLanguageId: "java" | "python" | "typescript";
  sourceLanguage: "Java" | "Python" | "TypeScript";
  targetLanguageId: "csharp" | "python" | "typescript";
  targetLanguage: "C#" | "Python" | "TypeScript";
}

/**
 * Explicit route inventory. Adding a language adapter never creates migration
 * pairs implicitly; every source x target x strategy tuple remains reviewed.
 */
const EXACT_TRANSLATION_ROUTES: readonly ExactTranslationRoute[] = [
  {
    id: "forexplore.translate.java-to-csharp",
    name: "Java to C# translation (historical regression route)",
    sourceLanguageId: "java",
    sourceLanguage: "Java",
    targetLanguageId: "csharp",
    targetLanguage: "C#",
  },
  {
    id: "forexplore.translate.typescript-to-python",
    name: "TypeScript to Python translation",
    sourceLanguageId: "typescript",
    sourceLanguage: "TypeScript",
    targetLanguageId: "python",
    targetLanguage: "Python",
  },
  {
    id: "forexplore.translate.python-to-typescript",
    name: "Python to TypeScript translation",
    sourceLanguageId: "python",
    sourceLanguage: "Python",
    targetLanguageId: "typescript",
    targetLanguage: "TypeScript",
  },
];

export function createAdaptationRuntimeCapabilitySnapshot(
  options: AdaptationRuntimeCapabilitySnapshotOptions,
): MigrationRuntimeCapabilitySnapshot {
  const targetRegistry =
    options.targetEngineeringRegistry ?? createDefaultTargetEngineeringAdapterRegistry();
  const compilerByLanguageId = new Map(
    listCompilerRouteCapabilities().map((capability) => [
      normalizeLanguageId(capability.language),
      capability,
    ]),
  );
  const routes = EXACT_TRANSLATION_ROUTES.map((route) => buildRoute(
    route,
    targetRegistry.adapterFor(route.targetLanguageId)?.descriptor,
    compilerByLanguageId.get(route.targetLanguageId),
    options,
  ));
  return materializeMigrationRuntimeCapabilitySnapshot({
    routes,
    createdAt: options.createdAt,
  });
}

function buildRoute(
  route: ExactTranslationRoute,
  targetEngineering: TargetEngineeringCapabilityDescriptor | undefined,
  compiler: CompilerRouteCapability | undefined,
  options: AdaptationRuntimeCapabilitySnapshotOptions,
): MigrationRouteDescriptor {
  const analysisAvailability = options.analysisExecution === "trusted-host"
    ? available()
    : unavailable(
        "external-host-required",
        "Repository analysis is owned by an external trusted host, not the adaptation HTTP runtime.",
      );
  const contextAvailability = targetEngineering?.context.status === "supported"
    ? available()
    : unavailable(
        "target-context-capability-unavailable",
        `No target context collector is available for ${route.targetLanguageId}.`,
      );
  const patchAvailability = targetEngineering?.patchLocator.status === "supported"
    ? available()
    : unavailable(
        "target-patch-locator-capability-unavailable",
        `No fail-closed patch locator is available for ${route.targetLanguageId}.`,
      );
  const compileAvailability = compiler
    ? available()
    : unavailable(
        "target-compiler-capability-unavailable",
        `No compiler route is available for ${route.targetLanguageId}.`,
      );
  const verifierRoute = resolveTranslationVerifierRoute(
    route.sourceLanguage,
    route.targetLanguage,
  );
  const behaviorAvailability = !verifierRoute
    ? unavailable(
        "behavior-verifier-route-unavailable",
        `No differential verifier route is registered for ${route.sourceLanguageId} to ${route.targetLanguageId}.`,
      )
    : options.verifierExecution !== "trusted-isolated"
      ? unavailable(
          "behavior-verifier-execution-disabled",
          "Differential execution is disabled because no externally isolated executor is configured.",
        )
      : available();
  const applyAvailability = options.workspaceMutationExecution === "trusted-host"
    ? available()
    : unavailable(
        "http-workspace-apply-disabled",
        "The adaptation HTTP runtime is not an approval authority and cannot apply patches.",
      );
  const rollbackAvailability = options.workspaceMutationExecution === "trusted-host"
    ? available()
    : unavailable(
        "http-workspace-rollback-disabled",
        "The adaptation HTTP runtime does not own a workspace checkpoint to roll back.",
      );

  const targetProvider = targetEngineering ?? unavailableTargetProvider(route.targetLanguageId);
  const compilerProviderId = compiler?.providerId ?? `forexplore.compiler.${route.targetLanguageId}.unavailable`;
  const compilerProviderVersion = compiler?.version ?? "0.0.0";
  const stages: MigrationRouteStageCapability[] = [
    stage(
      "source-analysis",
      "forexplore.external-host.repository-analysis",
      "1.0.0",
      [],
      analysisAvailability,
    ),
    stage(
      "target-analysis",
      "forexplore.external-host.repository-analysis",
      "1.0.0",
      [],
      analysisAvailability,
    ),
    stage(
      "context-collection",
      targetProvider.id,
      targetProvider.version,
      [],
      contextAvailability,
    ),
    stage(
      "behavior-extraction",
      "forexplore.analyzer.deepseek",
      "1.0.0",
      ["behavior-extraction"],
      available(),
    ),
    stage(
      "migration-planning",
      "forexplore.analyzer.deepseek",
      "1.0.0",
      ["migration-planning"],
      available(),
    ),
    stage(
      "translation",
      "forexplore.translator.deepseek",
      "1.0.0",
      ["code-translation"],
      available(),
    ),
    stage(
      "patch-generation",
      targetProvider.id,
      targetProvider.version,
      ["patch-generation"],
      patchAvailability,
    ),
    stage(
      "compile-validation",
      compilerProviderId,
      compilerProviderVersion,
      ["migration-validation"],
      compileAvailability,
    ),
    stage(
      "behavior-validation",
      "forexplore.translation-verifier.differential",
      "1.0.0",
      ["migration-validation"],
      behaviorAvailability,
    ),
    stage(
      "workspace-apply",
      "forexplore.backfill.trusted-host",
      "1.0.0",
      ["workspace-apply"],
      applyAvailability,
    ),
    stage(
      "workspace-rollback",
      "forexplore.backfill.trusted-host",
      "1.0.0",
      ["workspace-rollback"],
      rollbackAvailability,
    ),
  ];
  const routeAvailability = aggregateRouteAvailability(stages);

  return {
    schemaVersion: migrationRouteSchemaVersion,
    id: route.id,
    name: route.name,
    version: "2.0.0",
    sourceLanguageId: route.sourceLanguageId,
    targetLanguageId: route.targetLanguageId,
    strategy: "translate",
    stages,
    availability: routeAvailability,
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: `${route.id}.validation-policy`,
      routeId: route.id,
      routeVersion: "2.0.0",
      checks: [
        {
          id: "behavior-differential",
          label: "Independent differential behavior validation",
          phase: "behavior",
          required: true,
          verifierId: "forexplore.translation-verifier.differential",
          verifierVersion: "1.0.0",
          reason: "Compilation alone does not establish migration behavior.",
        },
        {
          id: "patch-boundary",
          label: "Target adapter patch-boundary validation",
          phase: "static-analysis",
          required: true,
          verifierId: targetProvider.id,
          verifierVersion: targetProvider.version,
          reason: "Patch boundaries must be isolated by the registered target-language adapter.",
        },
        {
          id: "target-compile",
          label: `${route.targetLanguage} target compilation`,
          phase: compiler?.integrated.level === "syntax" ? "syntax" : "compile",
          required: true,
          verifierId: compilerProviderId,
          verifierVersion: compilerProviderVersion,
          reason: compiler?.quality.limitations.join(" ") ?? "No compiler route is available.",
        },
      ],
      createdAt: options.createdAt,
    },
  };
}

function stage(
  stageName: MigrationRouteStageCapability["stage"],
  providerId: string,
  providerVersion: string,
  capabilities: MigrationRouteStageCapability["capabilities"],
  availability: MigrationRouteAvailability,
): MigrationRouteStageCapability {
  return {
    stage: stageName,
    providerId,
    providerVersion,
    capabilities,
    availability,
  };
}

function aggregateRouteAvailability(
  stages: readonly MigrationRouteStageCapability[],
): MigrationRouteAvailability {
  const unavailableStages = stages.filter((stage) => stage.availability.status === "unavailable");
  if (unavailableStages.length > 0) {
    return unavailableStages.reduce<MigrationRouteAvailability>(
      (result, stageCapability) => ({
        status: "unavailable",
        reasonCodes: [
          ...result.reasonCodes,
          ...stageCapability.availability.reasonCodes.map(
            (reason) => `${stageCapability.stage}:${reason}`,
          ),
        ],
        summary: "One or more required runtime stages are unavailable.",
      }),
      {
        status: "unavailable",
        reasonCodes: [],
        summary: "One or more required runtime stages are unavailable.",
      },
    );
  }
  const degradedStages = stages.filter((stage) => stage.availability.status === "degraded");
  if (degradedStages.length > 0) {
    return {
      status: "degraded",
      reasonCodes: degradedStages.flatMap((stageCapability) =>
        stageCapability.availability.reasonCodes.map(
          (reason) => `${stageCapability.stage}:${reason}`,
        )),
      summary: "All required stages are executable, with declared limitations.",
    };
  }
  return available();
}

function available(): MigrationRouteAvailability {
  return { status: "available", reasonCodes: [] };
}

function unavailable(reason: string, summary: string): MigrationRouteAvailability {
  return { status: "unavailable", reasonCodes: [reason], summary };
}

function unavailableTargetProvider(languageId: string): TargetEngineeringCapabilityDescriptor {
  return {
    id: `forexplore.target-engineering.${languageId}.unavailable`,
    version: "0.0.0",
    languageId,
    context: {
      status: "unsupported",
      targetKinds: [],
      ownerKinds: [],
      relatedFileExtensions: [],
    },
    patchLocator: { status: "unsupported", targetKinds: [] },
    quality: {
      level: "unavailable",
      provesBehavioralCorrectness: false,
      failClosed: true,
      limitations: ["No target engineering adapter is registered."],
    },
  };
}

export function routeByExactPair(
  snapshot: MigrationRuntimeCapabilitySnapshot,
  sourceLanguageId: string,
  targetLanguageId: string,
): MaterializedMigrationRouteDescriptor | undefined {
  validateMigrationRuntimeCapabilitySnapshot(snapshot);
  const source = normalizeLanguageId(sourceLanguageId);
  const target = normalizeLanguageId(targetLanguageId);
  return snapshot.routes.find((route) =>
    route.sourceLanguageId === source &&
    route.targetLanguageId === target &&
    route.strategy === "translate");
}
