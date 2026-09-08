/**
 * smoke 差分验证类型定义(src/strategies 模块与 e2e 共享的 SmokeReport schema)。
 *
 * Per-case expected observations are derived from the Host-confirmed basis and
 * reviewed separately from actual runner output; both sides are assessed independently.
 */
import type { VerificationAssessment } from "../../schemas/verification-types.js";

/** smoke 差分验证支持的语言。 */
export type VerifierLanguage = "Java" | "C#" | "Python" | "TypeScript";

/** runner 产出的规范化值。 */
export type TypedValue =
 | { type: "string"; value: string }
 | { type: "number"; value: number }
 | { type: "boolean"; value: boolean }
 | { type: "null"; value: null }
 | { type: "list"; value: TypedValue[] }
 | { type: "map"; value: Record<string, TypedValue> };

/** 双侧 runner 的单个 case 结果。 */
export interface CaseResult {
 caseId: string;
 outcome: "return" | "exception";
 returnValue?: TypedValue;
 exceptionType?: string;
 exceptionMessage?: string;
}

/** 兼容小型 fixture 输入的源码文件。 */
export interface SideFile {
 relativePath: string;
 content: string;
}

/** 冒烟验证的双侧:源侧(参考基准)与目标侧(翻译产物)。 */
export type SmokeSide = "source" | "target";

/** 冒烟会话的运行模式:verify-only 禁止目标修复;diagnostic-repair 允许(仅诊断用)。 */
export type SmokeMode = "verify-only" | "diagnostic-repair";

/** 报告声明的单条执行证据(report.executions 条目,commandId 必须能在命令证据日志中找到)。 */
export interface SmokeExecutionEvidence {
 side: SmokeSide;
 phase: "compile" | "run";
 commandId: string;
 exitCode: number | null;
 durationMs: number;
}

/** verifier-command 命令代理写入的命令证据(commands.jsonl 条目,宿主侧 ground truth)。 */
export interface CommandEvidence extends SmokeExecutionEvidence {
 cwd: string;
 command: string;
 baselineValid: boolean;
 timedOut: boolean;
 stdout: string;
 stderr: string;
}

/**
 * 工作区文件基线(声明只在 smoke-types.ts;workspace-baseline.ts 负责实现并导入本类型)。
 * Task 2 实现文件系统助手,本任务不新增。
 */
export interface WorkspaceBaseline {
 schemaVersion: "1.0";
 workspaceRoot: string;
 protectedFiles: Array<{ relativePath: string; sha256: string }>;
 runnerRoots: ["source/.forexplore-tests", "target/.forexplore-tests"];
 mutableFiles: [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
 ];
 artifactDirectoryNames: string[];
}

/** agent 声明的 runner / 修复文件(相对路径 + 完整内容)。 */
export interface RunnerFile {
 path: string;
 content: string;
}

/** LLM 语义裁决的四种决策。 */
export type SmokeDecision =
 | "pass"
 | "translation-bug"
 | "accepted-diff"
 | "unclear";

/** 机械差分(compareCases)的三种 verdict。 */
export type SmokeMechanicalVerdict = "pass" | "fail" | "divergent";

// ---------------------------------------------------------------------------
// 报告结构(SmokeReport,report.json 契约)
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
 sourceAssessment?: VerificationAssessment["sourceAssessment"];
 targetAssessment?: VerificationAssessment["targetAssessment"];
 /** Host-confirmed basis and the case-specific expected observation derived from it. */
 requirement?: {
  basis: string;
  expected: CaseResult;
  expectedBySide?: Partial<Record<SmokeSide, CaseResult>>;
 };
 /** Successful run commands whose stdout contains this case's observations. */
 commandIds?: { source?: string; target: string };
}

export interface SmokeReport {
 /** true = 差分收敛(所有差异已裁决/修复)。 */
 converged: boolean;
 /** 已执行步骤数。 */
 steps: number;
 /** 目标侧修复轮数。 */
 rounds: number;
 cases: SmokeCaseVerdict[];
 /** 修复后的目标文件全文(未采纳不落盘,由调用方决定是否写回用户目录)。 */
 targetFiles: RunnerFile[];
 /**
  * 双侧 runner/driver 文件(可选):收敛无修复的常见路径下 targetFiles 为空,
  * 由本字段携带双侧可编译 runner 文件(含 driver 入口)。
  */
 runnerFiles?: {
  side: SmokeSide;
  language: VerifierLanguage;
  files: RunnerFile[];
 }[];
 /** agent 标注的源侧疑似缺陷(两侧一致但都偏离需求的情形,只标注不机械判 fail)。 */
 sourceIssues: string[];
 /** 报告声明的执行证据引用(每次真实编译/运行的 commandId;缺省视为无可核验证据)。 */
 executions?: SmokeExecutionEvidence[];
 /** 整体结论(如 "5/5 用例行为一致")。 */
 summary: string;
}
