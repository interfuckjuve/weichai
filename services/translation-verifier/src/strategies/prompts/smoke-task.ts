/**
 * 方向 1「Agent 冒烟测试 + 行为一致性自修复」自主任务提示词(纯函数,可单测)。
 *
 * 报告契约内嵌 SmokeReport(src/smoke-types.ts)精确字段 + 精简示例 JSON;
 * claude 自主完成后把报告写入工作目录 report.json,写完即结束。
 */
import type { VerifierLanguage } from "../../description.js";
import type { SideFile } from "../../executor.js";

export interface SmokeTaskInput {
  requirement: string;
  source: { language: VerifierLanguage; root?: string; files?: SideFile[] };
  target: {
    language: VerifierLanguage;
    className: string;
    method: string;
    isStatic: boolean;
    root?: string;
    file?: string;
  };
  /** Analyzer 报告 JSON 字符串(参考;不覆盖需求)。 */
  analysisReport?: string;
}

export function buildSmokeTaskPrompt(input: SmokeTaskInput): string {
  const sourceDesc = input.source.root
    ? input.source.root
    : input.source.files?.map((f) => f.relativePath).join(", ") || "(源码在参考目录内,自行浏览定位)";
  const targetDesc = input.target.root ?? input.target.file ?? input.target.className;
  const sourceFiles = input.source.files?.map((f) => f.relativePath).join(", ") || "(自行浏览)";
  const targetFiles = input.target.file ?? "(自行浏览)";
  const staticHint = input.target.isStatic ? "static" : "instance";

  return `You are a behavior-consistency smoke-test agent for cross-language code translation verification.

TASK
You verify a translation by running smoke tests against BOTH sides, comparing observable behavior, and repairing the translation when needed. You are a differential detector, not an absolute judge.

REQUIREMENT (highest priority)
${input.requirement}

${input.analysisReport ? `ANALYZER REPORT (Analyzer 对候选适用性的判定,参考;不覆盖需求,需求仍是最高优先)
${input.analysisReport}

` : ""}SOURCE SIDE (reference baseline)
- language: ${input.source.language}
- root: ${sourceDesc}
- files: ${sourceFiles}

TARGET SIDE (translated artifact under test)
- language: ${input.target.language}
- class: ${input.target.className}
- method: ${input.target.method} (${staticHint})
- root: ${targetDesc}
- file: ${targetFiles}

WORKFLOW
1. Read the source module and the target translation to understand both implementations.
2. Design a set of smoke test cases covering normal, boundary and error inputs (intent descriptions only, no golden values).
3. Write runner code for BOTH sides (a compilable driver that runs each case and prints a results JSON), and record all runner files in the report (runnerFiles, see REPORT CONTRACT).
4. Compile and run both sides; if compilation fails, fix the runner (never fabricate compile/run output — only real command output is authoritative).
5. Diff the two sides' observable behavior case by case (mechanical comparison).
6. Judge each difference: pass / translation-bug / accepted-diff / unclear, with reasoning.
7. If the target diverges, propose a fix for the translated target files and re-run; repeat until converged or you decide it cannot converge.
8. Write the report (below) to report.json in your working directory, then STOP.

SANDBOX CONSTRAINTS
- The reference directories listed above are READ-ONLY: you may read them but must never edit, rename or delete anything inside them.
- You may only write files inside your working directory (the current directory).
- Never write outside the working directory, never modify the read-only reference directories.

AVAILABLE COMMANDS (Bash whitelist)
You may run these commands in Bash: javac, java, dotnet, python3, tsx, plus standard shell utilities (ls, cat, head, tail, grep, mkdir, cp, rm of files you created).
Prefer absolute tool paths: use $JAVA_HOME/bin/javac and $JAVA_HOME/bin/java (JAVA_HOME is injected into your environment). When JAVA_HOME is unset, fall back to javac/java on PATH.

REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (SmokeReport):

{
  "converged": boolean,                       // true = 差分收敛(所有差异已裁决/修复)
  "steps": number,                            // 已执行步骤数
  "rounds": number,                           // 目标侧修复轮数
  "cases": [                                  // 每个用例一个条目
    {
      "caseId": string,
      "intent": string,                       // 用例意图描述
      "source": { "caseId": string, "outcome": "return"|"exception", "returnValue": <TypedValue|null>, "exceptionType": string|null, "exceptionMessage": string|null } | null,
      "target": <同 source 结构>,
      "mechanical": "pass"|"fail"|"divergent", // 机械差分 verdict
      "decision": "pass"|"translation-bug"|"accepted-diff"|"unclear", // LLM 语义裁决
      "reasoning": string                     // 裁决依据
    }
  ],
  "targetFiles": [ { "path": string, "content": string } ],  // 修复后的目标文件全文(未采纳不落盘)
  "runnerFiles": [ { "side": "source"|"target", "language": "Java"|"C#"|"Python"|"TypeScript", "files": [ { "path": string, "content": string } ] } ],  // 双侧 runner 文件(必填,含 driver 入口)
  "sourceIssues": [ string ],                 // 源侧疑似缺陷(仅标注,不机械判 fail)
  "summary": string                           // 整体结论(如 "5/5 用例行为一致")
}

RUNNER FILES CONTRACT
- Write BOTH sides' complete runner source into runnerFiles (two entries: one per side), including the driver entry.
- Use conventional driver entry paths: Python = driver.py, TypeScript = driver.ts, C# = Driver.cs, Java = the public class file containing main, named <ClassName>.java.
- The source side entry path is "source", the target side entry path is "target".

Example (compact):
{"converged": true, "steps": 18, "rounds": 1,
 "cases": [{"caseId": "c1", "intent": "空串输入", "source": {"caseId": "c1", "outcome": "return", "returnValue": {"type": "string", "value": ""}}, "target": {"caseId": "c1", "outcome": "return", "returnValue": {"type": "string", "value": ""}}, "mechanical": "pass", "decision": "pass", "reasoning": "双侧输出一致"}],
 "targetFiles": [], "sourceIssues": [],
 "runnerFiles": [{"side": "source", "language": "Java", "files": [{"path": "SmokeDriver.java", "content": "..."}, {"path": "MimeDecoder.java", "content": "..."}]}, {"side": "target", "language": "C#", "files": [{"path": "Driver.cs", "content": "..."}, {"path": "MimeDecoder.cs", "content": "..."}]}],
 "summary": "5/5 用例行为一致"}

TERMINATION
Your task is complete once report.json exists in your working directory and is valid JSON matching the schema above. Do not continue working after that. If you cannot complete the verification, still write a report.json with converged=false and an explanatory summary.`;
}
