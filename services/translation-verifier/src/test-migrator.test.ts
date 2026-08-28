import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMigrationPrompt,
  MIGRATOR_SYSTEM_PROMPT,
  TestMigratorAgent,
  type MigrationInput,
} from "./test-migrator.js";
import type { SpawnClaude } from "./claude-client.js";

// ---- 测试辅助 ----

type FakeSpawn = SpawnClaude & ReturnType<typeof vi.fn>;

/** 预设 stdout/exitCode 的 fake spawnClaude(claude 子进程注入,不触网)。 */
function fakeSpawn(stdout: string, exitCode = 0, stderr = ""): FakeSpawn {
  const mock = vi.fn(async () => ({ stdout, exitCode, stderr }));
  return mock as unknown as FakeSpawn;
}

function validDescriptionJson(): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    target: {
      language: "Java",
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "c1",
        description: "nominal: plain text passes through",
        inputs: [{ type: "string", value: "abc" }],
        expected: { kind: "return", value: { type: "string", value: "abc" } },
      },
      {
        id: "c2",
        description: "encoded text decodes",
        inputs: [{ type: "string", value: "=?UTF-8?B?aGVsbG8=?=" }],
        expected: { kind: "return", value: { type: "string", value: "hello" } },
      },
      {
        id: "c3",
        description: "invalid input throws",
        inputs: [],
        expected: { kind: "exception", type: "IllegalArgumentException", messageContains: "invalid" },
      },
    ],
  });
}

function sampleInput(): MigrationInput {
  return {
    sourceLanguage: "C#",
    sourceCode: "public static string DecodeText(string value) { return value; }",
    existingTests: '// C# tests\nAssert.AreEqual("abc", DecodeText("abc"));',
    requirement: "解码 MIME 编码文本(如 =?UTF-8?B?...?=),非编码文本原样返回",
    repository: "commons-fileupload-csharp",
    sourcePath: "src/Util/MimeUtil.cs",
    target: {
      language: "Java" as const,
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
    },
  };
}

beforeEach(() => {
  // 默认值确定性:不依赖宿主环境 DEEPSEEK_* 变量。
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_MODEL;
});

// ---- 测试 ----

