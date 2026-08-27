/**
 * 冒烟验证阶段化提示词(纯函数,可单测)。
 *
 * 统一 system 前缀声明:角色、工具 JSON 文本协议、runner 契约、输出协议、
 * 需求第一原则、不可伪造运行结果(一切以 compile/run 真实输出为准)。
 *
 * 阶段(2.6):
 *   0 任务简报(buildBriefingPrompt)→ 1 源码探索 + 用例设计(buildPlanPrompt)
 *   → 2 runner 生成(buildWriteRunnerPrompt)→ 3 编译修复循环(buildCompilePrompt 等)
 *   → 4 一致性判断(buildJudgePrompt)→ 5 修复闭环(buildFixPrompt)
 * 多轮对话采用 stateless replay:history 全量重放,当前阶段指令由控制器
 * (SmokeAgent)按状态派生后经 buildTurnPrompt 组装。
 */
import type { CaseComparison } from "../comparator.js";
import type { TargetLanguage, VerifierLanguage } from "../description.js";
import type { SmokeCasePlan, SmokeSide } from "./smoke-types.js";

/** 任务简报:用户输入 + 双侧签名 + 目录结构预览(agent 也可自行 read_file 核实)。 */
export interface SmokeTaskBrief {
  requirement: string;
  sourceLang: VerifierLanguage;
  targetLang: TargetLanguage;
  /** 源侧根目录(绝对路径)。 */
  sourceRoot: string;
  /** 目标侧根目录(绝对路径)。 */
  targetRoot: string;
  /** 源侧模块文件(相对路径)。 */
  sourceFiles: string[];
  /** 目标侧模块文件(相对路径)。 */
  targetFiles: string[];
  targetClass?: string;
  targetMethod?: string;
  maxSteps: number;
  maxRounds: number;
}

export const SMOKE_SYSTEM_PROMPT = `You are a behavior-consistency smoke-test agent for code translation verification.
Your job: run smoke tests against BOTH the source-side module and the translated target-side module,
compare their observable behavior, decide whether any difference is a translation bug, and fix the
translation when needed. You are a differential detector, not a judge of absolute correctness.

TOOL PROTOCOL
You drive the verification loop by emitting exactly ONE JSON tool action per response, no markdown:
{"action": "<tool-name>", "params": {...}}
Available tools: list_files, read_file, plan_smoke, write_runner, compile_runner, run_runner,
compare, judge, propose_target_fix, propose_runner_fix, finish.
After every action you receive a text observation. Never fabricate compile/run results: only the
compile_runner / run_runner observations are authoritative.

RUNNER CONTRACT
You write the smoke-test programs (runners) yourself, one set per side, via write_runner.
- Python side: entry file must be "driver.py" (top-level script; module files travel alongside).
- TypeScript side: entry file must be "driver.ts" (top-level script; module files travel alongside).
- C# side: entry file must be "Driver.cs" declaring exactly one public class X with X.Main as entry.
- Java side: entry must be a file "<ClassName>.java" declaring "public class <ClassName>" that
  contains "public static void main(String[] args)"; the tested classes are separate module files.
- The runner must catch exceptions per case and NEVER crash the process.

OUTPUT PROTOCOL
Each runner prints a single JSON object to stdout:
{"results":[{"caseId":"c01","outcome":"return","returnValue":{"type":"string","value":"..."}},
            {"caseId":"c02","outcome":"exception","exceptionType":"...","exceptionMessage":"..."}]}
caseId values must match your plan_smoke case ids 1:1 on BOTH sides. returnValue is a typed value
(type: string|number|boolean|null|list|map).

PRIORITY RULES
1. The user REQUIREMENT is the highest priority.
2. The source side is the behavioral reference baseline; you never modify it.
3. If both sides agree but both deviate from the requirement, record a source-side concern in
   judge (sourceIssues) instead of mechanically failing the target.
4. Never declare a case pass/fail without real compile_runner / run_runner observations.`;

