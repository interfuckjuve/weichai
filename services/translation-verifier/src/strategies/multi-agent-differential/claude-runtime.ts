import {
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
  mkdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedProcess } from "../smoke-differential/manage-test-process.js";
import {
  captureProjectBaseline,
  type BehaviorProjectBaseline,
} from "./behavior-workspace.js";
import {
  BEHAVIOR_COMMAND_ENTRY,
  BEHAVIOR_CONTROL_ENV,
  assertCommandIntegrity,
  buildEnvironment,
  captureFrozenFiles,
  findInstalledExecutable,
  protectedSecrets,
  redact,
  runBehaviorCommand,
  validateScope,
  type BehaviorCommandControl,
} from "./behavior-command.js";
import type {
  BehaviorRuntime,
  BehaviorExecutionScope,
} from "./behavior-types.js";

/** Scope and hash checks are workflow controls, not OS isolation. Maven/.NET
 * restores and general-purpose runtimes intentionally retain host access.
 */
export function createBehaviorRuntime(
  options: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    maxTurns?: number;
    effort?: string;
  } = {},
): BehaviorRuntime {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxTurns = options.maxTurns ?? 50;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isInteger(maxTurns) ||
    maxTurns <= 0
  )
    throw new Error("Invalid behavior runtime limits.");
  if (
    options.effort &&
    !["low", "medium", "high", "xhigh", "max"].includes(options.effort)
  )
    throw new Error("Invalid Claude effort.");
  const baselines = new Map<string, BehaviorProjectBaseline>();
  const controlFor = (
    scope: BehaviorExecutionScope,
    deadlineAt: number,
  ): BehaviorCommandControl => {
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())
      throw new Error("Behavior execution deadline has expired.");
    const validated = validateScope(scope);
    let baseline = validated.baseline ?? baselines.get(validated.cwd);
    if (!baseline) {
      baseline = captureProjectBaseline(validated.cwd);
      baselines.set(validated.cwd, baseline);
    }
    const control: BehaviorCommandControl = {
      scope: validated,
      baselines: [baseline],
      frozenFiles: captureFrozenFiles(validated),
      deadlineAt: Math.min(deadlineAt, Date.now() + timeoutMs),
      env: buildEnvironment(),
      secrets: protectedSecrets(options.apiKey ?? process.env.DEEPSEEK_API_KEY),
    };
    assertCommandIntegrity(control);
    return control;
  };
  return {
    async runCommand(task) {
      task.signal?.throwIfAborted();
      const control = controlFor(task.sandbox, task.deadlineAt);
      // Replay also freezes already-authored helpers, not just original project files.
      control.baselines.push(captureProjectBaseline(control.scope.cwd));
      return runBehaviorCommand(task.command, control, task.signal);
    },
    async runAgent(task) {
      task.signal?.throwIfAborted();
      const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
      if (!apiKey?.trim())
        throw new Error("DEEPSEEK_API_KEY is required for behavior agents.");
      const control = controlFor(task.sandbox, task.deadlineAt);
      const model =
        options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
      const claude = findInstalledExecutable("claude", control.env);
      if (!claude)
        throw new Error("Claude CLI is unavailable; no fallback is permitted.");
      const directory = await mkdtemp(
        join(tmpdir(), "forexplore-behavior-agent-"),
      );
      const bookkeeping: string[] = [];
      try {
        for (const path of [
          join(control.scope.cwd, ".claude"),
          join(control.scope.cwd, ".claude", ".cc-writes"),
        ]) {
          try {
            await lstat(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            bookkeeping.push(path);
          }
        }
        const controlPath = join(directory, "control.json");
        control.evidencePath = join(directory, "commands.jsonl");
        await writeFile(controlPath, JSON.stringify(control), {
          flag: "wx",
          mode: 0o600,
        });
        const env = {
          ...control.env,
          [BEHAVIOR_CONTROL_ENV]: controlPath,
          CLAUDE_CONFIG_DIR: directory,
          CLAUDE_CODE_TMPDIR: directory,
          CLAUDE_CODE_SHELL: "/bin/bash",
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_MODEL: model,
        };
        const versionResult = await runManagedProcess(
          {
            command: claude,
            args: ["--version"],
            cwd: directory,
            env,
            deadlineAt: control.deadlineAt,
          },
          task.signal,
        );
        const version = /^(\d+)\.(\d+)\.(\d+)/.exec(
          versionResult.stdout.trim(),
        );
        if (
          versionResult.exitCode !== 0 ||
          versionResult.timedOut ||
          !version ||
          Number(version[1]) < 2 ||
          (Number(version[1]) === 2 &&
            (Number(version[2]) < 1 ||
              (Number(version[2]) === 1 && Number(version[3]) < 236)))
        )
          throw new Error(
            "Claude CLI >= 2.1.236 is required for verified safe-mode and command permissions; refusing fallback.",
          );
        const promptFile = join(directory, "prompt.txt");
        await writeFile(promptFile, task.prompt, { flag: "wx", mode: 0o600 });
        const proxy = `npx tsx ${BEHAVIOR_COMMAND_ENTRY}`;
        const protectedPaths = [
          ...Object.keys(control.baselines[0]!.files).map((path) =>
            join(control.scope.cwd, path),
          ),
          ...Object.keys(control.frozenFiles),
          ...control.scope.readRoots
            .filter((root) => root !== control.scope.cwd)
            .map((root) => `${root}/**`),
          `${directory}/**`,
        ];
        const settings = {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          enabledPlugins: {},
          sandbox: { enabled: false },
          permissions: {
            deny: [
              ...protectedPaths.flatMap((path) =>
                ["Edit", "Write"].map(
                  (tool) => `${tool}(//${path.replace(/^\/+/, "")})`,
                ),
              ),
              `Read(//${directory.replace(/^\/+/, "")}/**)`,
            ],
          },
        };
        const settingsPath = join(directory, "settings.json");
        await writeFile(settingsPath, JSON.stringify(settings), {
          flag: "wx",
          mode: 0o600,
        });
        let output = "";
        let pending = "";
        let droppingLine = false;
        const decoder = new StringDecoder("utf8");
        const emitLine = (line: string): void => {
          try {
            const event = JSON.parse(line) as {
              type?: string;
              subtype?: string;
            };
            if (
              event.type === "stream_event" ||
              event.subtype === "thinking_tokens"
            )
              return;
          } catch {
            return;
          }
          output = (output + redact(line, control.secrets) + "\n").slice(
            0,
            1024 * 1024,
          );
        };
        const consume = (text: string): void => {
          const lines = text.split("\n");
          for (let index = 0; index < lines.length; index++) {
            const piece = lines[index]!;
            if (!droppingLine && pending.length + piece.length <= 1024 * 1024)
              pending += piece;
            else {
              pending = "";
              droppingLine = true;
            }
            if (index < lines.length - 1) {
              if (!droppingLine) emitLine(pending);
              pending = "";
              droppingLine = false;
            }
          }
          task.onOutput?.(redact(output, control.secrets));
        };
        // The host-only shell redirects stdin without interpolating the prompt.
        // Agent commands never use this shell entry: the proxy spawns argv directly.
        const result = await runManagedProcess(
          {
            command: "/bin/bash",
            args: [
              "-c",
              'input="$1"; shift; exec "$@" < "$input"',
              "behavior-agent",
              promptFile,
              claude,
              "--print",
              "--output-format",
              "stream-json",
              "--verbose",
              "--safe-mode",
              "--setting-sources",
              "",
              "--settings",
              settingsPath,
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--disable-slash-commands",
              "--no-chrome",
              "--tools",
              "Bash,Read,Edit,Write,Glob,Grep",
              "--add-dir",
              ...control.scope.readRoots,
              "--allowedTools",
              `Bash(npx tsx ${BEHAVIOR_COMMAND_ENTRY} *)`,
              "Read",
              "Edit",
              "Write",
              "Glob",
              "Grep",
              "--disallowedTools",
              "TaskCreate",
              "TaskUpdate",
              "Agent",
              "WebFetch",
              "WebSearch",
              "--permission-mode",
              "dontAsk",
              "--no-session-persistence",
              "--system-prompt",
              `You are the independent ${task.side} behavior-test agent. Develop tests in the supplied actual project. Preserve all original baseline-protected implementation and test files, plus the Host-frozen harness inputs. Return the requested manifest.`,
              "--append-system-prompt",
              [
                "HOST EXECUTION CONTEXT (authoritative)",
                `Actual project cwd: ${control.scope.cwd}`,
                `Readable project roots: ${JSON.stringify(control.scope.readRoots)}`,
                `Test/build write scope: ${JSON.stringify(control.scope.writeRoots)}`,
                "Native sandbox is disabled. There is NO OS isolation. Node/Python and build scripts are general-purpose host processes, not a security sandbox.",
                "Use Read/Edit/Write/Glob/Grep for files. All build, test and run commands MUST use the Host-supplied proxy:",
                `  ${proxy} -- <installed-tool-or-project-wrapper> <args...>`,
                "The proxy fixes cwd, environment, deadline and baseline; never change these through environment assignments or shell composition. Command evidence is recorded by the Host separately from your output.",
                "Original baseline files are frozen except regenerable build/cache outputs. Newly authored tests may be repaired unless Host-frozen. New tests belong in standard project test directories or .forexplore-tests. Put other generated metadata in .forexplore-tests.",
              ].join("\n"),
              "--model",
              model,
              "--max-turns",
              String(maxTurns),
              ...(options.effort ? ["--effort", options.effort] : []),
            ],
            cwd: control.scope.cwd,
            env,
            deadlineAt: control.deadlineAt,
            onStdoutChunk: (chunk) => consume(decoder.write(chunk)),
          },
          task.signal,
        );
        consume(decoder.end());
        if (pending && !droppingLine) emitLine(pending);
        return {
          ...result,
          stdout: redact(output, control.secrets),
          stderr: redact(result.stderr, control.secrets),
        };
      } finally {
        try {
          // Claude can create empty .claude/.cc-writes entries even in safe mode.
          // Remove only entries absent before the session, never agent-written content.
          for (const path of bookkeeping.reverse()) {
            try {
              if ((await realpath(path)) === path) await rmdir(path);
            } catch {
              /* Integrity checks handle remaining entries. */
            }
          }
          if (control.evidencePath) {
            let evidence: string | undefined;
            try {
              evidence = await readFile(control.evidencePath, "utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            if (evidence) {
              const tests = join(control.scope.cwd, ".forexplore-tests");
              await mkdir(tests, { recursive: true });
              await writeFile(
                join(tests, `commands-${randomUUID()}.jsonl`),
                redact(evidence, control.secrets),
                { flag: "wx", mode: 0o600 },
              );
            }
          }
          assertCommandIntegrity(control);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
