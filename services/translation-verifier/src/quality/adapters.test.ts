/**
 * 五个生成器适配器的调用链单测(Task 4 起走统一策略入口)。
 * 覆盖:baseline(描述 + 成本计数)、smoke/distinct/aid/mitgen(createTestStrategy 自主
 * 会话,离线夹具 = fake spawnClaude 把预设 report.json 写入策略工作目录,runner 读取归一化)。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriverExecutor, type RunOutcome } from "../executor.js";
import type { SpawnClaude } from "../claude-client.js";
import type { DatasetEntry, QualityTask } from "./types.js";
import { BaselineAdapter } from "./adapters/baseline.js";
import { SmokeAdapter } from "./adapters/smoke.js";
import { DistinctAdapter } from "./adapters/distinct.js";
import { AidAdapter } from "./adapters/aid.js";
import { MitGenAdapter } from "./adapters/mitgen.js";
import { splitDriverEntry } from "../smoke/driver-entry.js";
import type { AdapterContext } from "./adapters.js";
import type { AIDVerificationReport, AIDReplayBaseline } from "../aid/aid-verifier.js";
import type { TestDescription, TypedValue } from "../description.js";

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

const ENTRY: DatasetEntry = {
  id: "ParameterParser.parse",
  requirement: "解析参数对:空输入抛异常,非法引号输入抛异常(检索代码返回 null 是历史缺陷)。",
  source: { language: "Java", file: "src/Source.java", className: "Source", method: "clamp" },
  target: { language: "C#", file: "src/Target.cs", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  requirementDiffs: ["需求明确:非法输入抛异常;检索代码返回 null(历史缺陷)。"],
};

const SOURCE_JAVA = `public class Source {
  public static int clamp(int value, int max) {
    if (value > max) {
      return max;
    }
    return value;
  }
}`;

const TARGET_CS = `public class Target {
  public static int Compute(int value) {
    if (value > 10) return value * 2;
    return value + 1;
  }
}`;

const DESCRIPTION_JSON = JSON.stringify({
  schemaVersion: "1.0",
  requirement: ENTRY.requirement,
  target: { language: "C#", className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "c01",
      description: "场景:常规输入 / 触发行为:计算 / 目标分支或边界:nominal",
      inputs: [{ type: "number", value: 1 }],
      expected: { kind: "return", value: { type: "number", value: 42 } },
    },
  ],
});

const descriptionFixture = () => JSON.parse(DESCRIPTION_JSON) as TestDescription;

function makeTask(): QualityTask {
  return {
    entry: ENTRY,
    source: { language: "Java", driverSource: "", sourceFiles: [{ relativePath: "Source.java", content: SOURCE_JAVA }] },
    target: { language: "C#", driverSource: "", sourceFiles: [{ relativePath: "Target.cs", content: TARGET_CS }] },
  };
}

/** 按序返回 stdout 的 fake spawnClaude(旧调用链测试用)。 */
function scriptedSpawn(responses: string[]): SpawnClaude {
  let index = 0;
  return async () => ({ stdout: responses[index++] ?? "", exitCode: 0 });
}

const fakeExecutor = (runOutcome?: RunOutcome) =>
  new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: runOutcome ?? {
      exitCode: 0,
      stdout: JSON.stringify({ results: [{ caseId: "c01", outcome: "return", returnValue: { type: "number", value: 42 } }] }),
      stderr: "",
    },
  });

function ctx(spawn: SpawnClaude, executor?: FakeDriverExecutor): AdapterContext {
  return {
    llm: { apiKey: "offline-test", spawnClaude: spawn },
    executor: executor ?? fakeExecutor(),
    logger: undefined,
  };
}

// ---------------------------------------------------------------------------
// 策略自主会话离线夹具
// ---------------------------------------------------------------------------

