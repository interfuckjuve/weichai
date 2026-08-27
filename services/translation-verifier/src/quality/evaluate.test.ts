/**
 * 评估编排端到端单测:小数据集(3 entry,磁盘文件)+ fake LLM + fake executor。
 * 覆盖:quick/full 模式、CSR 计算、conformance 三态评审、检出率(注入→检出)、
 * 误报率(干净不误报)、成本(llmCalls)、--skip-conformance。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDriverExecutor } from "../executor.js";
import type { SpawnClaude } from "../claude-client.js";
import type { QualityDataset } from "./types.js";
import { BaselineAdapter } from "./adapters/baseline.js";
import { DistinctAdapter } from "./adapters/distinct.js";
import { evaluate } from "./evaluate.js";
import type { AdapterContext } from "./adapters.js";

// ---------------------------------------------------------------------------
// fixture:3 个 entry,磁盘文件
// ---------------------------------------------------------------------------

const SOURCE_JAVA = `public class Source {
  public static int clamp(int value, int max) {
    if (value > max) return max;
    return value;
  }
}`;

const TARGET_CS = `public class Target {
  public static int Compute(int value) {
    if (value == 10) return value * 2;
    if (value > 20) return value - 1;
    return value + 1;
  }
}`;

const DESCRIPTION_JSON = JSON.stringify({
  schemaVersion: "1.0",
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

const INVENTORY_BRANCHES = {
  methodId: "Source.clamp",
  methodSummary: "clamp 到上限",
  branches: [{ id: "b1", kind: "if", location: "L1", condition: "value > max", semantics: "返回 max", nldConsistent: true }],
};

/** 策略自主会话的 report.json 夹具(ConsistencyResult;无 flag-fail → 无检出信号)。 */
const CONSISTENCY_RESULT = {
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
    inventory: INVENTORY_BRANCHES,
    cases: [{ caseId: "c01", touchedBranches: ["b1"], assertionConsistent: true, nldVerdict: "conforms", recommend: "ok", reasons: [] }],
    coverage: { covered: ["b1"], uncovered: [] },
    augmentations: [],
  },
  augmented: false,
};

function conformanceSpawn(): SpawnClaude {
  return async (args, _env, _timeoutMs, options) => {
    // 策略自主会话(带 cwd):预写 report.json(ConsistencyResult),runner 读取归一化。
    if (options?.cwd) {
      writeFileSync(join(options.cwd, "report.json"), JSON.stringify(CONSISTENCY_RESULT));
      return { stdout: "done", exitCode: 0 };
    }
    const prompt = args.slice(1).join(" ");
    let stdout = "{}";
    if (prompt.includes("test migration specialist")) stdout = DESCRIPTION_JSON;
    else if (prompt.includes("test-quality reviewer")) stdout = JSON.stringify({ verdict: "conforms", reasoning: "符合需求" });
    return { stdout, exitCode: 0 };
  };
}

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

interface Fixture {
  dir: string;
  dataset: QualityDataset;
  cleanTargetContent: string;
}

function makeFixture(entryCount = 3): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "quality-eval-"));
  const entries = Array.from({ length: entryCount }, (_, i) => {
    const id = `entry-${i}`;
    writeFileSync(join(dir, `Source-${i}.java`), SOURCE_JAVA, "utf-8");
    writeFileSync(join(dir, `Target-${i}.cs`), TARGET_CS, "utf-8");
    return {
      id,
      requirement: `需求 ${i}:返回输入 +1;非法输入抛异常(检索代码返回 null 是历史缺陷)。`,
      source: { language: "Java", file: `Source-${i}.java`, className: "Source", method: "clamp" },
      target: { language: "C#", file: `Target-${i}.cs`, className: "Target", method: "Compute", isStatic: true, constructorArgs: [] },
      requirementDiffs: ["需求明确:非法输入抛异常;检索代码返回 null(历史缺陷)。"],
    };
  });
  return { dir, dataset: { schemaVersion: "1.0", source: "test-dataset", entries }, cleanTargetContent: TARGET_CS };
}

