import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revalidateFunctionGroupReport } from "./revalidation.js";
import type {
  FunctionGroupTestRun,
  FunctionGroupTestRunner,
  ToolContext,
  ToolRuntimeContext,
} from "./tools/common.js";
import type { FunctionGroupFunctionResult, FunctionGroupVerificationInput } from "../types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const ORDER_PATH = "src/Order.java";

const input: FunctionGroupVerificationInput = {
  schemaVersion: "3.1",
  sourceLanguage: "C#",
  targetLanguage: "Java",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  requirement: "Preserve order pricing behavior.",
  functions: [
    { source: { path: "src/Order.cs", name: "CalculatePrice" }, target: { path: ORDER_PATH, name: "calculatePrice" } },
    { source: { path: "src/Order.cs", name: "ApplyDiscount" }, target: { path: ORDER_PATH, name: "applyDiscount" } },
  ],
};

function groupFunction(
  name: string,
  entry: Pick<FunctionGroupFunctionResult, "executed" | "status">,
): FunctionGroupFunctionResult {
  return {
    target: { path: ORDER_PATH, name },
    executed: entry.executed,
    status: entry.status,
    lineCoverage: entry.executed ? 100 : null,
    branchCoverage: null,
    reason: entry.status === "passed" ? "verified" : "not-executed",
  };
}

/** A Host context whose function-group runner is injected, so inconsistent runner output can be exercised. */
async function contextWithRunner(
  observation: FunctionGroupTestRun,
  requested: FunctionGroupVerificationInput = input,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "verifier-group-revalidation-"));
  roots.push(root);
  await mkdir(join(root, "tests/agent"), { recursive: true });
  await writeFile(join(root, "tests/agent/GroupTest.java"), "class GroupTest {}");
  const runtime: ToolRuntimeContext = {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    sourceProjectPath: root,
    targetProjectPath: root,
    sourcePath: ORDER_PATH,
    targetPath: ORDER_PATH,
    targetFunction: { path: ORDER_PATH, name: "calculatePrice" },
    sourceDirectory: "src",
    targetDirectory: "src",
    testRoots: ["tests/agent"],
    testRunner: "maven",
    targetTest: { executable: "mvn", args: [] },
    functionGroup: requested,
  };
  const functionGroupRunner: FunctionGroupTestRunner = { run: async () => observation };
  return {
    runtime,
    runner: { run: async () => { throw new Error("unused target runner"); } },
    functionGroupRunner,
  };
}

function suite(overrides: Partial<FunctionGroupTestRun> = {}): FunctionGroupTestRun {
  return {
    status: "success",
    testPaths: ["tests/agent/GroupTest.java"],
    tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
    executionErrors: 0,
    functions: [groupFunction("calculatePrice", { executed: true, status: "passed" }), groupFunction("applyDiscount", { executed: true, status: "passed" })],
    failures: [],
    stdout: "",
    stderr: "",
    exitCode: 0,
    reason: "verified",
    reportPaths: ["target/site/jacoco/jacoco.xml"],
    ...overrides,
  };
}

const noBug = { verdict: "no-bug" as const, summary: "Everything was checked." };
const uncertain = {
  verdict: "uncertain" as const,
  summary: "One requirement is unresolved.",
  issue: { kind: "unknown" as const, description: "The requirement never defines rounding for negative amounts." },
};

