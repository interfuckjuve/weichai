#!/usr/bin/env node
/**
 * translation-verifier E2E 验收脚本(不依赖 vitest;由 agent 驱动的验收机制)。
 *
 * 数据流(检索/迁移与验证分离):
 * - 候选检索由上游混合检索服务 POST /v1/search 完成(向量+全文+RRF+rerank,返回 SearchCandidate);
 *   agent 按 path 从语料读完整方法体;测试自寻(测试不在索引)由 agent 在同仓库内文件搜索。
 *   本脚本只接收整理好的纯输入:
 *   --source-method(源语言完整方法体文件)、--source-tests(相关测试,仅参考)、
 *   --target-file(Java 翻译产物文件,翻译由 agent 在调度时完成)。
 * - 描述生成:有 DEEPSEEK_API_KEY → 默认 TestMigratorAgent(claude 子进程,需求第一);
 *   指定 --generator mitgen → MitGenMigratorAgent(片段级微观测试生成,源侧实跑录制 expected);
 *   无 key → 用 --fixture(手写语言无关描述 JSON)保证离线可跑通。
 * - 验证机制:双侧真实工具链(javac/dotnet)编译运行 → 差分比较 + 需求黄金校验。
 * - 阶段 D(可选 --analyzer):DISTINCT 描述引导的分支一致性分析 —— 缺陷源实现 + 忠实镜像的
 *   翻译产物(双侧共享缺陷)在旧流程下差分全 PASS(行为等价率高但漏检);Analyzer 以 NLD 为锚
 *   把"两侧一致但都偏离需求"的 case 标 diverges/flag-fail,演示检错率(DDR)提升。需 LLM key。
 * - 注入 bug 演示:把目标方法体替换为固定错误返回值 → 重新 verify → 断言检出 FAIL。
 * - 分支级 bug 演示(仅 --generator mitgen --branch-bug):翻转目标方法内单个比较运算符
 *   (bug 藏在单个分支),验证 MitGen 片段级用例能覆盖此前整方法生成常漏检的分支/边界。
 * - 修复闭环演示(有 key):RepairLoop + RepairAgent(claude 子进程)从注入 bug 的
 *   目标文件出发,最多 maxRounds 轮修复,rebuildTargetSide 用修复产物替换目标文件。
 *
 * 退出码:全部验收 PASS=0;验收 FAIL(翻译产物有差异/修复后仍 FAIL)=1;参数/运行错误=2。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { validateDescription, type TestDescription, type VerifierLanguage } from "../src/description.js";
import { matchingBrace, escapeRegExp } from "../src/code-utils.js";
import { generateDriverSource, generateSourceDriverSource } from "../src/driver/driver-codegen.js";
import type { SourceInvocation } from "../src/driver/source-invocation.js";
import { isToolchainAvailable, RealDriverExecutor, type SideSpec } from "../src/executor.js";
import { verify, type VerificationJob, type VerificationReport } from "../src/verifier.js";
import { formatReport } from "../src/cli-helpers.js";
import { TestMigratorAgent } from "../src/test-migrator.js";
import { MitGenMigratorAgent } from "../src/mitgen/mitgen-migrator.js";
import { RepairAgent, RepairLoop } from "../src/repair-loop.js";
import { createTestStrategy } from "../src/strategies/index.js";
import type { ConsistencyResult } from "../src/distinct/consistency-verifier-types.js";
import { createLogger, type Logger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

export interface E2EOptions {
  requirement: string;
  sourceMethod: string;
  sourceTests?: string;
  targetFile: string;
  sourceLang: VerifierLanguage;
  fixture: string;
  apiKey?: string;
  targetClass?: string;
  targetMethod?: string;
  maxRounds: number;
  timeoutMs: number;
  json: boolean;
  /** --analyzer:开启阶段 D(DISTINCT 分支一致性分析,双侧共享缺陷演示)。 */
  analyzer: boolean;
  /** 描述生成器:migrator=TestMigratorAgent(默认,现有验收路径);mitgen=MitGenMigratorAgent(片段级)。 */
  generator: "mitgen" | "migrator";
  /** 分支级 bug 注入 + MitGen 检出演示(仅 --generator mitgen 时生效,默认关闭)。 */
  branchBug: boolean;
}

