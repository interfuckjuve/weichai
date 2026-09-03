import { existsSync, mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectProcessGone,
  LONG_RUNNING_FIXTURE,
  pidFilePath,
  readPids,
  waitFor,
} from "./process-test-helpers.js";
import { sanitizedBuildEnvironment } from "./process-tree.js";
import { runVerifierCommand, runVerifierCommandCli } from "./verifier-command.js";
import { createWorkspaceBaseline, writeWorkspaceBaseline } from "./workspace-baseline.js";

const RUNNER_ROOTS = ["source/.forexplore-tests", "target/.forexplore-tests"] as const;

interface Ws {
  root: string;
  baselinePath: string;
  evidencePath: string;
  targetFile: string;
}

let root: string;

function makeWorkspace(): Ws {
  const r = mkdtempSync(join(tmpdir(), "fx-verifier-command-"));
  mkdirSync(join(r, "source", "project", "src"), { recursive: true });
  mkdirSync(join(r, "target", "project", "src"), { recursive: true });
  writeFileSync(join(r, "source", "project", "src", "Source.java"), "class Source {}", "utf8");
  writeFileSync(join(r, "target", "project", "src", "Target.cs"), "class Target {}", "utf8");
  writeFileSync(join(r, "metadata.json"), '{"role":"unit"}\n', "utf8");
  const baselinePath = join(r, "baseline.json");
  writeWorkspaceBaseline(baselinePath, createWorkspaceBaseline(r, RUNNER_ROOTS, MUTABLE_FILES));
  return {
    root: r,
    baselinePath,
    evidencePath: join(r, "agent", "commands.jsonl"),
    targetFile: join(r, "target", "project", "src", "Target.cs"),
  };
}

function baseInput(
  ws: Ws,
  overrides: Partial<Parameters<typeof runVerifierCommand>[0]> = {},
): Parameters<typeof runVerifierCommand>[0] {
  return {
    workspaceRoot: ws.root,
    side: "source",
    phase: "compile",
    cwd: join(ws.root, "source", "project"),
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    deadlineAt: Date.now() + 30_000,
    baselinePath: ws.baselinePath,
    evidencePath: ws.evidencePath,
    ...overrides,
  };
}

function readEvidenceLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const MUTABLE_FILES = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

