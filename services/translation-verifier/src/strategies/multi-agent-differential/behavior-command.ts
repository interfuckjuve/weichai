import { randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runManagedProcess,
  sanitizedBuildEnvironment,
} from "../smoke-differential/manage-test-process.js";
import {
  assertProjectBaseline,
  hashContent,
  inside,
  type BehaviorProjectBaseline,
} from "./behavior-workspace.js";
import type {
  BehaviorCommand,
  BehaviorExecutionScope,
  BehaviorProcessResult,
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
  frozenFiles: Record<string, string>;
  deadlineAt: number;
  env: NodeJS.ProcessEnv;
  secrets: string[];
  evidencePath?: string;
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
  for (const baseline of control.baselines) assertProjectBaseline(baseline);
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

export async function runBehaviorCommand(
  command: BehaviorCommand,
  control: BehaviorCommandControl,
  signal?: AbortSignal,
): Promise<BehaviorProcessResult> {
  signal?.throwIfAborted();
  if (!Number.isFinite(control.deadlineAt) || control.deadlineAt <= Date.now())
    throw new Error("Behavior execution deadline has expired.");
  const scope = validateScope(control.scope);
  if (scope.cwd !== control.scope.cwd) throw new Error("Command cwd changed.");
  assertCommandIntegrity(control);
  const executable = resolveBehaviorCommand(command, control);
  let result: BehaviorProcessResult;
  try {
    result = await runManagedProcess(
      {
        command: executable,
        args: command.args,
        cwd: scope.cwd,
        env: sanitizedBuildEnvironment(control.env),
        deadlineAt: control.deadlineAt,
      },
      signal,
    );
  } catch (error) {
    assertCommandIntegrity(control);
    throw error;
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
  if (control.evidencePath)
    appendFileSync(
      control.evidencePath,
      JSON.stringify({
        commandId: randomUUID(),
        command: {
          executable: command.executable,
          args: command.args.map((arg) => redact(arg, control.secrets)),
        },
        cwd: scope.cwd,
        ...safeResult,
        baselineValid: !integrityError,
        credentialHit,
      }) + "\n",
      { mode: 0o600 },
    );
  if (integrityError) throw integrityError;
  if (credentialHit)
    throw new Error(
      "Command output contains protected credential material; comparison refused.",
    );
  return { ...result, stderr: safeResult.stderr };
}

/** Only the command is agent-selected. Scope, environment, baseline and deadline
 * come from a Host-created control file, never CLI flags or model output.
 */
export async function runBehaviorCommandCli(
  argv: string[],
  env = process.env,
): Promise<number> {
  const controlPath = env[BEHAVIOR_CONTROL_ENV];
  if (!controlPath || !isAbsolute(controlPath))
    throw new Error("Missing Host command control.");
  let control: BehaviorCommandControl;
  try {
    control = JSON.parse(
      readFileSync(controlPath, "utf8"),
    ) as BehaviorCommandControl;
  } catch {
    throw new Error("Invalid Host command control.");
  }
  if (argv[0] !== "--" || argv.length < 2)
    throw new Error("Expected -- <tool> <args...>.");
  const result = await runBehaviorCommand(
    { executable: argv[1]!, args: argv.slice(2) },
    control,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.timedOut ? 1 : (result.exitCode ?? 1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runBehaviorCommandCli(process.argv.slice(2)).then(
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
