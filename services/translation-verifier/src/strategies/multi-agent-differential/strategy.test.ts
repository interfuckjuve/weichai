import { afterEach, describe, expect, it, vi } from "vitest";
import * as workspace from "./behavior-workspace.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultiAgentDifferentialStrategy } from "./strategy.js";
import type { BehaviorAgentTask, BehaviorRuntime } from "./behavior-types.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";
import { normalizeVerificationStrategyOutput } from "../../schemas/materialize-verification-result.js";
import { createVerificationArtifactStore } from "../../run-output/verification-artifact-store.js";
import { runManagedProcess } from "../smoke-differential/manage-test-process.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(delta = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "behavior-strategy-")));
  directories.push(root);
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const strategyRoot = join(root, "artifacts-staging");
  for (const dir of [sourceRoot, targetRoot, strategyRoot]) mkdirSync(dir);
  writeFileSync(
    join(sourceRoot, "implementation.cjs"),
    "module.exports = value => value;",
  );
  writeFileSync(
    join(targetRoot, "implementation.cjs"),
    `module.exports = value => value + ${delta};`,
  );
  const store = createVerificationArtifactStore({
    artifactRoot: join(root, "durable"),
    durablePrefix: "attempt",
    agentRoot: strategyRoot,
  });
  const context: VerificationStrategyContext = {
    workspace: {
      root,
      sourceRoot,
      targetRoot,
      strategyRoot,
      evidenceRoot: strategyRoot,
    },
    deadlineAt: Date.now() + 10_000,
    writeArtifact: store.writeArtifact,
  };
  const input: VerificationInput = {
    schemaVersion: "1.0",
    request: {
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
    } as unknown as VerificationInput["request"],
    analysisReport: { applicability: { level: "direct" } },
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent: "",
      files: [],
      patchHash: "a".repeat(64),
    },
  };
  const agents: string[] = [];
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      agents.push(task.side);
      writeHarness(task);
      return {
        stdout: "Authored test harness",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
      };
    },
    runCommand: (task) =>
      runManagedProcess(
        {
          command: task.command.executable,
          args: task.command.args,
          cwd: task.sandbox.cwd,
          env: { PATH: process.env.PATH },
          deadlineAt: task.deadlineAt,
        },
        task.signal,
      ),
  };
  return { root, input, context, runtime, agents };
}
function independentFixture(delta = 1) {
  const f = fixture(delta);
  f.input.analysisReport = { applicability: { level: "reference" } };
  f.input.request.requirement = "Increment input by one";
  const author = f.runtime.runAgent;
  f.runtime.runAgent = async (task) => {
    const result = await author(task);
    const frozenPlan = JSON.stringify(targetPlan());
    writeFileSync(task.expectationFile!, frozenPlan);
    return { ...result, frozenPlan, commandEvidence: [targetRecord(task)] };
  };
  return f;
}
function targetPlan() {
  return {
    schemaVersion: "1.0",
    testBasis: {
      summary: "Increment the input",
      evidence: ["request.requirement"],
    },
    cases: [
      {
        caseId: "zero",
        intent: "zero input",
        input: 0,
        expectation: {
          kind: "requirement",
          rationale: "Increment required",
          provenance: ["request.requirement"],
          expected: { caseId: "zero", outcome: "return", value: 1 },
        },
      },
    ],
  };
}
function targetRecord(task: BehaviorAgentTask) {
  return {
    commandId: "target-probe",
    side: "target" as const,
    cwd: task.sandbox.cwd,
    command: { executable: process.execPath, args: ["tests/runner.cjs"] },
    baselineValid: true,
    credentialHit: false,
    completed: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: "[]",
    stderr: "",
  };
}
function writeHarness(task: BehaviorAgentTask) {
  const root = task.sandbox.writeRoots[0];
  const tests = join(task.sandbox.cwd, "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(tests, "runner.cjs"),
    `const fs = require('node:fs'); const subject = require('../implementation.cjs'); const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); process.stdout.write(JSON.stringify(cases.map(c => ({caseId:c.caseId,outcome:'return',value:subject(c.input)}))));`,
  );
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: task.side === "source" ? "3.0" : "2.0",
      testFiles: ["tests/runner.cjs"],
      notes:
        "Trusted deterministic fixture harness invokes implementation module.",
      ...(task.side === "source"
        ? {
            cases: [
              {
                caseId: "zero",
                intent: "zero input",
                input: 0,
                expectation: {
                  kind: "source",
                  rationale: "Preserve existing identity behavior",
                  provenance: ["analysisReport.applicability"],
                },
              },
              {
                caseId: "negative",
                intent: "negative input",
                input: -1,
                expectation: {
                  kind: "source",
                  rationale: "Preserve existing identity behavior",
                  provenance: ["analysisReport.applicability"],
                },
              },
            ],
          }
        : {}),
      commands: {
        setup: [],
        run: {
          executable: process.execPath,
          args: ["tests/runner.cjs"],
        },
      },
    }),
  );
}

