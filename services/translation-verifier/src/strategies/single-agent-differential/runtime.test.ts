import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBehaviorRuntime } from "../multi-agent-differential/claude-runtime.js";
import {
  runBehaviorCommandCli,
  stopRegisteredCommands,
  BEHAVIOR_COMMAND_ENTRY,
  BEHAVIOR_CONTROL_ENV,
  type BehaviorSessionControl,
} from "../multi-agent-differential/behavior-command.js";
import * as processes from "../smoke-differential/manage-test-process.js";
import type { BehaviorAgentTask } from "../multi-agent-differential/behavior-types.js";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "single-runtime-")));
  directories.push(root);
  const source = join(root, "source"),
    target = join(root, "target");
  for (const path of [source, target]) {
    mkdirSync(join(path, ".forexplore-tests"), { recursive: true });
    writeFileSync(join(path, "implementation.cjs"), "module.exports = 42;");
  }
  const scope = (cwd: string) => ({
    cwd,
    readRoots: [source, target],
    writeRoots: [cwd],
  });
  const task: BehaviorAgentTask = {
    side: "target",
    sandbox: scope(target),
    additionalProjects: { source: scope(source) },
    executionSides: ["source", "target"],
    sessionRole: "single-agent",
    expectationFile: join(target, ".forexplore-tests/plan.json"),
    prompt: "test",
    deadlineAt: Date.now() + 10000,
  };
  return { root, source, target, task };
}
function mockAgent(
  callback: (
    input: Parameters<typeof processes.runManagedProcess>[0],
  ) => Promise<void>,
) {
  const actual = processes.runManagedProcess;
  return vi
    .spyOn(processes, "runManagedProcess")
    .mockImplementation(async (input, signal) => {
      if (input.args.includes("--version"))
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "2.1.236",
          stderr: "",
        };
      if (!input.args.includes("--print")) return actual(input, signal);
      await callback(input);
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: "",
        stderr: "",
      };
    });
}
describe("single-session Host runtime controls", () => {
  it("retries transient process-group permission errors until disappearance is confirmed", async () => {
    const f = fixture();
    const path = join(f.root, "groups.jsonl");
    writeFileSync(path, JSON.stringify({ pid: 999999, active: true }) + "\n");
    let calls = 0;
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("group transition"), {
        code: ++calls < 3 ? "EPERM" : "ESRCH",
      });
    });
    await expect(stopRegisteredCommands(path)).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(3);
  });
  it("never treats persistent permission errors as confirmed process cleanup", async () => {
    const f = fixture();
    const path = join(f.root, "groups.jsonl");
    writeFileSync(path, JSON.stringify({ pid: 999999, active: true }) + "\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    vi.useFakeTimers();
    try {
      const result = expect(stopRegisteredCommands(path)).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      await vi.advanceTimersByTimeAsync(2010);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
  it("treats an already-exited Windows command as idempotent cleanup", async () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(child.status).toBe(0);
    const registry = join(f.root, "processes.jsonl");
    writeFileSync(
      registry,
      `${JSON.stringify({ pid: child.pid, active: true })}\n`,
    );
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      await expect(stopRegisteredCommands(registry)).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
  it("reaps same-group background descendants even when the command exits normally", async () => {
    const f = fixture();
    const pidFile = join(f.target, ".forexplore-tests/background.txt");
    let pid: number | undefined;
    mockAgent(async (input) => {
      writeFileSync(f.task.expectationFile!, "{}");
      await runBehaviorCommandCli(
        [
          "--project",
          "target",
          "--",
          "node",
          "-e",
          `const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`,
        ],
        input.env,
      );
      pid = Number(readFileSync(pidFile, "utf8"));
    });
    try {
      await createBehaviorRuntime({ apiKey: "local-test-key" }).runAgent(
        f.task,
      );
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
    }
  });
  it.each(["abort", "kill-proxy"])(
    "stops nested proxy commands before a %s session returns",
    async (termination) => {
      const f = fixture();
      const controller = new AbortController();
      f.task.signal = controller.signal;
      const pidFile = join(f.target, ".forexplore-tests/pid.txt");
      const actual = processes.runManagedProcess;
      let pid: number | undefined;
      mockAgent(async (input) => {
        writeFileSync(f.task.expectationFile!, "{}");
        let proxyPid: number | undefined;
        const pending = actual(
          {
            command: process.execPath,
            args: [
              "--import",
              import.meta.resolve("tsx"),
              BEHAVIOR_COMMAND_ENTRY,
              "--project",
              "target",
              "--",
              "node",
              "-e",
              `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
            ],
            cwd: input.cwd,
            env: input.env,
            deadlineAt: input.deadlineAt,
            onSpawn: (spawned) => {
              proxyPid = spawned;
            },
          },
          controller.signal,
        );
        // The real proxy, not the injected Agent, launches the long-running command.
        for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(existsSync(pidFile)).toBe(true);
        pid = Number(readFileSync(pidFile, "utf8"));
        if (termination === "abort")
          controller.abort(new DOMException("stop", "AbortError"));
        else process.kill(-proxyPid!, "SIGKILL");
        await pending;
      });
      try {
        const session = createBehaviorRuntime({
          apiKey: "local-test-key",
        }).runAgent(f.task);
        if (termination === "abort") await expect(session).rejects.toThrow();
        else await session;
        expect(pid).toBeDefined();
        expect(() => process.kill(pid!, 0)).toThrow();
      } finally {
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
      }
    },
  );
  it("routes both project selectors, freezes before target execution and returns Host evidence before cleanup", async () => {
    const f = fixture();
    let temp = "";
    const spy = mockAgent(async (input) => {
      temp = input.env.CLAUDE_CONFIG_DIR!;
      const settings = JSON.parse(
        readFileSync(input.args[input.args.indexOf("--settings") + 1]!, "utf8"),
      );
      for (const root of [f.source, f.target]) {
        expect(settings.permissions.deny).toContain(
          `Write(//${root.replace(/^\/+/, "")}/implementation.cjs)`,
        );
        expect(settings.permissions.deny).not.toContain(
          `Write(//${root.replace(/^\/+/, "")}/**)`,
        );
        writeFileSync(
          join(root, ".forexplore-tests/runner.cjs"),
          "console.log(require('../implementation.cjs'))",
        );
      }
      await runBehaviorCommandCli(
        ["--project", "source", "--", "node", ".forexplore-tests/runner.cjs"],
        input.env,
      );
      await expect(
        runBehaviorCommandCli(
          ["--project", "target", "--", "node", ".forexplore-tests/runner.cjs"],
          input.env,
        ),
      ).rejects.toThrow();
      writeFileSync(f.task.expectationFile!, '{"frozen":"before-target"}');
      await runBehaviorCommandCli(
        ["--project", "target", "--", "node", ".forexplore-tests/runner.cjs"],
        input.env,
      );
      // An Agent-writable evidence copy is irrelevant to the runtime return value.
      writeFileSync(
        join(f.target, ".forexplore-tests/commands-forged.jsonl"),
        '{"commandId":"fake"}\n',
      );
    });
    const result = await createBehaviorRuntime({
      apiKey: "local-test-key",
    }).runAgent(f.task);
    expect(result.frozenPlan).toBe('{"frozen":"before-target"}');
    expect(
      result.commandEvidence?.map((row) => [
        row.side,
        row.cwd,
        row.stdout.trim(),
      ]),
    ).toEqual([
      ["source", f.source, "42"],
      ["target", f.target, "42"],
    ]);
    expect(
      result.commandEvidence?.[1]?.testFiles?.[".forexplore-tests/runner.cjs"],
    ).toContain("implementation.cjs");
    expect(
      spy.mock.calls.filter(([input]) => input.args.includes("--print")),
    ).toHaveLength(1);
    expect(existsSync(temp)).toBe(false);
  });
  it("rejects plan rewrites, arbitrary project selectors, and disabled execution sides", async () => {
    const f = fixture();
    mockAgent(async (input) => {
      await expect(
        runBehaviorCommandCli(
          ["--project", f.target, "--", "node", "-e", "0"],
          input.env,
        ),
      ).rejects.toThrow(/selector/);
      await expect(
        runBehaviorCommandCli(["--", "node", "-e", "0"], input.env),
      ).rejects.toThrow(/selector/);
      await expect(
        runBehaviorCommandCli(
          ["--project", "source", "--", "node", "-e", "0"],
          input.env,
        ),
      ).rejects.toThrow(/selector/);
      writeFileSync(f.task.expectationFile!, "{}");
      await runBehaviorCommandCli(
        ["--project", "target", "--", "node", "-e", "0"],
        input.env,
      );
      writeFileSync(f.task.expectationFile!, '{"changed":true}');
      await expect(
        runBehaviorCommandCli(
          ["--project", "target", "--", "node", "-e", "0"],
          input.env,
        ),
      ).rejects.toThrow(/Frozen test plan/);
    });
    await expect(
      createBehaviorRuntime({ apiKey: "local-test-key" }).runAgent({
        ...f.task,
        executionSides: ["target"],
      }),
    ).rejects.toThrow(/Frozen test plan/);
  });
  it("checks both project baselines on every command and returns evidence on session failure", async () => {
    const f = fixture();
    const collected = vi.fn();
    mockAgent(async (input) => {
      writeFileSync(f.task.expectationFile!, "{}");
      await expect(
        runBehaviorCommandCli(
          [
            "--project",
            "target",
            "--",
            "node",
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(join(f.source, "implementation.cjs"))}, 'changed')`,
          ],
          input.env,
        ),
      ).rejects.toThrow(/baseline changed/);
      throw new Error("Agent failed");
    });
    await expect(
      createBehaviorRuntime({ apiKey: "local-test-key" }).runAgent({
        ...f.task,
        onEvidence: collected,
      }),
    ).rejects.toThrow(/baseline changed/);
    expect(collected.mock.calls[0]?.[0]).toMatchObject([
      { side: "target", baselineValid: false },
    ]);
  });
  it("supports explicitly empty execution authorization for design-only sessions", async () => {
    const f = fixture();
    mockAgent(async (input) => {
      const control = JSON.parse(
        readFileSync(input.env[BEHAVIOR_CONTROL_ENV]!, "utf8"),
      ) as BehaviorSessionControl;
      expect(control.executionSides).toEqual([]);
      for (const side of ["source", "target"])
        await expect(
          runBehaviorCommandCli(
            ["--project", side, "--", "node", "-e", "0"],
            input.env,
          ),
        ).rejects.toThrow(/selector/);
    });
    const result = await createBehaviorRuntime({
      apiKey: "local-test-key",
    }).runAgent({ ...f.task, executionSides: [] });
    expect(result.commandEvidence).toEqual([]);
    expect(result.frozenPlan).toBeUndefined();
  });
});
