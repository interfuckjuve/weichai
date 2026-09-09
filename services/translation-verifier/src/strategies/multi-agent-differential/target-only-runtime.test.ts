import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processes from "../smoke-differential/manage-test-process.js";
import { createBehaviorRuntime } from "./claude-runtime.js";
import {
  BEHAVIOR_CONTROL_ENV,
  runBehaviorCommandCli,
  type BehaviorSessionControl,
} from "./behavior-command.js";
import type {
  BehaviorAgentTask,
  BehaviorCommandRecord,
} from "./behavior-types.js";
import { MultiAgentDifferentialStrategy } from "./strategy.js";
import { createVerificationArtifactStore } from "../../run-output/verification-artifact-store.js";
import type { VerificationInput } from "../../schemas/verification-types.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent2-runtime-")));
  roots.push(root);
  const target = join(root, "target");
  const tests = join(target, ".forexplore-tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(target, "implementation.cjs"),
    "module.exports = value => value + 1;",
  );
  const task: BehaviorAgentTask = {
    side: "target",
    sandbox: { cwd: target, readRoots: [target], writeRoots: [tests, target] },
    executionSides: ["target"],
    expectationFile: join(tests, "plan.json"),
    prompt:
      "Design requirement-derived target tests using only the target project.",
    deadlineAt: Date.now() + 10000,
  };
  return { root, target, task };
}

function localAgent(
  callback: (
    input: Parameters<typeof processes.runManagedProcess>[0],
  ) => Promise<void>,
) {
  const actual = processes.runManagedProcess;
  vi.spyOn(processes, "runManagedProcess").mockImplementation(
    async (input, signal) => {
      const result = {
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: "",
        stderr: "",
      };
      if (input.args.includes("--version"))
        return { ...result, stdout: "2.1.236" };
      if (!input.args.includes("--print")) return actual(input, signal);
      await callback(input);
      return result;
    },
  );
}

const command = [
  "--project",
  "target",
  "--",
  "node",
  "-e",
  "console.log(require('./implementation.cjs')(2))",
];

