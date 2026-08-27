/**
 * consensus 单元测试:规则 R0 全分支 + 相似缺陷污染反例(核心)。
 * 全部 fake,不依赖真实工具链/LLM。
 */
import { describe, expect, it } from "vitest";
import type { TypedValue } from "../description.js";
import type { CaseResult, SideResults } from "../result-capture.js";
import { DISPUTED_DETAIL_PREFIX, buildConsensus, compareAgainstConsensus } from "./consensus.js";

// ---- 测试辅助 ----

function str(value: string): TypedValue {
  return { type: "string", value };
}

function side(label: string, results: CaseResult[]): SideResults {
  return { side: label, results, rawStdout: "", parseErrors: [] };
}

function ret(caseId: string, value: TypedValue): CaseResult {
  return { caseId, outcome: "return", returnValue: value };
}

function exc(caseId: string, exceptionType: string): CaseResult {
  return { caseId, outcome: "exception", exceptionType };
}

/** 参考组三侧:源 + 2 变体,全部输出 X(全一致)。 */
function allAgreeSides(output: TypedValue): SideResults[] {
  return [side("source", [ret("c1", output)]), side("Variant_1", [ret("c1", output)]), side("Variant_2", [ret("c1", output)])];
}

describe("buildConsensus: 规则 R0 oracle 构造", () => {
  it("参考组全一致(|O|=1)→ consensus,agreeingSides=totalSides", () => {
    const oracle = buildConsensus(allAgreeSides(str("ok")));
    const o = oracle.get("c1");
    expect(o).toBeDefined();
    expect(o?.confidence).toBe("consensus");
    expect(o?.outcome).toBe("return");
    expect(o?.returnValue).toEqual(str("ok"));
    expect(o?.agreeingSides).toBe(3);
    expect(o?.totalSides).toBe(3);
    expect(o?.details).toHaveLength(0);
  });

  it("参考组内部分歧(|O|>1)→ disputed,共识输出优先取源侧输出", () => {
    const oracle = buildConsensus([
      side("source", [ret("c1", str("A"))]),
      side("Variant_1", [ret("c1", str("B"))]),
      side("Variant_2", [ret("c1", str("B"))]),
    ]);
    const o = oracle.get("c1");
    expect(o?.confidence).toBe("disputed");
    // 分歧时共识输出 = 源侧输出 A(参考锚),而不是多数输出 B —— 规避多数投票污染。
    expect(o?.returnValue).toEqual(str("A"));
    expect(o?.agreeingSides).toBe(1);
    expect(o?.totalSides).toBe(3);
    expect(o?.distinctOutputs).toHaveLength(2);
    expect(o?.details.some((d) => d.startsWith(DISPUTED_DETAIL_PREFIX))).toBe(true);
  });

  it("异常类型跨语言别名归一化:NullPointerException 与 NullReferenceException 同组", () => {
    const oracle = buildConsensus([
      side("source", [exc("c1", "NullReferenceException")]),
      side("Variant_1", [exc("c1", "NullReferenceException")]),
    ]);
    const o = oracle.get("c1");
    expect(o?.confidence).toBe("consensus");
    expect(o?.outcome).toBe("exception");
    expect(o?.exceptionType).toBe("NullReferenceException");
  });

  it("map 返回值按语义相等分组(键序无关)", () => {
    const oracle = buildConsensus([
      side("source", [ret("c1", { type: "map", value: { a: str("1"), b: str("2") } })]),
      side("Variant_1", [ret("c1", { type: "map", value: { b: str("2"), a: str("1") } })]),
    ]);
    expect(oracle.get("c1")?.confidence).toBe("consensus");
  });

  it("没有任何参考侧产出该 case → 无 oracle 条目", () => {
    const oracle = buildConsensus([side("source", []), side("Variant_1", [])]);
    expect(oracle.size).toBe(0);
  });
});

