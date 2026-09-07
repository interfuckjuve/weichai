#!/usr/bin/env node
/**
 * 「冒烟差分验证」E2E 验收脚本(黑盒,不依赖 vitest)。
 *
 * 单次 claude 自主会话完成读码 → 设计冒烟用例 → 写双侧 runner → 经
 * verifier-command 代理真实编译运行 → 机械差分 + LLM 语义裁决 → 写 report.json
 * (SmokeReport)→ 归一化 status。
 *
 * 两种显式模式:
 * - 默认(diagnostic-repair):样本 fixture,允许报告诊断修复(旧实验行为);
 * - --verify-only:使用完整本地依赖 fixture 根(source=C# 项目,target=Java 项目),
 *   生产语义——rounds===0、targetFiles 为空、双侧 runnerFiles 与执行证据齐全。
 * 需要真实 claude(--api-key / DEEPSEEK_API_KEY);--offline-only 跳过真实会话。
 *
 * 退出码:0=策略报告生成成功(status 非 error);1=status=error 或 verify-only
 * 不变量不满足;2=参数错误/缺 key。
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { runSmoke, type SmokeResult, type SmokeTaskInput } from "../src/strategies/differential-smoke/runner.js";
import type { SmokeReport } from "../src/strategies/differential-smoke/types.js";
import { DIFFERENTIAL_SMOKE_STRATEGY } from "../src/strategies/differential-smoke/strategy.js";
import { createLogger, DEFAULT_LOG_DIR } from "../src/logger.js";

export interface SmokeE2EOptions {
  /** 任务输入目录(requirement.txt + 经 .. 定位 samples)。 */
  fixtureDir: string;
  apiKey?: string;
  timeoutMs: number;
  /** 跳过真实 claude 子进程路径(自主模式必须有 key,离线路径不再存在)。 */
  offlineOnly: boolean;
  /** 生产 verify-only 模式:完整本地依赖 fixture 根。 */
  verifyOnly: boolean;
  /** 静态注册策略 ID;当前 E2E suite 只覆盖 differential-smoke。 */
  strategyId: string;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--fixture-dir", "--api-key", "--timeout-ms", "--strategy"]);
const BOOLEAN_FLAGS = new Set(["--json", "--offline-only", "--verify-only"]);

export function parseArgs(argv: string[]): SmokeE2EOptions | { error: string } {
  const opts: SmokeE2EOptions = {
    fixtureDir: fileURLToPath(new URL("./fixtures/smoke-mime-util", import.meta.url)),
    timeoutMs: 300_000,
    offlineOnly: false,
    verifyOnly: false,
    strategyId: DIFFERENTIAL_SMOKE_STRATEGY.id,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `Missing value for ${flag}.` };
      if (flag === "--fixture-dir") opts.fixtureDir = value;
      else if (flag === "--api-key") opts.apiKey = value;
      else if (flag === "--strategy") opts.strategyId = value;
      else if (flag === "--timeout-ms") {
        if (!/^\d+$/.test(value)) return { error: `Invalid --timeout-ms: "${value}".` };
        opts.timeoutMs = Number(value);
      }
      i++;
    } else if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") opts.json = true;
      else if (flag === "--offline-only") opts.offlineOnly = true;
      else if (flag === "--verify-only") opts.verifyOnly = true;
    } else {
      return { error: `Unknown option: ${flag}` };
    }
  }
  return opts;
}

function readFixture(fixtureDir: string, name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf-8");
}

/** 超长文本截断,附带截断标记。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 人类可读的 SmokeReport 摘要(逐 case 裁决)。 */
export function summarizeReport(report: SmokeReport): string {
  const lines = [`converged=${report.converged} steps=${report.steps} rounds=${report.rounds} cases=${report.cases.length}`];
  for (const c of report.cases) {
    lines.push(`  [${c.caseId}] decision=${c.decision} mechanical=${c.mechanical} intent="${c.intent}"`);
  }
  return lines.join("\n");
}

/** verify-only 生产不变量:无目标修复、双侧 runner、非空 cases 与执行证据。 */
function verifyOnlyViolations(report: SmokeReport): string[] {
  const violations: string[] = [];
  if (report.rounds !== 0) violations.push(`rounds 必须为 0,实际 ${report.rounds}`);
  if (report.targetFiles.length !== 0) {
    violations.push(`targetFiles 必须为空,实际 ${report.targetFiles.length} 个`);
  }
  if (report.cases.length === 0) violations.push("cases 不能为空");
  const sides = report.runnerFiles?.map((group) => group.side) ?? [];
  if (!sides.includes("source") || !sides.includes("target")) {
    violations.push("runnerFiles 必须同时包含 source 与 target");
  }
  if (!report.executions || report.executions.length === 0) {
    violations.push("executions 必须包含非空执行证据");
  }
  return violations;
}

/** 完整本地依赖 fixture 根的 verify-only 任务(C# → Java)。 */
function verifyOnlyJob(): SmokeTaskInput {
  const dependencies = fileURLToPath(new URL("./fixtures/dependencies", import.meta.url));
  return {
    requirement:
      "TargetService.value() 必须返回 MathDependency.doubleValue(21) 的语义结果(21 × 2 = 42)。",
    source: {
      language: "C#",
      root: join(dependencies, "dotnet"),
      candidatePath: "App/TargetService.cs",
    },
    target: {
      language: "Java",
      className: "fixture.TargetService",
      method: "value",
      isStatic: false,
      root: join(dependencies, "maven"),
      file: "app/src/main/java/fixture/TargetService.java",
    },
  };
}

