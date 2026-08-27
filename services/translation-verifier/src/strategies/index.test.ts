import { describe, expect, it } from "vitest";
import { createTestStrategy } from "./index.js";

describe("createTestStrategy", () => {
  const options = { llm: { apiKey: "test-key" } };

  it("分发到四个 runner(均暴露 run)", () => {
    for (const strategy of ["smoke", "distinct", "aid", "mitgen"] as const) {
      const runner = createTestStrategy(strategy, options);
      expect(typeof runner.run).toBe("function");
    }
  });

  it("非法策略抛错", () => {
    expect(() => createTestStrategy("nope" as never, options)).toThrow(/未知策略|unknown/i);
  });

  it("类型导出存在(编译期)", () => {
    // 仅验证 index 模块可加载且导出函数签名正确。
    const runner = createTestStrategy("smoke", options);
    expect(runner.run).toBeDefined();
  });
});