describe("compareAgainstConsensus: 目标 vs 共识", () => {
  it("consensus 且目标一致 → pass", () => {
    const oracle = buildConsensus(allAgreeSides(str("ok")));
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("ok"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("pass");
    expect(comparisons[0]?.source?.returnValue).toEqual(str("ok"));
  });

  it("consensus 且目标不一致 → fail", () => {
    const oracle = buildConsensus(allAgreeSides(str("ok")));
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("buggy"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("fail");
    expect(comparisons[0]?.details).toContain("return value mismatch");
  });

  it("|O|>1 且目标 ∉ O → fail(高置信:目标与所有参考都不同)", () => {
    const oracle = buildConsensus([
      side("source", [ret("c1", str("A"))]),
      side("Variant_1", [ret("c1", str("B"))]),
    ]);
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("X"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("fail");
    expect(comparisons[0]?.details[0] ?? "").toContain("differs from ALL");
  });

  it("|O|>1 且目标 ∈ O → disputed(divergent 枚举 + details 标注)", () => {
    const oracle = buildConsensus([
      side("source", [ret("c1", str("A"))]),
      side("Variant_1", [ret("c1", str("B"))]),
    ]);
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("B"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("divergent");
    expect(comparisons[0]?.details.some((d) => d.startsWith(DISPUTED_DETAIL_PREFIX))).toBe(true);
    // 不判 fail(低置信)
    expect(comparisons[0]?.details.join(" ")).toContain("low confidence");
  });

  it("k-共识辅助:目标 ∈ O 但与 ≥minAgreeingSides 的一致组冲突 → fail(DFP ≥2 变体一致触发)", () => {
    const oracle = buildConsensus([
      side("source", [ret("c1", str("A"))]),
      side("Variant_1", [ret("c1", str("A"))]),
      side("Variant_2", [ret("c1", str("A"))]),
      side("Variant_3", [ret("c1", str("B"))]),
    ]);
    // 目标 = B:参考组 3:1 分歧,目标命中少数派 —— 与 3 侧一致组冲突 → fail。
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("B"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("fail");
    expect(comparisons[0]?.details.join(" ")).toContain("consensus");
  });

  it("k-共识可配置:minAgreeingSides=3 时 2 侧一致组不触发 → disputed", () => {
    const oracle = buildConsensus(
      [
        side("source", [ret("c1", str("A"))]),
        side("Variant_1", [ret("c1", str("A"))]),
        side("Variant_2", [ret("c1", str("B"))]),
      ],
      { minAgreeingSides: 3 },
    );
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("B"))]), oracle, {
      minAgreeingSides: 3,
    });
    // 2 侧一致组 < 3,不触发 fail → disputed。
    expect(comparisons[0]?.verdict).toBe("divergent");
  });

  it("目标异常与共识异常跨语言等价(IllegalArgumentException ↔ ArgumentException)一致 → pass", () => {
    const oracle = buildConsensus([side("source", [exc("c1", "ArgumentException")]), side("Variant_1", [exc("c1", "ArgumentException")])]);
    const comparisons = compareAgainstConsensus(side("target", [exc("c1", "IllegalArgumentException")]), oracle);
    expect(comparisons[0]?.verdict).toBe("pass");
  });
});

describe("相似缺陷污染反例(核心):多数投票会漏检,R0 不会", () => {
  // 参考组:源输出 C(正确),Variant_1 输出 C(正确),Variant_2/Variant_3 共享缺陷输出 Z。
  // 目标(含缺陷的翻译产物)输出 Z —— 多数投票把 Z 当 oracle → 目标通过 = 漏检。
  function pollutedOracle() {
    return buildConsensus([
      side("source", [ret("c1", str("C"))]),
      side("Variant_1", [ret("c1", str("C"))]),
      side("Variant_2", [ret("c1", str("Z"))]),
      side("Variant_3", [ret("c1", str("Z"))]),
    ]);
  }

  it("目标输出 Z(共享缺陷)→ 不判 pass(R0 判 disputed 或 k-共识正确处理),bug 不被漏检", () => {
    const oracle = pollutedOracle();
    expect(oracle.get("c1")?.confidence).toBe("disputed");
    // 源输出 C 是共识代表(不是多数输出 Z)。
    expect(oracle.get("c1")?.returnValue).toEqual(str("C"));
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("Z"))]), oracle);
    // 必须非 pass:要么 disputed(divergent),要么 k-共识 fail —— 唯独不能 pass。
    expect(comparisons[0]?.verdict).not.toBe("pass");
  });

  it("目标输出 X(∉O)→ fail(多样性优先:不需要多数一致也能触发)", () => {
    const oracle = pollutedOracle();
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("X"))]), oracle);
    expect(comparisons[0]?.verdict).toBe("fail");
  });

  it("目标输出 C(与源一致的正确输出)→ disputed 或 pass,不误报为 fail", () => {
    const oracle = pollutedOracle();
    const comparisons = compareAgainstConsensus(side("target", [ret("c1", str("C"))]), oracle);
    expect(comparisons[0]?.verdict).not.toBe("fail");
  });
});
