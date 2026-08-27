#!/usr/bin/env node
/**
 * AID 变体轨道 E2E 验收脚本(独立于 run-e2e.ts,不破坏现有验收)。
 *
 * 三阶段:
 * - A(离线机制,无 key):fixture 变体(variant-samples/)+ fixture 输入生成器(aid-input-generator.ts)
 *   经真实工具链(javac/dotnet)跑 verifyWithVariants → 干净目标应全 PASS;
 * - B(注入精细 bug):bug-injection.ts 注入 off-by-one / fixed-value 等 → AID 检出 FAIL;
 * - C(有 key):真实 VariantGeneratorAgent + InputGeneratorAgent(claude 子进程)跑通,输出报告 JSON;
 *   演示轨道不改变退出码(真实 LLM 输入会暴露跨语言边界噪声,见设计 R4)。
 * 另输出检出率指标矩阵(设计文档 5.3):baselineDetectionRate / aidDetectionRate / detectionGain /
 * falsePositiveRate / oracleAgreement / variantPassRate。
 *
 * 退出码:0=确定性验收全 PASS(阶段 A 干净目标无 fail、阶段 B off-by-one 注入被 AID 检出);
 * 1=阶段 A/B 验收 FAIL;2=参数/运行错误。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { validateDescription, type TestDescription, type VerifierLanguage } from "../src/description.js";
import { generateDriverSource, generateSourceDriverSource } from "../src/driver/driver-codegen.js";
import type { SourceInvocation } from "../src/driver/source-invocation.js";
import { isToolchainAvailable, RealDriverExecutor, type SideSpec } from "../src/executor.js";
import { verify, type VerificationJob, type VerificationReport } from "../src/verifier.js";
import { createLogger, type Logger } from "../src/logger.js";
import { VariantGeneratorAgent } from "../src/aid/variant-generator.js";
import { InputGeneratorAgent } from "../src/aid/input-generator.js";
import { verifyTargetAgainstAIDBaseline, verifyWithVariants, type AIDVerificationReport } from "../src/aid/aid-verifier.js";
import { DISPUTED_DETAIL_PREFIX } from "../src/aid/consensus.js";
import {
  BUG_KINDS,
  computeDetectionMetrics,
  injectFineGrainedBug,
  type DetectionMetrics,
  type InjectedBugKind,
} from "./bug-injection.js";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

export interface AIDE2EOptions {
  requirement: string;
  sourceMethod: string;
  targetFile: string;
  sourceLang: VerifierLanguage;
  fixture: string;
  variantSamples: string; // 目录(含 *.cs / *.java 变体文件)
  inputGenerator: string; // TS 输入生成器脚本
  targetClass?: string;
  targetMethod?: string;
  apiKey?: string;
  timeoutMs: number;
  inputCount: number;
  variantCount: number;
  json: boolean;
  skipMetrics: boolean;
}

const VALUE_FLAGS = new Set([
  "--requirement",
  "--source-method",
  "--target-file",
  "--source-lang",
  "--fixture",
  "--variant-samples",
  "--input-generator",
  "--target-class",
  "--target-method",
  "--api-key",
  "--timeout-ms",
  "--input-count",
  "--variant-count",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--skip-metrics"]);

export function parseAidArgs(argv: string[]): AIDE2EOptions | { error: string } {
  const options: AIDE2EOptions = {
    requirement: "",
    sourceMethod: "",
    targetFile: "",
    sourceLang: "C#",
    fixture: fileURLToPath(new URL("./fixtures/aid-description.json", import.meta.url)),
    variantSamples: fileURLToPath(new URL("./fixtures/variant-samples", import.meta.url)),
    inputGenerator: fileURLToPath(new URL("./fixtures/aid-input-generator.ts", import.meta.url)),
    timeoutMs: 300_000,
    inputCount: 40,
    variantCount: 2,
    json: false,
    skipMetrics: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      if (flag === "--skip-metrics") options.skipMetrics = true;
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
        case "--target-file":
          options.targetFile = value;
          break;
        case "--source-lang": {
          if (value !== "Java" && value !== "C#" && value !== "Python" && value !== "TypeScript") {
            return { error: `Invalid --source-lang: "${value}".` };
          }
          options.sourceLang = value;
          break;
        }
        case "--fixture":
          options.fixture = value;
          break;
        case "--variant-samples":
          options.variantSamples = value;
          break;
        case "--input-generator":
          options.inputGenerator = value;
          break;
        case "--target-class":
          options.targetClass = value;
          break;
        case "--target-method":
          options.targetMethod = value;
          break;
        case "--api-key":
          options.apiKey = value;
          break;
        case "--timeout-ms": {
          if (!/^\d+$/.test(value)) return { error: `Invalid --timeout-ms: "${value}".` };
          options.timeoutMs = Number.parseInt(value, 10);
          break;
        }
        case "--input-count": {
          if (!/^\d+$/.test(value)) return { error: `Invalid --input-count: "${value}".` };
          options.inputCount = Number.parseInt(value, 10);
          break;
        }
        case "--variant-count": {
          if (!/^\d+$/.test(value)) return { error: `Invalid --variant-count: "${value}".` };
          options.variantCount = Number.parseInt(value, 10);
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
// 声明行解析(与 run-e2e.ts 同构,本地实现避免导入执行副作用)
// ---------------------------------------------------------------------------

function parseTargetClassName(source: string): string | null {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(source);
  const cls = /public\s+class\s+(\w+)/.exec(source);
  if (!cls?.[1]) return null;
  return pkg ? `${pkg[1]}.${cls[1]}` : cls[1];
}

function parseTargetMethodName(source: string): string | null {
  const m = /public\s+static\s+[\w<>[\].]+\s+(\w+)\s*\(/.exec(source);
  return m?.[1] ?? null;
}

function parseSourceClassName(source: string): string | null {
  const ns = /(?:^|\n)\s*namespace\s+([\w.]+)\s*(?:;|\{)/.exec(source);
  const cls = /\bclass\s+(\w+)/.exec(source);
  if (!cls?.[1]) return null;
  return ns ? `${ns[1]}.${cls[1]}` : cls[1];
}

function parseSourceMethodName(source: string, className: string): string | null {
  if (/\bdef\s+/.test(source)) {
    return /\bdef\s+(?!__init__\b)([A-Za-z_]\w*)\s*\(/.exec(source)?.[1] ?? null;
  }
  if (/\b(?:export\s+)?function\s+/.test(source)) {
    return /\b(?:export\s+)?function\s+([A-Za-z_]\w*)\s*\(/.exec(source)?.[1] ?? null;
  }
  const block = classBlock(source, className);
  const snippet = block ? source.slice(block.start, block.end) : source;
  const m = /public\s+static\s+[\w<>[\].?]+\s+(\w+)\s*\(/.exec(snippet);
  if (m?.[1]) return m[1];
  return /public\s+[\w<>[\].?]+\s+(\w+)\s*\(/.exec(snippet)?.[1] ?? null;
}

function classBlock(source: string, className: string): { start: number; end: number } | null {
  const simple = className.split(".").pop() as string;
  const m = new RegExp(`\\bclass\\s+${escapeRegExp(simple)}\\s*(?:<[^>]*>)?\\s*\\{`).exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return { start: m.index, end: matchingBrace(source, open) };
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 度量辅助
// ---------------------------------------------------------------------------

/** 从 AID 报告计算 falsePositiveRate / oracleAgreement / variantPassRate。 */
function computeAidQualityMetrics(report: AIDVerificationReport, description: TestDescription): DetectionMetrics {
  const total = report.totalCases;
  const falsePositiveRate = total === 0 ? 0 : report.failedCases / total;
  const expectedChecked = description.cases.length;
  const oracleAgreement =
    expectedChecked === 0 ? 1 : 1 - report.consensusExpectedConflicts.length / expectedChecked;
  const variantPassRate = report.variants.length === 0 ? 0 : report.variants.filter((v) => v.passes).length / report.variants.length;
  const metrics = computeDetectionMetrics([]);
  return { ...metrics, falsePositiveRate, oracleAgreement, variantPassRate };
}

