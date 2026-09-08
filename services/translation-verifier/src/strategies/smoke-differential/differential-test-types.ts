/**
 * smoke 差分验证类型定义(src/strategies 模块与 e2e 共享的 SmokeReport schema)。
 *
 * The Agent derives case expectations from the Host-confirmed basis; Host checks
 * enforce evidence consistency, not independent approval of those expectations.
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

/** 冒烟验证的双侧:源侧(参考基准)与目标侧(翻译产物)。 */
export type SmokeSide = "source" | "target";

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

/** File baseline created and checked by protect-project-files.ts. */
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

/** Agent-declared runner file with a relative path and complete content. */
export interface RunnerFile {
 path: string;
 content: string;
}

/** Legacy model annotation; never used as the Host verification verdict. */
export type SmokeDecision =
 | "pass"
 | "translation-bug"
 | "accepted-diff"
 | "unclear";

/** Agent-reported mechanical comparison annotation; not a Host verdict. */
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
 /** Non-authoritative mechanical annotation; never establishes code findings. */
 mechanical: SmokeMechanicalVerdict;
 /** Non-authoritative model annotation; independent assessments and evidence are authoritative. */
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
 /** Legacy Agent convergence annotation; does not establish verification success. */
 converged: boolean;
 /** 已执行步骤数。 */
 steps: number;
 /** Must be zero in verify-only mode; target repair belongs to the translator. */
 rounds: number;
 cases: SmokeCaseVerdict[];
 /** Must be empty in verify-only mode; target implementation edits are rejected. */
 targetFiles: RunnerFile[];
 /** Agent-declared runners for the permitted sides, including driver entry points. */
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
