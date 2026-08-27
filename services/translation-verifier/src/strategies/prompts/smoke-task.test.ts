import { describe, expect, it } from "vitest";
import { buildSmokeTaskPrompt, type SmokeTaskInput } from "./smoke-task.js";

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

describe("buildSmokeTaskPrompt", () => {
  it("包含任务指令(读源→写 runner→双侧编译运行→差分→judge→必要时修复)", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toMatch(/runner/i);
    expect(p).toMatch(/compile/i);
    expect(p).toMatch(/run/i);
    expect(p).toMatch(/compar/i);
    expect(p).toMatch(/judge/i);
    expect(p).toMatch(/fix/i);
  });

  it("包含双侧签名与需求原文", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("decodeMimeText");
    expect(p).toContain("MimeDecoder");
    expect(p).toContain("DecodeMimeText");
    expect(p).toContain("C#");
    expect(p).toContain("Java");
  });

  it("包含沙箱约束:只读参考目录 + 仅在工作目录写", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/working directory/i);
    expect(p).toContain("/ref/source");
    expect(p).toContain("/ref/target");
  });

  it("包含 Bash 白名单(javac/java/dotnet/python3/tsx)与 $JAVA_HOME 全路径提示", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    for (const cmd of ["javac", "java", "dotnet", "python3", "tsx"]) {
      expect(p).toContain(cmd);
    }
    expect(p).toContain("$JAVA_HOME");
    expect(p).toContain("JAVA_HOME");
  });

  it("内嵌 SmokeReport schema 关键字段与 report.json 写入要求", () => {
    const p = buildSmokeTaskPrompt(baseInput);
    expect(p).toContain("report.json");
    for (const key of ["converged", "steps", "rounds", "cases", "mechanical", "decision", "targetFiles", "sourceIssues", "summary"]) {
      expect(p).toContain(key);
    }
  });

  it("包含终止条件(写完 report.json 即结束)", () => {
    expect(buildSmokeTaskPrompt(baseInput)).toMatch(/report\.json/i);
  });

  it("root 缺省时提示词仍可构建(不抛错)", () => {
    const p = buildSmokeTaskPrompt({ ...baseInput, source: { language: "Java" }, target: { language: "C#", className: "M", method: "m", isStatic: false } });
    expect(p).toContain("report.json");
  });
});
