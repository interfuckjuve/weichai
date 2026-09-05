/**
 * @forexplore/adaptation-service
 *
 * Language-neutral code adaptation service:
 *   Analyzer report → Translator → target validation → protected patch
 */

export { AdaptationAdapter } from "./adaptation-adapter";
export type {
  AdaptationAdapterOptions,
  AdaptationAnalyzer,
  AdaptationContextCollector,
  AdaptationValidator,
} from "./adaptation-adapter";

export {
  AdaptationAdapterV2,
  DeepSeekMigrationAnalyzerV2,
  DeepSeekMigrationPlannerV2,
  DeepSeekMigrationTranslatorV2,
  MigrationRouteExecutionError,
} from "./adaptation-adapter-v2";
export type {
  AdaptationAdapterV2Options,
  CodeAdaptationPortV2,
  DeepSeekMigrationAgentsV2Options,
  MigrationAnalysisV2,
  MigrationAnalyzerV2,
  MigrationBehaviorVerificationInputV2,
  MigrationBehaviorVerifierV2,
  MigrationCompilerV2,
  MigrationEvidenceInputV2,
  MigrationPlanV2,
  MigrationPlannerV2,
  MigrationRouteExecutionErrorCode,
  MigrationTranslationV2,
  MigrationTranslatorV2,
  MigrationValidationEvidenceV2,
} from "./adaptation-adapter-v2";

export { TranslationVerifierV2Adapter } from "./translation-verifier-v2-adapter";
export { createAdaptationV2Runtime } from "./adaptation-v2-runtime";
export type { AdaptationV2Runtime } from "./adaptation-v2-runtime";


export { BackfillAdapter } from "./backfill-adapter";
export type {
  BackfillAdapterOptions,
  BackfillRecoveryResult,
  BackfillTransactionOptions,
} from "./backfill-adapter";

export { GitWaveTransaction } from "./git-wave-transaction";
export type {
  GitWavePreparationRequest,
  GitWavePreparationResult,
  GitWavePublicationEvidence,
  GitWaveRecoveryResult,
  GitWaveTransactionRequest,
  GitWaveTransactionResult,
} from "./git-wave-transaction";

export { ModuleWaveExecutionCoordinator } from "./module-wave-execution";
export type {
  ModuleWavePreparationRequest,
  ModuleWaveAutomatedPreparationRequest,
  ModuleWaveCommitRequest,
  ModuleWaveCommitResult,
  PreparedModuleWave,
  PreparedModulePatch,
} from "./module-wave-execution";

export { ModuleWavePreparationRunner } from "./module-wave-preparation-runner";
export type {
  ModulePatchPreparer,
  ModulePatchPreparationContext,
  PrepareModuleWavePatchesRequest,
} from "./module-wave-preparation-runner";

export {
  projectTargetContext,
  repairTranslation,
  TranslatorAgent,
  translateWithAnalysis,
} from "./translator";
export type {
  AnalyzeTranslationRequest,
  ApplicabilityLevel,
  RepairTranslationRequest,
  TranslationMapping,
  TranslationResult,
  TranslatorAnalysisReport,
  TranslatorModelOptions,
  TranslatorTargetContext,
  ValidationFeedback,
} from "./translator";

export {
  AnalyzerAgent,
  buildAnalyzerMessages,
  parseAnalysisReport,
  validateAnalysisReport,
} from "./analyzer";
export type {
  AnalyzerAgentOptions,
  AnalyzerMessage,
  AnalyzerModelClient,
} from "./analyzer";

export {
  Agenticodex,
  ArchitectAgent,
  buildArchitectMessages,
  parseModuleMigrationProposal,
  validateModuleMigrationProposal,
  validateRepositoryArchitectureRequest,
} from "./architect-agent";
export type {
  ArchitectAgentOptions,
  ArchitectMessage,
  ArchitectModelClient,
} from "./architect-agent";

