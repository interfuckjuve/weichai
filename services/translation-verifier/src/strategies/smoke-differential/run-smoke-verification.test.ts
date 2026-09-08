import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnClaude } from "./claude-session.js";
import { SmokeVerificationError } from "./smoke-errors.js";
import {
  acceptedPolicy,
  validCommandEvidence,
  validSmokeCase,
  validSmokeReport,
} from "./differential-test-fixtures.js";
import type {
  CommandEvidence,
  SmokeReport,
} from "./differential-test-types.js";
import { VERIFIER_COMMAND_ENTRY } from "./test-execution-config.js";
import {
  createRunRecorder,
  withRunRecorder,
} from "../../run-output/record-run.js";
import { runSmoke, type SmokeRunOptions } from "./run-smoke-verification.js";
import { prepareSmokeWorkspaceFixture } from "./prepared-workspace-fixture.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

const validReport = validSmokeReport;
const validEvidence = validCommandEvidence;

/** 每次调用新建的临时父根(工作区在其下)。 */
function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-smoke-runner-"));
}

/** Caller stages its fixture before invoking the runner and retains cleanup ownership. */
function runPreparedSmoke(
  parent: string,
  job: SmokeTaskInput,
  options: Omit<SmokeRunOptions, "layout" | "deadlineAt">,
  signal?: AbortSignal,
) {
  const prepared = prepareSmokeWorkspaceFixture(parent, job);
  return runSmoke(
    prepared.job,
    { layout: prepared.layout, deadlineAt: prepared.deadlineAt, ...options },
    signal,
  );
}

