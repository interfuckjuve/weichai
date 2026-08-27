/**
 * AID / TrickCatcher 变体轨道的三个提示词模板(只读借鉴 paper/src/TrickCatcher/Datasets 下
 * 各 PromptTemplates 目录):
 * - buildVariantPrompt:借鉴 genprog_tc("找 bug 并修复")+ genprog_dfp("按规范生成实现"),
 *   要求生成「行为等价需求、可修复源方法历史缺陷、策略多样」的源语言替代实现;
 * - buildInputGeneratorPrompt:借鉴 geninput_generator_sys(写 sample_one() 输入生成器),
 *   要求 LLM 写 TS 生成器脚本而非直接列输入(把逻辑与计算分离,规避 LLM 计算弱点)。
 */
import type { VerifierLanguage } from "../description.js";

// ---------------------------------------------------------------------------
// 变体生成(genprog_tc / genprog_dfp)
// ---------------------------------------------------------------------------

export interface VariantGenerationInput {
  /** 用户需求,最高优先级(需求第一)。 */
  requirement: string;
  /** 变体语言 = 源语言(变体是源方法的替代实现,与目标侧跨语言比较)。 */
  sourceLanguage: VerifierLanguage;
  /** 源方法完整文件(参考实现,可能含历史缺陷)。 */
  sourceCode: string;
  /** 目标契约(签名约束:类名/方法名/isStatic;变体保持源方法签名)。 */
  target: { className: string; method: string; isStatic: boolean };
  /** 生成变体数;默认 3。 */
  variantCount?: number;
  /** 来源仓库(提示词引用与报告追踪)。 */
  repository?: string;
  /** 来源文件路径(仓库相对路径)。 */
  sourcePath?: string;
  /** 实现扩展:本次生成要求采用的实现策略(对抗变体趋同;由 agent 按变体序号轮换)。 */
  strategyHint?: string;
}

export const VARIANT_SYSTEM_PROMPT = `You are a professional translation verification specialist. You will receive a user
REQUIREMENT (highest priority) and a REFERENCE_IMPLEMENTATION (a source method that may contain historical
defects — it is NOT the ground truth). Your task: produce a COMPLETE, COMPILABLE alternative implementation
of the source method in the same source language, behaviorally equivalent to the REQUIREMENT (repair any
defects you find in the reference implementation per the requirement).
Constraints:
1. Keep the EXACT same signature as the source method: method name, parameter types and order, return type, static-ness.
2. Use ONLY the standard library — no third-party dependencies, no external frameworks.
3. Use a DIFFERENT implementation strategy from the reference (e.g. iteration vs recursion, different data
   structures or algorithms, different control-flow style) so the variant is not a copy of the reference.
4. Output a single complete file containing ONE public class (the method's owner) plus any package-private
   helper classes it needs. Do NOT include a package declaration. Do not add unused imports.
5. Reply with ONLY the complete code — no markdown fences, no explanation, no trailing commentary.`;

export function buildVariantPrompt(input: VariantGenerationInput): string {
  const strategy = input.strategyHint?.trim()
    ? `\nImplementation strategy to use (IMPORTANT — vary the strategy across variants to avoid convergence):\n${input.strategyHint}`
    : "";
  return `${VARIANT_SYSTEM_PROMPT}

REQUIREMENT (highest priority)
${input.requirement}

REFERENCE_IMPLEMENTATION
Source language: ${input.sourceLanguage}${input.repository ? `\nRepository: ${input.repository}` : ""}${input.sourcePath ? `\nPath: ${input.sourcePath}` : ""}
Target contract:
- className: ${input.target.className}
- method: ${input.target.method}
- isStatic: ${input.target.isStatic}

SOURCE_METHOD
\`\`\`
${input.sourceCode}
\`\`\`
${strategy}`;
}

// ---------------------------------------------------------------------------
// 输入生成器(geninput_generator_sys → TS + TypedValue 化)
// ---------------------------------------------------------------------------

export interface InputGeneratorInput {
  /** 用户需求,最高优先级。 */
  requirement: string;
  /** 源语言(生成器针对源方法签名产输入)。 */
  sourceLanguage: VerifierLanguage;
  /** 源方法完整文件(参数类型/约束的唯一真相来源)。 */
  sourceCode: string;
  /** 目标输入数;默认 50。 */
  count?: number;
  /** 参数列表文本(如 "decodeText(string value)"),供生成器约束参数。 */
  targetSignature: string;
}

export const INPUT_GENERATOR_SYSTEM_PROMPT = `You are a professional software testing engineer. You will receive a user
REQUIREMENT, a SOURCE_METHOD (reference implementation), and the TARGET_SIGNATURE (the parameter list the
generated inputs must match). Write a TypeScript input generator for the method — DO NOT generate concrete
outputs yourself (the oracle is derived from execution, not from your arithmetic).
The generator must define a single top-level function:

  function sampleOne(): TypedValue[]

where TypedValue is the language-agnostic tagged value used by this verifier:
  { type: "string", value: "..." } | { type: "number", value: 1 } | { type: "boolean", value: true }
  | { type: "null", value: null } | { type: "list", value: TypedValue[] } | { type: "map", value: { [k]: TypedValue } }

Each call returns the full argument list for ONE invocation of the method, in parameter order, matching the
TARGET_SIGNATURE types. Mix random values, boundary values (empty / min-max / off-by-one / negative / zero /
long strings / invalid encodings) and exception-triggering values — input diversity is the priority.
Do NOT export the function and do NOT call it at the top level (the runner appends the sampling loop).
Reply with ONLY the complete TypeScript code — no markdown fences, no explanation.`;

export function buildInputGeneratorPrompt(input: InputGeneratorInput): string {
  return `${INPUT_GENERATOR_SYSTEM_PROMPT}

REQUIREMENT (highest priority)
${input.requirement}

SOURCE_METHOD (reference implementation)
\`\`\`
${input.sourceCode}
\`\`\`

TARGET_SIGNATURE (parameter list the generated inputs must match)
${input.targetSignature}

The runner will call sampleOne() ${input.count ?? 50} times.`;
}
