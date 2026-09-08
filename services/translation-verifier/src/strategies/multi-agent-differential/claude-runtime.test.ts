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
import { projectHash } from "./behavior-workspace.js";
import type { BehaviorSandbox } from "./behavior-types.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  source: string;
  target: string;
  tests: string;
  sandbox: BehaviorSandbox;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "behavior-runtime-")));
  directories.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  const tests = join(source, ".forexplore-tests");
  mkdirSync(tests, { recursive: true });
  mkdirSync(target);
  mkdirSync(join(source, "lib"));
  writeFileSync(join(source, "implementation.txt"), "source-original");
  writeFileSync(join(source, "lib", "nested.txt"), "nested-original");
  writeFileSync(join(target, "implementation.txt"), "target-original");
  writeFileSync(join(root, "private.txt"), "outside-secret");
  return {
    root,
    source,
    target,
    tests,
    sandbox: { cwd: source, readRoots: [source, target], writeRoots: [tests] },
  };
}

function run(
  sandbox: BehaviorSandbox,
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

const native = describe.skipIf(process.platform !== "darwin");
native("behavior command native Seatbelt", () => {
  it("reads both project roots, writes only tests, and denies source edits, symlink escapes, hard links and outside reads", async () => {
    const f = fixture();
    symlinkSync(join(f.root, "private.txt"), join(f.tests, "outside-link"));
    symlinkSync(
      join(f.source, "implementation.txt"),
      join(f.tests, "source-link"),
    );
    const code = `
      const fs = require('node:fs'); const path = require('node:path');
      const tests = ${JSON.stringify(f.tests)}; const root = ${JSON.stringify(f.root)};
      const blocked = (operation) => { try { operation(); return false; } catch (e) { return ['EPERM','EACCES'].includes(e.code); } };
      fs.writeFileSync(path.join(tests, 'allowed.txt'), 'test-output');
      console.log(JSON.stringify({
        source: fs.readFileSync('implementation.txt', 'utf8'),
        target: fs.readFileSync(${JSON.stringify(join(f.target, "implementation.txt"))}, 'utf8'),
        outsideRead: blocked(() => fs.readFileSync(path.join(root, 'private.txt'))),
        outsideWrite: blocked(() => fs.writeFileSync(path.join(root, 'new.txt'), 'bad')),
        sourceWrite: blocked(() => fs.writeFileSync('implementation.txt', 'bad')),
        sourceUnlink: blocked(() => fs.unlinkSync('implementation.txt')),
        nestedWrite: blocked(() => fs.writeFileSync('lib/nested.txt', 'bad')),
        newProjectFile: blocked(() => fs.writeFileSync('new.txt', 'bad')),
        sourceRename: blocked(() => fs.renameSync('lib', path.join(tests, 'moved'))),
        symlinkRead: blocked(() => fs.readFileSync(path.join(tests, 'outside-link'))),
        symlinkWrite: blocked(() => fs.writeFileSync(path.join(tests, 'source-link'), 'bad')),
        hardlink: blocked(() => { fs.linkSync('implementation.txt', path.join(tests, 'hardlink')); fs.writeFileSync(path.join(tests, 'hardlink'), 'bad'); }),
      }));`;
    const result = await run(f.sandbox, process.execPath, ["-e", code]);
    expect(result, result.stderr).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      source: "source-original",
      target: "target-original",
      outsideRead: true,
      outsideWrite: true,
      sourceWrite: true,
      sourceUnlink: true,
      nestedWrite: true,
      newProjectFile: true,
      sourceRename: true,
      symlinkRead: true,
      symlinkWrite: true,
      hardlink: true,
    });
    expect(readFileSync(join(f.source, "implementation.txt"), "utf8")).toBe(
      "source-original",
    );
    expect(readFileSync(join(f.tests, "allowed.txt"), "utf8")).toBe(
      "test-output",
    );
  });

  it("freezes declared replay files while leaving output and cache writable", async () => {
    const f = fixture();
    mkdirSync(join(f.tests, "runners"));
    const frozen = join(f.tests, "runners", "runner.cjs");
    writeFileSync(frozen, "trusted-runner");
    mkdirSync(join(f.tests, "cache"));
    const result = await run(
      { ...f.sandbox, readOnlyFiles: [frozen] },
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const frozen = ${JSON.stringify(frozen)};
      const blocked = operation => { try { operation(); return false; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code); } };
      const replacement = ${JSON.stringify(join(f.tests, "replacement"))};
      fs.writeFileSync(replacement, 'replacement');
      console.log(JSON.stringify({
        read: fs.readFileSync(frozen, 'utf8'),
        write: blocked(() => fs.writeFileSync(frozen, 'bad')),
        unlink: blocked(() => fs.unlinkSync(frozen)),
        rename: blocked(() => fs.renameSync(frozen, frozen + '.moved')),
        replace: blocked(() => fs.renameSync(replacement, frozen)),
        hardlink: blocked(() => { fs.linkSync(frozen, frozen + '.link'); fs.writeFileSync(frozen + '.link', 'bad'); }),
        parentRename: blocked(() => fs.renameSync(${JSON.stringify(join(f.tests, "runners"))}, ${JSON.stringify(join(f.tests, "moved-runners"))})),
        rootRename: blocked(() => fs.renameSync(${JSON.stringify(f.tests)}, ${JSON.stringify(f.tests + "-moved")})),
      }));
      fs.writeFileSync(${JSON.stringify(join(f.tests, "output.json"))}, '{}');
      fs.writeFileSync(${JSON.stringify(join(f.tests, "cache", "entry"))}, 'cache');
    `,
      ],
    );
    expect(result, result.stderr).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      read: "trusted-runner",
      write: true,
      unlink: true,
      rename: true,
      replace: true,
      hardlink: true,
      parentRename: true,
      rootRename: true,
    });
    expect(readFileSync(frozen, "utf8")).toBe("trusted-runner");
    expect(readFileSync(join(f.tests, "output.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(f.tests, "cache", "entry"), "utf8")).toBe("cache");
  });

  it("refuses credential-bearing stdout instead of comparing redacted values and only scrubs stderr", async () => {
    const f = fixture();
    vi.stubEnv("TEST_API_KEY", "protected-output-one");
    vi.stubEnv("TEST_SECRET", "protected-output-two");
    for (const value of ["protected-output-one", "protected-output-two"]) {
      await expect(
        run(f.sandbox, process.execPath, [
          "-e",
          `console.log(${JSON.stringify(value)})`,
        ]),
      ).rejects.toThrow(
        "Command output contains protected credential material; comparison refused.",
      );
    }
    const result = await run(f.sandbox, process.execPath, [
      "-e",
      "process.stdout.write('unchanged\\n'); console.error('protected-output-one')",
    ]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "unchanged\n",
      stderr: "[REDACTED]\n",
    });
  });

  it("rejects noncanonical, symlinked, multi-link, missing or out-of-root frozen files before process creation", async () => {
    const f = fixture();
    const frozen = join(f.tests, "runner.cjs");
    writeFileSync(frozen, "trusted");
    const symbolic = join(f.tests, "runner-link");
    symlinkSync(frozen, symbolic);
    const hard = join(f.tests, "runner-hard");
    linkSync(frozen, hard);
    const spy = vi.spyOn(processes, "runManagedProcess");
    for (const path of [
      frozen,
      hard,
      symbolic,
      f.tests,
      join(f.tests, "missing"),
      join(f.source, "implementation.txt"),
      `${f.tests}/../.forexplore-tests/runner.cjs`,
    ]) {
      await expect(
        run({ ...f.sandbox, readOnlyFiles: [path] }, process.execPath, [
          "-e",
          "",
        ]),
      ).rejects.toThrow();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("denies a real loopback TCP connection and inherited child-process escape", async () => {
    const f = fixture();
    let connected = false;
    const server = createServer((_request, response) => {
      connected = true;
      response.end("not allowed");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing listener address.");
      const code = `
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(`try { require('node:fs').readFileSync(${JSON.stringify(join(f.root, "private.txt"))}); process.exit(9); } catch(e) { process.exit(e.code === 'EPERM' || e.code === 'EACCES' ? 0 : 8); }`)}], {encoding:'utf8'});
        const req = require('node:http').get('http://127.0.0.1:${address.port}', () => { process.exitCode = 9; });
        req.on('error', e => console.log(JSON.stringify({code:e.code,child:child.status})));
      `;
      const result = await run(f.sandbox, process.execPath, ["-e", code]);
      expect(result, result.stderr).toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        code: "EPERM",
        child: 0,
      });
      expect(connected).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not inherit credentials, shell startup hooks, Node injection flags or host HOME", async () => {
    const f = fixture();
    vi.stubEnv("DEEPSEEK_API_KEY", "test-credential-not-for-child");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "another-secret");
    vi.stubEnv("NODE_OPTIONS", "--require=/must-not-load.cjs");
    vi.stubEnv("BASH_ENV", "/must-not-source.sh");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");
    const result = await run(f.sandbox, process.execPath, [
      "-e",
      "console.log(JSON.stringify(process.env))",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.HOME).toBe(f.tests);
    for (const name of [
      "DEEPSEEK_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
      "BASH_ENV",
      "CONTEXT7_API_KEY",
    ])
      expect(env[name]).toBeUndefined();
    expect(result.stdout).not.toContain("test-credential-not-for-child");
  });

  it("reports Host exit status and times out a process tree", async () => {
    const f = fixture();
    const failed = await run(f.sandbox, process.execPath, [
      "-e",
      "console.log('agent-claims-pass'); process.exit(7)",
    ]);
    expect(failed).toMatchObject({
      exitCode: 7,
      timedOut: false,
      stdout: "agent-claims-pass\n",
    });
    const started = Date.now();
    const result = await run(
      f.sandbox,
      process.execPath,
      [
        "-e",
        "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'}); setInterval(()=>{},1000)",
      ],
      500,
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10_000);

  it("runs installed Node, Python standard-library extensions and Java compilation without widening project access", async () => {
    const f = fixture();
    const node = await run(f.sandbox, "node", ["-e", "console.log('node-ok')"]);
    expect(node.exitCode, node.stderr).toBe(0);
    expect(node.stdout).toContain("node-ok");
    if (
      existsSync("/opt/homebrew/bin/python3") ||
      existsSync("/usr/local/bin/python3")
    ) {
      const python = await run(f.sandbox, "python3", [
        "-c",
        "import ssl, sqlite3, lzma, decimal; print('python-ok')",
      ]);
      expect(python.exitCode, python.stderr).toBe(0);
      expect(python.stdout).toContain("python-ok");
      writeFileSync(join(f.source, "implementation.py"), "value = 1\n");
      const before = projectHash(f.source);
      const bytecode = await run(f.sandbox, "python3", [
        "-m",
        "compileall",
        "-q",
        "implementation.py",
      ]);
      expect(bytecode.exitCode, bytecode.stderr).toBe(0);
      expect(existsSync(join(f.tests, "python-cache"))).toBe(true);
      expect(projectHash(f.source)).toBe(before);
    }
    if (
      existsSync(
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java",
      ) ||
      existsSync(
        "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java",
      )
    ) {
      writeFileSync(
        join(f.tests, "Probe.java"),
        'public class Probe { public static void main(String[] args) { System.out.println("java-ok"); } }',
      );
      const compile = await run(f.sandbox, "javac", [
        "-d",
        f.tests,
        join(f.tests, "Probe.java"),
      ]);
      expect(compile.exitCode, compile.stderr).toBe(0);
      const java = await run(f.sandbox, "java", [
        "-XX:-UsePerfData",
        "-cp",
        f.tests,
        "Probe",
      ]);
      expect(java.exitCode, java.stderr).toBe(0);
      expect(java.stdout).toContain("java-ok");
    }
  }, 30_000);
});

native("behavior Claude agent configuration", () => {
  it("starts separate source/target processes with existing source entries protected and stream-json evidence redacted", async () => {
    const f = fixture();
    const key = "only-a-test-key";
    const spy = vi
      .spyOn(processes, "runManagedProcess")
      .mockImplementation(async (input) => ({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: input.args.includes("--version")
          ? "2.1.236 (Claude Code)\n"
          : `{"secret":"${key}"}\n`,
        stderr: key,
      }));
    const runtime = createBehaviorRuntime({
      apiKey: key,
      model: "test-model",
      maxTurns: 3,
      effort: "high",
    });
    const results = [];
    for (const side of ["source", "target"] as const) {
      const cwd = side === "source" ? f.source : f.target;
      const tests = join(cwd, ".forexplore-tests");
      mkdirSync(tests, { recursive: true });
      const sandbox = {
        cwd,
        readRoots: [f.source, f.target],
        writeRoots: [tests],
        readOnlyFiles: [join(tests, "runner.cjs")],
      };
      writeFileSync(sandbox.readOnlyFiles[0]!, "trusted");
      results.push(
        await runtime.runAgent({
          side,
          prompt: "author tests",
          sandbox,
          deadlineAt: Date.now() + 10_000,
        }),
      );
    }
    const agentCalls = spy.mock.calls.filter(
      ([input]) => !input.args.includes("--version"),
    );
    expect(agentCalls).toHaveLength(2);
    for (const [index, [input]] of agentCalls.entries()) {
      const args = input.args;
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
      expect(input.cwd).toBe(index === 0 ? f.source : f.target);
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
      expect(args).not.toContain("--bare");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("bypassPermissions");
      expect(args[args.indexOf("--tools") + 1]).toBe("Bash");
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
      expect(settings.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
      });
      expect(settings.sandbox.filesystem.denyWrite).toContain(
        join(input.cwd, "implementation.txt"),
      );
      expect(settings.sandbox.filesystem.denyWrite).not.toContain(input.cwd);
      const scratch = input.env.CLAUDE_CODE_TMPDIR!;
      expect(scratch).toMatch(/^\/private\/tmp\/fx-[a-zA-Z0-9]{6}$/);
      expect(settings.sandbox.filesystem.allowWrite).toEqual([
        join(input.cwd, ".forexplore-tests"),
        scratch,
      ]);
      expect(settings.sandbox.filesystem.allowRead).toContain(scratch);
      expect(settings.sandbox.filesystem.denyWrite).toEqual(
        expect.arrayContaining([
          "/tmp/claude*",
          "/private/tmp/claude*",
          join(input.cwd, ".forexplore-tests", "runner.cjs"),
        ]),
      );
      expect(existsSync(scratch)).toBe(false);
      expect(settings.sandbox.network).toMatchObject({
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
      });
      expect(input.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
      expect(input.env.ANTHROPIC_AUTH_TOKEN).toBe(key);
      expect(input.env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(existsSync(input.env.CLAUDE_CONFIG_DIR!)).toBe(false);
      expect(results[index]!.stdout).not.toContain(key);
      expect(results[index]!.stderr).toBe("[REDACTED]");
    }
    expect(agentCalls[0]![0].env.CLAUDE_CONFIG_DIR).not.toBe(
      agentCalls[1]![0].env.CLAUDE_CONFIG_DIR,
    );
    expect(agentCalls[0]![0].env.CLAUDE_CODE_TMPDIR).not.toBe(
      agentCalls[1]![0].env.CLAUDE_CODE_TMPDIR,
    );
  });

  it("runs the real Claude CLI against a local mock model and enforces native Bash read/write boundaries", async () => {
    const f = fixture();
    const initialHash = projectHash(f.source);
    const marker = join(f.tests, "native-agent-result.json");
    const otherSession = mkdtempSync("/private/tmp/claude-boundary-test-");
    directories.push(otherSession);
    writeFileSync(join(otherSession, "secret"), "other-session-secret");
    const probe = join(f.tests, "native-agent-probe.cjs");
    writeFileSync(
      probe,
      `
      const fs = require('node:fs');
      const blocked = operation => { try { operation(); return false; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; } };
      const result = {
        source: fs.readFileSync('implementation.txt', 'utf8'),
        outsideRead: blocked(() => fs.readFileSync(${JSON.stringify(join(f.root, "private.txt"))})),
        sourceWrite: blocked(() => fs.writeFileSync('implementation.txt', 'bad')),
        nestedWrite: blocked(() => fs.writeFileSync('lib/nested.txt', 'bad')),
        sourceRename: blocked(() => fs.renameSync('lib', '.forexplore-tests/moved')),
        hardlinkWrite: blocked(() => { fs.linkSync('implementation.txt', '.forexplore-tests/native-hardlink'); fs.writeFileSync('.forexplore-tests/native-hardlink', 'bad'); }),
        credentialAbsent: process.env.ANTHROPIC_AUTH_TOKEN === undefined,
        otherSessionRead: blocked(() => fs.readFileSync(${JSON.stringify(join(otherSession, "secret"))})),
        otherSessionWrite: blocked(() => fs.writeFileSync(${JSON.stringify(join(otherSession, "secret"))}, 'bad')),
        frozenWrite: blocked(() => fs.writeFileSync(${JSON.stringify(probe)}, 'bad')),
        frozenUnlink: blocked(() => fs.unlinkSync(${JSON.stringify(probe)})),
        frozenRename: blocked(() => fs.renameSync(${JSON.stringify(probe)}, ${JSON.stringify(probe + ".moved")})),
        frozenHardlink: blocked(() => { fs.linkSync(${JSON.stringify(probe)}, ${JSON.stringify(probe + ".link")}); fs.writeFileSync(${JSON.stringify(probe + ".link")}, 'bad'); }),
      };
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(result)); console.log(JSON.stringify(result));
    `,
    );
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}`;
    let messageRequests = 0;
    const longPrompt = `Execute the supplied boundary probe, then stop.\n${"x".repeat(300_000)}\nend-of-prompt-$HOME`;
    let receivedWholePrompt = false;
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
      receivedWholePrompt ||= JSON.stringify(body).includes(
        JSON.stringify(longPrompt).slice(1, -1),
      );
      const tool = messageRequests++ === 0;
      const block = tool
        ? {
            type: "tool_use",
            id: "tool_boundary_probe",
            name: "Bash",
            input: {
              command,
              dangerouslyDisableSandbox: true,
              description: "Probe the native sandbox and blocked fallback",
            },
          }
        : { type: "text", text: "Local boundary probe complete." };
      const message = {
        id: `msg_local_${messageRequests}`,
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
        delta: tool
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
    const realRun = processes.runManagedProcess;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing mock address.");
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
        timeoutMs: 30_000,
        maxTurns: 3,
      }).runAgent({
        side: "source",
        sandbox: { ...f.sandbox, readOnlyFiles: [probe] },
        prompt: longPrompt,
        deadlineAt: Date.now() + 30_000,
      });
      expect(result, `${result.stderr}\n${result.stdout}`).toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      expect(existsSync(marker), `${result.stderr}\n${result.stdout}`).toBe(
        true,
      );
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
        source: "source-original",
        outsideRead: true,
        sourceWrite: true,
        nestedWrite: true,
        sourceRename: true,
        hardlinkWrite: true,
        credentialAbsent: true,
        otherSessionRead: true,
        otherSessionWrite: true,
        frozenWrite: true,
        frozenUnlink: true,
        frozenRename: true,
        frozenHardlink: true,
      });
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const toolResults = events
        .flatMap((event) => event.message?.content ?? [])
        .filter((block) => block.type === "tool_result");
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0], JSON.stringify(toolResults[0])).toMatchObject({
        tool_use_id: "tool_boundary_probe",
        is_error: false,
      });
      expect(JSON.stringify(toolResults)).not.toMatch(
        /Operation not permitted|Exit code [1-9]/,
      );
      expect(readFileSync(join(otherSession, "secret"), "utf8")).toBe(
        "other-session-secret",
      );
      expect(readFileSync(join(f.source, "implementation.txt"), "utf8")).toBe(
        "source-original",
      );
      expect(projectHash(f.source)).toBe(initialHash);
      expect(receivedWholePrompt).toBe(true);
      expect(messageRequests).toBeGreaterThanOrEqual(2);
      expect(result.stdout).toContain('"type":"assistant"');
      expect(result.stdout).not.toContain("local-mock-token-only");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 40_000);

  it("fails closed before model execution on an old CLI or a filename that cannot be denied literally", async () => {
    const f = fixture();
    const spy = vi.spyOn(processes, "runManagedProcess").mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "2.1.100 (Claude Code)\n",
      stderr: "",
    });
    const task = {
      side: "source" as const,
      sandbox: f.sandbox,
      prompt: "unused",
      deadlineAt: Date.now() + 10_000,
    };
    await expect(
      createBehaviorRuntime({ apiKey: "dummy-only" }).runAgent(task),
    ).rejects.toThrow(">= 2.1.236");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].args).toEqual(["--version"]);
    spy.mockClear();
    writeFileSync(join(f.source, "literal[1].txt"), "must remain protected");
    await expect(
      createBehaviorRuntime({ apiKey: "dummy-only" }).runAgent(task),
    ).rejects.toThrow("filename");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects broad write roots and expired or aborted requests before process creation", async () => {
    const f = fixture();
    const spy = vi.spyOn(processes, "runManagedProcess");
    const runtime = createBehaviorRuntime();
    await expect(
      runtime.runCommand({
        sandbox: { ...f.sandbox, writeRoots: [f.source] },
        command: { executable: "node", args: [] },
        deadlineAt: Date.now() + 10_000,
      }),
    ).rejects.toThrow("dedicated");
    await expect(
      runtime.runCommand({
        sandbox: f.sandbox,
        command: { executable: "node", args: [] },
        deadlineAt: 0,
      }),
    ).rejects.toThrow("deadline");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.runAgent({
        side: "source",
        prompt: "unused",
        sandbox: f.sandbox,
        deadlineAt: Date.now() + 10_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spy).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform === "darwin")(
  "fails closed on platforms without the supported native boundary",
  async () => {
    const f = fixture();
    await expect(run(f.sandbox, "echo", ["must-not-execute"])).rejects.toThrow(
      "unsupported",
    );
  },
);