describe("target-only Agent2 runtime controls", () => {
  it.each([
    { scenario: "correct target", delta: 0, alias: false, corrupt: false },
    { scenario: "defective target", delta: 1, alias: false, corrupt: false },
    {
      scenario: "target through a parent symlink",
      delta: 0,
      alias: true,
      corrupt: false,
    },
    {
      scenario: "restored implementation after command integrity failure",
      delta: 0,
      alias: false,
      corrupt: true,
    },
  ])(
    "verifies $scenario through one managed Agent2 session and Host replay",
    async ({ delta, alias, corrupt }) => {
      const f = fixture();
      rmdirSync(join(f.target, ".forexplore-tests"));
      writeFileSync(
        join(f.target, "implementation.cjs"),
        `module.exports = value => value + ${1 + delta};`,
      );
      const strategyRoot = join(f.root, "agent");
      mkdirSync(strategyRoot);
      const aliasRoot = join(f.root, "project-alias");
      if (alias) symlinkSync(f.root, aliasRoot, "dir");
      const store = createVerificationArtifactStore({
        artifactRoot: join(f.root, "durable"),
        durablePrefix: "attempt",
        agentRoot: strategyRoot,
      });
      const input: VerificationInput = {
        schemaVersion: "1.0",
        request: {
          requirement: "Increment the input by one.",
          sourceBundle: { files: [] },
          targetContext: { sourceFiles: [] },
        } as unknown as VerificationInput["request"],
        analysisReport: { applicability: { level: "reject" } },
        migrationPlan: {},
        translation: {
          round: 1,
          generatedContent: "",
          files: [],
          patchHash: "a".repeat(64),
        },
      };
      const cases = [
        {
          caseId: "increment",
          intent: "Increment a positive input",
          input: 2,
          expectation: {
            kind: "requirement",
            rationale: "The requirement explicitly requests adding one.",
            provenance: ["request.requirement"],
            expected: { caseId: "increment", outcome: "return", value: 3 },
          },
        },
      ];
      let sessions = 0;
      localAgent(async (invocation) => {
        sessions++;
        expect(invocation.cwd).toBe(f.target);
        const metadata = join(f.target, ".forexplore-tests");
        writeFileSync(
          join(metadata, "target-plan.json"),
          JSON.stringify({
            schemaVersion: "1.0",
            testBasis: {
              summary: "Increment as requested",
              evidence: ["request.requirement"],
            },
            cases,
          }),
        );
        mkdirSync(join(f.target, "tests"), { recursive: true });
        writeFileSync(
          join(f.target, "tests/runner.cjs"),
          "const fs = require('node:fs'); const subject = require('../implementation.cjs'); const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); console.log(JSON.stringify(cases.map(c => ({caseId:c.caseId,outcome:'return',value:subject(c.input)}))));",
        );
        writeFileSync(
          join(metadata, "probe-inputs.json"),
          JSON.stringify(cases),
        );
        writeFileSync(
          join(metadata, "manifest.json"),
          JSON.stringify({
            schemaVersion: "2.0",
            testFiles: ["tests/runner.cjs"],
            notes:
              "Real project implementation executed via generated test launcher",
            commands: {
              setup: [],
              run: { executable: "node", args: ["tests/runner.cjs"] },
            },
          }),
        );
        if (corrupt && sessions === 1) {
          const implementation = join(f.target, "implementation.cjs");
          const original = readFileSync(implementation, "utf8");
          await expect(
            runBehaviorCommandCli(
              [
                "--project",
                "target",
                "--",
                "node",
                "-e",
                "require('node:fs').writeFileSync('implementation.cjs', 'module.exports = () => 999;')",
              ],
              invocation.env,
            ),
          ).rejects.toThrow(/baseline/);
          writeFileSync(implementation, original);
        }
        expect(
          await runBehaviorCommandCli(
            [
              "--project",
              "target",
              "--",
              "node",
              "tests/runner.cjs",
              ".forexplore-tests/probe-inputs.json",
            ],
            invocation.env,
          ),
        ).toBe(0);
      });
      const output = await new MultiAgentDifferentialStrategy({
        runtime: createBehaviorRuntime({ apiKey: "local-test-key" }),
        executionSides: ["target"],
      }).verify(input, {
        deadlineAt: Date.now() + 10000,
        workspace: {
          root: f.root,
          sourceRoot: join(f.root, "absent-source"),
          targetRoot: alias ? join(aliasRoot, "target") : f.target,
          strategyRoot,
          evidenceRoot: strategyRoot,
        },
        writeArtifact: store.writeArtifact,
      });
      expect(sessions, JSON.stringify(output.problems)).toBe(1);
      if (corrupt) {
        expect(output).toMatchObject({
          executionStatus: "failed",
          targetAssessment: "inconclusive",
          problems: [{ code: "workspace_integrity_violation" }],
          strategyReport: { repairs: [] },
        });
        return;
      }
      expect(output, JSON.stringify(output.problems)).toMatchObject({
        mode: "target_only",
        sourceAssessment: "not_checked",
        executionStatus: "completed",
        targetAssessment: delta === 0 ? "no_bug_observed" : "bug_found",
        problems: [],
      });
      const report = output.strategyReport as Record<string, unknown>;
      expect(report.sourceSnapshot).toBeUndefined();
      expect(report.targetPlan).toMatchObject({ cases });
      expect(report.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: "target", exitCode: 0 }),
        ]),
      );
    },
  );

  it("exposes only the target project and freezes the plan before actual target execution", async () => {
    const f = fixture();
    const plan = '{"schemaVersion":"1.0","expectation":"increment by one"}';
    let records: BehaviorCommandRecord[] = [];
    let frozen: string | undefined;
    f.task.onEvidence = (evidence, snapshot) => {
      records = evidence;
      frozen = snapshot;
    };
    localAgent(async (input) => {
      const control = JSON.parse(
        readFileSync(input.env[BEHAVIOR_CONTROL_ENV]!, "utf8"),
      ) as BehaviorSessionControl;
      expect(Object.keys(control.projects)).toEqual(["target"]);
      expect(control.executionSides).toEqual(["target"]);
      expect(control.projects.target!.scope.readRoots).toEqual([f.target]);
      expect(
        input.args.slice(
          input.args.indexOf("--add-dir") + 1,
          input.args.indexOf("--allowedTools"),
        ),
      ).toEqual([f.target]);
      expect(input.cwd).toBe(f.target);
      await expect(
        runBehaviorCommandCli(
          [
            "--project",
            "source",
            "--",
            "node",
            "-e",
            "throw Error('must not run')",
          ],
          input.env,
        ),
      ).rejects.toThrow(/Host-authorized/);
      writeFileSync(f.task.expectationFile!, plan);
      const snapshot = control.projects.target!.expectation!.snapshot;
      expect(existsSync(snapshot)).toBe(false);
      expect(await runBehaviorCommandCli(command, input.env)).toBe(0);
      expect(readFileSync(snapshot, "utf8")).toBe(plan);
    });
    const result = await createBehaviorRuntime({
      apiKey: "local-test-key",
    }).runAgent(f.task);
    expect(result.frozenPlan).toBe(plan);
    expect(frozen).toBe(plan);
    expect(records).toEqual(result.commandEvidence);
    expect(
      records.some(
        (record) =>
          record.completed &&
          record.side === "target" &&
          record.stdout === "3\n",
      ),
    ).toBe(true);
    expect(
      records.every(
        (record) => record.cwd === f.target && record.side === "target",
      ),
    ).toBe(true);
  });

  it("rejects execution without a plan and any command after frozen expectations change", async () => {
    const f = fixture();
    const plan = '{"expected":3}';
    localAgent(async (input) => {
      const control = JSON.parse(
        readFileSync(input.env[BEHAVIOR_CONTROL_ENV]!, "utf8"),
      ) as BehaviorSessionControl;
      const target = control.projects.target!;
      await expect(runBehaviorCommandCli(command, input.env)).rejects.toThrow();
      expect(existsSync(target.evidencePath!)).toBe(false);
      expect(existsSync(target.expectation!.snapshot)).toBe(false);
      writeFileSync(f.task.expectationFile!, plan);
      expect(await runBehaviorCommandCli(command, input.env)).toBe(0);
      const evidence = readFileSync(target.evidencePath!, "utf8");
      writeFileSync(f.task.expectationFile!, '{"expected":99}');
      await expect(runBehaviorCommandCli(command, input.env)).rejects.toThrow(
        /Frozen test plan/,
      );
      expect(readFileSync(target.evidencePath!, "utf8")).toBe(evidence);
      writeFileSync(f.task.expectationFile!, plan);
    });
    const result = await createBehaviorRuntime({
      apiKey: "local-test-key",
    }).runAgent(f.task);
    expect(result.frozenPlan).toBe(plan);
    expect(
      result.commandEvidence!.filter((record) => record.completed),
    ).toHaveLength(1);
  });
});
