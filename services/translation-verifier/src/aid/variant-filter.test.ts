/**
 * variant-filter 单元测试:同语言差分过滤、编译失败剔除、契约解析。
 * 全部 fake executor,不依赖真实工具链。
 */
import { describe, expect, it } from "vitest";
import type { TypedValue } from "../description.js";
import { FakeDriverExecutor, type CompileOutcome, type RunOutcome, type SideSpec } from "../executor.js";
import { createLogger } from "../logger.js";
import { filterVariants, parseSourceContract, parseMethodSignature, sameLanguageResultEqual } from "./variant-filter.js";

const SILENT = createLogger("test", { disabled: true });

function str(value: string): TypedValue {
  return { type: "string", value };
}

function num(value: number): TypedValue {
  return { type: "number", value };
}

/** C# 源方法文件(单类,无 namespace,与 e2e fixture 同构)。 */
const CSHARP_SOURCE = `using System;
public static class MimeUtility
{
    public static string DecodeText(string value)
    {
        return value;
    }
}`;

/** 与源行为一致的变体 1(类名已由 VariantGeneratorAgent 改写为 Variant_1)。 */
const VARIANT_1_OK = `using System;
public class Variant_1
{
    public static string DecodeText(string value)
    {
        return string.Concat(value);
    }
}`;

/** 行为不一致的变体 2(把输入改为 "buggy")。 */
const VARIANT_2_BAD = `using System;
public class Variant_2
{
    public static string DecodeText(string value)
    {
        return "buggy";
    }
}`;

/** 编译失败的变体 3(语法错误)。 */
const VARIANT_3_BROKEN = `using System;
public class Variant_3
{
    public static string DecodeText(string value)
    {
        return this is not valid csharp !!!
    }
}`;

const SOURCE_SIDE: SideSpec = {
  language: "C#",
  driverSource: "// driver",
  sourceFiles: [{ relativePath: "source.cs", content: CSHARP_SOURCE }],
};

const BASE_CASES = [
  { id: "c1", inputs: [str("hello")] },
  { id: "c2", inputs: [str("world")] },
];

/** 生成驱动输出 JSON(CaseResult[] → stdout)。 */
function stdoutFor(results: { caseId: string; outcome: "return"; returnValue: TypedValue }[]): string {
  return JSON.stringify({ results });
}

describe("parseSourceContract / parseMethodSignature", () => {
  it("C# 类 + static 方法:解析类名/方法名/isStatic", () => {
    const contract = parseSourceContract(CSHARP_SOURCE, "C#");
    expect(contract).toEqual({ className: "MimeUtility", method: "DecodeText", isStatic: true });
    expect(parseMethodSignature(CSHARP_SOURCE, contract as { method: string; isStatic: boolean })).toBe(
      "DecodeText(string value)",
    );
  });

  it("Java 带 package:类名含包前缀", () => {
    const java = `package org.example;\npublic class Util {\n  public static int doubleIt(int x) { return x * 2; }\n}`;
    expect(parseSourceContract(java, "Java")).toEqual({ className: "org.example.Util", method: "doubleIt", isStatic: true });
  });

  it("C# namespace + 非 static 方法", () => {
    const csharp = `namespace A.B {\npublic class Util {\n  public int inc(int x) { return x + 1; }\n}\n}`;
    expect(parseSourceContract(csharp, "C#")).toEqual({ className: "A.B.Util", method: "inc", isStatic: false });
  });

  it("Python 模块函数 / TypeScript 函数", () => {
    expect(parseSourceContract("def decode(value):\n    return value", "Python")).toEqual({
      method: "decode",
      isStatic: true,
    });
    expect(parseSourceContract("export function decode(value: string) { return value; }", "TypeScript")).toEqual({
      method: "decode",
      isStatic: true,
    });
  });
});

describe("sameLanguageResultEqual", () => {
  it("return 严格相等 / 异常类型相等 / outcome 不同不等", () => {
    expect(
      sameLanguageResultEqual(
        { caseId: "c", outcome: "return", returnValue: str("a") },
        { caseId: "c", outcome: "return", returnValue: str("a") },
      ),
    ).toBe(true);
    expect(
      sameLanguageResultEqual(
        { caseId: "c", outcome: "return", returnValue: str("a") },
        { caseId: "c", outcome: "return", returnValue: str("b") },
      ),
    ).toBe(false);
    expect(
      sameLanguageResultEqual(
        { caseId: "c", outcome: "exception", exceptionType: "ArgumentException" },
        { caseId: "c", outcome: "exception", exceptionType: "ArgumentException" },
      ),
    ).toBe(true);
    expect(
      sameLanguageResultEqual(
        { caseId: "c", outcome: "return", returnValue: str("a") },
        { caseId: "c", outcome: "exception", exceptionType: "ArgumentException" },
      ),
    ).toBe(false);
  });
});