/**
 * 策略 runner 的 fake spawnClaude:
 * - 主调用(runClaude 带 cwd 的自主会话,第四参数 options.cwd 存在)→ 把预设 report.json
 *   写入工作目录(可选同时写入 keptDir 附加文件),stdout 无关紧要;
 * - 其余调用(无 cwd,如 TestMigratorAgent 描述 / aid 变体预处理器)→ 按序返回 variantCodes
 *   (aid 变体生成需要含 public class 的源码),缺省返回 description(TestMigratorAgent 描述)。
 */
function strategySpawn(opts: {
  report: unknown;
  variantCodes?: string[];
  description?: string;
  workspaceExtra?: Record<string, string>;
}): SpawnClaude {
  const variantCodes = opts.variantCodes ?? [];
  let variantIndex = 0;
  return async (_args, _env, _timeoutMs, options) => {
    if (options?.cwd) {
      writeFileSync(join(options.cwd, "report.json"), JSON.stringify(opts.report));
      for (const [name, content] of Object.entries(opts.workspaceExtra ?? {})) {
        writeFileSync(join(options.cwd, name), content, "utf-8");
      }
      return { stdout: "done", exitCode: 0 };
    }
    if (variantIndex < variantCodes.length) {
      return { stdout: variantCodes[variantIndex++], exitCode: 0 };
    }
    return { stdout: opts.description ?? "{}", exitCode: 0 };
  };
}

