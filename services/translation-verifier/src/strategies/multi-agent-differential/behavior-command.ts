import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  resolve,
  relative,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  runManagedProcess,
  sanitizedBuildEnvironment,
} from "../smoke-differential/manage-test-process.js";
import {
  assertProjectBaseline,
  hashContent,
  inside,
  readTestFile,
  captureProjectBaseline,
  isProjectTestPath,
  type BehaviorProjectBaseline,
} from "./behavior-workspace.js";
import type {
  BehaviorCommand,
  BehaviorExecutionScope,
  BehaviorProcessResult,
  BehaviorSide,
} from "./behavior-types.js";

export const BEHAVIOR_COMMAND_ENTRY = fileURLToPath(
  new URL("./behavior-command.ts", import.meta.url),
);
export const BEHAVIOR_CONTROL_ENV = "FOREXPLORE_BEHAVIOR_CONTROL";

/** Command control and post-execution integrity checks, NOT OS isolation.
 * General-purpose runtimes and project build scripts can access the host.
 */
const ALLOWED_TOOLS = new Set([
  "java",
  "javac",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "dotnet",
  "node",
  "npm",
  "npx",
  "pnpm",
  "tsx",
  "tsc",
  "python",
  "python3",
  "go",
  "cargo",
  "rustc",
]);
const WRAPPERS = new Set(["mvnw", "gradlew"]);

export interface BehaviorCommandControl {
  scope: BehaviorExecutionScope;
  baselines: BehaviorProjectBaseline[];
  /** Canonical mutable project roots selected by the Host, never command argv. */
  experimentRoots?: string[];
  frozenFiles: Record<string, string>;
  deadlineAt: number;
  env: NodeJS.ProcessEnv;
  secrets: string[];
  evidencePath?: string;
  processRegistryPath?: string;
  side?: BehaviorSide;
  /** A Host-only frozen snapshot is shared by all project controls. */
  expectation?: { file: string; snapshot: string; targetRoot: string };
}
export interface BehaviorSessionControl {
  projects: Partial<Record<BehaviorSide, BehaviorCommandControl>>;
  executionSides: BehaviorSide[];
}

export function buildEnvironment(): NodeJS.ProcessEnv {
  const env = sanitizedBuildEnvironment();
  for (const name of Object.keys(env))
    if (/^CLAUDE_|^FOREXPLORE_BEHAVIOR_/.test(name)) delete env[name];
  return env;
}

export function protectedSecrets(apiKey?: string): string[] {
  const clean = sanitizedBuildEnvironment();
  return [
    ...new Set([
      ...(apiKey ? [apiKey] : []),
      ...Object.entries(process.env)
        .filter(
          ([name, value]) =>
            value && value.length >= 8 && clean[name] === undefined,
        )
        .map(([, value]) => value!),
    ]),
  ].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets)
    text = text
      .split(secret)
      .join("[REDACTED]")
      .split(JSON.stringify(secret).slice(1, -1))
      .join("[REDACTED]");
  return text;
}

export function validateScope(
  scope: BehaviorExecutionScope,
): BehaviorExecutionScope {
  if (scope.projectAccess !== undefined && scope.projectAccess !== "experiment")
    throw new Error("Invalid Host project access.");
  const directory = (path: string): string => {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Execution paths must be absolute literal paths.");
    const canonical = realpathSync(path);
    if (
      !statSync(canonical).isDirectory() ||
      resolve(canonical, "..") === canonical
    )
      throw new Error("Execution roots must be existing non-root directories.");
    return canonical;
  };
  const cwd = directory(scope.cwd);
  const readRoots = [...new Set(scope.readRoots.map(directory))];
  const writeRoots = [...new Set(scope.writeRoots.map(directory))];
  if (
    !readRoots.some((root) => inside(root, cwd)) ||
    !writeRoots.length ||
    writeRoots.some((root) => !inside(cwd, root))
  )
    throw new Error(
      "Execution scope requires readable cwd and project-contained write roots.",
    );
  const readOnlyFiles = [...new Set(scope.readOnlyFiles ?? [])];
  for (const file of readOnlyFiles) {
    if (
      !isAbsolute(file) ||
      realpathSync(file) !== file ||
      !readRoots.some((root) => inside(root, file))
    )
      throw new Error("Frozen files must be canonical project files.");
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new Error("Frozen files must be single-link regular files.");
  }
  if (scope.baseline && realpathSync(scope.baseline.root) !== cwd)
    throw new Error("Host baseline must belong to command cwd.");
  return {
    cwd,
    readRoots,
    writeRoots,
    readOnlyFiles,
    ...(scope.projectAccess ? { projectAccess: scope.projectAccess } : {}),
    ...(scope.baseline ? { baseline: scope.baseline } : {}),
  };
}

