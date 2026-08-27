import { describe, expect, it } from "vitest";
import { NoneCoverageProvider, type AnalyzerLike, type BranchInventory, type CaseConsistency, type CoverageProvider } from "./analyzer.js";

/**
 * Task 4 剪裁后 analyzer.ts 仅保留类型/常量契约:
 * - LLM 实现(LlmAnalyzer 三方法)与 prompt 构建随策略自主化删除;
 * - runConsistencyVerification 编排删除;
 * - 本测试仅覆盖保留的可执行件(NoneCoverageProvider)与类型契约(编译期)。
 */

const inventory: BranchInventory = {
  methodId: "Calculator.add",
  methodSummary: "需求语义:add 返回两数之和;输入为 null 时返回 0。",
  branches: [
    { id: "b1", kind: "if", location: "方法开头", condition: "任一输入为 null", semantics: "返回 0", nldConsistent: true },
  ],
};

describe("Analyzer 类型契约(Task 4 剪裁保留)", () => {
  it("NoneCoverageProvider 恒返回 null(无插桩默认提供者,触发 LLM 退化判定)", async () => {
    const provider: CoverageProvider = new NoneCoverageProvider();
    await expect(provider.getCoverage({} as never, {} as never, {} as never)).resolves.toBeNull();
  });

  it("AnalyzerLike 接口签名可被结构化对象满足(编排层兼容契约)", () => {
    const analyzer: AnalyzerLike = {
      buildBranchInventory: async () => inventory,
      analyzeCases: async (): Promise<CaseConsistency[]> => [],
      generateAugmentations: async () => [],
    };
    expect(typeof analyzer.buildBranchInventory).toBe("function");
    expect(typeof analyzer.analyzeCases).toBe("function");
    expect(typeof analyzer.generateAugmentations).toBe("function");
  });
});
