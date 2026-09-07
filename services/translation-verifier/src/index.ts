export const translationVerifierSchemaVersion = "1.0" as const;

export * from "./schemas/verification-types.js";
export { assertVerificationInput } from "./schemas/validate-verification-input.js";
export { assertVerificationResult } from "./schemas/validate-verification-result.js";
export { assertVerificationReceipt } from "./schemas/validate-verification-receipt.js";
export { assertVerificationRun } from "./schemas/validate-verification-run.js";
export { createVerificationResult } from "./run-output/create-verification-result.js";
export { validateRunSchema, validateRunEventSchema } from "./schemas/compile-schema-validators.js";
export { VerificationStrategyFactory } from "./strategies/strategy-registry.js";
export { VerificationService } from "./verification-service.js";
export { createDefaultVerificationService } from "./create-default-verifier.js";
export { DIFFERENTIAL_SMOKE_STRATEGY } from "./strategies/differential-smoke.js";
