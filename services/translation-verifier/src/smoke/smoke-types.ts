/**
 * 方向 1「Agent 冒烟测试 + 行为一致性自修复」类型定义。
 *
 * 与旧 schema 管线(description.ts 的 TestDescription/cases/expected)完全解耦:
 * 本模块只借用 VerifierLanguage / TargetLanguage 类型,用例设计(plan)只有
 * 自然语言意图描述,不声明 expected 黄金值——一致性判断 = 机械差分 + LLM 语义裁决。
 */
import type { CaseComparison } from "../comparator.js";
import type { CaseResult, SideResults } from "../result-capture.js";
import type { CompileOutcome } from "../executor.js";
import type { TargetLanguage, VerifierLanguage } from "../description.js";

/** 冒烟验证的双侧:源侧(参考基准)与目标侧(翻译产物)。 */
export type SmokeSide = "source" | "target";

/** 冒烟用例计划:每个 case 只需意图描述,无 expected。 */
export interface SmokeCasePlan {
  id: string;
  intent: string;
}

/** agent 声明的 runner / 修复文件(相对路径 + 完整内容)。 */
export interface RunnerFile {
  path: string;
  content: string;
}

/** LLM 语义裁决的四种决策。 */
export type SmokeDecision = "pass" | "translation-bug" | "accepted-diff" | "unclear";

/** 机械差分(compareCases)的三种 verdict。 */
export type SmokeMechanicalVerdict = "pass" | "fail" | "divergent";

// ---------------------------------------------------------------------------
// 工具参数(与 MCP tool 规范对齐的 JSON 文本协议)
// ---------------------------------------------------------------------------

export interface ListFilesParams {
  path: string;
}

export interface ReadFileParams {
  path: string;
}

export interface PlanSmokeParams {
  cases: { id: string; intent: string }[];
}

export interface WriteRunnerParams {
  side: SmokeSide;
  language: VerifierLanguage;
  files: RunnerFile[];
}

export interface CompileRunnerParams {
  side: SmokeSide;
}

export interface RunRunnerParams {
  side: SmokeSide;
}

export interface JudgeVerdictParam {
  caseId: string;
  decision: SmokeDecision;
  reasoning: string;
}

export interface JudgeParams {
  verdicts: JudgeVerdictParam[];
  /** agent 标注的源侧疑似缺陷(两侧一致但都偏离需求的情形,只标注不机械判 fail)。 */
  sourceIssues?: string[];
}

export interface ProposeTargetFixParams {
  /** 修复后的完整目标文件(非方法体片段;控制器按 path 覆盖后自动走 compile→run→compare)。 */
  files: RunnerFile[];
}

export interface ProposeRunnerFixParams {
  side: SmokeSide;
  files: RunnerFile[];
}

export interface FinishParams {
  summary: string;
  verdicts?: JudgeVerdictParam[];
}

/** 判别联合:LLM stdout 解析出的全部工具动作。 */
export type SmokeAction =
  | { action: "list_files"; params: ListFilesParams }
  | { action: "read_file"; params: ReadFileParams }
  | { action: "plan_smoke"; params: PlanSmokeParams }
  | { action: "write_runner"; params: WriteRunnerParams }
  | { action: "compile_runner"; params: CompileRunnerParams }
  | { action: "run_runner"; params: RunRunnerParams }
  | { action: "compare"; params: Record<string, never> }
  | { action: "judge"; params: JudgeParams }
  | { action: "propose_target_fix"; params: ProposeTargetFixParams }
  | { action: "propose_runner_fix"; params: ProposeRunnerFixParams }
  | { action: "finish"; params: FinishParams };

export const SMOKE_ACTION_NAMES = [
  "list_files",
  "read_file",
  "plan_smoke",
  "write_runner",
  "compile_runner",
  "run_runner",
  "compare",
  "judge",
  "propose_target_fix",
  "propose_runner_fix",
  "finish",
] as const;

// ---------------------------------------------------------------------------
// 报告结构
// ---------------------------------------------------------------------------

export interface SmokeCaseVerdict {
  caseId: string;
  /** 用例意图(agent plan)。 */
  intent: string;
  source: CaseResult | null;
  target: CaseResult | null;
  /** 机械差分 verdict。 */
  mechanical: SmokeMechanicalVerdict;
  /** LLM 语义裁决。 */
  decision: SmokeDecision;
  /** LLM 裁决依据。 */
  reasoning: string;
}

export interface SmokeReport {
  converged: boolean;
  steps: number;
  /** 修复轮数(propose_target_fix 次数)。 */
  rounds: number;
  cases: SmokeCaseVerdict[];
  /** 修复后的目标文件全文(未采纳不落盘,由调用方决定是否写回用户目录)。 */
  targetFiles: RunnerFile[];
  /** agent 标注的源侧疑似缺陷。 */
  sourceIssues: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// 控制器/工具共享的可变状态
// ---------------------------------------------------------------------------

export interface SmokeContextState {
  requirement: string;
  sourceLang: VerifierLanguage;
  targetLang: TargetLanguage;
  /** 源侧根目录(list_files/read_file 的允许范围)。 */
  sourceRoot: string;
  /** 目标侧根目录(list_files/read_file 的允许范围)。 */
  targetRoot: string;
  /** 用户提供的源模块文件(随 runner 一起进编译/运行临时目录)。 */
  sourceModuleFiles: { relativePath: string; content: string }[];
  /** 用户提供的目标模块文件;propose_target_fix 会整体替换为修复文件。 */
  targetModuleFiles: { relativePath: string; content: string }[];
  /** maven 项目 projectRoot(目标/源目录含 pom.xml 时自动探测)。 */
  sourceProjectRoot?: string;
  targetProjectRoot?: string;

  /** plan_smoke 记录的用例计划。 */
  plan: SmokeCasePlan[];
  /** 各侧 runner 文件(write_runner 记录;compile/run 前必须就绪)。 */
  runners: Record<SmokeSide, RunnerFile[] | null>;
  /** 各侧最近一次编译结果。 */
  compile: Record<SmokeSide, CompileOutcome | null>;
  /** 各侧最近一次运行解析结果。 */
  run: Record<SmokeSide, SideResults | null>;
  /** 最近一次机械差分比较。 */
  comparisons: CaseComparison[] | null;
  /** judge 记录的 LLM 裁决(按 caseId 覆盖)。 */
  decisions: JudgeVerdictParam[];
  sourceIssues: string[];
  /** 修复轮数(propose_target_fix 计数)。 */
  rounds: number;
  steps: number;
  finished: boolean;
  summary: string;
  /** 各侧编译失败次数(用于 3 次/侧上限)。 */
  compileFailures: Record<SmokeSide, number>;
}
