import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as processManager from "./manage-test-process.js";
import { runClaude, spawnClaudeProcess, type SpawnClaude } from "./claude-session.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 预设 stdout/exitCode/stderr 的 fake spawnClaude(fake 可额外携带 stderr 字段供错误断言)。 */
function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

/** 断言 runClaude 调用 spawnClaude 时的 args/env/timeout 三要素。 */
function lastCall(spawnClaude: FakeSpawn): { args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number } {
  const call = spawnClaude.mock.calls.at(-1);
  if (!call) throw new Error("spawnClaude was never called");
  return { args: call[0] as string[], env: call[1] as NodeJS.ProcessEnv, timeoutMs: call[2] as number };
}

beforeEach(() => {
  // 保证默认值测试确定性:不依赖宿主环境是否设置了 DEEPSEEK_* 变量。
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(() => vi.restoreAllMocks());

// ---- 测试 ----

describe("runClaude", () => {
  it("enables partial stream-json only for observed calls without replaying buffered stdout", async () => {
    const observer = vi.fn(() => { throw new Error("observer failed"); });
    const fake: SpawnClaude = async (args, _env, _timeout, options) => {
      expect(args).toEqual(["-p", "p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
      options?.onStdoutChunk?.(Buffer.from("live"));
      return { stdout: "buffered", exitCode: 0 };
    };
    expect(await runClaude("p", { apiKey: "k", spawnClaude: fake, onStdoutChunk: observer })).toBe("buffered");
    expect(observer).toHaveBeenCalledExactlyOnceWith(Buffer.from("live"));
  });
  it("① 返回 claude 子进程的 stdout 原样", async () => {
    const spawnClaude = fakeSpawn('{"schemaVersion":"1.0"}');

    const out = await runClaude("hello", { apiKey: "test-key", spawnClaude });

    expect(out).toBe('{"schemaVersion":"1.0"}');
  });

  it("② spawn claude 的 args 含 -p / --output-format / text 与完整 prompt", async () => {
    const spawnClaude = fakeSpawn("ok");
    const prompt = `system prompt\n\nREQUIREMENT
decode MIME text`;

    await runClaude(prompt, { apiKey: "test-key", spawnClaude });

    expect(spawnClaude).toHaveBeenCalledTimes(1);
    expect(spawnClaude).toHaveBeenCalledWith(
      ["-p", prompt, "--output-format", "text"],
      expect.any(Object),
      expect.any(Number),
    );
    const { args } = lastCall(spawnClaude);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe(prompt);
    expect(args[2]).toBe("--output-format");
    expect(args[3]).toBe("text");
  });

  it("③ env 含 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL(及各默认模型别名)正确值", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "sk-test", model: "deepseek-v4-flash", spawnClaude });

    const { env } = lastCall(spawnClaude);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-flash");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash");
    // 未知模型名(deepseek)时不因窗口强制警告以非零码退出(2026-08-27 实测坑)。
    expect(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
  });

  it("③b 未传 model 时默认 deepseek-v4-flash;未传 timeoutMs 时默认 120_000", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "test-key", spawnClaude });

    const { env, timeoutMs } = lastCall(spawnClaude);
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
    expect(timeoutMs).toBe(120_000);
  });

  it("③c 显式 timeoutMs 透传给 spawnClaude", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", { apiKey: "test-key", spawnClaude, timeoutMs: 5_000 });

    const { timeoutMs } = lastCall(spawnClaude);
    expect(timeoutMs).toBe(5_000);
  });

  it("④ exitCode ≠ 0 → 抛错且错误含 stderr", async () => {
    const spawnClaude = fakeSpawn("", 1, "claude: error: invalid model config");

    await expect(runClaude("p", { apiKey: "test-key", spawnClaude })).rejects.toThrow(
      /claude: error: invalid model config/,
    );
  });

  it("⑤ 无 apiKey(缺省且环境未设)→ 抛错且 spawnClaude 未被调用", async () => {
    const spawnClaude = fakeSpawn("ok");

    await expect(runClaude("p", { spawnClaude })).rejects.toThrow(
      /DEEPSEEK_API_KEY is required for claude subprocess requests/,
    );
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("⑤b 空/空白 apiKey → 抛错且 spawnClaude 未被调用", async () => {
    const spawnClaude = fakeSpawn("ok");

    await expect(runClaude("p", { apiKey: "   ", spawnClaude })).rejects.toThrow(
      /DEEPSEEK_API_KEY is required for claude subprocess requests/,
    );
    expect(spawnClaude).not.toHaveBeenCalled();
  });

  it("⑥ spawnClaude 抛错(超时)→ runClaude 传播该错误", async () => {
    const spawnClaude = vi.fn(async () => {
      throw new Error("claude subprocess timed out after 120000ms");
    }) as unknown as FakeSpawn;

    await expect(runClaude("p", { apiKey: "test-key", spawnClaude })).rejects.toThrow(/timed out after 120000ms/);
  });

  it("⑦ options.env 自定义变量置于 ANTHROPIC_* 覆盖之后合并(如 JAVA_HOME)", async () => {
    const spawnClaude = fakeSpawn("ok");

    await runClaude("p", {
      apiKey: "sk-test",
      spawnClaude,
      env: { JAVA_HOME: "/opt/jdk-21", EXTRA: "x" },
    });

    const { env } = lastCall(spawnClaude);
    expect(env.JAVA_HOME).toBe("/opt/jdk-21");
    expect(env.EXTRA).toBe("x");
    // ANTHROPIC_* 覆盖仍在自定义 env 之后生效(模型别名不被覆盖)。
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
  });
});