const VALUE_FLAGS = new Set([
  "--requirement",
  "--source-method",
  "--source-tests",
  "--target-file",
  "--source-lang",
  "--fixture",
  "--api-key",
  "--target-class",
  "--target-method",
  "--max-rounds",
  "--timeout-ms",
  "--generator",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--analyzer", "--branch-bug"]);

/**
 * 解析 CLI 参数(`--key value` 格式)。必填:--requirement/--source-method/--target-file;
 * 可选:--source-tests/--source-lang(默认 C#)/--fixture/--api-key/--target-class/--target-method/
 * --max-rounds(默认 3)/--timeout-ms(LLM 调用超时,默认 300000)/--json/--generator(migrator|mitgen,默认 migrator)/
 * --branch-bug(MitGen 分支级 bug 检出演示)。非法参数 → { error }。
 */
export function parseArgs(argv: string[]): E2EOptions | { error: string } {
  const options: E2EOptions = {
    requirement: "",
    sourceMethod: "",
    targetFile: "",
    sourceLang: "C#",
    // 默认 fixture 相对脚本所在目录(e2e/);显式传入的 --fixture 按 CWD 解析。
    fixture: fileURLToPath(new URL("./fixtures/mime-util-description.json", import.meta.url)),
    maxRounds: 3,
    timeoutMs: 300_000,
    json: false,
    analyzer: false,
    generator: "migrator",
    branchBug: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      if (flag === "--analyzer") options.analyzer = true;
      if (flag === "--branch-bug") options.branchBug = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined) return { error: `Missing value for ${flag}.` };
      i += 1;
      switch (flag) {
        case "--requirement":
          options.requirement = value;
          break;
        case "--source-method":
          options.sourceMethod = value;
          break;
        case "--source-tests":
          options.sourceTests = value;
          break;
        case "--target-file":
          options.targetFile = value;
          break;
        case "--source-lang": {
          if (value !== "Java" && value !== "C#" && value !== "Python" && value !== "TypeScript") {
            return { error: `Invalid --source-lang: "${value}" (must be Java, C#, Python, or TypeScript).` };
          }
          options.sourceLang = value;
          break;
        }
        case "--fixture":
          options.fixture = value;
          break;
        case "--api-key":
          options.apiKey = value;
          break;
        case "--target-class":
          options.targetClass = value;
          break;
        case "--target-method":
          options.targetMethod = value;
          break;
        case "--max-rounds": {
          if (!/^\d+$/.test(value)) {
            return { error: `Invalid --max-rounds: "${value}" (must be a non-negative integer).` };
          }
          options.maxRounds = Number.parseInt(value, 10);
          break;
        }
        case "--timeout-ms": {
          if (!/^\d+$/.test(value)) {
            return { error: `Invalid --timeout-ms: "${value}" (must be a non-negative integer).` };
          }
          options.timeoutMs = Number.parseInt(value, 10);
          break;
        }
        case "--generator": {
          if (value !== "mitgen" && value !== "migrator") {
            return { error: `Invalid --generator: "${value}" (must be mitgen or migrator).` };
          }
          options.generator = value;
          break;
        }
      }
      continue;
    }
    return { error: `Unknown option: ${flag}` };
  }
  if (!options.requirement.trim()) return { error: "Missing required option: --requirement <text>." };
  if (!options.sourceMethod) return { error: "Missing required option: --source-method <path>." };
  if (!options.targetFile) return { error: "Missing required option: --target-file <path>." };
  return options;
}

// ---------------------------------------------------------------------------
// 声明行解析(仅解析声明,不算检索;目标类名/方法名优先由参数/描述给出)
// ---------------------------------------------------------------------------

/** 从目标文件解析 public 类名:package 声明 + public class 声明组合为全限定名。 */
export function parseTargetClassName(source: string): string | null {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(source);
  const cls = /public\s+class\s+(\w+)/.exec(source);
  if (!cls?.[1]) return null;
  return pkg ? `${pkg[1]}.${cls[1]}` : cls[1];
}

