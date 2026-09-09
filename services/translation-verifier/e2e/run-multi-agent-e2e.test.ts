import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeMultiAgentE2E,
  parseMultiAgentArgs,
} from "./run-multi-agent-e2e.js";
import {
  sourceProjectRoot,
  targetProjectRoot,
  fileUploadInput,
} from "./fileupload-benchmark-fixture.js";
import { projectHash } from "../src/strategies/multi-agent-differential/behavior-workspace.js";
import type { BehaviorRuntime } from "../src/strategies/multi-agent-differential/behavior-types.js";

const runtime: BehaviorRuntime = {
  async runAgent(task) {
    const root = join(task.sandbox.cwd, ".forexplore-tests");
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify(
        task.side === "source"
          ? {
              schemaVersion: "3.0",
              cases: [
                {
                  caseId: "case-1",
                  intent: "body",
                  input: { body: "YWJj" },
                  expectation: {
                    kind: "source",
                    rationale: "Preserve body transfer",
                    provenance: ["analysisReport.applicability"],
                  },
                },
              ],
              testFiles: [".forexplore-tests/harness.json"],
              resultFile: ".forexplore-tests/observations.json",
              notes: "fixture",
              commands: { setup: [], run: { executable: "fixture", args: [] } },
            }
          : {
              schemaVersion: "2.0",
              testFiles: [".forexplore-tests/harness.json"],
              resultFile: ".forexplore-tests/observations.json",
              notes: "fixture",
              commands: { setup: [], run: { executable: "fixture", args: [] } },
            },
      ),
      { flag: "w" },
    );
    await writeFile(join(root, "harness.json"), "{}\n", { flag: "w" });
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "",
      stderr: "",
    };
  },
  async runCommand(task) {
    const target = task.sandbox.cwd.endsWith("/target");
    const content = target
      ? await readFile(
          join(
            task.sandbox.cwd,
            "src/main/java/org/apache/commons/fileupload/MultipartStream.java",
          ),
          "utf8",
        )
      : "";
    // Injected deterministic observations test orchestration only, not Java behavior.
    const mutation =
      content.includes(
        "return (int) Streams.copy(newInputStream(), output, false) + 1;",
      ) ||
      content.includes(
        "return (int) Streams.copy(newInputStream(), null, false);",
      );
    const output = JSON.stringify([
      { caseId: "case-1", outcome: "return", value: mutation ? 4 : 3 },
    ]);
    await writeFile(
      join(task.sandbox.cwd, ".forexplore-tests/observations.json"),
      `${output}\n`,
    );
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: output,
      stderr: "",
    };
  },
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function roots() {
  const root = await mkdtemp(join(tmpdir(), "multi-agent-e2e-"));
  temporaryRoots.push(root);
  return {
    root,
    workspaceRoot: join(root, "workspaces"),
    artifactRoot: join(root, "artifacts"),
  };
}

