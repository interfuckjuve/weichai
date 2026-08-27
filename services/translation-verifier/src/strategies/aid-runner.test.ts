import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAidRunner } from "./aid-runner.js";
import type { SpawnClaude } from "../claude-client.js";
import type { AIDVerificationReport } from "../variant/aid-verifier.js";
import type { TestStrategyJob } from "./types.js";

const job: TestStrategyJob = {
  requirement: "实现 Mime.decode:把 MIME 编码文本解码为纯文本",
  source: { language: "Java", root: "/tmp/ref-src", files: [{ relativePath: "Mime.java", content: "public class Mime { public static String decode(String s) { if (s == null) return \"\"; return s; } }" }] },
  target: { language: "C#", className: "Mime", method: "Decode", isStatic: true, root: "/tmp/ref-tgt", file: "Mime.cs" },
};

const minimalDescription = {
  schemaVersion: "1.0" as const,
  requirement: "decode MIME",
  target: { language: "Java" as const, className: "Mime", method: "decode", isStatic: true, constructorArgs: [] },
  cases: [{ id: "c1", inputs: [], expected: { kind: "return" as const, value: { type: "string" as const, value: "" } } }],
};

function aidReport(overrides: Partial<AIDVerificationReport> = {}): AIDVerificationReport {
  return {
    schemaVersion: "1.1",
    variants: [{ code: "class V {}", side: { language: "Java", driverSource: "", sourceFiles: [] }, passes: true }],
    oracleSummary: { consensusCount: 3, disputedCount: 0 },
    comparisons: [{ caseId: "c1", verdict: "pass", source: null, target: null, details: [] }],
    passRate: 1,
    totalCases: 1,
    passedCases: 1,
    failedCases: 0,
    disputedCases: 0,
    consensusExpectedConflicts: [],
    baseline: {
      schemaVersion: "1.1",
      description: minimalDescription,
      batchDescription: minimalDescription,
      variants: [],
      oracle: [],
      consensusOptions: {},
      cleanTarget: { usable: true },
      cleanFailedCaseIds: [],
    },
    ...overrides,
  };
}

/**
 * fake spawnClaude:
 * - 变体预生成调用(无 cwd)→ 返回合法变体源码(满足 VariantGeneratorAgent 的提取/改名/长度校验);
 * - 主策略调用(带 cwd)→ 预写 report.json 并返回无关 stdout。
 */
function fakeSpawn(report: AIDVerificationReport): ReturnType<typeof vi.fn> {
  return vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string }) => {
    if (options?.cwd) {
      writeFileSync(join(options.cwd, "report.json"), JSON.stringify(report));
      return { stdout: "done", exitCode: 0 };
    }
    return { stdout: "public class Variant_1 { public int compute(int x) { return x; } }", exitCode: 0 };
  });
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-aid-runner-"));
}

describe("createAidRunner", () => {
  it("预处理器:变体预生成并写入工作目录 variants/(Variant_1..3.java)", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(aidReport());
      const runner = createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      // 变体预生成 3 次(默认 variantCount=3)+ 1 次主调用。
      expect(fake).toHaveBeenCalledTimes(4);
      const variantsDir = join(report.keptDir!, "variants");
      expect(existsSync(join(variantsDir, "Variant_1.java"))).toBe(true);
      expect(existsSync(join(variantsDir, "Variant_3.java"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("主调用提示词包含变体目录与 AID 报告契约;自主会话参数透传", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(aidReport());
      const runner = createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      const mainCall = fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, { cwd?: string; addDirs?: string[]; readOnlyDirs?: string[]; hooksLogPath?: string }];
      expect(mainCall[0][1]).toContain("AID REPORT CONTRACT");
      expect(mainCall[0][1]).toContain(join(report.keptDir!, "variants"));
      expect(mainCall[3].cwd).toBe(report.keptDir);
      expect(mainCall[3].addDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt"), report.keptDir]);
      expect(mainCall[3].readOnlyDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleanTarget.usable=false → status=unverified;failedCases=0 → pass;passRate 取报告", async () => {
    const root = tmpRoot();
    try {
      const unverified = aidReport({ baseline: { ...aidReport().baseline, cleanTarget: { usable: false, note: "target-compile-failed" } } });
      const r1 = await createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fakeSpawn(unverified) as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root }).run(job);
      expect(r1.status).toBe("unverified");
      expect(r1.passRate).toBe(1);

      const failed = aidReport({ failedCases: 2, passedCases: 1, totalCases: 3, passRate: 1 / 3 });
      const r2 = await createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fakeSpawn(failed) as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root }).run(job);
      expect(r2.status).toBe("fail");
      expect(r2.passRate).toBeCloseTo(1 / 3, 6);

      const passed = aidReport();
      const r3 = await createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fakeSpawn(passed) as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root }).run(job);
      expect(r3.status).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=false:目录已删,keptDir undefined", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(aidReport());
      const runner = createAidRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.generatedTestsKept).toBe(false);
      expect(report.keptDir).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