/** 从目标文件解析第一个 public static 方法的声明行方法名。 */
export function parseTargetMethodName(source: string): string | null {
  const m = /public\s+static\s+[\w<>[\].]+\s+(\w+)\s*\(/.exec(source);
  return m?.[1] ?? null;
}

/** 从源文件解析类名(含 namespace 时返回全限定名);取第一个 class 声明。 */
export function parseSourceClassName(source: string): string | null {
  const ns = /(?:^|\n)\s*namespace\s+([\w.]+)\s*(?:;|\{)/.exec(source);
  const cls = /\bclass\s+(\w+)/.exec(source);
  if (!cls?.[1]) return null;
  return ns ? `${ns[1]}.${cls[1]}` : cls[1];
}

/** 在类块内找第一个 public static 方法名(C# 源侧驱动需要源语言方法名)。 */
export function parseSourceMethodName(source: string, className: string): string | null {
  if (/\bdef\s+/.test(source)) {
    const pythonMethod = /\bdef\s+(?!__init__\b)([A-Za-z_]\w*)\s*\(/.exec(source);
    return pythonMethod?.[1] ?? null;
  }
  const block = classBlock(source, className);
  if (!block) {
    const moduleFunction = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/.exec(source);
    return moduleFunction?.[1] ?? null;
  }
  const snippet = source.slice(block.start, block.end);
  const m = /public\s+static\s+[\w<>[\].?]+\s+(\w+)\s*\(/.exec(snippet);
  if (m?.[1]) return m[1];
  const typeScriptMethod = /(?:static\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::[^\{]+)?\s*\{/.exec(snippet);
  return typeScriptMethod?.[1] ?? null;
}

/** 定位 class 声明块的起止(花括号配对;仅用于方法名声明行解析)。 */
function classBlock(source: string, className: string): { start: number; end: number } | null {
  const simple = className.split(".").pop() as string;
  const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(simple)}\\s*(?:<[^>]*>)?\\s*\\{`);
  const m = pattern.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchingBrace(source, open);
  return { start: m.index, end: close };
}

// ---------------------------------------------------------------------------
// 注入 bug(替换目标方法体为固定错误返回值)
// ---------------------------------------------------------------------------

/** 把目标方法体替换为固定错误返回值(如字符串方法返回 "buggy"),用于演示差分验证能检出缺陷。 */
export function injectBug(source: string, className: string, methodName: string): string {
  const simple = className.split(".").pop() as string;
  const block = classBlock(source, simple);
  if (!block) throw new Error(`cannot locate class ${simple} for bug injection`);
  const snippet = source.slice(block.start, block.end);
  const decl = new RegExp(
    `public\\s+static\\s+([\\w<>[\\].]+)\\s+${escapeRegExp(methodName)}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const dm = decl.exec(snippet);
  if (!dm) throw new Error(`cannot locate method ${simple}.${methodName} for bug injection`);
  const open = block.start + dm.index + dm[0].length - 1;
  const close = matchingBrace(source, open);
  return `${source.slice(0, open + 1)}\n    ${buggyReturnFor(dm[1] as string)}\n  ${source.slice(close)}`;
}

/** 按目标方法返回类型挑选固定错误返回值(保证编译通过,行为明显错误)。 */
function buggyReturnFor(returnType: string): string {
  const t = returnType.trim();
  if (t === "String") return 'return "buggy";';
  if (/\[\]/.test(t) || /^byte/.test(t)) return "return new byte[] { 1, 2, 3 };";
  if (/^boolean$/i.test(t)) return "return false;";
  if (/^(int|long|short)$/.test(t)) return "return -999;";
  if (/^(double|float)$/.test(t)) return "return -999.0;";
  return "return null;";
}

/**
 * 分支级 bug 注入:把目标方法体内第一个比较运算符翻转(`<`↔`>=`、`==`↔`!=` 等)。
 * 与 injectBug(整方法体替换)不同,bug 藏在单个分支/边界里,整方法生成常漏检——
 * 这正是 MitGen 片段级定向输入的目标场景。
 */
export function injectBranchBug(source: string, className: string, methodName: string): string {
  const simple = className.split(".").pop() as string;
  const block = classBlock(source, simple);
  if (!block) throw new Error(`cannot locate class ${simple} for branch bug injection`);
  const snippet = source.slice(block.start, block.end);
  const decl = new RegExp(
    `public\\s+static\\s+([\\w<>[\\].]+)\\s+${escapeRegExp(methodName)}\\s*\\([^)]*\\)\\s*\\{`,
  );
  const dm = decl.exec(snippet);
  if (!dm) throw new Error(`cannot locate method ${simple}.${methodName} for branch bug injection`);
  const open = block.start + dm.index + dm[0].length - 1;
  const close = matchingBrace(source, open);
  const body = source.slice(open, close + 1);
  const flipped = body.replace(/(<=|>=|==|!=|<|>)/, (op) => {
    const map: Record<string, string> = { "<": ">=", ">": "<=", "<=": ">", ">=": "<", "==": "!=", "!=": "==" };
    return map[op] as string;
  });
  return `${source.slice(0, open)}${flipped}${source.slice(close + 1)}`;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 修复产物补全 package 声明:LLM 输出可能省略包名,而驱动按全限定名调用,必须对齐原目标文件。 */
export function prepareRepairOutput(repairCode: string, originalTarget: string): string {
  const code = repairCode.trim();
  if (/^\s*package\b/m.test(code)) return code;
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(originalTarget);
  if (!pkg) return code;
  return `package ${pkg[1]};\n\n${code}`;
}

// ---------------------------------------------------------------------------
// E2E 主流程
// ---------------------------------------------------------------------------

/**
 * 运行 E2E 验收,返回退出码:
 * 0=全部 PASS(真实翻译验证全 PASS、注入 bug 被检出、修复闭环收敛);
 * 1=验收 FAIL(翻译产物有差异 / 注入 bug 未被检出 / 修复后仍 FAIL);
 * 2=参数或运行错误。
 */
export async function runE2E(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = "logs";
  const parsed = parseArgs(argv);
  // --json:stdout 只输出最终报告 JSON,控制台日志降为 ERROR(仅 stderr);文件日志(DEBUG)不受影响。
  if (!("error" in parsed) && parsed.json) {
    process.env.VERIFIER_LOG_LEVEL = "ERROR";
  }
  const logger = createLogger("e2e");

  if ("error" in parsed) {
    logger.error(`参数错误:${parsed.error}`);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  logger.info(
    `E2E 开始:requirement="${truncate(parsed.requirement, 120)}", source-lang=${parsed.sourceLang}, fixture=${parsed.fixture}`,
  );

  // 0. 工具链预检(双侧真实编译/运行)。
  if (!isToolchainAvailable("Java")) {
    logger.error("javac/java 不可用:Java 目标侧验证无法进行");
    console.error("error: javac is not available on PATH (Java target side verification requires it).");
    return 2;
  }
  if (!isToolchainAvailable(parsed.sourceLang)) {
    logger.error(`${parsed.sourceLang} 工具链不可用:源侧验证无法进行`);
    console.error(`error: ${parsed.sourceLang} toolchain is not available (source side verification requires it).`);
    return 2;
  }

  // 1. 读取整理好的纯输入(source-method 完整方法体 / target-file 翻译产物 / source-tests 参考测试)。
  let sourceContent: string;
  let targetContent: string;
  let testsContent: string | undefined;
  try {
    sourceContent = readFileSync(resolve(parsed.sourceMethod), "utf-8");
  } catch (error) {
    logger.error(`读取源方法体失败 ${parsed.sourceMethod}:${errorMessage(error)}`);
    console.error(`error: cannot read --source-method ${parsed.sourceMethod}: ${errorMessage(error)}`);
    return 2;
  }
  try {
    targetContent = readFileSync(resolve(parsed.targetFile), "utf-8");
  } catch (error) {
    logger.error(`读取目标翻译产物失败 ${parsed.targetFile}:${errorMessage(error)}`);
    console.error(`error: cannot read --target-file ${parsed.targetFile}: ${errorMessage(error)}`);
    return 2;
  }
  if (parsed.sourceTests !== undefined) {
    try {
      testsContent = readFileSync(resolve(parsed.sourceTests), "utf-8");
    } catch (error) {
      logger.error(`读取源测试失败 ${parsed.sourceTests}:${errorMessage(error)}`);
      console.error(`error: cannot read --source-tests ${parsed.sourceTests}: ${errorMessage(error)}`);
      return 2;
    }
  }
  logger.info(
    `读取输入:source-method=${parsed.sourceMethod}(${sourceContent.length} chars), target-file=${parsed.targetFile}(${targetContent.length} chars)${testsContent !== undefined ? `, source-tests=${parsed.sourceTests}(${testsContent.length} chars)` : ""}`,
  );

  // 2. 目标类名/方法名:优先 --target-class/--target-method,缺省从目标文件 public class/方法声明解析
  //   (仅声明行,不算检索)。
  const targetClassName = parsed.targetClass ?? parseTargetClassName(targetContent);
  const targetMethodName = parsed.targetMethod ?? parseTargetMethodName(targetContent);
  if (!targetClassName || !targetMethodName) {
    logger.error(`无法解析目标签名:className=${String(targetClassName)}, method=${String(targetMethodName)};请传 --target-class/--target-method`);
    console.error(
      "error: cannot resolve the target signature. Pass --target-class and --target-method, or make the target file declare a public class with a public static method.",
    );
    return 2;
  }
  logger.info(`目标签名:${targetClassName}.${targetMethodName}`);

  // 3. 源侧类名/方法名(从 agent 整理的完整方法体文件声明行解析;MitGen 片段生成/实跑也依赖)。
  const sourceClassName = parseSourceClassName(sourceContent);
  const sourceMethodName = parseSourceMethodName(sourceContent, sourceClassName ?? "");
  if (!sourceClassName || !sourceMethodName) {
    logger.error(`无法从 source-method 解析源类名/方法名:${String(sourceClassName)}.${String(sourceMethodName)}`);
    console.error("error: cannot resolve the source class/method from --source-method (expects a single-class method-body file).");
    return 2;
  }
  logger.info(`源侧签名:${sourceClassName}.${sourceMethodName}`);

  // 4. 执行器(双侧真实工具链;MitGen 片段级插桩实跑也用它)。
  const executor = new RealDriverExecutor({ logger });

  // 5. 描述生成:有 key → 按 --generator 选择 TestMigratorAgent(默认,现有验收路径)或
  //    MitGenMigratorAgent(片段级定向输入 + 源侧实跑录制 expected);无 key → fixture(离线路径)。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  let description: TestDescription;
  let mitgenSummary: string | undefined;
  if (apiKey && apiKey.trim() !== "") {
    if (parsed.generator === "mitgen") {
      logger.info("阶段[描述]:MitGenMigratorAgent.generate(片段级微观测试生成 + 源侧实跑录制 expected)");
      const mitgen = new MitGenMigratorAgent({ apiKey, logger, timeoutMs: parsed.timeoutMs, methodName: sourceMethodName });
      try {
        const mitgenResult = await mitgen.generate(
          {
            requirement: parsed.requirement,
            sourceLanguage: parsed.sourceLang,
            sourceCode: sourceContent,
            existingTests: testsContent,
            repository: parsed.sourceLang === "C#" ? "commons-fileupload-csharp" : undefined,
            sourcePath: parsed.sourceMethod,
            targetCode: targetContent,
            target: { language: "Java", className: targetClassName, method: targetMethodName, isStatic: true },
          },
          executor,
        );
        description = mitgenResult.description;
        const verified = mitgenResult.fragments.filter((f) => f.reachability === "verified").length;
        mitgenSummary = `片段 ${mitgenResult.fragments.length} 个(verified ${verified}),case ${description.cases.length} 个`;
      } catch (error) {
        logger.error(`MitGenMigratorAgent 失败:${errorMessage(error)}`);
        console.error(`error: MitGenMigratorAgent failed: ${errorMessage(error)}`);
        return 2;
      }
      logger.info(`阶段[描述]:MitGen 生成完成,${description.cases.length} 个 case`);
    } else {
      logger.info("阶段[描述]:TestMigratorAgent.extractDescription(claude 子进程,需求第一)");
      const migrator = new TestMigratorAgent({ apiKey, logger, timeoutMs: parsed.timeoutMs });
      try {
        description = await migrator.extractDescription({
          requirement: parsed.requirement,
          sourceLanguage: parsed.sourceLang,
          sourceCode: sourceContent,
          existingTests: testsContent,
          repository: parsed.sourceLang === "C#" ? "commons-fileupload-csharp" : undefined,
          sourcePath: parsed.sourceMethod,
          target: { language: "Java", className: targetClassName, method: targetMethodName, isStatic: true },
        });
      } catch (error) {
        logger.error(`TestMigratorAgent 失败:${errorMessage(error)}`);
        console.error(`error: TestMigratorAgent failed: ${errorMessage(error)}`);
        return 2;
      }
      logger.info(`阶段[描述]:生成完成,${description.cases.length} 个 case`);
    }
  } else {
    logger.info(`阶段[描述]:无 DEEPSEEK_API_KEY,读取 fixture ${parsed.fixture}(离线路径)${parsed.generator === "mitgen" ? ";指定 --generator mitgen 但无 key,回退 fixture" : ""}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(parsed.fixture), "utf-8"));
    } catch (error) {
      logger.error(`读取/解析 fixture 失败 ${parsed.fixture}:${errorMessage(error)}`);
      console.error(`error: cannot read/parse --fixture ${parsed.fixture}: ${errorMessage(error)}`);
      return 2;
    }
    try {
      description = validateDescription(raw);
    } catch (error) {
      logger.error(`fixture 校验失败:${errorMessage(error)}`);
      console.error(`error: fixture failed validation: ${errorMessage(error)}`);
      return 2;
    }
  }
  // 强制对齐目标签名(LLM/fixture 输出可能与实际目标文件不一致,以参数/目标文件解析为准)。
  description = {
    ...description,
    target: {
      ...description.target,
      language: "Java",
      className: targetClassName,
      method: targetMethodName,
      isStatic: true,
    },
  };
  // 需求第一:描述 requirement 为空时挂载 --requirement。
  if (description.requirement === undefined || description.requirement.trim() === "") {
    description = { ...description, requirement: parsed.requirement };
  }

  // 6. 双侧驱动(描述是唯一契约)。
  const targetSide = (content: string): SideSpec => ({
    language: "Java",
    driverSource: generateDriverSource(description),
    sourceFiles: [{ relativePath: `${targetClassName.split(".").pop()}.java`, content }],
  });
  const sourceModule = parsed.sourceLang === "Python" ? "source" : parsed.sourceLang === "TypeScript" ? "source.ts" : undefined;
  const sourceInvocation: SourceInvocation = {
    language: parsed.sourceLang,
    module: sourceModule,
    className: sourceClassName ?? undefined,
    method: sourceMethodName,
    isStatic: true,
    constructorArgs: [],
  };
  const sourceExtension = parsed.sourceLang === "Java" ? "java" : parsed.sourceLang === "C#" ? "cs" : parsed.sourceLang === "Python" ? "py" : "ts";
  const sourceSide: SideSpec = {
    language: parsed.sourceLang,
    driverSource: generateSourceDriverSource(description, sourceInvocation),
    sourceFiles: [{ relativePath: `source.${sourceExtension}`, content: sourceContent }],
  };
  const makeJob = (target: SideSpec): VerificationJob => ({ description, source: sourceSide, target });

  let exitCode = 0;
  // --json 模式下 stdout 只输出最终报告 JSON;人类可读报告/演示提示仅在非 json 模式打印。
  const printReport = (report: VerificationReport): void => {
    if (!parsed.json) console.log(formatReport(report, description));
  };
  const notice = (msg: string): void => {
    if (!parsed.json) console.log(msg);
  };
  if (mitgenSummary !== undefined) {
    notice(`MitGen 摘要:${mitgenSummary}(case id 形如 frag-<n>-<k>;expected 由源侧实跑录制)。`);
  }

  // 6. 阶段 A:真实翻译产物验证(验收主体)。
  logger.info("阶段[A]:验证翻译产物(差分验证 + 需求黄金校验)");
  const stageA = await verify(makeJob(targetSide(targetContent)), executor, logger);
  printReport(stageA);
  logger.info(`阶段[A] 验证:passRate=${stageA.passRate.toFixed(2)} (pass=${stageA.passedCases} fail=${stageA.failedCases} divergent=${stageA.divergentCases})`);
  if (stageA.failedCases > 0 || stageA.divergentCases > 0) {
    exitCode = 1;
    logger.error("阶段[A] 未全 PASS:翻译产物与源侧存在差异(或偏离需求)");
  }

  // 7. 阶段 D(可选,--analyzer):DISTINCT 分支一致性分析 —— 双侧共享缺陷演示(黑盒)。
  //    Task 4 起 LlmAnalyzer/runConsistencyVerification 删除,改为调 createTestStrategy("distinct")
  //    自主会话(真实 claude,读源/目标参考目录;报告 detail = ConsistencyResult)。
  //    演示预期:缺陷源实现 + 忠实镜像的翻译产物 → 差分两侧一致 → 旧流程全 PASS(漏检);
  //    DISTINCT 以 NLD 为锚标记 diverges/flag-fail → 阶段 D 判定检出(对应论文 DDR 提升)。
  if (parsed.analyzer) {
    if (!apiKey || apiKey.trim() === "") {
      logger.error("阶段[D] 需要 DEEPSEEK_API_KEY(--api-key 可覆盖)");
      console.error("error: --analyzer requires DEEPSEEK_API_KEY (or --api-key).");
      return 2;
    }
    logger.info("阶段[D]:DISTINCT 分支一致性分析(自主会话黑盒,真实 claude)");
    // 参考目录:源/目标文件各自所在目录(只读沙箱;文件内容同时内嵌于 job,双保险)。
    const distinctRunner = createTestStrategy("distinct", {
      llm: { apiKey, timeoutMs: parsed.timeoutMs },
      keepGeneratedTests: true,
      maxTurns: 50,
    });
    let strategyReport;
    try {
      strategyReport = await distinctRunner.run({
        requirement: parsed.requirement,
        source: {
          language: parsed.sourceLang,
          root: dirname(resolve(parsed.sourceMethod)),
          files: [{ relativePath: basename(resolve(parsed.sourceMethod)), content: sourceContent }],
        },
        target: {
          language: "Java",
          className: targetClassName,
          method: targetMethodName,
          isStatic: true,
          file: basename(resolve(parsed.targetFile)),
          root: dirname(resolve(parsed.targetFile)),
          files: [{ relativePath: basename(resolve(parsed.targetFile)), content: targetContent }],
        },
      });
    } catch (error) {
      logger.error(`阶段[D] distinct 策略运行失败:${errorMessage(error)}`);
      console.error(`error: stage D distinct strategy failed: ${errorMessage(error)}`);
      return 2;
    }
    if (strategyReport.status === "error") {
      logger.error(`阶段[D] distinct 策略 error:${strategyReport.summary}`);
      console.error(`error: stage D distinct strategy returned error status: ${strategyReport.summary}`);
      return 2;
    }
    logger.info(`阶段[D] 自主会话完成:status=${strategyReport.status}${strategyReport.keptDir ? `,keptDir=${strategyReport.keptDir}` : ""}`);
    const consistency = (strategyReport.detail as ConsistencyResult).consistency;
    const total = consistency.inventory.branches.length;
    const covered = consistency.coverage.covered.length;
    const diverging = consistency.cases.filter((c) => c.nldVerdict === "diverges" || c.recommend === "flag-fail");
    logger.info(
      `阶段[D] 分支清单:${total} 个分支(方法 ${consistency.inventory.methodId}),差分覆盖率 ${covered}/${total}`,
    );
    notice(`Analyzer 分支清单:${total} 个分支,差分覆盖率 ${covered}/${total}${consistency.augmentations.length > 0 ? `,augmentation 补测 ${consistency.augmentations.length} 个 case` : ""}`);
    for (const c of diverging) {
      notice(`Analyzer 检出 [${c.caseId}] nldVerdict=${c.nldVerdict} recommend=${c.recommend}: ${c.reasons.join("; ")}`);
      logger.warn(`阶段[D] 检出 case ${c.caseId}: ${c.reasons.join("; ")}`);
    }
    if (diverging.length > 0) {
      logger.info(`阶段[D] 检出 ${diverging.length} 个"双侧一致但偏离需求"的 case(旧流程全 PASS,检错率提升)`);
      notice(`阶段[D] 结果:检出 ${diverging.length} 个 case 两侧差分一致但偏离需求 —— 旧流程全 PASS,新流程检出(对应 DDR 提升)。`);
    } else {
      exitCode = 1;
      logger.error("阶段[D] 未检出偏离需求的 case:Analyzer 未能识别共享缺陷(演示失败)");
    }
  } else {
    logger.info("阶段[D]:跳过(未传 --analyzer;开启需 DEEPSEEK_API_KEY 或 --api-key)");
  }

  // 8. 阶段 B:注入 bug 演示 —— 把目标方法体替换为固定错误返回值,验证差分机制能检出 FAIL。
  logger.info("阶段[B]:注入 bug 演示(目标方法体 → 固定错误返回值)");
  const buggyTarget = injectBug(targetContent, targetClassName, targetMethodName);
  logger.debug(`注入 bug 后的目标文件:\n${buggyTarget}`);
  const buggyReport = await verify(makeJob(targetSide(buggyTarget)), executor, logger);
  printReport(buggyReport);
  logger.info(`阶段[B] 验证:passRate=${buggyReport.passRate.toFixed(2)} (pass=${buggyReport.passedCases} fail=${buggyReport.failedCases} divergent=${buggyReport.divergentCases})`);
  const bugDetected = buggyReport.failedCases > 0 || buggyReport.divergentCases > 0;
  if (bugDetected) {
    logger.info("阶段[B] 注入 bug 检出:FAIL(演示符合预期:差分验证能检出注入缺陷)");
    notice("注入 bug 检出:FAIL —— 差分验证按预期检出了注入缺陷(该轮单独验证的退出码语义为 1)。");
  } else {
    exitCode = 1;
    logger.error("阶段[B] 注入 bug 未被检出:验证仍全 PASS,差分机制失效");
    console.error("error: injected bug was NOT detected (verification still all-PASS); differential mechanism broken.");
  }

  // 阶段 B2(仅 --generator mitgen + --branch-bug):分支级 bug 注入 + MitGen 检出演示。
  // 与阶段 B(整方法体替换)不同,这里只翻转目标方法内的单个比较运算符(bug 藏在单个分支),
  // 验证 MitGen 片段级定向输入能覆盖到此前整方法生成常漏检的分支/边界。
  if (parsed.generator === "mitgen" && apiKey && apiKey.trim() !== "" && parsed.branchBug) {
    logger.info("阶段[B2]:分支级 bug 注入演示(MitGen 片段级用例检出门闩边界翻转)");
    const branchBuggyTarget = injectBranchBug(targetContent, targetClassName, targetMethodName);
    logger.debug(`分支级 bug 注入后的目标文件:\n${branchBuggyTarget}`);
    const branchReport = await verify(makeJob(targetSide(branchBuggyTarget)), executor, logger);
    printReport(branchReport);
    logger.info(
      `阶段[B2] 验证:passRate=${branchReport.passRate.toFixed(2)} (pass=${branchReport.passedCases} fail=${branchReport.failedCases} divergent=${branchReport.divergentCases})`,
    );
    const branchDetected = branchReport.failedCases > 0 || branchReport.divergentCases > 0;
    if (branchDetected) {
      logger.info("阶段[B2] 分支级 bug 检出:FAIL(演示符合预期:MitGen 用例覆盖到了翻转的分支)");
      notice("分支级 bug 检出:FAIL —— MitGen 片段级用例检出了单个分支的比较边界翻转。");
    } else {
      exitCode = 1;
      logger.error("阶段[B2] 分支级 bug 未被检出:MitGen 用例未覆盖到翻转的分支");
      console.error("error: branch-level bug was NOT detected by MitGen cases.");
    }
  }

  // 8. 阶段 C:修复闭环演示(有 key)。
  let finalReport: VerificationReport = stageA;
  if (apiKey && apiKey.trim() !== "") {
    logger.info("阶段[C]:修复闭环演示(RepairLoop + RepairAgent,claude 子进程;起点=注入 bug 的目标文件)");
    const repairAgent = new RepairAgent({ apiKey, logger, timeoutMs: parsed.timeoutMs });
    const loop = new RepairLoop({
      maxRounds: parsed.maxRounds,
      repairAgent,
      // rebuildTargetSide:修复产物替换目标文件(补全 package,对齐全限定名驱动调用)。
      rebuildTargetSide: (methodCode) => targetSide(prepareRepairOutput(methodCode, targetContent)),
      logger,
    });
    let repairResult;
    try {
      repairResult = await loop.run(makeJob(targetSide(buggyTarget)), executor);
    } catch (error) {
      logger.error(`修复闭环运行失败:${errorMessage(error)}`);
      console.error(`error: repair loop failed: ${errorMessage(error)}`);
      return 2;
    }
    finalReport = repairResult.finalReport;
    printReport(finalReport);
    logger.info(
      `阶段[C] 修复闭环结束:轮数=${repairResult.rounds},最终 passRate=${finalReport.passRate.toFixed(2)} (pass=${finalReport.passedCases} fail=${finalReport.failedCases} divergent=${finalReport.divergentCases})`,
    );
    for (const error of loop.repairErrors) {
      logger.warn(`阶段[C] repairErrors:${errorMessage(error)}`);
    }
    if (finalReport.failedCases > 0 || finalReport.divergentCases > 0) {
      exitCode = 1;
      logger.error("阶段[C] 修复后仍 FAIL(未在 maxRounds 内收敛)");
    } else {
      logger.info("阶段[C] 修复闭环收敛:全 PASS");
    }
  } else {
    logger.info("阶段[C]:跳过修复闭环演示(需 DEEPSEEK_API_KEY 或 --api-key)");
    notice("跳过修复演示:未提供 DEEPSEEK_API_KEY(--api-key 可覆盖)。");
  }

  if (parsed.json) {
    console.log(JSON.stringify(finalReport, null, 2));
  }
  logger.info(`E2E 结束:exitCode=${exitCode}`);
  return exitCode;
}

// ---------------------------------------------------------------------------
// 入口(独立运行)
// ---------------------------------------------------------------------------

const exitCode = await runE2E(process.argv.slice(2));
process.exitCode = exitCode;
