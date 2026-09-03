import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkspaceHandle {
  /** 工作目录绝对路径。 */
  dir: string;
  /** dir/report.json(claude 自主会话写入的 SmokeReport)。 */
  reportPath: string;
  /** dir/claude-steps.jsonl(PostToolUse hook 追加的每次工具调用 JSON 行)。 */
  stepsLogPath: string;
  /** 删除整个工作目录(幂等);keep=false 时由调用方显式调用。 */
  cleanup(): void;
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
 * 创建 smoke 验证工作目录,目录名 smoke-<YYYYMMDDHHmmss>-<随机hex>。
 * 目录立即递归创建;清理由调用方在 keep=false 时显式调用 cleanup()。
 */
export function createWorkspace(root: string): WorkspaceHandle {
  const dir = resolve(root, `smoke-${timestamp()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    reportPath: join(dir, "report.json"),
    stepsLogPath: join(dir, "claude-steps.jsonl"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
