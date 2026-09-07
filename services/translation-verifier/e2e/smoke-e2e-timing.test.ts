import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunRecorder, currentRunRecorder } from "../src/run-output/record-run.js";
import { writeSmokeTiming } from "./write-smoke-timing.js";
import { runSmokeE2E } from "./run-smoke-e2e.js";
import { runSmoke } from "../src/strategies/smoke-differential/run-smoke-verification.js";
import { validSmokeReport } from "../src/strategies/smoke-differential/differential-test-fixtures.js";

vi.mock("../src/strategies/smoke-differential/run-smoke-verification.js", () => ({ runSmoke: vi.fn() }));
const identifiers = { strategy: "differential-smoke", strategyVersion: "1.0.0", model: "fake-model", mode: "verify-only", fixture: "dependencies" };
const directories: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "tv-e2e-timing-")); directories.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("metadata-only smoke E2E timing", () => {
  it("writes dynamic inclusive Host spans, distinct approximate tasks and separately sourced command durations", () => {
    let clock = 100;
    const recorder = createRunRecorder({ runId: "e2e", monotonicNow: () => clock });
    const outer = recorder.startStep("host-wrapper", { scope: "strategy" });
    const inner = recorder.startStep("arbitrary-step", { scope: "strategy", parentId: outer!.id });
    recorder.observe({ kind: "agent-step-approximate", source: "host-performance", name: "explore", event: "start", operationId: "a1" });
    clock += 4;
    recorder.observe({ kind: "agent-step-approximate", source: "host-performance", name: "explore", event: "end", operationId: "a1" });
    recorder.observe({ kind: "agent-step-approximate", source: "host-performance", name: "explore", event: "start", operationId: "a2" });
    recorder.observe({ kind: "agent-step-approximate", source: "host-performance", name: "judge", event: "end", operationId: "a3" });
    recorder.observe({ kind: "command", source: "command-proxy:process-date-now", commandId: "c1", name: "source-run", durationMs: 3, exitCode: 0, timedOut: false });
    recorder.endStep(inner, "completed");
    recorder.endStep(outer, "failed", new Error("PRIVATE-PROMPT"));
    const dir = directory();
    expect(writeSmokeTiming(dir, identifiers, recorder.finish(), recorder.events())).toBe(dir);
    const raw = readFileSync(join(dir, "timing.json"), "utf8");
    const timing = JSON.parse(raw);
    expect(timing.totalDurationMs).toBe(4);
    expect(timing.hostSpans.map((span: { name: string }) => span.name)).toEqual(["host-wrapper", "arbitrary-step"]);
    expect(timing.agentTasks).toMatchObject([{ name: "explore", durationMs: 4, state: "complete" }, { name: "explore", state: "missing-end" }, { name: "judge", state: "missing-start" }]);
    expect(timing.agentTasks[1]).not.toHaveProperty("durationMs");
    expect(timing.commands[0]).toMatchObject({ durationMs: 3, source: "command-proxy:process-date-now" });
    expect(raw).not.toContain("PRIVATE-PROMPT");
    expect(readFileSync(join(dir, "timing.md"), "utf8")).toContain("Do not sum");
  });

  it("keeps missing telemetry explicit and output failure best-effort", () => {
    const recorder = createRunRecorder({ runId: "missing" });
    const run = recorder.finish();
    const dir = directory();
    writeSmokeTiming(dir, identifiers, run, []);
    expect(JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")).agentAvailability).toBe("unavailable");
    expect(writeSmokeTiming(join(dir, "missing"), identifiers, run, [])).toBeUndefined();
  });

  it.each(["pass", "fail", "error"] as const)("preserves %s result JSON and exit semantics with timing outside stdout", async (status) => {
    vi.stubEnv("VERIFIER_LOG_LEVEL", "ERROR");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = directory();
    const result = { status, summary: status, durationMs: 1, generatedTestsKept: true, keptDir: dir, report: validSmokeReport() };
    vi.mocked(runSmoke).mockImplementationOnce(async (_job, options) => {
      expect(currentRunRecorder()).toBeDefined();
      expect(options?.mode).toBe("verify-only");
      return result;
    });
    expect(await runSmokeE2E(["--verify-only", "--json", "--api-key", "fake-key"])).toBe(status === "error" ? 1 : 0);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.mock.calls[0][0])).toEqual(result);
    expect(JSON.parse(readFileSync(join(dir, "timing.json"), "utf8"))).toMatchObject({ mode: "verify-only", fixture: "dependencies" });
  });
});
