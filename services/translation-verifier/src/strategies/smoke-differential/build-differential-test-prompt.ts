/**
 * 「冒烟差分验证」自主任务提示词(纯函数,可单测)。
 *
 * 报告契约内嵌 SmokeReport(types.ts)精确字段 + 精简示例 JSON;
 * claude 自主完成后把报告写入工作目录 report.json,写完即结束。
 *
 * mode(默认 "verify-only"):verify-only 禁止目标侧修复(rounds 恒为 0、
 * targetFiles 恒为空,converged 只表示所有差异得到决定性裁决);需要诊断/修复
 * 实验的 E2E 必须显式选择 diagnostic-repair(保留目标修复轮措辞)。
 * 命令代理/路径等运行期上下文由 runner 在宿主侧追加(见 runner.ts)。
 */
import type { SideFile, SmokeMode, VerifierLanguage } from "./differential-test-types.js";

export interface SmokeTaskInput {
  requirement: string;
  /** Analyzer 报告 JSON 字符串(参考;不覆盖需求)。 */
  analysisReport?: string;
  source: {
    language: VerifierLanguage;
    root?: string;
    /** 相对 root 的候选源码文件(提示浏览起点)。 */
    candidatePath?: string;
    /** 兼容 fixture 输入(无 root 的小型 E2E 用)。 */
    files?: SideFile[];
  };
  target: {
    language: VerifierLanguage;
    className: string;
    method: string;
    isStatic: boolean;
    root?: string;
    /** 相对 root 的目标文件。 */
    file?: string;
  };
}

/** verify-only 模式报告的固定约束文案(与 report-schema 深校验一致)。 */
const VERIFY_ONLY_CONTRACT = `{
  "converged": boolean,                       // true = 所有已执行差分都得到决定性裁决(pass/translation-bug/accepted-diff)且无 unclear case;不代表目标被修复
  "steps": number,                            // 已执行步骤数
  "rounds": 0,                                // verify-only:恒为 0,禁止目标侧修复轮
  "cases": [                                  // 每个用例一个条目
    {
      "caseId": string,
      "intent": string,                       // 用例意图描述
      "source": { "caseId": string, "outcome": "return"|"exception", "returnValue": <CanonicalTypedValue|null>, "exceptionType": string|null, "exceptionMessage": string|null } | null,
      "target": <同 source 结构>,
      "mechanical": "pass"|"fail"|"divergent", // 机械差分 verdict
      "decision": "pass"|"translation-bug"|"accepted-diff"|"unclear", // LLM 语义裁决
      "reasoning": string                     // 裁决依据
    }
  ],
  "targetFiles": [],                          // verify-only:恒为空,目标实现绝不修改
  "runnerFiles": [ { "side": "source"|"target", "language": "Java"|"C#"|"Python"|"TypeScript", "files": [ { "path": string, "content": string } ] } ],  // 双侧 runner 文件(必填,含 driver 入口)
  "sourceIssues": [ string ],                 // 源侧疑似缺陷(仅标注,不机械判 fail)
  "executions": [ { "side": "source"|"target", "phase": "compile"|"run", "commandId": string, "exitCode": number|null, "durationMs": number } ],
  "summary": string                           // 整体结论(如 "5/5 用例行为一致")
}`;

