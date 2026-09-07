import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnClaude } from "./claude-session.js";
import { validCommandEvidence, validSmokeReport } from "./differential-test-fixtures.js";
import type { CommandEvidence, SmokeReport } from "./differential-test-types.js";
import { createWorkspaceBaseline, writeWorkspaceBaseline } from "./protect-project-files.js";
import { VERIFIER_COMMAND_ENTRY } from "./test-execution-config.js";
import { createRunRecorder, withRunRecorder } from "../run-output/record-run.js";
import { runSmoke } from "./run-smoke-verification.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

const validReport = validSmokeReport;
const validEvidence = validCommandEvidence;

/** 每次调用新建的临时父根(工作区在其下)。 */
function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-smoke-runner-"));
}

/** 文件型任务(无真实根,内部暂存由 files 落盘)。 */
function fileBasedJob(): SmokeTaskInput {
  return {
    requirement: "decode MIME text",
    source: {
      language: "C#",
      files: [{ relativePath: "src/MimeUtility.cs", content: "public class MimeUtility { public static string DecodeText(string s) => s; }\n" }],
    },
    target: {
      language: "Java",
      className: "org.apache.commons.fileupload.util.mime.MimeUtility",
      method: "decodeText",
      isStatic: true,
      file: "MimeUtility.java",
    },
  };
}

/** 根型任务:写入真实源/目标项目目录(测试复制与只读布局)。 */
function rootBasedJob(srcRoot: string, tgtRoot: string): SmokeTaskInput {
  return {
    requirement: "decode MIME text",
    source: { language: "C#", root: srcRoot, candidatePath: "MimeUtility.cs" },
    target: {
      language: "Java",
      className: "org.apache.commons.fileupload.util.mime.MimeUtility",
      method: "decodeText",
      isStatic: true,
      root: tgtRoot,
      file: "MimeUtility.java",
    },
  };
}

interface SpawnOptionsShape {
  cwd?: string;
  addDirs?: string[];
  readOnlyDirs?: string[];
  allowedTools?: string[];
  maxTurns?: number;
  permissionMode?: string;
  settingsFile?: string;
  signal?: AbortSignal;
}

interface WritingFake {
  fake: ReturnType<typeof vi.fn>;
  lastCall: () => { args: string[]; env: NodeJS.ProcessEnv; options: SpawnOptionsShape };
  cwd: () => string | undefined;
  env: () => NodeJS.ProcessEnv | undefined;
}

/**
 * fake spawnClaude:主调用(带 cwd)时把 report.json 与 commands.jsonl 预写入
 * 工作目录,并可选执行 mutate(executionRoot)。stdout 无关紧要。
 */
