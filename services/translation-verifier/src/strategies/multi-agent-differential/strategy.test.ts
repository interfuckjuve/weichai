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
    analysisReport: { migrationEligibility: { decision: "eligible" } },
    migrationPlan: {},
    verificationPolicy: {
      referenceDecision: "accepted",
      reason: "Selected by upstream",
      testBasis: "Identity behavior",
    },
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
      schemaVersion: "2.0",
      testFiles: ["tests/runner.cjs"],
      notes:
        "Trusted deterministic fixture harness invokes implementation module.",
      ...(task.side === "source"
        ? {
            cases: [
              { caseId: "zero", intent: "zero input", input: 0 },
              { caseId: "negative", intent: "negative input", input: -1 },
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
    expect(f.agents).toEqual(["source"]);
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
  it("does not treat eligibility as authorization to execute an unaccepted reference", async () => {
    const f = fixture();
    f.input.verificationPolicy!.referenceDecision = "rejected";
    const result = await new MultiAgentDifferentialStrategy({
      runtime: f.runtime,
    }).verify(f.input, f.context);
    expect(f.agents).toEqual([]);
    expect(result.sourceAssessment).toBe("not_checked");
    expect(result.problems[0].code).toBe("insufficient_test_basis");
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
          { caseId: "nested", intent: "nested values", input: nested },
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
