/**
 * 受控构建/运行命令代理:claude 会话不直接获得任意宿主 Bash,只允许经由本
 * 代理执行白名单工具链命令。每次执行:
 * 1) cwd 必须物理位于请求级工作区内(realpath 包含校验);
 * 2) 复查工作区基线(既有源码被改 / runner 区外出现新源码 → 拒绝执行);
 * 3) 命令在白名单内(已装工具按 basename;mvnw/gradlew 额外要求 realpath 在工作区内);
 * 4) 以最小化环境(sanitizedBuildEnvironment)参数数组 spawn,应用剩余 deadline,
 *    超时/取消终止整棵进程树;
 * 5) 有界捕获 stdout/stderr,在证据 JSONL 追加恰好一行 CommandEvidence;
 * 6) spawn 结束后立即复查基线:命令运行期间改动受保护文件的证据以 baselineValid:false
 *    落盘并以失败返回(CLI 非零),宿主评估不会把该证据当作有效通过。
 *
 * CLI(runVerifierCommandCli):工作区/基线/证据/deadline 边界全部来自固定环境变量,
 * agent 的 argv 只能选择 side/phase/cwd(工作区内)与命令本身。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandEvidence, SmokeSide } from "./differential-test-types.js";
import { DEFAULT_MAX_OUTPUT_BYTES, runManagedProcess, sanitizedBuildEnvironment } from "./manage-test-process.js";
import { assertWorkspaceBaseline } from "./protect-project-files.js";

/** 构建/运行阶段。 */
type CommandPhase = "compile" | "run";

/** 已装工具 basename 白名单(不开放 shell/git push/SSH/系统包管理器)。 */
const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Java
  "java",
  "javac",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  // .NET
  "dotnet",
  // JavaScript/TypeScript
  "node",
  "npm",
  "npx",
  "pnpm",
  "tsx",
  "tsc",
  // Python
  "python3",
  "python",
  // Go/Rust
  "go",
  "cargo",
  "rustc",
]);

/** 工作区本地 wrapper:必须作为真实文件存在于工作区内(realpath 校验),不走 PATH。 */
const LOCAL_WRAPPER_NAMES: ReadonlySet<string> = new Set(["mvnw", "gradlew"]);

export interface RunVerifierCommandInput {
  workspaceRoot: string;
  side: SmokeSide;
  phase: CommandPhase;
  cwd: string;
  command: string;
  args: string[];
  deadlineAt: number;
  baselinePath: string;
  evidencePath: string;
}

/** realpath 包含校验:candidate 物理位置必须在 root 内,否则抛带 label 的错误。
 * 先做词法包含(确定性),路径真实存在时再用 realpath 二次校验(符号链接逃逸守卫)。 */
function containedRealPath(
  root: string,
  candidate: string,
  label: string,
): string {
  const rootLexical = resolve(root);
  const candidateLexical = resolve(candidate);
  if (
    candidateLexical !== rootLexical &&
    !candidateLexical.startsWith(rootLexical + sep)
  ) {
    throw new Error(`${label} 必须位于工作区内: ${candidate}`);
  }
  if (existsSync(candidateLexical)) {
    const rootReal = realpathSync(rootLexical);
    const physical = realpathSync(candidateLexical);
    if (physical !== rootReal && !physical.startsWith(rootReal + sep)) {
      throw new Error(
        `${label} 必须位于工作区内: ${candidate} (实际 ${physical})`,
      );
    }
  }
  return candidateLexical;
}

/** 命令白名单校验;mvnw/gradlew 返回 realpath,其余已装工具原样交给 spawn 走 PATH。 */
function resolveAllowedCommand(
  command: string,
  workspaceRoot: string,
  cwd: string,
): string {
  const base = basename(command);
  if (!ALLOWED_TOOL_NAMES.has(base)) {
    throw new Error(`command not allowed: ${command}`);
  }
  if (!LOCAL_WRAPPER_NAMES.has(base)) return command;
  const candidate = isAbsolute(command) ? command : resolve(cwd, command);
  if (!existsSync(candidate)) {
    throw new Error(`command not allowed: ${command}(工作区内未找到 wrapper)`);
  }
  return containedRealPath(workspaceRoot, candidate, "command");
}