export function captureFrozenFiles(
  scope: BehaviorExecutionScope,
): Record<string, string> {
  return Object.fromEntries(
    (scope.readOnlyFiles ?? []).map((file) => [
      file,
      hashContent(readFileSync(file)),
    ]),
  );
}

export function assertCommandIntegrity(control: BehaviorCommandControl): void {
  if (control.expectation && existsSync(control.expectation.snapshot)) {
    const { file, snapshot, targetRoot } = control.expectation;
    if (
      readTestFile(targetRoot, relative(targetRoot, file)) !==
      readFileSync(snapshot, "utf8")
    )
      throw new Error("Frozen test plan integrity violation.");
  }
  for (const baseline of control.baselines) {
    if (realpathSync(baseline.root) !== baseline.root)
      throw new Error("Project baseline root changed.");
    if (control.experimentRoots?.includes(baseline.root))
      captureProjectBaseline(baseline.root);
    else assertProjectBaseline(baseline);
  }
  for (const [file, hash] of Object.entries(control.frozenFiles)) {
    const metadata = lstatSync(file);
    if (
      realpathSync(file) !== file ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      hashContent(readFileSync(file)) !== hash
    )
      throw new Error(`Frozen file integrity violation: ${file}`);
  }
}

export function findInstalledExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    // Relative PATH entries could resolve to agent-authored project executables.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      /* Try the next installed tool directory. */
    }
  }
  return undefined;
}

