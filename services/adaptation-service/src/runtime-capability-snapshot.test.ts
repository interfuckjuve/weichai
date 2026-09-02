import { describe, expect, it } from "vitest";
import { validateMigrationRuntimeCapabilitySnapshot } from "@forexplore/workflow-core";
import {
  createAdaptationRuntimeCapabilitySnapshot,
  defaultExactTranslationRouteRegistrations,
  routeByExactPair,
} from "./runtime-capability-snapshot";
import { CompilerRouteRegistry } from "./compiler";

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
    const typeScriptToPython = routeByExactPair(snapshot, "typescript", "python")!;
    expect(typeScriptToPython.stages.find((stage) => stage.stage === "behavior-extraction"))
      .toMatchObject({ providerId: "forexplore.analyzer.deepseek", providerVersion: "1.0.0" });
    expect(typeScriptToPython.stages.find((stage) => stage.stage === "migration-planning"))
      .toMatchObject({ providerId: "forexplore.planner.deepseek", providerVersion: "1.0.0" });
    expect(typeScriptToPython.stages.find((stage) => stage.stage === "translation"))
      .toMatchObject({ providerId: "forexplore.translator.deepseek", providerVersion: "1.0.0" });
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

  it("registers an exact route for open LanguageIds without changing a central union", () => {
    const compilerRegistry = new CompilerRouteRegistry([{
      capability: {
        languageId: "elixir",
        displayName: "Elixir",
        providerId: "fixture.compiler.elixir",
        version: "1.0.0",
        standalone: { command: "fixture-elixir-check", level: "syntax" },
        integrated: { command: "fixture-elixir-project-check", level: "project-build-or-test" },
        quality: {
          provesBehavioralCorrectness: false,
          limitations: ["Fixture compiler capability."],
        },
      },
      standalone: () => ({ success: true, errors: [], output: "ok" }),
      integrated: () => ({ success: true, errors: [], output: "ok" }),
    }]);
    const snapshot = createAdaptationRuntimeCapabilitySnapshot({
      createdAt,
      analysisExecution: "trusted-host",
      verifierExecution: "trusted-isolated",
      workspaceMutationExecution: "trusted-host",
      compilerRegistry,
      routeRegistrations: [{
        id: "fixture.translate.erlang-to-elixir",
        name: "Erlang to Elixir fixture route",
        strategy: "translate",
        sourceLanguageId: "erlang",
        sourceDisplayName: "Erlang",
        targetLanguageId: "elixir",
        targetDisplayName: "Elixir",
      }],
    });

    expect(validateMigrationRuntimeCapabilitySnapshot(snapshot)).toBe(snapshot);
    const route = routeByExactPair(snapshot, "erlang", "elixir")!;
    expect(route.stages.find((stage) => stage.stage === "compile-validation"))
      .toMatchObject({
        providerId: "fixture.compiler.elixir",
        availability: { status: "available" },
      });
    expect(route.availability).toMatchObject({
      status: "unavailable",
      reasonCodes: expect.arrayContaining([
        "context-collection:target-context-capability-unavailable",
        "patch-generation:target-patch-locator-capability-unavailable",
        "behavior-validation:behavior-verifier-route-unavailable",
      ]),
    });
  });

  it("rejects duplicate exact route keys even when route IDs differ", () => {
    const defaults = defaultExactTranslationRouteRegistrations();
    expect(() => createAdaptationRuntimeCapabilitySnapshot({
      createdAt,
      analysisExecution: "disabled",
      verifierExecution: "disabled",
      workspaceMutationExecution: "disabled",
      routeRegistrations: [
        ...defaults,
        { ...defaults[0]!, id: "fixture.duplicate.java-to-csharp" },
      ],
    })).toThrow("Duplicate exact migration route java -> csharp (translate)");
  });
});
