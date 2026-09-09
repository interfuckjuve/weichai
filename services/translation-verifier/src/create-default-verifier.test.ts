import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createDefaultVerificationService } from "./create-default-verifier.js";
import { assertVerificationReceipt } from "./schemas/validate-verification-receipt.js";
import type { VerificationInput } from "./schemas/verification-types.js";
import { SINGLE_AGENT_DIFFERENTIAL_STRATEGY } from "./strategies/single-agent-differential/strategy.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function input(): VerificationInput {
  const content = "module.exports = value => value;";
  const files: FilePatch[] = [
    {
      path: "implementation.cjs",
      status: "created",
      expectedAbsent: true,
      additions: 1,
      deletions: 0,
      hunks: [{ header: "@@ -0,0 +1,1 @@", lines: [{ type: "add", content }] }],
    },
  ];
  return {
    schemaVersion: "1.0",
    request: {
      requirement: "Return the input unchanged.",
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
    } as unknown as AdaptationRequestV2,
    analysisReport: { applicability: { level: "reject" } },
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent: content,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

describe("default service strategy integration", () => {
  it("selects the single session runtime and persists a bound failure when it supplies no evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "verifier-registration-"));
    roots.push(root);
    const sessions: string[] = [];
    const service = createDefaultVerificationService({
      workspaceRoot: join(root, "workspaces"),
      artifactRoot: join(root, "artifacts"),
      singleAgent: {
        runtime: {
          async runAgent(task) {
            sessions.push(task.sessionRole ?? "legacy");
            return {
              exitCode: 0,
              timedOut: false,
              durationMs: 1,
              stdout: "No tests supplied",
              stderr: "",
            };
          },
          async runCommand() {
            throw new Error("Unexpected separate replay");
          },
        },
      },
    });
    const request = input();
    const receipt = await service.verifyWithReceipt(request, {
      strategyId: SINGLE_AGENT_DIFFERENTIAL_STRATEGY.id,
    });
    expect(sessions).toEqual(["single-agent"]);
    expect(receipt.result).toMatchObject({
      strategyId: SINGLE_AGENT_DIFFERENTIAL_STRATEGY.id,
      subjectHash: request.translation.patchHash,
      executionStatus: "failed",
      targetAssessment: "inconclusive",
      problems: [{ code: "insufficient_test_basis" }],
    });
    expect(receipt.resultArtifact).toBeDefined();
    expect(() =>
      assertVerificationReceipt(
        receipt,
        request,
        SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
      ),
    ).not.toThrow();

    const defaultReceipt = await service.verifyWithReceipt(request);
    expect(defaultReceipt.result.strategyId).toBe("differential-smoke");
    expect(sessions).toHaveLength(1);
  });
});