beforeEach(() => {
  root = "";
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("sanitizedBuildEnvironment", () => {
  it("构建环境保留工具链但移除凭据", () => {
    const env = sanitizedBuildEnvironment({
      PATH: "/bin",
      JAVA_HOME: "/jdk",
      DEEPSEEK_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      DATABASE_URL: "secret",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.JAVA_HOME).toBe("/jdk");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("构建环境移除 token/口令/service URL 等凭据类变量", () => {
    const env = sanitizedBuildEnvironment({
      NPM_AUTH_TOKEN: "n",
      REDIS_URL: "redis://x",
      MYSQL_PASSWORD: "p",
      PATH: "/usr/bin",
    });
    expect(env.NPM_AUTH_TOKEN).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.MYSQL_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("runVerifierCommand 边界与基线", () => {
  it("构建子进程看不到服务凭据", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const evidence = await runVerifierCommand(
      baseInput(ws, {
        command: process.execPath,
        args: ["-e", "process.stdout.write(String(process.env.DEEPSEEK_API_KEY))"],
      }),
      undefined,
      { ...process.env, DEEPSEEK_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret" },
    );
    expect(evidence.stdout).toBe("undefined");
  });

  it("成功命令写恰好一条 JSONL 证据(含 commandId/side/phase/baselineValid)", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const evidence = await runVerifierCommand(baseInput(ws));

    expect(evidence.commandId).toBeTruthy();
    expect(evidence.side).toBe("source");
    expect(evidence.phase).toBe("compile");
    expect(evidence.exitCode).toBe(0);
    expect(evidence.baselineValid).toBe(true);
    expect(evidence.timedOut).toBe(false);
    const lines = readEvidenceLines(ws.evidencePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].commandId).toBe(evidence.commandId);
    expect(lines[0].exitCode).toBe(0);
  });

  it("stdout/stderr 各限 1 MiB 并在文本中标明截断", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const evidence = await runVerifierCommand(
      baseInput(ws, {
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      }),
    );
    expect(evidence.stdout.length).toBeLessThan(1024 * 1024 + 200);
    expect(evidence.stdout).toContain("[truncated");
  });

  it("拒绝工作区外 cwd 和未知命令", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    await expect(runVerifierCommand(baseInput(ws, { cwd: "/tmp/outside" }))).rejects.toThrow(/cwd/);
    await expect(runVerifierCommand(baseInput(ws, { command: "curl" }))).rejects.toThrow(
      /not allowed/,
    );
  });

  it("既有目标源码被修改时拒绝执行", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    writeFileSync(ws.targetFile, "changed", "utf8");
    await expect(
      runVerifierCommand(
        baseInput(ws, { command: process.execPath, args: ["-e", "process.exit(0)"] }),
      ),
    ).rejects.toThrow(/baseline/);
  });

  it("runner 目录外出现新的源码时拒绝执行", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    writeFileSync(join(ws.root, "target", "project", "Shadow.java"), "class Shadow {}", "utf8");
    await expect(runVerifierCommand(baseInput(ws))).rejects.toThrow(/new source/);
  });

  it("允许的命令在运行期间改动受保护文件 → baselineValid:false 证据且不能通过", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    // 白名单内的 node 命令,但运行时把受保护目标文件改掉(spawn 前基线是干净的)。
    const mutatingNode = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(ws.targetFile)}, "changed")`];
    const run = runVerifierCommand(baseInput(ws, { command: process.execPath, args: mutatingNode }));
    // 执行后复查失败 → runVerifierCommand 以 baseline 错误拒绝(不可产生有效通过)。
    await expect(run).rejects.toThrow(/baseline/);
    const lines = readEvidenceLines(ws.evidencePath);
    expect(lines).toHaveLength(1);
    // 证据如实保留:退出码是命令真实退出码,但 baselineValid=false。
    expect(lines[0].baselineValid).toBe(false);
    expect(lines[0].exitCode).toBe(0);
  });

  it("拒绝非法 side/phase", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    await expect(
      runVerifierCommand(baseInput(ws, { side: "invalid" as never })),
    ).rejects.toThrow(/side/);
    await expect(
      runVerifierCommand(baseInput(ws, { phase: "invalid" as never })),
    ).rejects.toThrow(/phase/);
  });
});

describe("runVerifierCommand 中止与 deadline", () => {
  it("signal 已中止(调用前)→ 在基线/白名单门禁之前以 AbortError 拒绝", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    // 若中止检查不在门禁前,这里会先抛 baseline 错而非 AbortError。
    writeFileSync(ws.targetFile, "changed", "utf8");
    const aborted = new AbortController();
    aborted.abort();
    await expect(runVerifierCommand(baseInput(ws), aborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(ws.evidencePath)).toBe(false);
  });

  it("abort 后命令进程树被回收,以 AbortError 拒绝且不写证据行", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const pidFile = pidFilePath();
    const controller = new AbortController();
    const running = runVerifierCommand(
      baseInput(ws, {
        command: process.execPath,
        args: ["-e", LONG_RUNNING_FIXTURE],
      }),
      controller.signal,
      { ...process.env, FIXTURE_PID_FILE: pidFile },
    );
    await waitFor(() => existsSync(pidFile));
    const pids = readPids(pidFile);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    expect(existsSync(ws.evidencePath)).toBe(false);
    rmSync(pidFile, { force: true });
  });

  it("deadline 到期返回 timedOut 证据且进程树已回收", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const pidFile = pidFilePath();
    const evidence = await runVerifierCommand(
      baseInput(ws, {
        command: process.execPath,
        args: ["-e", LONG_RUNNING_FIXTURE],
        deadlineAt: Date.now() + 1500,
      }),
      undefined,
      { ...process.env, FIXTURE_PID_FILE: pidFile },
    );
    await waitFor(() => existsSync(pidFile));
    expect(evidence.timedOut).toBe(true);
    expect(evidence.exitCode).toBeNull();
    expect(evidence.durationMs).toBeGreaterThanOrEqual(1000);
    const pids = readPids(pidFile);
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    const lines = readEvidenceLines(ws.evidencePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].timedOut).toBe(true);
    expect(lines[0].commandId).toBe(evidence.commandId);
    rmSync(pidFile, { force: true });
  });
});

describe("runVerifierCommandCli", () => {
  function cliEnv(ws: Ws): NodeJS.ProcessEnv {
    return {
      ...process.env,
      VERIFIER_WORKSPACE_ROOT: ws.root,
      VERIFIER_BASELINE_PATH: ws.baselinePath,
      VERIFIER_COMMAND_EVIDENCE_PATH: ws.evidencePath,
      VERIFIER_DEADLINE_AT: String(Date.now() + 30_000),
    };
  }

  it("从固定 env 边界读取路径并成功执行(-- mvn 之后为命令)", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const code = await runVerifierCommandCli(
      [
        "--side",
        "source",
        "--phase",
        "compile",
        "--cwd",
        "source/project",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      cliEnv(ws),
    );
    expect(code).toBe(0);
    const lines = readEvidenceLines(ws.evidencePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].side).toBe("source");
    expect(lines[0].phase).toBe("compile");
    expect(lines[0].exitCode).toBe(0);
  });

  it("严格校验 side/phase 枚举", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const base = ["--cwd", "source/project", "--", process.execPath, "-e", "process.exit(0)"] as const;
    const badSide = await runVerifierCommandCli(["--side", "nope", "--phase", "compile", ...base], cliEnv(ws));
    expect(badSide).toBe(1);
    const badPhase = await runVerifierCommandCli(["--side", "source", "--phase", "nope", ...base], cliEnv(ws));
    expect(badPhase).toBe(1);
    expect(existsSync(ws.evidencePath)).toBe(false);
  });

  it("argv 不能越过固定边界:越界 cwd 被拒且不写证据", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const code = await runVerifierCommandCli(
      [
        "--side",
        "source",
        "--phase",
        "compile",
        "--cwd",
        "/tmp/outside-verifier",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      cliEnv(ws),
    );
    expect(code).toBe(1);
    expect(existsSync(ws.evidencePath)).toBe(false);
  });

  it("命令执行后基线破坏:CLI 返回 1 且证据保留 baselineValid=false", async () => {
    const ws = makeWorkspace();
    root = ws.root;
    const code = await runVerifierCommandCli(
      [
        "--side",
        "source",
        "--phase",
        "compile",
        "--cwd",
        "source/project",
        "--",
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(ws.targetFile)}, "changed")`,
      ],
      cliEnv(ws),
    );
    // 代理不得向 claude 报告可接受的“成功”。
    expect(code).toBe(1);
    const lines = readEvidenceLines(ws.evidencePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].baselineValid).toBe(false);
    expect(lines[0].exitCode).toBe(0);
  });
});


