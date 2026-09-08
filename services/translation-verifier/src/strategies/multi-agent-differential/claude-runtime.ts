import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { runManagedProcess } from "../smoke-differential/manage-test-process.js";
import type {
  BehaviorProcessResult,
  BehaviorRuntime,
  BehaviorSandbox,
} from "./behavior-types.js";

const SYSTEM_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/System/Library",
  "/Library/Apple/System/Library",
  "/usr/share/locale",
];
const SYSTEM_READ_FILES = [
  "/",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/private/etc/localtime",
  "/private/etc/bashrc",
  "/private/etc/profile",
];
const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep);

async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || /[\x00-\x1f*?[\]{}!]/.test(path))
    throw new Error("Sandbox paths must be absolute literal paths.");
  const canonical = await realpath(path);
  if (/[\x00-\x1f*?[\]{}!]/.test(canonical))
    throw new Error("Canonical sandbox paths must be literal paths.");
  if (!(await stat(canonical)).isDirectory() || canonical === "/")
    throw new Error("Sandbox roots must be existing non-root directories.");
  return canonical;
}

async function validateSandbox(
  sandbox: BehaviorSandbox,
): Promise<BehaviorSandbox> {
  const cwd = await canonicalDirectory(sandbox.cwd);
  const readRoots = [
    ...new Set(await Promise.all(sandbox.readRoots.map(canonicalDirectory))),
  ];
  const writeRoots = [
    ...new Set(await Promise.all(sandbox.writeRoots.map(canonicalDirectory))),
  ];
  if (!readRoots.some((root) => within(root, cwd)) || writeRoots.length === 0)
    throw new Error(
      "Sandbox requires readable cwd and a dedicated test write root.",
    );
  for (const root of writeRoots) {
    if (
      !root.split(sep).includes(".forexplore-tests") ||
      within(root, cwd) ||
      readRoots.some((read) => within(root, read))
    ) {
      throw new Error(
        "Sandbox writes must be confined to dedicated .forexplore-tests directories, never project roots.",
      );
    }
  }
  const readOnlyFiles = await Promise.all(
    (sandbox.readOnlyFiles ?? []).map(async (path) => {
      if (!isAbsolute(path) || /[\x00-\x1f*?[\]{}!]/.test(path))
        throw new Error("Read-only files must be absolute literal paths.");
      const canonical = await realpath(path);
      const metadata = await lstat(path);
      if (
        canonical !== path ||
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        !writeRoots.some((root) => within(root, canonical))
      ) {
        throw new Error(
          "Read-only files must be canonical single-link regular files inside test write roots.",
        );
      }
      return canonical;
    }),
  );
  return {
    cwd,
    readRoots,
    writeRoots,
    readOnlyFiles: [...new Set(readOnlyFiles)],
  };
}

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function toolchains(): Promise<{
  paths: string[];
  readRoots: string[];
  readFiles: string[];
  javaHome?: string;
}> {
  const node = await realpath(process.execPath);
  const paths = [dirname(node)];
  const readRoots: string[] = [];
  const readFiles = [node];
  const formulas = new Set<string>();
  let javaHome: string | undefined;
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    const python = await executable(join(prefix, "bin/python3"));
    if (python) {
      const match = python.match(/^(.*\/Cellar\/python@[^/]+\/[^/]+)\//);
      if (match) {
        paths.push(dirname(python));
        readRoots.push(join(match[1]!, "Frameworks"));
        formulas.add(match[1]!);
      }
    }
    const java = await executable(
      join(prefix, "opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java"),
    );
    if (java && !javaHome) {
      javaHome = dirname(dirname(java));
      paths.push(join(javaHome, "bin"));
      readRoots.push(javaHome);
      const formula = java.match(/^(.*\/Cellar\/openjdk\/[^/]+)\//)?.[1];
      if (formula) formulas.add(formula);
    }
  }
  // Homebrew's receipt lists transitive runtime dependencies. Grant only each
  // versioned library directory, never the Homebrew prefix or a user's home.
  for (const formula of formulas) {
    let receipt: {
      runtime_dependencies?: { full_name: string; pkg_version: string }[];
    };
    try {
      receipt = JSON.parse(
        await readFile(join(formula, "INSTALL_RECEIPT.json"), "utf8"),
      );
      if (!receipt || !Array.isArray(receipt.runtime_dependencies))
        throw new Error("Missing dependency list.");
    } catch (cause) {
      throw new Error("Cannot read trusted toolchain receipt.", { cause });
    }
    const cellar = dirname(dirname(formula));
    for (const dependency of receipt.runtime_dependencies ?? []) {
      if (
        !/^[a-zA-Z0-9@+_.-]+$/.test(dependency.full_name) ||
        !/^[a-zA-Z0-9+_.-]+$/.test(dependency.pkg_version)
      )
        throw new Error("Invalid toolchain receipt dependency.");
      const library = join(dirname(cellar), "opt", dependency.full_name, "lib");
      let canonical: string;
      try {
        canonical = await realpath(library);
      } catch {
        continue;
      }
      if (!within(join(cellar, dependency.full_name), canonical))
        throw new Error("Toolchain library escapes its installed formula.");
      readRoots.push(canonical);
    }
  }
  paths.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return { paths, readRoots: [...new Set(readRoots)], readFiles, javaHome };
}

async function protectedProjectEntries(
  sandbox: BehaviorSandbox,
): Promise<string[]> {
  const denied: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (sandbox.writeRoots.includes(directory)) return;
    if (!sandbox.writeRoots.some((root) => within(directory, root))) {
      denied.push(directory);
      return;
    }
    for (const name of await readdir(directory)) {
      const child = join(directory, name);
      if (/[\x00-\x1f*?[\]{}!]/.test(name))
        throw new Error(
          "Cannot safely express a project filename in native sandbox deny rules.",
        );
      if (sandbox.writeRoots.some((root) => within(child, root)))
        await walk(child);
      else denied.push(child);
    }
  };
  for (const root of sandbox.readRoots) await walk(root);
  return [...new Set(denied)];
}

