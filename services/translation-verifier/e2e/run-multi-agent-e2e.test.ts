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
  it("accepts the true black-box strategy and explicit per-session output budgets", () => {
    expect(
      parseMultiAgentArgs([
        "--strategy",
        "multi-agent-black-box",
        "--output-root",
        "/tmp/e2e",
        "--max-turns",
        "12",
      ]),
    ).toMatchObject({
      strategyId: "multi-agent-black-box",
      outputRoot: "/tmp/e2e",
      maxTurns: 12,
      timeoutMs: 600_000,
    });
    expect(parseMultiAgentArgs(["--max-turns", "0"])).toHaveProperty("error");
  });
  it("runs true black-box preparation before fixed translation, preserving source experiments only in the copy", async () => {
    const paths = await roots();
    const sourceBefore = projectHash(sourceProjectRoot);
    const targetBefore = projectHash(targetProjectRoot);
    const events: string[] = [];
    const subject =
      "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
    const blackbox: BehaviorRuntime = {
      async runAgent(task) {
        events.push(`agent-${task.side}`);
        expect(task.side).toBe("source");
        expect(task.executionSides).toEqual(["source"]);
        const target = task.additionalProjects!.target!.cwd;
        expect(await readFile(join(target, subject), "utf8")).toBe(
          await readFile(join(targetProjectRoot, subject), "utf8"),
        );
        expect(task.prompt.length).toBeLessThan(25_000);
        expect(task.prompt).toContain(task.sandbox.cwd);
        expect(task.prompt).toContain(target);
        expect(task.prompt).not.toContain("{{source_project_root}}");
        expect(task.prompt).not.toContain('"sourceFiles"');
        expect(task.prompt).not.toContain("outputProvenance");
        expect(task.prompt).not.toContain("has been filled in");
        expect(task.prompt).toContain(
          "Only when execution is authorized and required in this phase",
        );
        expect(task.prompt).toContain(
          "Host executes these target tests only AFTER translation",
        );
        await writeFile(
          join(task.sandbox.cwd, "src/commons_fileupload/core.py"),
          "# source experiment in the copy\n",
        );
        await writeFile(
          join(task.sandbox.cwd, ".forexplore-tests/manifest.json"),
          JSON.stringify({
            schemaVersion: "3.0",
            notes: "Requirement-derived oracle, no source observation",
            testFiles: [],
            cases: [
              {
                caseId: "case-1",
                intent: "body",
                input: { body: "YWJj" },
                expectation: {
                  kind: "requirement",
                  rationale: "Count body bytes",
                  provenance: ["request.requirement"],
                  expected: { caseId: "case-1", outcome: "return", value: 3 },
                },
              },
            ],
          }),
        );
        await mkdir(join(target, "src/test/java"), { recursive: true });
        await writeFile(
          join(target, "src/test/java/FrozenBodyTest.java"),
          "class FrozenBodyTest {}\n",
        );
        await writeFile(
          join(target, ".forexplore-tests/manifest.json"),
          JSON.stringify({
            schemaVersion: "2.0",
            notes: "Tests authored against target contract",
            testFiles: ["src/test/java/FrozenBodyTest.java"],
            resultFile: ".forexplore-tests/observations.json",
            commands: { setup: [], run: { executable: "fixture", args: [] } },
          }),
        );
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "",
          stderr: "",
        };
      },
      async runCommand(task) {
        events.push("replay-target");
        expect(task.sandbox.cwd.endsWith("/target")).toBe(true);
        expect(
          await readFile(
            join(task.sandbox.cwd, "src/test/java/FrozenBodyTest.java"),
            "utf8",
          ),
        ).toBe("class FrozenBodyTest {}\n");
        return runtime.runCommand(task);
      },
    };
    const output = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 10_000,
        strategyId: "multi-agent-black-box",
        outputRoot: paths.root,
        live: true,
        json: false,
      },
      {
        runtime: blackbox,
        prepareProjects: async (context) => {
          const { targetRoot, sides } = context;
          events.push(
            events.includes("agent-source")
              ? "preflight-translated"
              : "preflight-original",
          );
          if (events.includes("agent-source")) {
            expect(context).toMatchObject({ compileTests: false });
            expect(sides).toEqual(["target"]);
            expect(await readFile(join(targetRoot, subject), "utf8")).not.toBe(
              await readFile(join(targetProjectRoot, subject), "utf8"),
            );
          }
          return {
            command: "fixture compile",
            cwd: targetRoot,
            durationMs: 1,
            exitCode: 0,
            timedOut: false,
            stdout: "ready",
            stderr: "",
          };
        },
      },
    );
    expect(output.result, JSON.stringify(output.result.problems)).toMatchObject(
      {
        strategyId: "multi-agent-black-box",
        executionStatus: "completed",
        targetAssessment: "no_bug_observed",
      },
    );
    expect(events).toEqual([
      "preflight-original",
      "agent-source",
      "preflight-translated",
      "replay-target",
    ]);
    expect(output.workspaceRoot).toContain(
      "/multi-agent-black-box/commons-fileupload-java-skeleton/",
    );
    const benchmark = JSON.parse(
      await readFile(join(output.workspaceRoot, "benchmark.json"), "utf8"),
    );
    expect(benchmark).toMatchObject({
      executionMode: "injected-test",
      originalsUnchanged: true,
      strategy: "multi-agent-black-box",
      effort: "low",
    });
    expect(
      JSON.parse(
        await readFile(join(output.workspaceRoot, "report.json"), "utf8"),
      ),
    ).toEqual(output.result);
    for (const name of [
      "timing.json",
      "events.jsonl",
      "agent/original-preparation.json",
      "agent/translated-preparation.json",
    ])
      expect(await stat(join(output.workspaceRoot, name))).toBeTruthy();
    expect(
      JSON.parse(await readFile(output.timingPath, "utf8")).hostSpans,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "copy-projects",
          state: "completed",
          durationMs: expect.any(Number),
        }),
        expect.objectContaining({ name: "black-box-agent2", state: "skipped" }),
      ]),
    );
    expect(projectHash(sourceProjectRoot)).toBe(sourceBefore);
    expect(projectHash(targetProjectRoot)).toBe(targetBefore);
  });

  it("retains verifier timeout evidence when target cleanup finishes after the phase deadline", async () => {
    const paths = await roots();
    const output = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 1000,
        live: false,
        json: false,
      },
      {
        ...paths,
        runtime: {
          ...runtime,
          async runAgent(task) {
            if (task.side === "source") return runtime.runAgent(task);
            await new Promise<void>((resolve) => {
              if (task.signal?.aborted) resolve();
              else
                task.signal?.addEventListener(
                  "abort",
                  () => setTimeout(resolve, 20),
                  { once: true },
                );
            });
            return {
              exitCode: null,
              timedOut: true,
              durationMs: 1000,
              stdout: "",
              stderr: "target timed out",
            };
          },
        },
      },
    );
    expect(output.result.executionStatus).not.toBe("completed");
    expect(
      output.result.problems.some(
        (problem) => problem.code === "environment_unavailable",
      ),
    ).toBe(false);
    expect(output.result.strategyReport).toMatchObject({
      stage: "target",
      caseStatus: "timeout",
    });
    expect(
      output.result.artifacts.some(
        (artifact) => artifact.kind === "target-agent-session",
      ),
      JSON.stringify(output.result.artifacts),
    ).toBe(true);
  });

  it("classifies a black-box preparation timeout as timeout rather than environment failure", async () => {
    const paths = await roots();
    const output = await executeMultiAgentE2E(
      {
        strategyId: "multi-agent-black-box",
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 1000,
        live: false,
        json: false,
      },
      {
        ...paths,
        runtime: {
          ...runtime,
          async runAgent() {
            throw new DOMException(
              "prepare-tests deadline exceeded",
              "TimeoutError",
            );
          },
        },
      },
    );
    expect(output.result.executionStatus).toBe("failed");
    expect(output.result.problems).toEqual([
      { code: "agent_timeout", message: "prepare-tests deadline exceeded" },
    ]);
  });

  it("retains outer failure artifacts when durable storage is unavailable", async () => {
    const paths = await roots();
    await writeFile(paths.artifactRoot, "not a directory\n");
    const output = await executeMultiAgentE2E(
      {
        task: "multipart-read-body",
        variant: "correct",
        timeoutMs: 0,
        live: false,
        json: false,
      },
      { ...paths, runtime },
    );
    expect(output.result.executionStatus).toBe("failed");
    expect(JSON.parse(await readFile(output.resultPath, "utf8"))).toEqual(
      output.result,
    );
    expect(
      JSON.parse(await readFile(output.benchmarkPath, "utf8")),
    ).toMatchObject({ originalsUnchanged: true });
    expect(await stat(output.eventsPath)).toBeTruthy();
  });

  it.each(["multi-agent-differential", "multi-agent-black-box"] as const)(
    "skips Agent1 and its handoff for a not-applicable target-only run (%s)",
    async (strategyId) => {
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
          strategyId,
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
      expect(
        result.result,
        JSON.stringify(result.result.problems),
      ).toMatchObject({
        mode: "target_only",
        sourceAssessment: "not_checked",
        executionStatus: "completed",
        targetAssessment: "no_bug_observed",
      });
      expect(result.result.strategyReport).not.toHaveProperty("sourceSnapshot");
      expect(result.result.strategyReport).toHaveProperty("targetPlan");
    },
  );

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
          expect(task.prompt).toContain(task.sandbox.cwd);
          expect(task.prompt).toContain(targetRoot);
          expect(task.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
          expect(task.prompt.length).toBeLessThan(25_000);
          expect(task.prompt).toContain("For cases requiring execution");
          expect(task.prompt).not.toContain('"sourceFiles"');
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
