import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMitgenRunner } from "./mitgen-runner.js";
import type { SpawnClaude } from "../claude-client.js";
import type { MitGenResult } from "../mitgen/types.js";
import type { TestStrategyJob } from "./types.js";

const job: TestStrategyJob = {
  requirement: "实现 Mime.decode:把 MIME 编码文本解码为纯文本",
  source: {
    language: "Java",
    root: "/tmp/ref-src",
    files: [
      {
        relativePath: "Mime.java",
        content: [
          "public class Mime {",
          "  public static String decode(String s) {",
          '    if (s == null) return "";',
          "    StringBuilder sb = new StringBuilder();",
          "    for (int i = 0; i < s.length(); i++) { sb.append(s.charAt(i)); }",
          "    return sb.toString();",
          "  }",
          "}",
        ].join("\n"),
      },
    ],
  },
  target: { language: "C#", className: "Mime", method: "Decode", isStatic: true, root: "/tmp/ref-tgt", file: "Mime.cs" },
};

const minimalDescription = {
  schemaVersion: "1.0" as const,
  requirement: "decode MIME",
  target: { language: "Java" as const, className: "Mime", method: "decode", isStatic: true, constructorArgs: [] },
  cases: [{ id: "c1", inputs: [], expected: { kind: "return" as const, value: { type: "string" as const, value: "" } } }],
};

function mitgenResult(overrides: Partial<MitGenResult> = {}): MitGenResult {
  return {
    description: minimalDescription,
    fragments: [
      { fragmentId: "frag-01", sourceCode: "if (s == null) return \"\";", correspondence: "equivalent", correspondenceNote: "ok", cases: [], reachability: "verified" },
    ],
    ...overrides,
  };
}

/** fake spawnClaude:主调用(带 cwd)时预写 report.json,返回无关 stdout。 */
function fakeSpawn(report: MitGenResult): { fake: ReturnType<typeof vi.fn>; settingsContent: () => string | undefined } {
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
  return mkdtempSync(join(tmpdir(), "tv-mitgen-runner-"));
}

describe("createMitgenRunner", () => {
  it("预处理器:extractFragments 预提取片段,片段清单进入主提示词", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(mitgenResult());
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      const mainCall = fake.fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, { cwd?: string }];
      const prompt = mainCall[0][1];
      // 片段清单进入提示词:包含片段 id 与路径条件。
      expect(prompt).toContain("frag-01");
      expect(prompt).toContain("MITGEN REPORT CONTRACT");
      expect(mainCall[3].cwd).toBe(report.keptDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("自主会话参数透传(cwd/addDirs/readOnlyDirs/hooksLogPath)", async () => {
    const root = tmpRoot();
    try {
      const h = fakeSpawn(mitgenResult());
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      const mainCall = h.fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, { cwd?: string; addDirs?: string[]; readOnlyDirs?: string[]; settingsFile?: string }];
      expect(mainCall[3].addDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt"), report.keptDir]);
      expect(mainCall[3].readOnlyDirs).toEqual([resolve("/tmp/ref-src"), resolve("/tmp/ref-tgt")]);
      // runClaude 以 settingsFile(临时 hooks settings)透传;内容指向 claude-steps.jsonl。
      expect(mainCall[3].settingsFile).toBeTruthy();
      expect(h.settingsContent()).toContain(join(report.keptDir!, "claude-steps.jsonl"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status 恒为 pass,passRate 为 undefined(生成成功)", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(mitgenResult());
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.strategy).toBe("mitgen");
      expect(report.status).toBe("pass");
      expect(report.passRate).toBeUndefined();
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(existsSync(report.keptDir!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=false:目录已删,keptDir undefined", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(mitgenResult());
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, workspaceRoot: root });
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
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source.files 为空时预处理器显式报错(status=error,summary 含清晰原因,不触网)", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn(mitgenResult());
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run({ ...job, source: { language: "Java", root: "/tmp/ref-src", files: [] } });

      expect(report.status).toBe("error");
      expect(report.summary).toContain("mitgen 策略需要 source.files");
      expect(fake.fake).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("合法 JSON 但缺必填字段(fragments)→ status=error 且 summary 含 schema 校验原因", async () => {
    const root = tmpRoot();
    try {
      const fake = fakeSpawn({ ...mitgenResult(), fragments: undefined as unknown as MitGenResult["fragments"] });
      const runner = createMitgenRunner({ llm: { apiKey: "test-key", spawnClaude: fake.fake as unknown as SpawnClaude }, keepGeneratedTests: true, workspaceRoot: root });
      const report = await runner.run(job);

      expect(report.status).toBe("error");
      expect(report.summary).toContain("report schema 校验失败");
      expect(report.summary).toContain("fragments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
