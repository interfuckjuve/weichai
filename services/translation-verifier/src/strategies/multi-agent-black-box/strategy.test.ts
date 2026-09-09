import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { hashContent } from "../multi-agent-differential/behavior-workspace.js";
import type { FilePatch } from "@forexplore/contracts";
import type {
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";
import type { BehaviorRuntime } from "../multi-agent-differential/behavior-types.js";
import { createVerificationArtifactStore } from "../../run-output/verification-artifact-store.js";
import { runManagedProcess } from "../smoke-differential/manage-test-process.js";
import {
  MultiAgentBlackBoxStrategy,
  MULTI_AGENT_BLACK_BOX_STRATEGY,
} from "./strategy.js";
import { createDefaultVerificationService } from "../../create-default-verifier.js";
import { createPreparation, capturePreparationFiles, restorePreparationFiles } from "../multi-agent-differential/preparation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(delta = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "black-box-")));
  roots.push(root);
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target"),
    strategyRoot = join(root, "stage");
  for (const path of [sourceRoot, targetRoot, strategyRoot]) mkdirSync(path);
  writeFileSync(
    join(sourceRoot, "implementation.cjs"),
    "module.exports = x => x;",
  );
  const generatedContent = `module.exports = x => x + ${delta};`;
  const files: FilePatch[] = [
    {
      path: "implementation.cjs",
      status: "created",
      expectedAbsent: true,
      additions: 1,
      deletions: 0,
      hunks: [
        {
          header: "@@ -0,0 +1,1 @@",
          lines: [{ type: "add", content: generatedContent }],
        },
      ],
    },
  ];
  const input: VerificationInput = {
    schemaVersion: "1.0",
    request: {
      requirement: "Increment by one",
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
    } as unknown as VerificationInput["request"],
    analysisReport: { applicability: { level: "adapt" } },
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
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
    deadlineAt: Date.now() + 15_000,
    writeArtifact: store.writeArtifact,
  };
  const agents: string[] = [];
  const runtime: BehaviorRuntime = {
    async runAgent(task) {
      agents.push(task.side);
      if (task.side === "source") {
        expect(task.prompt).not.toContain(generatedContent);
        expect(task.sandbox.projectAccess).toBe("experiment");
        expect(task.executionSides).toEqual(["source"]);
        writeFileSync(
          join(sourceRoot, "implementation.cjs"),
          "module.exports = x => x + 99;",
        );
        writeFileSync(
          join(sourceRoot, ".forexplore-tests/manifest.json"),
          JSON.stringify({
            schemaVersion: "3.0",
            notes:
              "Changed behavior follows requirement, not experimental source output",
            testFiles: [],
            cases: [
              {
                caseId: "zero",
                intent: "increment zero",
                input: 0,
                expectation: {
                  kind: "requirement",
                  rationale: "Increment by one",
                  provenance: ["request.requirement"],
                  expected: { caseId: "zero", outcome: "return", value: 1 },
                },
              },
            ],
          }),
        );
        mkdirSync(join(targetRoot, "tests"));
        writeFileSync(
          join(targetRoot, "tests/runner.cjs"),
          "const fs=require('node:fs');const subject=require('../implementation.cjs');console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).map(c=>({caseId:c.caseId,outcome:'return',value:subject(c.input)}))));",
        );
        writeFileSync(
          join(targetRoot, ".forexplore-tests/manifest.json"),
          JSON.stringify({
            schemaVersion: "2.0",
            notes: "Target harness authored without translation",
            testFiles: ["tests/runner.cjs"],
            commands: {
              setup: [],
              run: { executable: process.execPath, args: ["tests/runner.cjs"] },
            },
          }),
        );
      } else {
        writeFileSync(
          join(targetRoot, ".forexplore-tests/diagnosis.json"),
          JSON.stringify({
            kind: "translation",
            reason:
              "Actual target output violates the frozen increment requirement",
          }),
        );
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "authored",
        stderr: "",
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
  return {
    root,
    input,
    context,
    runtime,
    agents,
    fill: () =>
      writeFileSync(join(targetRoot, "implementation.cjs"), generatedContent),
  };
}

it("prepares target tests before translation and verifies without Agent2 after source experiments", async () => {
  const f = fixture();
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  expect("verify" in strategy).toBe(false);
  const preparation = await strategy.prepareTests(f.input, f.context);
  expect(f.agents).toEqual(["source"]);
  f.fill();
  const result = await new MultiAgentBlackBoxStrategy({
    runtime: f.runtime,
  }).verifyTranslation(
    f.input,
    f.context,
    JSON.parse(JSON.stringify(preparation)),
  );
  expect(f.agents).toEqual(["source"]);
  expect(result).toMatchObject({
    executionStatus: "completed",
    targetAssessment: "no_bug_observed",
    sourceAssessment: "not_checked",
    mode: "target_only",
  });
  expect(JSON.stringify(result.strategyReport)).toContain("sourceChanges");
});

it("does not create Agent1 when preparation is missing", async () => {
  const f = fixture();
  f.fill();
  const result = await new MultiAgentBlackBoxStrategy({
    runtime: f.runtime,
  }).verifyTranslation(f.input, f.context);
  expect(result.executionStatus).toBe("failed");
  expect(f.agents).toEqual([]);
});

it("invokes only one diagnostic Agent2 after a real target divergence", async () => {
  const f = fixture(2);
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  f.fill();
  const result = await strategy.verifyTranslation(
    f.input,
    f.context,
    preparation,
  );
  expect(f.agents).toEqual(["source", "target"]);
  expect(result.targetAssessment).toBe("bug_found");
});

it("rejects changed frozen target tests before running Agent2", async () => {
  const f = fixture();
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  f.fill();
  writeFileSync(
    join(f.context.workspace.targetRoot, "tests/runner.cjs"),
    "console.log('[]');",
  );
  const result = await strategy.verifyTranslation(
    f.input,
    f.context,
    preparation,
  );
  expect(result.executionStatus).toBe("failed");
  expect(f.agents).toEqual(["source"]);
});

it("rejects undeclared metadata helpers before sealing preparation", async () => {
  const f = fixture();
  const original = f.runtime.runAgent;
  f.runtime.runAgent = async (task) => {
    const result = await original(task);
    writeFileSync(
      join(f.context.workspace.targetRoot, ".forexplore-tests/helper.cjs"),
      "module.exports=1",
    );
    return result;
  };
  await expect(
    new MultiAgentBlackBoxStrategy({ runtime: f.runtime }).prepareTests(
      f.input,
      f.context,
    ),
  ).rejects.toThrow(/Undeclared/);
});

it.each(["callback", "agent2-source"])(
  "rejects unauthorized evidence: %s",
  async (mode) => {
    const f = fixture(2);
    const original = f.runtime.runAgent;
    f.runtime.runAgent = async (task) => {
      const result = await original(task);
      const record = {
        commandId: "bad",
        side: "source" as const,
        cwd: task.sandbox.cwd,
        command: { executable: process.execPath, args: [] },
        baselineValid: mode !== "callback",
        credentialHit: false,
        completed: true,
        ...result,
      };
      if (mode === "callback") task.onEvidence?.([record]);
      else if (task.side === "target")
        return { ...result, commandEvidence: [record] };
      return result;
    };
    const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
    if (mode === "callback")
      await expect(strategy.prepareTests(f.input, f.context)).rejects.toThrow(
        /evidence/,
      );
    else {
      const preparation = await strategy.prepareTests(f.input, f.context);
      f.fill();
      expect(
        (await strategy.verifyTranslation(f.input, f.context, preparation))
          .executionStatus,
      ).toBe("failed");
    }
  },
);

it.each([
  "tests/runner.cjs",
  ".forexplore-tests/inputs.json",
  ".forexplore-tests/manifest.json",
])("rejects diagnosis chmod of %s", async (path) => {
  const f = fixture(2);
  const original = f.runtime.runAgent;
  f.runtime.runAgent = async (task) => {
    const result = await original(task);
    if (task.side === "target")
      chmodSync(join(f.context.workspace.targetRoot, path), 0o777);
    return result;
  };
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  f.fill();
  expect(
    (await strategy.verifyTranslation(f.input, f.context, preparation))
      .executionStatus,
  ).toBe("failed");
});

it("restores portable tests to a fresh translated workspace with no source project", async () => {
  const f = fixture();
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  const targetRoot = join(f.root, "fresh-target");
  mkdirSync(targetRoot);
  writeFileSync(
    join(targetRoot, "implementation.cjs"),
    f.input.translation.generatedContent,
  );
  rmSync(f.context.workspace.sourceRoot, { recursive: true });
  const context = {
    ...f.context,
    workspace: { ...f.context.workspace, targetRoot },
  };
  expect(
    (await strategy.verifyTranslation(f.input, context, preparation))
      .targetAssessment,
  ).toBe("no_bug_observed");
});

it("allows one plumbing repair while preserving expectations and target implementation", async () => {
  const f = fixture();
  const original = f.runtime.runAgent;
  let correct = "";
  f.runtime.runAgent = async (task) => {
    const result = await original(task);
    const path = join(f.context.workspace.targetRoot, "tests/runner.cjs");
    if (task.side === "source") {
      correct = readFileSync(path, "utf8");
      writeFileSync(path, "console.log('invalid json')");
    } else {
      writeFileSync(path, correct);
      writeFileSync(
        join(
          f.context.workspace.targetRoot,
          ".forexplore-tests/diagnosis.json",
        ),
        JSON.stringify({
          kind: "harness",
          reason: "Fix observation serialization",
        }),
      );
    }
    return result;
  };
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  f.fill();
  const result = await strategy.verifyTranslation(
    f.input,
    f.context,
    preparation,
  );
  expect(result.targetAssessment).toBe("no_bug_observed");
  expect(f.agents).toEqual(["source", "target"]);
});

it("cancels before Agent2 when replay is interrupted", async () => {
  const f = fixture();
  const controller = new AbortController();
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  const preparation = await strategy.prepareTests(f.input, f.context);
  f.fill();
  f.runtime.runCommand = async () => {
    controller.abort();
    throw controller.signal.reason;
  };
  expect(
    (
      await strategy.verifyTranslation(
        f.input,
        f.context,
        preparation,
        controller.signal,
      )
    ).executionStatus,
  ).toBe("cancelled");
  expect(f.agents).toEqual(["source"]);
});

it.each([false, true])("binds source expectations to original replay, source modified=%s", async modified => {
  const f = fixture(0); const author = f.runtime.runAgent;
  f.runtime.runAgent = async task => {
    const result = await author(task);
    if (task.side === "source") {
      if (!modified) writeFileSync(join(task.sandbox.cwd, "implementation.cjs"), "module.exports = x => x;");
      mkdirSync(join(task.sandbox.cwd, "tests"));
      writeFileSync(join(task.sandbox.cwd, "tests/runner.cjs"), readFileSync(join(f.context.workspace.targetRoot, "tests/runner.cjs"), "utf8"));
      writeFileSync(join(task.sandbox.cwd, ".forexplore-tests/manifest.json"), JSON.stringify({ schemaVersion: "3.0", notes: "Preserved behavior", cases: [{ caseId: "zero", input: 0, intent: "zero unchanged", expectation: { kind: "source", rationale: "Preserved behavior", provenance: ["source implementation"] } }], testFiles: ["tests/runner.cjs"], commands: { setup: [], run: { executable: process.execPath, args: ["tests/runner.cjs"] } } }));
    }
    return result;
  };
  const strategy = new MultiAgentBlackBoxStrategy({ runtime: f.runtime });
  if (modified) await expect(strategy.prepareTests(f.input, f.context)).rejects.toThrow(/baseline changed/);
  else {
    const preparation = await strategy.prepareTests(f.input, f.context); f.fill();
    expect(await strategy.verifyTranslation(f.input, f.context, preparation)).toMatchObject({ executionStatus: "completed", mode: "differential", targetAssessment: "no_bug_observed" });
  }
});

it("skips Agent1 for the explicit not-applicable target-only branch", async () => {
  const f = fixture(); f.input.analysisReport = { applicability: { level: "reject" } }; f.fill();
  f.runtime.runAgent = async task => {
    expect(task.side).toBe("target");
    expect(task.sandbox.readRoots).toEqual([f.context.workspace.targetRoot]);
    f.agents.push(task.side);
    throw new Error("Toolchain unavailable in fixture");
  };
  const result = await new MultiAgentBlackBoxStrategy({ runtime: f.runtime }).verifyTranslation(f.input, f.context);
  expect(f.agents).toEqual(["target"]);
  expect(result).toMatchObject({ mode: "target_only", sourceAssessment: "not_checked", executionStatus: "failed" });
  expect(result.summary).toContain("not black-box preparation");
});

it("uses Host-issued preparation across service instances without requiring the experimental source at verification", async () => {
  const f = fixture();
  const source = "module.exports = x => x;";
  // SAFETY: focused fixture supplies the source file subset checked by the verifier schema.
  f.input.request.sourceBundle.files = [{ path: "implementation.cjs", content: source, contentHash: hashContent(source) }] as typeof f.input.request.sourceBundle.files;
  const options = { workspaceRoot: join(f.root, "host-workspaces"), artifactRoot: join(f.root, "host-artifacts"), blackBox: { runtime: f.runtime } };
  const preparation = await createDefaultVerificationService(options).prepareTests(f.input, {
    strategyId: MULTI_AGENT_BLACK_BOX_STRATEGY.id,
    preparedProjects: { sourceRoot: f.context.workspace.sourceRoot, targetRoot: f.context.workspace.targetRoot },
  });
  f.fill();
  const result = await createDefaultVerificationService(options).verifyTranslation(f.input, {
    strategyId: MULTI_AGENT_BLACK_BOX_STRATEGY.id, preparation: JSON.parse(JSON.stringify(preparation)),
    preparedProjects: { targetRoot: f.context.workspace.targetRoot },
  });
  expect(result).toMatchObject({ executionStatus: "completed", targetAssessment: "no_bug_observed" });
});

it("restores frozen test permissions independently of process umask", () => {
  const f = fixture(); mkdirSync(join(f.context.workspace.targetRoot, "tests"));
  const path = join(f.context.workspace.targetRoot, "tests/group.cjs"); writeFileSync(path, "module.exports=1"); chmodSync(path, 0o664);
  const files = capturePreparationFiles(f.context.workspace.targetRoot, ["tests/group.cjs"]);
  const fresh = join(f.root, "fresh-permissions"); mkdirSync(fresh);
  restorePreparationFiles(fresh, files);
  expect(capturePreparationFiles(fresh, ["tests/group.cjs"])).toEqual(files);
});

it("rejects a rehashed forged capsule at the external service boundary", async () => {
  const f = fixture();
  const preparation = await new MultiAgentBlackBoxStrategy({
    runtime: f.runtime,
  }).prepareTests(f.input, f.context);
  f.fill();
  const forged = createPreparation(
    MULTI_AGENT_BLACK_BOX_STRATEGY,
    f.input,
    preparation.payload,
  );
  const service = createDefaultVerificationService({
    workspaceRoot: join(f.root, "host-workspaces"),
    artifactRoot: join(f.root, "host-artifacts"),
    blackBox: { runtime: f.runtime },
  });
  await expect(
    service.verifyTranslation(f.input, {
      strategyId: MULTI_AGENT_BLACK_BOX_STRATEGY.id,
      preparation: forged,
    }),
  ).rejects.toThrow(/Host.*preparation|preparation.*Host/);
});