function redactResult(
  result: BehaviorProcessResult,
  secret: string | undefined,
): BehaviorProcessResult {
  const secrets = [
    ...new Set([
      ...(secret ? [secret] : []),
      ...Object.entries(process.env)
        .filter(
          ([name, value]) =>
            /API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) &&
            value &&
            value.length >= 8,
        )
        .map(([, value]) => value!),
    ]),
  ].sort((a, b) => b.length - a.length);
  const redact = (text: string): string => {
    for (const value of secrets)
      text = text
        .split(value)
        .join("[REDACTED]")
        .split(JSON.stringify(value).slice(1, -1))
        .join("[REDACTED]");
    return text;
  };
  return {
    ...result,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

function environment(
  sandbox: BehaviorSandbox,
  tools: Awaited<ReturnType<typeof toolchains>>,
): NodeJS.ProcessEnv {
  const home = sandbox.writeRoots[0]!;
  return {
    PATH: tools.paths.join(":"),
    HOME: home,
    TMPDIR: home,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: join(home, "python-cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_cache: home,
    XDG_CACHE_HOME: home,
    ...(tools.javaHome ? { JAVA_HOME: tools.javaHome } : {}),
  };
}

function profile(
  sandbox: BehaviorSandbox,
  tools: Awaited<ReturnType<typeof toolchains>>,
): string {
  const subpaths = [
    ...SYSTEM_READ_ROOTS,
    ...tools.readRoots,
    ...sandbox.readRoots,
    ...sandbox.writeRoots,
  ];
  // A path-based file deny is bypassable by moving an ancestor directory.
  const frozenDirectories = new Set<string>();
  for (const file of sandbox.readOnlyFiles ?? []) {
    for (
      let path = dirname(file);
      sandbox.writeRoots.some((root) => within(root, path));
      path = dirname(path)
    )
      frozenDirectories.add(path);
  }
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.") (sysctl-name "kern.argmax") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.ostype") (sysctl-name "kern.osproductversion") (sysctl-name "kern.version") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.tcsm_available") (sysctl-name "kern.tcsm_enable") (sysctl-name "kern.usrstack64") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg"))',
    '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
    // Metadata is deliberately visible; Seatbelt is not a separate filesystem namespace.
    "(allow file-read-metadata)",
    `(allow file-read* ${subpaths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")} ${[...SYSTEM_READ_FILES, ...tools.readFiles].map((path) => `(literal ${JSON.stringify(path)})`).join(" ")})`,
    `(allow file-write* ${sandbox.writeRoots.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
    ...(sandbox.readOnlyFiles ?? []).map(
      (path) => `(deny file-write* (literal ${JSON.stringify(path)}))`,
    ),
    ...[...frozenDirectories].map(
      (path) => `(deny file-write-unlink (literal ${JSON.stringify(path)}))`,
    ),
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
  ].join("\n");
}

async function requirePlatform(): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error(
      "Behavior sandbox is unsupported on this platform; no unsandboxed fallback is permitted.",
    );
  await access("/usr/bin/sandbox-exec", constants.X_OK);
}

async function absentDirectory(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
}

/** Remove only empty runtime-created bookkeeping, never existing/user contents. */
async function removeEmptyBookkeeping(paths: string[]): Promise<void> {
  for (const path of paths.reverse()) {
    try {
      if ((await realpath(path)) === path) await rmdir(path);
    } catch {
      /* Nonempty, missing or linked entries remain subject to Host integrity checks. */
    }
  }
}

/** Only Bash runs in Claude's native sandbox. Host commands independently use Seatbelt. */
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
  const deadline = (value: number): number => {
    if (!Number.isFinite(value) || value <= Date.now())
      throw new Error("Behavior execution deadline has expired.");
    return Math.min(value, Date.now() + timeoutMs);
  };
  return {
    async runCommand(task) {
      task.signal?.throwIfAborted();
      const deadlineAt = deadline(task.deadlineAt);
      await requirePlatform();
      const sandbox = await validateSandbox(task.sandbox);
      const tools = await toolchains();
      if (
        !task.command.executable ||
        task.command.executable.includes("\0") ||
        task.command.args.some((arg) => arg.includes("\0"))
      )
        throw new Error("Invalid behavior command.");
      const result = await runManagedProcess(
        {
          command: "/usr/bin/sandbox-exec",
          args: [
            "-p",
            profile(sandbox, tools),
            "--",
            task.command.executable,
            ...task.command.args,
          ],
          cwd: sandbox.cwd,
          env: environment(sandbox, tools),
          deadlineAt,
        },
        task.signal,
      );
      const redacted = redactResult(
        result,
        options.apiKey ?? process.env.DEEPSEEK_API_KEY,
      );
      if (redacted.stdout !== result.stdout)
        throw new Error(
          "Command output contains protected credential material; comparison refused.",
        );
      return { ...result, stderr: redacted.stderr };
    },
    async runAgent(task) {
      task.signal?.throwIfAborted();
      const deadlineAt = deadline(task.deadlineAt);
      await requirePlatform();
      const sandbox = await validateSandbox(task.sandbox);
      const protectedEntries = await protectedProjectEntries(sandbox);
      const createdBookkeeping: string[] = [];
      for (const root of sandbox.readRoots) {
        for (const path of [
          join(root, ".claude"),
          join(root, ".claude", ".cc-writes"),
        ]) {
          if (await absentDirectory(path)) createdBookkeeping.push(path);
        }
      }
      // Claude always grants cwd writes. Existing non-test entries are denied
      // recursively; new siblings remain possible and MUST fail Host projectHash.
      // These are caller-owned COW projects, never original workspaces.
      const tools = await toolchains();
      const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
      if (!apiKey?.trim())
        throw new Error("DEEPSEEK_API_KEY is required for behavior agents.");
      const model =
        options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
      const control = await mkdtemp(
        join(tmpdir(), "forexplore-behavior-agent-"),
      );
      let scratch: string | undefined;
      try {
        // Long TMPDIR paths make Claude fall back to shared /tmp/claude-UID for
        // sockets and cwd bookkeeping. This private short root avoids that fallback.
        scratch = await mkdtemp("/private/tmp/fx-");
        const settings = {
          disableAllHooks: true,
          autoMemoryEnabled: false,
          enabledPlugins: {},
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            excludedCommands: [],
            allowAppleEvents: false,
            enableWeakerNestedSandbox: false,
            enableWeakerNetworkIsolation: false,
            filesystem: {
              disabled: false,
              denyRead: ["/"],
              allowRead: [
                ...SYSTEM_READ_ROOTS,
                ...SYSTEM_READ_FILES.filter((path) => path !== "/"),
                ...tools.readRoots,
                ...tools.readFiles,
                ...sandbox.readRoots,
                ...sandbox.writeRoots,
                scratch,
              ],
              allowWrite: [...sandbox.writeRoots, scratch],
              denyWrite: [
                ...protectedEntries,
                ...(sandbox.readOnlyFiles ?? []),
                control,
                "/tmp/claude*",
                "/private/tmp/claude*",
              ],
            },
            network: {
              allowedDomains: [],
              deniedDomains: ["*"],
              strictAllowlist: true,
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
            credentials: {
              envVars: [{ name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" }],
            },
          },
        };
        const env = {
          ...environment(sandbox, tools),
          HOME: control,
          CLAUDE_CONFIG_DIR: control,
          CLAUDE_CODE_TMPDIR: scratch,
          CLAUDE_CODE_SHELL: "/bin/bash",
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_MODEL: model,
        };
        const claude =
          (await executable("/opt/homebrew/bin/claude")) ??
          (await executable("/usr/local/bin/claude")) ??
          (await executable(join(dirname(process.execPath), "claude")));
        if (!claude)
          throw new Error(
            "Claude CLI is unavailable; no fallback is permitted.",
          );
        const versionResult = await runManagedProcess(
          {
            command: claude,
            args: ["--version"],
            cwd: control,
            env,
            deadlineAt,
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
        ) {
          throw new Error(
            "Claude CLI >= 2.1.236 is required for the verified native sandbox settings; refusing fallback.",
          );
        }
        const promptFile = join(control, "prompt.txt");
        await writeFile(promptFile, task.prompt, { flag: "wx", mode: 0o600 });
        // --bare only accepts ANTHROPIC_API_KEY, not this provider's AUTH_TOKEN.
        let partialOutput = "";
        let pendingLine = "";
        const decoder = new StringDecoder("utf8");
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
              JSON.stringify(settings),
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--disable-slash-commands",
              "--no-chrome",
              "--tools",
              "Bash",
              "--allowedTools",
              "Bash",
              "--permission-mode",
              "dontAsk",
              "--no-session-persistence",
              "--system-prompt",
              `You are the independent ${task.side} behavior-test agent. Inspect the supplied project, write tests only in the supplied test directory, and return the requested manifest. Readable project roots: ${JSON.stringify(sandbox.readRoots)}. Test write roots: ${JSON.stringify(sandbox.writeRoots)}.`,
              "--model",
              model,
              "--max-turns",
              String(maxTurns),
              ...(options.effort ? ["--effort", options.effort] : []),
            ],
            cwd: sandbox.cwd,
            env,
            deadlineAt,
            onStdoutChunk: (chunk) => {
              const lines = (pendingLine + decoder.write(chunk)).split("\n");
              pendingLine = lines.pop()!.slice(0, 1024 * 1024);
              for (const line of lines) {
                try {
                  const event = JSON.parse(line) as {
                    type?: string;
                    subtype?: string;
                  };
                  if (
                    event.type === "stream_event" ||
                    event.subtype === "thinking_tokens"
                  )
                    continue;
                } catch {
                  continue;
                }
                partialOutput = (partialOutput + line + "\n").slice(
                  0,
                  1024 * 1024,
                );
              }
              task.onOutput?.(
                redactResult(
                  {
                    stdout: partialOutput,
                    stderr: "",
                    exitCode: null,
                    timedOut: false,
                    durationMs: 0,
                  },
                  apiKey,
                ).stdout,
              );
            },
          },
          task.signal,
        );
        return redactResult({ ...result, stdout: partialOutput }, apiKey);
      } finally {
        await removeEmptyBookkeeping(createdBookkeeping);
        await Promise.all([
          rm(control, { recursive: true, force: true }),
          ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
        ]);
      }
    },
  };
}