/** Small self-contained source fixture staged by the test caller. */
function fileBasedJob(): SmokeTaskInput {
  return {
    verificationPolicy: acceptedPolicy,
    requirement: "decode MIME text",
    source: {
      language: "C#",
      candidatePath: "src/MimeUtility.cs",
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
    verificationPolicy: acceptedPolicy,
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
  lastCall: () => {
    args: string[];
    env: NodeJS.ProcessEnv;
    options: SpawnOptionsShape;
  };
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
    async (
      _args: string[],
      env: NodeJS.ProcessEnv,
      _timeoutMs: number,
      options?: SpawnOptionsShape,
    ) => {
      if (options?.cwd) {
        mainCwd = options.cwd;
        mainEnv = env;
        const payload =
          typeof reportPayload === "string"
            ? reportPayload
            : JSON.stringify(reportPayload);
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
      const call = fake.mock.calls.at(-1) as [
        string[],
        NodeJS.ProcessEnv,
        number,
        SpawnOptionsShape?,
      ];
      return { args: call[0], env: call[1], options: call[3] ?? {} };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSmoke verify-only prepared fixtures", () => {
  it.each([true, false])(
    "retains a null-exit command observation without inventing its exit code (timedOut=%s)",
    async (timedOut) => {
      const root = makeTmpRoot();
      const recorder = createRunRecorder({ runId: `null-exit-${timedOut}` });
      try {
        const evidence = validEvidence();
        evidence[0] = { ...evidence[0], exitCode: null, timedOut };
        const fake = writingFake(validReport(), evidence);
        const result = await withRunRecorder(recorder, () =>
          runPreparedSmoke(root, fileBasedJob(), {
            apiKey: "k",
            spawnClaude: fake.fake as unknown as SpawnClaude,
          }),
        );
        expect(result.executionStatus).toBe("failed");
        const commands = recorder
          .events()
          .filter((event) => event.kind === "command");
        expect(commands).toHaveLength(4);
        expect(commands[0]).toMatchObject({
          commandId: "source-compile",
          durationMs: 10,
          timedOut,
        });
        expect(commands[0]).not.toHaveProperty("exitCode");
        expect(
          recorder
            .snapshot()
            .diagnostics.some((entry) => entry.code === "invalid-event"),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["missing-report", "session-failure", "cancel"])(
    "retains command timing metadata after %s without changing failure semantics",
    async (failure) => {
      const root = makeTmpRoot();
      const recorder = createRunRecorder({ runId: failure });
      const abort = new DOMException("cancelled", "AbortError");
      try {
        const spawnClaude: SpawnClaude = async (
          _args,
          _env,
          _timeout,
          options,
        ) => {
          writeFileSync(
            join(options!.cwd!, "commands.jsonl"),
            validEvidence()
              .map((entry) =>
                JSON.stringify({
                  ...entry,
                  stdout: "PRIVATE-SOURCE",
                  timing: { processMs: 12, beforeEvidenceAppendMs: 20 },
                }),
              )
              .join("\n"),
          );
          if (failure === "cancel") throw abort;
          if (failure === "session-failure")
            throw new Error("claude subprocess failed");
          return { stdout: "buffered only", exitCode: 0 };
        };
        const pending = withRunRecorder(recorder, () =>
          runPreparedSmoke(root, fileBasedJob(), {
            apiKey: "k",
            spawnClaude,
          }),
        );
        if (failure === "cancel")
          expect(await pending).toMatchObject({ executionStatus: "cancelled" });
        else
          expect(await pending).toMatchObject({
            executionStatus: "failed",
            problems: expect.arrayContaining([
              expect.objectContaining({
                code:
                  failure === "missing-report"
                    ? "report_missing"
                    : "agent_error",
              }),
            ]),
          });
        const commands = recorder
          .events()
          .filter((event) => event.kind === "command");
        expect(commands).toHaveLength(4);
        expect(commands[0]).toMatchObject({
          commandId: "source-compile",
          source: "command-proxy:process-date-now",
          durationMs: 10,
        });
        expect(commands[0]).not.toHaveProperty("offsetMs");
        expect(
          recorder.events().filter((event) => event.kind === "command-timing"),
        ).toHaveLength(8);
        expect(JSON.stringify(recorder.events())).not.toContain(
          "PRIVATE-SOURCE",
        );
        expect(
          recorder
            .events()
            .filter((event) => event.kind === "agent-step-approximate"),
        ).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["completed", "failed"])(
    "preserves a standalone caller's same-named occurrence during %s execution",
    async (kind) => {
      const root = makeTmpRoot();
      const recorder = createRunRecorder({ runId: "legacy-host" });
      const handle = recorder.startStep("run-agent-session", {
        scope: "strategy",
      });
      try {
        const h = writingFake(validReport(), validEvidence());
        const spawnClaude =
          kind === "completed"
            ? (h.fake as unknown as SpawnClaude)
            : async () => {
                throw new Error("spawn failed");
              };
        const result = await withRunRecorder(recorder, () =>
          runPreparedSmoke(root, fileBasedJob(), {
            apiKey: "test",
            spawnClaude,
          }),
        );
        expect(result.executionStatus).toBe(kind);
        const sessions = recorder
          .snapshot()
          .stages.filter((step) => step.name === "run-agent-session");
        expect(sessions.map((step) => step.state)).toEqual([
          "running",
          kind === "completed" ? "completed" : "failed",
        ]);
        expect(sessions[0].id).not.toBe(sessions[1].id);
        recorder.endStep(handle, "completed");
        expect(recorder.finish().diagnostics.map((d) => d.code)).toEqual([
          "agent-telemetry-missing",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("默认 verify-only:深校验报告+命令证据后归一 pass,evaluation 存在", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake(validReport(), validEvidence());
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "test-key",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.targetAssessment).toBe("no_bug_observed");
      expect(result).not.toHaveProperty("evaluation");
      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("errorReason");
      expect(result.report?.rounds).toBe(0);
      // 内部暂存布局:claude cwd = agent 目录。
      const cwd = h.cwd();
      expect(cwd).toBeTruthy();
      expect(cwd).toMatch(/\/agent$/);
      const { args, options, env } = h.lastCall();
      expect(args[1]).toContain("REPORT CONTRACT");
      expect(args[1]).toContain("EXECUTION CONTEXT");
      // Bash 只放行精确的 verifier-command 形态。
      expect(options.allowedTools).toEqual([
        `Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`,
      ]);
      // 固定边界注入到 claude 子进程 env。
      expect(env.VERIFIER_WORKSPACE_ROOT).toBe(resolve(cwd!, ".."));
      expect(env.VERIFIER_BASELINE_PATH).toBe(
        join(resolve(cwd!, ".."), "baseline.json"),
      );
      expect(env.VERIFIER_COMMAND_EVIDENCE_PATH).toBe(
        join(cwd!, "commands.jsonl"),
      );
      expect(Number(env.VERIFIER_DEADLINE_AT)).toBeGreaterThan(Date.now());
      // 项目根只读、runner 根与 agent 可写。
      expect(options.readOnlyDirs).toEqual([
        resolve(cwd!, "..", "source", "project"),
        resolve(cwd!, "..", "target", "project"),
      ]);
      expect(options.addDirs).toContain(
        resolve(cwd!, "..", "source", ".forexplore-tests"),
      );
      expect(options.addDirs).toContain(
        resolve(cwd!, "..", "target", ".forexplore-tests"),
      );
      expect(options.addDirs).toContain(cwd);
      // Runner leaves cleanup to the caller.
      expect(result).not.toHaveProperty("generatedTestsKept");
      expect(existsSync(cwd!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("证据缺失、结束时基线变化或 verify-only 目标修复报告返回 error", async () => {
    const root = makeTmpRoot();
    try {
      const missingEvidence = writingFake(validReport(), []);
      expect(
        (
          await runPreparedSmoke(root, fileBasedJob(), {
            apiKey: "k",
            spawnClaude: missingEvidence.fake as unknown as SpawnClaude,
          })
        ).executionStatus,
      ).toBe("failed");

      // 会话后 agent 区外出现影子源码(基线变化)→ invalid-evidence。
      const mutating = writingFake(
        validReport(),
        validEvidence(),
        (executionRoot) => {
          writeFileSync(
            join(executionRoot, "agent", "Shadow.java"),
            "class Shadow {}",
            "utf8",
          );
        },
      );
      const changedAfterLastCommand = await runPreparedSmoke(
        root,
        fileBasedJob(),
        {
          apiKey: "k",
          spawnClaude: mutating.fake as unknown as SpawnClaude,
        },
      );
      expect(changedAfterLastCommand.executionStatus).toBe("failed");
      expect(changedAfterLastCommand.problems[0].code).toBe(
        "workspace_integrity_violation",
      );

      // verify-only 报告携带 rounds>0 → invalid-report。
      const repaired = writingFake(
        validReport({ rounds: 1, converged: false }),
        validEvidence(),
      );
      const repairResult = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: repaired.fake as unknown as SpawnClaude,
      });
      expect(repairResult.executionStatus).toBe("failed");
      expect(repairResult.problems[0].code).toBe("report_schema_invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 非法 JSON → error(invalid-report),summary 含 report.json", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake("{ broken json", []);
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.executionStatus).toBe("failed");
      expect(result.problems[0].code).toBe("report_invalid_json");
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
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.executionStatus).toBe("failed");
      expect(result.problems[0].code).toBe("report_schema_invalid");
      expect(result.summary).toContain("report.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runClaude 抛错(LLM/超时)→ error,timeout/toolchain 分类不外抛", async () => {
    const root = makeTmpRoot();
    try {
      const timedOut = vi.fn(async () => {
        throw new SmokeVerificationError("agent_timeout", "Different wording");
      }) as unknown as SpawnClaude;
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: timedOut,
      });
      expect(result.executionStatus).toBe("failed");
      expect(result.problems).toContainEqual({
        code: "agent_timeout",
        message: "Different wording",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the report and workspace available until the caller cleans up", async () => {
    const root = makeTmpRoot();
    try {
      const h = writingFake(validReport(), validEvidence());
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result).not.toHaveProperty("generatedTestsKept");
      expect(result).not.toHaveProperty("keptDir");
      expect(existsSync(join(h.cwd()!, "report.json"))).toBe(true);
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(h.cwd()!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSmoke caller-staged project copies", () => {
  it("真实双侧根被复制进 source/project+target/project 并只读,evidence 经命令代理", async () => {
    const root = makeTmpRoot();
    const srcRoot = join(root, "project-source");
    const tgtRoot = join(root, "project-target");
    try {
      mkdirSync(srcRoot, { recursive: true });
      mkdirSync(tgtRoot, { recursive: true });
      writeFileSync(
        join(srcRoot, "MimeUtility.cs"),
        "public class MimeUtility {}\n",
        "utf8",
      );
      writeFileSync(
        join(tgtRoot, "MimeUtility.java"),
        "public class MimeUtility {}\n",
        "utf8",
      );
      const copies: Record<string, string> = {};
      const h = writingFake(validReport(), validEvidence(), (executionRoot) => {
        copies.source = readFileSync(
          join(executionRoot, "source", "project", "MimeUtility.cs"),
          "utf8",
        );
        copies.target = readFileSync(
          join(executionRoot, "target", "project", "MimeUtility.java"),
          "utf8",
        );
      });
      const result = await runPreparedSmoke(
        root,
        rootBasedJob(srcRoot, tgtRoot),
        {
          apiKey: "k",
          spawnClaude: h.fake as unknown as SpawnClaude,
        },
      );
      expect(result.targetAssessment).toBe("no_bug_observed");
      // Caller-created copies remain available after the session.
      expect(copies.source).toContain("public class MimeUtility");
      expect(copies.target).toContain("public class MimeUtility");
      const cwd = h.cwd();
      expect(cwd).toBeTruthy();
      expect(existsSync(join(cwd!, ".."))).toBe(true);
      // 原项目从未被写入(位于工作区外,不受清理影响)。
      expect(readFileSync(join(srcRoot, "MimeUtility.cs"), "utf8")).toContain(
        "public class MimeUtility",
      );
      expect(readFileSync(join(tgtRoot, "MimeUtility.java"), "utf8")).toContain(
        "public class MimeUtility",
      );
      const env = h.env();
      expect(env?.VERIFIER_COMMAND_EVIDENCE_PATH).toContain("commands.jsonl");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSmoke caller-owned prepared workspace", () => {
  function productionWorkspace(parent: string) {
    const ws = prepareSmokeWorkspaceFixture(parent, fileBasedJob());
    return {
      ...ws,
      root: ws.layout.executionRoot,
      agentDir: ws.layout.agentDir,
      baselinePath: ws.layout.baselinePath,
      runnerSrc: ws.layout.runnerDirs[0],
      runnerTgt: ws.layout.runnerDirs[1],
    };
  }

  it("生产布局:直接用 caller workspace,不创建/清理,固定 env 与代理只读边界", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const before = [
        ws.root,
        ws.agentDir,
        ws.baselinePath,
        ...ws.layout.projectRoots,
      ].map((path) => ({ path, inode: statSync(path).ino }));
      const siblings = readdirSync(parent);
      const baseline = readFileSync(ws.baselinePath, "utf8");
      const h = writingFake(validReport(), validEvidence());
      const result = await runSmoke(ws.job, {
        layout: ws.layout,
        deadlineAt: ws.deadlineAt,
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.targetAssessment).toBe("no_bug_observed");
      expect(result).not.toHaveProperty("evaluation");
      expect(result).not.toHaveProperty("status");
      expect(result).not.toHaveProperty("keptDir");
      // caller-owned 工作区保持存在，目录身份和基线不变。
      expect(existsSync(ws.root)).toBe(true);
      expect(readdirSync(parent)).toEqual(siblings);
      expect(
        before.map(({ path }) => ({ path, inode: statSync(path).ino })),
      ).toEqual(before);
      expect(readFileSync(ws.baselinePath, "utf8")).toBe(baseline);
      const { options, env } = h.lastCall();
      expect(options.cwd).toBe(ws.agentDir);
      expect(options.readOnlyDirs).toEqual([
        ws.job.source.root,
        ws.job.target.root,
      ]);
      expect(options.addDirs).toContain(ws.runnerSrc);
      expect(options.addDirs).toContain(ws.runnerTgt);
      expect(env.VERIFIER_WORKSPACE_ROOT).toBe(ws.root);
      expect(env.VERIFIER_BASELINE_PATH).toBe(ws.baselinePath);
      expect(env.VERIFIER_COMMAND_EVIDENCE_PATH).toBe(
        join(ws.agentDir, "commands.jsonl"),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("caller-owned 结束时若受保护文件被改 → invalid-evidence(不改原项目)", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const mutating = writingFake(
        validReport(),
        validEvidence(),
        (executionRoot) => {
          writeFileSync(
            join(executionRoot, "target", "project", "MimeUtility.java"),
            "changed",
            "utf8",
          );
        },
      );
      const result = await runSmoke(ws.job, {
        layout: ws.layout,
        deadlineAt: ws.deadlineAt,
        apiKey: "k",
        spawnClaude: mutating.fake as unknown as SpawnClaude,
      });
      expect(result.executionStatus).toBe("failed");
      expect(result.problems[0].code).toBe("workspace_integrity_violation");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not recreate a missing caller-prepared Agent directory", async () => {
    const parent = makeTmpRoot();
    try {
      const ws = productionWorkspace(parent);
      const h = writingFake(validReport(), validEvidence());
      rmSync(ws.agentDir, { recursive: true });
      const result = await runSmoke(ws.job, {
        layout: ws.layout,
        deadlineAt: ws.deadlineAt,
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result.executionStatus).toBe("failed");
      expect(existsSync(ws.agentDir)).toBe(false);
      expect(existsSync(ws.root)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("runSmoke policy and classified outcomes", () => {
  it("uses the coded session failure rather than arbitrary timeout/report wording", async () => {
    const root = makeTmpRoot();
    try {
      const message = "ENOENT report baseline timed out";
      const result = await runPreparedSmoke(root, fileBasedJob(), {
        apiKey: "k",
        spawnClaude: async () => {
          throw new Error(message);
        },
      });
      expect(result.problems.map((problem) => problem.code)).toEqual([
        "report_missing",
        "agent_error",
      ]);
      expect(result.summary).toBe(message);
      expect(result).not.toHaveProperty("errorReason");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not launch an Agent without an independent Host basis", async () => {
    const spawnClaude = vi.fn();
    const root = makeTmpRoot();
    try {
      const result = await runPreparedSmoke(
        root,
        { ...fileBasedJob(), verificationPolicy: undefined },
        { spawnClaude },
      );
      expect(spawnClaude).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        mode: "target_only",
        executionStatus: "failed",
        sourceAssessment: "not_checked",
        problems: [{ code: "insufficient_test_basis" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("target-only staging never copies or exposes reference projects, files, runners or analysis", async () => {
    const root = makeTmpRoot();
    try {
      const report = validReport();
      report.cases[0].source = null;
      report.cases[0].sourceAssessment = "not_checked";
      report.cases[0].commandIds = { target: "target-run" };
      report.executions = report.executions!.filter(
        (item) => item.side === "target",
      );
      report.runnerFiles = report.runnerFiles!.filter(
        (item) => item.side === "target",
      );
      const h = writingFake(report, validEvidence(report), (executionRoot) =>
        expect(existsSync(join(executionRoot, "source"))).toBe(false),
      );
      const job = fileBasedJob();
      job.verificationPolicy = {
        ...acceptedPolicy,
        referenceDecision: "rejected",
      };
      job.analysisReport = "PRIVATE ANALYSIS";
      const result = await runPreparedSmoke(root, job, {
        apiKey: "k",
        spawnClaude: h.fake as unknown as SpawnClaude,
      });
      expect(result).toMatchObject({
        mode: "target_only",
        sourceAssessment: "not_checked",
        targetAssessment: "no_bug_observed",
        executionStatus: "completed",
      });
      const { args, env, options } = h.lastCall();
      expect(args[1]).not.toContain("PRIVATE ANALYSIS");
      expect(args[1]).not.toContain("MimeUtility.cs");
      expect(options.addDirs!.every((path) => !path.includes("/source/"))).toBe(
        true,
      );
      expect(options.readOnlyDirs).toHaveLength(1);
      expect(env.VERIFIER_MODE).toBe("target_only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["missing", "json", "schema", "evidence", "baseline"])(
    "classifies %s without confirming code findings",
    async (kind) => {
      const root = makeTmpRoot();
      try {
        const spawnClaude: SpawnClaude = async (
          _args,
          env,
          _timeout,
          options,
        ) => {
          if (kind !== "missing")
            writeFileSync(
              join(options!.cwd!, "report.json"),
              kind === "json"
                ? "{"
                : kind === "schema"
                  ? "{}"
                  : JSON.stringify(validReport()),
            );
          if (kind !== "evidence")
            writeFileSync(
              join(options!.cwd!, "commands.jsonl"),
              validEvidence()
                .map((item) => JSON.stringify(item))
                .join("\n"),
            );
          if (kind === "baseline")
            writeFileSync(
              join(env.VERIFIER_WORKSPACE_ROOT!, "target", "Shadow.java"),
              "changed",
            );
          return { stdout: "done", exitCode: 0 };
        };
        const result = await runPreparedSmoke(root, fileBasedJob(), {
          apiKey: "k",
          spawnClaude,
        });
        if (["missing", "json", "schema"].includes(kind))
          expect(result.report).toBeNull();
        expect(result.bugCases ?? []).toEqual([]);
        expect(result).not.toHaveProperty("status");
        const codes = {
          missing: "report_missing",
          json: "report_invalid_json",
          schema: "report_schema_invalid",
          evidence: "report_evidence_invalid",
          baseline: "workspace_integrity_violation",
        };
        expect(result).toMatchObject({
          executionStatus: "failed",
          sourceAssessment: "inconclusive",
          targetAssessment: "inconclusive",
          problems: [{ code: codes[kind as keyof typeof codes] }],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "json", "schema"])(
    "collects command timeouts and both baseline diagnostics with a %s report",
    async (kind) => {
      const root = makeTmpRoot();
      try {
        const spawnClaude: SpawnClaude = async (
          _args,
          env,
          _timeout,
          options,
        ) => {
          if (kind !== "missing")
            writeFileSync(
              join(options!.cwd!, "report.json"),
              kind === "json" ? "{" : "{}",
            );
          const evidence = validEvidence();
          evidence[0] = {
            ...evidence[0],
            timedOut: true,
            exitCode: null,
            baselineValid: false,
          };
          evidence[1] = { ...evidence[1], exitCode: 1 };
          writeFileSync(
            join(options!.cwd!, "commands.jsonl"),
            evidence.map((item) => JSON.stringify(item)).join("\n"),
          );
          writeFileSync(
            join(env.VERIFIER_WORKSPACE_ROOT!, "target", "Shadow.java"),
            "changed",
          );
          return { stdout: "done", exitCode: 0 };
        };
        const result = await runPreparedSmoke(root, fileBasedJob(), {
          apiKey: "k",
          spawnClaude,
        });
        expect(result).toMatchObject({
          executionStatus: "failed",
          sourceAssessment: "inconclusive",
          targetAssessment: "inconclusive",
        });
        expect(result.problems.map((problem) => problem.code)).toEqual([
          kind === "missing"
            ? "report_missing"
            : kind === "json"
              ? "report_invalid_json"
              : "report_schema_invalid",
          "workspace_integrity_violation",
          "workspace_integrity_violation",
          "command_timeout",
          "environment_unavailable",
        ]);
        expect(result.problems[3]).toMatchObject({
          side: "source",
          commandId: "source-compile",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps missing-report and malformed command evidence diagnostics together", async () => {
    const root = makeTmpRoot();
    try {
      for (const evidence of ["{", "null\n{}"]) {
        const result = await runPreparedSmoke(root, fileBasedJob(), {
          apiKey: "k",
          spawnClaude: async (_args, _env, _timeout, options) => {
            writeFileSync(join(options!.cwd!, "commands.jsonl"), evidence);
            return { stdout: "done", exitCode: 0 };
          },
        });
        expect(result.problems[0].code).toBe("report_missing");
        expect(
          result.problems
            .slice(1)
            .every((problem) => problem.code === "report_evidence_invalid"),
        ).toBe(true);
        expect(result.problems.length).toBeGreaterThan(1);
        expect(result.targetAssessment).toBe("inconclusive");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["timeout", "cancel"])(
    "preserves valid findings after %s, but not after baseline corruption",
    async (kind) => {
      for (const corrupt of [false, true]) {
        const root = makeTmpRoot();
        try {
          const report = validReport({
            cases: [validSmokeCase({ targetAssessment: "bug_found" })],
          });
          const spawnClaude: SpawnClaude = async (
            _args,
            env,
            _timeout,
            options,
          ) => {
            writeFileSync(
              join(options!.cwd!, "report.json"),
              JSON.stringify(report),
            );
            writeFileSync(
              join(options!.cwd!, "commands.jsonl"),
              validEvidence(report)
                .map((item) => JSON.stringify(item))
                .join("\n"),
            );
            if (corrupt)
              writeFileSync(
                join(env.VERIFIER_WORKSPACE_ROOT!, "target", "Shadow.java"),
                "changed",
              );
            throw kind === "cancel"
              ? new DOMException("cancelled", "AbortError")
              : new SmokeVerificationError(
                  "agent_timeout",
                  "Different wording",
                );
          };
          const result = await runPreparedSmoke(root, fileBasedJob(), {
            apiKey: "k",
            spawnClaude,
          });
          expect(result.executionStatus).toBe(
            kind === "cancel" ? "cancelled" : corrupt ? "failed" : "partial",
          );
          expect(result.bugCases?.map((item) => item.caseId) ?? []).toEqual(
            corrupt ? [] : ["c1"],
          );
          expect(result).not.toHaveProperty("evaluation");
          expect(result.targetAssessment).toBe(
            corrupt ? "inconclusive" : "bug_found",
          );
          expect(
            result.problems.some(
              (item) =>
                item.code ===
                (kind === "cancel" ? "cancelled" : "agent_timeout"),
            ),
          ).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
});

describe("runSmoke abort 语义", () => {
  it("运行中 abort 传播 AbortError 并保留取消语义", async () => {
    const root = makeTmpRoot();
    try {
      const controller = new AbortController();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocking = vi.fn(
        (
          _args: string[],
          _env: NodeJS.ProcessEnv,
          _timeoutMs: number,
          options?: { signal?: AbortSignal },
        ) =>
          new Promise<{ stdout: string; exitCode: number }>(
            (_resolve, reject) => {
              entered();
              options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal!.reason),
                { once: true },
              );
            },
          ),
      ) as unknown as SpawnClaude;
      const running = runPreparedSmoke(
        root,
        fileBasedJob(),
        { apiKey: "k", spawnClaude: blocking },
        controller.signal,
      );
      await started;
      controller.abort();
      await expect(running).resolves.toMatchObject({
        executionStatus: "cancelled",
        sourceAssessment: "inconclusive",
        targetAssessment: "inconclusive",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels between task construction and Agent launch without starting the Agent", async () => {
    const root = makeTmpRoot();
    try {
      const controller = new AbortController();
      const spawnClaude = vi.fn();
      const running = runPreparedSmoke(
        root,
        fileBasedJob(),
        { apiKey: "k", spawnClaude },
        controller.signal,
      );
      const reason = new DOMException("cancel before launch", "AbortError");
      controller.abort(reason);
      await expect(running).resolves.toMatchObject({
        executionStatus: "cancelled",
        summary: reason.message,
      });
      expect(spawnClaude).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signal 已中止(调用前)→ 以 AbortError 拒绝", async () => {
    const root = makeTmpRoot();
    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        runPreparedSmoke(root, fileBasedJob(), { apiKey: "k" }, aborted.signal),
      ).resolves.toMatchObject({ executionStatus: "cancelled" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
