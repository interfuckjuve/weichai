import { describe, expect, it } from "vitest";
import type {
  VerificationResult,
  VerificationStrategy,
  VerificationStrategyDescriptor,
  VerificationStrategyProvider,
} from "../schemas/verification-types.js";
import { VerificationStrategyFactory } from "./select-strategy.js";

const descriptor: VerificationStrategyDescriptor = {
  id: "fixture",
  version: "1.0.0",
  displayName: "Fixture Strategy",
};

const result = {
  schemaVersion: "2.0",
  strategyId: descriptor.id,
  strategyVersion: descriptor.version,
  subjectHash: "a".repeat(64),
  inputHash: "c".repeat(64),
  round: 0,
  summary: "ok",
  issues: [],
  artifacts: [],
  strategyReport: {},
  mode: "target_only",
  referenceDecision: "undetermined",
  referenceReason: "The Host has not accepted the reference implementation.",
  executionStatus: "completed",
  sourceAssessment: "not_checked",
  targetAssessment: "no_bug_observed",
  problems: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  contentHash: "b".repeat(64),
} satisfies VerificationResult;

function provider(): VerificationStrategyProvider {
  return {
    descriptor,
    create: () =>
      ({
        instance: Math.random(),
        verify: async () => result,
      }) as VerificationStrategy,
  };
}

describe("VerificationStrategyFactory", () => {
  it("creates a fresh strategy for each request", () => {
    let instances = 0;
    const freshProvider: VerificationStrategyProvider = {
      descriptor,
      create: () =>
        ({
          instance: ++instances,
          verify: async () => result,
        }) as VerificationStrategy,
    };
    const factory = new VerificationStrategyFactory([freshProvider]);

    expect(factory.create("fixture")).not.toBe(factory.create("fixture"));
    expect(instances).toBe(2);
  });

  it("rejects duplicate and unknown strategy IDs", () => {
    const currentProvider = provider();
    expect(
      () => new VerificationStrategyFactory([currentProvider, currentProvider]),
    ).toThrow(/duplicate/i);
    expect(() =>
      new VerificationStrategyFactory([currentProvider]).create("missing"),
    ).toThrow(/unknown/i);
  });

  it("returns cloned descriptors", () => {
    const listed = new VerificationStrategyFactory([provider()]).list();

    expect(listed).toEqual([descriptor]);
    expect(listed[0]).not.toBe(descriptor);
    listed[0].displayName = "mutated";
    expect(descriptor.displayName).toBe("Fixture Strategy");
  });
});
