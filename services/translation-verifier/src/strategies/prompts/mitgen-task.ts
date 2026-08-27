/**
 * 方向 4「片段级微观测试生成(MitGen)」自主任务提示词(纯函数,可单测)。
 *
 * 报告契约内嵌 MitGenResult(src/mitgen/types.ts)精确字段 + 精简示例 JSON;
 * claude 自主完成后把报告写入工作目录 report.json,写完即结束。
 */
import type { VerifierLanguage } from "../../description.js";
import type { SideFile } from "../../executor.js";
import type { CodeFragment } from "../../mitgen/types.js";

export interface MitgenTaskInput {
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
}

export interface MitgenTaskExtra {
  /** 预提取的片段清单(片段 id / 代码 / 路径条件 / 启发式特征)。 */
  fragments: CodeFragment[];
}

export function buildMitgenTaskPrompt(input: MitgenTaskInput, extra: MitgenTaskExtra): string {
  const fragments = extra.fragments;
  const sourceDesc = input.source.root
    ? input.source.root
    : input.source.files?.map((f) => f.relativePath).join(", ") || "(源码在参考目录内,自行浏览定位)";
  const targetDesc = input.target.root ?? input.target.file ?? input.target.className;
  const staticHint = input.target.isStatic ? "static" : "instance";
  const fragmentLines = fragments
    .map(
      (f) =>
        `- [${f.id}] kind=${f.kind} pathCondition="${f.pathCondition}" features=[${f.features.join(", ")}] score=${f.heuristicScore.toFixed(2)}\n  code: ${f.code}`,
    )
    .join("\n");

  return `You are a MitGen (micro test generation) agent for cross-language code translation.

TASK
You generate targeted test cases for individual fragments (control-flow slices) of the source method, so that each fragment is reached and its behavior is observed on both the source side and the translated target side. Generating per-fragment cases keeps the LLM reasoning burden to "solve one condition at a time" instead of the whole input-to-output mapping.

REQUIREMENT (highest priority)
${input.requirement}

SOURCE SIDE (reference baseline)
- language: ${input.source.language}
- root: ${sourceDesc}

TARGET SIDE (translated artifact under test)
- language: ${input.target.language}
- class: ${input.target.className}
- method: ${input.target.method} (${staticHint})
- root: ${targetDesc}

PRE-EXTRACTED FRAGMENT LIST (from the source method; use these to target test generation)
${fragmentLines || "(无片段,退化为整方法用例生成)"}

WORKFLOW
1. Read the source method and the target translation.
2. For each fragment above, design test inputs that make its path condition true so the fragment is actually reached; cover boundary, empty, and error inputs where the path condition suggests them.
3. Generate a complete test description (schemaVersion "1.0") whose cases carry inputs and declared expected values for the target method; compile and fix the driver until it runs on both sides.
4. Run both sides and record the behavior of each fragment (correspondence: equivalent / missing / divergent / unknown).
5. If a fragment cannot be reached (reachability failed), still record it in the report with its best-effort cases.
6. Write the report (below) to report.json in your working directory, then STOP.

SANDBOX CONSTRAINTS
- The reference directories listed above are READ-ONLY: you may read them but must never edit, rename or delete anything inside them.
- You may only write files inside your working directory (the current directory).
- Never write outside the working directory, never modify the read-only reference directories.

AVAILABLE COMMANDS (Bash whitelist)
You may run these commands in Bash: javac, java, dotnet, python3, tsx, plus standard shell utilities (ls, cat, head, tail, grep, mkdir, cp, rm of files you created).
Prefer absolute tool paths: use $JAVA_HOME/bin/javac and $JAVA_HOME/bin/java (JAVA_HOME is injected into your environment). When JAVA_HOME is unset, fall back to javac/java on PATH.

MITGEN REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (MitGenResult):

{
  "description": {                           // schema 兼容的完整测试描述(直接可喂 verify)
    "schemaVersion": "1.0",
    "requirement": string,
    "target": { "language": "Java"|"C#", "className": string, "method": string, "isStatic": boolean, "constructorArgs": [ <TypedValue> ] },
    "cases": [ { "id": string, "description": string, "branches": [string], "inputs": [ <TypedValue> ], "expected": { "kind": "return"|"exception", "value"?: <TypedValue>, "type"?: string, "messageContains"?: string } } ]
  },
  "fragments": [                              // 片段级报告
    {
      "fragmentId": string,
      "sourceCode": string,
      "correspondence": "equivalent"|"missing"|"divergent"|"unknown",
      "correspondenceNote": string,
      "cases": [ <TestCase> ],               // 该片段生成的整方法用例(与 description.cases 中 id 对应)
      "reachability": "verified"|"failed"|"skipped"
    }
  ]
}

Example (compact):
{"description": {"schemaVersion": "1.0", "requirement": "decode MIME", "target": {"language": "Java", "className": "Mime", "method": "decode", "isStatic": true, "constructorArgs": []}, "cases": [{"id": "c1", "inputs": [], "expected": {"kind": "return", "value": {"type": "string", "value": ""}}}]},
 "fragments": [{"fragmentId": "frag-01", "sourceCode": "if (s == null) return \"\";", "correspondence": "equivalent", "correspondenceNote": "ok", "cases": [], "reachability": "verified"}]}

TERMINATION
Your task is complete once report.json exists in your working directory and is valid JSON matching the schema above. Do not continue working after that. If a fragment cannot be reached, still write report.json with its reachability marked "failed".`;
}
