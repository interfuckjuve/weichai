import { readFileSync, statSync } from "node:fs";
import type { CommandEvidence } from "./differential-test-types.js";
import { SmokeVerificationError } from "./smoke-errors.js";

const MAX_EVIDENCE_LINES = 400;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** Missing evidence is empty input; parsed records remain untrusted until validated. */
export function readCommandEvidence(path: string): unknown[] {
  let text: string;
  try {
    if (statSync(path).size > MAX_EVIDENCE_BYTES) {
      throw new SmokeVerificationError(
        "report_evidence_invalid",
        `命令证据超过大小上限(${MAX_EVIDENCE_BYTES} 字节)`,
      );
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    if (error instanceof SmokeVerificationError) throw error;
    throw new SmokeVerificationError(
      "report_evidence_invalid",
      `Cannot read command evidence: ${path}`,
      { cause: error },
    );
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_EVIDENCE_LINES) {
    throw new SmokeVerificationError(
      "report_evidence_invalid",
      `命令证据行数超过上限(${MAX_EVIDENCE_LINES})`,
    );
  }
  return lines.map((line, index) => {
    try {
      const raw: unknown = JSON.parse(line);
      return raw;
    } catch (error) {
      throw new SmokeVerificationError(
        "report_evidence_invalid",
        `命令证据第 ${index + 1} 行不是合法 JSON`,
        { cause: error },
      );
    }
  });
}

export function isCommandEvidence(value: unknown): value is CommandEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.side === "source" || item.side === "target") &&
    (item.phase === "compile" || item.phase === "run") &&
    typeof item.commandId === "string" &&
    item.commandId.trim().length > 0 &&
    typeof item.cwd === "string" &&
    typeof item.command === "string" &&
    typeof item.stdout === "string" &&
    typeof item.stderr === "string" &&
    typeof item.baselineValid === "boolean" &&
    typeof item.timedOut === "boolean" &&
    typeof item.durationMs === "number" &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0 &&
    (item.exitCode === null ||
      (typeof item.exitCode === "number" &&
        Number.isInteger(item.exitCode) &&
        item.exitCode >= 0))
  );
}
