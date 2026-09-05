import { describe, expect, it } from "vitest";
import * as verifier from "./index.js";

const {
  buildSmokeTaskPrompt,
  createVerificationResult,
  runSmoke,
  translationVerifierSchemaVersion,
} = verifier;

describe("translation-verifier entry", () => {
  it("exposes the schema version constant", () => {
    expect(translationVerifierSchemaVersion).toBe("1.0");
  });

  it("exposes the smoke differential module API(runSmoke + prompt builder)", () => {
    expect(typeof runSmoke).toBe("function");
    expect(typeof buildSmokeTaskPrompt).toBe("function");
  });

  it("exposes the stable verification contract", () => {
    expect(typeof createVerificationResult).toBe("function");
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

