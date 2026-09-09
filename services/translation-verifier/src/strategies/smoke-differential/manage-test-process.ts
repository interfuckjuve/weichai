/**
 * 受控子进程共享原语(translation-verifier 包内,命令代理 verifier-command.ts
 * verifier-command 与 smoke 会话统一使用):
 * - sanitizedBuildEnvironment:构建子进程的最小化环境——保留工具链/缓存变量,
 *   移除模型与服务凭据类变量(凭据最小化,不是针对可信代码逃逸的安全沙箱)。
 * - runManagedProcess:参数数组 spawn(不经 shell),统一负责整体 deadline、AbortSignal、
 *   有界 stdout/stderr 收集与进程树回收。
 * - terminateProcessTree:终止整棵进程树并等待收尾。
 *
 * 生命周期语义(Node 24):spawn/execFile 自带 AbortSignal 只终止直接子进程,
 * 不回收后代进程树,因此 runManagedProcess 在 POSIX 以独立进程组(detached)
 * 启动子进程,终止时 kill -<pid>;Windows 走 taskkill /PID <pid> /T /F。
 *
 * 有界收尾(修复 round 1):settle 不再挂在 child 'close' 上——
 * (a) 'close' 只有在 stdout/stderr 写端全部关闭后才触发,直接子进程正常退出但
 *     后代继承管道写端时会永久不触发;
 * (b) 进程组若忽略 SIGTERM,仅发一次 TERM 会永久悬挂。
 * 因此所有 settle 路径都改为有界:直接进程 exit 为事实源,管道排空给短宽限,
 * TERM 后给宽限期再升级 SIGKILL(POSIX;Windows taskkill /F 本就强杀),
 * 然后强制关闭流并等待 close(有界),保证 abort/timeout/正常退出都能收敛。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

export interface ManagedProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** 单条输出(stdout/stderr)默认上限(1 MiB);超限截断并在文本中附标记。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** TERM→SIGKILL 升级宽限与直接进程退出后的管道排空宽限(生产默认)。 */
export const DEFAULT_CLEANUP_GRACE_MS = 2000;

/**
 * 凭据类环境变量名模式(大小写不敏感):命中即不向构建子进程透传。
 * 覆盖模型平台(ANTHROPIC_/DEEPSEEK_/OPENAI_)、云凭据(AWS_)、key/token/口令名段
 * 以及 DATABASE_URL 等服务连接变量;npm registry authToken 也会被 TOKEN 段命中。
 */
const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^DEEPSEEK_/i,
  /^OPENAI_/i,
  /^AWS_/i,
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /URL$/i,
  /_DSN$/i,
  /CONNECTION_STRING/i,
  /CONNSTR/i,
];

/** 构建子进程环境:保留工具链变量,剔除模型/服务凭据(env 缺省时用宿主环境)。 */
export function sanitizedBuildEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = env ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CREDENTIAL_NAME_PATTERNS.some((pattern) => pattern.test(name))) continue;
    result[name] = value;
  }
  return result;
}

/** 有界输出收集:达到上限后停止累积(继续排空流),结束时附截断标记。 */
interface BoundedOutput {
  push(chunk: Buffer): void;
  text(): string;
}

function boundedOutput(maxBytes: number): BoundedOutput {
  const parts: string[] = [];
  let stored = 0;
  let truncated = false;
  let dropped = 0;
  return {
    push(chunk: Buffer): void {
      const text = chunk.toString();
      if (truncated) {
        dropped += text.length;
        return;
      }
      const room = maxBytes - stored;
      if (room <= 0) {
        truncated = true;
        dropped += text.length;
        return;
      }
      if (text.length <= room) {
        parts.push(text);
        stored += text.length;
        return;
      }
      parts.push(text.slice(0, room));
      stored += room;
      dropped += text.length - room;
      truncated = true;
    },
    text(): string {
      const body = parts.join("");
      return truncated ? `${body}...[truncated ${dropped} chars]` : body;
    },
  };
}

function abortReasonOf(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  return reason !== undefined && reason !== null ? reason : new DOMException("This operation was aborted", "AbortError");
}

/** 直接子进程是否已退出(Node 在 exit 事件后填充 exitCode/signalCode)。 */
function childExitedNow(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 等待事件('exit'/'close')在宽限内发生。事件已发生过(依据 exitCode/流 closed)
 * 立即返回 true;宽限到期仍未发生返回 false,并移除一次性监听。
 */
function waitForSignalBounded(
  child: ChildProcess,
  kind: "exit" | "close",
  graceMs: number,
): Promise<boolean> {
  if (kind === "exit" && childExitedNow(child)) return Promise.resolve(true);
  if (kind === "close" && childExitedNow(child) && child.stdout?.closed && child.stderr?.closed) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolvePromise) => {
    const onEvent = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      child.removeListener(kind, onEvent);
      resolvePromise(false);
    }, graceMs);
    child.on(kind, onEvent);
  });
}

/**
 * 终止子进程整棵进程树并等待收尾(有界):
 * - 直接子进程未退出:POSIX 发 signal(默认 SIGTERM),宽限期后升级 SIGKILL;
 *   Windows 用 taskkill /T /F(本身即强杀)。
 * - 直接子进程已退出(含调用前已退出):不得就此返回——残余后代可能仍持有
 *   stdout/stderr 写端,因此继续 SIGKILL 残余进程组、强制关闭流、有界等 close。
 * 总耗时以 graceMs 为步长有界,绝不因后代存活或忽略信号而无限等待。
 */
