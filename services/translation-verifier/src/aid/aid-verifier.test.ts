/**
 * aid-verifier 集成单元测试(全 fake):干净目标全 pass、注入 bug 检出 fail、
 * disputed 不误报、报告字段齐备、全变体被过滤时回退参考组。
 * LLM 走 fake spawnClaude;执行走 fake executor。
 */
import { describe, expect, it } from "vitest";
import type { SpawnClaude } from "../claude-client.js";
import type { TestDescription, TypedValue } from "../description.js";
import { FakeDriverExecutor, type CompileOutcome, type RunOutcome, type SideSpec } from "../executor.js";
import { createLogger } from "../logger.js";
import { InputGeneratorAgent } from "./input-generator.js";
import { VariantGeneratorAgent } from "./variant-generator.js";
import { verifyTargetAgainstAIDBaseline, verifyWithVariants } from "./aid-verifier.js";

const SILENT = createLogger("test", { disabled: true });

function num(value: number): TypedValue {
  return { type: "number", value };
}

// ---------------------------------------------------------------------------
// 场景定义:source = C# Doubler.DoubleIt(x)=x*2;target = Java doubleIt。
// ---------------------------------------------------------------------------

const CSHARP_SOURCE = `using System;
public static class Doubler
{
    public static int DoubleIt(int x) { return x * 2; }
}`;

/** 行为一致、策略不同的变体(移位)。 */
const VARIANT_OK = `using System;
public class Doubler
{
    public static int DoubleIt(int x) { return x << 1; }
}`;

/** 行为不一致的变体(负数取绝对值)。 */
const VARIANT_ABS = `using System;
public class Doubler
{
    public static int DoubleIt(int x) { return Math.Abs(x * 2); }
}`;

/** 编译失败的变体。 */
const VARIANT_BROKEN = `using System;
public class Doubler
{
    public static int DoubleIt(int x) { return this is not csharp !!! }
}`;

const TARGET_CLEAN = `public class Doubler {
    public static int doubleIt(int x) { return x * 2; }
}`;

/** 注入的精细 bug:固定错值(x*3 而非 x*2)。 */
const TARGET_BUGGY = `public class Doubler {
    public static int doubleIt(int x) { return x * 3; }
}`;

const GENERATOR_SCRIPT = `function sampleOne() {
  const candidates = [[1],[2],[-3],[100000]];
  return candidates[Math.floor(Math.random() * candidates.length)];
}`;

/** 生成输入(与 GENERATOR_SCRIPT 输出一致,由 fake executor 返回)。 */
const GENERATED_INPUTS: TypedValue[][] = [[num(1)], [num(2)], [num(-3)], [num(100000)]];

function description(expectedC1: TypedValue = num(4)): TestDescription {
  return {
    schemaVersion: "1.0",
    requirement: "把输入整数翻倍",
    target: { language: "Java", className: "Doubler", method: "doubleIt", isStatic: true, constructorArgs: [] },
    cases: [{ id: "c1", inputs: [num(2)], expected: { kind: "return", value: expectedC1 } }],
  };
}

/** 每个 case 的输入值(c1 + gen_000..gen_003)。 */
function inputByCase(): Map<string, number> {
  const map = new Map<string, number>();
  map.set("c1", 2);
  GENERATED_INPUTS.forEach((input, i) => map.set(`gen_${String(i).padStart(3, "0")}`, (input[0] as { value: number }).value));
  return map;
}

/**
 * fake executor:
 * - run 收到含 sampleOne 的驱动(TS 生成器)→ 返回生成输入 JSON;
 * - 其余按 sourceFiles 内容判定行为:Math.Abs → abs;x*3 → buggy;否则 x*2;
 * - 变体编译:含 "this is not csharp" → 编译失败。
 */