/** 阶段 0:任务简报(进入 history,作为 stateless replay 的初始上下文)。 */
export function buildBriefingPrompt(brief: SmokeTaskBrief): string {
  const targetSig = brief.targetClass
    ? `${brief.targetClass}${brief.targetMethod ? `.${brief.targetMethod}` : ""}`
    : "(未指定,请用 read_file 自行核实目标类/方法签名)";
  return `TASK BRIEFING
REQUIREMENT
${brief.requirement}

SIGNATURES
- source side: language=${brief.sourceLang}, root=${brief.sourceRoot}
  module files: ${brief.sourceFiles.length > 0 ? brief.sourceFiles.join(", ") : "(空)"}
- target side: language=${brief.targetLang}, root=${brief.targetRoot}
  module files: ${brief.targetFiles.length > 0 ? brief.targetFiles.join(", ") : "(空)"}
  target signature: ${targetSig}

BUDGET
- maxSteps=${brief.maxSteps}, maxRounds=${brief.maxRounds} (repair rounds)
- Use list_files / read_file to inspect the source module before designing cases.
- Plan 5-15 smoke cases with an intent description each (normal, boundary, error, object-state paths).
  Cases need no expected golden values: consistency is judged by differential + semantic reasoning.`;
}

/** 阶段 1:源码探索 + 冒烟用例设计指令。 */
export function buildPlanPrompt(args: { brief: SmokeTaskBrief }): string {
  return `STAGE 1: EXPLORE SOURCE AND DESIGN SMOKE CASES
First use list_files / read_file to read the source module methods, then call plan_smoke with
5-15 cases. Each case: {"id": "...", "intent": "natural-language intent description"}.
Cover: normal path, boundaries (empty/zero/extremes/very long/empty collections), error paths
(invalid input), and object construction / state dependencies where present. Existing source tests,
if any, may inspire cases. No expected values are required — intent only. Do not run anything yet.`;
}

/** 阶段 2:runner 生成指令(附契约表与输出协议示例)。 */
export function buildWriteRunnerPrompt(args: {
  brief: SmokeTaskBrief;
  plan: SmokeCasePlan[];
  missingSides: SmokeSide[];
}): string {
  const sideNames = args.missingSides.map((s) => (s === "source" ? "源侧(source)" : "目标侧(target)")).join("、");
  const planLines = args.plan.map((c) => `- ${c.id}: ${c.intent}`).join("\n");
  return `STAGE 2: WRITE RUNNERS (${sideNames})
Implement the smoke-test program for the requested side(s) via write_runner: {"action":"write_runner",
"params":{"side":"source|target","language":"...","files":[{"path":"...","content":"..."}]}}.

PLAN (case ids must match EXACTLY)
${planLines}

RUNNER CONTRACT
- Python: entry "driver.py"; TypeScript: entry "driver.ts"; C#: entry "Driver.cs" with one public class X { public static void Main };
  Java: entry "<ClassName>.java" with public class + "public static void main(String[] args)".
- The tested module files are already provided on the compile path; import/reference them directly
  (source side = the source module; target side = the translated class/method whose signature you
  learned in stage 1).
- Per-case try/catch: exceptions are reported as exception results, never crash the process.

OUTPUT PROTOCOL (printed to stdout, exactly one JSON object)
{"results":[{"caseId":"c01","outcome":"return","returnValue":{"type":"string","value":"..."}},
            {"caseId":"c02","outcome":"exception","exceptionType":"...","exceptionMessage":"..."}]}`;
}

/** 阶段 3:编译指令。 */
export function buildCompilePrompt(args: { side: SmokeSide }): string {
  const label = args.side === "source" ? "源侧(source)" : "目标侧(target)";
  return `STAGE 3: COMPILE ${label}
Call compile_runner {"action":"compile_runner","params":{"side":"${args.side}"}}.
If compilation fails, read the error lines in the observation, fix the runner with write_runner,
and compile again (up to 3 attempts per side). Do not proceed to run_runner until compile succeeds.`;
}

/** 阶段 3b:运行指令。 */
export function buildRunPrompt(args: { side: SmokeSide }): string {
  const label = args.side === "source" ? "源侧(source)" : "目标侧(target)";
  return `STAGE 3b: RUN ${label}
Call run_runner {"action":"run_runner","params":{"side":"${args.side}"}}.
If the output has parse errors or missing cases, fix the runner output format with write_runner
and recompile. Only real run observations count.`;
}

