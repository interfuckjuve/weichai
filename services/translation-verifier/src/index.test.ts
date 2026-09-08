import { describe, expect, expectTypeOf, it } from "vitest";
import * as packageVerifier from "@forexplore/translation-verifier";
import * as verifier from "./index.js";

const {
  createDefaultVerificationService,
  translationVerifierSchemaVersion,
  VerificationService,
  VerificationStrategyFactory,
  resolveVerificationPolicy,
  failureAssessment,
} = verifier;
describe("translation-verifier entry", () => {
  it("preserves public verification and result-builder signatures", () => {
    type Input = packageVerifier.VerificationInput;
    type Descriptor = packageVerifier.VerificationStrategyDescriptor;
    type Result = packageVerifier.VerificationResult;
    type Receipt = packageVerifier.VerificationReceipt;
    type VerifyArgs = [
      Input,
      { strategyId?: string; keepWorkspace?: boolean }?,
      AbortSignal?,
    ];
    expectTypeOf<packageVerifier.VerificationService["verify"]>().toEqualTypeOf<
      (...args: VerifyArgs) => Promise<Result>
    >();
    expectTypeOf<
      packageVerifier.VerificationService["verifyWithReceipt"]
    >().toEqualTypeOf<(...args: VerifyArgs) => Promise<Receipt>>();
    expectTypeOf(packageVerifier.createVerificationResult).toEqualTypeOf<
      (
        input: Input,
        descriptor: Descriptor,
        output: packageVerifier.VerificationStrategyOutput,
        now?: () => string,
      ) => Result
    >();
    expectTypeOf(packageVerifier.assertVerificationInput).toEqualTypeOf<
      (input: Input) => Input
    >();
    expectTypeOf(packageVerifier.assertVerificationResult).toEqualTypeOf<
      (result: Result, input: Input, descriptor: Descriptor) => Result
    >();
    expectTypeOf(packageVerifier.assertVerificationReceipt).toEqualTypeOf<
      (receipt: Receipt, input: Input, descriptor: Descriptor) => Receipt
    >();
    expectTypeOf(packageVerifier.resolveVerificationPolicy).toBeFunction();
    expectTypeOf(packageVerifier.failureAssessment).toBeFunction();
  });
  it("preserves every runtime package export after internal moves", () => {
    expect(Object.keys(packageVerifier).sort()).toEqual(
      [
        "DIFFERENTIAL_SMOKE_STRATEGY",
        "VerificationService",
        "VerificationStrategyFactory",
        "assertVerificationInput",
        "assertVerificationReceipt",
        "assertVerificationResult",
        "assertVerificationRun",
        "createDefaultVerificationService",
        "createVerificationResult",
        "failureAssessment",
        "resolveVerificationPolicy",
        "translationVerifierSchemaVersion",
        "validateRunEventSchema",
        "validateRunSchema",
      ].sort(),
    );
    for (const key of Object.keys(verifier)) {
      expect(packageVerifier[key as keyof typeof packageVerifier]).toBe(
        verifier[key as keyof typeof verifier],
      );
    }
  });
  it("exports run validation without exposing a mutable Ajv instance", () => {
    expect(typeof verifier.validateRunSchema).toBe("function");
    expect(typeof verifier.validateRunEventSchema).toBe("function");
    expect(typeof verifier.assertVerificationRun).toBe("function");
    expect(verifier).not.toHaveProperty("ajv");
  });

  it("exposes the schema version constant", () => {
    expect(translationVerifierSchemaVersion).toBe("2.0");
  });

  it("keeps smoke internals out of the framework API", () => {
    expect(verifier).not.toHaveProperty("deriveCompatibilityStatus");
    expect(verifier).not.toHaveProperty("runSmoke");
    expect(verifier).not.toHaveProperty("buildSmokeTaskPrompt");
    expect(verifier).not.toHaveProperty("evaluateSmokeReport");
  });

  it("exposes the verification strategy framework API", () => {
    expect(typeof VerificationStrategyFactory).toBe("function");
    expect(typeof VerificationService).toBe("function");
    expect(typeof createDefaultVerificationService).toBe("function");
    expect(typeof resolveVerificationPolicy).toBe("function");
    expect(typeof failureAssessment).toBe("function");
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
