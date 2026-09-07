import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "./create-smoke-workspace.js";

/** 每个用例独立的临时根目录,finally 清理。 */
function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tv-workspace-"));
  return root;
}

describe("createWorkspace", () => {
  it("立即创建目录,目录名 smoke-<YYYYMMDDHHmmss>-<随机hex>", () => {
    const root = makeTmpRoot();
    try {
      const ws = createWorkspace(root);
      expect(existsSync(ws.dir)).toBe(true);
      const name = ws.dir.slice(root.length + 1);
      expect(name).toMatch(/^smoke-\d{14}-[A-Za-z0-9]+$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reportPath 与 stepsLogPath 固定为 dir/report.json 与 dir/claude-steps.jsonl", () => {
    const root = makeTmpRoot();
    try {
      const ws = createWorkspace(root);
      expect(ws.reportPath).toBe(join(ws.dir, "report.json"));
      expect(ws.stepsLogPath).toBe(join(ws.dir, "claude-steps.jsonl"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("root 不存在时递归创建(mkdirSync recursive)", () => {
    const base = mkdtempSync(join(tmpdir(), "tv-workspace-root-"));
    try {
      const nested = join(base, "test-results", "nested");
      const ws = createWorkspace(nested);
      expect(existsSync(ws.dir)).toBe(true);
      expect(ws.dir.startsWith(nested)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("cleanup 删除整个工作目录但保留外层 root,且幂等可重复调用", () => {
    const root = makeTmpRoot();
    try {
      const ws = createWorkspace(root);
      ws.cleanup();
      expect(existsSync(ws.dir)).toBe(false);
      expect(existsSync(root)).toBe(true);
      // 幂等:重复调用不抛错。
      ws.cleanup();
      expect(readdirSync(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
