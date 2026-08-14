import type { AdaptationRequest, SearchCandidate } from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";

const javaCandidate: SearchCandidate = {
  id: "java-candidate",
  title: "calculate",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public double calculate()",
  summary: "Calculates a value.",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: "public double calculate() { return 1.0; }",
  dependencies: [],
  compatibility: [],
  risks: [],
};

const request: AdaptationRequest = {
  target: {
    id: "target",
    name: "Calculate",
    kind: "function",
    path: "src/Calculator.cs",
    language: "C#",
    signature: "public decimal Calculate()",
  },
  candidate: javaCandidate,
  requirement: "Translate the calculation.",
  strategy: "translate",
  decisionNotes: "",
};

describe("AdaptationAdapter language gate", () => {
  const adapter = new AdaptationAdapter({ apiKey: "not-used-by-gate-tests" });

  it("rejects non-Java candidates before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        candidate: { ...javaCandidate, language: "Python" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Python -> C#. Supported: Java <-> C#.",
    );
  });

  it("rejects non-C# targets before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        target: { ...request.target, language: "TypeScript" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Java -> TypeScript. Supported: Java <-> C#.",
    );
  });

  it("rejects strategies unsupported by the Java-to-C# adapter", async () => {
    await expect(adapter.adapt({ ...request, strategy: "wrap" })).rejects.toThrow(
      'AdaptationAdapter only supports the "translate" strategy; received "wrap".',
    );
  });

  it("accepts C# -> Java direction at the gate (fails later without API key)", async () => {
    const csharpCandidate = {
      ...javaCandidate,
      language: "C#" as const,
      preview: "public decimal Calculate() { return 1.0m; }",
    };
    const javaTarget = {
      ...request.target,
      language: "Java" as const,
      name: "calculate",
      signature: "public double calculate()",
    };

    // 方向校验通过；因为没有有效 API key，会在 LLM 调用阶段抛出异常
    await expect(
      adapter.adapt({
        ...request,
        candidate: csharpCandidate,
        target: javaTarget,
      }),
    ).rejects.toThrow();
  });
});

describe("buildFilePatch", () => {
  const originalClass = [
    "using System;",
    "using System.Collections.Generic;",
    "",
    "namespace MyApp.Services",
    "{",
    "    public class RateQuoteService",
    "    {",
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            throw new NotImplementedException();",
    "        }",
    "",
    "        public void Initialize()",
    "        {",
    "            // setup",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const newMethod = [
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            return 0.92m;",
    "        }",
  ].join("\n");

  it("produces a context-based hunk when originalContent and targetLine are provided", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, 8);

    expect(patch.status).toBe("modified");
    expect(patch.hunks).toHaveLength(1);

    const lines = patch.hunks[0].lines;
    const types = lines.map((l) => l.type);

    // 必须包含 context 行（用于定位）
    expect(types).toContain("context");
    // 必须包含 remove 行（旧方法代码被删除）
    expect(types).toContain("remove");
    // 必须包含 add 行（新方法代码被加入）
    expect(types).toContain("add");

    // context 行应该是原方法签名前的那一行
    const contextLines = lines.filter((l) => l.type === "context");
    expect(contextLines.some((l) => l.content.trim() === "{")).toBe(true);

    // remove 行应包含原方法的 throw 语句
    const removeLines = lines.filter((l) => l.type === "remove");
    expect(removeLines.some((l) => l.content.includes("throw new NotImplementedException"))).toBe(true);

    // add 行应包含新方法代码
    const addLines = lines.filter((l) => l.type === "add");
    expect(addLines.some((l) => l.content.includes("return 0.92m"))).toBe(true);
  });

  it("falls back to add-only patch when originalContent is null", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, null, 8);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });

  it("falls back to add-only patch when targetLine is undefined", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, undefined);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });
});

// ---- 端到端回归:模拟扩展侧 applyHunks 应用补丁 ----

function parseHunkHeader(header: string): { oldStart: number } | null {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+/);
  if (!match?.[1]) return null;
  return { oldStart: Number(match[1]) };
}

function applyHunks(content: string, hunks: { header: string; lines: Array<{ type: string; content: string }> }[]): string {
  const lines = content.split(/\r?\n/);
  let lineDelta = 0;
  for (const hunk of hunks) {
    const parsed = parseHunkHeader(hunk.header);
    if (!parsed) continue;
    let cursor = Math.max(0, Math.min(parsed.oldStart - 1 + lineDelta, lines.length));
    for (const line of hunk.lines) {
      if (line.type === "remove") {
        if (cursor < lines.length) {
          lines.splice(cursor, 1);
          lineDelta -= 1;
        }
      } else if (line.type === "add") {
        lines.splice(cursor, 0, line.content);
        cursor += 1;
        lineDelta += 1;
      } else {
        cursor += 1;
      }
    }
  }
  return lines.join("\n");
}

describe("backfill patch end-to-end (service patch + extension applyHunks)", () => {
  const originalMain = [
    "// npm run dev:retrieval",
    "// npm run dev:adaptation",
    "using System;",
    "",
    "namespace HelloWorldApp",
    "{",
    "    class Program",
    "    {",
    "        static void Main(string[] args)",
    "        {",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const translatedMethod = [
    "static void Main(string[] args)",
    "{",
    "    var platform = new ForeXplore.ReferencePlatform.ReferencePlatform();",
    "    Console.WriteLine(platform.Quote(\"EUR\", \"USD\"));",
    "    Console.WriteLine(platform.Settle());",
    "    Console.WriteLine(platform.Report());",
    "}",
  ].join("\n");

  it("replaces the method when the user selected the signature line", () => {
    const patch = _buildFilePatch("/Users/x/Main.cs", translatedMethod, originalMain, 9);
    const next = applyHunks(originalMain, patch.hunks);

    expect(next.match(/static void Main\(string\[\] args\)/g)).toHaveLength(1);
    expect(next).toContain('new ForeXplore.ReferencePlatform.ReferencePlatform()');
    expect(next.trimEnd().endsWith("}")).toBe(true);
    // class 与 namespace 的闭合括号都应保留
    expect(next.split("\n").filter((l) => l.trim() === "}")).toHaveLength(3);
    // 新方法体缩进与原方法一致(8 空格)
    expect(next).toContain("        var platform = new ForeXplore");
  });

  it("replaces the method when the user selected inside the body", () => {
    const patch = _buildFilePatch("/Users/x/Main.cs", translatedMethod, originalMain, 10);
    const next = applyHunks(originalMain, patch.hunks);

    expect(next.match(/static void Main\(string\[\] args\)/g)).toHaveLength(1);
    expect(next).toContain('Console.WriteLine(platform.Report());');
    expect(next.trimEnd().endsWith("}")).toBe(true);
    expect(next.split("\n").filter((l) => l.trim() === "}")).toHaveLength(3);
  });
});
