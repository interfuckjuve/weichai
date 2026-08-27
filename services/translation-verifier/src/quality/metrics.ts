/**
 * 五维指标实现(quality-spec 2.2)。
 *
 * - CSR 编译通过率:描述型 = 描述→驱动(generateDriverSource)→executor.compile 目标侧;
 *   runner 型 = runner 文件→executor.compile(含目标模块文件);
 * - Conformance 需求一致性:LLM 三态评审(conforms/diverges/unverified),
 *   prompt 给需求+需求差异标注+检索代码+目标翻译+生成的测试,要求以需求推演 expected;
 * - 检出率:复用 bug-injection.ts 的 injectFineGrainedBug(4 策略)。描述型 = 差分验证
 *   (verify)在注入目标上的违规(目标偏离需求黄金值);runner 型 = 复用冒烟 runner 的
 *   机械差分(干净目标 vs 注入目标);
 * - 误报率:干净目标不误报(描述型 = 目标无违规;runner 型 = 无 judge translation-bug);
 * - 成本:GeneratedTest.meta.llmCalls 汇总。
 *
 * 语义要点(数据集设计「需求 R ≠ 检索代码 S」):差分 fail 本身不等于检出——正确实现需求
 * 的翻译在 R/S 分歧点上合法偏离 S。因此描述型检出/误报以「目标是否偏离需求黄金值
 * (expected)」为信号(verify 的 requirementVerdict=target-diverges 或黄金改判 fail),
 * 而非原始差分 fail;runner 型以干净 vs 注入的机械差分隔离注入 bug。
 */
import { runClaude, type ClaudeClientOptions } from "../claude-client.js";
import { basename } from "node:path";
import { compareCases } from "../comparator.js";
import { generateDriverSource } from "../driver/driver-codegen.js";
import type { CompileOutcome, DriverExecutor, SideSpec } from "../executor.js";
import { executeSide, verify, type VerificationReport } from "../verifier.js";
import { splitDriverEntry } from "../smoke/driver-entry.js";
import { injectFineGrainedBug, type InjectedBugKind } from "../bug-injection.js";
import type { GeneratedTest, QualityTask, ConformanceJudgement, DetectionTrial } from "./types.js";
import { buildSourceSide, buildTargetSide } from "./adapters/distinct.js";
import { smokeReportHasBugSignal } from "./adapters/smoke.js";
export { smokeReportBugCases, smokeReportHasBugSignal } from "./adapters/smoke.js";

// ---------------------------------------------------------------------------
// CSR 编译通过率
// ---------------------------------------------------------------------------

/** 描述型:描述 → 目标侧驱动 → 编译目标侧(driver + 目标模块文件)。
 * 保留 task.target 的项目文件结构(C# 整项目 + GlobalUsings),仅替换目标模块文件内容。 */
export function buildDescriptionTargetSide(description: NonNullable<GeneratedTest["description"]>, task: QualityTask, targetContent: string): SideSpec {
  return buildTargetSide(description, task, targetContent);
}

/** runner 型:runner 文件 + 目标模块文件组装目标侧(保留项目文件结构,替换模块内容)。 */
export function buildRunnerTargetSide(
  test: GeneratedTest,
  task: QualityTask,
  targetContent: string,
): SideSpec {
  const runner = test.runner!;
  const { driverSource, extraFiles } = splitDriverEntry(runner.language, runner.files);
  const targetFile = basename(task.entry.target.file);
  const sourceFiles = task.target.sourceFiles.map((f) =>
    f.relativePath === targetFile ? { ...f, content: targetContent } : f,
  );
  return {
    ...task.target,
    language: runner.language,
    driverSource,
    sourceFiles: [...sourceFiles, ...extraFiles.map((f) => ({ relativePath: f.path, content: f.content }))],
  };
}

/** 生成的测试 → 目标侧编译(CSR 度量)。描述缺省/runner 文件缺失返回失败编译结果。 */
export async function compileGeneratedTest(
  test: GeneratedTest,
  task: QualityTask,
  executor: DriverExecutor,
): Promise<CompileOutcome> {
  if (test.kind === "description" && test.description) {
    const cleanContent = task.target.sourceFiles.map((f) => f.content).join("\n");
    return executor.compile(buildDescriptionTargetSide(test.description, task, cleanContent));
  }
  if (test.kind === "runner" && test.runner && test.runner.files.length > 0) {
    const cleanContent = task.target.sourceFiles.map((f) => f.content).join("\n");
    return executor.compile(buildRunnerTargetSide(test, task, cleanContent));
  }
  return { success: false, errors: ["生成的测试缺少可编译产物(description 或 runner 文件)。"], output: "" };
}

// ---------------------------------------------------------------------------
// Conformance 需求一致性(LLM 三态评审)
// ---------------------------------------------------------------------------

