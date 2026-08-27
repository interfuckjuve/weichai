/**
 * variant 模块聚合导出:AID / TrickCatcher 变体轨道(LLM 变体 + 生成器输入 + 行为差异共识 oracle)。
 * 与现有 verify 双轨平行,不侵入现有语义。
 */
export {
  buildVariantPrompt,
  buildInputGeneratorPrompt,
  VARIANT_SYSTEM_PROMPT,
  INPUT_GENERATOR_SYSTEM_PROMPT,
} from "./prompts.js";
export type { VariantGenerationInput, InputGeneratorInput } from "./prompts.js";
export { VariantGeneratorAgent, extractJavaClass, renameClassName, stripPackageDeclaration, classNameOf } from "./variant-generator.js";
export {
  filterVariants,
  parseSourceContract,
  parseMethodSignature,
  buildBaseDescription,
  buildReferenceSide,
  buildVariantSideSpec,
  buildSideDriver,
  variantExtension,
  sameLanguageResultEqual,
} from "./variant-filter.js";
export type { FilteredVariant, VariantFilterOptions, SourceContract } from "./variant-filter.js";
export { InputGeneratorAgent, runInputGenerator, wrapGeneratorScript, dedupeInputs, diversitySample, toBatchDescription } from "./input-generator.js";
export type { GeneratedInputs } from "./input-generator.js";
export { buildConsensus, compareAgainstConsensus, oracleAsResult, DISPUTED_DETAIL_PREFIX } from "./consensus.js";
export type { ConsensusOracle, ConsensusOptions, ConsensusOutputGroup } from "./consensus.js";
export { verifyTargetAgainstAIDBaseline, verifyWithVariants } from "./aid-verifier.js";
export type { AIDJob, AIDJobOptions, AIDReplayBaseline, AIDVerificationReport } from "./aid-verifier.js";
