/**
 * variant-generator 单元测试:提示词内容、类体提取、类名改写、package 剥离、重试。
 * 全部 fake spawnClaude,不依赖真实 LLM。
 */
import { describe, expect, it } from "vitest";
import type { SpawnClaude } from "../claude-client.js";
import { createLogger } from "../logger.js";
import { buildVariantPrompt, type VariantGenerationInput } from "./prompts.js";
import {
  VariantGeneratorAgent,
  classNameOf,
  extractJavaClass,
  renameClassName,
  stripPackageDeclaration,
} from "./variant-generator.js";

const SILENT = createLogger("test", { disabled: true });

const BASE_INPUT: VariantGenerationInput = {
  requirement: "解码 MIME 编码文本,非编码文本原样返回",
  sourceLanguage: "Java",
  sourceCode: "public class MimeUtility { public static String decodeText(String value) { return value; } }",
  target: { className: "org.example.MimeUtility", method: "decodeText", isStatic: true },
  variantCount: 2,
};

const JAVA_CLASS = `package org.example;

public class MimeUtility {
    public static String decodeText(String value) {
        return value == null ? "" : value;
    }
    static String helper(String s) { return MimeUtility.normalize(s); }
    static String normalize(String s) { return s.trim(); }
}`;

/** fake spawnClaude:按调用序号返回预设 stdout。 */
function fakeSpawn(...outputs: string[]): SpawnClaude {
  let call = 0;
  return async () => {
    const out = outputs[Math.min(call, outputs.length - 1)] as string;
    call += 1;
    return { stdout: out, exitCode: 0 };
  };
}

describe("buildVariantPrompt", () => {
  it("提示词包含需求、源方法、目标契约与策略约束", () => {
    const prompt = buildVariantPrompt({ ...BASE_INPUT, strategyHint: "use iteration" });
    expect(prompt).toContain(BASE_INPUT.requirement);
    expect(prompt).toContain("SOURCE_METHOD");
    expect(prompt).toContain("org.example.MimeUtility");
    expect(prompt).toContain("use iteration");
    expect(prompt).toContain("ONLY the complete code");
  });
});

describe("extractJavaClass / renameClassName / stripPackageDeclaration", () => {
  it("提取完整类体(含 helper 类),去掉围栏与尾随说明", () => {
    const raw = "```java\n" + JAVA_CLASS + "\n```\nSome explanation text.";
    const extracted = extractJavaClass(raw);
    expect(extracted).toBeTruthy();
    expect(extracted).toContain("public class MimeUtility");
    expect(extracted).not.toContain("Some explanation");
    expect(extracted).not.toContain("```");
  });

  it("类名统一改写为 Variant_<k>,含内部静态自引用", () => {
    const renamed = renameClassName(extractJavaClass(JAVA_CLASS) as string, "Variant_1");
    expect(classNameOf(renamed)).toBe("Variant_1");
    expect(renamed).toContain("Variant_1.normalize(s)");
    expect(renamed).not.toContain("MimeUtility");
  });

  it("剥离 package 声明", () => {
    const stripped = stripPackageDeclaration(extractJavaClass(JAVA_CLASS) as string);
    expect(stripped).not.toContain("package org.example;");
    expect(stripped).toContain("public class");
  });

  it("非代码输出(无 class 声明)→ extractJavaClass 返回 null", () => {
    expect(extractJavaClass("this is not code at all")).toBeNull();
  });
});

describe("VariantGeneratorAgent.generateVariants", () => {
  it("生成 N 个变体,类名依次为 Variant_1..N,package 剥离", async () => {
    const agent = new VariantGeneratorAgent({
      apiKey: "offline-test",
      spawnClaude: fakeSpawn(JAVA_CLASS, JAVA_CLASS.replace("MimeUtility", "MimeUtilX")),
      logger: SILENT,
    });
    const variants = await agent.generateVariants({ ...BASE_INPUT, variantCount: 2 });
    expect(variants).toHaveLength(2);
    expect(classNameOf(variants[0] as string)).toBe("Variant_1");
    expect(classNameOf(variants[1] as string)).toBe("Variant_2");
    for (const v of variants) {
      expect(v).not.toContain("package org.example;");
      expect(v).toContain("public class Variant_");
    }
  });

  it("每次调用生成不同策略提示(对抗趋同),prompt 经 spawnClaude 收到", async () => {
    const seenPrompts: string[] = [];
    const spawn: SpawnClaude = async (args) => {
      seenPrompts.push(args[1] as string);
      return { stdout: JAVA_CLASS, exitCode: 0 };
    };
    const agent = new VariantGeneratorAgent({ apiKey: "offline-test", spawnClaude: spawn, logger: SILENT });
    await agent.generateVariants({ ...BASE_INPUT, variantCount: 3 });
    expect(seenPrompts).toHaveLength(3);
    // 三份 prompt 的策略提示互不相同(且非空)。
    const hints = seenPrompts.map((p) => {
      const tail = p.split("Implementation strategy to use")[1] ?? "";
      const hint = tail.split("\n").filter((l) => l.trim().length > 0).at(-1) ?? "";
      return hint.trim();
    });
    expect(new Set(hints).size).toBe(3);
    expect(hints.every((h) => h.length > 10)).toBe(true);
  });

  it("LLM 返回非代码 → 重试;第二次成功", async () => {
    const agent = new VariantGeneratorAgent({
      apiKey: "offline-test",
      spawnClaude: fakeSpawn("Sorry, I cannot produce code.", JAVA_CLASS),
      logger: SILENT,
    });
    const variants = await agent.generateVariants({ ...BASE_INPUT, variantCount: 1 });
    expect(classNameOf(variants[0] as string)).toBe("Variant_1");
  });

  it("重试耗尽仍失败 → 抛错", async () => {
    const agent = new VariantGeneratorAgent({
      apiKey: "offline-test",
      spawnClaude: fakeSpawn("no class here", "still no class", "again no class"),
      logger: SILENT,
    });
    await expect(agent.generateVariants({ ...BASE_INPUT, variantCount: 1 })).rejects.toThrow(/failed to produce variant/);
  });

  it("LLM 输出过短(提取后 <40 字符)→ 视为非法并重试", async () => {
    const agent = new VariantGeneratorAgent({
      apiKey: "offline-test",
      spawnClaude: fakeSpawn("public class Tiny {}", JAVA_CLASS),
      logger: SILENT,
    });
    const variants = await agent.generateVariants({ ...BASE_INPUT, variantCount: 1 });
    expect(classNameOf(variants[0] as string)).toBe("Variant_1");
  });
});