/** 策略类适配器测试上下文:注入独立临时 workspaceRoot(避免污染默认 test-results)。 */
function strategyCtx(
  spawn: SpawnClaude,
  extra: Partial<AdapterContext> = {},
  executor?: FakeDriverExecutor,
): { ctx: AdapterContext; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "quality-strategy-"));
  return {
    ctx: { ...ctx(spawn, executor), workspaceRoot: ws, ...extra },
    cleanup: () => rmSync(ws, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// baseline(不变:TestMigratorAgent 直接调用)
// ---------------------------------------------------------------------------

describe("BaselineAdapter", () => {
  it("需求+源码 → 描述(含 expected),成本 = 1 次 LLM 调用", async () => {
    const adapter = new BaselineAdapter(ctx(scriptedSpawn([DESCRIPTION_JSON])));
    const test = await adapter.generateTest(makeTask());
    expect(test.kind).toBe("description");
    expect(test.description?.cases[0]?.id).toBe("c01");
    expect(test.meta.llmCalls).toBe(1);
  });

  it("非法 LLM 输出触发重试,成本统计含重试次数", async () => {
    const adapter = new BaselineAdapter(ctx(scriptedSpawn(["not json", DESCRIPTION_JSON])));
    const test = await adapter.generateTest(makeTask());
    expect(test.description?.cases).toHaveLength(1);
    expect(test.meta.llmCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// smoke(策略自主会话 → runner 文件 + SmokeReport)
// ---------------------------------------------------------------------------

function smokeReportFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    converged: true,
    steps: 5,
    rounds: 0,
    cases: [
      { caseId: "c01", intent: "常规输入返回 +1", source: null, target: null, mechanical: "pass", decision: "pass", reasoning: "两侧一致" },
    ],
    targetFiles: [
      { path: "Driver.cs", content: "public class Driver { public static void Main(string[] args) {} }" },
      { path: "Helper.cs", content: "public class Helper { }" },
    ],
    sourceIssues: [],
    summary: "1/1 用例行为一致",
    ...overrides,
  };
}

describe("SmokeAdapter", () => {
  it("策略自主会话 → runner 文件(targetFiles)+ SmokeReport(converged)", async () => {
    const spawn = strategySpawn({ report: smokeReportFixture() });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn);
    try {
      const adapter = new SmokeAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("runner");
      expect(test.runner?.files.length).toBeGreaterThan(0);
      expect(test.runner?.files.some((f) => f.path === "Driver.cs")).toBe(true);
      expect(test.runner?.report?.converged).toBe(true);
      expect(test.runner?.report?.cases.some((c) => c.decision === "pass")).toBe(true);
      expect(test.meta.llmCalls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("策略 error(报告缺失)→ 空 runner + 无报告,不抛未捕获异常(no-runner 语义)", async () => {
    // fake 主调用不写 report.json → runner 读报告失败 → status=error。
    const noWrite = async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({ stdout: "done", exitCode: 0 });
    const adapterCtx = strategyCtx(noWrite as SpawnClaude);
    try {
      const adapter = new SmokeAdapter(adapterCtx.ctx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("runner");
      expect(test.runner?.files).toEqual([]);
      expect(test.runner?.report).toBeUndefined();
    } finally {
      adapterCtx.cleanup();
    }
  });

  it("keepGeneratedTests=true 且 targetFiles 为空:从 keptDir 读取 runner 文件", async () => {
    const spawn = strategySpawn({
      report: smokeReportFixture({ targetFiles: [] }),
      workspaceExtra: { "Runner.java": "public class Runner { public static void main(String[] a) {} }" },
    });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn, { keepGeneratedTests: true });
    try {
      const adapter = new SmokeAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("runner");
      expect(test.runner?.files.some((f) => f.path === "Runner.java")).toBe(true);
      expect(test.runner?.report?.converged).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("收敛报告携带 runnerFiles(双侧 runner/driver)时 runner.files 非空且可被 splitDriverEntry 拆分", async () => {
    const spawn = strategySpawn({
      report: smokeReportFixture({
        targetFiles: [],
        runnerFiles: [
          {
            side: "source",
            language: "Java",
            files: [
              { path: "SmokeDriver.java", content: "public class SmokeDriver { public static void main(String[] args) {} }" },
              { path: "Source.java", content: SOURCE_JAVA },
            ],
          },
          {
            side: "target",
            language: "C#",
            files: [
              { path: "Driver.cs", content: "public class Driver { public static void Main(string[] args) {} }" },
              { path: "Target.cs", content: TARGET_CS },
            ],
          },
        ],
      }),
    });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn);
    try {
      const adapter = new SmokeAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("runner");
      // 双侧合并(目标侧在前):4 个文件全部保留 path/content。
      expect(test.runner?.files).toHaveLength(4);
      expect(test.runner?.files.map((f) => f.path)).toEqual(["Driver.cs", "Target.cs", "SmokeDriver.java", "Source.java"]);
      expect(test.runner?.files.find((f) => f.path === "Target.cs")?.content).toContain("class Target");
      // Java 入口识别:含 main 的 public class 文件可被拆分(驱动 + 附加文件)。
      const split = splitDriverEntry("Java", test.runner!.files);
      expect(split.driverSource).toContain("public static void main");
      expect(split.extraFiles).toHaveLength(3);
      expect(test.runner?.report?.converged).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("keptDir 回退读取跳过子目录与二进制(.class 等),不 EISDIR 不产出乱码", async () => {
    // 自定义 fake:主调用时在工作目录写入 report.json + 文本 Driver.cs + 子目录 bin/ + 二进制 .class。
    const spawn = async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string }) => {
      if (options?.cwd) {
        const cwd = options.cwd;
        writeFileSync(join(cwd, "report.json"), JSON.stringify(smokeReportFixture({ targetFiles: [], runnerFiles: undefined })));
        writeFileSync(join(cwd, "Driver.cs"), "public class Driver { public static void Main(string[] args) {} }");
        mkdirSync(join(cwd, "bin"), { recursive: true });
        writeFileSync(join(cwd, "bin", "Target.class"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00])); // 魔数非 utf-8
        writeFileSync(join(cwd, "bin", "Helper.cs"), "public class Helper { }"); // 子目录内文本也不应被读到顶层
      }
      return { stdout: "done", exitCode: 0 };
    };
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn as SpawnClaude, { keepGeneratedTests: true });
    try {
      const adapter = new SmokeAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("runner");
      // 只读顶层文本文件:二进制 .class 与子目录 bin/ 均被跳过。
      expect(test.runner?.files.map((f) => f.path)).toEqual(["Driver.cs"]);
      expect(test.runner?.files[0]?.content).toContain("class Driver");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// distinct(baseline 描述 + 策略 ConsistencyResult → flag-fail 信号)
// ---------------------------------------------------------------------------

function consistencyResultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: {
      schemaVersion: "1.0",
      source: { language: "Java", compile: { success: true, errors: [], output: "" }, run: null, results: null },
      target: { language: "C#", compile: { success: true, errors: [], output: "" }, run: null, results: null },
      comparisons: [{ caseId: "c01", verdict: "pass", source: null, target: null, details: [] }],
      passRate: 1,
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      divergentCases: 0,
    },
    consistency: {
      inventory: {
        methodId: "Source.clamp",
        methodSummary: "clamp 到 [0, max]",
        branches: [{ id: "b1", kind: "if", location: "L1", condition: "value > max", semantics: "返回 max", nldConsistent: true }],
      },
      cases: [
        { caseId: "c01", touchedBranches: ["b1"], assertionConsistent: false, nldVerdict: "diverges", recommend: "flag-fail", reasons: ["expected 照抄了检索代码的旧行为"] },
      ],
      coverage: { covered: ["b1"], uncovered: [] },
      augmentations: [],
    },
    augmented: false,
    ...overrides,
  };
}

describe("DistinctAdapter", () => {
  it("baseline 描述 + 策略 ConsistencyResult → flag-fail 信号(偏离需求)", async () => {
    const spawn = strategySpawn({ report: consistencyResultFixture(), description: DESCRIPTION_JSON });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn, {}, fakeExecutor());
    try {
      const adapter = new DistinctAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("description");
      expect(test.description?.cases[0]?.id).toBe("c01");
      expect(test.meta.signal?.kind).toBe("flag-fail");
      expect(test.meta.signal?.caseIds).toEqual(["c01"]);
      // 描述 1 次(TestMigratorAgent)+ 自主会话 1 次,成本经计数包装统计。
      expect(test.meta.llmCalls).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("无 flag-fail 时不带检出信号", async () => {
    const spawn = strategySpawn({
      report: consistencyResultFixture({
        consistency: {
          ...(consistencyResultFixture().consistency as object),
          cases: [
            { caseId: "c01", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] },
          ],
        },
      }),
      description: DESCRIPTION_JSON,
    });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn, {}, fakeExecutor());
    try {
      const adapter = new DistinctAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.meta.signal).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("策略 error → 抛错(保持既有失败语义,evaluate 层按生成失败记录)", async () => {
    const noWrite = async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string }) => {
      if (options?.cwd) return { stdout: "done", exitCode: 0 }; // 不写 report.json → status=error
      return { stdout: DESCRIPTION_JSON, exitCode: 0 };
    };
    const { ctx: adapterCtx, cleanup } = strategyCtx(noWrite as SpawnClaude, {}, fakeExecutor());
    try {
      const adapter = new DistinctAdapter(adapterCtx);
      await expect(adapter.generateTest(makeTask())).rejects.toThrow(/distinct 策略失败/);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// aid(策略自主会话 → baseline.description + 共识差分信号;detectOnTarget 复用冻结基线)
// ---------------------------------------------------------------------------

/** 从驱动源码提取全部 caseId(Java/C# 两种驱动格式)。 */
function caseIdsFromDriver(driverSource: string): string[] {
  const ids: string[] = [];
  const re = /(?:name|Name)\("caseId"\)\.(?:value|Value)\("([^"]*)"\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(driverSource)) !== null) {
    ids.push(m[1] as string);
  }
  return ids;
}

function variantCode(index: number): string {
  return `public class Variant_${index} {
  public static int clamp(int value, int max) {
    return Math.min(value, max);
  }
}`;
}

/** 构造离线 AIDVerificationReport:描述(2 case)+ 冻结 oracle(consensus,期望 42)。 */
function aidReportFixture(): AIDVerificationReport {
  const description = descriptionFixture();
  const batchDescription: TestDescription = {
    ...description,
    cases: [
      ...description.cases,
      {
        id: "c02",
        description: "场景:边界输入 / 触发行为:计算 / 目标分支或边界:boundary",
        inputs: [{ type: "number", value: 11 }],
        expected: { kind: "return", value: { type: "number", value: 42 } },
      },
    ],
  };
  const oracle = [
    { caseId: "c01", outcome: "return", returnValue: { type: "number", value: 42 }, confidence: "consensus", agreeingSides: 2, totalSides: 2, details: [], distinctOutputs: [] },
    { caseId: "c02", outcome: "return", returnValue: { type: "number", value: 42 }, confidence: "consensus", agreeingSides: 2, totalSides: 2, details: [], distinctOutputs: [] },
  ] as AIDVerificationReport["baseline"]["oracle"];
  const baseline: AIDReplayBaseline = {
    schemaVersion: "1.1",
    description,
    batchDescription,
    variants: [],
    oracle,
    consensusOptions: {},
    cleanTarget: { usable: true },
    cleanFailedCaseIds: [],
  };
  return {
    schemaVersion: "1.1",
    variants: [],
    oracleSummary: { consensusCount: 2, disputedCount: 0 },
    comparisons: [
      { caseId: "c01", verdict: "pass", source: null, target: null, details: [] },
      { caseId: "c02", verdict: "pass", source: null, target: null, details: [] },
    ],
    passRate: 1,
    totalCases: 2,
    passedCases: 2,
    failedCases: 0,
    disputedCases: 0,
    consensusExpectedConflicts: [],
    baseline,
  };
}

/** FakeDriverExecutor:按驱动 caseId 返回结果;buggy 模块(-999)→ 全部 -999;partial → 仅首个 case。 */
function aidExecutor(cleanTarget: string, buggyMark = "-999", partialResultMark = "partial-target") {
  return new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: (side) => {
      if (side.language === "TypeScript") {
        return { exitCode: 0, stdout: JSON.stringify({ inputs: [[{ type: "number", value: 1 }]] }), stderr: "" };
      }
      const ids = caseIdsFromDriver(side.driverSource);
      const results: { caseId: string; outcome: "return"; returnValue: TypedValue }[] = ids.map((id) => ({
        caseId: id,
        outcome: "return",
        returnValue: { type: "number", value: 42 },
      }));
      if (side.language === "C#") {
        const module = side.sourceFiles.find((f) => f.relativePath.endsWith(".cs"))?.content ?? "";
        if (module.includes(partialResultMark)) {
          return { exitCode: 0, stdout: JSON.stringify({ results: results.slice(0, 1) }), stderr: "" };
        }
        if (module !== cleanTarget && module.includes(buggyMark)) {
          for (const r of results) r.returnValue = { type: "number", value: -999 };
        }
      }
      return { exitCode: 0, stdout: JSON.stringify({ results }), stderr: "" };
    },
  });
}

function aidSpawn(): SpawnClaude {
  return strategySpawn({
    report: aidReportFixture(),
    variantCodes: [variantCode(1), variantCode(2), variantCode(3)],
  });
}

describe("AidAdapter", () => {
  it("策略自主会话 → baseline.description + 共识差分信号(干净目标全 pass)", async () => {
    const spawn = aidSpawn();
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn, {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("description");
      expect(test.description?.cases[0]?.id).toBe("c01");
      expect(test.meta.signal?.kind).toBe("aid-differential");
      expect(test.meta.signal?.detail).toContain("failed=0");
      // 变体预生成 3 次 + 主会话 1 次。
      expect(test.meta.llmCalls).toBe(4);
      expect(test.meta.aidBaseline?.cleanTarget.usable).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:注入 bug 后共识差分 fail > clean → 检出", async () => {
    const executor = aidExecutor(TARGET_CS);
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, executor);
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const buggy = TARGET_CS.replace("value + 1", "return -999;");
      // evaluate() 会浅复制 test 并替换 description;基线必须随 meta 保留。
      const replayableTest = { ...test, description: { ...test.description! } };
      const result = await adapter.detectOnTarget(makeTask(), replayableTest, buggy);
      expect(result.detected).toBe(true);
      expect(result.failedCasesBuggy).toBeGreaterThan(result.failedCasesClean);
      expect(result.newFailedCaseIds.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:干净目标不检出", async () => {
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const result = await adapter.detectOnTarget(makeTask(), test, TARGET_CS);
      expect(result.detected).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:缺少 clean 基线时拒绝重新生成", async () => {
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const withoutBaseline = { ...test, meta: { ...test.meta, aidBaseline: undefined } };
      const result = await adapter.detectOnTarget(makeTask(), withoutBaseline, TARGET_CS);
      expect(result.detected).toBe(false);
      expect(result.note).toBe("clean-baseline-unavailable");
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:clean 基线目标不可用时拒绝将注入结果计为检出", async () => {
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const baseline = test.meta.aidBaseline!;
      const unusableTest = {
        ...test,
        meta: { ...test.meta, aidBaseline: { ...baseline, cleanTarget: { usable: false, note: "target-run-failed" } } },
      };
      const result = await adapter.detectOnTarget(makeTask(), unusableTest, TARGET_CS.replace("value + 1", "return -999;"));
      expect(result.detected).toBe(false);
      expect(result.note).toBe("clean-baseline-unusable:target-run-failed");
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:没有 consensus oracle 时拒绝计入检出率", async () => {
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const baseline = test.meta.aidBaseline!;
      const unusableTest = { ...test, meta: { ...test.meta, aidBaseline: { ...baseline, oracle: [] } } };
      const result = await adapter.detectOnTarget(makeTask(), unusableTest, TARGET_CS.replace("value + 1", "return -999;"));
      expect(result.detected).toBe(false);
      expect(result.note).toBe("clean-baseline-unusable:no-consensus-oracle");
    } finally {
      cleanup();
    }
  });

  it("detectOnTarget:注入目标未返回完整 batch 时标记为不可验证", async () => {
    const { ctx: adapterCtx, cleanup } = strategyCtx(aidSpawn(), {}, aidExecutor(TARGET_CS));
    try {
      const adapter = new AidAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      const result = await adapter.detectOnTarget(makeTask(), test, `${TARGET_CS}\n// partial-target`);
      expect(result.detected).toBe(false);
      expect(result.note).toBe("target-unusable");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// mitgen(策略自主会话 → MitGenResult.description + 片段摘要)
// ---------------------------------------------------------------------------

function mitgenResultFixture(): Record<string, unknown> {
  return {
    description: JSON.parse(DESCRIPTION_JSON),
    fragments: [
      {
        fragmentId: "frag-01",
        sourceCode: "if (value > 10) return value * 2;",
        correspondence: "equivalent",
        correspondenceNote: "",
        cases: [],
        reachability: "verified",
      },
    ],
  };
}

describe("MitGenAdapter", () => {
  it("策略自主会话 → 描述(schema 校验通过)+ 片段摘要信号", async () => {
    const spawn = strategySpawn({ report: mitgenResultFixture() });
    const { ctx: adapterCtx, cleanup } = strategyCtx(spawn);
    try {
      const adapter = new MitGenAdapter(adapterCtx);
      const test = await adapter.generateTest(makeTask());
      expect(test.kind).toBe("description");
      expect(test.description?.cases[0]?.id).toBe("c01");
      expect(test.meta.signal?.kind).toBe("mitgen-fragments");
      expect(test.meta.signal?.detail).toContain("fragments=1");
      expect(test.meta.signal?.detail).toContain("verified=1");
      expect(test.meta.llmCalls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("策略 error → 抛错(保持既有失败语义)", async () => {
    const noWrite = async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string }) => {
      if (options?.cwd) return { stdout: "done", exitCode: 0 };
      return { stdout: "{}", exitCode: 0 };
    };
    const { ctx: adapterCtx, cleanup } = strategyCtx(noWrite as SpawnClaude);
    try {
      const adapter = new MitGenAdapter(adapterCtx);
      await expect(adapter.generateTest(makeTask())).rejects.toThrow(/mitgen 策略失败/);
    } finally {
      cleanup();
    }
  });
});
