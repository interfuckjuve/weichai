import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRunRecorder, currentRunRecorder, withRunRecorder, type RunRecorder } from "./record-run-events.js";

export interface TimingMark {
  phase: string;
  atMs: number;
}

/** Legacy scopes carry identity and clock origin, never a second collection of observations. */
const timing = new AsyncLocalStorage<{ start: number; operationId: string; recorder: RunRecorder }>();

export function markVerificationPhase(phase: string): void {
  const scope = timing.getStore();
  const recorder = currentRunRecorder() ?? scope?.recorder;
  const current = scope?.recorder === recorder ? scope : undefined;
  recorder?.observe({
    kind: "legacy-phase",
    source: current ? "legacy-measurement:host-performance" : "host-performance",
    name: phase,
    ...(current ? { operationId: current.operationId, offsetMs: performance.now() - current.start } : {}),
  });
}

/**
 * Historical boundary: entry into this wrapper through successful callback return.
 * Legacy offsets use this measurement's clock origin, not the enclosing run's.
 * Adjacent phase labels are not precise stage spans; retain this view for benchmark readers.
 */
export async function measureVerification<T>(run: () => Promise<T>) {
  const start = performance.now();
  const existing = currentRunRecorder();
  const recorder = existing ?? createRunRecorder({ runId: randomUUID() });
  const state = { start, operationId: randomUUID(), recorder };
  return withRunRecorder(recorder, () => timing.run(state, async () => {
    try {
      const value = await run();
      const totalMs = performance.now() - start;
      const marks = recorder.events()
        .filter((event) => event.kind === "legacy-phase" && event.operationId === state.operationId)
        .map((event) => ({ phase: event.name!, atMs: event.offsetMs! }));
      return { value, timing: summarizeTimings(marks, totalMs) };
    } finally {
      if (!existing) recorder.finish();
    }
  }));
}

/** Marks are sequential boundaries, not nested spans; durations sum to totalMs. */
export function summarizeTimings(marks: TimingMark[], totalMs: number) {
  const boundaries = [{ phase: "entry-overhead", atMs: 0 }, ...marks];
  const phases = boundaries.map((mark, index) => {
    const durationMs = (boundaries[index + 1]?.atMs ?? totalMs) - mark.atMs;
    return {
      ...mark,
      durationMs,
      percent: totalMs > 0 ? (durationMs / totalMs) * 100 : 0,
    };
  });
  return { totalMs, phases };
}