export function resolveBehaviorCommand(
  command: BehaviorCommand,
  control: BehaviorCommandControl,
): string {
  if (
    !command ||
    typeof command.executable !== "string" ||
    !command.executable ||
    command.executable.includes("\0") ||
    !Array.isArray(command.args) ||
    command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("Invalid behavior command arguments.");
  const name = basename(command.executable);
  if (!ALLOWED_TOOLS.has(name))
    throw new Error(`Command not allowed: ${command.executable}`);
  if (WRAPPERS.has(name)) {
    const wrapper = realpathSync(
      resolve(control.scope.cwd, command.executable),
    );
    if (!inside(control.scope.cwd, wrapper) || !statSync(wrapper).isFile())
      throw new Error("Command wrapper must be inside the project.");
    accessSync(wrapper, constants.X_OK);
    return wrapper;
  }
  const installed = findInstalledExecutable(name, control.env);
  if (!installed) throw new Error(`Allowlisted tool is unavailable: ${name}`);
  if (
    command.executable !== name &&
    realpathSync(resolve(control.scope.cwd, command.executable)) !== installed
  )
    throw new Error(`Command is not the installed tool: ${command.executable}`);
  return installed;
}

function appendCommandEvidence(
  control: BehaviorCommandControl,
  record: unknown,
): void {
  if (!control.evidencePath) return;
  const line = `${JSON.stringify(record)}\n`;
  const size = existsSync(control.evidencePath)
    ? statSync(control.evidencePath).size
    : 0;
  if (size + Buffer.byteLength(line) > 8 * 1024 * 1024)
    throw new Error("Host command evidence exceeds session budget.");
  appendFileSync(control.evidencePath, line, { mode: 0o600 });
}

function captureCommandTests(
  control: BehaviorCommandControl,
): Record<string, string> {
  const root = control.scope.cwd;
  const original = control.baselines.find(
    (baseline) => baseline.root === root,
  )!;
  const paths = Object.keys(captureProjectBaseline(root).files).filter(
    (path) => !Object.hasOwn(original.files, path) && isProjectTestPath(path),
  );
  const walk = (directory: string): void => {
    if (!existsSync(join(root, directory))) return;
    if (lstatSync(join(root, directory)).isSymbolicLink())
      throw new Error("Linked generated test directory is not allowed.");
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk(".forexplore-tests");
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const path of paths) {
    const content = readTestFile(root, path);
    bytes += Buffer.byteLength(content);
    if (bytes > 4 * 1024 * 1024 || Object.keys(files).length >= 200)
      throw new Error("Generated test evidence exceeds budget.");
    if (redact(content, control.secrets) !== content)
      throw new Error("Test evidence contains protected credential material.");
    files[path] = content;
  }
  return files;
}

export async function runBehaviorCommand(
  command: BehaviorCommand,
  control: BehaviorCommandControl,
  signal?: AbortSignal,
): Promise<BehaviorProcessResult & { commandId: string }> {
  signal?.throwIfAborted();
  if (!Number.isFinite(control.deadlineAt) || control.deadlineAt <= Date.now())
    throw new Error("Behavior execution deadline has expired.");
  const scope = validateScope(control.scope);
  if (scope.cwd !== control.scope.cwd) throw new Error("Command cwd changed.");
  assertCommandIntegrity(control);
  const executable = resolveBehaviorCommand(command, control);
  const testFiles = control.side ? captureCommandTests(control) : undefined;
  const commandId = randomUUID();
  const startedAt = Date.now();
  const commandRecord = {
    commandId,
    ...(control.side ? { side: control.side, testFiles } : {}),
    command: {
      executable: command.executable,
      args: command.args.map((arg) => redact(arg, control.secrets)),
    },
    cwd: scope.cwd,
  };
  if (control.side)
    appendCommandEvidence(control, {
      ...commandRecord,
      completed: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "Command started; completion has not been recorded.",
      baselineValid: true,
      credentialHit: false,
    });
  let result: BehaviorProcessResult;
  let processError: unknown;
  let childPid: number | undefined;
  try {
    result = await runManagedProcess(
      {
        command: executable,
        args: command.args,
        cwd: scope.cwd,
        env: sanitizedBuildEnvironment(control.env),
        deadlineAt: control.deadlineAt,
        cleanupGraceMs: 250,
        onSpawn: (pid) => {
          childPid = pid;
          if (control.processRegistryPath)
            appendFileSync(
              control.processRegistryPath,
              `${JSON.stringify({ pid, active: true })}\n`,
              { mode: 0o600 },
            );
        },
      },
      signal,
    );
  } catch (error) {
    processError = error;
    result = {
      exitCode: null,
      timedOut: Date.now() >= control.deadlineAt,
      durationMs: Date.now() - startedAt,
      stdout: "",
      stderr: redact(
        error instanceof Error ? error.message : String(error),
        control.secrets,
      ),
    };
  } finally {
    if (childPid) await stopCommandProcessGroup(childPid);
    if (childPid && control.processRegistryPath)
      appendFileSync(
        control.processRegistryPath,
        `${JSON.stringify({ pid: childPid, active: false })}\n`,
      );
  }
  let integrityError: unknown;
  try {
    assertCommandIntegrity(control);
  } catch (error) {
    integrityError = error;
  }
  const stdout = redact(result.stdout, control.secrets);
  const credentialHit = stdout !== result.stdout;
  const safeResult = {
    ...result,
    stdout,
    stderr: redact(result.stderr, control.secrets),
  };
  appendCommandEvidence(control, {
    ...commandRecord,
    ...safeResult,
    completed: true,
    baselineValid: !integrityError,
    credentialHit,
  });
  if (integrityError) throw integrityError;
  if (processError) throw processError;
  if (credentialHit)
    throw new Error(
      "Command output contains protected credential material; comparison refused.",
    );
  return { ...result, commandId, stderr: safeResult.stderr };
}

/** Called only after the Agent process group has stopped, before evidence or cleanup. */
export async function stopRegisteredCommands(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const active = new Set<number>();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    let record: { pid: number; active: boolean };
    try {
      record = JSON.parse(line) as typeof record;
    } catch (cause) {
      throw new Error("Invalid Host process registry.", { cause });
    }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 1)
      throw new Error("Invalid Host process registry.");
    if (record.active) active.add(record.pid);
    else active.delete(record.pid);
  }
  for (const pid of active) await stopCommandProcessGroup(pid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopCommandProcessGroup(pid: number): Promise<void> {
  if (process.platform === "win32") {
    if (!processExists(pid)) return;
    await new Promise<void>((resolvePromise, reject) =>
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (error) => {
        try {
          if (error && processExists(pid)) reject(error);
          else resolvePromise();
        } catch (cause) {
          reject(cause);
        }
      }),
    );
  } else {
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        process.kill(-pid, "SIGKILL");
        if (!processExists(-pid)) return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return;
        if (code !== "EPERM") throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("Command process cleanup could not be confirmed.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

/** Only the command is agent-selected. Scope, environment, baseline and deadline
 * come from a Host-created control file, never CLI flags or model output.
 */
export async function runBehaviorCommandCli(
  argv: string[],
  env = process.env,
  signal?: AbortSignal,
): Promise<number> {
  const controlPath = env[BEHAVIOR_CONTROL_ENV];
  if (!controlPath || !isAbsolute(controlPath))
    throw new Error("Missing Host command control.");
  let loaded: BehaviorCommandControl | BehaviorSessionControl;
  try {
    loaded = JSON.parse(readFileSync(controlPath, "utf8")) as
      BehaviorCommandControl | BehaviorSessionControl;
  } catch {
    throw new Error("Invalid Host command control.");
  }
  let control: BehaviorCommandControl;
  if ("projects" in loaded) {
    const side = argv[1] as BehaviorSide;
    if (
      argv[0] !== "--project" ||
      !["source", "target"].includes(side) ||
      !loaded.executionSides.includes(side) ||
      !loaded.projects[side]
    )
      throw new Error(
        "A Host-authorized --project source|target selector is required.",
      );
    control = loaded.projects[side]!;
    argv = argv.slice(2);
    assertCommandIntegrity(control);
    if (side === "target" && control.expectation) {
      const { file, snapshot, targetRoot } = control.expectation;
      const plan = readTestFile(targetRoot, relative(targetRoot, file));
      try {
        writeFileSync(snapshot, plan, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      assertCommandIntegrity(control);
    }
  } else control = loaded;
  if (argv[0] !== "--" || argv.length < 2)
    throw new Error("Expected -- <tool> <args...>.");
  const result = await runBehaviorCommand(
    { executable: argv[1]!, args: argv.slice(2) },
    control,
    signal,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (control.side)
    process.stderr.write(`\nFOREXPLORE_COMMAND_ID=${result.commandId}\n`);
  return result.timedOut ? 1 : (result.exitCode ?? 1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      new DOMException("Command proxy terminated", "AbortError"),
    );
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  runBehaviorCommandCli(process.argv.slice(2), process.env, controller.signal)
    .finally(() => {
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGINT", abort);
    })
    .then(
      (code) => {
        process.exitCode = code;
      },
      () => {
        process.stderr.write(
          "Behavior command rejected or failed; Host command evidence must be checked.\n",
        );
        process.exitCode = 1;
      },
    );
}
