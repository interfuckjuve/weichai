import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSingleAgentE2E,
  parseSingleAgentArgs,
  runSingleAgentE2E,
  type SingleAgentE2EDeps,
} from "./run-single-agent-e2e.js";
import {
  fileUploadInput,
  sourceProjectRoot,
  targetProjectRoot,
  javaPath,
  pythonPath,
} from "./fileupload-benchmark-fixture.js";
import { projectHash } from "../src/strategies/multi-agent-differential/behavior-workspace.js";

const prepared: NonNullable<SingleAgentE2EDeps["prepareProjects"]> = async ({
  sourceRoot,
  targetRoot,
}) =>
  (["source", "target"] as const).map((side) => ({
    side,
    cwd: side === "source" ? sourceRoot : targetRoot,
    command: "injected fixture preparation",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: "ready",
    stderr: "",
  }));
const noReplay = async () => {
  throw new Error("No separate command replay is expected");
};

const options = {
  task: "multipart-read-body" as const,
  variant: "correct" as const,
  timeoutMs: 10_000,
  live: false,
  json: false,
  offlineOnly: false,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("single-agent E2E execution boundary", () => {
  it("accepts a common output root and native session turn limit", () => {
    expect(
      parseSingleAgentArgs(["--output-root", "/tmp/e2e", "--max-turns", "12"]),
    ).toMatchObject({
      outputRoot: "/tmp/e2e",
      maxTurns: 12,
      timeoutMs: 600_000,
    });
    expect(parseSingleAgentArgs(["--max-turns", "0"])).toHaveProperty("error");
  });
  it.each([
    ["--live", "--offline-only"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "NaN"],
    ["--timeout-ms", "2147483648"],
    ["--task", "unknown"],
    ["--variant", "unknown"],
    ["--effort", "invalid"],
    ["--mode", "target_only"],
    ["--test-basis", "answer"],
    ["--analysis-report"],
    ["--variant", "missing-policy"],
    ["--variant", "missing-test-basis"],
    ["--variant", "target-only-correct"],
  ])("rejects invalid or forced-decision arguments %j", (...argv) => {
    expect(parseSingleAgentArgs(argv)).toHaveProperty("error");
  });

  it("keeps separate runs and unified failure artifacts under the common project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
    roots.push(root);
    const runAgent = vi.fn(noReplay);
    const run = () =>
      executeSingleAgentE2E(
        { ...options, outputRoot: root },
        {
          runtime: { runAgent, runCommand: noReplay },
          prepareProjects: async () => {
            throw new Error("environment unavailable");
          },
        },
      );
    const first = await run();
    const originalReport = await readFile(first.resultPath, "utf8");
    const second = await run();
    expect(first.workspaceRoot).not.toBe(second.workspaceRoot);
    expect(second.workspaceRoot).toContain(
      "/single-agent-differential/commons-fileupload-java-skeleton/",
    );
    expect(await readFile(first.resultPath, "utf8")).toBe(originalReport);
    const benchmark = JSON.parse(
      await readFile(join(second.workspaceRoot, "benchmark.json"), "utf8"),
    );
    expect(benchmark).toMatchObject({
      executionMode: "injected-test",
      originalsUnchanged: true,
      dataset: { standardDatasetMatch: true },
      effort: "low",
      budget: { maxTurns: 50 },
    });
    expect(
      JSON.parse(
        await readFile(join(second.workspaceRoot, "report.json"), "utf8"),
      ),
    ).toEqual(second.result);
    const timing = JSON.parse(await readFile(second.timingPath, "utf8"));
    expect(timing.hostSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "single-agent-validation",
          state: "skipped",
        }),
      ]),
    );
    expect(await stat(join(second.workspaceRoot, "events.jsonl"))).toBeTruthy();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("retains a failed report when the durable artifact destination is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
    roots.push(root);
    const artifactRoot = join(root, "blocked-artifacts");
    await writeFile(artifactRoot, "not a directory\n");
    const output = await executeSingleAgentE2E(
      { ...options, outputRoot: root },
      {
        artifactRoot,
        runtime: { runAgent: vi.fn(noReplay), runCommand: noReplay },
        prepareProjects: async () => {
          throw new Error("preflight unavailable");
        },
      },
    );
    expect(output.result.executionStatus).toBe("failed");
    expect(JSON.parse(await readFile(output.resultPath, "utf8"))).toEqual(
      output.result,
    );
    expect(
      JSON.parse(await readFile(output.benchmarkPath, "utf8")),
    ).toMatchObject({ originalsUnchanged: true });
    expect(await stat(output.timingPath)).toBeTruthy();
  });

  it("requires explicit preparation for an injected runtime and records environment failure before any Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
    roots.push(root);
    const runAgent = vi.fn(() => {
      throw new Error("Agent must not start");
    });
    const deps = {
      workspaceRoot: root,
      runtime: { runAgent, runCommand: noReplay },
    };
    await expect(executeSingleAgentE2E(options, deps)).rejects.toThrow(
      "prepareProjects",
    );
    const result = await executeSingleAgentE2E(options, {
      ...deps,
      prepareProjects: async ({ sourceRoot, targetRoot }) => [
        {
          side: "source",
          cwd: sourceRoot,
          command: "python fixture preflight",
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "imported",
          stderr: "",
        },
        {
          side: "target",
          cwd: targetRoot,
          command: "java fixture preflight",
          exitCode: 1,
          timedOut: false,
          durationMs: 2,
          stdout: "",
          stderr: "missing JDK",
        },
      ],
    });
    expect(runAgent).not.toHaveBeenCalled();
    expect(result.result.executionStatus).toBe("failed");
    expect(result.result.problems[0].code).toBe("environment_unavailable");
    expect(result.result.targetAssessment).toBe("not_checked");
    expect(result.result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/:e2e-preparation$/),
          kind: "environment-preparation",
        }),
      ]),
    );
    expect(result.timings.agentMs).toBe(0);
    expect(
      JSON.parse(await readFile(result.preparationEvidencePath, "utf8")),
    ).toMatchObject({
      status: "failed",
      evidence: [{ side: "source" }, { side: "target", stderr: "missing JDK" }],
    });
    expect(JSON.parse(await readFile(result.resultPath, "utf8"))).toEqual(
      result.result,
    );
  });
  it.each(["target_only", "differential"] as const)(
    "runs one session after complete project preparation (%s), without leaking Host labels",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
      roots.push(root);
      const sourceHash = projectHash(sourceProjectRoot);
      const targetHash = projectHash(targetProjectRoot);
      const input = fileUploadInput("both-count-plus-one");
      input.request.targetContext.constraints = [
        "Preserve caller stream ownership; literal {{target_project_root}} is task data.",
      ];
      input.request.decisionNotes = [
        "Do not normalize malformed-input failures.",
      ];
      const originalInput = structuredClone(input);
      const events: string[] = [];
      const runAgent: NonNullable<
        SingleAgentE2EDeps["runtime"]
      >["runAgent"] = async (task) => {
        events.push("agent");
        expect(task.sessionRole).toBe("single-agent");
        expect(task.additionalProjects?.source).toBeDefined();
        const target = task.sandbox.cwd;
        const source = task.additionalProjects!.source!.cwd;
        expect(await readFile(join(source, "manifest.json"), "utf8")).toBe(
          await readFile(join(sourceProjectRoot, "manifest.json"), "utf8"),
        );
        expect(
          input.request.sourceBundle.files.some(
            (file) => file.path === "manifest.json",
          ),
        ).toBe(false);
        expect(
          await readFile(join(source, "pyproject.toml"), "utf8"),
        ).toContain("setuptools");
        expect(await readFile(join(target, "pom.xml"), "utf8")).toContain(
          "commons-fileupload",
        );
        expect(await readFile(join(source, pythonPath), "utf8")).toContain(
          "return len(body) + 1",
        );
        expect(await readFile(join(target, javaPath), "utf8")).toBe(
          input.translation.generatedContent,
        );
        expect(task.prompt.length).toBeLessThan(25_000);
        expect(task.prompt).toContain(source);
        expect(task.prompt).toContain(target);
        expect(task.prompt).not.toContain("{{source_project_root}}");
        expect(task.prompt).toContain(
          input.request.targetContext.constraints[0],
        );
        expect(task.prompt).toContain(input.request.decisionNotes[0]);
        expect(task.prompt).not.toContain(input.translation.generatedContent);
        expect(task.prompt).not.toContain("return len(body) + 1");
        expect(task.prompt).not.toContain("both-count-plus-one");
        expect(task.prompt).not.toContain("Seeded");
        expect(task.prompt).not.toContain("outputProvenance");
        expect(task.prompt).not.toContain('"verificationPolicy"');
        const observed = { caseId: "body", outcome: "return", value: 3 };
        const plan = {
          schemaVersion: "1.0",
          mode,
          referenceReason:
            "Injected workflow decision, not an Agent quality measurement",
          testBasis: {
            summary: "Exact byte count",
            evidence: ["request.requirement"],
          },
          cases: [
            {
              caseId: "body",
              intent: "preserve body count",
              input: { body: "YWJj" },
              expectationBasis:
                mode === "differential" ? "source_observation" : "requirement",
              evidence: ["request.requirement"],
              expected: observed,
              ...(mode === "differential"
                ? { sourceCommandId: "source-1" }
                : {}),
            },
          ],
        };
        await writeFile(
          join(target, ".forexplore-tests/plan.json"),
          JSON.stringify(plan),
        );
        await writeFile(join(target, ".forexplore-tests/runner.json"), "{}\n");
        if (mode === "differential")
          await writeFile(
            join(source, ".forexplore-tests/runner.json"),
            "{}\n",
          );
        await writeFile(
          join(target, ".forexplore-tests/report.json"),
          JSON.stringify({
            schemaVersion: "1.0",
            targetCommandId: "target-1",
            testFiles: {
              source:
                mode === "differential"
                  ? [".forexplore-tests/runner.json"]
                  : [],
              target: [".forexplore-tests/runner.json"],
            },
            notes:
              "Injected execution records verify orchestration only; no Java behavior claim.",
          }),
        );
        const evidence = (
          mode === "differential"
            ? (["source", "target"] as const)
            : (["target"] as const)
        ).map((side) => ({
          commandId: `${side}-1`,
          side,
          cwd: side === "source" ? source : target,
          command: { executable: "injected", args: [] },
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: JSON.stringify([observed]),
          stderr: "",
          baselineValid: true,
          credentialHit: false,
          testFiles: { ".forexplore-tests/runner.json": "{}\n" },
        }));
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "",
          stderr: "",
          frozenPlan: JSON.stringify(plan),
          commandEvidence: evidence,
        };
      };
      const output = await executeSingleAgentE2E(
        { ...options, variant: "both-count-plus-one" },
        {
          workspaceRoot: root,
          input,
          runtime: { runAgent, runCommand: noReplay },
          prepareProjects: async (context) => {
            events.push("prepare");
            expect(
              await readFile(join(context.targetRoot, javaPath), "utf8"),
            ).toBe(input.translation.generatedContent);
            return prepared(context);
          },
        },
      );
      expect(events).toEqual(["prepare", "agent"]);
      expect(output.result.problems).toEqual([]);
      expect(output.result.executionStatus).toBe("completed");
      expect(output.result.mode).toBe(mode);
      expect(output.result.artifacts.length).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(output.resultPath, "utf8"))).toEqual(
        output.result,
      );
      expect(
        JSON.parse(await readFile(output.timingPath, "utf8")),
      ).toMatchObject({
        schemaVersion: "1.0",
        strategy: "single-agent-differential",
        hostSpans: expect.arrayContaining([
          expect.objectContaining({
            name: "single-agent-validation",
            state: "completed",
          }),
        ]),
      });
      expect(output.timings).toMatchObject({
        preparationMs: expect.any(Number),
        agentMs: expect.any(Number),
        totalMs: expect.any(Number),
      });
      expect(input).toEqual(originalInput);
      expect(projectHash(sourceProjectRoot)).toBe(sourceHash);
      expect(projectHash(targetProjectRoot)).toBe(targetHash);
      const sourceCopy = await stat(
        join(output.workspaceRoot, "source", pythonPath),
      );
      expect(sourceCopy.nlink).toBe(1);
      expect(sourceCopy.ino).not.toBe(
        (await stat(join(sourceProjectRoot, pythonPath))).ino,
      );
    },
  );

  it.each(["missing-side", "throws", "timeout"] as const)(
    "preserves preflight failures without starting the Agent (%s)",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
      roots.push(root);
      const runAgent = vi.fn(noReplay);
      const output = await executeSingleAgentE2E(
        {
          ...options,
          timeoutMs: failure === "timeout" ? 20 : options.timeoutMs,
        },
        {
          workspaceRoot: root,
          runtime: { runAgent, runCommand: noReplay },
          prepareProjects: async (context) => {
            if (failure === "throws")
              throw new Error("preflight could not launch");
            const evidence = await prepared(context);
            if (failure === "missing-side") return evidence.slice(0, 1);
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            return evidence.map((item) => ({
              ...item,
              timedOut: true,
              exitCode: null,
              stdout: "partial build output",
            }));
          },
        },
      );
      expect(runAgent).not.toHaveBeenCalled();
      expect(output.result.executionStatus).toBe("failed");
      expect(output.result.referenceDecision).toBe("undetermined");
      expect(output.timings.agentMs).toBe(0);
      const preparation = JSON.parse(
        await readFile(output.preparationEvidencePath, "utf8"),
      );
      expect(preparation.status).toBe("failed");
      if (failure === "timeout")
        expect(preparation.evidence[0]).toMatchObject({
          timedOut: true,
          stdout: "partial build output",
        });
      if (failure === "throws")
        expect(preparation.error).toBe("preflight could not launch");
    },
  );

  it("loads an explicitly supplied Analyzer report and rejects malformed report JSON before preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
    roots.push(root);
    const reportPath = join(root, "analysis.json");
    const report = {
      scope: "multipart behavior",
      evidence: "externally supplied test analysis",
    };
    await writeFile(reportPath, JSON.stringify(report));
    let prompt = "";
    const runtime: NonNullable<SingleAgentE2EDeps["runtime"]> = {
      async runAgent(task) {
        prompt = task.prompt;
        return {
          exitCode: 1,
          timedOut: false,
          durationMs: 1,
          stdout: "",
          stderr: "injected stop",
        };
      },
      runCommand: noReplay,
    };
    const preparation = vi.fn(prepared);
    const output = await executeSingleAgentE2E(
      { ...options, analysisReport: reportPath },
      { workspaceRoot: root, runtime, prepareProjects: preparation },
    );
    expect(prompt).toContain(JSON.stringify(report));
    expect(output.result.executionStatus).toBe("failed");
    await writeFile(reportPath, "not JSON");
    await expect(
      executeSingleAgentE2E(
        { ...options, analysisReport: reportPath },
        { workspaceRoot: root, runtime, prepareProjects: preparation },
      ),
    ).rejects.toThrow();
    expect(preparation).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials in preflight evidence and thrown preparation errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
    roots.push(root);
    const secret = "e2e-private-secret-123";
    const runtime = { runAgent: vi.fn(noReplay), runCommand: noReplay };
    const failed = await executeSingleAgentE2E(
      { ...options, apiKey: secret },
      {
        workspaceRoot: root,
        runtime,
        prepareProjects: async (context) =>
          (await prepared(context)).map((item) => ({
            ...item,
            exitCode: 1,
            stdout: `stored credential ${secret}`,
            stderr: secret,
          })),
      },
    );
    const text = await readFile(failed.preparationEvidencePath, "utf8");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
    const thrown = await executeSingleAgentE2E(
      { ...options, apiKey: secret },
      {
        workspaceRoot: root,
        runtime,
        prepareProjects: async () => {
          throw new Error(`failed ${secret}`);
        },
      },
    );
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(
      await readFile(thrown.preparationEvidencePath, "utf8"),
    ).not.toContain(secret);
    expect(runtime.runAgent).not.toHaveBeenCalled();
  });

  it("requires explicit live execution and distinguishes an offline skip", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSingleAgentE2E([])).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("--live"));
      expect(await runSingleAgentE2E(["--offline-only", "--json"])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
        executionMode: "skipped",
        reason: "offline-only",
      });
      await expect(executeSingleAgentE2E(options)).rejects.toThrow("--live");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
