/** Current output contract version; input and run contracts remain 1.0. */
export const translationVerifierSchemaVersion = "2.0" as const;

export * from "./schemas/verification-types.js";
export {
  resolveVerificationPolicy,
  failureAssessment,
} from "./schemas/verification-assessment.js";
export { assertVerificationInput } from "./schemas/validate-verification-input.js";
export { assertVerificationResult } from "./schemas/validate-verification-result.js";
export { assertVerificationReceipt } from "./schemas/validate-verification-receipt.js";
export { assertVerificationRun } from "./schemas/validate-verification-run.js";
export { createVerificationResult } from "./schemas/materialize-verification-result.js";
export {
  validateRunSchema,
  validateRunEventSchema,
} from "./schemas/compile-schema-validators.js";
export { VerificationStrategyFactory } from "./workflow/strategy-registry.js";
export { VerificationService } from "./verification-service.js";
export { createDefaultVerificationService } from "./create-default-verifier.js";
export { DIFFERENTIAL_SMOKE_STRATEGY } from "./strategies/smoke-differential/strategy.js";
export {
  MULTI_AGENT_DIFFERENTIAL_STRATEGY,
  MultiAgentDifferentialStrategy,
} from "./strategies/multi-agent-differential/strategy.js";
export {
  MULTI_AGENT_BLACK_BOX_STRATEGY,
  MultiAgentBlackBoxStrategy,
} from "./strategies/multi-agent-black-box/strategy.js";
export { SINGLE_AGENT_DIFFERENTIAL_STRATEGY } from "./strategies/single-agent-differential/strategy.js";
