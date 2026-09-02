#!/usr/bin/env node
/**
 * 方向 1「Agent 冒烟测试 + 行为一致性自修复」CLI 入口。
 *
 * 用法示例:
 *   npx tsx src/smoke-cli.ts \
 *     --requirement "解码 MIME 编码文本" \
 *     --source-dir fixtures/samples --source-file fixtures/samples/mime-util-source.cs \
 *     --target-dir fixtures/samples --target-file fixtures/samples/mime-util-target.java \
 *     --source-lang C# --target-lang Java --target-class org.apache.commons.fileupload.util.mime.MimeUtility --target-method decodeText
 *
 * 可选:DEEPSEEK_API_KEY(或 --api-key)驱动真实 claude 子进程;maxSteps/maxRounds 控制预算;
 * --json 输出 SmokeReport JSON。
 *
 * 退出码:0=收敛;1=未收敛(全部步数/轮数用尽或存在 translation-bug/unclear);2=参数或运行错误。
 */
import { resolve } from "node:path";
import { SmokeAgent, type SmokeAgentOptions } from "./smoke-agent.js";
import { createLogger } from "./logger.js";
import type { SmokeReport } from "./smoke-types.js";

export interface SmokeCliOptions {
  requirement: string;
  sourceDir?: string;
  sourceFile?: string;
  targetDir?: string;
  targetFile?: string;
  sourceLang: SmokeAgentOptions["sourceLang"];
  targetLang: SmokeAgentOptions["targetLang"];
  targetClass?: string;
  targetMethod?: string;
  maxSteps: number;
  maxRounds: number;
  apiKey?: string;
  timeoutMs?: number;
  json: boolean;
}

const VALUE_FLAGS = new Set([
  "--requirement",
  "--source-dir",
  "--source-file",
  "--target-dir",
  "--target-file",
  "--source-lang",
  "--target-lang",
  "--target-class",
  "--target-method",
  "--max-steps",
  "--max-rounds",
  "--api-key",
  "--timeout-ms",
]);
const BOOLEAN_FLAGS = new Set(["--json"]);

/** 解析 CLI 参数(`--key value` 格式)。非法参数 → { error }。 */
export function parseArgs(argv: string[]): SmokeCliOptions | { error: string } {
  const options: SmokeCliOptions = {
    requirement: "",
    sourceLang: "C#",
    targetLang: "Java",
    maxSteps: 40,
    maxRounds: 3,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--json") options.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined) return { error: `Missing value for ${flag}.` };
    i += 1;
    switch (flag) {
      case "--requirement":
        options.requirement = value;
        break;
      case "--source-dir":
        options.sourceDir = value;
        break;
      case "--source-file":
        options.sourceFile = value;
        break;
      case "--target-dir":
        options.targetDir = value;
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
      case "--target-lang": {
        if (value !== "Java" && value !== "C#" && value !== "Python" && value !== "TypeScript") {
          return { error: `Invalid --target-lang: "${value}" (must be Java, C#, Python, or TypeScript).` };
        }
        options.targetLang = value;
        break;
      }
      case "--target-class":
        options.targetClass = value;
        break;
      case "--target-method":
        options.targetMethod = value;
        break;
      case "--max-steps": {
        if (!/^\d+$/.test(value)) return { error: `Invalid --max-steps: "${value}" (must be a non-negative integer).` };
        options.maxSteps = Number.parseInt(value, 10);
        break;
      }
      case "--max-rounds": {
        if (!/^\d+$/.test(value)) return { error: `Invalid --max-rounds: "${value}" (must be a non-negative integer).` };
        options.maxRounds = Number.parseInt(value, 10);
        break;
      }
      case "--api-key":
        options.apiKey = value;
        break;
      case "--timeout-ms": {
        if (!/^\d+$/.test(value)) return { error: `Invalid --timeout-ms: "${value}" (must be a non-negative integer).` };
        options.timeoutMs = Number.parseInt(value, 10);
        break;
      }
    }
  }
  if (!options.requirement.trim()) return { error: "Missing required option: --requirement <text>." };
  if (!options.sourceDir && !options.sourceFile) return { error: "Missing source side: pass --source-dir and/or --source-file." };
  if (!options.targetDir && !options.targetFile) return { error: "Missing target side: pass --target-dir and/or --target-file." };
  return options;
}

/** 人类可读的 SmokeReport 输出。 */
export function formatSmokeReport(report: SmokeReport): string {
  const lines = [
    "Smoke 报告",
    `收敛:${report.converged} | 步数:${report.steps} | 修复轮数:${report.rounds} | case 数:${report.cases.length}`,
    "--- 用例裁决 ---",
  ];
  for (const c of report.cases) {
    lines.push(
      `  [${c.caseId}] decision=${c.decision} mechanical=${c.mechanical} intent="${c.intent}"\n      reasoning: ${c.reasoning || "(无)"}`,
    );
  }
  if (report.sourceIssues.length > 0) {
    lines.push("--- 源侧疑似缺陷(agent 标注) ---");
    for (const issue of report.sourceIssues) lines.push(`  - ${issue}`);
  }
  lines.push("--- 修复后目标文件(未采纳不落盘) ---");
  for (const file of report.targetFiles) {
    lines.push(`  ${file.path} (${file.content.length} 字符)`);
  }
  lines.push(`--- 总结 ---\n${report.summary || "(无)"}`);
  return lines.join("\n");
}

/** 运行冒烟 CLI,返回退出码(0=收敛,1=未收敛,2=错误)。 */
export async function runSmokeCli(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR) process.env.VERIFIER_LOG_DIR = "logs";
  const parsed = parseArgs(argv);
  if (!("error" in parsed) && parsed.json) {
    process.env.VERIFIER_LOG_LEVEL = "ERROR";
  }
  const logger = createLogger("smoke-cli");
  if ("error" in parsed) {
    logger.error(`参数错误:${parsed.error}`);
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  logger.info(
    `Smoke CLI 开始:requirement="${parsed.requirement.slice(0, 120)}", source-lang=${parsed.sourceLang}, target-lang=${parsed.targetLang}`,
  );
  const agent = new SmokeAgent({
    requirement: parsed.requirement,
    sourceLang: parsed.sourceLang,
    targetLang: parsed.targetLang,
    sourceDir: parsed.sourceDir ? resolve(parsed.sourceDir) : undefined,
    sourceFile: parsed.sourceFile ? resolve(parsed.sourceFile) : undefined,
    targetDir: parsed.targetDir ? resolve(parsed.targetDir) : undefined,
    targetFile: parsed.targetFile ? resolve(parsed.targetFile) : undefined,
    targetClass: parsed.targetClass,
    targetMethod: parsed.targetMethod,
    maxSteps: parsed.maxSteps,
    maxRounds: parsed.maxRounds,
    apiKey: parsed.apiKey,
    timeoutMs: parsed.timeoutMs,
    logger,
  });
  const report = await agent.run();
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatSmokeReport(report));
  }
  logger.info(`Smoke CLI 结束:converged=${report.converged}, exitCode=${report.converged ? 0 : 1}`);
  return report.converged ? 0 : 1;
}

// 入口(独立运行)
const exitCode = await runSmokeCli(process.argv.slice(2));
process.exitCode = exitCode;
