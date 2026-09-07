export const translationVerifierSchemaVersion = "1.0" as const;

export * from "./verification-types.js";
export { validateRunSchema, validateRunEventSchema } from "./verification-schemas.js";
export { VerificationStrategyFactory } from "./verification-strategy-factory.js";
export { VerificationService } from "./verification-service.js";
export { createDefaultVerificationService } from "./default-verification-service.js";
export { DIFFERENTIAL_SMOKE_STRATEGY } from "./strategies/differential-smoke/strategy.js";
