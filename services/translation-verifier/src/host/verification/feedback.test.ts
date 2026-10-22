import { describe, expect, it } from "vitest";
import {
  feedbackMessage,
  functionGroupFeedbackMessage,
} from "./feedback.js";
import type { FunctionGroupTestRun, TargetTestResult } from "../tools/common.js";

const MAX_FEEDBACK_CHARS = 12_000;

function manyFunctions(count: number): FunctionGroupTestRun["functions"] {
  return Array.from({ length: count }, (_, index) => ({
    target: {
      path: `src/Module${index}.java`,
      name: `calculate${index}`,
      signature: `Module${index}.calculate${index}(int)`,
    },
    status: "unverified" as const,
    executed: false,
    lineCoverage: null,
    branchCoverage: null,
    reason: "coverage-unavailable" as const,
    coverageIssue: `The Host report contained no observation for target ${index}. `.repeat(4),
  }));
}

function groupRun(): FunctionGroupTestRun {
  return {
    status: "failure",
    timedOut: false,
    testPaths: ["tests/agent/GroupTest.java"],
    tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
    executionErrors: 0,
    functions: manyFunctions(48),
    failures: Array.from({ length: 12 }, (_, index) => ({
      message: `assertion ${index} failed: ${"detail ".repeat(200)}`,
      testPath: "tests/agent/GroupTest.java",
      suspectedFunctions: [],
    })),
    stdout: "BEGIN " + "compiler output ".repeat(4_000) + " END",
    stderr: "AssertionError: expected rejection ".repeat(300),
    exitCode: 1,
    reportPaths: ["target/site/jacoco/jacoco.xml", "target/surefire-reports/TEST-GroupTest.xml"],
  };
}

const conditions = [
  `A bug-found report must stay inside the requested function-group scope: ${Array.from({ length: 600 }, (_, index) => `src/Other${index}.java#other${index}`).join(", ")}.`,
  "This report requires execution evidence for every requested target function. Missing execution evidence: src/Module0.java#calculate0, src/Module1.java#calculate1.",
];

describe("Host feedback section budget", () => {
  it("keeps the rejection reasons, test counts and report paths visible for 40+ functions", () => {
    const message = functionGroupFeedbackMessage(conditions, groupRun());

    expect(message.length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    // The concrete reasons must survive; they are not the part that gets cut.
    expect(message).toContain("inside the requested function-group scope");
    expect(message).toContain("Missing execution evidence");
    expect(message).toContain("src/Module1.java#calculate1");
    // Host-owned facts stay: counts and where the fresh reports are.
    expect(message).toContain("tests executed: 2, passed: 1, failed: 1, skipped: 0");
    expect(message).toContain("target/site/jacoco/jacoco.xml");
    expect(message).toContain("target/surefire-reports/TEST-GroupTest.xml");
    // Long diagnostics and the 48-line coverage list only consume the rest.
    expect(message).toContain("BEGIN");
    expect(message).toMatch(/omitted|truncated/);
  });

  it("bounds an over-long condition itself instead of dropping the following ones", () => {
    const long = `A bug-found report must list the affected target functions: ${"x".repeat(20_000)}`;
    const message = functionGroupFeedbackMessage(
      [long, "This report requires execution evidence for every requested target function."],
      groupRun(),
    );

    expect(message.length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    expect(message).toContain("A bug-found report must list the affected target functions");
    expect(message).toContain("requires execution evidence for every requested target function");
    expect(message).toContain("additional characters");
  });

  it("keeps single-function facts and reasons when the runner output is huge", () => {
    const observation: TargetTestResult = {
      status: "failure",
      timedOut: false,
      exitCode: 1,
      stdout: "BEGIN " + "dump ".repeat(20_000) + " END",
      stderr: "AssertionError: expected rejection",
      durationMs: 1,
      tests: { executed: 1, passed: 0, failed: 1, skipped: 0 },
      testCases: [{ id: "BehaviorTest#requirement", status: "failed", message: "expected rejection" }],
      coverage: { status: "available", targetFunction: { name: "targetFn", executed: true, lineCoverage: 10, branchCoverage: null } },
      reportPaths: ["target/surefire-reports/TEST-BehaviorTest.xml"],
    };
    const message = feedbackMessage(
      [
        "A no-bug report requires every test in the dedicated folder to pass.",
        ...Array.from({ length: 40 }, (_, index) => `A no-bug report cannot be accepted while protocol checks are failed or ambiguous: rule-${index}.`),
      ],
      observation,
    );

    expect(message.length).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS);
    expect(message).toContain("A no-bug report requires every test in the dedicated folder to pass.");
    expect(message).toContain("BehaviorTest#requirement");
    expect(message).toContain("tests executed: 1, passed: 0, failed: 1, skipped: 0");
    expect(message).toContain("target/surefire-reports/TEST-BehaviorTest.xml");
    expect(message).toContain("BEGIN");
  });
});