/** fake executor:源侧(Java)/变体固定 42;目标侧(C#)内容变化即注入 → -999。 */
function makeExecutor(fixture: Fixture): FakeDriverExecutor {
  return new FakeDriverExecutor({
    compileResults: { success: true, errors: [], output: "" },
    runResults: (side) => {
      if (side.language === "TypeScript") {
        return { exitCode: 0, stdout: JSON.stringify({ inputs: [[{ type: "number", value: 1 }]] }), stderr: "" };
      }
      const results = caseIdsFromDriver(side.driverSource).map((id) => ({
        caseId: id,
        outcome: "return",
        returnValue: { type: "number", value: 42 },
      }));
      if (side.language === "C#") {
        const module = side.sourceFiles.find((f) => f.relativePath.endsWith(".cs"))?.content ?? "";
        if (module !== fixture.cleanTargetContent) {
          for (const r of results) r.returnValue = { type: "number", value: -999 };
        }
      }
      return { exitCode: 0, stdout: JSON.stringify({ results }), stderr: "" };
    },
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("evaluate 端到端", () => {
  it("quick 模式:CSR/conformance/检出率/误报率/成本 五维齐备", async () => {
    const fixture = makeFixture(3);
    try {
      const executor = makeExecutor(fixture);
      const context: AdapterContext = { llm: { apiKey: "offline-test", spawnClaude: conformanceSpawn() }, executor };
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [new BaselineAdapter(context)],
        mode: "quick",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: conformanceSpawn() },
        rootDir: fixture.dir,
      });
      const baseline = report.adapters.baseline;
      expect(report.dataset.evaluatedEntries).toBe(3);
      expect(baseline.csr).toBe(1); // 全部编译通过
      expect(baseline.conformance.judged).toBe(3);
      expect(baseline.conformance.conforms).toBe(3);
      expect(baseline.conformance.rate).toBe(1);
      expect(baseline.detectionRate).toBe(1); // off-by-one 注入全部检出
      expect(baseline.falsePositiveRate).toBe(0); // 干净目标不误报
      expect(baseline.llmCalls).toBe(3); // 每 entry 1 次生成调用(conformance 不计入成本)
      expect(baseline.perEntry).toHaveLength(3);
      expect(baseline.perEntry[0]!.detections).toHaveLength(1); // quick = 1 策略
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("full 模式:全部 entry + 4 注入策略", async () => {
    const fixture = makeFixture(2);
    try {
      const executor = makeExecutor(fixture);
      const spawn = conformanceSpawn();
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [new BaselineAdapter({ llm: { apiKey: "offline-test", spawnClaude: spawn }, executor })],
        mode: "full",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: spawn },
        rootDir: fixture.dir,
      });
      const baseline = report.adapters.baseline;
      expect(report.dataset.evaluatedEntries).toBe(2);
      expect(baseline.perEntry[0]!.detections).toHaveLength(4);
      expect(baseline.detectionRate).toBe(1);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("--skip-conformance:conformance 全 null,其余指标照常", async () => {
    const fixture = makeFixture(2);
    try {
      const executor = makeExecutor(fixture);
      const spawn = conformanceSpawn();
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [new BaselineAdapter({ llm: { apiKey: "offline-test", spawnClaude: spawn }, executor })],
        mode: "quick",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: spawn },
        rootDir: fixture.dir,
        skipConformance: true,
      });
      const baseline = report.adapters.baseline;
      expect(baseline.conformance.judged).toBe(0);
      expect(baseline.csr).toBe(1);
      expect(baseline.detectionRate).toBe(1);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("distinct 适配器端到端:描述 + flag-fail 信号进入 perEntry", async () => {
    const fixture = makeFixture(1);
    try {
      const executor = makeExecutor(fixture);
      const spawn = conformanceSpawn();
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [new DistinctAdapter({ llm: { apiKey: "offline-test", spawnClaude: spawn }, executor })],
        mode: "quick",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: spawn },
        rootDir: fixture.dir,
      });
      const distinct = report.adapters.distinct;
      expect(distinct.csr).toBe(1);
      expect(distinct.perEntry[0]!.signal).toBeUndefined(); // consistency 无 flag-fail
      expect(distinct.perEntry[0]!.llmCalls).toBe(2); // 描述(TestMigratorAgent)+ 自主会话各 1 次
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("生成失败 entry 记录 error,不中断整体评估", async () => {
    const fixture = makeFixture(1);
    try {
      const executor = makeExecutor(fixture);
      // 坏 spawn:返回非法 JSON → TestMigratorAgent 重试 2 次后失败。
      const badSpawn: SpawnClaude = async () => ({ stdout: "garbage", exitCode: 0 });
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [new BaselineAdapter({ llm: { apiKey: "offline-test", spawnClaude: badSpawn }, executor })],
        mode: "quick",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: badSpawn },
        rootDir: fixture.dir,
      });
      const baseline = report.adapters.baseline;
      expect(baseline.perEntry[0]!.generated).toBe(false);
      expect(baseline.perEntry[0]!.error).toContain("generate-failed");
      expect(baseline.csr).toBe(0);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("多适配器并行评估:baseline + distinct 各自产出报告", async () => {
    const fixture = makeFixture(2);
    try {
      const executor = makeExecutor(fixture);
      const spawn = conformanceSpawn();
      const report = await evaluate({
        dataset: fixture.dataset,
        adapters: [
          new BaselineAdapter({ llm: { apiKey: "offline-test", spawnClaude: spawn }, executor }),
          new DistinctAdapter({ llm: { apiKey: "offline-test", spawnClaude: spawn }, executor }),
        ],
        mode: "quick",
        executor,
        llm: { apiKey: "offline-test", spawnClaude: spawn },
        rootDir: fixture.dir,
      });
      expect(Object.keys(report.adapters).sort()).toEqual(["baseline", "distinct"]);
      expect(report.adapters.baseline.csr).toBe(1);
      expect(report.adapters.distinct.csr).toBe(1);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
