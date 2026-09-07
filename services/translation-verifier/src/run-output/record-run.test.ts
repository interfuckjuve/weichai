import { describe, expect, it } from "vitest";
import { createRunRecorder, currentRunRecorder, withRunRecorder } from "./record-run.js";
import { validateRunEventSchema, validateRunSchema } from "../schemas/compile-schema-validators.js";

const observation = { kind: "command", source: "command-proxy:child-performance", durationMs: 8 };

describe("run recorder", () => {
  it("rejects invalid Host run IDs rather than retaining unbounded identity", () => {
    for (const runId of ["", " ", "x".repeat(257)]) {
      expect(() => createRunRecorder({ runId })).toThrow("Run ID must be a nonempty identifier of at most 256 characters.");
    }
  });

  it("records repeated and nested arbitrary steps with occurrence handles", async () => {
    let clock = 0;
    const recorder = createRunRecorder({ runId: "variable", monotonicNow: () => clock });
    const result = Object.freeze({ status: "pass" });
    expect(await recorder.measureStep("compare-custom", { scope: "strategy" }, async () => {
      clock = 2;
      await recorder.measureStep("compare-custom", { scope: "strategy" }, async () => { clock = 7; });
      clock = 9;
      return result;
    })).toBe(result);
    const run = recorder.finish();
    expect(run.stages.map((step) => step.name)).toEqual(["compare-custom", "compare-custom"]);
    expect(new Set(run.stages.map((step) => step.id)).size).toBe(2);
    expect(run.stages[1].parentId).toBe(run.stages[0].id);
    expect(run.stages.map((step) => step.durationMs)).toEqual([9, 5]);
    expect(run.diagnostics).toEqual([]);
    expect(validateRunSchema(run)).toBe(true);
  });

  it("records skipped observations without inventing measurements", () => {
    const recorder = createRunRecorder({ runId: "skipped" });
    const handle = recorder.startStep("custom", { scope: "strategy" });
    recorder.endStep(handle, "completed");
    recorder.skipStep("optional", { scope: "strategy" }, "Not applicable.");
    const run = recorder.finish();
    expect(run.stages.map(({ state }) => state)).toEqual(["completed", "skipped"]);
    expect(run.stages[1]).not.toHaveProperty("durationMs");
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
    const handle1 = recorder.startStep("validate-input", { scope: "framework" });
    clock = 12;
    recorder.endStep(handle1, "completed");
    expect(recorder.snapshot().stages[0]).toMatchObject({ name: "validate-input", state: "completed", durationMs: 12 });
    expect(recorder.snapshot().stages).toHaveLength(1);
    expect(validateRunSchema(recorder.finish())).toBe(true);
  });

  it("ignores wall-clock jumps and preserves legitimate zero durations", () => {
    let clock = 0;
    let wall = "2026-09-07T12:00:00.000Z";
    const recorder = createRunRecorder({ runId: "jump", now: () => wall, monotonicNow: () => clock });
    const handle2 = recorder.startStep("validate-input", { scope: "framework" });
    recorder.endStep(handle2, "completed");
    const handle3 = recorder.startStep("prepare-workspace", { scope: "framework" });
    clock = 15;
    wall = "2026-09-06T12:00:00.000Z";
    recorder.endStep(handle3, "completed");
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
    recorder.skipStep("validate-input", { scope: "framework" }, "not needed");
    const first = recorder.finish();
    clock = 100;
    const handle4 = recorder.startStep("prepare-workspace", { scope: "framework" });
    recorder.endStep(handle4, "failed", new Error("late"));
    recorder.skipStep("prepare-agent-task", { scope: "framework" }, "late");
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
    let calls = 0;
    await expect(withRunRecorder(recorder, () => recorder.measureStep("custom-cancellation", { scope: "strategy" }, () => {
      calls++;
      throw abort;
    }))).rejects.toBe(abort);
    expect(calls).toBe(1);
    expect(currentRunRecorder()).toBeUndefined();
    expect(recorder.snapshot().endedAt).toBeUndefined();
    expect(recorder.finish().stages[0]).toMatchObject({ state: "cancelled", error: "cancel" });
  });

  it("records missing ends and invalid handles only as diagnostics", async () => {
    const recorder = createRunRecorder({ runId: "incomplete" });
    const other = createRunRecorder({ runId: "other" });
    const result = Object.freeze({ status: "pass", issues: Object.freeze([]) });
    const handle = recorder.startStep("unfinished", { scope: "strategy" });
    recorder.endStep({ id: handle!.id }, "completed");
    recorder.endStep(other.startStep("foreign", { scope: "strategy" }), "completed");
    expect(await withRunRecorder(recorder, async () => result)).toBe(result);
    const run = recorder.finish();
    expect(run.stages[0]).toMatchObject({ state: "failed", reason: "Stage ended without a matching end observation." });
    expect(run.stages[0]).not.toHaveProperty("durationMs");
    expect(run.stages[0]).not.toHaveProperty("endedAt");
    expect(run.diagnostics.map((item) => item.code)).toEqual(["step-lifecycle", "step-lifecycle", "stage-missing-end"]);
    expect(result).toEqual({ status: "pass", issues: [] });
    expect(validateRunSchema(run)).toBe(true);
    recorder.endStep(handle, "completed");
    expect(recorder.snapshot()).toEqual(run);
  });

  it("rejects malformed step observations without changing callback values or errors", async () => {
    const recorder = createRunRecorder({ runId: "invalid-steps" });
    const result = Object.freeze({ status: "pass" });
    const error = new Error("original");
    let calls = 0;
    for (const name of ["", " ", "x".repeat(257)]) {
      expect(await recorder.measureStep(name, { scope: "strategy" }, () => { calls++; return result; })).toBe(result);
    }
    await expect(recorder.measureStep("custom", { scope: "strategy", parentId: "missing" }, () => { calls++; throw error; })).rejects.toBe(error);
    expect(recorder.startStep("custom", { scope: "unknown" as never })).toBeUndefined();
    expect(recorder.startStep("custom", { get scope(): never { throw error; } })).toBeUndefined();
    expect(calls).toBe(4);
    expect(recorder.snapshot().stages).toEqual([]);
    expect(recorder.snapshot().diagnostics.map((item) => item.code)).toEqual(Array(6).fill("invalid-step"));
    expect(validateRunSchema(recorder.finish())).toBe(true);
  });

  it("bounds steps and diagnostics without skipping the measured callback", async () => {
    const recorder = createRunRecorder({ runId: "step-budget" });
    for (let index = 0; index < 1025; index++) recorder.skipStep("repeated", { scope: "strategy" }, "No work.");
    let calls = 0;
    expect(await recorder.measureStep("overflow", { scope: "strategy" }, () => ++calls)).toBe(1);
    expect(calls).toBe(1);
    expect(recorder.snapshot().stages).toHaveLength(1024);
    expect(recorder.snapshot().diagnostics.map((item) => item.code)).toEqual(["steps-truncated"]);
    const finished = recorder.finish();
    expect(await recorder.measureStep("late", { scope: "strategy" }, () => ++calls)).toBe(2);
    expect(recorder.snapshot()).toEqual(finished);
    expect(validateRunSchema(finished)).toBe(true);
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
    const handle6 = recorder.startStep("validate-input", { scope: "framework" });
    recorder.endStep(handle6, "failed", new Error(`API_KEY=secret ${"x".repeat(5000)}`));
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
    const handle7 = recorder.startStep("validate-input", { scope: "framework" });
    expect(() => recorder.endStep(handle7, "failed", error)).not.toThrow();
    expect(recorder.finish().stages[0].error).toBe("Error details unavailable.");
  });
});
