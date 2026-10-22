import { describe, expect, it } from "vitest";
import { createVerifier } from "./verify.js";
import type { AgentTask } from "./host/agent/task.js";
import type { VerificationInput } from "./types.js";

const input: VerificationInput = {
  schemaVersion: "2.0",
  sourceLanguage: "Python",
  targetLanguage: "Java",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  subject: {
    sourceFunction: { path: "src/source.py", name: "source_fn" },
    targetFunction: { path: "src/Target.java", name: "target_fn" },
    requirement: "Preserve the method behavior.",
  },
  analysisReport: {
    schemaVersion: "1.0",
    applicability: { level: "reference", confidence: 1, reasons: [] },
    behaviorMapping: [],
    contractMapping: [],
    dependencyPlan: [],
    implementationPlan: [],
    risks: [],
    assumptions: [],
    unresolved: [],
  },
  migrationPlan: {},
  translation: {
    round: 0,
    files: [],
  },
};

const noBugResult = {
  verdict: "no-bug" as const,
  summary: "The target function passed the complete dedicated test folder.",
};

describe("createVerifier", () => {
  it("starts the selected strategy with the upstream input", async () => {
    const tasks: AgentTask[] = [];
    const verify = createVerifier({
      run: (task) => {
        tasks.push(task);
        return noBugResult;
      },
    });

    await expect(verify(input, "single-agent", "verify")).resolves.toEqual({
      status: "success",
    });
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.taskContext.targetFunction).toEqual(input.subject.targetFunction);
    expect(task.systemPrompt).toContain("translation verification agent");
    expect(task.userPrompt).toContain("src/source.py");
    expect(task.userPrompt).toContain("target_fn in src/Target.java");
  });

  it("rejects an unsupported strategy", async () => {
    const verify = createVerifier({ run: () => noBugResult });

    await expect(verify(input, "black-box", "verify")).rejects.toThrow(
      "Unknown verification strategy: black-box",
    );
  });

  it("rejects prepare for the single-phase strategy", async () => {
    const verify = createVerifier({ run: () => noBugResult });

    await expect(verify(input, "single-agent", "prepare")).rejects.toThrow(
      "Verification strategy single-agent does not implement phase: prepare",
    );
  });
});
