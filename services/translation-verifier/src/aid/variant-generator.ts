/**
 * VariantGeneratorAgent:基于「需求 + 源方法 + 目标契约」调用 LLM 生成 N 个源语言变体
 * (借鉴 TrickCatcher genprog_tc/genprog_dfp 提示词,工程化约束)。
 * 每次调用生成一个变体,策略提示按序号轮换(对抗变体趋同);
 * LLM 输出经过 extractJavaClass(提取完整类体)→ renameClassName(统一改写为 Variant_<k>)
 * → stripPackageDeclaration(剥离 package)后校验;失败重试 ≤2 次。
 */
import { runClaude, type ClaudeClientOptions } from "../claude-client.js";
import { createLogger, type Logger } from "../logger.js";
import { buildVariantPrompt, type VariantGenerationInput } from "./prompts.js";

export type { VariantGenerationInput } from "./prompts.js";

/** 变体策略提示轮换表(对应设计 R1「提示词强制策略多样」)。 */
const STRATEGY_HINTS = [
  "Use an explicit iterative loop instead of the reference's control flow (e.g. replace recursion with iteration).",
  "Use different data structures (e.g. arrays/List instead of Map, or a different traversal order).",
  "Use recursion instead of iteration, or restructure control flow (guard clauses / early returns vs single-exit).",
  "Use a different algorithm family (e.g. StringBuilder-based processing instead of substring concatenation, or a different decode strategy).",
];

/** 每次生成的尝试次数 = 首次 + 重试 ≤2 次(借鉴 DISTINCT Validator 的结构化反馈重试思想)。 */
const MAX_ATTEMPTS = 3;

export class VariantGeneratorAgent {
  readonly #options: ClaudeClientOptions;
  readonly #logger: Logger;

  constructor(options: ClaudeClientOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("variant-generator");
  }

  async generateVariants(input: VariantGenerationInput, signal?: AbortSignal): Promise<string[]> {
    const count = Math.max(1, input.variantCount ?? 3);
    this.#logger.info(`generateVariants 开始:目标 ${count} 个变体(语言 ${input.sourceLanguage})`);
    const variants: string[] = [];
    for (let k = 1; k <= count; k += 1) {
      const variant = await this.#generateOne(
        { ...input, strategyHint: STRATEGY_HINTS[(k - 1) % STRATEGY_HINTS.length] },
        k,
        signal,
      );
      variants.push(variant);
    }
    this.#logger.info(`generateVariants 完成:${variants.length} 个变体`);
    return variants;
  }

  /** 单个变体:runClaude → 提取 → 改写类名 → 剥离 package → 校验;失败重试(反馈结构性问题)。 */
  async #generateOne(input: VariantGenerationInput, index: number, signal?: AbortSignal): Promise<string> {
    const newName = `Variant_${index}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      this.#logger.info(`生成变体 ${newName}(尝试 ${attempt}/${MAX_ATTEMPTS})`);
      try {
        const raw = await runClaude(buildVariantPrompt(input), this.#options);
        this.#logger.debug(`变体 ${newName} LLM 原始返回(截断):\n${truncate(raw, 800)}`);
        const extracted = extractJavaClass(raw);
        if (!extracted) throw new Error("Claude output did not contain a class declaration.");
        const renamed = renameClassName(extracted, newName);
        const stripped = stripPackageDeclaration(renamed);
        const finalName = classNameOf(stripped);
        if (finalName !== newName) {
          throw new Error(`expected public class ${newName} after rename, got ${finalName ?? "(none)"}`);
        }
        if (stripped.trim().length < 40) throw new Error("variant code is suspiciously short.");
        this.#logger.debug(`变体 ${newName} 生成成功(${stripped.length} chars)`);
        return stripped;
      } catch (error) {
        lastError = error;
        this.#logger.error(
          `变体 ${newName} 校验失败(尝试 ${attempt}/${MAX_ATTEMPTS}):${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new Error(
      `VariantGeneratorAgent failed to produce variant ${newName}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// LLM 输出结构化处理(提取 / 类名改写 / package 剥离)
// ---------------------------------------------------------------------------

/** 去掉 markdown 代码围栏(```java / ```cs 等)。 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:java|csharp|cs|typescript|ts)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

/**
 * 从 LLM 输出提取完整类文件:取代码头部(import/using/package 等声明行)+ 第一个 class 声明起
 * 到最后一个顶层 } 结束(保留同文件 helper 类)。尾随说明文字被截断。
 */
export function extractJavaClass(raw: string): string | null {
  const code = stripFences(raw).trim();
  const decl = classDeclaration(code);
  if (!decl) return null;
  // 保留类声明前的头部声明行(import/using/package/namespace 等),跳过说明文字与空行。
  const headerLines = code.slice(0, decl.index).split("\n");
  let headerStart = headerLines.length;
  for (let i = headerLines.length - 1; i >= 0; i -= 1) {
    const line = (headerLines[i] as string).trim();
    if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    if (/^(import|using|package|#include)\b/.test(line)) {
      headerStart = i;
      continue;
    }
    break; // 遇到非头部行(如 LLM 的说明文字)停止向上收集
  }
  const header = headerLines.slice(headerStart).join("\n").trim();
  const body = code.slice(decl.index);
  const end = body.lastIndexOf("}");
  if (end < 0) return null;
  const prefix = header === "" ? "" : `${header}\n`;
  return `${prefix}${body.slice(0, end + 1)}`;
}

/** 提取文件中第一个类声明的完整匹配(index 为声明起点)。 */
function classDeclaration(code: string): { index: number } | null {
  const m = /\b(?:public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+\w+/.exec(code);
  return m ? { index: m.index } : null;
}

/** 提取文件中第一个类声明的类名(Java/C# 通用)。 */
export function classNameOf(code: string): string | null {
  const m = /\b(?:public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+(\w+)/.exec(code);
  return m?.[1] ?? null;
}

/**
 * 把类名统一改写为 newName:替换文件中所有旧类名 token(含内部静态自引用,
 * 如 ClassName.staticMethod),避免多个 public 类同名冲突。无旧类名时原样返回。
 */
export function renameClassName(code: string, newName: string): string {
  const old = classNameOf(code);
  if (!old || old === newName) return code;
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return code.replace(new RegExp(`\\b${escaped}\\b`, "g"), newName);
}

/** 剥离 package 声明(变体统一放入默认包,便于驱动按简单类名调用)。 */
export function stripPackageDeclaration(code: string): string {
  return code.replace(/^\s*package\s+[\w.]+\s*;\s*/m, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
