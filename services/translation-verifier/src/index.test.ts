import { describe, expect, it } from "vitest";
import * as verifier from "./index.js";

const {
  createDefaultVerificationService,
  translationVerifierSchemaVersion,
  VerificationService,
  VerificationStrategyFactory,
} = verifier;

describe("translation-verifier entry", () => {
  it("exports run validation without exposing a mutable Ajv instance", () => {
    expect(typeof verifier.validateRunSchema).toBe("function");
    expect(typeof verifier.validateRunEventSchema).toBe("function");
    expect(typeof verifier.assertVerificationRun).toBe("function");
    expect(verifier).not.toHaveProperty("ajv");
  });

  it("exposes the schema version constant", () => {
    expect(translationVerifierSchemaVersion).toBe("1.0");
  });

  it("keeps smoke internals out of the framework API", () => {
    expect(verifier).not.toHaveProperty("runSmoke");
    expect(verifier).not.toHaveProperty("buildSmokeTaskPrompt");
    expect(verifier).not.toHaveProperty("evaluateSmokeReport");
  });

  it("exposes the verification strategy framework API", () => {
    expect(typeof VerificationStrategyFactory).toBe("function");
    expect(typeof VerificationService).toBe("function");
    expect(typeof createDefaultVerificationService).toBe("function");
  });

  it("does not expose the removed legacy driver API", () => {
    expect(verifier).not.toHaveProperty("verify");
    expect(verifier).not.toHaveProperty("executeSide");
    expect(verifier).not.toHaveProperty("RealDriverExecutor");
    expect(verifier).not.toHaveProperty("generateDriverSource");
    expect(verifier).not.toHaveProperty("generateSourceDriverSource");
    expect(verifier).not.toHaveProperty("TestMigratorAgent");
  });
});

