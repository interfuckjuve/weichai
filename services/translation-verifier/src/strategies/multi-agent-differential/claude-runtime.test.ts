import { createServer } from "node:http";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processes from "../smoke-differential/manage-test-process.js";
import { createBehaviorRuntime } from "./claude-runtime.js";
import {
  captureProjectBaseline,
  assertProjectBaseline,
} from "./behavior-workspace.js";
import {
  BEHAVIOR_COMMAND_ENTRY,
  BEHAVIOR_CONTROL_ENV,
  buildEnvironment,
  captureFrozenFiles,
  protectedSecrets,
  resolveBehaviorCommand,
  runBehaviorCommand,
  runBehaviorCommandCli,
  type BehaviorCommandControl,
} from "./behavior-command.js";
import type { BehaviorExecutionScope } from "./behavior-types.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "behavior-runtime-")));
  directories.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  const tests = join(source, ".forexplore-tests");
  mkdirSync(tests, { recursive: true });
  mkdirSync(target);
  mkdirSync(join(source, "lib"));
  writeFileSync(join(source, "implementation.txt"), "source-original");
  writeFileSync(join(source, "lib", "value.cjs"), "module.exports = 42;");
  writeFileSync(join(source, "value.py"), "value = 42\n");
  writeFileSync(join(target, "implementation.txt"), "target-original");
  const sandbox: BehaviorExecutionScope = {
    cwd: source,
    readRoots: [source, target],
    writeRoots: [tests, source],
  };
  return { root, source, target, tests, sandbox };
}
function control(sandbox: BehaviorExecutionScope): BehaviorCommandControl {
  return {
    scope: sandbox,
    baselines: sandbox.readRoots.map(captureProjectBaseline),
    frozenFiles: captureFrozenFiles(sandbox),
    deadlineAt: Date.now() + 10_000,
    env: buildEnvironment(),
    secrets: protectedSecrets(),
  };
}
function run(
  sandbox: BehaviorExecutionScope,
  executable: string,
  args: string[],
  timeoutMs = 10_000,
) {
  return createBehaviorRuntime({ timeoutMs }).runCommand({
    sandbox,
    command: { executable, args },
    deadlineAt: Date.now() + timeoutMs,
  });
}