describe("multi-agent differential E2E", () => {
  it("skips Agent1 and its handoff for a not-applicable target-only run", async () => {
    const events: string[] = [];
    const input = fileUploadInput("correct", "multipart-read-body");
    input.analysisReport = { applicability: { level: "reject" } };
    const targetRuntime: BehaviorRuntime = {
      ...runtime,
      async runAgent(task) {
        expect(events).toEqual([]);
        events.push(task.side);
        expect(task.side).toBe("target");
        expect(task.sandbox.readRoots).toEqual([task.sandbox.cwd]);
        expect(task.executionSides).toEqual(["target"]);
        expect(task.prompt).not.toContain("<source-collection-context>");
        expect(task.expectationFile).toBe(
          join(task.sandbox.cwd, ".forexplore-tests/target-plan.json"),
        );
        const plan = JSON.stringify({
          schemaVersion: "1.0",
          testBasis: {
            summary: "Transfer all body bytes",
            evidence: ["request.requirement"],
          },
          cases: [
            {
              caseId: "case-1",
              intent: "body",
              input: { body: "YWJj" },
              expectation: {
                kind: "requirement",
                rationale: "Report the number of bytes transferred",
                provenance: ["request.requirement"],
                expected: { caseId: "case-1", outcome: "return", value: 3 },
              },
            },
          ],
        });
        await writeFile(task.expectationFile!, plan);
        const result = await runtime.runAgent(task);
        // This fixed evidence tests assembly, not live Java execution or model quality.
        const record = {
          ...result,
          commandId: "fixture-target-command",
          side: "target" as const,
          cwd: task.sandbox.cwd,
          command: { executable: "fixture", args: [] },
          completed: true,
          baselineValid: true,
          credentialHit: false,
          testFiles: { ".forexplore-tests/harness.json": "{}\n" },
        };
        task.onEvidence?.([record], plan);
        return { ...result, frozenPlan: plan, commandEvidence: [record] };
      },
    };
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10000,
        live: false,
        json: false,
      },
      {
        ...(await roots()),
        input,
        runtime: targetRuntime,
      },
    );
    expect(events).toEqual(["target"]);
    expect(result.result, JSON.stringify(result.result.problems)).toMatchObject(
      {
        mode: "target_only",
        sourceAssessment: "not_checked",
        executionStatus: "completed",
        targetAssessment: "no_bug_observed",
      },
    );
    expect(result.result.strategyReport).not.toHaveProperty("sourceSnapshot");
    expect(result.result.strategyReport).toHaveProperty("targetPlan");
  });

  it("prepares source tests before fixture translation application and leaves original fixtures untouched", async () => {
    const paths = await roots();
    const sourceFixtureHash = projectHash(sourceProjectRoot);
    const targetFixtureHash = projectHash(targetProjectRoot);
    const ordered: string[] = [];
    const observedRuntime: BehaviorRuntime = {
      ...runtime,
      async runAgent(task) {
        if (task.side === "source") {
          const targetRoot = task.sandbox.readRoots.find((path) =>
            path.endsWith("/target"),
          )!;
          const subject =
            "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
          expect(await readFile(join(targetRoot, subject), "utf8")).toBe(
            await readFile(join(targetProjectRoot, subject), "utf8"),
          );
          ordered.push("agent1");
        }
        return runtime.runAgent(task);
      },
      async runCommand(task) {
        ordered.push(
          task.sandbox.cwd.endsWith("/target") ? "target" : "source",
        );
        return runtime.runCommand(task);
      },
    };
    const pending = executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        live: false,
        json: false,
      },
      {
        ...paths,
        runtime: observedRuntime,
      },
    );
    const result = await pending;
    expect(result.targetReady).toBe(true);
    expect(result.result.targetAssessment).toBe("no_bug_observed");
    expect(ordered).toEqual(["agent1", "source", "target"]);
    const targetOriginal = await readFile(
      join(
        targetProjectRoot,
        "src/main/java/org/apache/commons/fileupload/MultipartStream.java",
      ),
      "utf8",
    );
    const sourceOriginal = await readFile(
      join(sourceProjectRoot, "src/commons_fileupload/core.py"),
      "utf8",
    );
    expect(
      await readFile(
        join(
          result.workspaceRoot,
          "target/src/main/java/org/apache/commons/fileupload/MultipartStream.java",
        ),
        "utf8",
      ),
    ).not.toBe(targetOriginal);
    expect(
      await readFile(
        join(result.workspaceRoot, "source/src/commons_fileupload/core.py"),
        "utf8",
      ),
    ).toBe(sourceOriginal);
    expect(
      (
        await stat(
          join(result.workspaceRoot, "source/src/commons_fileupload/core.py"),
        )
      ).nlink,
    ).toBe(1);
    expect(projectHash(sourceProjectRoot)).toBe(sourceFixtureHash);
    expect(projectHash(targetProjectRoot)).toBe(targetFixtureHash);
    expect(
      await readFile(join(result.workspaceRoot, "target/pom.xml"), "utf8"),
    ).toContain("commons-fileupload");
  });

  it.each([
    ["count-plus-one", "bug_found"],
    ["drop-output", "bug_found"],
  ] as const)("reports target mutation %s", async (variant, assessment) => {
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant,
        timeoutMs: 10_000,
        live: false,
        json: false,
      },
      { ...(await roots()), runtime },
    );
    expect(result.result.targetAssessment).toBe(assessment);
    expect(result.result.sourceAssessment).toBe("inconclusive");
  });

  it("prepares the patched full target project before agent2 and permits only new tests/build outputs", async () => {
    const paths = await roots();
    const events: string[] = [];
    let targetSawInputs = false;
    const observedRuntime: BehaviorRuntime = {
      ...runtime,
      async runAgent(task) {
        events.push(`agent-${task.side}`);
        if (task.side === "target") {
          targetSawInputs = true;
          await stat(join(task.sandbox.writeRoots[0], "inputs.json"));
          await mkdir(join(task.sandbox.cwd, "src/test/java"), {
            recursive: true,
          });
          await writeFile(
            join(task.sandbox.cwd, "src/test/java/FxTests.java"),
            "class FxTests {}\n",
          );
        }
        return runtime.runAgent(task);
      },
    };
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        live: true,
        json: false,
      },
      {
        ...paths,
        runtime: observedRuntime,
        prepareProjects: async ({ targetRoot }) => {
          const translated = events.includes("agent-source");
          events.push(translated ? "prepare-translated" : "prepare-original");
          const subject =
            "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
          expect(
            (await readFile(join(targetRoot, subject), "utf8")) ===
              (await readFile(join(targetProjectRoot, subject), "utf8")),
          ).toBe(!translated);
          await mkdir(join(targetRoot, "target/classes"), { recursive: true });
          await writeFile(
            join(targetRoot, "target/classes/output.bin"),
            "compiled\n",
          );
          return {
            command: "mvn -B -ntp -DskipTests test-compile",
            cwd: targetRoot,
            durationMs: 2,
            exitCode: 0,
            timedOut: false,
            stdout: "BUILD SUCCESS",
            stderr: "",
          };
        },
      },
    );
    expect(events).toEqual([
      "prepare-original",
      "agent-source",
      "prepare-translated",
      "agent-target",
    ]);
    expect(targetSawInputs).toBe(true);
    expect(result.preparationEvidencePath).toBeDefined();
    expect(
      JSON.parse(await readFile(result.preparationEvidencePath!, "utf8")),
    ).toMatchObject({ exitCode: 0, cwd: join(result.workspaceRoot, "target") });
    expect(
      await readFile(join(result.workspaceRoot, "target/pom.xml"), "utf8"),
    ).toContain("<project");
    expect(
      await stat(
        join(result.workspaceRoot, "target/src/test/java/FxTests.java"),
      ),
    ).toBeTruthy();
    expect(
      await stat(
        join(result.workspaceRoot, "target/target/classes/output.bin"),
      ),
    ).toBeTruthy();
  });

  it("stops both agents when project preparation fails", async () => {
    const paths = await roots();
    const sides: string[] = [];
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        live: true,
        json: false,
      },
      {
        ...paths,
        runtime: {
          ...runtime,
          async runAgent(task) {
            sides.push(task.side);
            return runtime.runAgent(task);
          },
        },
        prepareProjects: async ({ targetRoot }) => ({
          command: "mvn -B -ntp -DskipTests test-compile",
          cwd: targetRoot,
          durationMs: 3,
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "BUILD FAILURE",
        }),
      },
    );
    expect(sides).toEqual([]);
    expect(result.result.targetAssessment).toBe("not_checked");
    expect(result.result.problems[0]?.code).toBe("environment_unavailable");
    expect(
      JSON.parse(await readFile(result.preparationEvidencePath!, "utf8")),
    ).toMatchObject({ exitCode: 1, stderr: "BUILD FAILURE" });
  });
  it("retains the frozen source capsule when post-translation fixture preparation fails", async () => {
    const paths = await roots();
    const sides: string[] = [];
    let preparations = 0;
    const output = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        live: true,
        json: false,
      },
      {
        ...paths,
        runtime: {
          ...runtime,
          async runAgent(task) {
            sides.push(task.side);
            return runtime.runAgent(task);
          },
        },
        prepareProjects: async ({ targetRoot }) => ({
          command: "fixture compile",
          cwd: targetRoot,
          durationMs: 1,
          exitCode: ++preparations === 1 ? 0 : 1,
          timedOut: false,
          stdout: "",
          stderr: "fixture compile evidence",
        }),
      },
    );
    expect(sides).toEqual(["source"]);
    expect(output.result.executionStatus).toBe("failed");
    const artifact = output.result.artifacts.find(
      (item) => item.kind === "fixture-verification-preparation",
    )!;
    expect(
      JSON.parse(
        await readFile(join(paths.artifactRoot, artifact.path), "utf8"),
      ),
    ).toMatchObject({
      strategyVersion: "4.0.0",
      payload: {
        report: {
          sourceSnapshot: { observations: [{ caseId: "case-1", value: 3 }] },
        },
      },
    });
  });
  it("waits for an aborted preparation to finish and persist timed-out evidence", async () => {
    const paths = await roots();
    let targetAgents = 0;
    const startedAt = Date.now();
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 20,
        live: true,
        json: false,
      },
      {
        ...paths,
        runtime: {
          ...runtime,
          async runAgent(task) {
            if (task.side === "target") targetAgents++;
            return runtime.runAgent(task);
          },
        },
        prepareProjects: async ({ targetRoot }) => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            command: "mvn -B -ntp -DskipTests test-compile",
            cwd: targetRoot,
            durationMs: 60,
            exitCode: null,
            timedOut: true,
            stdout: "partial build log",
            stderr: "deadline",
          };
        },
      },
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(targetAgents).toBe(0);
    expect(result.preparationEvidencePath).toBeDefined();
    expect(
      JSON.parse(await readFile(result.preparationEvidencePath!, "utf8")),
    ).toMatchObject({
      timedOut: true,
      stdout: "partial build log",
      stderr: "deadline",
    });
  });

  it("rejects live injected execution without an explicit preparation seam", async () => {
    const paths = await roots();
    let started = false;
    await expect(
      executeMultiAgentE2E(
        {
          task: "multipart-read-body",
          variant: "correct",
          timeoutMs: 10_000,
          live: true,
          json: false,
        },
        {
          ...paths,
          runtime: {
            ...runtime,
            async runAgent(task) {
              started = true;
              return runtime.runAgent(task);
            },
          },
        },
      ),
    ).rejects.toThrow("explicit prepareProjects seam");
    expect(started).toBe(false);
  });
  it("fails closed for invalid classification before starting agents", async () => {
    expect(
      parseMultiAgentArgs(["--strategy", "multi-agent-differential", "--live"]),
    ).toMatchObject({ live: true });
    const paths = await roots();
    let started = false;
    const guarded = {
      ...runtime,
      async runAgent(task: Parameters<BehaviorRuntime["runAgent"]>[0]) {
        started = true;
        return runtime.runAgent(task);
      },
    };
    const input = fileUploadInput("correct", "multipart-read-body");
    input.analysisReport = {
      scope: "test",
      applicability: { level: "invalid" },
    };
    const result = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        live: false,
        json: false,
      },
      { ...paths, runtime: guarded, input },
    );
    expect(result.result.executionStatus).toBe("failed");
    expect(result.result.problems[0]?.code).toBe("context_incomplete");
    expect(started).toBe(false);
  });
});
