/**
 * strategies 共享辅助(helpers)单测:makeClaudeOptions 的 env 注入语义与
 * packageRoot/repoRoot 命名契约。
 */
import { describe, expect, it } from "vitest";
import { makeClaudeOptions, packageRoot, repoRoot } from "./helpers.js";

const sandbox = { readOnlyDirs: ["/ro/ref"], writableDir: "/ws" };

describe("makeClaudeOptions env", () => {
  it("JAVA_HOME 设置时注入该值(供 claude 子进程定位 JDK)", () => {
    const prev = process.env.JAVA_HOME;
    process.env.JAVA_HOME = "/opt/jdk17";
    try {
      const opts = makeClaudeOptions({ apiKey: "k" }, sandbox, "/steps.jsonl", 50);
      expect(opts.env).toEqual({ JAVA_HOME: "/opt/jdk17" });
    } finally {
      if (prev === undefined) {
        delete process.env.JAVA_HOME;
      } else {
        process.env.JAVA_HOME = prev;
      }
    }
  });

  it("JAVA_HOME 未设置时省略该键(env 为空对象),不注入空串破坏 $JAVA_HOME/bin 全路径约定", () => {
    const prev = process.env.JAVA_HOME;
    delete process.env.JAVA_HOME;
    try {
      const opts = makeClaudeOptions({ apiKey: "k" }, sandbox, "/steps.jsonl", 50);
      expect(opts.env).toEqual({});
    } finally {
      if (prev !== undefined) process.env.JAVA_HOME = prev;
    }
  });
});

describe("packageRoot / repoRoot 命名", () => {
  it("packageRoot 指向包根(services/translation-verifier),repoRoot 为兼容别名指向同一路径", () => {
    expect(packageRoot.endsWith("services/translation-verifier")).toBe(true);
    expect(repoRoot).toBe(packageRoot);
  });
});