function writingFake(
  reportPayload: SmokeReport | string,
  evidence: CommandEvidence[],
  mutate?: (executionRoot: string) => void,
): WritingFake {
  let mainCwd: string | undefined;
  let mainEnv: NodeJS.ProcessEnv | undefined;
  const fake = vi.fn(
    async (_args: string[], env: NodeJS.ProcessEnv, _timeoutMs: number, options?: SpawnOptionsShape) => {
      if (options?.cwd) {
        mainCwd = options.cwd;
        mainEnv = env;
        const payload = typeof reportPayload === "string" ? reportPayload : JSON.stringify(reportPayload);
        writeFileSync(join(options.cwd, "report.json"), payload, "utf8");
        if (evidence.length > 0) {
          writeFileSync(
            join(options.cwd, "commands.jsonl"),
            evidence.map((item) => JSON.stringify(item)).join("\n") + "\n",
            "utf8",
          );
        }
        // agent 目录 = <executionRoot>/agent。
        mutate?.(resolve(options.cwd, ".."));
      }
      return { stdout: "done", exitCode: 0 };
    },
  ) as ReturnType<typeof vi.fn>;
  return {
    fake,
    cwd: () => mainCwd,
    env: () => mainEnv,
    lastCall: () => {
      const call = fake.mock.calls.at(-1) as [string[], NodeJS.ProcessEnv, number, SpawnOptionsShape?];
      return { args: call[0], env: call[1], options: call[3] ?? {} };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSmoke verify-only 内部暂存(files 输入)", () => {
  it.each(["pass", "error"])("does not claim legacy Host stages during standalone %s execution", async (kind) => {
    const root = makeTmpRoot();
    const recorder = createRunRecorder({ runId: "legacy-host" });
    recorder.startStage("validate-input");
    recorder.endStage("validate-input", "completed");
    recorder.startStage("prepare-workspace");
    recorder.endStage("prepare-workspace", "completed");
    recorder.skipStage("prepare-agent-task", "Legacy preparation is not observable.");
    recorder.startStage("run-agent-tests");
    try {
      const h = writingFake(validReport(), validEvidence());
      const spawnClaude = kind === "pass" ? h.fake as unknown as SpawnClaude : async () => { throw new Error("spawn failed"); };
      const result = await withRunRecorder(recorder, () => runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "test", spawnClaude }));
      expect(result.status).toBe(kind);
      expect(recorder.snapshot().stages.map((stage) => stage.state)).toEqual(["completed", "completed", "skipped", "running", "not-started", "not-started"]);
      expect(recorder.snapshot().diagnostics).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("默认 verify-only:深校验报告+命令证据后归一 pass,evaluation 存在", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake(validReport(), validEvidence());
      const result = await runSmoke(
        fileBasedJob(),
        { workspaceRoot: root, apiKey: "test-key", spawnClaude: h.fake as unknown as SpawnClaude },
      );
      expect(result.status).toBe("pass");
      expect(result.evaluation?.status).toBe("pass");
      expect(result.errorReason).toBeUndefined();
      expect(result.report.rounds).toBe(0);
      // 内部暂存布局:claude cwd = agent 目录。
      const cwd = h.cwd();
      expect(cwd).toBeTruthy();
      expect(cwd).toMatch(/\/agent$/);
      const { args, options, env } = h.lastCall();
      expect(args[1]).toContain("REPORT CONTRACT");
      expect(args[1]).toContain("EXECUTION CONTEXT");
      // Bash 只放行精确的 verifier-command 形态。
      expect(options.allowedTools).toEqual([`Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`]);
      // 固定边界注入到 claude 子进程 env。
      expect(env.VERIFIER_WORKSPACE_ROOT).toBe(resolve(cwd!, ".."));
      expect(env.VERIFIER_BASELINE_PATH).toBe(join(resolve(cwd!, ".."), "baseline.json"));
      expect(env.VERIFIER_COMMAND_EVIDENCE_PATH).toBe(join(cwd!, "commands.jsonl"));
      expect(Number(env.VERIFIER_DEADLINE_AT)).toBeGreaterThan(Date.now());
      // 项目根只读、runner 根与 agent 可写。
      expect(options.readOnlyDirs).toEqual([
        resolve(cwd!, "..", "source", "project"),
        resolve(cwd!, "..", "target", "project"),
      ]);
      expect(options.addDirs).toContain(resolve(cwd!, "..", "source", ".forexplore-tests"));
      expect(options.addDirs).toContain(resolve(cwd!, "..", "target", ".forexplore-tests"));
      expect(options.addDirs).toContain(cwd);
      // 默认不保留内部工作区。
      expect(result.generatedTestsKept).toBe(false);
      expect(existsSync(cwd!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("证据缺失、结束时基线变化或 verify-only 目标修复报告返回 error", async () => {
    const root = makeTmpRoot();
    try {
      const missingEvidence = writingFake(validReport(), []);
      expect((await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: missingEvidence.fake as unknown as SpawnClaude })).status).toBe("error");

      // 会话后 agent 区外出现影子源码(基线变化)→ invalid-evidence。
      const mutating = writingFake(validReport(), validEvidence(), (executionRoot) => {
        writeFileSync(join(executionRoot, "agent", "Shadow.java"), "class Shadow {}", "utf8");
      });
      const changedAfterLastCommand = await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: mutating.fake as unknown as SpawnClaude });
      expect(changedAfterLastCommand.status).toBe("error");
      expect(changedAfterLastCommand.errorReason).toBe("invalid-evidence");

      // verify-only 报告携带 rounds>0 → invalid-report。
      const repaired = writingFake(validReport({ rounds: 1, converged: false }), validEvidence());
      const repairResult = await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: repaired.fake as unknown as SpawnClaude });
      expect(repairResult.status).toBe("error");
      expect(repairResult.errorReason).toBe("invalid-report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 非法 JSON → error(invalid-report),summary 含 report.json", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake("{ broken json", []);
      const result = await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: h.fake as unknown as SpawnClaude });
      expect(result.status).toBe("error");
      expect(result.errorReason).toBe("invalid-report");
      expect(result.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 超过大小上限 → error(invalid-report)", async () => {
    const root = makeTmpRoot();
    try {
      // 大小检查在 JSON.parse 之前;超限即拒,不进入解析。
      const oversized = `{"pad":"${`x`.repeat(4 * 1024 * 1024)}"`;
      const h = writingFake(oversized, []);
      const result = await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: h.fake as unknown as SpawnClaude });
      expect(result.status).toBe("error");
      expect(result.errorReason).toBe("invalid-report");
      expect(result.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runClaude 抛错(LLM/超时)→ error,timeout/toolchain 分类不外抛", async () => {
    const root = makeTmpRoot();
    try {
      const timedOut = vi.fn(async () => { throw new Error("claude subprocess timed out after 120000ms"); }) as unknown as SpawnClaude;
      const result = await runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: timedOut });
      expect(result.status).toBe("error");
      expect(result.errorReason).toBe("timeout");
      expect(result.summary).toContain("timed out");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keep=true 保留内部工作区供诊断", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake(validReport(), validEvidence());
      const result = await runSmoke(fileBasedJob(), { workspaceRoot: root, keepGeneratedTests: true, apiKey: "k", spawnClaude: h.fake as unknown as SpawnClaude });
      expect(result.generatedTestsKept).toBe(true);
      expect(result.keptDir).toBeTruthy();
      expect(existsSync(result.keptDir!)).toBe(true);
      expect(existsSync(join(result.keptDir!, "agent", "report.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSmoke 内部暂存(root 输入复制双侧项目)", () => {
  it("真实双侧根被复制进 source/project+target/project 并只读,evidence 经命令代理", async () => {
    const root = makeTmpRoot();
    const srcRoot = join(root, "project-source");
    const tgtRoot = join(root, "project-target");
    try {
      mkdirSync(srcRoot, { recursive: true });
      mkdirSync(tgtRoot, { recursive: true });
      writeFileSync(join(srcRoot, "MimeUtility.cs"), "public class MimeUtility {}\n", "utf8");
      writeFileSync(join(tgtRoot, "MimeUtility.java"), "public class MimeUtility {}\n", "utf8");
      const copies: Record<string, string> = {};
      const h = writingFake(validReport(), validEvidence(), (executionRoot) => {
        copies.source = readFileSync(join(executionRoot, "source", "project", "MimeUtility.cs"), "utf8");
        copies.target = readFileSync(join(executionRoot, "target", "project", "MimeUtility.java"), "utf8");
      });
      const result = await runSmoke(
        rootBasedJob(srcRoot, tgtRoot),
        { workspaceRoot: root, apiKey: "k", spawnClaude: h.fake as unknown as SpawnClaude },
      );
      expect(result.status).toBe("pass");
      // 复制内容在工作区存在时(会话内)捕获;成功后内部暂存默认清理。
      expect(copies.source).toContain("public class MimeUtility");
      expect(copies.target).toContain("public class MimeUtility");
      const cwd = h.cwd();
      expect(cwd).toBeTruthy();
      expect(existsSync(join(cwd!, ".."))).toBe(false);
      // 原项目从未被写入(位于工作区外,不受清理影响)。
      expect(readFileSync(join(srcRoot, "MimeUtility.cs"), "utf8")).toContain("public class MimeUtility");
      expect(readFileSync(join(tgtRoot, "MimeUtility.java"), "utf8")).toContain("public class MimeUtility");
      const env = h.env();
      expect(env?.VERIFIER_COMMAND_EVIDENCE_PATH).toContain("commands.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSmoke caller-owned 生产工作区(workspaceDir)", () => {
  function productionWorkspace(parent: string): {
    root: string;
    agentDir: string;
    baselinePath: string;
    runnerSrc: string;
    runnerTgt: string;
    job: SmokeTaskInput;
  } {
    const root = join(parent, "forexplore-smoke-prod");
    const sourceProject = join(root, "source", "project");
    const targetProject = join(root, "target", "project");
    const agentDir = join(root, "agent");
    const runnerSrc = join(root, "source", ".forexplore-tests");
    const runnerTgt = join(root, "target", ".forexplore-tests");
    mkdirSync(sourceProject, { recursive: true });
    mkdirSync(targetProject, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(runnerSrc, { recursive: true });
    mkdirSync(runnerTgt, { recursive: true });
    writeFileSync(join(sourceProject, "MimeUtility.cs"), "public class MimeUtility {}\n", "utf8");
    writeFileSync(join(targetProject, "MimeUtility.java"), "public class MimeUtility {}\n", "utf8");
    const baselinePath = join(root, "baseline.json");
    writeWorkspaceBaseline(
      baselinePath,
      createWorkspaceBaseline(root, ["source/.forexplore-tests", "target/.forexplore-tests"], ["agent/report.json", "agent/claude-steps.jsonl", "agent/commands.jsonl"]),
    );
    const job: SmokeTaskInput = {
      requirement: "decode MIME text",
      source: { language: "C#", root: sourceProject, candidatePath: "MimeUtility.cs" },
      target: {
        language: "Java",
        className: "org.apache.commons.fileupload.util.mime.MimeUtility",
        method: "decodeText",
        isStatic: true,
        root: targetProject,
        file: "MimeUtility.java",
      },
    };
    return { root, agentDir, baselinePath, runnerSrc, runnerTgt, job };
  }

  it("生产布局:直接用 caller workspace,不创建/清理,固定 env 与代理只读边界", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const h = writingFake(validReport(), validEvidence());
      const result = await runSmoke(
        ws.job,
        {
          workspaceDir: ws.agentDir,
          executionRoot: ws.root,
          baselinePath: ws.baselinePath,
          commandEvidencePath: join(ws.agentDir, "commands.jsonl"),
          runnerRoots: ["source/.forexplore-tests", "target/.forexplore-tests"],
          apiKey: "k",
          spawnClaude: h.fake as unknown as SpawnClaude,
        },
      );
      expect(result.status).toBe("pass");
      expect(result.evaluation?.status).toBe("pass");
      expect(result.keptDir).toBeUndefined();
      // caller-owned 工作区保持存在。
      expect(existsSync(ws.root)).toBe(true);
      const { options, env } = h.lastCall();
      expect(options.cwd).toBe(ws.agentDir);
      expect(options.readOnlyDirs).toEqual([ws.job.source.root, ws.job.target.root]);
      expect(options.addDirs).toContain(ws.runnerSrc);
      expect(options.addDirs).toContain(ws.runnerTgt);
      expect(env.VERIFIER_WORKSPACE_ROOT).toBe(ws.root);
      expect(env.VERIFIER_BASELINE_PATH).toBe(ws.baselinePath);
      expect(env.VERIFIER_COMMAND_EVIDENCE_PATH).toBe(join(ws.agentDir, "commands.jsonl"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("caller-owned 结束时若受保护文件被改 → invalid-evidence(不改原项目)", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const mutating = writingFake(validReport(), validEvidence(), (executionRoot) => {
        writeFileSync(join(executionRoot, "target", "project", "MimeUtility.java"), "changed", "utf8");
      });
      const result = await runSmoke(
        ws.job,
        {
          workspaceDir: ws.agentDir,
          executionRoot: ws.root,
          baselinePath: ws.baselinePath,
          commandEvidencePath: join(ws.agentDir, "commands.jsonl"),
          runnerRoots: ["source/.forexplore-tests", "target/.forexplore-tests"],
          apiKey: "k",
          spawnClaude: mutating.fake as unknown as SpawnClaude,
        },
      );
      expect(result.status).toBe("error");
      expect(result.errorReason).toBe("invalid-evidence");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("生产工作区集不完整(缺 runnerRoots)时给出内部错误而非静默", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const h = writingFake(validReport(), validEvidence());
      const result = await runSmoke(ws.job, {
        workspaceDir: ws.agentDir,
        executionRoot: ws.root,
        baselinePath: ws.baselinePath,
        commandEvidencePath: join(ws.agentDir, "commands.jsonl"),
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.status).toBe("error");
      expect(result.errorReason).toBe("internal");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("runSmoke abort 语义", () => {
  it("运行中 abort 传播 AbortError 并保留取消语义", async () => {
    const root = makeTmpRoot();
    try {
      const controller = new AbortController();
      const blocking = vi.fn(
        (_args: string[], _env: NodeJS.ProcessEnv, _timeoutMs: number, options?: { signal?: AbortSignal }) =>
          new Promise<{ stdout: string; exitCode: number }>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
          }),
      ) as unknown as SpawnClaude;
      const running = runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k", spawnClaude: blocking }, controller.signal);
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signal 已中止(调用前)→ 以 AbortError 拒绝", async () => {
    const root = makeTmpRoot();
    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(runSmoke(fileBasedJob(), { workspaceRoot: root, apiKey: "k" }, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