describe("function-group report revalidation", () => {
  it("accepts no-bug only when the suite succeeded and every target is passed", async () => {
    const context = await contextWithRunner(suite());
    const result = await revalidateFunctionGroupReport(context, noBug);
    expect(result.feedback).toEqual([]);
    expect(result.observation.functions.every(item => item.status === "passed")).toBe(true);
  });

  it("rejects no-bug when a target was executed but carries no passed status", async () => {
    const context = await contextWithRunner(suite({
      functions: [
        groupFunction("calculatePrice", { executed: true, status: "passed" }),
        // Executed with coverage, but the runner did not mark it passed.
        groupFunction("applyDiscount", { executed: true, status: "unverified" }),
      ],
    }));

    const result = await revalidateFunctionGroupReport(context, noBug);

    expect(result.feedback.join("\n")).toContain("pass");
    expect(result.feedback.join("\n")).toContain("applyDiscount");
  });

  it("rejects no-bug and uncertain when the suite status is not success even if every target is passed", async () => {
    const context = await contextWithRunner(suite({ status: "failure", reason: "test-failed" }));

    for (const report of [noBug, uncertain]) {
      const result = await revalidateFunctionGroupReport(context, report);
      expect(result.feedback.join("\n")).toContain("complete test folder");
    }
  });

  it("records a target the runner omitted as unverified instead of borrowing coverage", async () => {
    const context = await contextWithRunner(suite({
      functions: [groupFunction("calculatePrice", { executed: true, status: "passed" })],
    }));

    const result = await revalidateFunctionGroupReport(context, noBug);

    expect(result.observation.functions).toHaveLength(2);
    expect(result.observation.functions[1]).toMatchObject({
      target: { path: ORDER_PATH, name: "applyDiscount" },
      executed: false,
      status: "unverified",
      lineCoverage: null,
      branchCoverage: null,
    });
    expect(result.observation.functions[1]?.coverageIssue).toContain("no observation");
    expect(result.feedback.join("\n")).toContain("applyDiscount");
  });

  it("keeps a missing requested signature distinct from an empty affected signature", async () => {
    const context = await contextWithRunner(suite({
      status: "failure",
      reason: "test-failed",
      tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
    }));

    const result = await revalidateFunctionGroupReport(context, {
      verdict: "bug-found",
      summary: "Discounts are wrong.",
      issue: { kind: "translation", description: "applyDiscount violates the monotonic rule." },
      // The requested target has no signature at all; an empty signature is a
      // different identity, so this must not be accepted as in scope.
      affectedTargets: [{ path: ORDER_PATH, name: "applyDiscount", signature: "" }],
    });

    expect(result.feedback.join("\n")).toContain("must stay inside the requested function-group scope");
    expect(result.feedback.join("\n")).toContain("needs execution evidence from this Host run");
  });

  it("does not match an observation whose signature is empty when the requested signature is missing", async () => {
    const observed = groupFunction("applyDiscount", { executed: true, status: "passed" });
    observed.target = { path: ORDER_PATH, name: "applyDiscount", signature: "" };
    const context = await contextWithRunner(suite({
      functions: [groupFunction("calculatePrice", { executed: true, status: "passed" }), observed],
    }));

    const result = await revalidateFunctionGroupReport(context, noBug);

    expect(result.observation.functions[1]).toMatchObject({
      target: { path: ORDER_PATH, name: "applyDiscount" },
      executed: false,
      status: "unverified",
      lineCoverage: null,
      branchCoverage: null,
    });
    expect(result.observation.functions[1]?.target.signature).toBeUndefined();
    expect(result.feedback.join("\n")).toContain("applyDiscount");
  });

  it("matches an observation and affected target with the same declared signature", async () => {
    const signature = "Order.applyDiscount(int)";
    const requested: FunctionGroupVerificationInput = {
      ...input,
      functions: input.functions.map(mapping =>
        mapping.target.name === "applyDiscount"
          ? { ...mapping, target: { ...mapping.target, signature } }
          : mapping,
      ),
    };
    const observed = groupFunction("applyDiscount", { executed: true, status: "passed" });
    observed.target = { path: ORDER_PATH, name: "applyDiscount", signature };
    const context = await contextWithRunner(
      suite({
        status: "failure",
        reason: "test-failed",
        tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
        functions: [groupFunction("calculatePrice", { executed: true, status: "passed" }), observed],
      }),
      requested,
    );

    const result = await revalidateFunctionGroupReport(context, {
      verdict: "bug-found",
      summary: "Discounts are wrong.",
      issue: { kind: "translation", description: "applyDiscount violates the monotonic rule." },
      affectedTargets: [{ path: ORDER_PATH, name: "applyDiscount", signature }],
    });

    expect(result.feedback).toEqual([]);
    expect(result.observation.functions[1]).toMatchObject({ executed: true, status: "passed" });
  });

  it("rejects uncertain when a target is executed without a passed status", async () => {
    const context = await contextWithRunner(suite({
      functions: [
        groupFunction("calculatePrice", { executed: true, status: "unverified" }),
        groupFunction("applyDiscount", { executed: true, status: "passed" }),
      ],
    }));

    const result = await revalidateFunctionGroupReport(context, uncertain);

    expect(result.feedback.join("\n")).toContain("calculatePrice");
    expect(result.feedback.join("\n")).toContain("pass");
  });
});
