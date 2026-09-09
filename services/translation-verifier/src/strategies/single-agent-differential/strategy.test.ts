import { afterEach, describe, expect, it } from "vitest";
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
import { SingleAgentDifferentialStrategy } from "./strategy.js";
import type {
  BehaviorRuntime,
  BehaviorAgentTask,
  BehaviorAgentResult,
  BehaviorCommandRecord,
  BehaviorSide,
} from "../multi-agent-differential/behavior-types.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";
import { createVerificationArtifactStore } from "../../run-output/verification-artifact-store.js";
import { normalizeVerificationStrategyOutput } from "../../schemas/materialize-verification-result.js";
import { runManagedProcess } from "../smoke-differential/manage-test-process.js";
import type { SingleAgentPlan } from "./report.js";

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  delta = 0,
  mode: SingleAgentPlan["mode"] = "target_only",
  expectationBasis: "requirement" | "source_observation" = "requirement",
  sourceDelta = 0,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "single-agent-")));
  directories.push(root);
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target"),
    strategyRoot = join(root, "artifacts");
  for (const path of [sourceRoot, targetRoot, strategyRoot]) mkdirSync(path);
  writeFileSync(
    join(sourceRoot, "implementation.cjs"),
    `module.exports = x => x + ${sourceDelta};`,
  );
  writeFileSync(
    join(targetRoot, "implementation.cjs"),
    `module.exports = x => x + ${delta};`,
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
    deadlineAt: Date.now() + 10000,
    writeArtifact: store.writeArtifact,
  };
  const input: VerificationInput = {
    schemaVersion: "1.0",
    request: {
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
      requirement: "Return the input unchanged",
    } as unknown as VerificationInput["request"],
    analysisReport: {
      notes: "Source suitability must be assessed by the testing agent",
    },
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent: "",
      files: [],
      patchHash: "a".repeat(64),
    },
  };
  const tasks: BehaviorAgentTask[] = [];
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      tasks.push(task);
      const commandEvidence: BehaviorCommandRecord[] = [];
      const execute = async (side: BehaviorSide) => {
        const cwd = side === "source" ? sourceRoot : targetRoot;
        const content =
          "console.log(JSON.stringify([{caseId:'negative',outcome:'return',value:require('../implementation.cjs')(-1)}]));";
        writeFileSync(join(cwd, ".forexplore-tests/runner.cjs"), content);
        const command = {
          executable: process.execPath,
          args: [".forexplore-tests/runner.cjs"],
        };
        const result = await runManagedProcess(
          {
            command: command.executable,
            args: command.args,
            cwd,
            env: { PATH: process.env.PATH },
            deadlineAt: task.deadlineAt,
          },
          task.signal,
        );
        commandEvidence.push({
          ...result,
          commandId: `${side}-1`,
          side,
          cwd,
          command,
          baselineValid: true,
          credentialHit: false,
          testFiles: { ".forexplore-tests/runner.cjs": content },
        });
      };
      if (mode === "differential") await execute("source");
      const plan: SingleAgentPlan = {
        schemaVersion: "1.0",
        mode,
        referenceReason: "Requirement-based target check",
        testBasis: {
          summary: "Identity behavior",
          evidence: ["request.requirement"],
        },
        cases: [
          {
            caseId: "negative",
            intent: "preserve negative value",
            input: -1,
            expectationBasis,
            evidence: ["request.requirement"],
            expected: {
              caseId: "negative",
              outcome: "return",
              value:
                expectationBasis === "source_observation"
                  ? -1 + sourceDelta
                  : -1,
            },
            ...(mode === "differential" ? { sourceCommandId: "source-1" } : {}),
          },
        ],
      };
      writeFileSync(
        join(targetRoot, ".forexplore-tests", "plan.json"),
        JSON.stringify(plan),
      );
      await execute("target");
      writeFileSync(
        join(targetRoot, ".forexplore-tests", "report.json"),
        JSON.stringify({
          schemaVersion: "1.0",
          targetCommandId: "target-1",
          testFiles: {
            source:
              mode === "differential" ? [".forexplore-tests/runner.cjs"] : [],
            target: [".forexplore-tests/runner.cjs"],
          },
          notes: "Actual implementation invoked",
        }),
      );
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: "Done",
        stderr: "",
        frozenPlan: JSON.stringify(plan),
        commandEvidence,
      };
    },
    async runCommand() {
      throw new Error("Single-agent must not start a separate replay phase");
    },
  };
  return { root, input, context, runtime, tasks };
}

