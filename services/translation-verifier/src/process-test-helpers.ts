import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LONG_RUNNING_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000);"], { stdio: "ignore" });
writeFileSync(process.env.FIXTURE_PID_FILE, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`;

export function pidFilePath(): string {
  return join(tmpdir(), `fx-verifier-pids-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

export function readPids(path: string): { parent: number; child: number } {
  return JSON.parse(readFileSync(path, "utf8")) as { parent: number; child: number };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function expectProcessGone(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}
