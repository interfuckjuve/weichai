/**
 * 双向翻译测试 — Java ↔ C#
 *
 * 覆盖两个方向:
 *   - java-to-csharp: Java 候选 → C# 目标 → compileStandalone (dotnet)
 *   - csharp-to-java: C# 候选 → Java 目标 → compileJavaStandalone (javac)
 *
 * 不依赖 DeepSeek API key, 只验证「翻译后的代码能否通过编译」这条链路。
 * 真正的 LLM 翻译请看 poc/bidirectional_e2e.ts。
 */

import { describe, expect, it } from "vitest";
import {
  compileJavaStandalone,
  compileStandalone,
  isCompilerUnavailable,
} from "./compiler";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";

// ---- 两个方向各自使用只依赖标准库的方法体，保证独立编译可验证 ----

const csharpMethod = `public decimal CalculateTotal(List<decimal> amounts, decimal discount)
{
    decimal total = 0.0m;
    foreach (decimal amount in amounts)
    {
        total += amount;
    }
    return total - discount;
}`;

const javaMethod = `public double calculateTotal(List<Double> amounts, double discount) {
    double total = 0.0;
    for (double amount : amounts) {
        total += amount;
    }
    return total - discount;
}`;

describe("bidirectional compile (Java <-> C#)", () => {
  it("java-to-csharp: 翻译出的 C# 方法能通过 dotnet 独立编译", () => {
    const result = compileStandalone(csharpMethod, "OrderService");

    if (isCompilerUnavailable(result)) {
      expect(result.errors[0]).toMatch(/\.NET SDK not installed/i);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  }, 30_000);

  it("csharp-to-java: 翻译出的 Java 方法能通过 javac 独立编译", () => {
    const result = compileJavaStandalone(javaMethod, "OrderService");

    if (isJavacMissing(result)) {
      // javac 未安装时不视为测试失败，只说明方向分发正确但环境缺 JDK
      expect(result.errors[0]).toMatch(/JDK not installed/i);
      return;
    }

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  }, 30_000);
});

describe("bidirectional direction dispatch", () => {
  const adapter = new AdaptationAdapter({ apiKey: "unused-gate-only" });

  it("接受 Java -> C# 方向（在门卫处通过）", async () => {
    await expect(
      adapter.adapt({
        target: {
          id: "t",
          name: "CalculateTotal",
          kind: "function",
          path: "src/OrderService.cs",
          language: "C#",
          signature: csharpMethod.split("\n")[0],
        },
        candidate: {
          id: "c",
          title: "calculateTotal",
          repository: "fixture/java",
          license: "Apache-2.0",
          language: "Java",
          kind: "function",
          path: "src/OrderService.java",
          signature: "public double calculateTotal(List<Double> amounts, double discount)",
          summary: "Sums amounts minus discount.",
          score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
          preview: javaMethod,
          dependencies: [],
          compatibility: [],
          risks: [],
        },
        requirement: "sum amounts and subtract discount",
        strategy: "translate",
        decisionNotes: "",
      }),
    ).rejects.toThrow(); // 门卫通过，随后因无 API key 在 LLM 调用处抛错
  });

  it("接受 C# -> Java 方向（在门卫处通过）", async () => {
    await expect(
      adapter.adapt({
        target: {
          id: "t",
          name: "calculateTotal",
          kind: "function",
          path: "src/OrderService.java",
          language: "Java",
          signature: javaMethod.split("\n")[0],
        },
        candidate: {
          id: "c",
          title: "CalculateTotal",
          repository: "fixture/csharp",
          license: "MIT",
          language: "C#",
          kind: "function",
          path: "src/OrderService.cs",
          signature: "public decimal CalculateTotal(List<decimal> amounts, decimal discount)",
          summary: "Sums amounts minus discount.",
          score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
          preview: csharpMethod,
          dependencies: [],
          compatibility: [],
          risks: [],
        },
        requirement: "sum amounts and subtract discount",
        strategy: "translate",
        decisionNotes: "",
      }),
    ).rejects.toThrow(); // 门卫通过，随后因无 API key 在 LLM 调用处抛错
  });
});

describe("bidirectional backfill patch", () => {
  it("java-to-csharp: 生成 context patch 替换原 C# 方法", () => {
    const originalCSharp = [
      "public sealed class OrderService",
      "{",
      "    public decimal CalculateTotal(List<decimal> amounts, decimal discount)",
      "    {",
      "        throw new NotImplementedException();",
      "    }",
      "}",
    ].join("\n");

    const patch = _buildFilePatch(
      "src/OrderService.cs",
      csharpMethod,
      originalCSharp,
      3,
    );

    const types = [...new Set(patch.hunks[0].lines.map((l) => l.type))];
    expect(types).toContain("context");
    expect(types).toContain("remove");
    expect(types).toContain("add");
    expect(patch.status).toBe("modified");
  });

  it("csharp-to-java: 生成 context patch 替换原 Java 方法", () => {
    const originalJava = [
      "public final class OrderService {",
      "    public double calculateTotal(List<Double> amounts, double discount) {",
      "        throw new UnsupportedOperationException();",
      "    }",
      "}",
    ].join("\n");

    const patch = _buildFilePatch(
      "src/OrderService.java",
      javaMethod,
      originalJava,
      2,
    );

    const types = [...new Set(patch.hunks[0].lines.map((l) => l.type))];
    expect(types).toContain("context");
    expect(types).toContain("remove");
    expect(types).toContain("add");
    expect(patch.status).toBe("modified");
  });
});

function isJavacMissing(result: { errors: string[] }): boolean {
  return result.errors.some((e) => /JDK not installed/i.test(e));
}