export function buildSmokeTaskPrompt(input: SmokeTaskInput, mode: SmokeMode = "verify-only"): string {
  const repairMode = mode === "diagnostic-repair";
  const sourceRoot = input.source.root ?? "(源码项目根目录见 EXECUTION CONTEXT)";
  const sourceDesc = input.source.candidatePath ?? input.source.files?.[0]?.relativePath ?? "(自行浏览)";
  const targetRoot = input.target.root ?? "(目标项目根目录见 EXECUTION CONTEXT)";
  const targetFiles = input.target.file ?? "(自行浏览)";
  const staticHint = input.target.isStatic ? "static" : "instance";

  const workflow = repairMode
    ? `WORKFLOW
1. Read the source module and the target translation to understand both implementations.
2. Design a set of smoke test cases covering normal, boundary and error inputs (intent descriptions only, no golden values).
3. Write runner code for BOTH sides (a compilable driver that runs each case and prints a results JSON), and record all runner files in the report (runnerFiles, see REPORT CONTRACT).
4. Compile and run both sides through the command proxy; if compilation fails, fix the runner (never fabricate compile/run output — only real command output is authoritative).
5. Diff the two sides' observable behavior case by case (mechanical comparison).
6. Judge each difference: pass / translation-bug / accepted-diff / unclear, with reasoning.
7. If the target diverges, propose a fix for the translated target files (record them in targetFiles) and, when the workspace permits, re-run. Limit target-side repair to at most 2 rounds: if it still diverges after 2 rounds, stop repairing and record your verdicts in the report with converged=false.
8. Write the report (below) to report.json in your working directory, then STOP.

DIAGNOSTIC MODE NOTE
This is a diagnostic-repair session: rounds/targetFiles MAY be non-zero because the host explicitly selected diagnostic-repair. This mode is never used for production write-back decisions.`
    : `WORKFLOW (verify-only)
1. Read the source module and the target translation to understand both implementations.
2. Design a set of smoke test cases covering normal, boundary and error inputs (intent descriptions only, no golden values).
3. Write runner code for BOTH sides (a compilable driver that runs each case and prints a results JSON), and record all runner files in the report (runnerFiles, see REPORT CONTRACT). You may repair runner and test harness files whenever they are wrong.
4. Compile and run both sides through the command proxy; if compilation fails, fix the runner and re-run (never fabricate compile/run output — only real command output is authoritative).
5. Diff the two sides' observable behavior case by case (mechanical comparison).
6. Judge each difference: pass / translation-bug / accepted-diff / unclear, with reasoning.
7. Never modify the target implementation. You are verifying a snapshot that belongs to the host; any required change is reported as a translation-bug case and repaired by a separate host-owned translator. There are no target repair rounds in this mode.
8. Write the report (below) to report.json in your working directory, then STOP.

CONVERGED DEFINITION (verify-only)
converged=true means every executed difference received a decisive verdict (pass / translation-bug / accepted-diff) and no case remains unclear. It does NOT mean the target was repaired: verify-only never repairs the target.`;

  const efficiency = repairMode
    ? `EFFICIENCY DISCIPLINE (reduce round trips)
- Combine steps: run multiple shell commands in a single Bash call, and write a side's files in the fewest possible Write calls.
- Do not use task-planning or bookkeeping tools (TaskCreate/TaskUpdate); do the work directly.
- Do not repeatedly re-read runner output files to diagnose a difference: after one mechanical diff, judge every case and either finish or propose fixes in the same pass.
- If the target still diverges after 2 repair rounds, stop and write the report with converged=false and your per-case verdicts (TERMINATION still applies).`
    : `EFFICIENCY DISCIPLINE (reduce round trips)
- Combine steps: run multiple shell commands in a single Bash call, and write a side's files in the fewest possible Write calls.
- Do not use task-planning or bookkeeping tools (TaskCreate/TaskUpdate); do the work directly.
- Do not repeatedly re-read runner output files to diagnose a difference: after one mechanical diff, judge every case and finish.`;
  const decision = `DECISION DISCIPLINE (evidence first)
- Base each decision on observed evidence; re-open a case when a repair or new evidence changes the observed behavior.
- Do not repeat a comparison without a concrete reason.
- If evidence is insufficient, record unclear with the missing evidence and converged=false; never guess a decisive verdict for speed.
- Stop at the earliest valid completion: once report.json exists and is valid, do not run further verification steps.`;

  const reportContract = repairMode
    ? `REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (SmokeReport):

{
  "converged": boolean,                       // true = 差分收敛(所有差异已裁决/修复)
  "steps": number,                            // 已执行步骤数
  "rounds": number,                           // 目标侧修复轮数(诊断模式允许 >0)
  "cases": [
    {
      "caseId": string,
      "intent": string,
      "source": { "caseId": string, "outcome": "return"|"exception", "returnValue": <CanonicalTypedValue|null>, "exceptionType": string|null, "exceptionMessage": string|null } | null,
      "target": <同 source 结构>,
      "mechanical": "pass"|"fail"|"divergent",
      "decision": "pass"|"translation-bug"|"accepted-diff"|"unclear",
      "reasoning": string
    }
  ],
  "targetFiles": [ { "path": string, "content": string } ],  // 修复后的目标文件全文(未采纳不落盘)
  "runnerFiles": [ { "side": "source"|"target", "language": "Java"|"C#"|"Python"|"TypeScript", "files": [ { "path": string, "content": string } ] } ],
  "sourceIssues": [ string ],
  "executions": [ { "side": "source"|"target", "phase": "compile"|"run", "commandId": string, "exitCode": number|null, "durationMs": number } ],
  "summary": string
}`
    : `REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (SmokeReport, verify-only):

${VERIFY_ONLY_CONTRACT}`;

  return `You are a behavior-consistency smoke-test agent for cross-language code translation verification.

TASK
You verify a translation by running smoke tests against BOTH sides and comparing observable behavior. You are a differential detector, not an absolute judge. In verify-only mode you never repair the translation itself.

REQUIREMENT (highest priority)
${input.requirement}

${input.analysisReport ? `ANALYZER REPORT (Analyzer 对候选适用性的判定,参考;不覆盖需求,需求仍是最高优先)
${input.analysisReport}

` : ""}SOURCE SIDE (reference baseline, READ-ONLY)
- language: ${input.source.language}
- project root: ${sourceRoot}
- candidate file: ${sourceDesc}

TARGET SIDE (translated artifact under test, READ-ONLY)
- language: ${input.target.language}
- class: ${input.target.className}
- method: ${input.target.method} (${staticHint})
- project root: ${targetRoot}
- file: ${targetFiles}

${workflow}

${efficiency}

${decision}

TASK TIMING MARKERS (optional observations, never execution evidence)
Before and after each actual task, emit a standalone assistant text line, outside code fences:
[VERIFIER_STEP] {"name":"explore","event":"start"}
[VERIFIER_STEP] {"name":"explore","event":"end"}
Use short lowercase hyphenated names for the work actually performed, such as explore,
design-cases, write-runners, execute-tests, compare, judge, and finalize-report.
Repeat start/end for every repeated task; do not invent missing tasks or timestamps.
Do not write these markers into files or tool output. For finalize-report, emit start before
writing report.json and end immediately after writing it, then STOP. This final end marker
is permitted by TERMINATION and does not request another tool call.

SANDBOX CONSTRAINTS
- The project roots listed above are READ-ONLY: you may read them but must never edit, rename or delete anything inside them.
- You may only write runner files under the two dedicated runner directories given in EXECUTION CONTEXT, plus report.json/steps/evidence files in your working directory.
- Never write anywhere else, never modify the read-only project roots or the target implementation.

AVAILABLE COMMANDS (Bash whitelist)
Bash is restricted to exactly one form: the verifier-command proxy described in EXECUTION CONTEXT. Direct javac/java/dotnet/python3/tsx invocations are not permitted; route every compile and run through the proxy so the host can capture command evidence.

${reportContract}

CANONICAL TYPED VALUE CONTRACT
Every non-null returnValue must be exactly one of these JSON shapes:
- { "type": "string", "value": string }
- { "type": "number", "value": finite JSON number }
- { "type": "boolean", "value": boolean }
- { "type": "null", "value": null }
- { "type": "list", "value": CanonicalTypedValue[] }
- { "type": "map", "value": { [stringKey]: CanonicalTypedValue } }
Use "number" for every numeric language type, including int, integer, long, short, byte, float, double, decimal, BigInteger and BigDecimal. Never emit those language-specific names in the type field.

RUNNER FILES CONTRACT
- Write BOTH sides' complete runner source into runnerFiles (two entries: one per side), including the driver entry.
- Use conventional driver entry paths: Python = driver.py, TypeScript = driver.ts, C# = Driver.cs, Java = the public class file containing main, named <ClassName>.java.
- The source side entry path is "source", the target side entry path is "target".

EXECUTION EVIDENCE CONTRACT
- After each proxied compile/run, read the last line of commands.jsonl (in your working directory) and copy its commandId together with side/phase/exitCode/durationMs into the report executions entry.
- Never invent commandIds or exit codes: only values the proxy actually logged are valid evidence.

Example (compact):
{"converged": true, "steps": 18, "rounds": 0,
 "cases": [{"caseId": "c1", "intent": "空串输入", "source": {"caseId": "c1", "outcome": "return", "returnValue": {"type": "string", "value": ""}}, "target": {"caseId": "c1", "outcome": "return", "returnValue": {"type": "string", "value": ""}}, "mechanical": "pass", "decision": "pass", "reasoning": "双侧输出一致"}],
 "targetFiles": [], "sourceIssues": [],
 "runnerFiles": [{"side": "source", "language": "Java", "files": [{"path": "SmokeDriver.java", "content": "..."}]}, {"side": "target", "language": "C#", "files": [{"path": "Driver.cs", "content": "..."}]}],
 "executions": [{"side": "source", "phase": "compile", "commandId": "uuid-1", "exitCode": 0, "durationMs": 1200}],
 "summary": "5/5 用例行为一致"}

TERMINATION
Your task is complete once report.json exists in your working directory and is valid JSON matching the schema above. Emit the finalize-report end marker, then stop; do not perform further work. If you cannot complete the verification, still write a report.json with converged=false and an explanatory summary.`;
}
