import { describe, expect, it, vi } from "vitest";
import { createRunRecorder, withRunRecorder } from "./record-run.js";
import { markVerificationPhase, measureVerification, summarizeTimings } from "./measure-legacy-run.js";

describe("verification timing", () => {
  it("records legacy marks in the active recorder without claiming precise stage spans", async () => {
    let clock = 100;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const recorder = createRunRecorder({ runId: "shared" });
      clock = 120;
      const measured = await withRunRecorder(recorder, () => measureVerification(async () => {
        clock = 125;
        markVerificationPhase("prepare");
        clock = 130;
        markVerificationPhase("agent");
        clock = 140;
        return "result";
      }));
      expect(measured.timing.totalMs).toBe(20);
      expect(measured.timing.phases.map(({ durationMs }) => durationMs)).toEqual([5, 5, 10]);
      expect(recorder.events().map(({ name }) => name)).toEqual(["prepare", "agent"]);
      expect(recorder.events().every(({ source, kind }) => source === "legacy-measurement:host-performance" && kind === "legacy-phase")).toBe(true);
      expect(recorder.snapshot().stages).toEqual([]);
      expect(recorder.snapshot().endedAt).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("observes marks with a recorder even outside a legacy measurement", async () => {
    const recorder = createRunRecorder({ runId: "marks" });
    await withRunRecorder(recorder, async () => { markVerificationPhase("prepare"); });
    expect(recorder.events()[0]).toMatchObject({ kind: "legacy-phase", name: "prepare", source: "host-performance" });
  });

  it("does not apply an outer measurement identity inside a nested recorder", async () => {
    const nested = createRunRecorder({ runId: "nested" });
    await measureVerification(() => withRunRecorder(nested, async () => {
      markVerificationPhase("nested-mark");
    }));
    expect(nested.events()[0]).toMatchObject({ source: "host-performance", name: "nested-mark" });
    expect(nested.events()[0]).not.toHaveProperty("operationId");
  });

  it("keeps nested legacy measurement marks separate", async () => {
    const outer = await measureVerification(async () => {
      markVerificationPhase("outer-start");
      const inner = await measureVerification(async () => { markVerificationPhase("inner"); });
      expect(inner.timing.phases.map(({ phase }) => phase)).toEqual(["entry-overhead", "inner"]);
      markVerificationPhase("outer-end");
    });
    expect(outer.timing.phases.map(({ phase }) => phase)).toEqual(["entry-overhead", "outer-start", "outer-end"]);
  });
  it("partitions the elapsed time without double-counting nested work", () => {
    const result = summarizeTimings(
      [
        { phase: "prepare", atMs: 2 },
        { phase: "agent", atMs: 5 },
      ],
      10,
    );
    expect(result.phases.map((phase) => phase.durationMs)).toEqual([2, 3, 5]);
    expect(result.phases.reduce((sum, phase) => sum + phase.percent, 0)).toBe(
      100,
    );
  });

  it("isolates concurrent requests and does nothing outside a measured request", async () => {
    markVerificationPhase("ignored");
    const runs = await Promise.all(
      ["first", "second"].map((name) =>
        measureVerification(async () => {
          markVerificationPhase(name);
          await new Promise((resolve) => setTimeout(resolve, 2));
          markVerificationPhase(`${name}-done`);
          return name;
        }),
      ),
    );
    for (const run of runs) {
      expect(run.timing.phases.map((phase) => phase.phase)).toEqual([
        "entry-overhead",
        run.value,
        `${run.value}-done`,
      ]);
      expect(run.timing.phases.every((phase) => phase.durationMs >= 0)).toBe(
        true,
      );
      expect(
        run.timing.phases.reduce((sum, phase) => sum + phase.durationMs, 0),
      ).toBeCloseTo(run.timing.totalMs, 8);
    }
  });

  it("preserves cancellation identity", async () => {
    const abort = new DOMException("cancel", "AbortError");
    await expect(
      measureVerification(async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });
});
