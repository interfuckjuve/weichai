import { describe, expect, it } from "vitest";
import { buildMitgenTaskPrompt, type MitgenTaskInput } from "./mitgen-task.js";

const baseInput: MitgenTaskInput = {
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

const fragments = [
  {
    id: "frag-01",
    kind: "guard" as const,
    start: 10,
    end: 30,
    code: "if (s == null) return \"\";",
    pathCondition: "s 为 null",
    features: ["guard", "empty"],
    heuristicScore: 0.8,
    wrap: true,
  },
  {
    id: "frag-02",
    kind: "loop-body" as const,
    start: 40,
    end: 60,
    code: "sb.append(s.charAt(i));",
    pathCondition: "进入循环体(至少执行一次迭代)",
    features: ["loop"],
    heuristicScore: 0.6,
  },
];

const prompt = (): string => buildMitgenTaskPrompt(baseInput, { fragments });

describe("buildMitgenTaskPrompt", () => {
  it("包含任务指令(基于预提取片段→片段定向生成测试→编译运行验证)", () => {
    const p = prompt();
    expect(p).toMatch(/fragment/i);
    expect(p).toMatch(/generate/i);
    expect(p).toMatch(/compile/i);
    expect(p).toMatch(/run/i);
  });

  it("包含片段清单(片段 id / 路径条件 / 代码)与目标签名", () => {
    const p = prompt();
    expect(p).toContain("frag-01");
    expect(p).toContain("frag-02");
    expect(p).toContain("s 为 null");
    expect(p).toContain("if (s == null) return");
    expect(p).toContain("Mime");
    expect(p).toContain("Decode");
  });

  it("包含沙箱约束与 Bash 白名单 + $JAVA_HOME", () => {
    const p = prompt();
    expect(p).toMatch(/read-only/i);
    for (const cmd of ["javac", "java", "dotnet", "python3", "tsx"]) expect(p).toContain(cmd);
    expect(p).toContain("$JAVA_HOME");
  });

  it("内嵌 MitGenResult schema 关键字段与 report.json 写入要求", () => {
    const p = prompt();
    expect(p).toContain("report.json");
    for (const key of ["description", "fragments", "fragmentId", "correspondence", "correspondenceNote", "reachability", "schemaVersion", "cases"]) {
      expect(p).toContain(key);
    }
  });

  it("包含终止条件(写完 report.json 即结束)", () => {
    expect(prompt()).toMatch(/report\.json/i);
  });
});
