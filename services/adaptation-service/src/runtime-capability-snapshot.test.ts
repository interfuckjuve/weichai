import { describe, expect, it } from "vitest";
import { validateMigrationRuntimeCapabilitySnapshot } from "@forexplore/workflow-core";
import {
  createAdaptationRuntimeCapabilitySnapshot,
  routeByExactPair,
} from "./runtime-capability-snapshot";

const createdAt = "2026-09-02T00:00:00.000Z";

describe("createAdaptationRuntimeCapabilitySnapshot", () => {
  it("materializes only explicitly reviewed source-target pairs", () => {
    const snapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt,
      analysisExecution: "trusted-host",
      verifierExecution: "trusted-isolated",
      workspaceMutationExecution: "trusted-host",
    });

    expect(validateMigrationRuntimeCapabilitySnapshot(snapshot)).toBe(snapshot);
    expect(snapshot.routes.map((route) => [
      route.sourceLanguageId,
      route.targetLanguageId,
      route.strategy,
    ])).toEqual([
      ["java", "csharp", "translate"],
      ["python", "typescript", "translate"],
      ["typescript", "python", "translate"],
    ]);
    expect(snapshot.routes.every((route) => route.availability.status === "available")).toBe(true);
    expect(routeByExactPair(snapshot, "Java", "C#")?.id)
      .toBe("forexplore.translate.java-to-csharp");
    expect(routeByExactPair(snapshot, "python", "csharp")).toBeUndefined();
  });

  it("marks production HTTP routes unavailable when required execution and mutation are disabled", () => {
    const snapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt,
      analysisExecution: "disabled",
      verifierExecution: "disabled",
      workspaceMutationExecution: "disabled",
    });

    expect(snapshot.routes).toHaveLength(3);
    for (const route of snapshot.routes) {
      expect(route.availability.status).toBe("unavailable");
      expect(route.availability.reasonCodes).toEqual(expect.arrayContaining([
        "source-analysis:external-host-required",
        "target-analysis:external-host-required",
        "behavior-validation:behavior-verifier-execution-disabled",
        "workspace-apply:http-workspace-apply-disabled",
        "workspace-rollback:http-workspace-rollback-disabled",
      ]));
      expect(route.stages.find((stage) => stage.stage === "behavior-validation"))
        .toEqual(expect.objectContaining({
          availability: expect.objectContaining({
            status: "unavailable",
            reasonCodes: ["behavior-verifier-execution-disabled"],
          }),
        }));
      expect(route.validationPolicy.checks.find((check) => check.id === "behavior-differential"))
        .toEqual(expect.objectContaining({ required: true, phase: "behavior" }));
    }
  });
});
