import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSmokeRunner } from "./smoke-runner.js";
import type { SpawnClaude } from "../claude-client.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import type { TestStrategyJob } from "./types.js";

const job: TestStrategyJob = {
  requirement: "decode MIME text",
  source: { language: "Java", root: "/tmp/ref-src", files: [{ relativePath: "Mime.java", content: "public class Mime {}" }] },
  target: { language: "C#", className: "Mime", method: "Decode", isStatic: true, root: "/tmp/ref-tgt", file: "Mime.cs" },
};

function smokeReport(overrides: Partial<SmokeReport> = {}): SmokeReport {
  return {
    converged: true,
    steps: 5,
    rounds: 0,
    cases: [
      { caseId: "c1", intent: "empty", source: null, target: null, mechanical: "pass", decision: "pass", reasoning: "ok" },
      { caseId: "c2", intent: "null", source: null, target: null, mechanical: "fail", decision: "translation-bug", reasoning: "diff" },
    ],
    targetFiles: [],
    sourceIssues: [],
    summary: "2 用例 1 通过",
    ...overrides,
  };
}

interface FakeHandle {
  fake: ReturnType<typeof vi.fn>;
  mainCwd: () => string | undefined;
  settingsContent: () => string | undefined;
  lastCall: () => { args: string[]; options: { cwd?: string; addDirs?: string[]; readOnlyDirs?: string[]; settingsFile?: string; maxTurns?: number; permissionMode?: string } };
}

/** fake spawnClaude:主调用(带 cwd)时把 report.json 预写入工作目录,stdout 无关紧要。 */
function fakeSpawn(report: SmokeReport): FakeHandle {
  let mainCwd: string | undefined;
  let settingsContent: string | undefined;
  const fake = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string; settingsFile?: string }) => {
    // runClaude 在 fake 返回后会删除临时 settings 文件,故在调用内先读走内容。
    if (options?.settingsFile) settingsContent = readFileSync(options.settingsFile, "utf-8");
    if (options?.cwd) {
      mainCwd = options.cwd;
      writeFileSync(join(options.cwd, "report.json"), JSON.stringify(report));
    }
    return { stdout: "done", exitCode: 0 };
  });
  return {
    fake,
    mainCwd: () => mainCwd,
    settingsContent: () => settingsContent,
    lastCall: () => {
      const call = fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, { cwd?: string; addDirs?: string[]; readOnlyDirs?: string[]; settingsFile?: string; maxTurns?: number; permissionMode?: string }];
      return { args: call[0], options: call[3] };
    },
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-smoke-runner-"));
}

describe("createSmokeRunner", () => {
  it("fake spawnClaude 捕获自主会话参数透传(cwd/addDirs/readOnlyDirs/hooksLogPath/maxTurns/permissionMode)", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(smokeReport());
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      const { args, options } = h.lastCall();
      expect(args[0]).toBe("-p");
      expect(args[1]).toContain("REPORT CONTRACT");
      expect(options.cwd).toBe(report.keptDir);
      expect(options.addDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt"), report.keptDir]);
      expect(options.readOnlyDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt")]);
      // runClaude 以 settingsFile(临时 hooks settings)透传;内容指向 claude-steps.jsonl。
      expect(options.settingsFile).toBeTruthy();
      expect(h.settingsContent()).toContain(join(report.keptDir!, "claude-steps.jsonl"));
      expect(options.maxTurns).toBe(50);
      expect(options.permissionMode).toBe("acceptEdits");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=true:报告归一化正确(status/passRate/summary),keptDir 存在且目录未删", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(smokeReport());
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.strategy).toBe("smoke");
      expect(report.status).toBe("pass");
      expect(report.passRate).toBe(0.5);
      expect(report.summary).toBe("2 用例 1 通过");
      expect(report.generatedTestsKept).toBe(true);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.keptDir).toBeTruthy();
      expect(existsSync(report.keptDir!)).toBe(true);
      expect(existsSync(join(report.keptDir!, "report.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=false(默认):工作目录已删,keptDir 为 undefined", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(smokeReport());
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.generatedTestsKept).toBe(false);
      expect(report.keptDir).toBeUndefined();
      expect(h.mainCwd()).toBeTruthy();
      expect(existsSync(h.mainCwd()!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("converged=false → status=fail;cases 为空 → passRate=undefined", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(smokeReport({ converged: false, cases: [], summary: "未收敛" }));
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("fail");
      expect(report.passRate).toBeUndefined();
      expect(report.summary).toBe("未收敛");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 缺失/非法 → status=error 且 summary 含原因,不抛未捕获异常", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(smokeReport());
      // 预写的 report.json 在 fake 之外被破坏:改为让 fake 写非法 JSON。
      const fake = vi.fn(async (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { cwd?: string }) => {
        if (options?.cwd) writeFileSync(join(options.cwd, "report.json"), "{ broken json");
        return { stdout: "done", exitCode: 0 };
      });
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("合法 JSON 但缺必填字段(converged)→ status=error 且 summary 含 schema 校验原因(不静默落成 fail)", async () => {
    const root = tmpRoot();
    try {
      // converged 置 undefined → JSON.stringify 丢弃该键,模拟 claude 缺字段报告。
      const h = fakeSpawn(smokeReport({ converged: undefined as unknown as boolean }));
      const runner = createSmokeRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report schema 校验失败");
      expect(report.summary).toContain("converged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
