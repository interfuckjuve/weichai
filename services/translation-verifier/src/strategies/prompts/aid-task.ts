/**
 * 方向 3「变体差分验证(AID)」自主任务提示词(纯函数,可单测)。
 *
 * 报告契约内嵌 AIDVerificationReport(src/aid/aid-verifier.ts)精确字段 + 精简示例 JSON;
 * claude 自主完成后把报告写入工作目录 report.json,写完即结束。
 */
import type { VerifierLanguage } from "../../description.js";
import type { SideFile } from "../../executor.js";

export interface AidTaskInput {
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

export interface AidTaskExtra {
  /** 预生成变体目录(工作目录下 variants/;claude 需读取并在其上编译/差分/共识)。 */
  variantsDir: string;
}

export function buildAidTaskPrompt(input: AidTaskInput, extra: AidTaskExtra): string {
  const variantsDir = extra.variantsDir;
  const sourceDesc = input.source.root
    ? input.source.root
    : input.source.files?.map((f) => f.relativePath).join(", ") || "(源码在参考目录内,自行浏览定位)";
  const targetDesc = input.target.root ?? input.target.file ?? input.target.className;
  const staticHint = input.target.isStatic ? "static" : "instance";

  return `You are an AID (alternative-implementation differential) verification agent for cross-language code translation.

TASK
You verify the translated target implementation against a reference group: the source method PLUS pre-generated alternative variants of the source. The reference group forms a consensus oracle; the target is compared against that consensus per input. You are a differential detector: you only flag differences between the target and the consensus, and you annotate cases where the reference group itself disagrees (disputed) or the consensus conflicts with the declared expectation.

REQUIREMENT (highest priority)
${input.requirement}

SOURCE SIDE (reference baseline, read-only)
- language: ${input.source.language}
- root: ${sourceDesc}

PRE-GENERATED VARIANTS (read from this directory: each is an alternative source-language implementation)
- variants dir: ${variantsDir}

TARGET SIDE (translated artifact under test)
- language: ${input.target.language}
- class: ${input.target.className}
- method: ${input.target.method} (${staticHint})
- root: ${targetDesc}

WORKFLOW
1. Read the source method, the target translation, and the variants in the variants directory.
2. Compile each variant and the source; drop variants that fail to compile or behave inconsistently on a base input set (keep only usable reference sides).
3. Generate a batch of inputs (cover normal, boundary, error). Execute the reference group (source + kept variants) on the batch.
4. Build a consensus oracle (an input is decided by the majority of the reference group; if they disagree it is disputed).
5. Execute the target on the same batch and compare against the consensus case by case (pass / fail / divergent[=disputed]).
6. Record conflicts where the consensus differs from the declared expectation of a base case.
7. Write the report (below) to report.json in your working directory, then STOP.

SANDBOX CONSTRAINTS
- The reference directories listed above are READ-ONLY: you may read them but must never edit, rename or delete anything inside them.
- The variants directory is inside your working directory: you may read it, but do not modify the variant files themselves.
- You may only write new files inside your working directory (the current directory).

AVAILABLE COMMANDS (Bash whitelist)
You may run these commands in Bash: javac, java, dotnet, python3, tsx, plus standard shell utilities (ls, cat, head, tail, grep, mkdir, cp, rm of files you created).
Prefer absolute tool paths: use $JAVA_HOME/bin/javac and $JAVA_HOME/bin/java (JAVA_HOME is injected into your environment). When JAVA_HOME is unset, fall back to javac/java on PATH.

AID REPORT CONTRACT
Write a single JSON file named report.json in your working directory, strictly matching this schema (AIDVerificationReport):

{
  "schemaVersion": "1.1",
  "variants": [ { "code": string, "side": <SideSpec>, "passes": boolean, "reason": string } ],  // 过滤后变体(含被剔除者与原因)
  "oracleSummary": { "consensusCount": number, "disputedCount": number },
  "comparisons": [ { "caseId": string, "verdict": "pass"|"fail"|"divergent", "source": <CaseResult|null>, "target": <CaseResult|null>, "details": [string] } ],
  "passRate": number,                        // passedCases / totalCases
  "totalCases": number,
  "passedCases": number,
  "failedCases": number,
  "disputedCases": number,                   // 低置信 case 数(divergent 中 disputed 标注者)
  "consensusExpectedConflicts": [string],    // 共识 vs 声明 expected 冲突的 caseId
  "baseline": {                              // 可重放干净基线
    "schemaVersion": "1.1",
    "description": <TestDescription>,
    "batchDescription": <TestDescription>,
    "variants": [ <FilteredVariant> ],
    "oracle": [ <ConsensusOracle> ],
    "consensusOptions": <ConsensusOptions>,
    "cleanTarget": { "usable": boolean, "note": string },   // clean 目标是否完整执行了全部 case
    "cleanFailedCaseIds": [string]
  }
}

Example (compact):
{"schemaVersion": "1.1", "variants": [{"code": "class V {}", "side": {"language": "Java", "driverSource": "", "sourceFiles": []}, "passes": true}], "oracleSummary": {"consensusCount": 3, "disputedCount": 0}, "comparisons": [{"caseId": "c1", "verdict": "pass", "source": null, "target": null, "details": []}], "passRate": 1, "totalCases": 1, "passedCases": 1, "failedCases": 0, "disputedCases": 0, "consensusExpectedConflicts": [], "baseline": {"schemaVersion": "1.1", "description": {}, "batchDescription": {}, "variants": [], "oracle": [], "consensusOptions": {}, "cleanTarget": {"usable": true}, "cleanFailedCaseIds": []}}

TERMINATION
Your task is complete once report.json exists in your working directory and is valid JSON matching the schema above. Do not continue working after that. If the clean target could not be fully executed, still write a report.json with baseline.cleanTarget.usable=false, an explanatory note, and any comparisons you did collect.`;
}
