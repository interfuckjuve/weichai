import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifier } from "../src/verify.js";
import { createAgentHost } from "../src/host/runtime.js";
import { createTranslationVerifierModelClient } from "../src/host/model-client.js";
import { createJsonlAgentWorkLogger } from "../src/host/work-log.js";
import { createJsonlAgentTraceLogger } from "../src/host/trace-log.js";
import type { SingleAgentTerminalResult } from "../src/strategies/single-agent/strategy.js";
import type { VerificationResult } from "../src/types.js";
import type { AgentWorkLogEvent } from "../src/host/work-log.js";
import {
  createFixtureWorkspace,
  materializeFixtureInput,
  type FixtureWorkspace,
} from "./fixture-workspace.js";

const liveEnabled = process.env.TRANSLATION_VERIFIER_LIVE_E2E === "1";
const liveTest = liveEnabled ? it : it.skip;
const keepWorkspaces = process.env.TRANSLATION_VERIFIER_LIVE_KEEP_WORKTREE === "1";
const workspaces: FixtureWorkspace[] = [];

afterEach(async () => {
  const pending = workspaces.splice(0);
  if (keepWorkspaces) {
    for (const workspace of pending) {
      console.info(
        JSON.stringify({
          stage: "translation-verifier-live-workspace",
          preserved: true,
          repositoryRoot: workspace.repositoryRoot,
          targetWorktree: workspace.targetRoot,
        }),
      );
    }
    return;
  }
  await Promise.all(pending.map((workspace) => workspace.dispose()));
});

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function defaultArtifactPaths(): {
  logPath: string;
  reportPath: string;
  tracePath: string;
} {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const directory = join(process.cwd(), "logs");
  const artifactStem = `translation-verifier-live-${timestamp}`;
  return {
    logPath: join(directory, `${artifactStem}.jsonl`),
    reportPath: join(directory, `${artifactStem}.json`),
    tracePath: join(directory, `${artifactStem}-trace.jsonl`),
  };
}

function errorSummary(error: unknown): Record<string, unknown> {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    errorMessageCharacters: error instanceof Error ? error.message.length : String(error).length,
  };
}

function summarizeTools(events: readonly AgentWorkLogEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.event === "tool.started")
    .map((started) => {
      const completed = events.find(
        (event) =>
          (event.event === "tool.completed" || event.event === "tool.failed") &&
          event.turn === started.turn &&
          event.toolCallId === started.toolCallId,
      );
      return {
        turn: started.turn,
        id: started.toolCallId,
        name: started.toolName,
        status: completed?.event === "tool.completed" ? "success" : "failure",
        ...(completed?.elapsedMs === undefined ? {} : { durationMs: completed.elapsedMs }),
        ...(completed?.status === undefined ? {} : { statusDetail: completed.status }),
        ...(completed?.exitCode === undefined ? {} : { exitCode: completed.exitCode }),
        ...(completed?.timedOut === undefined ? {} : { timedOut: completed.timedOut }),
      };
    });
}

