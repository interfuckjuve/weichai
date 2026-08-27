/**
 * filterVariants:论文「用既有测试过滤变体」的工程化映射。
 * - 基础输入集 = description 现有 cases 的 inputs(只用 inputs,不用 expected —— expected 正是不可靠的 oracle);
 * - 对每个变体:单独编译 → 基础输入集上运行 → 与源方法做「同语言差分」逐 case 比较(严格相等);
 * - 保留:编译通过且全部基础 case 与源方法行为一致;剔除编译失败 / 运行异常 / 行为不一致;
 * - 全部失败 → 参考组退化为 {源方法}(AID 不降级失败,由调用方记录)。
 *
 * 另导出 parseSourceContract 等解析辅助:源侧/变体侧驱动的构建需要从源方法文件
 * 解析类名/方法名/isStatic(与 e2e/run-e2e.ts 的声明行解析口径一致)。
 */
import { DEFAULT_EXCEPTION_ALIASES, valuesEqual } from "../comparator.js";
import type { TestCase, TestDescription, TypedValue, VerifierLanguage } from "../description.js";
import { generateDriverSource, generateSourceDriverSource } from "../driver/driver-codegen.js";
import type { SourceInvocation } from "../driver/source-invocation.js";
import type { DriverExecutor, SideSpec } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import type { CaseResult, SideResults } from "../result-capture.js";
import { parseSideResults } from "../result-capture.js";
import { executeSide } from "../verifier.js";

// ---------------------------------------------------------------------------
// 类型与接口(与设计文档 3.4 严格对齐)
// ---------------------------------------------------------------------------

export interface FilteredVariant {
  code: string;
  /** 可直接交给 executor 编译/运行(基础输入集驱动)。 */
  side: SideSpec;
  /** 与源方法在基础输入集上行为一致(可进入参考组)。 */
  passes: boolean;
  /** 剔除原因:编译失败 / 运行异常 / 行为不一致。 */
  reason?: string;
}

export interface VariantFilterOptions {
  /** 源侧(真实实现);其 sourceFiles 同时提供源方法文件供契约解析。 */
  sourceSide: SideSpec;
  /** 基础输入集(只用 inputs,不用 expected)。 */
  baseCases: { id: string; inputs: TypedValue[] }[];
  executor: DriverExecutor;
  logger?: Logger;
}

/** 从源方法文件解析出的调用契约(供驱动构建)。 */
export interface SourceContract {
  /** 静态调用类名(Java/C# 含包名前缀;Python/TS 模块级函数可为 undefined)。 */
  className?: string;
  method: string;
  isStatic: boolean;
}

// ---------------------------------------------------------------------------
// 源方法契约解析(声明行解析,不算检索;与 e2e/run-e2e.ts 口径一致)
// ---------------------------------------------------------------------------

