import { describe, expect, it } from "vitest";
import { buildSmokeTaskPrompt, type SmokeTaskInput } from "./build-differential-test-prompt.js";

/** mime-util 场景夹具:Java 源 + C# 目标,双侧 root 与文件齐全。 */
const baseInput: SmokeTaskInput = {
  requirement: "实现 decodeMimeText:把 MIME 编码文本解码为纯文本",
  source: {
    language: "Java",
    root: "/ref/source",
    files: [{ relativePath: "MimeDecoder.java", content: "public class MimeDecoder { ... }" }],
  },
  target: {
    language: "C#",
    className: "MimeDecoder",
    method: "DecodeMimeText",
    isStatic: true,
    root: "/ref/target",
    file: "MimeDecoder.cs",
  },
};

describe("buildSmokeTaskPrompt verify-only(默认)模式", () => {
  it("verify-only 允许修 runner 但禁止修改目标实现", () => {
    const prompt = buildSmokeTaskPrompt(baseInput, "verify-only");
    expect(prompt).toContain("You may repair runner and test harness files");
    expect(prompt).toContain("Never modify the target implementation");
    expect(prompt).toContain('"rounds": 0');
    expect(prompt).toContain('"targetFiles": []');
    expect(prompt).toContain("verifier-command");
  });

  it("默认模式即 verify-only(与显式 verify-only 同内容)", () => {
    expect(buildSmokeTaskPrompt(baseInput)).toBe(buildSmokeTaskPrompt(baseInput, "verify-only"));
  });

  it("verify-only 明确定义 converged:全部差异得到决定性裁决且无 unclear,不代表目标被修复", () => {
    const prompt = buildSmokeTaskPrompt(baseInput);
    expect(prompt).toContain("CONVERGED DEFINITION (verify-only)");
    expect(prompt).toMatch(/does NOT mean the target was repaired/);
  });

  it("verify-only 不含目标修复轮措辞(at most 2 修复轮)", () => {
    const prompt = buildSmokeTaskPrompt(baseInput);
    expect(prompt).not.toContain("Limit target-side repair to at most 2");
    expect(prompt).not.toContain("DIAGNOSTIC MODE NOTE");
  });
});

describe("buildSmokeTaskPrompt diagnostic-repair 模式", () => {
  it("显式 diagnostic-repair 保留目标修复措辞(rounds 可为非零)", () => {
    const prompt = buildSmokeTaskPrompt(baseInput, "diagnostic-repair");
    expect(prompt).toContain("DIAGNOSTIC MODE NOTE");
    expect(prompt).toContain("Limit target-side repair to at most 2");
    expect(prompt).not.toContain("Never modify the target implementation");
  });
});

describe("buildSmokeTaskPrompt 公共内容", () => {
  it("展开完整报告与 canonical TypedValue 契约", () => {
    const prompt = buildSmokeTaskPrompt(baseInput);
    expect(prompt).toContain("REPORT CONTRACT");
    expect(prompt).toContain("CANONICAL TYPED VALUE CONTRACT");
    expect(prompt).toContain('Use "number" for every numeric language type');
    expect(prompt).not.toContain("<TypedValue");
  });

  it("含任务指令:读源→写双侧 runner→编译运行→差分比较→judge", () => {
    const p = buildSmokeTaskPrompt(baseInput, "diagnostic-repair");
    expect(p).toMatch(/runner/i);
    expect(p).toMatch(/compile/i);
    expect(p).toMatch(/run/i);
    expect(p).toMatch(/compar/i);
    expect(p).toMatch(/judge/i);
  });

  it("analysisReport 存在时输出 ANALYZER REPORT 段(需求之后、源侧之前)", () => {
    const report = JSON.stringify({
      schemaVersion: "1.0",
      applicability: { level: "adapt", confidence: 0.8, reasons: ["similar behavior"] },
    });
    const p = buildSmokeTaskPrompt({ ...baseInput, analysisReport: report });
    expect(p).toContain("ANALYZER REPORT");
    expect(p).toContain('"applicability"');
    expect(p.indexOf("ANALYZER REPORT")).toBeGreaterThan(p.indexOf("REQUIREMENT"));
    expect(p.indexOf("ANALYZER REPORT")).toBeLessThan(p.indexOf("SOURCE SIDE"));
  });

  it("analysisReport 缺省时不输出 ANALYZER REPORT 段", () => {
    expect(buildSmokeTaskPrompt(baseInput)).not.toContain("ANALYZER REPORT");
  });

  it("内嵌双侧签名、语言与需求原文", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("decodeMimeText");
    expect(p).toContain("MimeDecoder");
    expect(p).toContain("DecodeMimeText");
    expect(p).toContain("C#");
    expect(p).toContain("Java");
  });

  it("含沙箱约束:项目根只读 + 仅 runner 目录/工作目录可写", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toMatch(/READ-ONLY/i);
    expect(p).toContain("/ref/source");
    expect(p).toContain("/ref/target");
    expect(p).toMatch(/runner directories/i);
  });

  it("含命令代理说明:所有编译/运行经 verifier-command,禁止直接 javac/java/dotnet/python3/tsx", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("verifier-command");
    expect(p).toMatch(/direct javac\/java\/dotnet\/python3\/tsx invocations are not permitted/i);
  });

  it("内嵌 SmokeReport schema 关键字段与 report.json 写入要求", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("report.json");
    for (const key of ["converged", "steps", "rounds", "cases", "mechanical", "decision", "targetFiles", "runnerFiles", "sourceIssues", "executions", "summary"]) {
      expect(p).toContain(key);
    }
  });

  it("执行证据契约:commandId 必须来自 commands.jsonl,不得伪造", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("EXECUTION EVIDENCE CONTRACT");
    expect(p).toContain("commands.jsonl");
    expect(p).toMatch(/Never invent commandIds/);
  });

  it("runnerFiles 契约:双侧 runner + 约定驱动入口名", () => {
    const p = buildSmokeTaskPrompt(baseInput, "diagnostic-repair");
    expect(p).toContain("runnerFiles");
    expect(p).toContain("driver.py");
    expect(p).toContain("driver.ts");
    expect(p).toContain("Driver.cs");
    expect(p).toContain("main");
    expect(p).toContain('"source"');
    expect(p).toContain('"target"');
  });

  it("含终止条件:report.json 写完即结束;无法完成也须写 converged=false", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toMatch(/report\.json/i);
    expect(p).toMatch(/converged=false/);
  });

  it("含效率纪律:合并命令/禁止任务规划工具", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("EFFICIENCY DISCIPLINE");
    expect(p).toContain("TaskCreate");
    expect(p).toContain("TaskUpdate");
    expect(p).toMatch(/single Bash call/);
  });

  it("keeps evidence-insufficient decisions unclear and final timing compatible with termination", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("If evidence is insufficient, record unclear");
    expect(p).not.toContain("pick the closest defensible decision");
    expect(p).toContain('[VERIFIER_STEP] {"name":"explore","event":"start"}');
    expect(p).toContain("Repeat start/end for every repeated task");
    expect(p).toContain("do not invent missing tasks or timestamps");
    expect(p.split("TERMINATION\n")[1]).toContain("Emit the finalize-report end marker, then stop");
  });

  it("root/files 缺省时仍可构建,使用降级文案(不抛错)", () => {
    const p = buildSmokeTaskPrompt({
      ...baseInput,
      source: { language: "Java" },
      target: { language: "C#", className: "MimeDecoder", method: "DecodeMimeText", isStatic: false },
    });
    expect(p).toContain("report.json");
    expect(p).toContain("(自行浏览)");
  });
});
