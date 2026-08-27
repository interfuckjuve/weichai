#!/usr/bin/env node
/**
 * 方向 1「冒烟验证 + 行为一致性自修复」E2E 验收脚本(黑盒,不依赖 vitest)。
 *
 * Task 4 起 SmokeAgent 删除,本脚本改为经统一策略入口 createTestStrategy("smoke")
 * 黑盒运行:单一 claude 自主会话完成读码 → 双侧 runner → 编译运行 → 机械差分 →
 * 语义裁决 → 目标修复 → report.json(SmokeReport)。fixture 化应答序列(ReAct 工具调用
 * 逐轮脚本)机制随 SmokeAgent 失效,本脚本需要真实 claude(--api-key / DEEPSEEK_API_KEY)。
 *
 * 场景:
 *   A   真实翻译产物(mime-util C# → Java)→ 策略报告 status=pass/fail(converged 归一化);
 *   C   有 key 时跑真实 claude 自主会话(--offline-only 跳过)。
 *
 * 退出码:0=策略报告生成成功(status 非 error);1=策略 error 或验收断言失败;2=参数错误。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createTestStrategy } from "../src/strategies/index.js";
import type { SmokeReport } from "../src/smoke/smoke-types.js";
import { createLogger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

export interface SmokeE2EOptions {
  fixtureDir: string;
  apiKey?: string;
  timeoutMs: number;
  /** 跳过真实 claude 子进程路径(自主模式必须有 key,离线路径不再存在)。 */
  offlineOnly: boolean;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--fixture-dir", "--api-key", "--timeout-ms"]);
const BOOLEAN_FLAGS = new Set(["--json", "--offline-only"]);

/** 解析 CLI 参数;缺省 fixture 目录为脚本同目录 fixtures/smoke-mime-util。 */
export function parseArgs(argv: string[]): SmokeE2EOptions | { error: string } {
  const options: SmokeE2EOptions = {
    fixtureDir: fileURLToPath(new URL("./fixtures/smoke-mime-util", import.meta.url)),
    timeoutMs: 300_000,
    offlineOnly: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      if (flag === "--offline-only") options.offlineOnly = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `Missing value for ${flag}.` };
    i += 1;
    switch (flag) {
      case "--fixture-dir":
        options.fixtureDir = value;
        break;
      case "--api-key":
        options.apiKey = value;
        break;
      case "--timeout-ms": {
        if (!/^\d+$/.test(value)) return { error: `Invalid --timeout-ms: "${value}".` };
        options.timeoutMs = Number.parseInt(value, 10);
        break;
      }
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readFixture(fixtureDir: string, name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf-8");
}

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

// ---------------------------------------------------------------------------
// E2E 主流程
// ---------------------------------------------------------------------------

/**
 * 运行 smoke E2E 验收,返回退出码:0=策略报告成功;1=验收 FAIL;2=参数错误。
 */
export async function runSmokeE2E(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = "logs";
  const parsed = parseArgs(argv);
  if (!("error" in parsed) && parsed.json) {
    process.env.VERIFIER_LOG_LEVEL = "ERROR";
  }
  const logger = createLogger("smoke-e2e");
  if ("error" in parsed) {
    logger.error(`参数错误:${parsed.error}`);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  logger.info(`Smoke E2E 开始:fixture-dir=${parsed.fixtureDir}, timeout-ms=${parsed.timeoutMs}`);

  // 0. key 预检:自主策略必须有真实 claude;--offline-only 时跳过。
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (parsed.offlineOnly) {
    logger.info("--offline-only 已指定:自主模式无离线路径,跳过(需 DEEPSEEK_API_KEY 或 --api-key)");
    if (!parsed.json) console.log("跳过 smoke E2E:自主模式需要真实 claude(--offline-only 仅跳过)。");
    return 0;
  }
  if (!apiKey || apiKey.trim() === "") {
    logger.error("smoke 自主策略需要 DEEPSEEK_API_KEY(--api-key 可覆盖)");
    console.error("error: smoke E2E requires DEEPSEEK_API_KEY (or --api-key) for the autonomous strategy.");
    return 2;
  }

  // 1. 读取样例输入(源/目标文件 + 需求)。
  const fixtureDir = resolve(parsed.fixtureDir);
  const samplesDir = join(fixtureDir, "..", "samples");
  const requirement = readFixture(fixtureDir, "requirement.txt").trim();
  const sourceContent = readFixture(samplesDir, "mime-util-source.cs");
  const targetContent = readFixture(samplesDir, "mime-util-target.java");
  logger.info(
    `输入:requirement="${truncate(requirement, 80)}", source=(${sourceContent.length} chars), target=(${targetContent.length} chars)`,
  );

  // 2. 黑盒运行 smoke 策略(真实 claude 自主会话,读参考目录内的源/目标文件)。
  logger.info("阶段[A]:smoke 策略自主会话(C# 源 → Java 目标,mime-util)");
  const runner = createTestStrategy("smoke", {
    llm: { apiKey, timeoutMs: parsed.timeoutMs },
    keepGeneratedTests: true,
    maxTurns: 40,
  });
  let report;
  try {
    report = await runner.run({
      requirement,
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
        files: [{ relativePath: "mime-util-target.java", content: targetContent }],
      },
    });
  } catch (error) {
    logger.error(`阶段[A] 策略运行错误:${errorMessage(error)}`);
    console.error(`error: smoke strategy run failed: ${errorMessage(error)}`);
    return 2;
  }
  logger.info(`阶段[A] 策略完成:status=${report.status},durationMs=${report.durationMs.toFixed(0)}${report.keptDir ? `,keptDir=${report.keptDir}` : ""}`);
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.status === "error") {
    logger.error(`阶段[A] FAIL:策略 error(${truncate(report.summary, 200)})`);
    console.error(`error: smoke strategy returned error status: ${report.summary}`);
    return 1;
  }
  const detail = report.detail as SmokeReport;
  logger.info(`阶段[A] 报告:\n${summarizeReport(detail)}`);
  const bugCases = detail.cases.filter((c) => c.decision === "translation-bug");
  const allPass = detail.converged && detail.cases.every((c) => c.mechanical === "pass" && c.decision === "pass");
  if (allPass) {
    logger.info("阶段[A] PASS:真实翻译产物全部机械 pass + 语义 pass,策略收敛");
    console.log(`Smoke E2E PASS:converged=true,${detail.cases.length} 个 case 全 pass。`);
    return 0;
  }
  if (bugCases.length > 0) {
    logger.warn(`阶段[A] 检出 ${bugCases.length} 个 translation-bug(真实翻译产物不应出现,报告如实呈现)`);
  }
  logger.info(`阶段[A] 完成(未全 pass):converged=${detail.converged},cases=${detail.cases.length}`);
  return 0;
}

// ---------------------------------------------------------------------------
// 入口(独立运行)
// ---------------------------------------------------------------------------

const exitCode = await runSmokeE2E(process.argv.slice(2));
process.exitCode = exitCode;