describe("translation verifier live model E2E", () => {
  liveTest(
    "runs the real model through the Host and records a bounded work log",
    async () => {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "DEEPSEEK_API_KEY is required when TRANSLATION_VERIFIER_LIVE_E2E=1.",
        );
      }

      const workspace = await createFixtureWorkspace();
      workspaces.push(workspace);
      const input = await materializeFixtureInput(workspace);
      const artifactPaths = defaultArtifactPaths();
      const logPath = process.env.TRANSLATION_VERIFIER_LIVE_LOG ?? artifactPaths.logPath;
      const reportPath = process.env.TRANSLATION_VERIFIER_LIVE_REPORT ?? artifactPaths.reportPath;
      const tracePath = process.env.TRANSLATION_VERIFIER_LIVE_TRACE ?? artifactPaths.tracePath;
      const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
      const workLogger = createJsonlAgentWorkLogger(logPath);
      const traceLogger = createJsonlAgentTraceLogger(tracePath, [apiKey]);
      const modelClient = createTranslationVerifierModelClient({
        apiKey: () => apiKey,
        apiBase: process.env.DEEPSEEK_API_BASE,
        model,
      });
      const host = createAgentHost<SingleAgentTerminalResult>({
        modelClient,
        workLogger,
        traceLogger,
        limits: {
          maxDurationMs: positiveIntegerEnv(
            "TRANSLATION_VERIFIER_LIVE_MAX_DURATION_MS",
            600_000,
          ),
          maxTurns: positiveIntegerEnv("TRANSLATION_VERIFIER_LIVE_MAX_TURNS", 24),
          maxToolCalls: positiveIntegerEnv(
            "TRANSLATION_VERIFIER_LIVE_MAX_TOOL_CALLS",
            80,
          ),
          maxToolCallsPerTurn: positiveIntegerEnv(
            "TRANSLATION_VERIFIER_LIVE_MAX_TOOL_CALLS_PER_TURN",
            8,
          ),
        },
      });

      let result: VerificationResult | undefined;
      let runError: unknown;
      try {
        result = await createVerifier(host)(input, "single-agent", "verify");
      } catch (error) {
        runError = error;
      }
      const log = await readFile(logPath, "utf8");
      const events = log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentWorkLogEvent);
      const completedRun = [...events].reverse().find((event) => event.event === "run.completed");
      const targetTest = [...events]
        .reverse()
        .find((event) => event.event === "tool.completed" && event.toolName === "run_target_tests");
      const trace = await readFile(tracePath, "utf8");
      const traceEvents = trace
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const report = {
        startedAt: events[0]?.at,
        finishedAt: new Date().toISOString(),
        runId: events[0]?.runId,
        fixture: "commons-fileupload-read-body-data",
        strategy: "single-agent",
        phase: "verify",
        model,
        passed: runError === undefined && result?.status === "success",
        turns: completedRun?.turns ?? Math.max(0, ...events.map((event) => event.turn ?? 0)),
        totalToolCalls: completedRun?.totalToolCalls,
        tools: summarizeTools(events),
        trace: {
          path: tracePath,
          events: traceEvents.length,
        },
        workspace: {
          preserved: keepWorkspaces,
          ...(keepWorkspaces ? { targetWorktree: workspace.targetRoot } : {}),
        },
        ...(targetTest
          ? {
              targetTest: {
                status: targetTest.status,
                exitCode: targetTest.exitCode,
                timedOut: targetTest.timedOut,
                durationMs: targetTest.elapsedMs,
              },
            }
          : {}),
        ...(result
          ? {
              result: {
                status: result.status,
                ...(result.issue ? { issueKind: result.issue.kind } : {}),
              },
            }
          : {}),
        ...(runError ? { error: errorSummary(runError) } : {}),
      };
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });

      const reportText = await readFile(reportPath, "utf8");
      if (runError) throw runError;
      expect(result?.status).toBe("success");
      expect(events[0]?.event).toBe("run.started");
      expect(events.some((event) => event.event === "tool.completed")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.event === "tool.completed" &&
            event.toolName === "run_target_tests",
        ),
      ).toBe(true);
      expect(events.at(-1)?.event).toBe("run.completed");
      expect(traceEvents.some((event) => event.event === "model.request")).toBe(true);
      expect(traceEvents.some((event) => event.event === "model.response")).toBe(true);
      expect(
        traceEvents.some(
          (event) => event.event === "tool.started" && event.arguments !== undefined,
        ),
      ).toBe(true);
      expect(
        traceEvents.some(
          (event) => event.event === "tool.completed" && event.output !== undefined,
        ),
      ).toBe(true);
      expect(log).not.toContain(apiKey);
      expect(log).not.toContain(workspace.sourceRoot);
      expect(log).not.toContain(workspace.targetRoot);
      expect(trace).not.toContain(apiKey);
      expect(trace).not.toContain("Authorization");
      expect(reportText).not.toContain(apiKey);

      console.info(
        JSON.stringify({
          stage: "translation-verifier-live-e2e",
          status: result?.status,
          logPath,
          reportPath,
          tracePath,
          targetWorktree: keepWorkspaces ? workspace.targetRoot : undefined,
          events: events.length,
          traceEvents: traceEvents.length,
        }),
      );
    },
    720_000,
  );
});
