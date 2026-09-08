import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import type { BehaviorRuntime } from "../src/strategies/multi-agent-differential/behavior-types.js";

const runtime: BehaviorRuntime = {
  async runAgent(task) {
    const root = task.sandbox.writeRoots[0];
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify(
        task.side === "source"
          ? {
              schemaVersion: "1.0",
              cases: [
                { caseId: "case-1", intent: "body", input: { body: "YWJj" } },
              ],
              testFiles: ["harness.json"],
              notes: "fixture",
              commands: { setup: [], run: { executable: "fixture", args: [] } },
            }
          : {
              schemaVersion: "1.0",
              testFiles: ["harness.json"],
              notes: "fixture",
              commands: { setup: [], run: { executable: "fixture", args: [] } },
            },
      ),
      { flag: "wx" },
    );
    await writeFile(join(root, "harness.json"), "{}\n", { flag: "wx" });
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
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: JSON.stringify([
        { caseId: "case-1", outcome: "return", value: mutation ? 4 : 3 },
      ]),
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
      targetProjectRoot +
        "/src/main/java/org/apache/commons/fileupload/MultipartStream.java",
      "utf8",
    );
    const sourceOriginal = await readFile(
      sourceProjectRoot + "/src/commons_fileupload/core.py",
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

  it("fails closed for an ineligible input before starting agents", async () => {
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
      migrationEligibility: { decision: "ineligible" },
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