/** 解析源方法文件的调用契约;无法解析时返回 null。 */
export function parseSourceContract(source: string, language: VerifierLanguage): SourceContract | null {
  if (language === "Python") {
    const m = /\bdef\s+(?!__init__\b)([A-Za-z_]\w*)\s*\(/.exec(source);
    return m ? { method: m[1] as string, isStatic: true } : null;
  }
  if (language === "TypeScript") {
    const moduleFn = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/.exec(source);
    if (moduleFn) return { method: moduleFn[1] as string, isStatic: true };
    const classMethod = /\b(?:export\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/.exec(source);
    return classMethod ? { method: classMethod[1] as string, isStatic: true } : null;
  }
  // Java / C#
  const pkg = /(?:^|\n)\s*(?:package\s+([\w.]+)\s*;|namespace\s+([\w.]+)\s*(?:;|\{))/.exec(source);
  const cls = /\bclass\s+(\w+)/.exec(source);
  if (!cls?.[1]) return null;
  const className = pkg ? `${pkg[1] ?? pkg[2]}.${cls[1]}` : cls[1];
  const block = classBlock(source, cls[1]);
  const snippet = block ? source.slice(block.start, block.end) : source;
  const staticM = /public\s+static\s+[\w<>[\].?]+\s+(\w+)\s*\(/.exec(snippet);
  if (staticM?.[1]) return { className, method: staticM[1], isStatic: true };
  const instanceM = /public\s+[\w<>[\].?]+\s+(\w+)\s*\(/.exec(snippet);
  if (instanceM?.[1]) return { className, method: instanceM[1], isStatic: false };
  return null;
}

/** 从源方法文件解析目标签名参数列表文本(供输入生成器提示词)。找不到时返回占位描述。 */
export function parseMethodSignature(source: string, contract: SourceContract): string {
  const method = contract.method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\b${method}\\s*\\(([^)]*)\\)`).exec(source);
  return m ? `${method}(${m[1]?.trim() ?? ""})` : `${method}(...)`;
}

/** 定位 class 声明块的起止(花括号配对;跳过字符串/字符/注释)。 */
function classBlock(source: string, className: string): { start: number; end: number } | null {
  const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\s*(?:<[^>]*>)?\\s*\\{`);
  const m = pattern.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingBrace(source, open);
  return { start: m.index, end: close };
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === '"') {
      i = skipQuoted(source, i, '"');
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(source, i, "'");
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced braces in source");
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i += 1;
  }
  return source.length - 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// 源侧 / 变体侧驱动与 SideSpec 构建
// ---------------------------------------------------------------------------

/** 语言的源文件扩展名。 */
export function variantExtension(language: VerifierLanguage): string {
  switch (language) {
    case "Java":
      return "java";
    case "C#":
      return "cs";
    case "Python":
      return "py";
    case "TypeScript":
      return "ts";
  }
}

/**
 * 为源侧 / 变体侧构建驱动(Java/C# 直接走 generateDriverSource;Python/TS 走
 * generateSourceDriverSource)。description 的 cases 决定驱动覆盖哪些输入。
 */
export function buildSideDriver(
  description: TestDescription,
  ctx: {
    language: VerifierLanguage;
    className?: string;
    method: string;
    isStatic: boolean;
    module?: string;
  },
): string {
  if (ctx.language === "Python" || ctx.language === "TypeScript") {
    const invocation: SourceInvocation = {
      language: ctx.language,
      module: ctx.module,
      className: ctx.className,
      method: ctx.method,
      isStatic: ctx.isStatic,
      constructorArgs: [],
    };
    return generateSourceDriverSource(description, invocation);
  }
  return generateDriverSource({
    ...description,
    target: {
      language: ctx.language,
      className: ctx.className ?? "Unknown",
      method: ctx.method,
      isStatic: ctx.isStatic,
      constructorArgs: [],
    },
  });
}

/** 为参考组一侧构建完整 SideSpec(驱动 + 源文件)。 */
export function buildReferenceSide(
  description: TestDescription,
  language: VerifierLanguage,
  contract: SourceContract,
  options: { className?: string; module?: string; sourceFiles?: SideSpec["sourceFiles"] } = {},
): SideSpec {
  return {
    language,
    driverSource: buildSideDriver(description, {
      language,
      className: options.className ?? contract.className,
      method: contract.method,
      isStatic: contract.isStatic,
      module: options.module,
    }),
    sourceFiles: options.sourceFiles ?? [],
  };
}

/** 为第 index 个变体构建 SideSpec(类名按代码内实际类名命名文件,兼容过滤后序号)。 */
export function buildVariantSideSpec(
  description: TestDescription,
  language: VerifierLanguage,
  contract: SourceContract,
  code: string,
  index: number,
): SideSpec {
  const name = classNameOfVariant(code) ?? `Variant_${index}`;
  return buildReferenceSide(description, language, contract, {
    className: name,
    module: language === "Python" ? name : language === "TypeScript" ? `${name}.ts` : undefined,
    sourceFiles: [{ relativePath: `${name}.${variantExtension(language)}`, content: code }],
  });
}

/** 变体代码中的类名(Java/C#;Python/TS 无类名时回退 undefined)。 */
function classNameOfVariant(code: string): string | null {
  const m = /\b(?:public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+(\w+)/.exec(code);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// 同语言差分过滤
// ---------------------------------------------------------------------------

/**
 * 对每个变体执行「编译 → 基础输入集运行 → 与源方法逐 case 同语言差分」。
 * 返回保留清单(passes === true);全部失败时返回空保留清单(调用方回退参考组为 {源方法})。
 */
export async function filterVariants(
  variants: string[],
  options: VariantFilterOptions,
): Promise<FilteredVariant[]> {
  const { sourceSide, baseCases, executor, logger = createLogger("variant-filter") } = options;
  const language = sourceSide.language;
  const sourceContent = sourceSide.sourceFiles.map((f) => f.content).join("\n");
  const contract = parseSourceContract(sourceContent, language);

  if (!contract) {
    logger.error("无法解析源侧契约(类名/方法名),变体过滤无法进行");
    return variants.map((code, i) => ({
      code,
      side: buildVariantSideSpec(emptyDescription(language), language, { method: "unknown", isStatic: true }, code, i + 1),
      passes: false,
      reason: "cannot parse source contract",
    }));
  }

  // 基础输入集描述:仅用 inputs;expected 为占位(过滤不做黄金校验)。
  const baseDescription = buildBaseDescription(language, contract, baseCases);

  // 源方法在基础输入集上的参考输出。
  const sourceSpec = buildReferenceSide(baseDescription, language, contract, { sourceFiles: sourceSide.sourceFiles });
  const sourceInfo = await executeSide(executor, sourceSpec, "source");
  const sourceResults = sourceInfo.results;
  if (!sourceResults || sourceResults.results.length === 0) {
    logger.error("源方法在基础输入集上未产生可用结果,全部变体视为不通过(参考组将退化为仅源方法)");
    return variants.map((code, i) => ({
      code,
      side: buildVariantSideSpec(baseDescription, language, contract, code, i + 1),
      passes: false,
      reason: "source produced no usable base results",
    }));
  }
  const sourceCaseById = new Map(sourceResults.results.map((r) => [r.caseId, r]));

  const filtered: FilteredVariant[] = [];
  for (let i = 0; i < variants.length; i += 1) {
    const index = i + 1;
    const code = variants[i] as string;
    const side = buildVariantSideSpec(baseDescription, language, contract, code, index);
    const compile = await executor.compile(side);
    if (!compile.success) {
      const reason = `compile failed: ${compile.errors.join("; ") || "no diagnostics"}`;
      logger.warn(`变体 ${index} 编译失败:${reason}`);
      filtered.push({ code, side, passes: false, reason });
      continue;
    }
    const run = await executor.run(side);
    if (run.exitCode !== 0) {
      const reason = `run failed: ${truncate(run.stderr, 200)}`;
      logger.warn(`变体 ${index} 运行失败:${reason}`);
      filtered.push({ code, side, passes: false, reason });
      continue;
    }
    const parsed = parseVariantResults(`Variant_${index}`, run.stdout);
    const variantCaseById = new Map(parsed.results.map((r) => [r.caseId, r]));
    const mismatches: string[] = [];
    for (const base of baseCases) {
      const sourceResult = sourceCaseById.get(base.id);
      const variantResult = variantCaseById.get(base.id);
      if (!sourceResult || !variantResult) {
        mismatches.push(
          `case ${base.id}: missing result (source=${sourceResult ? "ok" : "missing"}, variant=${variantResult ? "ok" : "missing"})`,
        );
        continue;
      }
      if (!sameLanguageResultEqual(sourceResult, variantResult)) {
        mismatches.push(`case ${base.id}: behavior divergence`);
      }
    }
    const passes = mismatches.length === 0;
    filtered.push({ code, side, passes, reason: passes ? undefined : mismatches.join("; ") });
    logger.info(`变体 ${index}:${passes ? "保留(与源方法行为一致)" : `剔除(${mismatches.join("; ")})`}`);
  }
  logger.info(`过滤完成:${filtered.filter((v) => v.passes).length}/${variants.length} 个变体保留`);
  return filtered;
}

/** 基础输入集描述(目标 = 源契约,语言 = 源语言)。 */
export function buildBaseDescription(
  language: VerifierLanguage,
  contract: SourceContract,
  baseCases: { id: string; inputs: TypedValue[] }[],
): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: language as "Java" | "C#",
      className: contract.className ?? "Unknown",
      method: contract.method,
      isStatic: contract.isStatic,
      constructorArgs: [],
    },
    cases: baseCases.map((c) => ({
      id: c.id,
      inputs: c.inputs,
      expected: { kind: "return", value: { type: "null", value: null } } as TestCase["expected"],
    })),
  };
}

/** 空描述(无法解析契约时的占位;仅用于构造不可执行的 side)。 */
function emptyDescription(language: VerifierLanguage): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: language as "Java" | "C#",
      className: "Unknown",
      method: "unknown",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [{ id: "placeholder", inputs: [], expected: { kind: "return", value: { type: "null", value: null } } }],
  };
}

/** 解析变体运行输出(与 parseSideResults 同构,side 标签为变体名)。 */
export function parseVariantResults(side: string, stdout: string): SideResults {
  // 直接复用现有解析器(已导出),避免重复实现。
  return parseSideResults(side, stdout);
}

/**
 * 同语言差分相等:两侧同为 return → valuesEqual(严格);同为 exception → 归一化异常类型相等
 * (同语言下别名映射恒等,归一化仅为与跨语言比较口径一致);outcome 不同 → 不等。
 */
export function sameLanguageResultEqual(a: CaseResult, b: CaseResult): boolean {
  if (a.outcome !== b.outcome) return false;
  if (a.outcome === "exception") {
    return normalizeExceptionType(a.exceptionType ?? "") === normalizeExceptionType(b.exceptionType ?? "");
  }
  if (a.returnValue === undefined || b.returnValue === undefined) return a.returnValue === b.returnValue;
  return valuesEqual(a.returnValue, b.returnValue);
}

function normalizeExceptionType(type: string): string {
  const simple = type.split(".").at(-1) ?? type;
  return DEFAULT_EXCEPTION_ALIASES[simple] ?? simple;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
