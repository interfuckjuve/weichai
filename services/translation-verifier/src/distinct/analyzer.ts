/**
 * 方向 2(DISTINCT):描述引导的分支一致性分析 —— 类型与常量契约(Task 4 剪裁)。
 *
 * 核心主张:非回归场景下被测方法本身可能带缺陷,自动测试生成会把缺陷实现当 ground truth,
 * 产出"复制缺陷行为"的测试(差分两侧一致 → 全 PASS,但 DDR=0)。Analyzer 以 NLD
 * (需求 + case.description + case.branches)为唯一 truth anchor,做分支级一致性判定。
 *
 * Task 4 起 LLM 实现(LlmAnalyzer 与三个方法)随策略自主化删除,本文件仅保留
 * 类型/接口/常量契约,供 distinct runner 提示词(schema 内嵌)与 quality 层消费。
 */

// ---------------------------------------------------------------------------
// 分支清单模型
// ---------------------------------------------------------------------------

/** 单个控制流分支(源方法侧;跨语言时源侧是唯一有完整代码的一侧)。 */
export interface BranchInfo {
  id: string; // "b1","b2",...
  kind: "if" | "switch" | "loop" | "boundary" | "implicit" | "error";
  location: string; // 代码位置描述
  condition: string; // 分支条件的自然语言化
  semantics: string; // 该分支在需求下的预期行为
  nldConsistent: boolean; // 与需求是否一致
  defectNote?: string; // 不一致时的疑似缺陷
}

/** LLM 分支清单(对应论文 Analyzer step 1+2 合并)。 */
export interface BranchInventory {
  methodId: string; // `${className}.${method}`
  methodSummary: string; // LLM 重述的需求语义(补充 NLD)
  branches: BranchInfo[];
}

// ---------------------------------------------------------------------------
// case 一致性模型
// ---------------------------------------------------------------------------

/** 单个 case 的 NLD 一致性判定。 */
export interface CaseConsistency {
  caseId: string;
  touchedBranches: string[]; // 判定触达的分支 id
  assertionConsistent: boolean; // expected 与 NLD 语义一致(而非与源实现一致)
  nldVerdict: "conforms" | "diverges" | "unverified"; // 三态裁决,宁可不判不误报
  recommend: "ok" | "flag-fail" | "fix-assertion" | "add-case";
  reasons: string[];
}

/** Analyzer 完整输出。 */
export interface ConsistencyReport {
  inventory: BranchInventory;
  cases: CaseConsistency[];
  coverage: { covered: string[]; uncovered: string[] }; // 差分覆盖率 = covered.length / total
  augmentations: import("../description.js").TestCase[]; // LLM 为覆盖缺口生成的新 case(由调用方决定是否并入描述重验)
}

// ---------------------------------------------------------------------------
// 覆盖率提供者(退化方案:无插桩 → null → 退回 LLM 判定)
// ---------------------------------------------------------------------------

/** 插桩分支覆盖结果;covered 为触达的分支 id(与 BranchInventory.branches[].id 对齐)。 */
export interface BranchCoverage {
  covered: string[];
  /** 插桩证据描述(供 prompt/日志)。 */
  evidence?: string;
}

/**
 * 覆盖率提供者接口:有插桩时返回真实分支覆盖,无插桩返回 null → Analyzer 退回 LLM 判断。
 * 未来接入 JaCoCo / dotnet-coverage 时实现该接口即可,Analyzer 主体不变。
 */
export interface CoverageProvider {
  getCoverage(
    side: import("../executor.js").SideSpec,
    executor: import("../executor.js").DriverExecutor,
    description: import("../description.js").TestDescription,
  ): Promise<BranchCoverage | null>;
}

/** 无插桩时的默认提供者:恒返回 null(触发 LLM 退化判定)。 */
export class NoneCoverageProvider implements CoverageProvider {
  async getCoverage(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analyzer 接口(LLM 实现 Task 4 起由 distinct 策略自主会话承担)
// ---------------------------------------------------------------------------

export interface AnalyzerLike {
  buildBranchInventory(sourceCode: string, requirement: string, signal?: AbortSignal): Promise<BranchInventory>;
  analyzeCases(
    description: import("../description.js").TestDescription,
    report: import("../verifier.js").VerificationReport,
    inventory: BranchInventory,
    signal?: AbortSignal,
  ): Promise<CaseConsistency[]>;
  generateAugmentations(
    inventory: BranchInventory,
    description: import("../description.js").TestDescription,
    signal?: AbortSignal,
  ): Promise<import("../description.js").TestCase[]>;
}