describe("TestMigratorAgent.extractDescription", () => {
  it("returns the parsed description when the fake claude subprocess returns valid TestDescription JSON", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    const result = await agent.extractDescription(sampleInput());

    expect(result.schemaVersion).toBe("1.0");
    expect(result.target).toEqual({
      language: "Java",
      className: "MimeUtil",
      method: "decodeText",
      isStatic: true,
      constructorArgs: [],
    });
    expect(result.cases).toHaveLength(3);
    expect(result.cases[1]?.inputs[0]).toEqual({ type: "string", value: "=?UTF-8?B?aGVsbG8=?=" });
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("spawns claude -p with (system prompt + buildMigrationPrompt 输出) 且 env 指向 DeepSeek Anthropic 端点", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await agent.extractDescription(sampleInput());

    expect(spawnClaude).toHaveBeenCalledTimes(1);
    const call = spawnClaude.mock.calls[0];
    const args = call?.[0] as string[];
    const env = call?.[1] as NodeJS.ProcessEnv;
    // args 形态:claude -p <prompt> --output-format text
    expect(args[0]).toBe("-p");
    expect(args[2]).toBe("--output-format");
    expect(args[3]).toBe("text");
    // prompt = MIGRATOR_SYSTEM_PROMPT + 空行 + buildMigrationPrompt 输出
    const prompt = args[1] as string;
    expect(prompt).toBe(`${MIGRATOR_SYSTEM_PROMPT}\n\n${buildMigrationPrompt(sampleInput())}`);
    // system 段提示输出 schema
    expect(prompt).toContain('"schemaVersion": "1.0"');
    expect(prompt).toContain('"cases"');
    // env:DeepSeek Anthropic 兼容端点 + auth token + 模型
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
  });

  it("throws when the model returns invalid JSON", async () => {
    const spawnClaude = fakeSpawn("this is definitely not json {");
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
  });

  it("throws when the JSON parses but fails schema validation (wrong schemaVersion)", async () => {
    const spawnClaude = fakeSpawn(
      JSON.stringify({
        schemaVersion: "2.0",
        target: { language: "Java", className: "MimeUtil", method: "decodeText", isStatic: true, constructorArgs: [] },
        cases: [],
      }),
    );
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/schemaVersion must be "1.0"/);
  });

  it("fails immediately with a single claude call when the response is invalid (no retry)", async () => {
    const spawnClaude = fakeSpawn("bad json");
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("gives up after the first failure (single claude call, no retries)", async () => {
    const spawnClaude = fakeSpawn("bad json");
    const agent = new TestMigratorAgent({ apiKey: "test-key", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(
      /TestMigratorAgent failed to produce a valid test description/,
    );
    expect(spawnClaude).toHaveBeenCalledTimes(1);
  });

  it("throws without spawning claude when no apiKey is provided", async () => {
    const spawnClaude = fakeSpawn(validDescriptionJson());
    const agent = new TestMigratorAgent({ apiKey: "   ", spawnClaude });

    await expect(agent.extractDescription(sampleInput())).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
    expect(spawnClaude).not.toHaveBeenCalled();
  });
});

describe("buildMigrationPrompt(需求第一)", () => {
  it("places the REQUIREMENT section first and marks the source as a reference implementation", () => {
    const input = sampleInput();
    const prompt = buildMigrationPrompt(input);

    // 段序最前:第一个 section 是 REQUIREMENT
    const sections = prompt.split("\n\n");
    expect(sections[0]).toBe(`REQUIREMENT\n${input.requirement}`);
    expect(prompt.startsWith("REQUIREMENT\n")).toBe(true);
    expect(prompt.indexOf("REQUIREMENT")).toBeLessThan(prompt.indexOf("REFERENCE_IMPLEMENTATION"));
    // 源码段标记为参考
    expect(prompt).toContain("REFERENCE_IMPLEMENTATION");
    // REFERENCE_IMPLEMENTATION 段携带元数据与目标契约
    expect(prompt).toContain(`Source language: ${input.sourceLanguage}`);
    expect(prompt).toContain(`Repository: ${input.repository}`);
    expect(prompt).toContain(`Path: ${input.sourcePath}`);
    expect(prompt).toContain("Target contract:");
    expect(prompt).toContain(`- language: ${input.target.language}`);
    expect(prompt).toContain(`- className: ${input.target.className}`);
    expect(prompt).toContain(`- method: ${input.target.method}`);
    expect(prompt).toContain(`- isStatic: ${input.target.isStatic}`);
    // 源码与既有测试段
    expect(prompt).toContain("SOURCE_METHOD");
    expect(prompt).toContain(input.sourceCode);
    expect(prompt).toContain("EXISTING_TESTS");
    expect(prompt).toContain(input.existingTests as string);
  });

  it("omits repository/path metadata lines when not provided", () => {
    const prompt = buildMigrationPrompt({ ...sampleInput(), repository: undefined, sourcePath: undefined });

    expect(prompt).not.toContain("Repository:");
    expect(prompt).not.toContain("Path:");
    expect(prompt).toContain("REFERENCE_IMPLEMENTATION");
  });

  it("includes ANALYSIS_REPORT and TARGET_TRANSLATION sections when provided", () => {
    const analysisReport = JSON.stringify({
      schemaVersion: "1.0",
      applicability: { level: "adapt", confidence: 0.8, reasons: ["similar behavior"] },
      behaviorMapping: [{ requirement: "decode", status: "covered", candidateEvidence: ["x"], targetAction: "y" }],
    });
    const targetCode = "public static String decodeText(String value) { return value; }";
    const prompt = buildMigrationPrompt({ ...sampleInput(), analysisReport, targetCode });

    // ANALYSIS_REPORT 位于 REQUIREMENT 之后、REFERENCE_IMPLEMENTATION 之前。
    expect(prompt).toContain("ANALYSIS_REPORT");
    expect(prompt).toContain('"applicability"');
    expect(prompt.indexOf("ANALYSIS_REPORT")).toBeGreaterThan(prompt.indexOf("REQUIREMENT"));
    expect(prompt.indexOf("ANALYSIS_REPORT")).toBeLessThan(prompt.indexOf("REFERENCE_IMPLEMENTATION"));
    // TARGET_TRANSLATION 位于 SOURCE_METHOD 之后。
    expect(prompt).toContain("TARGET_TRANSLATION");
    expect(prompt).toContain(targetCode);
    expect(prompt.indexOf("TARGET_TRANSLATION")).toBeGreaterThan(prompt.indexOf("SOURCE_METHOD"));
  });

  it("omits ANALYSIS_REPORT and TARGET_TRANSLATION when absent", () => {
    const prompt = buildMigrationPrompt(sampleInput());

    expect(prompt).not.toContain("ANALYSIS_REPORT");
    expect(prompt).not.toContain("TARGET_TRANSLATION");
  });

  it("omits the EXISTING_TESTS section when no tests are provided", () => {
    const prompt = buildMigrationPrompt({ ...sampleInput(), existingTests: undefined });

    expect(prompt).not.toContain("EXISTING_TESTS");
  });

  it("requires requirement at the type level (必填)", () => {
    const base = {
      sourceLanguage: "C#",
      sourceCode: "x",
      target: { language: "Java" as const, className: "A", method: "b", isStatic: true },
    };
    // @ts-expect-error MigrationInput.requirement 是必填字段
    const bad: MigrationInput = base;
    expect(bad).toBeDefined();
  });
});

describe("MIGRATOR_SYSTEM_PROMPT(需求第一规则)", () => {
  it("declares the requirement as highest priority and forbids inheriting defects", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/highest priority/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/do not inherit/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/conflict/i);
  });

  it("does not contain the old rule 'do not invent behavior not present in the source'", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).not.toContain("do not invent behavior not present in the source");
  });

  // ---- 方向 2(DISTINCT)提示词增强断言 ----

  it("declares the requirement as the ONLY ground truth and forbids replicating source defects", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/ONLY ground truth/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/may contain defects/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/replicate source\s+defects/i);
  });

  it("requires the three-part description structure (场景/触发行为/目标分支或边界)", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/场景: <scenario>/);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/触发行为: <triggered behavior>/);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/目标分支或边界: <target branch or boundary>/);
  });

  it("documents the optional branches field consumed by the consistency analyzer", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/"branches": \["\.\.\."\]/);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/branch-level consistency analyzer/i);
  });

  it("requires at least 3 cases covering nominal/boundary/error and names boundaries", () => {
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/AT LEAST 3 cases/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/nominal, boundary, and error/i);
    expect(MIGRATOR_SYSTEM_PROMPT).toMatch(/off-by-one/i);
  });
});

