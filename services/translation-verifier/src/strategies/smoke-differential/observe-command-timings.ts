import { currentRunRecorder } from "../../run-output/record-run.js";
import { readCommandEvidence } from "./command-evidence.js";

/** Diagnostic metadata only; this observer never attests authoritative evidence. */
export function observeCommandTimings(path: string): void {
  const recorder = currentRunRecorder();
  if (!recorder) return;
  try {
    for (const raw of readCommandEvidence(path)) {
      const entry =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      if (
        (entry.side !== "source" && entry.side !== "target") ||
        (entry.phase !== "compile" && entry.phase !== "run") ||
        typeof entry.commandId !== "string" ||
        !/^[a-zA-Z0-9-]{1,256}$/.test(entry.commandId) ||
        typeof entry.durationMs !== "number" ||
        !Number.isFinite(entry.durationMs) ||
        entry.durationMs < 0 ||
        (entry.exitCode !== null &&
          (typeof entry.exitCode !== "number" ||
            !Number.isInteger(entry.exitCode) ||
            entry.exitCode < 0)) ||
        typeof entry.timedOut !== "boolean"
      ) {
        recorder.anomaly(
          "command-timing-omitted",
          "Invalid command metadata omitted; evidence validation is unchanged.",
        );
        continue;
      }
      recorder.observe({
        kind: "command",
        source: "command-proxy:process-date-now",
        name: `${entry.side}-${entry.phase}`,
        commandId: entry.commandId,
        durationMs: entry.durationMs,
        ...(entry.exitCode === null ? {} : { exitCode: entry.exitCode }),
        timedOut: entry.timedOut,
      });
      const timing =
        entry.timing &&
        typeof entry.timing === "object" &&
        !Array.isArray(entry.timing)
          ? (entry.timing as Record<string, unknown>)
          : undefined;
      for (const name of [
        "validationMs",
        "preBaselineMs",
        "processMs",
        "postBaselineMs",
        "beforeEvidenceAppendMs",
      ]) {
        const durationMs = timing?.[name];
        if (
          typeof durationMs === "number" &&
          Number.isFinite(durationMs) &&
          durationMs >= 0
        ) {
          recorder.observe({
            kind: "command-timing",
            source: "command-proxy:child-performance",
            name,
            commandId: entry.commandId,
            durationMs,
          });
        }
      }
    }
  } catch {
    recorder.anomaly(
      "command-timing-unavailable",
      "Command timing metadata could not be read; evidence validation is unchanged.",
    );
  }
}
