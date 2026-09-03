import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorSummary, MAX_REPORT_BYTES, readReport } from "./report.js";

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tv-report-"));
}

describe("readReport", () => {
  it("读取合法 JSON 并原样返回(无校验函数)", async () => {
    const root = makeTmpRoot();
    try {
      writeFileSync(join(root, "report.json"), '{"converged":true,"cases":[],"summary":"ok"}', "utf-8");
      const report = await readReport<{ converged: boolean }>(root);
      expect(report.converged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 缺失 → 抛带路径上下文的错误", async () => {
    const root = makeTmpRoot();
    try {
      await expect(readReport(root)).rejects.toThrow(/无法读取报告文件 .*report\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 非法 JSON → 抛带路径上下文的错误", async () => {
    const root = makeTmpRoot();
    try {
      writeFileSync(join(root, "report.json"), "{ broken json", "utf-8");
      await expect(readReport(root)).rejects.toThrow(/报告文件不是合法 JSON .*report\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("report.json 超过大小上限 → 读取前 stat 拒绝且不进入 JSON.parse", async () => {
    const root = makeTmpRoot();
    try {
      writeFileSync(join(root, "report.json"), Buffer.alloc(MAX_REPORT_BYTES + 1, 0x20));
      await expect(readReport(root)).rejects.toThrow(/report\.json 超过大小上限/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("传入校验函数:解析后立即校验,失败原样向上抛", async () => {
    const root = makeTmpRoot();
    try {
      writeFileSync(join(root, "report.json"), '{"converged":"yes"}', "utf-8");
      const validate = (raw: unknown): asserts raw is { converged: boolean } => {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.converged !== "boolean") throw new Error("report schema 校验失败: converged 字段缺失或类型错误");
      };
      await expect(readReport(root, validate)).rejects.toThrow(/校验失败/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("errorSummary", () => {
  it("Error 实例取 message", () => {
    expect(errorSummary(new Error("boom"))).toBe("boom");
  });

  it("字符串原样返回", () => {
    expect(errorSummary("plain")).toBe("plain");
  });

  it("null/undefined 转 String", () => {
    expect(errorSummary(null)).toBe("null");
    expect(errorSummary(undefined)).toBe("undefined");
  });

  it("对象 JSON 序列化;序列化失败回落 String", () => {
    expect(errorSummary({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof errorSummary(circular)).toBe("string");
  });
});