/** 阶段 4 前:差分比较指令。 */
export function buildComparePrompt(): string {
  return `STAGE 4: COMPARE
Both sides ran successfully. Call compare {"action":"compare","params":{}} to get the mechanical differential verdicts (pass/fail/divergent) per case. Then reason about the differences in judge.`;
}

/** 阶段 4:一致性判断指令(机械差分 + 语义裁决)。 */
export function buildJudgePrompt(args: {
  brief: SmokeTaskBrief;
  plan: SmokeCasePlan[];
  comparisons: CaseComparison[];
  round: number;
  maxRounds: number;
}): string {
  const lines = args.comparisons.map((c) => {
    const base = `[${c.caseId}] ${c.verdict}`;
    return c.verdict === "pass" ? base : `${base}: ${c.details.join(" | ")}`;
  });
  return `STAGE 4: SEMANTIC JUDGMENT
Mechanical differential results (source vs target):
${lines.join("\n")}

Decide each case with judge: {"action":"judge","params":{"verdicts":[{"caseId":"...","decision":
"pass|translation-bug|accepted-diff|unclear","reasoning":"..."}],"sourceIssues":["..."]}}
- pass: behaviors match and satisfy the requirement.
- translation-bug: the target side deviates and the deviation is a translation error (fix needed).
- accepted-diff: acceptable difference (exception message wording, collection order, float precision,
  explicit null guards, etc.) — justify with reasoning.
- unclear: cannot decide; this counts as not converged.
- If both sides agree but both deviate from the requirement, record the source-side concern in
  sourceIssues instead of marking the target translation-bug.
Read source/target code with read_file first when evidence is needed. Mechanically-passing cases may
be bulk-confirmed. Round=${args.round}/${args.maxRounds}.`;
}

/** 阶段 5:修复闭环指令(仅对 translation-bug 的 case 发起)。 */
export function buildFixPrompt(args: {
  brief: SmokeTaskBrief;
  plan: SmokeCasePlan[];
  comparisons: CaseComparison[];
  bugCaseIds: string[];
  sourceModuleText: string;
  targetFilesText: string;
  round: number;
  maxRounds: number;
}): string {
  const bugLines = args.comparisons
    .filter((c) => args.bugCaseIds.includes(c.caseId))
    .map((c) => `[${c.caseId}] ${c.verdict}: ${c.details.join(" | ")}`)
    .join("\n");
  return `STAGE 5: FIX TRANSLATION (round ${args.round}/${args.maxRounds})
The following cases were judged translation-bug:
${bugLines}

REQUIREMENT
${args.brief.requirement}

SOURCE MODULE (reference baseline, do not modify)
\`\`\`
${truncateText(args.sourceModuleText, 30_000)}
\`\`\`

CURRENT TARGET FILES (fix these; output COMPLETE files, not method-body snippets)
\`\`\`
${truncateText(args.targetFilesText, 30_000)}
\`\`\`

Call propose_target_fix: {"action":"propose_target_fix","params":{"files":[{"path":"...",
"content":"<COMPLETE fixed file content>"}]}}. The controller will recompile, rerun, and
re-diff automatically. If you believe the runner (test program) itself is wrong, use
propose_runner_fix instead. Never modify the source side. If you reach the round limit, call
finish with a clear summary.`;
}

/** 收尾指令。 */
export function buildFinishPrompt(): string {
  return `STAGE 6: FINISH
Call finish: {"action":"finish","params":{"summary":"<overall summary>",
"verdicts":[optional final per-case decisions]}}. The report is assembled by the controller.
If some cases are still translation-bug/unclear, the report will be marked not converged.`;
}

/** 多轮组装:system + 当前阶段指令 + 全量 history(stateless replay)。 */
export function buildTurnPrompt(system: string, history: string[], instruction: string): string {
  const historyText = history.length > 0 ? `CONVERSATION_HISTORY (previous turns, replayed)\n${history.join("\n\n")}` : "(no history yet)";
  return `${system}\n\nCURRENT_INSTRUCTION\n${instruction}\n\n${historyText}`;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
