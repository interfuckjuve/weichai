import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "./workspace.js";

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-workspace-"));
}

describe("createWorkspace", () => {
  it("目录名 <strategy>-<YYYYMMDDHHmmss>-<rand> 且目录已创建", () => {
    const root = makeTmpRoot();
    try {
      const ws = createWorkspace(root, "smoke");
      const name = ws.dir.split(/[\\/]/).pop()!;
      expect(name).toMatch(/^smoke-\d{14}-[A-Za-z0-9]+$/);
      expect(ws.dir.startsWith(root)).toBe(true);
      expect(existsSync(ws.dir)).toBe(true);
      expect(ws.reportPath).toBe(join(ws.dir, "report.json"));
      expect(ws.stepsLogPath).toBe(join(ws.dir, "claude-steps.jsonl"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不同策略前缀不同,且根目录下产生两个工作目录", () => {
    const root = makeTmpRoot();
    try {
      const a = createWorkspace(root, "smoke");
      const b = createWorkspace(root, "aid");
      expect(a.dir).not.toBe(b.dir);
      expect(b.dir).toMatch(/aid-\d{14}-/);
      expect(readdirSync(root).length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleanup() 删除整个工作目录,根目录保留", () => {
    const root = makeTmpRoot();
    const ws = createWorkspace(root, "distinct");
    writeFileSync(join(ws.dir, "report.json"), "{}");
    expect(existsSync(ws.dir)).toBe(true);
    ws.cleanup();
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("cleanup() 可重复调用(幂等)", () => {
    const root = makeTmpRoot();
    const ws = createWorkspace(root, "mitgen");
    ws.cleanup();
    ws.cleanup();
    expect(existsSync(ws.dir)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
