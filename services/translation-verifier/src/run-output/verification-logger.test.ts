import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, redactSecrets, DEFAULT_LOG_DIR, type LoggerOptions } from "./verification-logger.js";

// ---- 测试辅助 ----

/** 注入式 console(测试捕获,不污染全局 console)。 */
function fakeConsole() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "logger-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.VERIFIER_LOG_CONTENT;
});

function baseOptions(c: ReturnType<typeof fakeConsole>): LoggerOptions {
  return { logDir: tempDir, fileName: "test.log", console: c, level: "INFO", fileLevel: "INFO" };
}

function readLog(): string {
  return readFileSync(join(tempDir, "test.log"), "utf-8");
}

describe("createLogger: 文件默认 INFO + content 默认关闭 + 脱敏", () => {
  it("文件默认 INFO 且 content 默认关闭", () => {
    const c = fakeConsole();
    const logger = createLogger("test", baseOptions(c));
    logger.debug("debug detail");
    logger.content("SOURCE_METHOD secret body");
    logger.info("done");
    expect(readLog()).not.toContain("debug detail");
    expect(readLog()).not.toContain("SOURCE_METHOD");
    expect(readLog()).toContain("done");
    // content 也不会进控制台。
    expect(c.debug).not.toHaveBeenCalledWith(expect.stringContaining("SOURCE_METHOD"));
  });

  it("contentEnabled=true 时 content 以 DEBUG 记录到文件(可经 options 或 env 打开)", () => {
    const c = fakeConsole();
    const logger = createLogger("test", { ...baseOptions(c), contentEnabled: true });
    logger.content("SOURCE_METHOD full body");
    expect(readLog()).toContain("SOURCE_METHOD full body");
    expect(readLog()).toContain("DEBUG");

    process.env.VERIFIER_LOG_CONTENT = "1";
    const envLogger = createLogger("env-content", baseOptions(c));
    envLogger.content("second body");
    expect(readLog()).toContain("second body");
  });

  it("格式含 [name] 与 ISO 时间戳", () => {
    const logger = createLogger("verify", baseOptions(fakeConsole()));
    logger.info("hello");
    const line = readLog();
    expect(line.trimEnd()).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[verify\] INFO hello$/);
  });

  it("多行消息每行都带前缀且单次 append(注入 writeFile 计数)", () => {
    const writes: string[] = [];
    const logger = createLogger("test", { ...baseOptions(fakeConsole()), writeFile: (_p, payload) => writes.push(payload) });
    logger.info("line 1\nline 2");
    expect(writes).toHaveLength(1);
    const lines = writes[0].trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[test\] INFO line 1$/);
    expect(lines[1]).toMatch(/\[test\] INFO line 2$/);
  });

  it("disabled 时不写文件不输出控制台", () => {
    const c = fakeConsole();
    const logger = createLogger("quiet", { ...baseOptions(c), disabled: true });
    logger.info("nope");
    expect(existsSync(join(tempDir, "test.log"))).toBe(false);
    expect(c.info).not.toHaveBeenCalled();
  });

  it("logDir 不存在时自动递归创建", () => {
    const nested = join(tempDir, "a", "b");
    const logger = createLogger("deep", { logDir: nested, fileName: "x.log", level: "INFO", fileLevel: "DEBUG" });
    logger.debug("created");
    expect(readFileSync(join(nested, "x.log"), "utf8")).toContain("created");
  });
});

describe("redactSecrets", () => {
  it("凭据被脱敏", () => {
    expect(redactSecrets("Authorization: Bearer abc DEEPSEEK_API_KEY=sk-secret"))
      .toBe("Authorization: [REDACTED] DEEPSEEK_API_KEY=[REDACTED]");
  });

  it("覆盖 Authorization 冒号形态、token/sk- 值与 key: value 形态", () => {
    expect(redactSecrets("Authorization: Bearer abc")).toBe("Authorization: [REDACTED]");
    expect(redactSecrets("Authorization: Basic Zm9v")).toBe("Authorization: [REDACTED]");
    expect(redactSecrets("sk-abc12345 rest")).toBe("[REDACTED] rest");
    expect(redactSecrets("ANTHROPIC_AUTH_TOKEN=sk-ant-abcdef")).toContain("ANTHROPIC_AUTH_TOKEN=[REDACTED]");
    expect(redactSecrets("NPM_AUTH_TOKEN: secret-value")).toContain("NPM_AUTH_TOKEN: [REDACTED]");
  });

  it("普通日志原样保留", () => {
    expect(redactSecrets("case c1 passed in 12ms")).toBe("case c1 passed in 12ms");
  });
});

describe("createLogger: 轮转保留 maxFiles", () => {
  it("超过上限轮转并只保留 maxFiles 份", () => {
    const logger = createLogger("rot", {
      logDir: tempDir,
      fileName: "rot.log",
      level: "INFO",
      fileLevel: "INFO",
      maxFileBytes: 120,
      maxFiles: 2,
    });
    for (let index = 0; index < 20; index += 1) logger.info("x".repeat(40));
    const files = readdirSync(tempDir).filter((name) => name.startsWith("rot.log"));
    expect(files.length).toBeLessThanOrEqual(3); // rot.log + 两份轮转档
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("小消息不触发轮转(文件保持单份)", () => {
    const logger = createLogger("small", {
      logDir: tempDir,
      fileName: "small.log",
      level: "INFO",
      fileLevel: "INFO",
      maxFileBytes: 4096,
      maxFiles: 2,
    });
    for (let index = 0; index < 10; index += 1) logger.info("ok");
    const files = readdirSync(tempDir).filter((name) => name.startsWith("small.log"));
    expect(files).toEqual(["small.log"]);
  });
});

describe("默认 logDir(monorepo 根 logs/,不依赖 cwd)", () => {
  it("默认日志目录解析到仓库根 logs/", () => {
    expect(DEFAULT_LOG_DIR).toMatch(/logs$/);
  });
});