/**
 * 执行前基线复查,并把 Task 2 断言错误归一化为命令代理可见语义:
 * 既有文件变化 / 受保护文件被删 → /baseline/;runner 区外新文件 → /new source/。
 */
function assertBaselineGated(
  workspaceRoot: string,
  baselinePath: string,
): void {
  try {
    assertWorkspaceBaseline(workspaceRoot, baselinePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("new file outside")) {
      throw new Error(
        `baseline violation: runner 区外出现新源码(new source): ${message}`,
      );
    }
    throw new Error(`baseline 校验失败: ${message}`);
  }
}

function appendEvidenceLine(
  evidencePath: string,
  evidence: CommandEvidence,
): void {
  mkdirSync(dirname(evidencePath), { recursive: true });
  appendFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
}

/**
 * 执行一条受控命令并返回命令证据。基线/cwd/白名单违规直接抛错且不写证据行;
 * 超时返回 timedOut 证据行;取消以原 signal.reason(AbortError)拒绝且不写证据行。
 *
 * 基线复查在 spawn 前后各一次:执行前门禁拦截已知变更;执行后再查一次——若命令在
 * 运行期间改动了受保护文件(自身或影子进程),证据行仍以 baselineValid:false 落盘
 * (truthful evidence),随后抛错,CLI 因此返回非零、宿主评估也无法接受该证据。
 * 注意残余限制:同一命令内先改后恢复原内容无法被哈希复查发现(见 README 已知限制)。
 */
