import { describe, expect, it, vi } from "vitest";
import { prepareSmokeInput } from "./prepare-smoke-input.js";
import { acceptedPolicy } from "./differential-test-fixtures.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";

function fixture() {
  const declarations = [
    {
      path: "target.ts",
      attributes: { containerName: "Target", isStatic: true },
    },
  ];
  const input = {
    verificationPolicy: acceptedPolicy,
    request: {
      requirement: "identity",
      candidate: { entity: { languageId: "java", path: "Source.java" } },
      target: {
        entity: {
          languageId: "typescript",
          name: "identity",
          path: "target.ts",
        },
      },
      sourceBundle: { files: [{ path: "Source.java" }] },
      targetContext: { declarations, dependencies: [] },
    },
    analysisReport: {},
    migrationPlan: {},
  } as unknown as VerificationInput;
  const context = {
    workspace: {
      root: "/not-created",
      sourceRoot: "/not-created/source/project",
      targetRoot: "/not-created/target/project",
      strategyRoot: "/not-created/agent",
    },
  } as VerificationStrategyContext;
  return { input, context, declarations };
}

describe("pure smoke preflight", () => {
  it("resolves language and target declaration once without filesystem access", () => {
    const { input, context, declarations } = fixture();
    const find = vi.spyOn(declarations, "find");
    const prepared = prepareSmokeInput(input, context);
    expect(find).toHaveBeenCalledOnce();
    expect(prepared).toMatchObject({
      applicable: true,
      job: {
        source: { language: "Java" },
        target: { language: "TypeScript", className: "Target", isStatic: true },
      },
    });
    declarations[0].attributes.containerName = "Changed";
    expect(prepared).toMatchObject({
      job: { target: { className: "Target" } },
    });
  });
  it("target-only does not read rejected source bundle or workspace root", () => {
    const { input, context } = fixture();
    input.verificationPolicy = {
      ...acceptedPolicy,
      referenceDecision: "rejected",
    };
    Object.defineProperty(input.request, "sourceBundle", {
      get() {
        throw new Error("source bundle read");
      },
    });
    Object.defineProperty(context.workspace, "sourceRoot", {
      get() {
        throw new Error("source root read");
      },
    });
    const prepared = prepareSmokeInput(input, context);
    expect(prepared).toMatchObject({
      applicable: true,
      job: { source: { language: "TypeScript" } },
    });
    if (prepared.applicable) {
      expect(prepared.job.source.root).toBeUndefined();
      expect(prepared.job.source.candidatePath).toBeUndefined();
      expect(prepared.job.analysisReport).toBeUndefined();
    }
  });
  it("keeps failure precedence and returns the complete failed output", () => {
    const { input, context } = fixture();
    input.verificationPolicy = undefined;
    expect(prepareSmokeInput(input, context)).toMatchObject({
      applicable: false,
      output: {
        problems: [{ code: "insufficient_test_basis" }],
        artifacts: [],
        strategyReport: null,
      },
    });
  });
});
