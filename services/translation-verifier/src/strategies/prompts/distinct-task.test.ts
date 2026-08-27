import { describe, expect, it } from "vitest";
import { buildDistinctTaskPrompt, type DistinctTaskInput } from "./distinct-task.js";

const baseInput: DistinctTaskInput = {
  requirement: "实现 StringUtils.split:按分隔符拆分字符串",
  source: {
    language: "Java",
    root: "/ref/source",
    files: [{ relativePath: "StringUtils.java", content: "public class StringUtils { ... }" }],
  },
  target: {
    language: "C#",
    className: "StringUtils",
    method: "Split",
    isStatic: true,
    root: "/ref/target",
    file: "StringUtils.cs",
  },
};

describe("buildDistinctTaskPrompt", () => {
  it("包含任务指令(生成测试→试编译修复→分支分析→按需求修正断言)", () => {
    const p = buildDistinctTaskPrompt(baseInput);
    expect(p).toMatch(/branch/i);
    expect(p).toMatch(/assertion/i);
    expect(p).toMatch(/requirement/i);
    expect(p).toMatch(/compile/i);
  });

  it("包含双侧签名与需求原文", () => {
    const p = buildDistinctTaskPrompt(baseInput);
    expect(p).toContain("StringUtils");
    expect(p).toContain("Split");
    expect(p).toContain("StringUtils.split");
  });

  it("包含沙箱约束与 Bash 白名单 + $JAVA_HOME", () => {
    const p = buildDistinctTaskPrompt(baseInput);
    expect(p).toMatch(/read-only/i);
    for (const cmd of ["javac", "java", "dotnet", "python3", "tsx"]) expect(p).toContain(cmd);
    expect(p).toContain("$JAVA_HOME");
  });

  it("内嵌 ConsistencyResult schema 关键字段与 report.json 写入要求", () => {
    const p = buildDistinctTaskPrompt(baseInput);
    expect(p).toContain("report.json");
    for (const key of ["report", "consistency", "augmented", "passRate", "failedCases", "coverage", "uncovered", "inventory", "branches"]) {
      expect(p).toContain(key);
    }
  });

  it("包含终止条件(写完 report.json 即结束)", () => {
    expect(buildDistinctTaskPrompt(baseInput)).toMatch(/report\.json/i);
  });
});