export {
  canonicalTargetLanguageId,
  collectTargetContext,
  collectTargetContextSnapshot,
  createDefaultTargetEngineeringAdapterRegistry,
  locateTargetPatch,
  serializeTargetContext,
  TargetEngineeringAdapterRegistry,
  TargetEngineeringUnsupportedError,
} from "./context-collector";
export type {
  ContextCollectorOptions,
  TargetContextSnapshot,
  TargetEngineeringAdapter,
  TargetEngineeringCapabilityDescriptor,
  TargetEngineeringContextRequest,
  TargetEngineeringPatchContextV2,
  TargetEngineeringResult,
  TargetEngineeringStage,
  TargetEngineeringUnsupportedReason,
  TargetPatchLocation,
  TargetPatchLocatorInput,
} from "./context-collector";

export {
  compileStandalone,
  compileIntegrated,
  compileJavaStandalone,
  compileJavaIntegrated,
  compileTargetStandalone,
  compileTargetIntegrated,
  compilerCommand,
  createDefaultCompilerRouteRegistry,
  listCompilerRouteCapabilities,
  resolveCompilerRouteCapability,
  resolveCompilerRouteCapabilityByLanguageId,
  compileTargetStandaloneByLanguageId,
  compileTargetIntegratedByLanguageId,
} from "./compiler";
export type {
  CompileResult,
  CompilerRouteRegistration,
  CompilerRouteCapability,
  CompilerUnsupportedReason,
  CompilerValidationLevel,
} from "./compiler";
export { CompilerRouteRegistry } from "./compiler";

export { deepSeekModelConfig, loadDeepSeekModelConfig } from "./model-config";
export type { DeepSeekModelConfig } from "./model-config";

export { chatCompletionContent, completeWithDeepSeek } from "./deepseek-client";
export type { DeepSeekClientOptions, DeepSeekMessage } from "./deepseek-client";

export { loadConfig } from "./config";
export type { AdaptationServiceConfig } from "./config";

export { createHttpServer } from "./http-server";
export type {
  HttpServerOptions,
  MigrationExecutionV2ArtifactLookup,
  MigrationExecutionV2ArtifactStore,
  MigrationExecutionV2ServerArtifacts,
  ModuleDiscoveryHttpConstraint,
  ModuleDiscoveryHttpRequest,
  ModulePlanHttpRequest,
  StaticAnalysisSnapshotStore,
} from "./http-server";
export type { RepositoryArchitecturePort } from "@forexplore/workflow-core";

export {
  adaptationServiceOwnedRouteStages,
  adaptationServiceOwnedRouteUnavailability,
  createAdaptationRuntimeCapabilitySnapshot,
  defaultExactTranslationRouteRegistrations,
  hostOwnedRouteStages,
  routeByExactPair,
} from "./runtime-capability-snapshot";
export type {
  AdaptationRuntimeCapabilitySnapshotOptions,
  BehaviorVerifierExecution,
  ExactTranslationRouteRegistration,
  RepositoryAnalysisExecution,
  WorkspaceMutationExecution,
} from "./runtime-capability-snapshot";

export {
  ModuleDiscoveryAgent,
  buildModuleDiscoveryMessages,
  materializeModuleDiscoveryProposal,
  parseModuleDiscoveryDraft,
  repositoryStaticAnalysisToUnifiedIr,
  validateModuleDiscoveryDraft,
  validateModuleDiscoveryProposal,
  validateModuleDiscoveryRequest,
} from "./module-discovery-agent";

export {
  ModuleSummaryAgent,
  buildModuleSummaryMessages,
  moduleSummaryAgentVersion,
  moduleSummaryPromptTemplateId,
  moduleSummaryPromptTemplateVersion,
  parseModuleSummaryDraft,
  validateModuleSummaryRequest,
} from "./module-summary-agent";
export type {
  ModuleSummaryAgentOptions,
  ModuleSummaryDraft,
  ModuleSummaryMessage,
  ModuleSummaryModelClient,
  ModuleSummaryPort,
  ModuleSummaryRequest,
} from "./module-summary-agent";
export type {
  ModuleDiscoveryAgentOptions,
  ModuleDiscoveryDraft,
  ModuleDiscoveryMessage,
  ModuleDiscoveryModelClient,
  ModuleDiscoveryPort,
  ModuleDiscoveryRequest,
  RepositoryStaticAnalysisIrBridge,
} from "./module-discovery-agent";

export { FileStaticAnalysisSnapshotStore } from "./analysis-snapshot-store";
export type { FileStaticAnalysisSnapshotStoreOptions } from "./analysis-snapshot-store";
