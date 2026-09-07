import { AsyncLocalStorage } from "node:async_hooks";

export interface TimingMark {
  phase: string;
  atMs: number;
}

/** Opt-in, request-local observations. No report or verification contract changes. */
const timing = new AsyncLocalStorage<{ start: number; marks: TimingMark[] }>();

export function markVerificationPhase(phase: string): void {
  const current = timing.getStore();
  if (current)
    current.marks.push({ phase, atMs: performance.now() - current.start });
}

export async function measureVerification<T>(run: () => Promise<T>) {
  const state = { start: performance.now(), marks: [] as TimingMark[] };
  return timing.run(state, async () => {
    const value = await run();
    return {
      value,
      timing: summarizeTimings(state.marks, performance.now() - state.start),
    };
  });
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