describe("filterVariants", () => {
  /** fake executor:按 driverSource 特征分派(含 "Variant_1" 的驱动 → OK;含 Variant_2 → 行为不一致;Variant_3 → 编译失败)。 */
  function executorFor(variantOutputs: Record<string, TypedValue>): FakeDriverExecutor {
    return new FakeDriverExecutor({
      compileResults: (side: SideSpec): CompileOutcome => {
        const joined = side.sourceFiles.map((f) => f.content).join("");
        if (joined.includes("this is not valid csharp")) {
          return { success: false, errors: ["CS1002: ; expected"], output: "build failed" };
        }
        return { success: true, errors: [], output: "" };
      },
      runResults: (side: SideSpec): RunOutcome => {
        const joined = side.sourceFiles.map((f) => f.content).join("");
        if (joined.includes("return \"buggy\"")) {
          return { exitCode: 0, stdout: stdoutFor([{ caseId: "c1", outcome: "return", returnValue: str("buggy") }, { caseId: "c2", outcome: "return", returnValue: str("buggy") }]), stderr: "" };
        }
        // 源方法与变体 1:按类名匹配输出。
        const className = /Variant_(\d+)/.exec(joined)?.[1];
        const value = variantOutputs[className ?? "source"] ?? str("default");
        return { exitCode: 0, stdout: stdoutFor([{ caseId: "c1", outcome: "return", returnValue: value }, { caseId: "c2", outcome: "return", returnValue: value }]), stderr: "" };
      },
    });
  }

  it("行为一致的保留,不一致的剔除,编译失败的剔除", async () => {
    const executor = executorFor({ "1": str("hello"), source: str("hello") });
    const filtered = await filterVariants([VARIANT_1_OK, VARIANT_2_BAD, VARIANT_3_BROKEN], {
      sourceSide: SOURCE_SIDE,
      baseCases: BASE_CASES,
      executor,
      logger: SILENT,
    });
    expect(filtered).toHaveLength(3);
    // Variant_1 与源一致 → 保留。
    const ok = filtered[0];
    expect(ok?.passes).toBe(true);
    expect(ok?.reason).toBeUndefined();
    expect(ok?.side.language).toBe("C#");
    expect(ok?.side.sourceFiles[0]?.relativePath).toBe("Variant_1.cs");
    // Variant_2 行为不一致 → 剔除。
    expect(filtered[1]?.passes).toBe(false);
    expect(filtered[1]?.reason).toContain("behavior divergence");
    // Variant_3 编译失败 → 剔除。
    expect(filtered[2]?.passes).toBe(false);
    expect(filtered[2]?.reason).toContain("compile failed");
  });

  it("全部变体被过滤 → 返回空保留清单(调用方回退参考组为 {源方法})", async () => {
    const executor = executorFor({ source: str("hello") });
    const filtered = await filterVariants([VARIANT_2_BAD], {
      sourceSide: SOURCE_SIDE,
      baseCases: BASE_CASES,
      executor,
      logger: SILENT,
    });
    expect(filtered.filter((v) => v.passes)).toHaveLength(0);
  });

  it("源方法在基础输入集上无可用结果 → 全部变体视为不通过", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: () => ({ success: true, errors: [], output: "" }),
      runResults: () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
    });
    const filtered = await filterVariants([VARIANT_1_OK], {
      sourceSide: SOURCE_SIDE,
      baseCases: BASE_CASES,
      executor,
      logger: SILENT,
    });
    expect(filtered.filter((v) => v.passes)).toHaveLength(0);
    expect(filtered[0]?.reason).toContain("no usable");
  });

  it("基础输入集只使用 inputs,不使用 expected(传入不一致的 expected 不影响过滤)", async () => {
    const executor = executorFor({ "1": str("hello"), source: str("hello") });
    const filtered = await filterVariants([VARIANT_1_OK], {
      sourceSide: SOURCE_SIDE,
      baseCases: [
        { id: "c1", inputs: [str("hello")] },
        { id: "c2", inputs: [str("world")] },
      ],
      executor,
      logger: SILENT,
    });
    expect(filtered[0]?.passes).toBe(true);
  });

  it("变体驱动按基础输入集生成:fake executor 收到的驱动含全部基础 case 调用", async () => {
    const executor = executorFor({ "1": str("hello"), source: str("hello") });
    await filterVariants([VARIANT_1_OK], {
      sourceSide: SOURCE_SIDE,
      baseCases: BASE_CASES,
      executor,
      logger: SILENT,
    });
    // 编译/运行各 2 次:源方法 + 变体。
    expect(executor.compileCalls).toHaveLength(2);
    expect(executor.runCalls).toHaveLength(2);
    const variantCall = executor.runCalls[1];
    expect(variantCall?.driverSource).toContain('"c1"');
    expect(variantCall?.driverSource).toContain('"c2"');
  });
});
