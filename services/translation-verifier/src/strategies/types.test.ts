import { describe, expect, it } from "vitest";
import type {
  StrategySide,
  StrategyRunOptions,
  TestStrategy,
  TestStrategyJob,
  TestStrategyReport,
  TestStrategyRunner,
} from "./types.js";

describe("types 契约(判别联合编译检查)", () => {
  it("TestStrategy 为四策略之一", () => {
    const all: TestStrategy[] = ["smoke", "distinct", "aid", "mitgen"];
    expect(all).toHaveLength(4);
  });

  it("StrategySide:language 必填,files/root 可选", () => {
    const side: StrategySide = {
      language: "Java",
      files: [{ relativePath: "Add.java", content: "class Add {}" }],
    };
    expect(side.language).toBe("Java");
    expect(side.files).toHaveLength(1);

    const minimal: StrategySide = { language: "Python", root: "/repo/src" };
    expect(minimal.root).toBe("/repo/src");
    expect(minimal.files).toBeUndefined();
  });

  it("TestStrategyJob:source/target 组合可构造", () => {
    const job: TestStrategyJob = {
      requirement: "把 Add.add 从 Java 翻译为 C#",
      source: {
        language: "Java",
        files: [
          {
            relativePath: "Add.java",
            content: "public class Add { public int add(int a, int b) { return a + b; } }",
          },
        ],
      },
      target: { language: "C#", className: "Add", method: "add", isStatic: false, file: "Add.cs" },
    };
    expect(job.requirement).toContain("Add");
    expect(job.target.className).toBe("Add");
    expect(job.target.method).toBe("add");
    expect(job.target.isStatic).toBe(false);
    expect(job.target.file).toBe("Add.cs");
    expect(job.source.root).toBeUndefined();
  });

  it("StrategyRunOptions 字段全部可选", () => {
    const opts: StrategyRunOptions = {
      keepGeneratedTests: true,
      workspaceRoot: "/tmp/test-results",
      claudeSandbox: { readOnlyDirs: ["/repo/src"], writableDir: "/tmp/out" },
      maxTurns: 30,
      apiKey: "k",
      model: "claude",
      timeoutMs: 60_000,
    };
    expect(opts.keepGeneratedTests).toBe(true);
    expect(opts.claudeSandbox?.readOnlyDirs).toEqual(["/repo/src"]);

    const defaults: StrategyRunOptions = {};
    expect(defaults.maxTurns).toBeUndefined();
    expect(defaults.keepGeneratedTests).toBeUndefined();
  });

  it("detail 判别联合:in 收窄后访问策略专属字段(smoke)", () => {
    const smoke: TestStrategyReport = {
      strategy: "smoke",
      status: "pass",
      passRate: 1,
      summary: "全部通过",
      durationMs: 1200,
      generatedTestsKept: false,
      detail: {
        converged: true,
        steps: 3,
        rounds: 0,
        cases: [],
        targetFiles: [],
        sourceIssues: [],
        summary: "全部通过",
      },
    };
    if ("converged" in smoke.detail) {
      // 编译期:detail 已收窄为 SmokeReport
      expect(smoke.detail.converged).toBe(true);
      expect(smoke.detail.rounds).toBe(0);
    }
    expect(smoke.durationMs).toBeGreaterThan(0);
  });

  it("detail 判别联合:in 收窄后访问 mitgen 专属字段", () => {
    const mitgen: TestStrategyReport = {
      strategy: "mitgen",
      status: "unverified",
      summary: "待人工复核",
      durationMs: 500,
      generatedTestsKept: true,
      keptDir: "/tmp/x",
      detail: {
        description: {
          schemaVersion: "1.0",
          target: {
            language: "C#",
            className: "Add",
            method: "add",
            isStatic: false,
            constructorArgs: [],
          },
          cases: [
            {
              id: "c1",
              inputs: [
                { type: "number", value: 1 },
                { type: "number", value: 2 },
              ],
              expected: { kind: "return", value: { type: "number", value: 3 } },
            },
          ],
        },
        fragments: [],
      },
    };
    if ("fragments" in mitgen.detail) {
      expect(mitgen.detail.fragments).toEqual([]);
      expect(mitgen.detail.description.cases).toHaveLength(1);
    }
  });

  it("detail 判别联合:distinct/aid 成员可用(全量构造留给 Task 3 runner 测试)", () => {
    const distinct = {
      strategy: "distinct",
      status: "fail",
      summary: "s",
      durationMs: 1,
      generatedTestsKept: false,
      detail: { augmented: true },
    } as TestStrategyReport;
    const aid = {
      strategy: "aid",
      status: "error",
      summary: "s",
      durationMs: 1,
      generatedTestsKept: false,
      detail: { schemaVersion: "1.1" },
    } as TestStrategyReport;
    expect(distinct.strategy).toBe("distinct");
    expect(aid.strategy).toBe("aid");
  });

  it("TestStrategyRunner 接口可满足(run 返回 TestStrategyReport)", async () => {
    const runner: TestStrategyRunner = {
      async run(job, signal) {
        expect(signal).toBeUndefined();
        return {
          strategy: "smoke",
          status: "pass",
          summary: job.requirement,
          durationMs: 0,
          generatedTestsKept: false,
          detail: {
            converged: true,
            steps: 1,
            rounds: 0,
            cases: [],
            targetFiles: [],
            sourceIssues: [],
            summary: job.requirement,
          },
        };
      },
    };
    const job: TestStrategyJob = {
      requirement: "r",
      source: { language: "Java" },
      target: { language: "C#", className: "A", method: "m", isStatic: false },
    };
    const report = await runner.run(job);
    expect(report.status).toBe("pass");
    expect(report.summary).toBe("r");
  });
});