/** 默认诊断样例任务(MimeUtility C# → Java,允许报告修复轮)。 */
function diagnosticJob(fixtureDir: string): SmokeTaskInput {
  const samplesDir = join(fixtureDir, "..", "samples");
  const sourceContent = readFixture(samplesDir, "mime-util-source.cs");
  return {
    requirement: readFixture(fixtureDir, "requirement.txt").trim(),
    source: {
      language: "C#",
      root: samplesDir,
      files: [{ relativePath: "mime-util-source.cs", content: sourceContent }],
    },
    target: {
      language: "Java",
      className: "org.apache.commons.fileupload.util.mime.MimeUtility",
      method: "decodeText",
      isStatic: true,
      file: "mime-util-target.java",
      root: samplesDir,
    },
  };
}

export async function runSmokeE2E(argv: string[]): Promise<number> {
  // 统一使用 logger 根据模块位置解析出的仓库根 logs/,避免相对 cwd 产生多个日志目录。
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = DEFAULT_LOG_DIR;
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    const logger = createLogger("smoke-e2e");
    logger.error(parsed.error);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (parsed.json) process.env.VERIFIER_LOG_LEVEL = "ERROR";
  const logger = createLogger("smoke-e2e");
  if (parsed.strategyId !== DIFFERENTIAL_SMOKE_STRATEGY.id) {
    logger.error(`unknown smoke E2E strategy: ${parsed.strategyId}`);
    console.error(`error: unknown smoke E2E strategy: ${parsed.strategyId}`);
    return 2;
  }

  // 自主模式必须有真实 claude:key 预检(无离线回放路径)。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (parsed.offlineOnly) {
    logger.info("skipping smoke E2E: autonomous mode requires a real claude session.");
    if (!parsed.json) console.log("跳过 smoke E2E:自主模式需要真实 claude(--offline-only 仅跳过)。");
    return 0;
  }
  if (!apiKey) {
    logger.error("smoke E2E requires DEEPSEEK_API_KEY (or --api-key) for the autonomous strategy.");
    console.error("error: smoke E2E requires DEEPSEEK_API_KEY (or --api-key) for the autonomous strategy.");
    return 2;
  }

  const fixtureDir = resolve(parsed.fixtureDir);
  const mode = parsed.verifyOnly ? "verify-only" : "diagnostic-repair";
  const job = parsed.verifyOnly ? verifyOnlyJob() : diagnosticJob(fixtureDir);

  // 单次 claude 自主会话(keep 产物供验收与调试)。
  let result: SmokeResult;
  try {
    logger.info(
      `run smoke ${parsed.strategyId} ${mode} session (fixture=${fixtureDir}, timeoutMs=${parsed.timeoutMs})`,
    );
    result = await runSmoke(
      job,
      {
        mode,
        apiKey,
        timeoutMs: parsed.timeoutMs,
        keepGeneratedTests: true,
        maxTurns: 40,
      },
    );
  } catch (error) {
    logger.error(`smoke strategy run failed: ${errorMessage(error)}`);
    console.error(`error: smoke strategy run failed: ${errorMessage(error)}`);
    return 2;
  }

  if (parsed.json) console.log(JSON.stringify(result, null, 2));

  // 验收:报告生成成功即 status 非 error;converged=false 或检出 translation-bug
  // 亦如实呈现(真实翻译产物不应有 bug,检出则警告),不据此判失败。
  if (result.status === "error") {
    logger.error(`smoke strategy returned error status: ${result.summary}`);
    console.error(`error: smoke strategy returned error status: ${truncate(result.summary, 2000)}`);
    return 1;
  }
  const report = result.report;
  console.log(summarizeReport(report));
  if (parsed.verifyOnly) {
    const violations = verifyOnlyViolations(report);
    if (violations.length > 0) {
      logger.error(`verify-only report violated production invariants:\n${violations.join("\n")}`);
      console.error(`error: verify-only 生产不变量不满足:\n${violations.join("\n")}`);
      return 1;
    }
    console.log(`Smoke E2E VERIFY-ONLY OK:cases=${report.cases.length}, executions=${report.executions?.length}。`);
    return 0;
  }
  const bugCases = report.cases.filter((c) => c.decision === "translation-bug");
  const allPass = report.converged && report.cases.every((c) => c.mechanical === "pass" && c.decision === "pass");
  if (allPass) {
    console.log(`Smoke E2E PASS:converged=true,${report.cases.length} 个 case 全 pass。`);
    return 0;
  }
  if (bugCases.length > 0) {
    logger.warn(`smoke report found ${bugCases.length} translation-bug case(s): ${bugCases.map((c) => c.caseId).join(", ")}`);
  }
  logger.info(`smoke E2E finished: status=${result.status} summary=${result.summary}`);
  return 0;
}

function isModuleEntryPoint(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  const entryPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(entryPath);
  } catch {
    return resolve(process.argv[1]) === resolve(entryPath);
  }
}

if (isModuleEntryPoint()) {
  const exitCode = await runSmokeE2E(process.argv.slice(2));
  process.exitCode = exitCode;
}
