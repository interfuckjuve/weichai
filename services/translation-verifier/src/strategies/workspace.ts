import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestStrategy } from "./types.js";

export interface WorkspaceHandle {
  dir: string; // 工作目录绝对路径
  reportPath: string; // dir/report.json
  stepsLogPath: string; // dir/claude-steps.jsonl
  cleanup(): void; // keep=false 时删除整个目录
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 创建策略工作目录,目录名 <strategy>-<YYYYMMDDHHmmss>-<rand>。
 * 目录立即创建(mkdirSync recursive);清理由调用方在 keep=false 时显式调用 cleanup()。
 */
export function createWorkspace(root: string, strategy: TestStrategy): WorkspaceHandle {
  const dir = resolve(root, `${strategy}-${timestamp()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  const stepsLogPath = join(dir, "claude-steps.jsonl");
  return {
    dir,
    reportPath,
    stepsLogPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
