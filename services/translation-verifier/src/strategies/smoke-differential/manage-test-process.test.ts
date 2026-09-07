import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectProcessGone, LONG_RUNNING_FIXTURE, pidFilePath, readPids, waitFor } from "./process-test-fixtures.js";
import { runManagedProcess, terminateProcessTree } from "./manage-test-process.js";

/** 父子都忽略 SIGTERM 的 fixture(验证 TERM→SIGKILL 升级;60s 看门狗自愈)。 */
const SIGTERM_IGNORING_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"], { stdio: "ignore" });
writeFileSync(process.env.FIXTURE_PID_FILE + ".tmp", JSON.stringify({ parent: process.pid, child: child.pid }));
renameSync(process.env.FIXTURE_PID_FILE + ".tmp", process.env.FIXTURE_PID_FILE);
setInterval(() => {}, 1000);
`;

/** 父进程写标记后退出,但子进程(unref,不等待)以 inherit 方式共享 stdout/stderr 管道并继续驻留(60s 自愈)。 */
const PIPE_HOLDING_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync, writeSync, renameSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"], { stdio: "inherit" });
child.unref();
writeFileSync(process.env.FIXTURE_PID_FILE + ".tmp", JSON.stringify({ parent: process.pid, child: child.pid }));
renameSync(process.env.FIXTURE_PID_FILE + ".tmp", process.env.FIXTURE_PID_FILE);
writeSync(1, "PARENT-DONE\\n");
process.exit(0);
`;

let workDir: string;

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "fx-process-tree-"));
}

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("terminateProcessTree", () => {
  it("终止进程组,直接子进程与后代都被回收", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const child = spawn(process.execPath, ["-e", LONG_RUNNING_FIXTURE], {
      env: { ...process.env, FIXTURE_PID_FILE: pidFile },
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    await waitFor(() => existsSync(pidFile));
    const pids = readPids(pidFile);

    await terminateProcessTree(child);

    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });
});

describe("runManagedProcess", () => {
  it("observes stdout live beyond the retained-output cap and isolates callback faults", async () => {
    workDir = makeDir();
    const observed: Buffer[] = [];
    const result = await runManagedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 30);"],
      cwd: workDir, env: process.env, deadlineAt: Date.now() + 5000, maxOutputBytes: 2,
      onStdoutChunk(chunk) { observed.push(Buffer.from(chunk)); throw new Error("observer failed"); },
    });
    expect(Buffer.concat(observed).toString()).toBe("firstsecond");
    expect(result.stdout).toContain("truncated");
    expect(result.exitCode).toBe(0);
  });
  it("abort 信号终止进程树并以 AbortError 拒绝", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const controller = new AbortController();
    const running = runManagedProcess(
      {
        command: process.execPath,
        args: ["-e", LONG_RUNNING_FIXTURE],
        cwd: workDir,
        env: { ...process.env, FIXTURE_PID_FILE: pidFile },
        deadlineAt: Date.now() + 30_000,
      },
      controller.signal,
    );
    await waitFor(() => existsSync(pidFile));
    const pids = readPids(pidFile);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });

  it("deadline 到期返回 timedOut:true,记录的两个 PID 均已退出", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const result = await runManagedProcess({
      command: process.execPath,
      args: ["-e", LONG_RUNNING_FIXTURE],
      cwd: workDir,
      env: { ...process.env, FIXTURE_PID_FILE: pidFile },
      deadlineAt: Date.now() + 1500,
    });
    await waitFor(() => existsSync(pidFile));
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(1000);
    const pids = readPids(pidFile);
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });

  it("spawn 失败(命令不存在)以 error 拒绝", async () => {
    workDir = makeDir();
    await expect(
      runManagedProcess({
        command: "definitely-not-a-real-command-xyz",
        args: [],
        cwd: workDir,
        env: { ...process.env },
        deadlineAt: Date.now() + 5000,
      }),
    ).rejects.toThrow();
  });

  it("deadline 到期:忽略 SIGTERM 的进程组经 SIGKILL 升级被回收,有界返回 timedOut", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const startedAt = Date.now();
    const result = await runManagedProcess({
      command: process.execPath,
      args: ["-e", SIGTERM_IGNORING_FIXTURE],
      cwd: workDir,
      env: { ...process.env, FIXTURE_PID_FILE: pidFile },
      deadlineAt: Date.now() + 150,
      cleanupGraceMs: 250,
    });
    await waitFor(() => existsSync(pidFile));
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // 有界收尾:整体远小于 60s 看门狗/测试超时,证明不是永久悬挂。
    expect(Date.now() - startedAt).toBeLessThan(4000);
    const pids = readPids(pidFile);
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });

  it("abort:忽略 SIGTERM 的进程组经升级回收,以 AbortError 有界拒绝", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const controller = new AbortController();
    const running = runManagedProcess(
      {
        command: process.execPath,
        args: ["-e", SIGTERM_IGNORING_FIXTURE],
        cwd: workDir,
        env: { ...process.env, FIXTURE_PID_FILE: pidFile },
        deadlineAt: Date.now() + 30_000,
        cleanupGraceMs: 250,
      },
      controller.signal,
    );
    await waitFor(() => existsSync(pidFile));
    const pids = readPids(pidFile);
    const startedAt = Date.now();
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(4000);
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });

  it("直接父进程正常退出但后代持有 stdout 管道:有界排空后回收残余,成功返回不悬挂", async () => {
    workDir = makeDir();
    const pidFile = pidFilePath();
    const startedAt = Date.now();
    const result = await runManagedProcess({
      command: process.execPath,
      args: ["-e", PIPE_HOLDING_FIXTURE],
      cwd: workDir,
      env: { ...process.env, FIXTURE_PID_FILE: pidFile },
      deadlineAt: Date.now() + 30_000,
      cleanupGraceMs: 250,
    });
    await waitFor(() => existsSync(pidFile));
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("PARENT-DONE");
    expect(Date.now() - startedAt).toBeLessThan(4000);
    const pids = readPids(pidFile);
    await expectProcessGone(pids.parent);
    await expectProcessGone(pids.child);
    rmSync(pidFile, { force: true });
  });
});
