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
  it("keeps source and original fixtures untouched and applies target only after the barrier", async () => {
    const paths = await roots();
    const sourceFixtureHash = projectHash(sourceProjectRoot);
    const targetFixtureHash = projectHash(targetProjectRoot);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sourceStarted = false;
    const ordered: string[] = [];
    const observedRuntime: BehaviorRuntime = {
      ...runtime,
      async runAgent(task) {
        if (task.side === "source") {
          sourceStarted = true;
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
        waitForTarget: async () => {
          expect(sourceStarted).toBe(true);
          expect(ordered).toEqual(["agent1", "source"]);
          release();
          await barrier;
        },
      },
    );
    const result = await pending;
    expect(result.targetReady).toBe(true);
    expect(result.result.targetAssessment).toBe("no_bug_observed");
    expect(ordered.at(-1)).toBe("target");
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
          events.push("prepare");
          const subject =
            "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
          expect(await readFile(join(targetRoot, subject), "utf8")).not.toBe(
            await readFile(join(targetProjectRoot, subject), "utf8"),
          );
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
    expect(events).toEqual(["prepare", "agent-source", "agent-target"]);
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
