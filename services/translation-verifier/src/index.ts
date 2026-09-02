export const translationVerifierSchemaVersion = "1.0" as const;

export { verify } from "./verifier.js";
export type { VerificationJob, VerificationReport, SideRunInfo } from "./verifier.js";
export { TestMigratorAgent } from "./test-migrator.js";
export type { MigrationInput, TestMigratorOptions } from "./test-migrator.js";
export { LlmAnalyzer, NoneCoverageProvider } from "./analyzer.js";
export type {
  AnalyzerLike,
  BranchCoverage,
  BranchInfo,
  BranchInventory,
  CaseConsistency,
  ConsistencyReport,
  CoverageProvider,
  LlmAnalyzerOptions,
} from "./analyzer.js";
export { DescriptionValidator, buildValidatorFeedbackPrompt, filterDriverErrors } from "./validator.js";
export type { DescriptionValidatorOptions } from "./validator.js";
export { runConsistencyVerification } from "./consistency-verifier.js";
export type { ConsistencyResult, ConsistencyVerifierOptions } from "./consistency-verifier.js";
export { MitGenMigratorAgent } from "./mitgen/mitgen-migrator.js";
export type { MitGenOptions } from "./mitgen/mitgen-migrator.js";
export type {
  CodeFragment,
  FragmentKind,
  FragmentScore,
  Correspondence,
  Reachability,
  FragmentReport,
  MitGenResult,
  RankWeights,
} from "./mitgen/types.js";
export { extractFragments } from "./mitgen/fragment-extractor.js";
export { heuristicScore, rankFragments } from "./mitgen/fragment-prioritizer.js";
export { instrumentFragment, extractMarkers } from "./mitgen/splicer.js";
export { RealDriverExecutor } from "./executor.js";
export type {
  CompileOutcome,
  DriverExecutor,
  RealExecutorOptions,
  RunOutcome,
  SideFile,
  SideSpec,
} from "./executor.js";
export { generateDriverSource, generateSourceDriverSource } from "./driver/driver-codegen.js";
export type { SourceInvocation } from "./driver/source-invocation.js";
export type { TargetLanguage, TestDescription, TypedValue, VerifierLanguage } from "./description.js";
export { SmokeAgent } from "./smoke-agent.js";
export type { SmokeAgentOptions } from "./smoke-agent.js";
export type {
  SmokeAction,
  SmokeCaseVerdict,
  SmokeReport,
  SmokeDecision,
  SmokeSide,
} from "./smoke-types.js";

// AID / TrickCatcher 变体轨道(参考组 vs 目标的行为差异差分,oracle 来自共识/行为差异)。
export * from "./variant/index.js";

// 统一测试质量评估框架(接口 + 五维指标 + 五个生成器适配器 + CLI)。
export * from "./quality/types.js";
export { loadDataset, validateDataset, buildTask, alignDescriptionTarget, findRepoRoot } from "./quality/dataset.js";
export type { LoadResult, TaskBuildResult } from "./quality/dataset.js";
export { createAdapter, ADAPTER_NAMES, countedClaude } from "./quality/adapters.js";
export type { AdapterContext, CountedClaude } from "./quality/adapters.js";
export { BaselineAdapter } from "./quality/adapters/baseline.js";
export { SmokeAdapter, RecordingExecutor, splitSideSpec, smokeReportHasBugSignal, smokeReportBugCases } from "./quality/adapters/smoke.js";
export { DistinctAdapter, buildSourceSide, buildTargetSide } from "./quality/adapters/distinct.js";
export { AidAdapter } from "./quality/adapters/aid.js";
export type { AidDetectionResult } from "./quality/adapters/aid.js";
export { MitGenAdapter } from "./quality/adapters/mitgen.js";
export {
  compileGeneratedTest,
  buildConformancePrompt,
  parseConformanceVerdict,
  judgeConformance,
  targetViolations,
  detectInjectedBug,
  injectBug,
  runCleanDifferential,
  falsePositiveFromClean,
  falsePositiveFromSmoke,
} from "./quality/metrics.js";
export type { CleanCheck } from "./quality/metrics.js";
export { evaluate, sampleEntries, aggregateMetrics, defaultBugKinds } from "./quality/evaluate.js";
export type { EvaluateOptions, EvaluationReport } from "./quality/evaluate.js";
export { parseCliArgs, formatTable, runQualityCli } from "./quality/cli.js";
export type { CliOptions } from "./quality/cli.js";
