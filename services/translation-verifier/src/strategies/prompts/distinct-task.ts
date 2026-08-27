/**
 * 方向 2「分支一致性验证(DISTINCT)」自主任务提示词(纯函数,可单测)。
 *
 * 报告契约内嵌 ConsistencyResult(src/distinct/consistency-verifier-types.ts)精确字段 + 精简示例 JSON;
 * claude 自主完成后把报告写入工作目录 report.json,写完即结束。
 */
import type { VerifierLanguage } from "../../description.js";
import type { SideFile } from "../../executor.js";

export interface DistinctTaskInput {
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

export function buildDistinctTaskPrompt(input: DistinctTaskInput): string {
  const sourceDesc = input.source.root
    ? input.source.root
    : input.source.files?.map((f) => f.relativePath).join(", ") || "(源码在参考目录内,自行浏览定位)";
  const targetDesc = input.target.root ?? input.target.file ?? input.target.className;
  const sourceFiles = input.source.files?.map((f) => f.relativePath).join(", ") || "(自行浏览)";
  const targetFiles = input.target.file ?? "(自行浏览)";
  const staticHint = input.target.isStatic ? "static" : "instance";

  return `You are a branch-consistency verification agent (DISTINCT) for cross-language code translation.

TASK
You verify that the translated target implementation is consistent with the source implementation branch by branch, and that every branch is covered by executable tests with assertions aligned to the REQUIREMENT (not merely to the source implementation). You are a differential detector plus a natural-language-defect (NLD) analyzer; when both sides agree but both diverge from the requirement, flag it.

REQUIREMENT (highest priority)
${input.requirement}

SOURCE SIDE (reference baseline)
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
1. Read both implementations and enumerate the branch structure of the source method (conditions, guards, loop headers, switch cases).
2. Generate executable test cases targeting every branch; compile and fix them until the driver runs on both sides.
3. Run both sides, diff the observable behavior case by case (mechanical differential verification).
4. Analyze each case against the REQUIREMENT semantics: mark cases where the assertion diverges from the requirement (flag-fail / fix-assertion / add-case).
5. Compute branch coverage: covered / uncovered branches. If coverage has gaps and you can add cases, add them and re-verify.
6. Write the report (below) to report.json in your working directory, then STOP.

SANDBOX CONSTRAINTS
- The reference directories listed above are READ-ONLY: you may read them but must never edit, rename or delete anything inside them.
- You may only write files inside your working directory (the current directory).
- Never write outside the working directory, never modify the read-only reference directories.

AVAILABLE COMMANDS (Bash whitelist)
You may run these commands in Bash: javac, java, dotnet, python3, tsx, plus standard shell utilities (ls, cat, head, tail, grep, mkdir, cp, rm of files you created).
Prefer absolute tool paths: use $JAVA_HOME/bin/javac and $JAVA_HOME/bin/java (JAVA_HOME is injected into your environment). When JAVA_HOME is unset, fall back to javac/java on PATH.

CONSISTENCY REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (ConsistencyResult):

{
  "report": {                                // 差分验证报告(现有 verify 双轨)
    "schemaVersion": "1.0",
    "source": <SideRunInfo>,                 // { language, compile: {success,errors,output}, run: {exitCode,stdout,stderr}|null, results: {side,results,rawStdout,parseErrors}|null }
    "target": <SideRunInfo>,
    "comparisons": [ { "caseId": string, "verdict": "pass"|"fail"|"divergent", "source": <CaseResult|null>, "target": <CaseResult|null>, "details": [string] } ],
    "passRate": number,
    "totalCases": number,
    "passedCases": number,
    "failedCases": number,
    "divergentCases": number
  },
  "consistency": {                           // 分支一致性分析
    "inventory": { "methodId": string, "methodSummary": string, "branches": [ { "id": string, "condition": string, "semantics": string, "nldConsistent": boolean } ] },
    "cases": [ { "caseId": string, "touchedBranches": [string], "assertionConsistent": boolean, "nldVerdict": "conforms"|"diverges"|"unverified", "recommend": "ok"|"flag-fail"|"fix-assertion"|"add-case", "reasons": [string] } ],
    "coverage": { "covered": [string], "uncovered": [string] },
    "augmentations": [ <TestCase> ]         // 覆盖缺口补测生成的新 case(未补测则为空数组)
  },
  "augmented": boolean                        // 是否发生了补测并入后的重验
}

Example (compact):
{"report": {"schemaVersion": "1.0", "source": {"language": "Java", "compile": {"success": true, "errors": [], "output": ""}, "run": null, "results": null}, "target": {"language": "C#", "compile": {"success": true, "errors": [], "output": ""}, "run": null, "results": null}, "comparisons": [{"caseId": "c1", "verdict": "pass", "source": null, "target": null, "details": []}], "passRate": 1, "totalCases": 1, "passedCases": 1, "failedCases": 0, "divergentCases": 0},
 "consistency": {"inventory": {"methodId": "StringUtils.Split", "methodSummary": "按分隔符拆分", "branches": []}, "cases": [], "coverage": {"covered": [], "uncovered": []}, "augmentations": []},
 "augmented": false}

TERMINATION
Your task is complete once report.json exists in your working directory and is valid JSON matching the schema above. Do not continue working after that. If you cannot complete the verification, still write a report.json with failedCases set and an explanatory summary inside report.`;
}
