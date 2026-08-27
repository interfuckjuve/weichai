import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorSummary, readReport } from "./report.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tv-report-"));
}

describe("readReport", () => {
  it("读取并解析存在的 report.json", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "report.json"), JSON.stringify({ status: "pass", summary: "ok" }));
      const report = await readReport<{ status: string; summary: string }>(dir);
      expect(report).toEqual({ status: "pass", summary: "ok" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件缺失时抛出带路径上下文的错误", async () => {
    const dir = makeTmpDir();
    try {
      await expect(readReport(dir)).rejects.toThrow(/report\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非法 JSON 抛出带路径上下文的错误", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, "report.json"), "{ this is not json");
      await expect(readReport(dir)).rejects.toThrow(/report\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("可选 validate 在解析后执行;校验失败抛错", async () => {
    const dir = makeTmpDir();
    try {
      const validate = (raw: unknown): asserts raw is { status: string } => {
        if (typeof raw !== "object" || raw === null || !("status" in raw)) {
          throw new Error("报告缺少 status 字段");
        }
      };
      writeFileSync(join(dir, "report.json"), JSON.stringify({ status: "pass", extra: 1 }));
      const ok = await readReport(dir, validate);
      expect(ok.status).toBe("pass");
      expect((ok as { extra?: number }).extra).toBe(1);

      writeFileSync(join(dir, "report.json"), JSON.stringify({ nope: true }));
      await expect(readReport(dir, validate)).rejects.toThrow(/status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("errorSummary", () => {
  it("Error 实例取其 message", () => {
    expect(errorSummary(new Error("boom"))).toBe("boom");
  });

  it("字符串原样返回", () => {
    expect(errorSummary("boom")).toBe("boom");
  });

  it("未知值归一化为非空文本", () => {
    expect(errorSummary(undefined)).not.toBe("");
    expect(errorSummary(42)).toContain("42");
    expect(errorSummary({ code: "E" })).toBeTruthy();
  });

  it("readReport 的错误也能被归一化", async () => {
    const dir = makeTmpDir();
    try {
      await readReport(dir).then(
        () => expect.fail("应当抛错"),
        (err) => {
          const s = errorSummary(err);
          expect(s).toContain("report.json");
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
