import { describe, expect, it } from "vitest";
import { createRunRecorder, currentRunRecorder, withRunRecorder } from "./record-run-events.js";
import { validateRunEventSchema, validateRunSchema } from "./verification-schemas.js";

const observation = { kind: "command", source: "command-proxy:child-performance", durationMs: 8 };

describe("run recorder", () => {
  it("rejects invalid Host run IDs rather than retaining unbounded identity", () => {
    for (const runId of ["", " ", "x".repeat(257)]) {
      expect(() => createRunRecorder({ runId })).toThrow("Run ID must be a nonempty identifier of at most 256 characters.");
    }
  });

  it("completes ordered stages and skips without inventing measurements", () => {
    const recorder = createRunRecorder({ runId: "ordered" });
    for (const stage of recorder.snapshot().stages) {
      if (stage.id === "prepare-agent-task") {
        recorder.skipStage(stage.id, "Provider has no preparation hook.");
      } else {
        recorder.startStage(stage.id);
        recorder.endStage(stage.id, "completed");
      }
    }
    const run = recorder.finish();
    expect(run.stages.map(({ state }) => state)).toEqual(["completed", "completed", "skipped", "completed", "completed", "completed"]);
    expect(run.stages[2]).not.toHaveProperty("durationMs");
    expect(run.diagnostics).toEqual([]);
    expect(validateRunSchema(run)).toBe(true);
  });

  it("preserves explicitly sourced child offsets without rebasing or adding durations", () => {
    const recorder = createRunRecorder({ runId: "child-clock", monotonicNow: () => 1000 });
    recorder.observe({ ...observation, offsetMs: 3 });
    expect(recorder.events()[0]).toMatchObject({ source: observation.source, offsetMs: 3, durationMs: 8 });
    expect(recorder.finish().totalDurationMs).toBe(0);
  });
  it("omits missing non-Host offsets while preserving child offsets and Host receipt times", () => {
    let clock = 1000;
    const receivedAt = "2026-09-07T12:00:00.000Z";
    const recorder = createRunRecorder({ runId: "clock-origins", monotonicNow: () => clock, now: () => receivedAt });
    clock = 1012;
    recorder.observe({ ...observation, offsetMs: 12 });
    recorder.observe(observation);
    recorder.observe({ ...observation, source: "buffered-provider" });
    recorder.observe({ ...observation, source: "host-performance" });
    recorder.observe({ ...observation, offsetMs: 0 });
    const events = recorder.events();
    expect(events[0]).toMatchObject({ source: observation.source, offsetMs: 12, receivedAt });
    expect(events[1]).toMatchObject({ source: observation.source, durationMs: 8, receivedAt });
    expect(events[1]).not.toHaveProperty("offsetMs");
    expect(events[2]).not.toHaveProperty("offsetMs");
    expect(events[3]).toMatchObject({ source: "host-performance", offsetMs: 12, receivedAt });
    expect(events[4]).toMatchObject({ source: observation.source, offsetMs: 0 });
    expect(events.every((event) => validateRunEventSchema(event))).toBe(true);
  });

  it("measures only started stages with a monotonic clock", () => {
    let clock = 0;
    const recorder = createRunRecorder({ runId: "run-test", monotonicNow: () => clock });
    recorder.startStage("validate-input");
    clock = 12;
    recorder.endStage("validate-input", "completed");
    expect(recorder.snapshot().stages[0]).toMatchObject({ id: "validate-input", state: "completed", durationMs: 12 });
    expect(recorder.snapshot().stages[1].durationMs).toBeUndefined();
    expect(validateRunSchema(recorder.finish())).toBe(true);
  });

  it("ignores wall-clock jumps and preserves legitimate zero durations", () => {
    let clock = 0;
    let wall = "2026-09-07T12:00:00.000Z";
    const recorder = createRunRecorder({ runId: "jump", now: () => wall, monotonicNow: () => clock });
    recorder.startStage("validate-input");
    recorder.endStage("validate-input", "completed");
    recorder.startStage("prepare-workspace");
    clock = 15;
    wall = "2026-09-06T12:00:00.000Z";
    recorder.endStage("prepare-workspace", "completed");
    const run = recorder.finish();
    expect(run.totalDurationMs).toBe(15);
    expect(run.stages[0].durationMs).toBe(0);
    expect(run.stages[1].durationMs).toBe(15);
    expect(run.endedAt).toBe(wall);
  });

  it("isolates concurrent contexts and restores the outer recorder", async () => {
    const outer = createRunRecorder({ runId: "outer" });
    await withRunRecorder(outer, async () => {
      await Promise.all(["first", "second"].map(async (runId) => {
        const recorder = createRunRecorder({ runId });
        await withRunRecorder(recorder, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          expect(currentRunRecorder()).toBe(recorder);
          currentRunRecorder()!.observe(observation);
        });
        expect(recorder.events().map((event) => event.runId)).toEqual([runId]);
      }));
      expect(currentRunRecorder()).toBe(outer);
    });
    expect(currentRunRecorder()).toBeUndefined();
    expect(outer.events()).toEqual([]);
  });

  it("finishes once, ignores every late write, and returns detached snapshots/events", () => {
    let clock = 0;
    const recorder = createRunRecorder({ runId: "once", monotonicNow: () => clock });
    recorder.observe(observation);
    recorder.skipStage("validate-input", "not needed");
    const first = recorder.finish();
    clock = 100;
    recorder.startStage("prepare-workspace");
    recorder.endStage("prepare-workspace", "failed", new Error("late"));
    recorder.skipStage("prepare-agent-task", "late");
    recorder.observe(observation);
    recorder.anomaly("late", "late");
    expect(recorder.finish()).toEqual(first);
    first.stages[0].reason = "mutated";
    first.diagnostics.push({ code: "mutated", message: "mutated" });
    recorder.events()[0].source = "mutated";
    expect(recorder.snapshot().stages[0].reason).toBe("not needed");
    expect(recorder.snapshot().diagnostics).toEqual([]);
    expect(recorder.events()).toHaveLength(1);
    expect(recorder.events()[0].source).toBe(observation.source);
  });

  it("preserves cancellation identity without taking lifecycle ownership", async () => {
    const recorder = createRunRecorder({ runId: "cancel" });
    const abort = new DOMException("cancel", "AbortError");
    await expect(withRunRecorder(recorder, async () => {
      recorder.startStage("validate-input");
      recorder.endStage("validate-input", "cancelled", abort);
      throw abort;
    })).rejects.toBe(abort);
    expect(currentRunRecorder()).toBeUndefined();
    expect(recorder.snapshot().endedAt).toBeUndefined();
    expect(recorder.finish().stages[0]).toMatchObject({ state: "cancelled", error: "cancel" });
  });

  it("records missing ends and bad ordering only as diagnostics", async () => {
    const recorder = createRunRecorder({ runId: "incomplete" });
    const result = Object.freeze({ status: "pass", issues: Object.freeze([]) });
    expect(await withRunRecorder(recorder, async () => {
      recorder.startStage("prepare-workspace");
      recorder.endStage("validate-input", "completed");
      recorder.startStage("validate-input");
      recorder.startStage("validate-input");
      recorder.skipStage("validate-input", "cannot skip running stage");
      recorder.anomaly("optional-observation", "does not change result");
      return result;
    })).toBe(result);
    const run = recorder.finish();
    expect(run.stages[0]).toMatchObject({ state: "failed", reason: "Stage ended without a matching end observation." });
    expect(run.stages[0].durationMs).toBeUndefined();
    expect(run.stages[1]).toEqual({ id: "prepare-workspace", state: "not-started" });
    expect(run.stages.some((stage) => stage.state === "running")).toBe(false);
    expect(run.diagnostics.map((item) => item.code)).toContain("stage-missing-end");
    expect(result).toEqual({ status: "pass", issues: [] });
    expect(validateRunSchema(run)).toBe(true);
  });

  it("retains at most 10,000 events with trustworthy receipt identity and child clock metadata", () => {
    let clock = 40;
    const recorder = createRunRecorder({ runId: "bounded", monotonicNow: () => clock });
    clock = 52;
    for (let index = 0; index < 10_001; index++) recorder.observe(observation);
    const events = recorder.events();
    expect(events).toHaveLength(10_000);
    expect(events[0]).toMatchObject({ ...observation, runId: "bounded", sequence: 0 });
    expect(events.every((event) => !("offsetMs" in event))).toBe(true);
    expect(events.at(-1)!.sequence).toBe(9999);
    expect(events.every((event) => validateRunEventSchema(event))).toBe(true);
    expect(recorder.snapshot().hostEvents.completeness).toBe("truncated");
    expect(recorder.snapshot().diagnostics.filter((item) => item.code === "events-truncated")).toHaveLength(1);
  });

  it("bounds and redacts strings, drops raw payloads and invalid observations", () => {
    const recorder = createRunRecorder({ runId: "sanitized" });
    recorder.startStage("validate-input");
    recorder.endStage("validate-input", "failed", new Error(`API_KEY=secret ${"x".repeat(5000)}`));
    recorder.observe({ ...observation, name: `TOKEN=secret ${"x".repeat(1000)}`, rawPayload: "private code", runId: "forged", sequence: 99 } as typeof observation);
    recorder.observe({ ...observation, durationMs: Number.NaN });
    recorder.observe({ ...observation, get name(): string { throw new Error("broken getter"); } });
    for (let index = 0; index < 300; index++) recorder.anomaly("x".repeat(300), "PASSWORD=secret " + "x".repeat(5000));
    const run = recorder.finish();
    expect(run.diagnostics).toHaveLength(256);
    expect(run.diagnostics.at(-1)!.code).toBe("diagnostics-truncated");
    expect(run.stages[0].error!.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(run)).not.toContain("=secret");
    expect(recorder.events()).toHaveLength(1);
    expect(recorder.events()[0]).toMatchObject({ runId: "sanitized", sequence: 0 });
    expect(recorder.events()[0]).not.toHaveProperty("rawPayload");
    expect(validateRunEventSchema(recorder.events()[0])).toBe(true);
    expect(validateRunSchema(run)).toBe(true);
  });

  it("does not serialize arbitrary error objects or let getters mask an error", () => {
    const recorder = createRunRecorder({ runId: "error" });
    const error = new Error("original");
    Object.defineProperty(error, "message", { get() { throw new Error("getter"); } });
    recorder.startStage("validate-input");
    expect(() => recorder.endStage("validate-input", "failed", error)).not.toThrow();
    expect(recorder.finish().stages[0].error).toBe("Error details unavailable.");
  });
});