describe("independent two-session differential strategy", () => {
  it.each(["reference", "reject"])(
    "skips Agent1 and source preparation for %s",
    async (level) => {
      const f = fixture(1);
      f.input.analysisReport = {
        applicability: { level },
        sourceSecret: "SOURCE_CONTEXT_MUST_NOT_LEAK",
      };
      f.input.request.requirement = "Increment the input by one";
      rmSync(f.context.workspace.sourceRoot, { recursive: true });
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        expect(task.side).toBe("target");
        expect(task.executionSides).toEqual(["target"]);
        expect(task.sandbox.readRoots).toEqual([
          f.context.workspace.targetRoot,
        ]);
        expect(task.additionalProjects).toBeUndefined();
        expect(task.prompt).toContain(
          "independent target verification (agent2)",
        );
        expect(task.prompt).not.toContain("<source-collection-context>");
        expect(task.prompt).not.toContain("<frozen-input-cases>");
        expect(task.prompt).not.toContain("SOURCE_CONTEXT_MUST_NOT_LEAK");
        expect(task.expectationFile).toBe(
          join(task.sandbox.cwd, ".forexplore-tests/target-plan.json"),
        );
        const result = await author(task);
        const frozenPlan = JSON.stringify(targetPlan());
        writeFileSync(task.expectationFile!, frozenPlan);
        return { ...result, frozenPlan, commandEvidence: [targetRecord(task)] };
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
        waitForTarget: async () => {
          expect(f.agents).toEqual([]);
        },
      }).verify(f.input, f.context);
      expect(f.agents).toEqual(["target"]);
      expect(result).toMatchObject({
        executionStatus: "completed",
        mode: "target_only",
        sourceAssessment: "not_checked",
        targetAssessment: "no_bug_observed",
      });
      expect(result.strategyReport).not.toHaveProperty("sourceSnapshot");
      expect(result.strategyReport).toMatchObject({
        targetPlan: { schemaVersion: "1.0" },
        evidence: [{ side: "target" }],
      });
      expect(
        result.artifacts.some((item) => item.kind.startsWith("source-")),
      ).toBe(false);
      expect(normalizeVerificationStrategyOutput(f.input, result)).toEqual(
        result,
      );
    },
  );
  it.each([0, 1])(
    "independently compares target behavior against requirement expectations (delta=%s)",
    async (delta) => {
      const f = independentFixture(delta);
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(result.targetAssessment).toBe(
        delta ? "no_bug_observed" : "bug_found",
      );
      expect(result.strategyReport).toMatchObject({
        cases: [
          { source: null, expected: { value: 1 }, target: { value: delta } },
        ],
      });
      expect(f.agents).toEqual(["target"]);
    },
  );
  it.each([
    "missing-plan",
    "no-freeze",
    "no-records",
    "source-activity",
    "wrong-cwd",
    "invalid-baseline",
    "credential",
    "unresolved",
    "uncited",
    "blank-basis",
    "source-expectation",
  ])("fails closed for independent target %s", async (scenario) => {
    const f = independentFixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      const plan = targetPlan();
      if (scenario === "unresolved") {
        Object.assign(plan.cases[0].expectation, { kind: "unresolved" });
        delete (plan.cases[0].expectation as { expected?: unknown }).expected;
      }
      if (scenario === "uncited") plan.cases[0].expectation.provenance = [" "];
      if (scenario === "blank-basis") plan.testBasis.summary = " ";
      if (scenario === "source-expectation") {
        Object.assign(plan.cases[0].expectation, { kind: "source" });
        delete (plan.cases[0].expectation as { expected?: unknown }).expected;
      }
      const frozenPlan = JSON.stringify(plan);
      writeFileSync(task.expectationFile!, frozenPlan);
      if (scenario === "missing-plan") rmSync(task.expectationFile!);
      const record = targetRecord(task);
      if (scenario === "source-activity")
        Object.assign(record, { side: "source" });
      if (scenario === "wrong-cwd") record.cwd = f.context.workspace.sourceRoot;
      if (scenario === "invalid-baseline") record.baselineValid = false;
      if (scenario === "credential") record.credentialHit = true;
      return {
        ...result,
        frozenPlan: scenario === "no-freeze" ? undefined : frozenPlan,
        commandEvidence: scenario === "no-records" ? [] : [record],
      };
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.sourceAssessment).toBe("not_checked");
    expect(f.agents).not.toContain("source");
    expect(result.strategyReport).not.toHaveProperty("sourceSnapshot");
  });
  it.each(["during-session", "during-replay", "during-repair"])(
    "rejects target plan mutation %s",
    async (phase) => {
      const f = independentFixture();
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await author(task);
        if (
          phase === "during-session" ||
          (phase === "during-repair" && f.agents.length > 1)
        ) {
          const plan = targetPlan();
          plan.cases[0].input = 20;
          writeFileSync(task.expectationFile!, JSON.stringify(plan));
          if (phase === "during-repair")
            return { ...result, frozenPlan: JSON.stringify(plan) };
        }
        return result;
      };
      const command = f.runtime.runCommand;
      f.runtime.runCommand = async (task) => {
        const result = await command(task);
        expect(task.sandbox.readOnlyFiles).toContain(
          join(task.sandbox.cwd, ".forexplore-tests/target-plan.json"),
        );
        if (phase === "during-replay")
          writeFileSync(
            join(task.sandbox.cwd, ".forexplore-tests/target-plan.json"),
            "{}",
          );
        return phase === "during-repair"
          ? { ...result, stdout: "invalid" }
          : result;
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(result.problems[0]?.code).toBe("workspace_integrity_violation");
      expect(result.targetAssessment).toBe("inconclusive");
    },
  );
  it("retains one bounded target harness repair without changing its design", async () => {
    const f = independentFixture();
    const command = f.runtime.runCommand;
    let runs = 0;
    f.runtime.runCommand = async (task) => {
      const result = await command(task);
      return ++runs === 1 ? { ...result, stdout: "invalid" } : result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("completed");
    expect(f.agents).toEqual(["target", "target"]);
    expect(result.strategyReport).toMatchObject({
      repairs: [{ side: "target", attempt: 1 }],
    });
  });
  it.each(["cancel", "timeout", "failure"])(
    "does not start independent Agent2 on readiness %s",
    async (mode) => {
      const f = independentFixture();
      const controller = new AbortController();
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
        timeoutMs: 80,
        waitForTarget: async () => {
          if (mode === "cancel") controller.abort();
          if (mode === "failure") throw new Error("not ready");
          await new Promise<void>(() => {});
        },
      }).verify(f.input, f.context, controller.signal);
      expect(result.executionStatus).toBe(
        mode === "cancel" ? "cancelled" : "failed",
      );
      expect(f.agents).toEqual([]);
      expect(
        result.artifacts.some((item) => item.kind.startsWith("source-")),
      ).toBe(false);
    },
  );
  it("preserves independent frozen plan and Host records when Agent2 is cancelled", async () => {
    const f = independentFixture();
    const controller = new AbortController();
    f.runtime.runAgent = async (task) => {
      task.onEvidence?.([targetRecord(task)], JSON.stringify(targetPlan()));
      controller.abort();
      throw controller.signal.reason;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context, controller.signal);
    expect(result.executionStatus).toBe("cancelled");
    const session = result.artifacts.find(
      (item) => item.kind === "target-agent-session",
    )!;
    expect(
      JSON.parse(readFileSync(join(f.root, "durable", session.path), "utf8")),
    ).toMatchObject({
      frozenPlan: JSON.stringify(targetPlan()),
      commandEvidence: [{ side: "target" }],
    });
  });
  it("cannot hide an observed source command by returning only target records", async () => {
    const f = independentFixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      task.onEvidence?.(
        [{ ...targetRecord(task), side: "source" }],
        result.frozenPlan,
      );
      return result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0]?.code).toBe("report_evidence_invalid");
    expect(result.targetAssessment).toBe("inconclusive");
  });
  it("refuses independent target execution without caller authorization", async () => {
    const f = independentFixture();
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
      executionSides: [],
    }).verify(f.input, f.context);
    expect(result.problems[0]?.code).toBe("context_incomplete");
    expect(f.agents).toEqual([]);
  });
  it("rejects independent Agent2 edits to the implementation", async () => {
    const f = independentFixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      writeFileSync(
        join(task.sandbox.cwd, "implementation.cjs"),
        "module.exports = () => 1;",
      );
      return result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0]?.code).toBe("workspace_integrity_violation");
  });
  it.each(["adapt"])(
    "uses a design-only Agent1 for %s and validates target requirements without Host policy",
    async (level) => {
      const f = fixture(1);
      f.input.analysisReport = { applicability: { level } };
      f.input.request.requirement = "Increment the input by one";
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        if (task.side === "source") {
          expect(task.executionSides).toEqual([]);
          expect(task.prompt).toContain(
            level === "adapt"
              ? "MODIFICATION / ADAPTATION:"
              : "NOT APPLICABLE AS A SOURCE ORACLE",
          );
          expect(task.prompt).not.toContain("DIRECT REUSE:");
        }
        const result = await author(task);
        if (task.side === "source") {
          const path = join(
            task.sandbox.cwd,
            ".forexplore-tests/manifest.json",
          );
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          delete manifest.commands;
          manifest.testFiles = [];
          for (const item of manifest.cases)
            item.expectation = {
              kind: "requirement",
              rationale: "Increment required",
              provenance: ["request.requirement"],
              expected: {
                caseId: item.caseId,
                outcome: "return",
                value: item.input + 1,
              },
            };
          writeFileSync(path, JSON.stringify(manifest));
        }
        return result;
      };
      const run = f.runtime.runCommand;
      f.runtime.runCommand = (task) => {
        expect(task.sandbox.cwd).toBe(f.context.workspace.targetRoot);
        return run(task);
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
        executionSides: ["target"],
      }).verify(f.input, f.context);
      expect(f.agents).toEqual(["source", "target"]);
      expect(result).toMatchObject({
        executionStatus: "completed",
        mode: "target_only",
        referenceDecision: "rejected",
        sourceAssessment: "not_checked",
        targetAssessment: "no_bug_observed",
      });
      expect(result.strategyReport).toMatchObject({
        classification: level === "adapt" ? "adapt" : "not_applicable",
        caseStatus: "requirement-satisfied",
        sourceSnapshot: { observations: [] },
        evidence: [{ side: "target" }],
      });
      expect(normalizeVerificationStrategyOutput(f.input, result)).toEqual(
        result,
      );
    },
  );
  it.each([false, true])(
    "compares preserved and adapted behavior using separate frozen bases (defect=%s)",
    async (defect) => {
      const f = fixture();
      f.input.analysisReport = { applicability: { level: "adapt" } };
      f.input.request.requirement = "Preserve zero, increment negative inputs";
      writeFileSync(
        join(f.context.workspace.targetRoot, "implementation.cjs"),
        defect
          ? "module.exports = value => value;"
          : "module.exports = value => value === 0 ? 0 : value + 1;",
      );
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await author(task);
        if (task.side === "source") {
          expect(task.executionSides).toEqual(["source"]);
          expect(task.prompt).toContain("MODIFICATION / ADAPTATION:");
          expect(task.prompt).not.toContain("DIRECT REUSE:");
          const path = join(
            task.sandbox.cwd,
            ".forexplore-tests/manifest.json",
          );
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          manifest.cases[1].expectation = {
            kind: "requirement",
            rationale: "Changed behavior",
            provenance: ["request.requirement"],
            expected: { caseId: "negative", outcome: "return", value: 0 },
          };
          manifest.cases[1].setup = { value: -1 };
          manifest.cases[1].operations = [
            { operation: "invoke", arguments: [-1] },
          ];
          manifest.cases[1].observe = ["return"];
          writeFileSync(path, JSON.stringify(manifest));
          const runner = join(task.sandbox.cwd, "tests/runner.cjs");
          writeFileSync(
            runner,
            readFileSync(runner, "utf8").replace(
              "cases.map",
              "cases.filter(c => c.expectation.kind === 'source').map",
            ),
          );
        } else {
          expect(task.prompt).toContain(
            '"operations":[{"operation":"invoke","arguments":[-1]}]',
          );
          expect(task.prompt).toContain('"kind":"requirement"');
        }
        return result;
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(result).toMatchObject({
        executionStatus: "completed",
        mode: "differential",
        targetAssessment: defect ? "bug_found" : "no_bug_observed",
      });
      expect(result.strategyReport).toMatchObject({
        cases: [
          { caseId: "zero", caseStatus: "verified-equivalent" },
          {
            caseId: "negative",
            source: null,
            caseStatus: defect
              ? "translation-divergence"
              : "requirement-satisfied",
            expectation: {
              kind: "requirement",
              provenance: ["request.requirement"],
            },
          },
        ],
      });
      expect(normalizeVerificationStrategyOutput(f.input, result)).toEqual(
        result,
      );
    },
  );
  it.each(["adapt"])(
    "rejects source activity hidden by a requirement-only %s collection",
    async (level) => {
      const f = fixture();
      f.input.analysisReport = { applicability: { level } };
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await author(task);
        const path = join(task.sandbox.cwd, ".forexplore-tests/manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        delete manifest.commands;
        manifest.testFiles = [];
        for (const item of manifest.cases)
          item.expectation = {
            kind: "requirement",
            rationale: "Identity requirement",
            provenance: ["request.requirement"],
            expected: {
              caseId: item.caseId,
              outcome: "return",
              value: item.input,
            },
          };
        writeFileSync(path, JSON.stringify(manifest));
        return {
          ...result,
          commandEvidence: [
            {
              ...result,
              commandId: "source-probe",
              side: "source",
              cwd: task.sandbox.cwd,
              command: { executable: "node", args: ["-e", "0"] },
              baselineValid: true,
              credentialHit: false,
            },
          ],
        };
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(result.executionStatus).toBe("failed");
      expect(result.problems[0]?.code).toBe("report_evidence_invalid");
      expect(f.agents).not.toContain("target");
      expect(result.referenceDecision).toBe("undetermined");
    },
  );
  it("does not promote direct applicability to caller execution authorization", async () => {
    const f = fixture();
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
      executionSides: ["target"],
    }).verify(f.input, f.context);
    expect(result.problems[0]?.code).toBe("context_incomplete");
    expect(f.agents).toEqual([]);
  });
  it.each(["unresolved", "uncited", "invented-source"])(
    "fails closed for %s expectations",
    async (kind) => {
      const f = fixture();
      f.input.analysisReport = { applicability: { level: "adapt" } };
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await author(task);
        const path = join(task.sandbox.cwd, ".forexplore-tests/manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.cases[0].expectation =
          kind === "invented-source"
            ? {
                kind: "source",
                rationale: "fabricated",
                provenance: ["analysisReport"],
                expected: { caseId: "zero", outcome: "return", value: 0 },
              }
            : {
                kind: kind === "unresolved" ? "unresolved" : "requirement",
                rationale: "Need a requirement",
                provenance:
                  kind === "uncited" ? [" "] : ["request.requirement"],
                ...(kind === "uncited"
                  ? {
                      expected: { caseId: "zero", outcome: "return", value: 0 },
                    }
                  : {}),
              };
        writeFileSync(path, JSON.stringify(manifest));
        return result;
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(result.executionStatus).toBe("failed");
      expect(result.targetAssessment).toBe("inconclusive");
      expect(f.agents).not.toContain("target");
    },
  );
  it.each(["waiting", "target"])(
    "rejects Agent1 handoff changes during %s",
    async (phase) => {
      const f = fixture();
      const corrupt = () =>
        writeFileSync(
          join(
            f.context.workspace.sourceRoot,
            ".forexplore-tests/manifest.json",
          ),
          "{}",
        );
      const author = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await author(task);
        if (phase === "target" && task.side === "target") corrupt();
        return result;
      };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
        waitForTarget: async () => {
          if (phase === "waiting") corrupt();
        },
      }).verify(f.input, f.context);
      expect(result.problems[0]?.code).toBe("workspace_integrity_violation");
      expect(result.targetAssessment).toBe("inconclusive");
    },
  );

  it.each([0, 1])(
    "replays generated tests through the actual implementations (delta=%s)",
    async (delta) => {
      const f = fixture(delta);
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(f.agents).toEqual(["source", "target"]);
      expect(result.executionStatus).toBe("completed");
      expect(result.targetAssessment).toBe(
        delta ? "bug_found" : "no_bug_observed",
      );
      expect(result.sourceAssessment).toBe("inconclusive");
      expect(normalizeVerificationStrategyOutput(f.input, result)).toEqual(
        result,
      );
      expect(
        result.issues.filter((item) => item.kind === "behavioral-divergence"),
      ).toHaveLength(delta ? 2 : 0);
      expect(result.strategyReport).toMatchObject({
        caseStatus: delta ? "translation-divergence" : "verified-equivalent",
        evidence: [
          { side: "source", exitCode: 0 },
          { side: "target", exitCode: 0 },
        ],
      });
      expect(
        readFileSync(
          join(f.context.workspace.targetRoot, "implementation.cjs"),
          "utf8",
        ),
      ).toBe(`module.exports = value => value + ${delta};`);
      expect(result.artifacts.map((item) => item.kind)).toContain(
        "source-behavior-snapshot",
      );
    },
  );
  it("starts agent2 only after Host target readiness; wait never runs a coordinator model", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      if (task.side === "target") {
        expect(task.prompt).toContain(
          '"observations":[{"caseId":"zero","outcome":"return","value":0}',
        );
        expect(task.prompt).toContain('"input":-1');
      }
      return author(task);
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
      waitForTarget: async () => {
        expect(f.agents).toEqual(["source"]);
        expect(
          readFileSync(
            join(f.context.workspace.targetRoot, "implementation.cjs"),
            "utf8",
          ),
        ).toContain("value + 0");
      },
    }).verify(f.input, f.context);
    expect(result.targetAssessment).toBe("no_bug_observed");
    expect(f.agents).toEqual(["source", "target"]);
  });
  it("rejects target drift between the ready barrier and declared snapshot binding", async () => {
    const f = fixture();
    const target = f.context.workspace.targetRoot;
    const path = join(target, "implementation.cjs");
    const content = readFileSync(path, "utf8");
    f.input.request.targetContext.sourceFiles = [
      {
        id: "target-file",
        role: "source-file",
        path: "implementation.cjs",
        content,
        contentHash: workspace.hashContent(content),
        provider: { providerId: "test", providerVersion: "1" },
        attributes: {},
      },
    ];
    const hash = workspace.captureProjectBaseline;
    vi.spyOn(workspace, "captureProjectBaseline").mockImplementation((root) => {
      if (root === target)
        writeFileSync(path, "module.exports = value => value + 9;");
      return hash(root);
    });
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.problems[0].message).toContain(
      "differs from the submitted snapshot",
    );
    expect(f.agents).toEqual([]);
  });
  it("rejects source-side pollution of undeclared target helper files before agent2 starts", async () => {
    const f = fixture();
    const helper = join(f.context.workspace.targetRoot, "helper.cjs");
    writeFileSync(helper, "original helper");
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      if (task.side === "source") writeFileSync(helper, "polluted helper");
      return result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.problems[0].code).toBe("workspace_integrity_violation");
    expect(result.problems[0].message).toContain(
      "unauthorized change: helper.cjs",
    );
    expect(f.agents).toEqual(["source"]);
  });
  it.each(["ineligible", "missing"])(
    "does not run an agent without upstream eligibility (%s)",
    async (decision) => {
      const f = fixture();
      f.input.analysisReport =
        decision === "missing" ? {} : { migrationEligibility: { decision } };
      const result = await new MultiAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(f.agents).toEqual([]);
      expect(result.executionStatus).toBe("failed");
      expect(result.strategyReport).toMatchObject({
        caseStatus: "not-executed",
      });
    },
  );
  it("does not use legacy Host policy as the strategy's reference decision", async () => {
    const f = fixture();
    f.input.verificationPolicy = {
      referenceDecision: "rejected",
      reason: "Legacy only",
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(f.agents).toEqual(["source", "target"]);
    expect(result.mode).toBe("differential");
    expect(result.referenceDecision).toBe("accepted");
    expect(result.targetAssessment).toBe("no_bug_observed");
  });
  it("cancels a pending ready barrier and preserves the frozen source artifact", async () => {
    const f = fixture();
    const controller = new AbortController();
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
      waitForTarget: async () => {
        controller.abort();
        await new Promise<void>(() => {});
      },
    }).verify(f.input, f.context, controller.signal);
    expect(result.executionStatus).toBe("cancelled");
    expect(f.agents).toEqual(["source"]);
    expect(
      result.artifacts.some((item) => item.kind === "source-behavior-snapshot"),
    ).toBe(true);
  });
  it("times out a ready barrier without spawning agent2", async () => {
    const f = fixture();
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
      timeoutMs: 150,
      waitForTarget: async () => new Promise<void>(() => {}),
    }).verify(f.input, f.context);
    expect(result.strategyReport).toMatchObject({
      stage: "waiting-target",
      caseStatus: "target-not-ready",
    });
    expect(f.agents).toEqual(["source"]);
  });
  it("rejects edits to the implementation even when the agent claims success", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      if (task.side === "target")
        writeFileSync(
          join(task.sandbox.cwd, "implementation.cjs"),
          "module.exports = value => value;",
        );
      return result;
    };
    // Change to a distinct original so the unauthorized edit is observable.
    writeFileSync(
      join(f.context.workspace.targetRoot, "implementation.cjs"),
      "module.exports = value => value + 7;",
    );
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0].code).toBe("workspace_integrity_violation");
    expect(result.targetAssessment).toBe("inconclusive");
  });
  it("reports actual command failure instead of equating agent output with success", async () => {
    const f = fixture();
    const command = f.runtime.runCommand;
    f.runtime.runCommand = async (task) =>
      command({
        ...task,
        command: {
          executable: process.execPath,
          args: ["-e", "process.exit(9)"],
        },
      });
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.strategyReport).toMatchObject({
      caseStatus: "command-failed",
      evidence: [{ exitCode: 9 }],
    });
    expect(f.agents).toEqual(["source"]);
  });
  it("reports the structured agent terminal reason instead of unrelated stderr warnings", async () => {
    const f = fixture();
    f.runtime.runAgent = async () => ({
      stdout:
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          errors: ["Reached maximum number of turns (50)"],
        }) + "\n",
      stderr: "Warning: custom model name",
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
    });
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0].message).toContain(
      "error_max_turns: Reached maximum number of turns (50)",
    );
    expect(result.problems[0].message).not.toContain("custom model");
  });
  it("rejects malformed target stdout without treating a completed command as a behavior verdict", async () => {
    const f = fixture();
    const command = f.runtime.runCommand;
    f.runtime.runCommand = async (task) => {
      const result = await command(task);
      return task.sandbox.cwd === f.context.workspace.targetRoot
        ? { ...result, stdout: result.stdout + "}" }
        : result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.problems[0].code).toBe("report_evidence_invalid");
    expect(result.strategyReport).toMatchObject({
      stage: "target",
      caseStatus: "input-invalid",
    });
    expect(
      result.issues.some((issue) => issue.kind === "behavioral-divergence"),
    ).toBe(false);
  });
  it("feeds invalid target evidence back once without rerunning source collection", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      if (task.side === "target" && f.agents.includes("target")) {
        expect(task.prompt).toContain("Host rejected your test harness");
        expect(task.sandbox.baseline?.files).toHaveProperty(
          "implementation.cjs",
        );
        expect(task.sandbox.readOnlyFiles).toContain(
          join(task.sandbox.cwd, ".forexplore-tests/inputs.json"),
        );
      }
      return author(task);
    };
    const command = f.runtime.runCommand;
    let targetRuns = 0;
    f.runtime.runCommand = async (task) => {
      const result = await command(task);
      return task.sandbox.cwd === f.context.workspace.targetRoot &&
        ++targetRuns === 1
        ? { ...result, stdout: result.stdout + "}" }
        : result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("completed");
    expect(f.agents).toEqual(["source", "target", "target"]);
    expect(result.strategyReport).toMatchObject({
      repairs: [{ side: "target", attempt: 1 }],
    });
    expect(
      result.artifacts.some(
        (item) => item.kind === "target-agent-repair-1-session",
      ),
    ).toBe(true);
  });
  it("reads fresh result files while preserving normal build logs", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      const runner = join(task.sandbox.cwd, "tests/runner.cjs");
      writeFileSync(
        runner,
        readFileSync(runner, "utf8").replace(
          "process.stdout.write(",
          "fs.writeFileSync('.forexplore-tests/observations.json', ",
        ) + "console.log('normal build output');",
      );
      const path = join(task.sandbox.cwd, ".forexplore-tests/manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.resultFile = ".forexplore-tests/observations.json";
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(
        join(task.sandbox.cwd, manifest.resultFile),
        "stale output",
      );
      return result;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("completed");
    expect(result.targetAssessment).toBe("no_bug_observed");
    expect(result.strategyReport).toMatchObject({
      evidence: [
        {
          stdout: "normal build output\n",
          resultFile: ".forexplore-tests/observations.json",
        },
        {
          stdout: "normal build output\n",
          resultFile: ".forexplore-tests/observations.json",
        },
      ],
    });
  });
  it("never accepts a stale result file when the run produces no new observations", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      const path = join(task.sandbox.cwd, ".forexplore-tests/manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.resultFile = ".forexplore-tests/observations.json";
      writeFileSync(path, JSON.stringify(manifest));
      writeFileSync(
        join(task.sandbox.cwd, manifest.resultFile),
        JSON.stringify([
          { caseId: "zero", outcome: "return", value: 0 },
          { caseId: "negative", outcome: "return", value: -1 },
        ]),
      );
      return result;
    };
    f.runtime.runCommand = async () => ({
      exitCode: 0,
      stdout: "normal logs",
      stderr: "",
      durationMs: 0,
      timedOut: false,
    });
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("failed");
    expect(result.targetAssessment).not.toBe("no_bug_observed");
    expect(result.problems[0].code).toBe("report_evidence_invalid");
    expect(f.agents).toEqual(["source", "source"]);
  });
  it("persists Host command evidence when an Agent throws after execution", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.runtime.runAgent = async (task) => {
      task.onEvidence?.([
        {
          commandId: "interrupted-source",
          side: "source",
          cwd: task.sandbox.cwd,
          command: { executable: "node", args: ["tests/runner.cjs"] },
          stdout: "partial actual output",
          stderr: "partial error output",
          completed: false,
          exitCode: null,
          timedOut: false,
          durationMs: 10,
          baselineValid: true,
          credentialHit: false,
        },
      ]);
      controller.abort();
      throw controller.signal.reason;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context, controller.signal);
    expect(result.executionStatus).toBe("cancelled");
    const artifact = result.artifacts.find(
      (item) => item.kind === "source-agent-session",
    )!;
    const session = JSON.parse(
      readFileSync(join(f.root, "durable", artifact.path), "utf8"),
    );
    expect(session.commandEvidence).toMatchObject([
      {
        commandId: "interrupted-source",
        completed: false,
        stdout: "partial actual output",
        stderr: "partial error output",
      },
    ]);
  });
  it("retains redacted incremental logs after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.runtime.runAgent = async (task) => {
      task.onOutput?.('{"type":"system","message":"started"}\n');
      controller.abort(new Error("cancelled for test"));
      throw controller.signal.reason;
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context, controller.signal);
    expect(result.executionStatus).toBe("cancelled");
    const artifact = result.artifacts.find(
      (item) => item.kind === "source-agent-session",
    )!;
    expect(
      readFileSync(join(f.root, "durable", artifact.path), "utf8"),
    ).toContain("started");
  });
  it("rejects changed harness files and requests read-only execution bindings", async () => {
    const f = fixture();
    f.runtime.runCommand = async (task) => {
      expect(task.sandbox.readOnlyFiles).toContain(
        join(task.sandbox.cwd, "tests/runner.cjs"),
      );
      expect(task.sandbox.readOnlyFiles).toContain(
        join(task.sandbox.writeRoots[0], "inputs.json"),
      );
      writeFileSync(
        join(task.sandbox.cwd, "tests/runner.cjs"),
        "changed after capture",
      );
      return {
        stdout: "[]",
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
      };
    };
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0].code).toBe("workspace_integrity_violation");
  });
  it("preserves valid deeply nested cases in the report envelope", async () => {
    const f = fixture();
    const author = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await author(task);
      if (task.side === "source") {
        const path = join(task.sandbox.writeRoots[0], "manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        let nested: unknown = 1;
        for (let i = 0; i < 12; i++) nested = { item: nested };
        manifest.cases = [
          {
            caseId: "nested",
            intent: "nested values",
            input: nested,
            expectation: {
              kind: "source",
              rationale: "Preserved identity",
              provenance: ["analysisReport.applicability"],
            },
          },
        ];
        writeFileSync(path, JSON.stringify(manifest));
      }
      return result;
    };
    writeFileSync(
      join(f.context.workspace.targetRoot, "implementation.cjs"),
      "module.exports = value => value;",
    );
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.executionStatus).toBe("completed");
    expect(result.targetAssessment).toBe("no_bug_observed");
  });
  it("requires actual stdout for every case, rejecting incomplete observations", async () => {
    const f = fixture();
    const command = f.runtime.runCommand;
    f.runtime.runCommand = async (task) =>
      command({
        ...task,
        command: {
          executable: process.execPath,
          args: ["-e", "process.stdout.write('[]')"],
        },
      });
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(result.problems[0].code).toBe("report_evidence_invalid");
    expect(result.targetAssessment).toBe("inconclusive");
  });
});