// ---- 自主会话参数(参考 rev.2+ 契约) ----

describe("spawnClaudeProcess 自主会话参数组装", () => {
  it.each([5000, 1500, 900])("preserves absolute deadline %s at the managed process boundary, even after expiry", async (deadlineAt) => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1200).mockReturnValue(1300);
    const managed = vi.spyOn(processManager, "runManagedProcess").mockResolvedValue({ exitCode: 0, timedOut: false, durationMs: 0, stdout: "ok", stderr: "" });
    const signal = new AbortController().signal;
    await spawnClaudeProcess(["-p", "p"], { VERIFIER_DEADLINE_AT: String(deadlineAt) }, 10_000, { deadlineAt, signal });
    expect(managed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deadlineAt, env: { VERIFIER_DEADLINE_AT: String(deadlineAt) } }), signal);
  });
  it("forwards the live observer to the existing injected process boundary", async () => {
    const onStdoutChunk = vi.fn();
    const injected: SpawnClaude = async (_args, _env, _timeout, options) => {
      options?.onStdoutChunk?.(Buffer.from("chunk"));
      return { stdout: "buffered", exitCode: 0 };
    };
    await spawnClaudeProcess(["-p", "p"], {}, 1000, { spawn: injected, onStdoutChunk });
    expect(onStdoutChunk).toHaveBeenCalledExactlyOnceWith(Buffer.from("chunk"));
  });
  it("组装 add-dir/disallowedTools/permission-mode/max-turns/allowedTools/settings 并透传 cwd 与注入 spawn", async () => {
    const captured: { args: string[]; opts: { cwd?: string } }[] = [];
    const injected: SpawnClaude = async (args, _env, _timeout, options) => {
      captured.push({ args, opts: (options ?? {}) as { cwd?: string } });
      return { stdout: "ok", exitCode: 0 };
    };

    await spawnClaudeProcess(
      ["-p", "hello", "--output-format", "text"],
      { ANTHROPIC_AUTH_TOKEN: "k" } as NodeJS.ProcessEnv,
      1000,
      {
        cwd: "/ws",
        addDirs: ["/ws"],
        readOnlyDirs: ["/ref-a"],
        permissionMode: "acceptEdits",
        maxTurns: 40,
        allowedTools: ["Bash(javac *)"],
        settingsFile: "/tmp/hooks.json",
        spawn: injected,
      },
    );

    expect(captured).toHaveLength(1);
    const args = captured[0].args;
    // 基础 print-mode 参数原样保留在最前。
    expect(args.slice(0, 3)).toEqual(["-p", "hello", "--output-format"]);
    expect(args).toContain("--add-dir");
    expect(args).toContain("/ws");
    expect(args).toContain("--disallowedTools");
    // 只读目录权限串:resolve 后去首斜杠,组装 Edit(//<dir>/**)。
    expect(args.some((a) => a.includes("Edit(//ref-a/**)"))).toBe(true);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
    expect(args).toContain("--max-turns");
    expect(args).toContain("40");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Bash(javac *)");
    expect(args).toContain("--settings");
    expect(args).toContain("/tmp/hooks.json");
    expect(captured[0].opts.cwd).toBe("/ws");
  });

  it("effort 设置时追加 --effort <level>", async () => {
    const captured: string[][] = [];
    const injected: SpawnClaude = async (args) => {
      captured.push(args);
      return { stdout: "ok", exitCode: 0 };
    };
    await spawnClaudeProcess(["-p", "x", "--output-format", "text"], {} as NodeJS.ProcessEnv, 1000, {
      effort: "low",
      spawn: injected,
    });
    expect(captured[0]).toEqual(["-p", "x", "--output-format", "text", "--effort", "low"]);
  });

  it("无自主选项时 args 与现状一致(不加任何新参数)", async () => {
    const captured: string[][] = [];
    const injected: SpawnClaude = async (args) => {
      captured.push(args);
      return { stdout: "ok", exitCode: 0 };
    };

    await spawnClaudeProcess(["-p", "x", "--output-format", "text"], {} as NodeJS.ProcessEnv, 1000, {
      spawn: injected,
    });
    expect(captured[0]).toEqual(["-p", "x", "--output-format", "text"]);
  });

  it("显式 disallowedTools 与只读目录 Edit 权限串合并为同一条 --disallowedTools", async () => {
    const captured: { args: string[] }[] = [];
    const injected: SpawnClaude = async (args) => {
      captured.push({ args });
      return { stdout: "ok", exitCode: 0 };
    };

    await spawnClaudeProcess(["-p", "x", "--output-format", "text"], {} as NodeJS.ProcessEnv, 1000, {
      readOnlyDirs: ["/ref-a"],
      disallowedTools: ["TaskCreate", "TaskUpdate"],
      spawn: injected,
    });

    const args = captured[0].args;
    const flags = args.filter((a) => a === "--disallowedTools");
    expect(flags).toHaveLength(1);
    const values = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 4);
    expect(values).toEqual(["Edit(//ref-a/**)", "TaskCreate", "TaskUpdate"]);
  });
});