describe("single-agent autonomous verification", () => {
  it("classifies missing credentials as an environment failure without fabricated evidence", async () => {
    const f = fixture();
    const output = await new SingleAgentDifferentialStrategy({
      apiKey: "",
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.referenceDecision).toBe("undetermined");
    expect(output.problems[0]?.code).toBe("environment_unavailable");
  });
  it("classifies an unexpected Agent runtime failure separately from invalid evidence", async () => {
    const f = fixture();
    f.runtime.runAgent = async () => {
      throw new Error("Agent transport failed");
    };
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(output.problems[0]?.code).toBe("agent_error");
  });
  it.each([0, 1])(
    "checks the prepared target in exactly one session without Host testBasis (delta=%s)",
    async (delta) => {
      const f = fixture(delta);
      const output = await new SingleAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(output.executionStatus).toBe("completed");
      expect(output.mode).toBe("target_only");
      expect(output.sourceAssessment).toBe("not_checked");
      expect(output.targetAssessment).toBe(
        delta ? "bug_found" : "no_bug_observed",
      );
      expect(f.tasks).toHaveLength(1);
      expect(f.tasks[0]).toMatchObject({
        side: "target",
        sessionRole: "single-agent",
        additionalProjects: { source: { cwd: f.context.workspace.sourceRoot } },
      });
      expect(normalizeVerificationStrategyOutput(f.input, output)).toEqual(
        output,
      );
      expect(output.artifacts.length).toBeGreaterThan(0);
    },
  );
  it.each([0, 1])(
    "collects both sides in the same session and detects differential divergence (delta=%s)",
    async (delta) => {
      const f = fixture(delta, "differential", "source_observation");
      const output = await new SingleAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(output.executionStatus).toBe("completed");
      expect(output.mode).toBe("differential");
      expect(output.referenceDecision).toBe("accepted");
      expect(output.sourceAssessment).toBe("inconclusive");
      expect(output.targetAssessment).toBe(
        delta ? "bug_found" : "no_bug_observed",
      );
      expect(f.tasks).toHaveLength(1);
      expect(normalizeVerificationStrategyOutput(f.input, output)).toEqual(
        output,
      );
      expect(output.strategyReport).toMatchObject({
        evidence: [{ side: "source" }, { side: "target" }],
      });
    },
  );
  it("accepts a requirement-backed target change while retaining differing actual source evidence", async () => {
    const f = fixture(0, "differential", "requirement", 1);
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(output.targetAssessment).toBe("no_bug_observed");
    expect(output.sourceAssessment).toBe("inconclusive");
    expect(output.strategyReport).toMatchObject({
      cases: [
        {
          source: { value: 0 },
          target: { value: -1 },
          expected: { value: -1 },
          matches: true,
        },
      ],
    });
  });
  it.each(["missing", "blank", "uncited"])(
    "refuses %s Agent test basis",
    async (kind) => {
      const f = fixture();
      const original = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await original(task);
        if (kind === "missing") delete result.frozenPlan;
        else {
          const plan = JSON.parse(result.frozenPlan!);
          if (kind === "blank") plan.testBasis.summary = " ";
          else plan.cases[0].evidence = [];
          result.frozenPlan = JSON.stringify(plan);
          writeFileSync(task.expectationFile!, result.frozenPlan!);
        }
        return result;
      };
      const output = await new SingleAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(output.executionStatus).toBe("failed");
      expect(output.targetAssessment).toBe("inconclusive");
      expect(output.problems[0]?.code).toBe("insufficient_test_basis");
    },
  );
  const evidenceAttacks: [
    string,
    (result: BehaviorAgentResult, f: ReturnType<typeof fixture>) => void,
  ][] = [
    [
      "missing authoritative records",
      (result) => {
        result.commandEvidence = [];
      },
    ],
    [
      "wrong command cwd",
      (result) => {
        result.commandEvidence![0]!.cwd = "/tmp";
      },
    ],
    [
      "wrong selected side",
      (result) => {
        result.commandEvidence![0]!.side = "source";
      },
    ],
    [
      "duplicated command IDs",
      (result) => {
        result.commandEvidence!.push(result.commandEvidence![0]!);
      },
    ],
    [
      "failed baseline",
      (result) => {
        result.commandEvidence![0]!.baselineValid = false;
      },
    ],
    [
      "credential exposure",
      (result) => {
        result.commandEvidence![0]!.credentialHit = true;
      },
    ],
    [
      "unfinished command",
      (result) => {
        result.commandEvidence![0]!.completed = false;
      },
    ],
    [
      "forged stdout",
      (result) => {
        result.commandEvidence![0]!.stdout = "not-observations";
      },
    ],
    [
      "duplicate observed cases",
      (result) => {
        const record = result.commandEvidence![0]!;
        const value = JSON.parse(record.stdout);
        record.stdout = JSON.stringify([...value, ...value]);
      },
    ],
    [
      "missing executed test identity",
      (result) => {
        delete result.commandEvidence![0]!.testFiles;
      },
    ],
    [
      "changed test after run",
      (_result, f) => {
        writeFileSync(
          join(f.context.workspace.targetRoot, ".forexplore-tests/runner.cjs"),
          "console.log('forged');",
        );
      },
    ],
  ];
  it.each(evidenceAttacks)("rejects %s", async (_name, attack) => {
    const f = fixture();
    const original = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await original(task);
      attack(result, f);
      return result;
    };
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.problems[0]?.code).toBe("report_evidence_invalid");
    expect(output.targetAssessment).toBe("inconclusive");
  });
  it("rejects source execution in target-only even if the report hides it", async () => {
    const f = fixture();
    const original = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await original(task);
      result.commandEvidence!.unshift({
        ...result.commandEvidence![0]!,
        commandId: "source-attempt",
        side: "source",
        cwd: f.context.workspace.sourceRoot,
        exitCode: 1,
      });
      return result;
    };
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(output.problems[0]?.message).toContain("must not execute source");
  });
  it.each(["plan", "source", "target"])(
    "fails closed for changed %s",
    async (side) => {
      const f = fixture();
      const original = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await original(task);
        writeFileSync(
          side === "plan"
            ? task.expectationFile!
            : join(
                side === "source"
                  ? f.context.workspace.sourceRoot
                  : f.context.workspace.targetRoot,
                "implementation.cjs",
              ),
          "changed",
        );
        return result;
      };
      const output = await new SingleAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(output.problems[0]?.code).toBe("workspace_integrity_violation");
    },
  );
  it("does not authorize source execution through the Agent report", async () => {
    const f = fixture(0, "differential");
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
      executionSides: ["target"],
    }).verify(f.input, f.context);
    expect(output.problems[0]?.code).toBe("report_evidence_invalid");
    expect(f.tasks[0]?.executionSides).toEqual(["target"]);
  });
  it("rejects altered source-reference expected values", async () => {
    const f = fixture(0, "differential", "source_observation");
    const original = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await original(task);
      const plan = JSON.parse(result.frozenPlan!);
      plan.cases[0].expected.value = 55;
      result.frozenPlan = JSON.stringify(plan);
      writeFileSync(task.expectationFile!, result.frozenPlan!);
      return result;
    };
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(output.problems[0]?.message).toContain(
      "does not match actual source",
    );
  });
  it.each(["agent", "command"])(
    "preserves %s timeout evidence without a repair session",
    async (kind) => {
      const f = fixture();
      const original = f.runtime.runAgent;
      f.runtime.runAgent = async (task) => {
        const result = await original(task);
        if (kind === "agent") result.timedOut = true;
        else result.commandEvidence![0]!.timedOut = true;
        return result;
      };
      const output = await new SingleAgentDifferentialStrategy({
        runtime: f.runtime,
      }).verify(f.input, f.context);
      expect(output.problems[0]?.code).toBe(
        kind === "agent" ? "agent_timeout" : "command_timeout",
      );
      expect(f.tasks).toHaveLength(1);
      expect(output.strategyReport).toMatchObject({
        evidence: [{ commandId: "target-1" }],
      });
    },
  );
  it("awaits runtime shutdown on cancellation and saves prompt/partial output", async () => {
    const f = fixture();
    const controller = new AbortController();
    let quiesced = false;
    f.runtime.runAgent = async (task) => {
      task.onOutput?.("partial testing output");
      setTimeout(() => controller.abort(new Error("stop")), 5);
      await new Promise<void>((resolve) =>
        task.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      quiesced = true;
      task.onEvidence?.([]);
      throw task.signal!.reason;
    };
    const output = await new SingleAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context, controller.signal);
    expect(quiesced).toBe(true);
    expect(output.executionStatus).toBe("cancelled");
    expect(
      readFileSync(
        join(f.context.workspace.strategyRoot, "single-agent-session.json"),
        "utf8",
      ),
    ).toContain("partial testing output");
    expect(output.artifacts.map((row) => row.kind)).toContain(
      "single-agent-prompt",
    );
  });
});