// ---- Task 8: 真实本地依赖 fixture(离线可构建)----

function fixtureProjectWorkspace(fixtureDir: string): Ws {
  const r = mkdtempSync(join(tmpdir(), "fx-verifier-fixture-"));
  mkdirSync(join(r, "source", "project"), { recursive: true });
  mkdirSync(join(r, "source", ".forexplore-tests"), { recursive: true });
  mkdirSync(join(r, "target", ".forexplore-tests"), { recursive: true });
  mkdirSync(join(r, "target", "project"), { recursive: true });
  mkdirSync(join(r, "agent"), { recursive: true });
  cpSync(fixtureDir, join(r, "source", "project"), { recursive: true });
  writeFileSync(join(r, "target", "project", "Placeholder.cs"), "class Placeholder {}", "utf8");
  const baselinePath = join(r, "baseline.json");
  writeWorkspaceBaseline(baselinePath, createWorkspaceBaseline(r, RUNNER_ROOTS, MUTABLE_FILES));
  return { root: r, baselinePath, evidencePath: join(r, "agent", "commands.jsonl"), targetFile: join(r, "target", "project", "Placeholder.cs") };
}

function toolAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const MAVEN = process.env.MAVEN_COMMAND?.trim() || "mvn";
const DOTNET = process.env.DOTNET_COMMAND?.trim() || "dotnet";
const mavenAvailable = toolAvailable(MAVEN, ["-v"]);
const dotnetAvailable = toolAvailable(DOTNET, ["--version"]);

describe("真实依赖 fixture(离线本地构建)", () => {
  const mavenFixture = fileURLToPath(new URL("../e2e/fixtures/dependencies/maven", import.meta.url));
  const dotnetFixture = fileURLToPath(new URL("../e2e/fixtures/dependencies/dotnet", import.meta.url));

  it.runIf(mavenAvailable)("Maven reactor runner 解析 sibling module 依赖", async () => {
    const ws = fixtureProjectWorkspace(mavenFixture);
    root = ws.root;
    const evidence = await runVerifierCommand(
      baseInput(ws, {
        side: "source",
        phase: "run",
        cwd: join(ws.root, "source", "project"),
        command: MAVEN,
        args: ["-q", "test"],
        deadlineAt: Date.now() + 180_000,
      }),
    );
    expect(evidence.exitCode).toBe(0);
    expect(evidence.baselineValid).toBe(true);
    expect(evidence.timedOut).toBe(false);
  });

  it.runIf(dotnetAvailable)("ProjectReference runner 解析 sibling 项目依赖", async () => {
    const ws = fixtureProjectWorkspace(dotnetFixture);
    root = ws.root;
    const evidence = await runVerifierCommand(
      baseInput(ws, {
        side: "source",
        phase: "run",
        cwd: join(ws.root, "source", "project"),
        command: DOTNET,
        args: ["build", "--nologo", "-v", "q"],
        deadlineAt: Date.now() + 180_000,
      }),
    );
    expect(evidence.exitCode).toBe(0);
    expect(evidence.baselineValid).toBe(true);
    expect(evidence.timedOut).toBe(false);
  });
});