/** 评审对象文本:描述型 = 描述 JSON;runner 型 = runner 源码(含报告摘要)。 */
export function testForReview(test: GeneratedTest): string {
  if (test.kind === "description" && test.description) {
    return JSON.stringify(test.description, null, 2);
  }
  if (test.kind === "runner" && test.runner) {
    const files = test.runner.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
    const report = test.runner.report
      ? `\nSMOKE_REPORT_SUMMARY\n${JSON.stringify(
          {
            converged: test.runner.report.converged,
            cases: test.runner.report.cases.map((c) => ({ caseId: c.caseId, decision: c.decision, mechanical: c.mechanical })),
          },
          null,
          2,
        )}`
      : "";
    return `${files}${report}`;
  }
  return "(空测试)";
}

/** conformance 评审 prompt:需求(唯一 ground truth)+ 差异标注 + 检索代码 + 目标 + 测试。 */
export function buildConformancePrompt(test: GeneratedTest, task: QualityTask): string {
  const entry = task.entry;
  const sourceCode = task.source.sourceFiles.map((f) => f.content).join("\n\n");
  const targetCode = task.target.sourceFiles.map((f) => f.content).join("\n\n");
  const diffs = entry.requirementDiffs.length > 0 ? entry.requirementDiffs.map((d) => `- ${d}`).join("\n") : "(无)";
  return `You are a test-quality reviewer for translation verification. Judge whether a generated test's
expected values / assertions match the REQUIREMENT semantics, NOT whether they match the reference
implementation (which may contain defects). The REQUIREMENT is the ONLY ground truth.

REQUIREMENT (唯一 ground truth)
${entry.requirement}

REQUIREMENT_CLARIFICATIONS (数据集标注的需求细节差异,评审须以需求语义为准)
${diffs}

REFERENCE_IMPLEMENTATION (检索代码,可能含缺陷)
\`\`\`
${sourceCode}
\`\`\`

TARGET_TRANSLATION (目标侧翻译产物)
\`\`\`
${targetCode}
\`\`\`

GENERATED_TEST (待评审的生成测试)
\`\`\`
${testForReview(test)}
\`\`\`

判定标准:
- "conforms": 测试的 expected/断言与 REQUIREMENT 语义一致(以需求推演 expected 可得到同样的值/行为);
- "diverges": 测试的 expected/断言照抄了检索代码的(可能是缺陷的)行为,与 REQUIREMENT 语义冲突;
- "unverified": 信息不足、需求或测试语义不明确,无法可靠判定(宁可不判,不误报)。

Output ONLY JSON (no markdown):
{"verdict": "conforms" | "diverges" | "unverified", "reasoning": "<简短依据,中文可>"}`;
}