export async function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  graceMs: number = DEFAULT_CLEANUP_GRACE_MS,
): Promise<void> {
  if (child.pid === undefined) {
    // spawn 尚未完成或失败:等 pid 或错误收尾。
    if (childExitedNow(child)) return;
    await new Promise<void>((resolvePromise) => {
      child.once("spawn", () => resolvePromise());
      child.once("error", () => resolvePromise());
    });
    if (child.pid === undefined) return; // spawn 失败,error/close 已接管
  }
  const pid = child.pid;
  // 1) 直接子进程未退出:发信号并等待有界,到期升级为强杀。
  //    kill 失败(ESRCH=进程组已消失 / EPERM=竞态或越权)一律容忍——清理是最佳
  //    努力,settle 的有界性由后续 destroy+close 宽限兜底,不允许挂起。
  if (!childExitedNow(child)) {
    if (process.platform === "win32") {
      await terminateWindowsTree(pid);
      if (!(await waitForSignalBounded(child, "exit", graceMs))) child.kill();
    } else {
      try {
        process.kill(-pid, signal);
      } catch {
        // best-effort
      }
      if (!(await waitForSignalBounded(child, "exit", graceMs))) {
        // SIGTERM 被忽略:升级 SIGKILL(不可忽略)。
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // best-effort
        }
        await waitForSignalBounded(child, "exit", graceMs);
      }
    }
  }
  // 2) 残余后代清理 + 强制关闭流 + 有界等 close:
  //    直接子进程已退出也可能有后代继承管道写端,导致 close 永不自然到来。
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // best-effort:残余组可能已空或越权(EPERM),不阻塞收尾。
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  await waitForSignalBounded(child, "close", graceMs);
}

/** Windows 进程树终止;taskkill 失败(如进程已退出)退化为直接 child.kill。 */
function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolvePromise) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error) {
        try {
          process.kill(pid);
        } catch {
          // 进程已退出,忽略
        }
      }
      resolvePromise();
    });
  });
}

/**
 * 受控运行一个命令(参数数组,不经 shell):收集有界输出,deadline 到期标记
 * timedOut 并终止进程树;AbortSignal 触发时以 signal.reason(AbortError)拒绝,
 * 保留 AbortError 同一性。spawn 失败(如命令不存在)以该 error 拒绝。
 *
 * settle 以直接子进程 'exit' 为事实源,不再依赖 'close':
 * - 正常退出 → 有界排空管道(graceMs);若后代仍持有写端导致 close 未到,终止
 *   残余进程组并强制关闭流后有界 settle(不悬挂)。
 * - deadline/abort → terminateProcessTree(TERM→SIGKILL 升级,有界)后 settle。
 * cleanupGraceMs 仅测试/特殊调用方传入更小值以缩短宽限。
 */
export function runManagedProcess(
  input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    deadlineAt: number;
    maxOutputBytes?: number;
    /** Host lifecycle hook; runs synchronously while the new process is owned here. */
    onSpawn?: (pid: number) => void;
    /** Best-effort live observer, independent of retained stdout limits. */
    onStdoutChunk?: (chunk: Buffer) => void;
    /** 终止升级与管道排空宽限(ms);缺省 DEFAULT_CLEANUP_GRACE_MS。 */
    cleanupGraceMs?: number;
  },
  signal?: AbortSignal,
): Promise<ManagedProcessResult> {
  const startedAt = Date.now();
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const graceMs = input.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  if (signal?.aborted) return Promise.reject(abortReasonOf(signal));
  const timeoutMs = Math.max(1, input.deadlineAt - Date.now());
  return new Promise<ManagedProcessResult>((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined && input.onSpawn) {
      try {
        input.onSpawn(child.pid);
      } catch (error) {
        void terminateProcessTree(child, "SIGKILL", graceMs).then(() => reject(error));
        return;
      }
    }
    const stdout = boundedOutput(maxBytes);
    const stderr = boundedOutput(maxBytes);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      try { input.onStdoutChunk?.(chunk); } catch { /* Observers never own process lifecycle. */ }
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let exitCode: number | null = null;
    let directExited = false;
    let timedOut = false;
    let abortErr: unknown = null;
    let settled = false;
    let termination: Promise<void> | null = null;

    const resultPayload = (): ManagedProcessResult => ({
      exitCode: timedOut ? null : exitCode,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout: stdout.text(),
      stderr: stderr.text(),
    });
    const cleanup = (): void => {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settleNormal = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(resultPayload());
    };
    const settleAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortErr);
    };

    // 终止(deadline/abort)共用一条有界清理链,完成后按标志 settle;
    // 即使终止本身抛错(防御)也保证 settle,不允许悬挂。
    const requestTermination = (): Promise<void> => {
      termination ??= (async () => {
        try {
          await terminateProcessTree(child, "SIGTERM", graceMs);
        } catch {
          // best-effort 收尾已含 kill 容忍;这里再兜底一层。
        }
        if (settled) return;
        if (abortErr !== null) settleAbort();
        else settleNormal(); // timedOut=true 时 payload exitCode 为 null
      })();
      return termination;
    };

    // 正常收尾:直接进程已退出 → 有界等 close(管道自然排空);未到则终止残余组。
    const finishNormalExit = async (): Promise<void> => {
      const closedInGrace = await waitForSignalBounded(child, "close", graceMs);
      if (settled) return;
      if (!closedInGrace) {
        await terminateProcessTree(child, "SIGKILL", graceMs);
        if (settled) return;
      }
      settleNormal();
    };

    const deadlineTimer = setTimeout(() => {
      if (settled || directExited) return; // 正常完成路径会接管
      timedOut = true;
      void requestTermination();
    }, timeoutMs);
    const onAbort = (): void => {
      if (settled || directExited || abortErr !== null) return;
      abortErr = abortReasonOf(signal);
      void requestTermination();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("exit", (code) => {
      exitCode = code;
      directExited = true;
      if (abortErr !== null || timedOut) return; // 终止路径负责 settle
      void finishNormalExit();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}
