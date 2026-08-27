import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDistinctRunner } from "./distinct-runner.js";
import type { SpawnClaude } from "../claude-client.js";
import type { ConsistencyResult } from "../distinct/consistency-verifier-types.js";
import type { TestStrategyJob } from "./types.js";

const job: TestStrategyJob = {
  requirement: "实现 StringUtils.split",
  source: { language: "Java", root: "/tmp/ref-src", files: [{ relativePath: "StringUtils.java", content: "public class StringUtils {}" }] },
  target: { language: "C#", className: "StringUtils", method: "Split", isStatic: true, root: "/tmp/ref-tgt", file: "StringUtils.cs" },
};

function distinctResult(overrides: Partial<ConsistencyResult> = {}): ConsistencyResult {
  return {
    report: {
      schemaVersion: "1.0",
      source: { language: "Java", compile: { success: true, errors: [], output: "" }, run: null, results: null },
      target: { language: "C#", compile: { success: true, errors: [], output: "" }, run: null, results: null },
      comparisons: [{ caseId: "c1", verdict: "pass", source: null, target: null, details: [] }],
      passRate: 1,
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      divergentCases: 0,
    },
    consistency: {
      inventory: { methodId: "StringUtils.Split", methodSummary: "split", branches: [] },
      cases: [],
      coverage: { covered: [], uncovered: [] },
      augmentations: [],
    },
    augmented: false,
    ...overrides,
  };
}

/** fake spawnClaude:主调用(带 cwd)时预写 report.json,返回 stdout。 */
function fakeSpawn(report: ConsistencyResult): { fake: ReturnType<typeof vi.fn>; settingsContent: () => string | undefined } {
  let settingsContent: string | undefined;
  const fake = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string; settingsFile?: string }) => {
    // runClaude 在 fake 返回后会删除临时 settings 文件,故在调用内先读走内容。
    if (options?.settingsFile) settingsContent = readFileSync(options.settingsFile, "utf-8");
    if (options?.cwd) writeFileSync(join(options.cwd, "report.json"), JSON.stringify(report));
    return { stdout: "done", exitCode: 0 };
  });
  return { fake, settingsContent: () => settingsContent };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-distinct-runner-"));
}

describe("createDistinctRunner", () => {
  it("fake spawnClaude 捕获自主会话参数透传,提示词为 distinct 任务", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(distinctResult());
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      const call = h.fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, { cwd?: string; addDirs?: string[]; readOnlyDirs?: string[]; settingsFile?: string }];
      expect(call[1]).toBeDefined();
      expect(call[3].cwd).toBe(report.keptDir);
      expect(call[3].addDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt"), report.keptDir]);
      expect(call[3].readOnlyDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt")]);
      // runClaude 以 settingsFile(临时 hooks settings)透传;内容指向 claude-steps.jsonl。
      expect(call[3].settingsFile).toBeTruthy();
      expect(h.settingsContent()).toContain(join(report.keptDir!, "claude-steps.jsonl"));
      expect(call[0][1]).toContain("CONSISTENCY REPORT CONTRACT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failedCases=0 → status=pass;passRate 取自报告", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(distinctResult());
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.strategy).toBe("distinct");
      expect(report.status).toBe("pass");
      expect(report.passRate).toBe(1);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(existsSync(report.keptDir!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failedCases>0 → status=fail", async () => {
    const root = tmpRoot();
    try {
      const base = distinctResult();
      const failed = {
        ...base,
        report: { ...base.report, passRate: 0.5, passedCases: 1, failedCases: 1, totalCases: 2 },
      };
      const fake = fakeSpawn(failed);
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("fail");
      expect(report.passRate).toBe(0.5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failedCases=0 但 divergentCases>0(全 divergent)→ status=fail,不误判 pass", async () => {
    const root = tmpRoot();
    try {
      const base = distinctResult();
      const divergent = {
        ...base,
        report: { ...base.report, passRate: 0, passedCases: 0, failedCases: 0, divergentCases: 2, totalCases: 2 },
      };
      const fake = fakeSpawn(divergent);
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=false:目录已删,keptDir undefined", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(distinctResult());
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.generatedTestsKept).toBe(false);
      expect(report.keptDir).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 缺失 → status=error", async () => {
    const root = tmpRoot();
    try {
      const fake = vi.fn(async () => ({ stdout: "done", exitCode: 0 }));
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("合法 JSON 但缺必填字段(report 对象)→ status=error 且 summary 含 schema 校验原因", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn({ report: undefined } as unknown as ConsistencyResult);
      const runner = createDistinctRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report schema 校验失败");
      expect(report.summary).toContain("report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
