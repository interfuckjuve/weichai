import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceCompilation, WorkspaceCompileCommand } from "@forexplore/contracts";

export function validateWorkspaceCompileCommand(value: unknown): asserts value is WorkspaceCompileCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compile command.");
  const command = value as WorkspaceCompileCommand;
  if (typeof command.executable !== "string" || !command.executable.trim() || command.executable.includes("\0") ||
    !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
    (command.cwd !== undefined && (typeof command.cwd !== "string" || isAbsolute(command.cwd) || command.cwd.includes("\0"))) ||
    (command.timeoutMs !== undefined && (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1000 || command.timeoutMs > 1_800_000))) {
    throw new Error("Compile command needs executable, args, optional relative cwd and timeoutMs (1000..1800000).");
  }
}

export async function compileWorkspace(
  root: string, command: WorkspaceCompileCommand, signal: AbortSignal,
): Promise<WorkspaceCompilation> {
  validateWorkspaceCompileCommand(command);
  signal.throwIfAborted();
  const cwd = realpathSync(resolve(root, command.cwd ?? "."));
  const local = relative(root, cwd);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) || !lstatSync(cwd).isDirectory()) {
    throw new Error("Compile cwd must be inside the configured workspace.");
  }
  const started = Date.now();
  return new Promise((resolveResult) => {
    let output = "";
    let failure = "";
    let stopped = false;
    const child = spawn(command.executable, command.args, {
      cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (text: string) => { output = (output + text).slice(-64_000); };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = true;
      failure = reason;
      if (child.pid && process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => child.kill("SIGKILL"));
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("Compilation cancelled.");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Compilation timed out."), command.timeoutMs ?? 120_000);
    child.on("error", (error) => { failure = error.message; });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) append(`\n${failure}`);
      const success = exitCode === 0 && !failure && !signal.aborted;
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const errors = lines.filter((line) => /error|fatal|failed|exception/i.test(line));
      resolveResult({
        command: structuredClone(command), startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started, exitCode, success, output,
        diagnostics: success ? [] : (errors.length ? errors.slice(-60) : lines.slice(-20)),
      });
    });
    if (signal.aborted) abort();
  });
}
