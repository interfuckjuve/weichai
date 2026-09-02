import {
  migrationRouteSchemaVersion,
  normalizeLanguageId,
  validationPolicySchemaVersion,
  type Language,
  type LanguageId,
  type MaterializedMigrationRouteDescriptor,
  type MigrationRouteAvailability,
  type MigrationRouteDescriptor,
  type MigrationRouteStageCapability,
  type MigrationRouteStage,
  type MigrationRuntimeCapabilitySnapshot,
} from "@forexplore/contracts";
import {
  materializeMigrationRuntimeCapabilitySnapshot,
  validateMigrationRuntimeCapabilitySnapshot,
} from "@forexplore/workflow-core";
import {
  createDefaultCompilerRouteRegistry,
  listCompilerRouteCapabilities,
  type CompilerRouteRegistry,
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

export const adaptationServiceOwnedRouteStages = [
  "context-collection",
  "behavior-extraction",
  "migration-planning",
  "translation",
  "patch-generation",
  "compile-validation",
  "behavior-validation",
] as const satisfies readonly MigrationRouteStage[];

export const hostOwnedRouteStages = [
  "source-analysis",
  "target-analysis",
  "workspace-apply",
  "workspace-rollback",
] as const satisfies readonly MigrationRouteStage[];

const adaptationServiceOwnedStageSet = new Set<MigrationRouteStage>(
  adaptationServiceOwnedRouteStages,
);

export interface AdaptationRuntimeCapabilitySnapshotOptions {
  createdAt: string;
  analysisExecution: RepositoryAnalysisExecution;
  verifierExecution: TranslationVerifierExecution;
  workspaceMutationExecution: WorkspaceMutationExecution;
  targetEngineeringRegistry?: TargetEngineeringAdapterRegistry;
  compilerRegistry?: CompilerRouteRegistry;
  /**
   * Complete reviewed exact-route inventory; defaults to the built-in three.
   * Spread defaultExactTranslationRouteRegistrations() to append, or supply a
   * standalone array to replace the defaults.
   */
  routeRegistrations?: readonly ExactTranslationRouteRegistration[];
}

export interface ExactTranslationRouteRegistration {
  id: string;
  name: string;
  strategy: "translate";
  sourceLanguageId: LanguageId;
  sourceDisplayName: string;
  targetLanguageId: LanguageId;
  targetDisplayName: string;
  /** Optional compatibility mapping for the legacy verifier protocol. */
  legacyVerifier?: { sourceLanguage: Language; targetLanguage: Language };
}

/**
 * Explicit route inventory. Adding a language adapter never creates migration
 * pairs implicitly; every source x target x strategy tuple remains reviewed.
 */
const DEFAULT_EXACT_TRANSLATION_ROUTES: readonly ExactTranslationRouteRegistration[] = [
  {
    id: "forexplore.translate.java-to-csharp",
    name: "Java to C# translation (historical regression route)",
    strategy: "translate",
    sourceLanguageId: "java",
    sourceDisplayName: "Java",
    targetLanguageId: "csharp",
    targetDisplayName: "C#",
    legacyVerifier: { sourceLanguage: "Java", targetLanguage: "C#" },
  },
  {
    id: "forexplore.translate.typescript-to-python",
    name: "TypeScript to Python translation",
    strategy: "translate",
    sourceLanguageId: "typescript",
    sourceDisplayName: "TypeScript",
    targetLanguageId: "python",
    targetDisplayName: "Python",
    legacyVerifier: { sourceLanguage: "TypeScript", targetLanguage: "Python" },
  },
  {
    id: "forexplore.translate.python-to-typescript",
    name: "Python to TypeScript translation",
    strategy: "translate",
    sourceLanguageId: "python",
    sourceDisplayName: "Python",
    targetLanguageId: "typescript",
    targetDisplayName: "TypeScript",
    legacyVerifier: { sourceLanguage: "Python", targetLanguage: "TypeScript" },
  },
];

export function defaultExactTranslationRouteRegistrations(): ExactTranslationRouteRegistration[] {
  return DEFAULT_EXACT_TRANSLATION_ROUTES.map((route) => structuredClone(route));
}

function validateExactRouteRegistrations(
  registrations: readonly ExactTranslationRouteRegistration[],
): ExactTranslationRouteRegistration[] {
  const routeIds = new Set<string>();
  const exactKeys = new Set<string>();
  return registrations.map((registration) => {
    const sourceLanguageId = normalizeLanguageId(registration.sourceLanguageId);
    const targetLanguageId = normalizeLanguageId(registration.targetLanguageId);
    if (
      !registration.id.trim() ||
      !registration.name.trim() ||
      !registration.sourceDisplayName.trim() ||
      !registration.targetDisplayName.trim() ||
      registration.strategy !== "translate"
    ) {
      throw new Error("Exact translation route requires stable identity, display metadata, and translate strategy.");
    }
    const exactKey = `${sourceLanguageId}\u0000${targetLanguageId}\u0000${registration.strategy}`;
    if (routeIds.has(registration.id)) {
      throw new Error(`Duplicate migration route ID ${registration.id}.`);
    }
    if (exactKeys.has(exactKey)) {
      throw new Error(
        `Duplicate exact migration route ${sourceLanguageId} -> ${targetLanguageId} (${registration.strategy}).`,
      );
    }
    routeIds.add(registration.id);
    exactKeys.add(exactKey);
    return {
      ...structuredClone(registration),
      sourceLanguageId,
      targetLanguageId,
    };
  });
}

export function createAdaptationRuntimeCapabilitySnapshot(
  options: AdaptationRuntimeCapabilitySnapshotOptions,
): MigrationRuntimeCapabilitySnapshot {
  const targetRegistry =
    options.targetEngineeringRegistry ?? createDefaultTargetEngineeringAdapterRegistry();
  const compilerRegistry = options.compilerRegistry ?? createDefaultCompilerRouteRegistry();
  const compilerByLanguageId = new Map(
    listCompilerRouteCapabilities(compilerRegistry).map((capability) => [
      capability.languageId,
      capability,
    ]),
  );
  const registrations = validateExactRouteRegistrations(
    options.routeRegistrations ?? DEFAULT_EXACT_TRANSLATION_ROUTES,
  );
  const routes = registrations.map((route) => buildRoute(
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
  route: ExactTranslationRouteRegistration,
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
  const verifierRoute = route.legacyVerifier
    ? resolveTranslationVerifierRoute(
        route.legacyVerifier.sourceLanguage,
        route.legacyVerifier.targetLanguage,
      )
    : undefined;
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
      "forexplore.planner.deepseek",
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
    strategy: route.strategy,
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
          label: `${route.targetDisplayName} target compilation`,
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

export function adaptationServiceOwnedRouteUnavailability(
  serviceSnapshot: MigrationRuntimeCapabilitySnapshot,
  routeId: string,
): string[] {
  validateMigrationRuntimeCapabilitySnapshot(serviceSnapshot);
  const route = serviceSnapshot.routes.find((candidate) => candidate.id === routeId);
  if (!route) return ["route-not-registered"];
  return route.stages
    .filter((stage) =>
      adaptationServiceOwnedStageSet.has(stage.stage) &&
      stage.availability.status === "unavailable")
    .flatMap((stage) => stage.availability.reasonCodes.map((reason) => `${stage.stage}:${reason}`));
}
