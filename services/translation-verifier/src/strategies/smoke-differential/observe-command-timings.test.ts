import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunRecorder,
  withRunRecorder,
} from "../../run-output/record-run.js";
import { isCommandEvidence } from "./command-evidence.js";
import { observeCommandTimings } from "./observe-command-timings.js";

const roots: string[] = [];
function evidencePath() {
  const root = mkdtempSync(join(tmpdir(), "command-timings-"));
  roots.push(root);
  return join(root, "commands.jsonl");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const metadata = {
  commandId: "target-run",
  side: "target",
  phase: "run",
  durationMs: 12,
  exitCode: null,
  timedOut: true,
};

describe("non-authoritative command timing observation", () => {
  it("reads only narrow metadata, preserves clock provenance and omits invalid optional timings", async () => {
    const path = evidencePath();
    const entry = {
      ...metadata,
      stdout: "PRIVATE",
      timing: {
        processMs: 5,
        preBaselineMs: 0,
        validationMs: -1,
        postBaselineMs: "1",
        beforeEvidenceAppendMs: null,
      },
    };
    expect(isCommandEvidence(entry)).toBe(false);
    writeFileSync(path, JSON.stringify(entry));
    const recorder = createRunRecorder({ runId: "timing" });
    await withRunRecorder(recorder, async () => observeCommandTimings(path));
    expect(recorder.events()).toMatchObject([
      {
        kind: "command",
        source: "command-proxy:process-date-now",
        name: "target-run",
        durationMs: 12,
        timedOut: true,
      },
      {
        kind: "command-timing",
        source: "command-proxy:child-performance",
        name: "preBaselineMs",
        durationMs: 0,
      },
      {
        kind: "command-timing",
        source: "command-proxy:child-performance",
        name: "processMs",
        durationMs: 5,
      },
    ]);
    expect(recorder.events()[0]).not.toHaveProperty("exitCode");
    expect(recorder.events().every((entry) => !("offsetMs" in entry))).toBe(
      true,
    );
    expect(JSON.stringify(recorder.events())).not.toContain("PRIVATE");
    expect(recorder.snapshot().diagnostics).toEqual([]);
  });
  it.each([
    {},
    null,
    [],
    { ...metadata, durationMs: -1 },
    { ...metadata, commandId: "unsafe/id" },
    { ...metadata, exitCode: 1.5 },
    { ...metadata, timedOut: null },
  ])("omits missing or invalid metadata %# without throwing", async (entry) => {
    const path = evidencePath();
    writeFileSync(path, JSON.stringify(entry));
    const recorder = createRunRecorder({ runId: "invalid" });
    await withRunRecorder(recorder, async () => observeCommandTimings(path));
    expect(recorder.events()).toEqual([]);
    expect(recorder.snapshot().diagnostics).toMatchObject([
      { code: "command-timing-omitted" },
    ]);
  });
  it("keeps unreadable evidence best effort and missing input empty", async () => {
    const path = evidencePath();
    const recorder = createRunRecorder({ runId: "unavailable" });
    await withRunRecorder(recorder, async () => observeCommandTimings(path));
    expect(recorder.snapshot().diagnostics).toEqual([]);
    writeFileSync(path, "{");
    await withRunRecorder(recorder, async () => observeCommandTimings(path));
    expect(recorder.events()).toEqual([]);
    expect(recorder.snapshot().diagnostics).toMatchObject([
      { code: "command-timing-unavailable" },
    ]);
    expect(() => observeCommandTimings(path)).not.toThrow();
  });
  it("retains the existing bounded recorder when repeatedly observed", async () => {
    const path = evidencePath();
    writeFileSync(path, (JSON.stringify(metadata) + "\n").repeat(400));
    const recorder = createRunRecorder({ runId: "bounded" });
    await withRunRecorder(recorder, async () => {
      for (let i = 0; i < 26; i++) observeCommandTimings(path);
    });
    expect(recorder.events()).toHaveLength(10_000);
    expect(recorder.snapshot().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "events-truncated" }),
      ]),
    );
  });
});