/** 解析 LLM 三态输出(容错:非 JSON/非法 verdict 一律 unverified)。 */
export function parseConformanceVerdict(raw: string): ConformanceJudgement {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return { verdict: "unverified", reasoning: "评审输出无法解析为 JSON。" };
    try {
      value = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return { verdict: "unverified", reasoning: "评审输出无法解析为 JSON。" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { verdict: "unverified", reasoning: "评审输出不是 JSON 对象。" };
  }
  const v = value as Record<string, unknown>;
  const verdict = v.verdict === "conforms" || v.verdict === "diverges" ? v.verdict : "unverified";
  return {
    verdict,
    reasoning: typeof v.reasoning === "string" ? v.reasoning : "",
  };
}

/** LLM 三态评审(一次调用)。 */
export async function judgeConformance(
  test: GeneratedTest,
  task: QualityTask,
  llm: ClaudeClientOptions,
): Promise<ConformanceJudgement> {
  const raw = await runClaude(buildConformancePrompt(test, task), llm);
  return parseConformanceVerdict(raw);
}

// ---------------------------------------------------------------------------
// 检出率 / 误报率
// ---------------------------------------------------------------------------

/** 报告中的「目标违规」caseId 列表(偏离需求黄金值的信号)。 */
export function targetViolations(report: VerificationReport): string[] {
  return report.comparisons
    .filter(
      (c) =>
        c.requirementVerdict === "target-diverges" ||
        (c.verdict === "fail" && c.requirementVerdict === undefined),
    )
    .map((c) => c.caseId);
}

export interface CleanCheck {
  /** 干净目标差分报告;null = 源侧/目标侧不可用(无法运行)。 */
  report: VerificationReport | null;
  /** 不可用原因(source-compile-failed / source-run-failed / target-compile-failed / no-description)。 */
  note?: string;
}

/** 描述型:跑干净目标差分(供误报判定 + 检出基线)。一次调用,检出各策略复用。 */
export async function runCleanDifferential(test: GeneratedTest, task: QualityTask, executor: DriverExecutor): Promise<CleanCheck> {
  const description = test.description;
  if (!description) return { report: null, note: "no-description" };
  const cleanContent = task.target.sourceFiles.map((f) => f.content).join("\n");
  const report = await verify(
    { description, source: buildSourceSide(description, task), target: buildDescriptionTargetSide(description, task, cleanContent) },
    executor,
  );
  if (!report.source.compile.success) return { report: null, note: "source-compile-failed" };
  if (report.source.run === null || report.source.results === null || report.source.results.results.length === 0) {
    return { report: null, note: "source-run-failed" };
  }
  if (!report.target.compile.success) return { report: null, note: "target-compile-failed" };
  return { report };
}

/** 描述型检出:注入目标差分 → 目标违规(排除干净目标已有的违规,隔离数据集 R≠S 噪声)。 */
export function detectFromDifferential(
  clean: CleanCheck,
  buggyReport: VerificationReport,
  kind: InjectedBugKind,
): DetectionTrial {
  if (clean.report === null) {
    return { kind, detected: false, note: clean.note ?? "clean-unusable" };
  }
  if (!buggyReport.target.compile.success) {
    return { kind, detected: false, note: "target-compile-failed" };
  }
  if (!buggyReport.source.compile.success || buggyReport.source.results === null || buggyReport.source.results.results.length === 0) {
    return { kind, detected: false, note: "source-unusable" };
  }
  const cleanViolations = new Set(targetViolations(clean.report));
  const buggyViolations = targetViolations(buggyReport);
  if (cleanViolations.size > 0) {
    return { kind, detected: false, note: "clean-already-violating" };
  }
  return { kind, detected: buggyViolations.length > 0 };
}

/** runner 型检出:复用冒烟 runner 的机械差分(干净目标 vs 注入目标,同一 runner 两次运行)。 */
export async function detectRunnerDifferential(
  test: GeneratedTest,
  task: QualityTask,
  executor: DriverExecutor,
  targetSource: string,
  kind: InjectedBugKind,
): Promise<DetectionTrial> {
  const runner = test.runner;
  if (!runner || runner.files.length === 0) return { kind, detected: false, note: "no-runner" };
  const cleanContent = task.target.sourceFiles.map((f) => f.content).join("\n");
  const cleanSide = buildRunnerTargetSide(test, task, cleanContent);
  const buggySide = buildRunnerTargetSide(test, task, targetSource);
  const cleanRun = await executeSide(executor, cleanSide, "clean");
  const buggyRun = await executeSide(executor, buggySide, "buggy");
  if (!cleanRun.compile.success || !buggyRun.compile.success) {
    return { kind, detected: false, note: "target-compile-failed" };
  }
  if (cleanRun.results === null || cleanRun.results.results.length === 0 || buggyRun.results === null || buggyRun.results.results.length === 0) {
    return { kind, detected: false, note: "runner-unusable" };
  }
  const comparisons = compareCases(cleanRun.results, buggyRun.results);
  return { kind, detected: comparisons.some((c) => c.verdict === "fail") };
}

/**
 * 统一检出入口:描述型走差分验证(buggy 报告由调用方注入——evaluate 层按策略注入后调用
 * detectFromDifferential);runner 型走机械差分。此函数为 runner 型专用封装。
 */
export async function detectInjectedBug(
  test: GeneratedTest,
  task: QualityTask,
  executor: DriverExecutor,
  targetSource: string,
  kind: InjectedBugKind,
): Promise<DetectionTrial> {
  if (test.kind === "runner") return detectRunnerDifferential(test, task, executor, targetSource, kind);
  return { kind, detected: false, note: "description-kind 需经差分报告判定(见 detectFromDifferential)" };
}

/** 注入策略:复用 bug-injection.ts。source 为目标源码;className/method 取 entry。
 * 成功时 note 为 undefined;注入失败(方法定位失败等)返回原源码 + note。 */
export function injectBug(source: string, kind: InjectedBugKind, entry: QualityTask["entry"]): { source: string; note?: string } {
  try {
    const injected = injectFineGrainedBug(source, kind, entry.target.className, entry.target.method);
    return { source: injected.source };
  } catch (error) {
    return { source, note: `注入失败:${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 误报判定(描述型):干净目标上出现目标违规即误报。 */
export function falsePositiveFromClean(clean: CleanCheck): { falsePositive: boolean; note?: string } {
  if (clean.report === null) return { falsePositive: false, note: clean.note ?? "clean-unusable" };
  const violations = targetViolations(clean.report);
  return violations.length > 0 ? { falsePositive: true } : { falsePositive: false };
}

/** 误报判定(runner 型):干净冒烟报告的 judge 决策含 translation-bug 即误报。 */
export function falsePositiveFromSmoke(test: GeneratedTest): { falsePositive: boolean; note?: string } {
  const report = test.runner?.report;
  if (!report) return { falsePositive: false, note: "no-report" };
  if (report.cases.length === 0) return { falsePositive: false, note: "no-judge" };
  return { falsePositive: smokeReportHasBugSignal(report) };
}
