import { createDefaultVerificationService, type VerificationService } from "@forexplore/translation-verifier";
import type { MigrationRuntimeCapabilitySnapshot } from "@forexplore/contracts";
import type { TargetEngineeringAdapterRegistry } from "./context-collector";
import {
  AdaptationAdapterV2,
  DeepSeekMigrationAnalyzerV2,
  DeepSeekMigrationPlannerV2,
  DeepSeekMigrationTranslatorV2,
  type AdaptationAdapterV2Options,
  type MigrationAnalyzerV2,
  type MigrationPlannerV2,
  type MigrationTranslatorV2,
} from "./adaptation-adapter-v2";
import { createAdaptationRuntimeCapabilitySnapshot } from "./runtime-capability-snapshot";
import type { AdaptationServiceConfig } from "./config";
import { TranslationVerifierV2Adapter } from "./translation-verifier-v2-adapter";

export interface AdaptationV2Runtime {
  runtimeCapabilitySnapshot: MigrationRuntimeCapabilitySnapshot;
  adapterV2: AdaptationAdapterV2;
}

export function createAdaptationV2Runtime(
  config: Pick<AdaptationServiceConfig, "apiKey" | "verificationWorkspaceRoot" | "verificationArtifactRoot" | "verificationTimeoutMs">,
  options: {
    createdAt?: string;
    targetEngineeringRegistry?: TargetEngineeringAdapterRegistry;
    analyzer?: MigrationAnalyzerV2;
    planner?: MigrationPlannerV2;
    translator?: MigrationTranslatorV2;
    verificationService?: Pick<VerificationService, "verify">;
  } = {},
): AdaptationV2Runtime {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const verificationService = options.verificationService ?? createDefaultVerificationService({
    workspaceRoot: config.verificationWorkspaceRoot,
    artifactRoot: config.verificationArtifactRoot,
    timeoutMs: config.verificationTimeoutMs,
  });
  const verifier = new TranslationVerifierV2Adapter(verificationService);
  const agents = { apiKey: config.apiKey };
  const runtimeCapabilitySnapshot = createAdaptationRuntimeCapabilitySnapshot({
    createdAt,
    analysisExecution: "disabled",
    verifierExecution: "local-process",
    workspaceMutationExecution: "disabled",
    ...(options.targetEngineeringRegistry ? { targetEngineeringRegistry: options.targetEngineeringRegistry } : {}),
  });
  const adapterOptions: AdaptationAdapterV2Options = {
    runtimeCapabilities: runtimeCapabilitySnapshot,
    analyzer: options.analyzer ?? new DeepSeekMigrationAnalyzerV2(agents),
    planner: options.planner ?? new DeepSeekMigrationPlannerV2(agents),
    translator: options.translator ?? new DeepSeekMigrationTranslatorV2(agents),
    verifier,
    ...(options.targetEngineeringRegistry ? { targetEngineeringRegistry: options.targetEngineeringRegistry } : {}),
  };
  return { runtimeCapabilitySnapshot, adapterV2: new AdaptationAdapterV2(adapterOptions) };
}