// ---------------------------------------------------------------------------
// E2E 主流程
// ---------------------------------------------------------------------------

export async function runE2EAid(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = "logs";
  const parsed = parseAidArgs(argv);
  if (!("error" in parsed) && parsed.json) {
    process.env.VERIFIER_LOG_LEVEL = "ERROR";
  }
  const logger = createLogger("e2e-aid");

  if ("error" in parsed) {
    logger.error(`参数错误:${parsed.error}`);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  logger.info(
    `AID E2E 开始:requirement="${truncate(parsed.requirement, 100)}", source-lang=${parsed.sourceLang}, variant-samples=${parsed.variantSamples}`,
  );

  // 0. 工具链预检。
  if (!isToolchainAvailable("Java") || !isToolchainAvailable(parsed.sourceLang)) {
    console.error("error: required toolchain (javac/java or source-language toolchain) is not available on PATH.");
    return 2;
  }

  // 1. 读取输入。
  let sourceContent: string;
  let targetContent: string;
  try {
    sourceContent = readFileSync(resolve(parsed.sourceMethod), "utf-8");
    targetContent = readFileSync(resolve(parsed.targetFile), "utf-8");
  } catch (error) {
    console.error(`error: cannot read input files: ${errorMessage(error)}`);
    return 2;
  }

  // 2. 描述(fixture;离线无 key)。
  let description: TestDescription;
  try {
    description = validateDescription(JSON.parse(readFileSync(resolve(parsed.fixture), "utf-8")));
  } catch (error) {
    console.error(`error: fixture failed validation: ${errorMessage(error)}`);
    return 2;
  }
  const targetClassName = parsed.targetClass ?? parseTargetClassName(targetContent);
  const targetMethodName = parsed.targetMethod ?? parseTargetMethodName(targetContent);
  if (!targetClassName || !targetMethodName) {
    console.error("error: cannot resolve the target signature. Pass --target-class/--target-method.");
    return 2;
  }
  description = {
    ...description,
    requirement: parsed.requirement,
    target: {
      ...description.target,
      language: "Java",
      className: targetClassName,
      method: targetMethodName,
      isStatic: true,
    },
  };

  // 3. 双侧驱动 + 执行器。
  const executor = new RealDriverExecutor({ logger });
  const targetSide = (content: string): SideSpec => ({
    language: "Java",
    driverSource: generateDriverSource(description),
    sourceFiles: [{ relativePath: `${targetClassName.split(".").pop()}.java`, content }],
  });
  const sourceClassName = parseSourceClassName(sourceContent);
  const sourceMethodName = parseSourceMethodName(sourceContent, sourceClassName ?? "");
  if (!sourceClassName || !sourceMethodName) {
    console.error("error: cannot resolve the source class/method from --source-method.");
    return 2;
  }
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

  // 4. fixture 变体 + fixture 输入生成器(fake spawnClaude 直接返回 fixture 内容,不调用真实 LLM)。
  let fixtureVariants: string[];
  try {
    fixtureVariants = readdirSync(parsed.variantSamples)
      .filter((f) => f.endsWith(".cs") || f.endsWith(".java") || f.endsWith(".py") || f.endsWith(".ts"))
      .sort()
      .map((f) => readFileSync(join(parsed.variantSamples, f), "utf-8"));
  } catch (error) {
    console.error(`error: cannot read --variant-samples ${parsed.variantSamples}: ${errorMessage(error)}`);
    return 2;
  }
  let fixtureGeneratorScript: string;
  try {
    fixtureGeneratorScript = readFileSync(resolve(parsed.inputGenerator), "utf-8");
  } catch (error) {
    console.error(`error: cannot read --input-generator ${parsed.inputGenerator}: ${errorMessage(error)}`);
    return 2;
  }
  if (fixtureVariants.length === 0) {
    console.error("error: --variant-samples directory contains no variant source files.");
    return 2;
  }

  const fixtureAgents = (): { variants: VariantGeneratorAgent; inputs: InputGeneratorAgent } => {
    let variantIndex = 0;
    return {
      variants: new VariantGeneratorAgent({
        // 任意非空 key 即可通过 runClaude 前置检查;spawnClaude 被注入为返回 fixture 内容。
        apiKey: "offline-fixture",
        spawnClaude: async () => {
          const code = fixtureVariants[Math.min(variantIndex, fixtureVariants.length - 1)] as string;
          variantIndex += 1;
          return { stdout: code, exitCode: 0 };
        },
        logger,
      }),
      inputs: new InputGeneratorAgent({
        apiKey: "offline-fixture",
        spawnClaude: async () => ({ stdout: fixtureGeneratorScript, exitCode: 0 }),
        logger,
      }),
    };
  };

  const job = (target: SideSpec) => ({
    description,
    source: sourceSide,
    target,
    options: { variantCount: parsed.variantCount, inputCount: parsed.inputCount },
  });

  let exitCode = 0;
  const printReport = (report: AIDVerificationReport): void => {
    if (parsed.json) return; // json 模式最后统一输出
    for (const cmp of report.comparisons) {
      const flag = cmp.verdict === "pass" ? "PASS" : cmp.verdict === "fail" ? "FAIL" : "DIVERGENT";
      const details = cmp.details.length > 0 ? ` | ${cmp.details.join("; ")}` : "";
      console.log(`${cmp.caseId}\t${flag}${details}`);
    }
    console.log(
      `AID passRate: ${report.passedCases}/${report.totalCases} (${(report.passRate * 100).toFixed(1)}%)  fail=${report.failedCases} disputed=${report.disputedCases}`,
    );
    console.log(
      `variants: ${report.variants.filter((v) => v.passes).length}/${report.variants.length} 保留; oracle consensus=${report.oracleSummary.consensusCount} disputed=${report.oracleSummary.disputedCount}`,
    );
  };

  // 5. 阶段 A:离线机制验收(干净目标 → 全 PASS)。
  logger.info("阶段[A]:离线机制验收(clean 目标,fixture 变体 + fixture 输入)");
  let cleanReport: AIDVerificationReport;
  try {
    cleanReport = await verifyWithVariants(job(targetSide(targetContent)), executor, fixtureAgents(), logger);
  } catch (error) {
    console.error(`error: AID 阶段 A 运行失败: ${errorMessage(error)}`);
    return 2;
  }
  printReport(cleanReport);
  const quality = computeAidQualityMetrics(cleanReport, description);
  logger.info(
    `阶段[A] AID:passRate=${cleanReport.passRate.toFixed(2)} fail=${cleanReport.failedCases} disputed=${cleanReport.disputedCases} variantPassRate=${quality.variantPassRate.toFixed(2)}`,
  );
  if (cleanReport.failedCases > 0) {
    exitCode = 1;
    logger.error("阶段[A] 未全 PASS:干净目标被 AID 判 fail(误报)");
  }
  const cleanBaselineNote =
    cleanReport.baseline.cleanTarget.usable !== true
      ? cleanReport.baseline.cleanTarget.note ?? "missing-clean-target-status"
      : cleanReport.baseline.oracle.some((entry) => entry.confidence === "consensus")
        ? undefined
        : "no-consensus-oracle";
  if (cleanBaselineNote !== undefined) {
    exitCode = 1;
    logger.error(`阶段[A] clean 基线不可用于注入检出:${cleanBaselineNote}`);
  }

  // 6. 阶段 B:注入精细 bug → AID 检出 + 检出率指标矩阵。
  logger.info("阶段[B]:注入精细 bug(off-by-one / fixed-value / condition-flip / constant-wrong)");
  const details: DetectionMetrics["details"] = [];
  // off-by-one / condition-flip / constant-wrong 注入到 QP 解码器 decode(边界逻辑所在);
  // fixed-value 注入到顶层 decodeText。
  const INJECTION_MATRIX: { kind: InjectedBugKind; method: string }[] = BUG_KINDS.map((kind) => ({
    kind,
    method: kind === "fixed-value" ? targetMethodName : "decode",
  }));
  const offByOneDetected = new Map<InjectedBugKind, boolean>();
  for (const { kind, method } of INJECTION_MATRIX) {
    if (cleanBaselineNote !== undefined) {
      details.push({ method, kind, baselineDetected: false, aidDetected: false, note: `clean-baseline-unusable:${cleanBaselineNote}` });
      continue;
    }
    let buggyTarget: string;
    try {
      buggyTarget = injectFineGrainedBug(targetContent, kind, targetClassName, method).source;
    } catch (error) {
      const note = `injection-failed:${errorMessage(error)}`;
      details.push({ method, kind, baselineDetected: false, aidDetected: false, note });
      logger.warn(`注入 ${kind} 失败:${errorMessage(error)}`);
      continue;
    }
    let baselineReport: VerificationReport;
    let aidReport: AIDVerificationReport;
    try {
      // baseline:现有双轨(固定 description 输入 + 单参考差分)。
      baselineReport = await verify(
        { description, source: sourceSide, target: targetSide(buggyTarget) },
        executor,
        logger,
      );
      // AID:只重放阶段 A 已冻结的 batch/oracle，不能重新生成随机输入或变体。
      aidReport = await verifyTargetAgainstAIDBaseline(targetSide(buggyTarget), cleanReport.baseline, executor, logger);
    } catch (error) {
      const note = `detection-failed:${errorMessage(error)}`;
      details.push({ method, kind, baselineDetected: false, aidDetected: false, note });
      logger.warn(`注入 ${kind} 的检测执行失败:${errorMessage(error)}`);
      continue;
    }
    const baselineDetected = baselineReport.failedCases > 0;
    const aidTargetUsable = cleanReport.baseline.batchDescription.cases.every((testCase) =>
      aidReport.comparisons.some((comparison) => comparison.caseId === testCase.id && comparison.target !== null),
    );
    if (!aidTargetUsable) {
      details.push({ method, kind, baselineDetected, aidDetected: false, note: "aid-target-unusable" });
      logger.warn(`注入 ${kind} 的 AID 目标结果不完整，试验不计入检出率`);
      continue;
    }
    const cleanFailedCaseIds = new Set(cleanReport.baseline.cleanFailedCaseIds);
    const aidDetected = aidReport.comparisons.some(
      (comparison) => comparison.verdict === "fail" && !cleanFailedCaseIds.has(comparison.caseId),
    );
    offByOneDetected.set(kind, aidDetected);
    details.push({ method, kind, baselineDetected, aidDetected });
    logger.info(
      `注入[${method}.${kind}]:baseline=${baselineDetected ? "检出" : "漏检"}(fail=${baselineReport.failedCases}), AID=${aidDetected ? "检出" : "漏检"}(fail=${aidReport.failedCases})`,
    );
  }
  const metrics = computeDetectionMetrics(details);
  metrics.falsePositiveRate = quality.falsePositiveRate;
  metrics.oracleAgreement = quality.oracleAgreement;
  metrics.variantPassRate = quality.variantPassRate;
  // 硬断言:off-by-one 必须被 AID 检出(边界输入覆盖是 AID 的核心卖点)。
  const offByOneResult = offByOneDetected.get("off-by-one");
  if (offByOneResult !== true) {
    exitCode = 1;
    logger.error("阶段[B] off-by-one 注入 bug 未形成可检出证据");
    console.error("error: injected off-by-one bug was not successfully detected by the AID variant track.");
  } else {
    logger.info("阶段[B] off-by-one 注入 bug 被 AID 检出:FAIL(符合预期)");
  }
  if (!parsed.skipMetrics) {
    console.log("=== AID 检出率指标 ===");
    console.log(JSON.stringify(metrics, null, 2));
  }

  // 7. 阶段 C(有 key):真实 LLM 变体 + 输入生成器 —— 演示轨道:输出报告,不改变退出码。
  // 真实 LLM 变体 + 生成器输入会暴露跨语言边界噪声(设计 R4:非法字符集/字符集解码差异等),
  // 例如 Java Charset.forName 的 IllegalCharsetNameException 不在现有异常别名表内 → 干净目标也可能
  // 出现 fail/disputed。确定性验收由离线阶段 A/B 承担,阶段 C 仅演示真实管线跑通。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (apiKey && apiKey.trim() !== "") {
    logger.info("阶段[C]:真实 LLM 变体轨道(claude 子进程,演示,不影响退出码)");
    const realAgents = {
      variants: new VariantGeneratorAgent({ apiKey, logger, timeoutMs: parsed.timeoutMs }),
      inputs: new InputGeneratorAgent({ apiKey, logger, timeoutMs: parsed.timeoutMs }),
    };
    try {
      const realReport = await verifyWithVariants(job(targetSide(targetContent)), executor, realAgents, logger);
      printReport(realReport);
      logger.info(
        `阶段[C] 真实 LLM:passRate=${realReport.passRate.toFixed(2)} fail=${realReport.failedCases} disputed=${realReport.disputedCases}`, 
      );
      if (realReport.failedCases > 0) {
        // 仅记录:跨语言边界噪声(R4)预期可见,不代表注入缺陷;退出码由阶段 A/B 决定。
        logger.warn(
          `阶段[C] 干净目标上出现 ${realReport.failedCases} 个 fail(跨语言边界噪声,见设计 R4;如非法字符集异常别名缺口等)`,
        );
      }
    } catch (error) {
      logger.error(`阶段[C] 运行失败:${errorMessage(error)}`);
      console.error(`error: stage C failed: ${errorMessage(error)}`);
      return 2;
    }
  } else {
    logger.info("阶段[C]:跳过真实 LLM 轨道(需 DEEPSEEK_API_KEY 或 --api-key)");
  }

  if (parsed.json) {
    console.log(JSON.stringify({ cleanReport, metrics }, null, 2));
  }
  logger.info(`AID E2E 结束:exitCode=${exitCode}`);
  return exitCode;
}

const exitCode = await runE2EAid(process.argv.slice(2));
process.exitCode = exitCode;
