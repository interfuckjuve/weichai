import { describe, expect, it } from "vitest";
import { buildAidTaskPrompt, type AidTaskInput } from "./aid-task.js";

const baseInput: AidTaskInput = {
  requirement: "实现 Mime.decode:把 MIME 编码文本解码为纯文本",
  source: {
    language: "Java",
    root: "/ref/source",
    files: [{ relativePath: "Mime.java", content: "public class Mime { ... }" }],
  },
  target: {
    language: "C#",
    className: "Mime",
    method: "Decode",
    isStatic: true,
    root: "/ref/target",
    file: "Mime.cs",
  },
};

const prompt = (): string => buildAidTaskPrompt(baseInput, { variantsDir: "/workspace/variants" });

describe("buildAidTaskPrompt", () => {
  it("包含任务指令(读预生成变体→编译过滤→生成输入→差分→共识判定)", () => {
    const p = prompt();
    expect(p).toMatch(/variant/i);
    expect(p).toMatch(/consensus/i);
    expect(p).toMatch(/differenc/i);
    expect(p).toMatch(/input/i);
    expect(p).toMatch(/filter/i);
  });

  it("包含变体目录与目标签名", () => {
    const p = prompt();
    expect(p).toContain("/workspace/variants");
    expect(p).toContain("Mime");
    expect(p).toContain("Decode");
  });

  it("包含沙箱约束与 Bash 白名单 + $JAVA_HOME", () => {
    const p = prompt();
    expect(p).toMatch(/read-only/i);
    for (const cmd of ["javac", "java", "dotnet", "python3", "tsx"]) expect(p).toContain(cmd);
    expect(p).toContain("$JAVA_HOME");
  });

  it("内嵌 AIDVerificationReport schema 关键字段与 report.json 写入要求", () => {
    const p = prompt();
    expect(p).toContain("report.json");
    for (const key of [
      "schemaVersion",
      "variants",
      "oracleSummary",
      "comparisons",
      "passRate",
      "totalCases",
      "failedCases",
      "disputedCases",
      "consensusExpectedConflicts",
      "baseline",
      "cleanTarget",
      "usable",
    ]) {
      expect(p).toContain(key);
    }
  });

  it("包含终止条件(写完 report.json 即结束)", () => {
    expect(prompt()).toMatch(/report\.json/i);
  });
});
