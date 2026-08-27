/**
 * InputGeneratorAgent + runInputGenerator:论文 geninput_generator 的工程化实现。
 * - InputGeneratorAgent:LLM 写「输入生成器脚本」(把逻辑与计算分离,规避 LLM 计算弱点);
 * - runInputGenerator:包装采样循环 → 经 executor.run 执行(TS 脚本)→ stdout JSON 解析
 *   → validateTypedValue 校验 → 去重 → 多样性采样 → 截断到 count;
 * - toBatchDescription:把批量输入合成为「扩展 description」(cases = 每输入一个 case),
 *   复用现有 generateDriverSource / generateSourceDriverSource 一次编译一次运行产出全部结果。
 */
import { runClaude, type ClaudeClientOptions } from "../claude-client.js";
import { validateTypedValue, type TestCase, type TestDescription, type TypedValue } from "../description.js";
import type { DriverExecutor, RunOutcome, SideSpec } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import { buildInputGeneratorPrompt, type InputGeneratorInput } from "./prompts.js";

export type { InputGeneratorInput } from "./prompts.js";

export interface GeneratedInputs {
  inputs: TypedValue[][];
  /** 包装后的完整脚本(含采样循环,供回放/调试)。 */
  source: string;
  /** 解析/校验/执行错误(不影响已产出的合法输入)。 */
  errors: string[];
}

export class InputGeneratorAgent {
  readonly #options: ClaudeClientOptions;
  readonly #logger: Logger;

  constructor(options: ClaudeClientOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("input-generator");
  }

  /** 生成 TS 输入生成器脚本(仅代码;采样循环由 runInputGenerator 追加)。 */
  async generate(input: InputGeneratorInput, signal?: AbortSignal): Promise<string> {
    const prompt = buildInputGeneratorPrompt(input);
    this.#logger.debug(`buildInputGeneratorPrompt 输出:\n${prompt}`);
    try {
      const raw = await runClaude(prompt, this.#options);
      const script = stripFences(raw).trim();
      if (!script) throw new Error("InputGeneratorAgent returned an empty script.");
      this.#logger.debug(`生成器脚本(截断):\n${truncate(script, 800)}`);
      return script;
    } catch (error) {
      this.#logger.error(`输入生成器失败:${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// 脚本执行与输入校验
// ---------------------------------------------------------------------------

/** 在 LLM 脚本后追加采样循环:调用 sampleOne() count 次,stdout 输出 {"inputs": [...]}。 */
export function wrapGeneratorScript(script: string, count: number): string {
  return `${script.trim()}

// --- 以下由 runInputGenerator 追加:采样循环(调用上方定义的 sampleOne) ---
const __sampleCount = ${count};
const __inputs: unknown[] = [];
for (let __i = 0; __i < __sampleCount; __i += 1) { __inputs.push(sampleOne()); }
process.stdout.write(JSON.stringify({ inputs: __inputs }));`;
}

/**
 * 执行输入生成器脚本:executor.run(TS)→ 解析 stdout → 校验 TypedValue → 去重 → 多样性采样截断。
 * 脚本退出码非零 / stdout 非法 / 输入校验失败均记录到 errors(不抛错,便于上层降级)。
 */
export async function runInputGenerator(
  script: string,
  count: number,
  executor: DriverExecutor,
  logger: Logger = createLogger("input-generator"),
): Promise<GeneratedInputs> {
  const errors: string[] = [];
  const wrapped = wrapGeneratorScript(script, count);
  const side: SideSpec = { language: "TypeScript", driverSource: wrapped, sourceFiles: [] };
  logger.debug(`生成器脚本(包装后,截断):\n${truncate(wrapped, 800)}`);

  let run: RunOutcome;
  try {
    run = await executor.run(side);
  } catch (error) {
    return {
      inputs: [],
      source: wrapped,
      errors: [`generator execution failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (run.exitCode !== 0) {
    return {
      inputs: [],
      source: wrapped,
      errors: [`generator script exited with code ${run.exitCode}: ${truncate(run.stderr, 300)}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (error) {
    return {
      inputs: [],
      source: wrapped,
      errors: [`generator stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).inputs)) {
    return { inputs: [], source: wrapped, errors: ["generator stdout must be an object with an inputs array."] };
  }

  const inputs: TypedValue[][] = [];
  for (const [i, entry] of (parsed as { inputs: unknown[] }).inputs.entries()) {
    if (!Array.isArray(entry)) {
      errors.push(`inputs[${i}] is not an array of TypedValue.`);
      continue;
    }
    try {
      const args: TypedValue[] = entry.map((v, j) => {
        validateTypedValue(v, `inputs[${i}][${j}]`);
        return v as TypedValue;
      });
      inputs.push(args);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (inputs.length === 0) errors.push("no valid inputs were produced by the generator.");

  const deduped = dedupeInputs(inputs);
  const sampled = diversitySample(deduped, count);
  logger.info(`输入生成器:产出 ${inputs.length} 个合法输入,去重后 ${deduped.length},采样截断为 ${sampled.length}`);
  return { inputs: sampled, source: wrapped, errors };
}

/** 按 canonical JSON 去重(递归展平为普通值,map 键排序)。 */
export function dedupeInputs(inputs: TypedValue[][]): TypedValue[][] {
  const seen = new Set<string>();
  const out: TypedValue[][] = [];
  for (const input of inputs) {
    const key = JSON.stringify(input.map(plainValue));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(input);
  }
  return out;
}

/**
 * 多样性采样:超过 count 时保留首尾 + 均匀间隔样本(确定性、覆盖分布范围,
 * 近似「保留边界类输入」的轻量启发式)。
 */
export function diversitySample(inputs: TypedValue[][], count: number): TypedValue[][] {
  if (count <= 0) return [];
  if (inputs.length <= count) return inputs;
  if (count === 1) return [inputs[0] as TypedValue[]];
  const out: TypedValue[][] = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i * (inputs.length - 1)) / (count - 1));
    out.push(inputs[idx] as TypedValue[]);
  }
  return out;
}

/** 递归展平为普通 JSON 值(去重键用)。 */
function plainValue(value: TypedValue): unknown {
  switch (value.type) {
    case "string":
    case "number":
    case "boolean":
    case "null":
      return value.value;
    case "list":
      return value.value.map(plainValue);
    case "map":
      return Object.fromEntries(
        Object.entries(value.value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, plainValue(item)]),
      );
  }
}

// ---------------------------------------------------------------------------
// 批量合成
// ---------------------------------------------------------------------------

/**
 * 把批量输入合成为「扩展 description」:基础 cases 保留(最小回归 + 共识-vs-expected 冲突标注),
 * 生成输入作为扩展 cases(id = gen_<i>,expected 占位,驱动生成只使用 inputs)。
 */
export function toBatchDescription(description: TestDescription, inputs: TypedValue[][]): TestDescription {
  return {
    ...description,
    cases: [
      ...description.cases,
      ...inputs.map((input, i) => ({
        id: `gen_${String(i).padStart(3, "0")}`,
        inputs: input,
        expected: { kind: "return", value: { type: "null", value: null } } as TestCase["expected"],
      })),
    ],
  };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:typescript|ts)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