describe("buildMigrationPrompt: VALIDATION_FEEDBACK 与签名增强", () => {
  it("emits the VALIDATION_FEEDBACK section after REQUIREMENT when validationFeedback is present", () => {
    const input = {
      ...sampleInput(),
      validationFeedback: "Driver.cs(3,9): error CS1503: argument 1: cannot convert from 'string' to 'int'",
    };
    const prompt = buildMigrationPrompt(input);
    expect(prompt).toContain("VALIDATION_FEEDBACK (编译诊断反馈,最高优先修正)");
    expect(prompt).toContain(input.validationFeedback as string);
    // 反馈段位于 REQUIREMENT 之后、REFERENCE_IMPLEMENTATION 之前。
    expect(prompt.indexOf("REQUIREMENT")).toBeLessThan(prompt.indexOf("VALIDATION_FEEDBACK"));
    expect(prompt.indexOf("VALIDATION_FEEDBACK")).toBeLessThan(prompt.indexOf("REFERENCE_IMPLEMENTATION"));
  });

  it("omits the VALIDATION_FEEDBACK section when not provided", () => {
    const prompt = buildMigrationPrompt(sampleInput());
    expect(prompt).not.toContain("VALIDATION_FEEDBACK");
  });

  it("includes the target signature line in the target contract", () => {
    const prompt = buildMigrationPrompt({ ...sampleInput(), targetSignature: "public static String decodeText(String)" });
    expect(prompt).toContain("- signature: public static String decodeText(String)");
    // 缺省时提示从源方法声明推导。
    const defaultPrompt = buildMigrationPrompt(sampleInput());
    expect(defaultPrompt).toContain("- signature: derive from the source method declaration (return type + parameters)");
  });
});
