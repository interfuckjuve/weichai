import { describe, expect, it } from "vitest";
import type { CaseComparison } from "../comparator.js";
import type { SmokeCasePlan } from "./smoke-types.js";
import {
  SMOKE_SYSTEM_PROMPT,
  buildBriefingPrompt,
  buildComparePrompt,
  buildCompilePrompt,
  buildFinishPrompt,
  buildFixPrompt,
  buildJudgePrompt,
  buildPlanPrompt,
  buildRunPrompt,
  buildTurnPrompt,
  buildWriteRunnerPrompt,
  type SmokeTaskBrief,
} from "./smoke-prompts.js";

const brief: SmokeTaskBrief = {
  requirement: "解码 MIME 编码文本,非编码文本原样返回",
  sourceLang: "C#",
  targetLang: "Java",
  sourceRoot: "/abs/src",
  targetRoot: "/abs/tgt",
  sourceFiles: ["MimeUtility.cs"],
  targetFiles: ["MimeUtility.java"],
  targetClass: "org.apache.commons.fileupload.util.mime.MimeUtility",
  targetMethod: "decodeText",
  maxSteps: 40,
  maxRounds: 3,
};

const plan: SmokeCasePlan[] = [
  { id: "plain", intent: "非编码文本原样返回" },
  { id: "null-input", intent: "null 输入抛异常" },
];

const comparisons: CaseComparison[] = [
  {
    caseId: "plain",
    verdict: "pass",
    source: { caseId: "plain", outcome: "return", returnValue: { type: "string", value: "hello" } },
    target: { caseId: "plain", outcome: "return", returnValue: { type: "string", value: "hello" } },
    details: [],
  },
  {
    caseId: "null-input",
    verdict: "fail",
    source: { caseId: "null-input", outcome: "exception", exceptionType: "NullReferenceException", exceptionMessage: "" },
    target: { caseId: "null-input", outcome: "return", returnValue: { type: "string", value: "buggy" } },
    details: ["behavior divergence: source exception NullReferenceException but target return"],
  },
];

describe("SMOKE_SYSTEM_PROMPT", () => {
  it("包含角色、工具协议、runner 契约、输出协议、需求第一、不可伪造运行结果", () => {
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/behavior-consistency smoke-test agent/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/\{"action": "<tool-name>"/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/list_files, read_file, plan_smoke/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/propose_target_fix/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/driver\.py/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/Driver\.cs/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/driver\.ts/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/"results":\[/);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/REQUIREMENT is the highest priority/i);
    expect(SMOKE_SYSTEM_PROMPT).toMatch(/Never fabricate compile\/run results/);
  });
});

describe("阶段提示词构建", () => {
  it("buildBriefingPrompt 含需求/签名/文件清单/预算", () => {
    const text = buildBriefingPrompt(brief);
    expect(text).toContain(brief.requirement);
    expect(text).toContain("C#");
    expect(text).toContain("Java");
    expect(text).toContain("MimeUtility.cs");
    expect(text).toContain("MimeUtility.java");
    expect(text).toContain("maxSteps=40");
    expect(text).toContain("maxRounds=3");
    expect(text).toContain("org.apache.commons.fileupload.util.mime.MimeUtility.decodeText");
    expect(text).toMatch(/no expected golden values/i);
  });

  it("buildPlanPrompt 要求先探索源码再 plan,用例只需意图无需 expected", () => {
    const text = buildPlanPrompt({ brief });
    expect(text).toMatch(/list_files \/ read_file/);
    expect(text).toMatch(/plan_smoke/);
    expect(text).toMatch(/5-15/);
    expect(text).toMatch(/No expected values are required/);
  });

  it("buildWriteRunnerPrompt 含计划 caseId 列表与 runner 契约/输出协议", () => {
    const text = buildWriteRunnerPrompt({ brief, plan, missingSides: ["target"] });
    expect(text).toContain("目标侧(target)");
    expect(text).toContain("- plain: 非编码文本原样返回");
    expect(text).toContain("case ids must match EXACTLY");
    expect(text).toMatch(/Driver\.cs/);
    expect(text).toContain('"caseId":"c01"');
  });

  it("buildCompilePrompt / buildRunPrompt 指明具体侧", () => {
    expect(buildCompilePrompt({ side: "source" })).toMatch(/compile_runner/);
    expect(buildCompilePrompt({ side: "source" })).toContain("源侧(source)");
    expect(buildRunPrompt({ side: "target" })).toMatch(/run_runner/);
    expect(buildRunPrompt({ side: "target" })).toContain("目标侧(target)");
  });

  it("buildComparePrompt 引导先差分再裁决", () => {
    const text = buildComparePrompt();
    expect(text).toMatch(/compare/);
    expect(text).toMatch(/mechanical differential verdicts/);
  });

  it("buildJudgePrompt 含逐 case 差分结果与四种裁决选项与源侧缺陷标注", () => {
    const text = buildJudgePrompt({ brief, plan, comparisons, round: 1, maxRounds: 3 });
    expect(text).toContain("[plain] pass");
    expect(text).toContain("[null-input] fail");
    expect(text).toMatch(/behavior divergence/);
    expect(text).toMatch(/translation-bug/);
    expect(text).toMatch(/accepted-diff/);
    expect(text).toMatch(/unclear/);
    expect(text).toMatch(/sourceIssues/);
  });

  it("buildFixPrompt 含需求/源模块全文/当前目标文件全文/失败 case 差异", () => {
    const text = buildFixPrompt({
      brief,
      plan,
      comparisons,
      bugCaseIds: ["null-input"],
      sourceModuleText: "public static class MimeUtility { /* src */ }",
      targetFilesText: "public class MimeUtility { /* tgt */ }",
      round: 1,
      maxRounds: 3,
    });
    expect(text).toContain(brief.requirement);
    expect(text).toContain("public static class MimeUtility { /* src */ }");
    expect(text).toContain("public class MimeUtility { /* tgt */ }");
    expect(text).toContain("[null-input] fail");
    expect(text).toMatch(/propose_target_fix/);
    expect(text).toMatch(/propose_runner_fix/);
    expect(text).toContain("round 1/3");
  });

  it("buildFinishPrompt 引导 finish 并说明未收敛语义", () => {
    const text = buildFinishPrompt();
    expect(text).toMatch(/finish/);
    expect(text).toMatch(/not converged/);
  });
});

describe("buildTurnPrompt(stateless replay 组装)", () => {
  it("拼接 system + 当前阶段指令 + 全量 history", () => {
    const system = "SYS";
    const history = ["briefing...", "<assistant action>\n{\"action\":\"plan_smoke\",\"params\":{}}", "<observation>\n已记录"];
    const text = buildTurnPrompt(system, history, "STAGE 1: ...");
    expect(text.startsWith("SYS\n\nCURRENT_INSTRUCTION\nSTAGE 1: ...")).toBe(true);
    expect(text).toContain("CONVERSATION_HISTORY");
    expect(text).toContain("briefing...");
    expect(text).toContain("plan_smoke");
    expect(text).toContain("已记录");
  });

  it("history 为空时给出占位", () => {
    const text = buildTurnPrompt("SYS", [], "inst");
    expect(text).toContain("(no history yet)");
  });
});