function makeExecutor(options: { generatorFailure?: boolean; targetCompileFailure?: boolean } = {}): FakeDriverExecutor {
  const inputs = inputByCase();
  return new FakeDriverExecutor({
    compileResults: (side: SideSpec): CompileOutcome => {
      const joined = side.sourceFiles.map((f) => f.content).join("");
      if (options.targetCompileFailure && side.language === "Java") {
        return { success: false, errors: ["target compile failed"], output: "" };
      }
      if (joined.includes("this is not csharp")) return { success: false, errors: ["CS1002"], output: "" };
      return { success: true, errors: [], output: "" };
    },
    runResults: (side: SideSpec): RunOutcome => {
      const driver = side.driverSource;
      if (driver.includes("sampleOne")) {
        if (options.generatorFailure) return { exitCode: 1, stdout: "", stderr: "sampleOne threw" };
        return { exitCode: 0, stdout: JSON.stringify({ inputs: GENERATED_INPUTS }), stderr: "" };
      }
      const joined = side.sourceFiles.map((f) => f.content).join("");
      const abs = joined.includes("Math.Abs");
      const buggy = joined.includes("x * 3");
      // 驱动只产出描述中声明的 case:从 driverSource 提取 caseId 字面量(基础 = c1;批量 = c1 + gen_*)。
      const caseIds = [...new Set([...driver.matchAll(/"(c1|gen_\d{3})"/g)].map((m) => m[1] as string))];
      const results = caseIds.map((caseId) => {
        const x = inputs.get(caseId) ?? 0;
        const value = buggy ? x * 3 : abs ? Math.abs(x * 2) : x * 2;
        return { caseId, outcome: "return", returnValue: num(value) };
      });
      return { exitCode: 0, stdout: JSON.stringify({ results }), stderr: "" };
    },
  });
}

function fakeSpawn(...outputs: string[]): SpawnClaude {
  let call = 0;
  return async () => {
    const out = outputs[Math.min(call, outputs.length - 1)] as string;
    call += 1;
    return { stdout: out, exitCode: 0 };
  };
}

function makeAgents(variantOutputs: string[]): { variants: VariantGeneratorAgent; inputs: InputGeneratorAgent } {
  return {
    variants: new VariantGeneratorAgent({ apiKey: "offline-test", spawnClaude: fakeSpawn(...variantOutputs), logger: SILENT }),
    inputs: new InputGeneratorAgent({ apiKey: "offline-test", spawnClaude: fakeSpawn(GENERATOR_SCRIPT), logger: SILENT }),
  };
}

function targetSide(content: string): SideSpec {
  return {
    language: "Java",
    driverSource: "// target driver",
    sourceFiles: [{ relativePath: "Doubler.java", content }],
  };
}

const sourceSide: SideSpec = {
  language: "C#",
  driverSource: "// source driver",
  sourceFiles: [{ relativePath: "source.cs", content: CSHARP_SOURCE }],
};