export async function runVerifierCommand(
  input: RunVerifierCommandInput,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<CommandEvidence> {
  const started = performance.now();
  // 已中止的 signal 优先于一切门禁生效:取消不以“baseline 违规”等理由被吞掉。
  signal?.throwIfAborted();
  const { side, phase } = input;
  if (side !== "source" && side !== "target")
    throw new Error(`invalid side: ${String(side)}`);
  if (phase !== "compile" && phase !== "run")
    throw new Error(`invalid phase: ${String(phase)}`);
  const workspaceRoot = resolve(input.workspaceRoot);
  containedRealPath(workspaceRoot, input.cwd, "cwd");
  const beforeBaseline = performance.now();
  assertBaselineGated(workspaceRoot, input.baselinePath);
  const afterBaseline = performance.now();
  const resolvedCommand = resolveAllowedCommand(
    input.command,
    workspaceRoot,
    input.cwd,
  );

  const beforeProcess = performance.now();
  const result = await runManagedProcess(
    {
      command: resolvedCommand,
      args: input.args,
      cwd: input.cwd,
      env: sanitizedBuildEnvironment(env),
      deadlineAt: input.deadlineAt,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    },
    signal,
  );

  const afterProcess = performance.now();
  // 接受证据前复查:命令运行期间是否动过受保护文件。
  let postBaselineError: string | null = null;
  try {
    assertWorkspaceBaseline(workspaceRoot, input.baselinePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postBaselineError = /^baseline/.test(message)
      ? message
      : `baseline 校验失败: ${message}`;
  }
  const afterPostBaseline = performance.now();
  const evidence = {
    timing: {
      validationMs: beforeBaseline - started + beforeProcess - afterBaseline,
      preBaselineMs: afterBaseline - beforeBaseline,
      processMs: afterProcess - beforeProcess,
      postBaselineMs: afterPostBaseline - afterProcess,
      beforeEvidenceAppendMs: afterPostBaseline - started,
    },
    commandId: randomUUID(),
    side,
    phase,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    cwd: input.cwd,
    command: input.command,
    baselineValid: postBaselineError === null,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  } satisfies CommandEvidence & { timing: Record<string, number> };
  appendEvidenceLine(input.evidencePath, evidence);
  if (postBaselineError !== null) {
    // 证据已如实落盘(baselineValid:false);调用方(CLI)据此返回失败,
    // 宿主侧 evaluateSmokeReport 也不会把该命令证据当作有效通过证据。
    throw new Error(`baseline 校验失败(命令执行后): ${postBaselineError}`);
  }
  return evidence;
}

interface CliInvocation {
  side: SmokeSide;
  phase: CommandPhase;
  cwd: string;
  command: string;
  args: string[];
}

type CliParse =
  | { ok: true; invocation: CliInvocation }
  | { ok: false; message: string };

function parseCliInvocation(argv: string[]): CliParse {
  const take = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    return value !== undefined && !value.startsWith("--") ? value : undefined;
  };
  const side = take("--side");
  const phase = take("--phase");
  const cwd = take("--cwd");
  const separator = argv.indexOf("--");
  const rest = separator === -1 ? [] : argv.slice(separator + 1);
  if (side === undefined)
    return { ok: false, message: "缺少 --side source|target" };
  if (side !== "source" && side !== "target")
    return { ok: false, message: `无效 side: ${side}` };
  if (phase === undefined)
    return { ok: false, message: "缺少 --phase compile|run" };
  if (phase !== "compile" && phase !== "run")
    return { ok: false, message: `无效 phase: ${phase}` };
  if (cwd === undefined || cwd === "")
    return { ok: false, message: "缺少 --cwd" };
  if (rest.length === 0)
    return { ok: false, message: "缺少命令(-- 之后为 command args)" };
  return {
    ok: true,
    invocation: { side, phase, cwd, command: rest[0], args: rest.slice(1) },
  };
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * CLI 入口:固定边界(工作区/基线/证据路径/deadline)只从环境变量读取,
 * agent 无法通过 argv 覆盖;返回被代理命令的退出码(超时/失败为 1)。
 * 调用形态:
 *   npx tsx <pkgRoot>/src/strategies/controlled-test-command.ts --side source --phase compile --cwd source/project -- mvn -q test
 */
export async function runVerifierCommandCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parseCliInvocation(argv);
  if (!parsed.ok) {
    process.stderr.write(`verifier-command: ${parsed.message}\n`);
    return 1;
  }
  const workspaceRoot = envString(env, "VERIFIER_WORKSPACE_ROOT");
  const baselinePath = envString(env, "VERIFIER_BASELINE_PATH");
  const evidencePath = envString(env, "VERIFIER_COMMAND_EVIDENCE_PATH");
  const deadlineRaw = envString(env, "VERIFIER_DEADLINE_AT");
  if (!workspaceRoot || !baselinePath || !evidencePath || !deadlineRaw) {
    process.stderr.write(
      "verifier-command: 缺少固定边界环境变量 VERIFIER_WORKSPACE_ROOT / VERIFIER_BASELINE_PATH / VERIFIER_COMMAND_EVIDENCE_PATH / VERIFIER_DEADLINE_AT\n",
    );
    return 1;
  }
  const deadlineAt = Number(deadlineRaw);
  if (!Number.isFinite(deadlineAt)) {
    process.stderr.write(
      `verifier-command: VERIFIER_DEADLINE_AT 非法: ${deadlineRaw}\n`,
    );
    return 1;
  }
  const { side, phase, cwd: cwdRel, command, args } = parsed.invocation;
  try {
    const evidence = await runVerifierCommand({
      workspaceRoot,
      side,
      phase,
      cwd: join(workspaceRoot, cwdRel),
      command,
      args,
      deadlineAt,
      baselinePath,
      evidencePath,
    });
    return evidence.exitCode ?? 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verifier-command: ${message}\n`);
    return 1;
  }
}

function isModuleEntryPoint(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  const entryPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(entryPath);
  } catch {
    return resolve(process.argv[1]) === resolve(entryPath);
  }
}

// 模块入口守卫:仅当本文件作为 tsx 启动入口时执行 CLI,单元测试 import 时不触发。
if (isModuleEntryPoint()) {
  try {
    process.exitCode = await runVerifierCommandCli(
      process.argv.slice(2),
      process.env,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verifier-command: ${message}\n`);
    process.exitCode = 1;
  }
}