describe("runClaude 透传自主会话选项", () => {
  it("cwd/addDirs/readOnlyDirs/permissionMode/maxTurns/allowedTools 经第四参透传", async () => {
    const captured: { opts?: Record<string, unknown> }[] = [];
    const fake: SpawnClaude = async (_args, _env, _t, options) => {
      captured.push({ opts: (options ?? {}) as Record<string, unknown> });
      return { stdout: "ok", exitCode: 0 };
    };

    await runClaude("p", {
      apiKey: "k",
      spawnClaude: fake,
      cwd: "/ws",
      addDirs: ["/ws"],
      readOnlyDirs: ["/ref-a"],
      permissionMode: "acceptEdits",
      maxTurns: 40,
      allowedTools: ["Bash(javac *)", "Bash(java *)"],
      disallowedTools: ["TaskCreate", "TaskUpdate"],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].opts?.cwd).toBe("/ws");
    expect(captured[0].opts?.addDirs).toEqual(["/ws"]);
    expect(captured[0].opts?.readOnlyDirs).toEqual(["/ref-a"]);
    expect(captured[0].opts?.disallowedTools).toEqual(["TaskCreate", "TaskUpdate"]);
    expect(captured[0].opts?.permissionMode).toBe("acceptEdits");
    expect(captured[0].opts?.maxTurns).toBe(40);
    expect(captured[0].opts?.allowedTools).toEqual(["Bash(javac *)", "Bash(java *)"]);
  });

  it("无自主选项时保持三参调用(旧行为兼容)", async () => {
    const spawnClaude = fakeSpawn("ok");
    await runClaude("p", { apiKey: "test-key", spawnClaude });
    expect(spawnClaude).toHaveBeenCalledTimes(1);
    const call = spawnClaude.mock.calls[0];
    // 第四参缺省:自主会话选项缺席时不得传空对象,维持旧调用面。
    expect(call).toHaveLength(3);
  });

  it("does not install raw tool hooks even for the legacy hooksLogPath option", async () => {
    const fake = fakeSpawn("ok");
    await runClaude("p", { apiKey: "k", spawnClaude: fake, hooksLogPath: "/tmp/unused-hooks.jsonl" });
    expect(fake.mock.calls[0]).toHaveLength(3);
  });
});

describe("runClaude signal/deadlineAt 透传", () => {
  it("signal 与 deadlineAt 到达注入的 SpawnClaudeOptions", async () => {
    const controller = new AbortController();
    const captured: { opts?: Record<string, unknown> }[] = [];
    const fake: SpawnClaude = async (_args, _env, _t, options) => {
      captured.push({ opts: (options ?? {}) as Record<string, unknown> });
      return { stdout: "ok", exitCode: 0 };
    };
    const deadlineAt = Date.now() + 60_000;

    await runClaude("p", {
      apiKey: "k",
      spawnClaude: fake,
      signal: controller.signal,
      deadlineAt,
    });

    expect(captured[0].opts?.signal).toBe(controller.signal);
    expect(captured[0].opts?.deadlineAt).toBe(deadlineAt);
  });

  it("仅有 signal 时仍传第四参(signal 不得随自主选项缺席而丢失)", async () => {
    const controller = new AbortController();
    const captured: { call: unknown[] }[] = [];
    const fake: SpawnClaude = async (...call) => {
      captured.push({ call });
      return { stdout: "ok", exitCode: 0 };
    };

    await runClaude("p", { apiKey: "k", spawnClaude: fake, signal: controller.signal });

    expect(captured[0].call).toHaveLength(4);
    const options = captured[0].call[3] as { signal?: AbortSignal };
    expect(options.signal).toBe(controller.signal);
  });
});
