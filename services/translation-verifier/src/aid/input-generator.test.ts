/**
 * input-generator 单元测试:脚本包装与执行、JSON 解析、TypedValue 校验、去重、批量合成。
 * 全部 fake executor(仅验证 run 收到包装后的脚本与 stdout 解析),不依赖真实 node/tsx。
 */
import { describe, expect, it } from "vitest";
import type { TestDescription, TypedValue } from "../description.js";
import { FakeDriverExecutor, type RunOutcome, type SideSpec } from "../executor.js";
import { createLogger } from "../logger.js";
import {
  dedupeInputs,
  diversitySample,
  runInputGenerator,
  toBatchDescription,
  wrapGeneratorScript,
} from "./input-generator.js";

const SILENT = createLogger("test", { disabled: true });

function str(value: string): TypedValue {
  return { type: "string", value };
}

function num(value: number): TypedValue {
  return { type: "number", value };
}

function baseDescription(): TestDescription {
  return {
    schemaVersion: "1.0",
    requirement: "解码 MIME 文本",
    target: { language: "C#", className: "MimeUtility", method: "DecodeText", isStatic: true, constructorArgs: [] },
    cases: [{ id: "base-1", inputs: [str("hello")], expected: { kind: "return", value: str("hello") } }],
  };
}

/** 构造 fake executor:run 返回预设 stdout。 */
function executorWith(stdout: string): FakeDriverExecutor {
  return new FakeDriverExecutor({
    compileResults: () => ({ success: true, errors: [], output: "" }),
    runResults: (): RunOutcome => ({ exitCode: 0, stdout, stderr: "" }),
  });
}

describe("wrapGeneratorScript", () => {
  it("追加采样循环并保留 sampleOne 调用与 count", () => {
    const script = "function sampleOne() { return []; }";
    const wrapped = wrapGeneratorScript(script, 3);
    expect(wrapped).toContain("function sampleOne");
    expect(wrapped).toContain("__sampleCount = 3");
    expect(wrapped).toContain("__inputs.push(sampleOne())");
    expect(wrapped).toContain("JSON.stringify({ inputs: __inputs })");
  });
});

describe("runInputGenerator", () => {
  it("合法 stdout → 解析为 TypedValue 输入;run 收到包装后的 TS 驱动", async () => {
    const stdout = JSON.stringify({
      inputs: [
        [{ type: "string", value: "a" }],
        [{ type: "string", value: "b" }],
        [{ type: "string", value: "a" }], // 重复,应被去重
      ],
    });
    const executor = executorWith(stdout);
    const result = await runInputGenerator("function sampleOne() { return []; }", 10, executor, SILENT);
    expect(result.errors).toEqual([]);
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0]).toEqual([str("a")]);
    expect(result.inputs[1]).toEqual([str("b")]);
    // run 收到的 driverSource 是包装后的脚本(TS 语言)。
    expect(executor.runCalls).toHaveLength(1);
    expect(executor.runCalls[0]?.language).toBe("TypeScript");
    expect(executor.runCalls[0]?.driverSource).toContain("sampleOne");
  });

  it("stdout 非法 JSON → errors 记录,无输入", async () => {
    const executor = executorWith("not json at all");
    const result = await runInputGenerator("x", 5, executor, SILENT);
    expect(result.inputs).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("not valid JSON"))).toBe(true);
  });

  it("stdout 缺 inputs 数组 → errors 记录", async () => {
    const executor = executorWith(JSON.stringify({ results: [] }));
    const result = await runInputGenerator("x", 5, executor, SILENT);
    expect(result.inputs).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("inputs array"))).toBe(true);
  });

  it("单个非法 TypedValue(缺 type / 非法 number)→ 该条输入被拒并记录错误", async () => {
    const stdout = JSON.stringify({
      inputs: [
        [{ type: "string", value: "ok" }],
        [{ value: "missing type" }],
        [{ type: "number", value: Number.POSITIVE_INFINITY }],
      ],
    });
    const executor = executorWith(stdout);
    const result = await runInputGenerator("x", 10, executor, SILENT);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toEqual([str("ok")]);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("脚本退出码非零 → errors 记录执行失败", async () => {
    const executor = new FakeDriverExecutor({
      compileResults: () => ({ success: true, errors: [], output: "" }),
      runResults: () => ({ exitCode: 1, stdout: "", stderr: "ReferenceError: sampleOne is not defined" }),
    });
    const result = await runInputGenerator("function sampleOne() {}", 5, executor, SILENT);
    expect(result.inputs).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("exited with code 1"))).toBe(true);
  });

  it("超出 count 时多样性采样截断(保留首尾与均匀间隔)", async () => {
    const inputs = [str("a"), str("b"), str("c"), str("d"), str("e")].map((v) => [v] as TypedValue[]);
    const sampled = diversitySample(inputs, 3);
    expect(sampled).toEqual([[str("a")], [str("c")], [str("e")]]);
    expect(diversitySample(inputs, 10)).toHaveLength(5); // 不超过 count 原样返回
    expect(diversitySample(inputs, 1)).toEqual([[str("a")]]);
  });

  it("去重:canonical 等价(map 键序不同)视为重复", async () => {
    const inputs: TypedValue[][] = [
      [{ type: "map", value: { a: str("1"), b: str("2") } }],
      [{ type: "map", value: { b: str("2"), a: str("1") } }],
      [str("x")],
    ];
    expect(dedupeInputs(inputs)).toHaveLength(2);
  });
});

describe("toBatchDescription", () => {
  it("cases = 基础 cases + 生成输入(gen_<i>),基础 expected 保留,生成 expected 为占位", () => {
    const batch = toBatchDescription(baseDescription(), [[str("gen-a")], [num(42)]]);
    expect(batch.cases).toHaveLength(3);
    expect(batch.cases[0]?.id).toBe("base-1");
    expect(batch.cases[0]?.expected).toEqual({ kind: "return", value: str("hello") });
    expect(batch.cases[1]?.id).toBe("gen_000");
    expect(batch.cases[1]?.inputs).toEqual([str("gen-a")]);
    expect(batch.cases[1]?.expected).toEqual({ kind: "return", value: { type: "null", value: null } });
    expect(batch.cases[2]?.id).toBe("gen_001");
    expect(batch.target).toEqual(baseDescription().target);
  });

  it("无生成输入时 batch = 基础描述(退化路径)", () => {
    const batch = toBatchDescription(baseDescription(), []);
    expect(batch.cases).toHaveLength(1);
    expect(batch.cases[0]?.id).toBe("base-1");
  });
});