describe("verifyWithVariants: AID 编排(全 fake)", () => {
  it("干净目标:变体 1 保留、变体 2 剔除,全部 case pass,报告字段齐备", async () => {
    const executor = makeExecutor();
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4, variantCount: 2 } },
      executor,
      makeAgents([VARIANT_OK, VARIANT_BROKEN]),
      SILENT,
    );

    expect(report.schemaVersion).toBe("1.1");
    // 变体 1 保留,变体 2 编译失败被剔除。
    expect(report.variants).toHaveLength(2);
    expect(report.variants[0]?.passes).toBe(true);
    expect(report.variants[1]?.passes).toBe(false);
    expect(report.variants[1]?.reason).toContain("compile failed");
    // 参考组 2 侧一致(源 + 变体 1)→ 5 个 case 全 consensus,目标全 pass。
    expect(report.oracleSummary).toEqual({ consensusCount: 5, disputedCount: 0 });
    expect(report.totalCases).toBe(5);
    expect(report.passedCases).toBe(5);
    expect(report.failedCases).toBe(0);
    expect(report.disputedCases).toBe(0);
    expect(report.passRate).toBe(1);
    expect(report.consensusExpectedConflicts).toEqual([]);
    for (const cmp of report.comparisons) {
      expect(cmp.verdict).toBe("pass");
    }
  });

  it("注入固定错值 bug 的目标 → 全部 case fail(检出)", async () => {
    const executor = makeExecutor();
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_BUGGY), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_OK]),
      SILENT,
    );
    expect(report.failedCases).toBe(5);
    expect(report.passedCases).toBe(0);
    expect(report.passRate).toBe(0);
    const [first] = report.comparisons;
    expect(first?.details).toContain("return value mismatch");
  });

  it("冻结 clean 基线后只重放目标侧，不重新生成输入、变体或 oracle", async () => {
    const executor = makeExecutor();
    const clean = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_OK]),
      SILENT,
    );
    const compileCalls = executor.compileCalls.length;
    const runCalls = executor.runCalls.length;

    const replay = await verifyTargetAgainstAIDBaseline(targetSide(TARGET_BUGGY), clean.baseline, executor, SILENT);

    expect(replay.failedCases).toBe(5);
    expect(replay.baseline).toBe(clean.baseline);
    expect(replay.baseline.batchDescription.cases.map((c) => c.id)).toEqual(clean.baseline.batchDescription.cases.map((c) => c.id));
    // 重放只编译和运行注入后的目标，绝不能再跑 TypeScript 输入器、源侧或变体侧。
    expect(executor.compileCalls).toHaveLength(compileCalls + 1);
    expect(executor.runCalls).toHaveLength(runCalls + 1);
    expect(executor.runCalls.at(-1)?.language).toBe("Java");
  });

  it("clean target 无法完整执行时，基线明确标记为不可用于注入检出", async () => {
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      makeExecutor({ targetCompileFailure: true }),
      makeAgents([VARIANT_OK]),
      SILENT,
    );

    expect(report.baseline.cleanTarget).toEqual({ usable: false, note: "target-compile-failed" });
  });

  it("参考组内部分歧且目标命中源侧输出 → disputed(divergent 枚举 + details 标注,不判 fail)", async () => {
    const executor = makeExecutor();
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_ABS]),
      SILENT,
    );
    // 源与 abs 变体在 gen_002(-3) 上分歧:源 -6 vs 变体 6;目标 -6 命中源 → disputed。
    expect(report.oracleSummary.disputedCount).toBe(1);
    expect(report.disputedCases).toBe(1);
    expect(report.failedCases).toBe(0);
    expect(report.passedCases).toBe(4);
    const disputed = report.comparisons.find((c) => c.caseId === "gen_002");
    expect(disputed?.verdict).toBe("divergent");
    expect(disputed?.details.some((d) => d.includes("low confidence"))).toBe(true);
  });

  it("共识与声明 expected 冲突 → consensusExpectedConflicts 标注", async () => {
    const executor = makeExecutor();
    // c1 的 expected 声明为 6,而共识为 4 → 冲突。
    const report = await verifyWithVariants(
      { description: description(num(6)), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_OK]),
      SILENT,
    );
    expect(report.consensusExpectedConflicts).toHaveLength(1);
    expect(report.consensusExpectedConflicts[0]).toContain("c1");
  });

  it("全部变体被过滤 → 参考组退化为仅源方法,目标干净时仍全 pass(不降级失败)", async () => {
    const executor = makeExecutor();
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_BROKEN]),
      SILENT,
    );
    expect(report.variants.every((v) => !v.passes)).toBe(true);
    // 参考组 = 仅源方法 → oracle 全部 consensus,目标一致 → pass。
    expect(report.oracleSummary).toEqual({ consensusCount: 5, disputedCount: 0 });
    expect(report.passedCases).toBe(5);
    expect(report.failedCases).toBe(0);
  });

  it("输入生成器执行失败 → 退化为基础输入集(仅 c1),机制不崩", async () => {
    const executor = makeExecutor({ generatorFailure: true });
    const report = await verifyWithVariants(
      { description: description(), source: sourceSide, target: targetSide(TARGET_CLEAN), options: { inputCount: 4 } },
      executor,
      makeAgents([VARIANT_OK]),
      SILENT,
    );
    // 只有基础 case c1 参与差分。
    expect(report.totalCases).toBe(1);
    expect(report.passedCases).toBe(1);
  });
});
