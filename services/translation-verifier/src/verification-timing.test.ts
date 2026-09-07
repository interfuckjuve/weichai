import { describe, expect, it } from "vitest";
import {
  markVerificationPhase,
  measureVerification,
  summarizeTimings,
} from "./verification-timing.js";

describe("verification timing", () => {
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
