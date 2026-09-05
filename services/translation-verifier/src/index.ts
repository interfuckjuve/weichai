export const translationVerifierSchemaVersion = "1.0" as const;

export { assertVerificationInput, assertVerificationResult, createVerificationResult } from "./verification-types.js";
export type {
  VerificationArtifact,
  VerificationInput,
  VerificationIssue,
  VerificationResult,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "./verification-types.js";

// smoke 差分报告类型(SmokeReport schema,src/smoke-types.ts)。
export type {
  CaseResult,
  CommandEvidence,
  RunnerFile,
  SideFile,
  SmokeCaseVerdict,
  SmokeDecision,
  SmokeExecutionEvidence,
  SmokeMechanicalVerdict,
  SmokeMode,
  SmokeReport,
  SmokeSide,
  WorkspaceBaseline,
  TypedValue,
  VerifierLanguage,
} from "./smoke-types.js";

// 深度 schema 校验(assertSmokeReport,运行时逐字段验证)。
export { assertSmokeReport } from "./strategies/report-schema.js";
// 请求级验证工作区文件基线实现与断言(create/write/assert,声明见 smoke-types.ts)。
export {
  assertWorkspaceBaseline,
  createWorkspaceBaseline,
  writeWorkspaceBaseline,
} from "./workspace-baseline.js";
export { evaluateSmokeReport } from "./smoke-evaluation.js";
export type { SmokeEvaluation } from "./smoke-evaluation.js";

// 新一代 smoke 差分验证:单次 claude 自主会话(读码→双侧 runner→真实编译运行→机械差分+语义裁决→自修复→report.json)。
export { runSmoke } from "./strategies/smoke-runner.js";
export type { SmokeErrorReason, SmokeResult, SmokeRunOptions, SmokeStatus } from "./strategies/smoke-runner.js";
export { buildSmokeTaskPrompt } from "./strategies/prompts/smoke-task.js";
export type { SmokeTaskInput } from "./strategies/prompts/smoke-task.js";