describe("behavior command controls without OS isolation", () => {
  it("runs real Node and Python in project cwd, reading implementation and creating tests/build caches", async () => {
    const f = fixture();
    const baseline = captureProjectBaseline(f.source);
    const node = await run(f.sandbox, process.execPath, [
      "-e",
      `
      const fs = require('node:fs');
      fs.mkdirSync('tests'); fs.writeFileSync('tests/value.test.cjs', "require('../lib/value.cjs')");
      fs.mkdirSync('target'); fs.writeFileSync('target/compiled.txt', String(require('./lib/value.cjs')));
      console.log(JSON.stringify({cwd:process.cwd(), value:require('./lib/value.cjs'), home:process.env.HOME}));
    `,
    ]);
    expect(node.exitCode, node.stderr).toBe(0);
    expect(JSON.parse(node.stdout)).toEqual({
      cwd: f.source,
      value: 42,
      home: process.env.HOME,
    });
    const python = await run(f.sandbox, "python3", [
      "-c",
      "import os, py_compile, ssl, sqlite3; import value; py_compile.compile('value.py'); print(str(value.value) + ':' + os.getcwd())",
    ]);
    expect(python.exitCode, python.stderr).toBe(0);
    expect(python.stdout).toBe(`42:${f.source}\n`);
    expect(existsSync(join(f.source, "__pycache__"))).toBe(true);
    expect(readFileSync(join(f.source, "target", "compiled.txt"), "utf8")).toBe(
      "42",
    );
    assertProjectBaseline(baseline);
  });

  it("keeps the original baseline across calls and rejects modifications before and after execution", async () => {
    const f = fixture();
    const runtime = createBehaviorRuntime();
    const task = {
      sandbox: f.sandbox,
      deadlineAt: Date.now() + 10_000,
      command: { executable: "node", args: ["-e", "console.log('ok')"] },
    };
    await runtime.runCommand(task);
    writeFileSync(join(f.source, "implementation.txt"), "modified");
    const spy = vi.spyOn(processes, "runManagedProcess");
    await expect(runtime.runCommand(task)).rejects.toThrow(/baseline changed/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    writeFileSync(join(f.source, "implementation.txt"), "source-original");
    await expect(
      runtime.runCommand({
        ...task,
        command: {
          executable: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('implementation.txt','bad')",
          ],
        },
      }),
    ).rejects.toThrow(/baseline changed/);
    // There is no OS deny: detection rejects the result but does not roll back the COW project.
    expect(readFileSync(join(f.source, "implementation.txt"), "utf8")).toBe(
      "bad",
    );
  });

  it("rejects new production files but accepts new standard test files", async () => {
    const f = fixture();
    await expect(
      run(f.sandbox, "node", [
        "-e",
        "require('node:fs').writeFileSync('new-production.cjs','bad')",
      ]),
    ).rejects.toThrow(/New file outside/);
  });

  it("freezes declared files inside otherwise writable test directories", async () => {
    const f = fixture();
    const frozen = join(f.tests, "runner.cjs");
    writeFileSync(frozen, "trusted");
    const sandbox = { ...f.sandbox, readOnlyFiles: [frozen] };
    const runtime = createBehaviorRuntime();
    const task = {
      sandbox,
      deadlineAt: Date.now() + 10_000,
      command: { executable: "node", args: ["-e", "console.log('ok')"] },
    };
    const c = control(sandbox);
    const command = { executable: "node", args: ["-e", "console.log('ok')"] };
    await runBehaviorCommand(command, c);
    writeFileSync(frozen, "tampered-within-session");
    await expect(runBehaviorCommand(command, c)).rejects.toThrow(
      /Frozen file integrity/,
    );
    writeFileSync(frozen, "trusted");
    await expect(
      runtime.runCommand({
        ...task,
        command: {
          executable: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(frozen)},'bad')`,
          ],
        },
      }),
    ).rejects.toThrow(/Frozen file integrity/);
  });

  it("rejects invalid frozen paths, links and outside write roots before spawning", async () => {
    const f = fixture();
    const frozen = join(f.tests, "runner.cjs");
    writeFileSync(frozen, "trusted");
    const symbolic = join(f.tests, "symbolic");
    symlinkSync(frozen, symbolic);
    const hard = join(f.tests, "hard");
    linkSync(frozen, hard);
    const spy = vi.spyOn(processes, "runManagedProcess");
    for (const file of [
      frozen,
      hard,
      symbolic,
      f.tests,
      join(f.tests, "missing"),
      `${f.tests}/../.forexplore-tests/runner.cjs`,
    ])
      await expect(
        run({ ...f.sandbox, readOnlyFiles: [file] }, "node", ["-e", ""]),
      ).rejects.toThrow();
    await expect(
      run({ ...f.sandbox, writeRoots: [f.root] }, "node", []),
    ).rejects.toThrow(/project-contained/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("removes credentials from subprocess env, scrubs stderr, and refuses credential stdout", async () => {
    const f = fixture();
    vi.stubEnv("TEST_API_KEY", "protected-output-one");
    vi.stubEnv("DEEPSEEK_API_KEY", "protected-output-two");
    const result = await run(f.sandbox, "node", [
      "-e",
      "console.log(JSON.stringify({key:process.env.TEST_API_KEY,model:process.env.DEEPSEEK_API_KEY,home:process.env.HOME})); console.error('protected-output-one')",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ home: process.env.HOME });
    expect(result.stderr).toBe("[REDACTED]\n");
    for (const secret of ["protected-output-one", "protected-output-two"])
      await expect(
        run(f.sandbox, "node", ["-e", `console.log('${secret}')`]),
      ).rejects.toThrow(
        "Command output contains protected credential material; comparison refused.",
      );
  });

  it("allowlists installed Maven/.NET and project wrappers, rejects shells and disguised paths", () => {
    const f = fixture();
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    for (const name of ["mvn", "dotnet"])
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const wrapper = join(f.source, "mvnw");
    writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const c = control(f.sandbox);
    c.env.PATH = `${bin}:${c.env.PATH}`;
    expect(
      resolveBehaviorCommand({ executable: "mvn", args: ["-q", "test"] }, c),
    ).toBe(join(bin, "mvn"));
    expect(
      resolveBehaviorCommand(
        { executable: "dotnet", args: ["test", "--no-restore"] },
        c,
      ),
    ).toBe(join(bin, "dotnet"));
    expect(
      resolveBehaviorCommand({ executable: "./mvnw", args: ["test"] }, c),
    ).toBe(wrapper);
    for (const executable of ["bash", "/bin/sh", "curl", "git", "node;echo"])
      expect(() => resolveBehaviorCommand({ executable, args: [] }, c)).toThrow(
        /not allowed/,
      );
    const fake = join(f.tests, "node");
    writeFileSync(fake, "fake", { mode: 0o755 });
    expect(() =>
      resolveBehaviorCommand({ executable: fake, args: [] }, c),
    ).toThrow(/not the installed tool/);
    symlinkSync(wrapper, join(f.root, "mvnw"));
    expect(() =>
      resolveBehaviorCommand(
        { executable: join(f.root, "mvnw"), args: ["test"] },
        c,
      ),
    ).not.toThrow();
    writeFileSync(join(f.root, "gradlew"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() =>
      resolveBehaviorCommand(
        { executable: join(f.root, "gradlew"), args: [] },
        c,
      ),
    ).toThrow(/inside the project/);
    expect(() =>
      resolveBehaviorCommand({ executable: "node", args: ["bad\0arg"] }, c),
    ).toThrow(/arguments/);
  });

  it("protects cwd only while unrelated target evolves, and freezes existing helpers during Host replay", async () => {
    const f = fixture();
    const runtime = createBehaviorRuntime();
    const baseline = captureProjectBaseline(f.source);
    mkdirSync(join(f.source, "tests"));
    const helper = join(f.source, "tests", "helper.cjs");
    writeFileSync(helper, "old-helper");
    const sandbox = { ...f.sandbox, baseline };
    const command = { executable: "node", args: ["-e", "console.log('ok')"] };
    await runtime.runCommand({
      sandbox,
      command,
      deadlineAt: Date.now() + 10_000,
    });
    writeFileSync(
      join(f.target, "implementation.txt"),
      "upstream-translation-in-progress",
    );
    expect(
      (
        await runtime.runCommand({
          sandbox,
          command,
          deadlineAt: Date.now() + 10_000,
        })
      ).exitCode,
    ).toBe(0);
    await expect(
      runtime.runCommand({
        sandbox,
        command: {
          executable: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('tests/helper.cjs','changed')",
          ],
        },
        deadlineAt: Date.now() + 10_000,
      }),
    ).rejects.toThrow(/baseline changed/);
  });

  it("records host command evidence with failed baseline and refuses tampered proxy scope", async () => {
    const f = fixture();
    const c = control(f.sandbox);
    c.evidencePath = join(f.root, "commands.jsonl");
    await expect(
      runBehaviorCommand(
        {
          executable: "node",
          args: [
            "-e",
            "require('node:fs').writeFileSync('implementation.txt','bad')",
          ],
        },
        c,
      ),
    ).rejects.toThrow(/baseline changed/);
    expect(JSON.parse(readFileSync(c.evidencePath, "utf8"))).toMatchObject({
      baselineValid: false,
      cwd: f.source,
      exitCode: 0,
    });
    const file = join(f.root, "control.json");
    writeFileSync(file, JSON.stringify(c));
    await expect(
      runBehaviorCommandCli(["--cwd", f.target, "--", "node"], {
        [BEHAVIOR_CONTROL_ENV]: file,
      }),
    ).rejects.toThrow(/Expected --/);
    writeFileSync(file, "{");
    await expect(
      runBehaviorCommandCli(["--", "node"], { [BEHAVIOR_CONTROL_ENV]: file }),
    ).rejects.toThrow(/Invalid Host/);
  });

  it("bounds output and terminates timeout process trees; expired/aborted tasks never spawn", async () => {
    const f = fixture();
    const large = await run(f.sandbox, "node", [
      "-e",
      "process.stdout.write('x'.repeat(2*1024*1024))",
    ]);
    expect(large.stdout.length).toBeLessThan(1024 * 1024 + 100);
    expect(large.stdout).toContain("truncated");
    const timed = await run(
      f.sandbox,
      "node",
      [
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)",
      ],
      250,
    );
    expect(timed.timedOut).toBe(true);
    const spy = vi.spyOn(processes, "runManagedProcess");
    const runtime = createBehaviorRuntime();
    const task = {
      sandbox: f.sandbox,
      command: { executable: "node", args: [] },
      deadlineAt: Date.now() - 1,
    };
    await expect(runtime.runCommand(task)).rejects.toThrow(/expired/);
    const abort = new AbortController();
    const reason = new Error("stop");
    abort.abort(reason);
    await expect(
      runtime.runCommand({ ...task, signal: abort.signal }),
    ).rejects.toBe(reason);
    expect(spy).not.toHaveBeenCalled();
  }, 10_000);
});

describe("behavior Claude agent configuration", () => {
  it("uses separate actual source/target cwd, isolated config, disabled native sandbox, fixed proxy permissions and stdin", async () => {
    const f = fixture();
    const key = "only-a-test-key";
    const settingsSeen: {
      sandbox: { enabled: boolean };
      disableAllHooks: boolean;
      permissions: { deny: string[] };
    }[] = [];
    vi.stubEnv("JAVA_HOME", "/host/toolchain");
    const spy = vi
      .spyOn(processes, "runManagedProcess")
      .mockImplementation(async (input) => {
        if (!input.args.includes("--version")) {
          settingsSeen.push(
            JSON.parse(
              readFileSync(
                input.args[input.args.indexOf("--settings") + 1]!,
                "utf8",
              ),
            ),
          );
          expect(readFileSync(input.args[3]!, "utf8")).toBe(
            "author tests $HOME",
          );
          const c = JSON.parse(
            readFileSync(input.env[BEHAVIOR_CONTROL_ENV]!, "utf8"),
          );
          expect(c.env.HOME).toBe(process.env.HOME);
          expect(c.env.JAVA_HOME).toBe("/host/toolchain");
          expect(c.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
          input.onStdoutChunk?.(
            Buffer.from(
              `{"type":"assistant","text":"${key}"}\n{"type":"stream_event"}\n`,
            ),
          );
        }
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: input.args.includes("--version")
            ? "2.1.236 (Claude Code)\n"
            : "",
          stderr: key,
        };
      });
    const runtime = createBehaviorRuntime({
      apiKey: key,
      model: "test-model",
      maxTurns: 3,
      effort: "high",
    });
    for (const side of ["source", "target"] as const) {
      const cwd = side === "source" ? f.source : f.target;
      const tests = join(cwd, ".forexplore-tests");
      mkdirSync(tests, { recursive: true });
      const result = await runtime.runAgent({
        side,
        sandbox: {
          cwd,
          readRoots: [f.source, f.target],
          writeRoots: [tests, cwd],
        },
        prompt: "author tests $HOME",
        deadlineAt: Date.now() + 10_000,
      });
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stdout).not.toContain("stream_event");
      expect(result.stderr).toBe("[REDACTED]");
    }
    const calls = spy.mock.calls.filter(
      ([input]) => !input.args.includes("--version"),
    );
    expect(calls).toHaveLength(2);
    for (const [index, [input]] of calls.entries()) {
      const args = input.args;
      const settings = settingsSeen[index]!;
      expect(settings.permissions.deny).toContain(
        `Write(//${input.cwd.replace(/^\/+/, "")}/implementation.txt)`,
      );
      expect(settings.permissions.deny).toContain(
        `Edit(//${(index === 0 ? f.target : f.source).replace(/^\/+/, "")}/**)`,
      );
      expect(input.cwd).toBe(index === 0 ? f.source : f.target);
      expect(settings.sandbox).toEqual({ enabled: false });
      expect(settings.disableAllHooks).toBe(true);
      expect(args).toContain("--safe-mode");
      expect(args).toContain("--disallowedTools");
      expect(args).toContain("dontAsk");
      expect(args).toContain(`Bash(npx tsx ${BEHAVIOR_COMMAND_ENTRY} *)`);
      expect(args).not.toContain("Bash");
      expect(args).not.toContain("bypassPermissions");
      expect(args[args.indexOf("--append-system-prompt") + 1]).toContain(
        "NO OS isolation",
      );
      expect(input.env.HOME).toBe(process.env.HOME);
      expect(input.env.PATH).toBe(process.env.PATH);
      expect(input.env.ANTHROPIC_AUTH_TOKEN).toBe(key);
      expect(input.env.ANTHROPIC_BASE_URL).toBe(
        "https://api.deepseek.com/anthropic",
      );
      expect(existsSync(input.env.CLAUDE_CONFIG_DIR!)).toBe(false);
    }
    expect(calls[0]![0].env.CLAUDE_CONFIG_DIR).not.toBe(
      calls[1]![0].env.CLAUDE_CONFIG_DIR,
    );
  });

  it("uses Host original baseline in new retry sessions and accepts repaired frozen helpers on later replay", async () => {
    const f = fixture();
    const baseline = captureProjectBaseline(f.source);
    const helper = join(f.source, "tests", "helper.cjs");
    mkdirSync(join(f.source, "tests"));
    writeFileSync(helper, "first-authored-version");
    vi.spyOn(processes, "runManagedProcess").mockImplementation(
      async (input) => {
        if (!input.args.includes("--version"))
          writeFileSync(helper, "repaired-authored-version");
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "2.1.236\n",
          stderr: "",
        };
      },
    );
    const runtime = createBehaviorRuntime({ apiKey: "local-only" });
    const task = {
      side: "source" as const,
      sandbox: { ...f.sandbox, baseline },
      prompt: "repair tests",
      deadlineAt: Date.now() + 10_000,
    };
    expect((await runtime.runAgent(task)).exitCode).toBe(0);
    vi.restoreAllMocks();
    const frozen = join(f.tests, "runner.cjs");
    writeFileSync(frozen, "console.log('first')");
    const replay = {
      sandbox: { ...task.sandbox, readOnlyFiles: [frozen] },
      command: { executable: "node", args: [frozen] },
      deadlineAt: Date.now() + 10_000,
    };
    expect((await runtime.runCommand(replay)).stdout).toBe("first\n");
    writeFileSync(frozen, "console.log('repaired')");
    expect((await runtime.runCommand(replay)).stdout).toBe("repaired\n");
  });

  it("rejects agent edits to original implementation even when the agent exits successfully", async () => {
    const f = fixture();
    vi.spyOn(processes, "runManagedProcess").mockImplementation(
      async (input) => {
        if (!input.args.includes("--version"))
          writeFileSync(join(f.source, "implementation.txt"), "bad");
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "2.1.236\n",
          stderr: "",
        };
      },
    );
    await expect(
      createBehaviorRuntime({ apiKey: "local-only" }).runAgent({
        side: "source",
        sandbox: f.sandbox,
        prompt: "unused",
        deadlineAt: Date.now() + 10_000,
      }),
    ).rejects.toThrow(/baseline changed/);
  });

  it("runs real CLI against local SSE mock: raw Bash denied, Write and controlled proxy allowed, no custom instructions", async () => {
    const f = fixture();
    const baseline = captureProjectBaseline(f.source);
    const rawMarker = join(f.tests, "raw-command-ran");
    const marker = join(f.tests, "proxy-result.json");
    writeFileSync(
      join(f.source, "CLAUDE.md"),
      "DO_NOT_LOAD_PROJECT_CUSTOM_INSTRUCTIONS_3918",
    );
    const probe = join(f.tests, "probe.cjs");
    writeFileSync(
      probe,
      `const fs = require('node:fs'); const result={cwd:process.cwd(),value:require('../lib/value.cjs'),credentialAbsent:process.env.ANTHROPIC_AUTH_TOKEN===undefined,home:process.env.HOME};fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(result));console.log(JSON.stringify(result));`,
    );
    const prompt = `Execute the local permissions probes then stop.\n${"x".repeat(300_000)}\nend-of-prompt-$HOME`;
    const tools = [
      {
        type: "tool_use",
        id: "raw_probe",
        name: "Bash",
        input: {
          command: `node -e 'require("fs").writeFileSync(${JSON.stringify(rawMarker)},"bad")'`,
          dangerouslyDisableSandbox: true,
        },
      },
      {
        type: "tool_use",
        id: "chain_probe",
        name: "Bash",
        input: {
          command: `npx tsx ${BEHAVIOR_COMMAND_ENTRY} -- node ${JSON.stringify(probe)}; node -e 'require("fs").writeFileSync(${JSON.stringify(rawMarker)},"bad")'`,
          description: "Attempt shell composition outside proxy",
        },
      },
      {
        type: "tool_use",
        id: "write_probe",
        name: "Write",
        input: {
          file_path: join(f.tests, "authored.txt"),
          content: "authored",
        },
      },
      {
        type: "tool_use",
        id: "proxy_probe",
        name: "Bash",
        input: {
          command: `npx tsx ${BEHAVIOR_COMMAND_ENTRY} -- node ${JSON.stringify(probe)}`,
          description: "Run Host-supplied command proxy",
        },
      },
    ];
    let requests = 0;
    let wholePrompt = false;
    let loadedCustomInstructions = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let body: { stream?: boolean };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (request.url?.includes("count_tokens")) {
        response.setHeader("Content-Type", "application/json");
        response.end('{"input_tokens":1}');
        return;
      }
      if (!request.url?.includes("/messages")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const serialized = JSON.stringify(body);
      wholePrompt ||= serialized.includes(JSON.stringify(prompt).slice(1, -1));
      loadedCustomInstructions ||= serialized.includes(
        "DO_NOT_LOAD_PROJECT_CUSTOM_INSTRUCTIONS_3918",
      );
      const block = tools.at(requests++) ?? {
        type: "text",
        text: "Local permissions probe complete.",
      };
      const tool = block.type === "tool_use";
      const message = {
        id: `msg_local_${requests}`,
        type: "message",
        role: "assistant",
        model: "deepseek-v4-flash",
        content: [block],
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!body.stream) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(message));
        return;
      }
      response.setHeader("Content-Type", "text/event-stream");
      const event = (type: string, data: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      event("message_start", {
        message: { ...message, content: [], stop_reason: null },
      });
      event("content_block_start", {
        index: 0,
        content_block: tool
          ? { ...block, input: {} }
          : { type: "text", text: "" },
      });
      event("content_block_delta", {
        index: 0,
        delta:
          "input" in block
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : { type: "text_delta", text: block.text },
      });
      event("content_block_stop", { index: 0 });
      event("message_delta", {
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      event("message_stop", {});
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing mock address.");
    const realRun = processes.runManagedProcess;
    vi.spyOn(processes, "runManagedProcess").mockImplementation(
      (input, signal) =>
        realRun(
          {
            ...input,
            env: {
              ...input.env,
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
          },
          signal,
        ),
    );
    try {
      const result = await createBehaviorRuntime({
        apiKey: "local-mock-token-only",
        timeoutMs: 40_000,
        maxTurns: 6,
      }).runAgent({
        side: "source",
        sandbox: { ...f.sandbox, readOnlyFiles: [probe] },
        prompt,
        deadlineAt: Date.now() + 40_000,
      });
      expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      expect(existsSync(rawMarker), result.stdout).toBe(false);
      expect(
        existsSync(marker),
        result.stderr || "Controlled command did not produce its output",
      ).toBe(true);
      expect(readFileSync(join(f.tests, "authored.txt"), "utf8")).toBe(
        "authored",
      );
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
        cwd: f.source,
        value: 42,
        credentialAbsent: true,
        home: process.env.HOME,
      });
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const toolResults = events
        .flatMap((event) => event.message?.content ?? [])
        .filter((block) => block.type === "tool_result");
      expect(
        toolResults.find((block) => block.tool_use_id === "raw_probe"),
      ).toMatchObject({ is_error: true });
      expect(
        toolResults.find((block) => block.tool_use_id === "chain_probe"),
      ).toMatchObject({ is_error: true });
      expect(
        toolResults.find((block) => block.tool_use_id === "proxy_probe"),
      ).toMatchObject({ is_error: false });
      expect(wholePrompt).toBe(true);
      expect(loadedCustomInstructions).toBe(false);
      expect(requests).toBeGreaterThanOrEqual(4);
      expect(result.stdout).not.toContain("local-mock-token-only");
      expect(readFileSync(join(f.source, "implementation.txt"), "utf8")).toBe(
        "source-original",
      );
      expect(baseline.files["implementation.txt"]).toBe(
        captureProjectBaseline(f.source).files["implementation.txt"],
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 50_000);
});
