import { readFileSync, statSync } from "node:fs";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { currentRunRecorder } from "../../run-output/record-run.js";
import { evaluateSmokeReport } from "./decide-test-verdict.js";
import { assertWorkspaceBaseline } from "./protect-project-files.js";
import { readReport, errorSummary } from "./read-test-report.js";
import { assertSmokeReport } from "./validate-test-report.js";
import type { CommandEvidence, SmokeMode, SmokeReport } from "./differential-test-types.js";
import type { SmokeResult, SmokeStatus } from "./run-smoke-verification.js";
import type { RunLayout } from "./prepare-projects.js";

const MAX_EVIDENCE_LINES = 400;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** 有界读取命令证据 JSONL:缺失=空数组;超限/坏行抛错(调用方归 invalid-evidence)。 */
export function readCommandEvidence(path: string): CommandEvidence[] {
  let text: string;
  try {
    if (statSync(path).size > MAX_EVIDENCE_BYTES) {
      throw new Error(`命令证据超过大小上限(${MAX_EVIDENCE_BYTES} 字节)`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) return [];
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_EVIDENCE_LINES) {
    throw new Error(`命令证据行数超过上限(${MAX_EVIDENCE_LINES})`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as CommandEvidence;
    } catch {
      throw new Error(`命令证据第 ${index + 1} 行不是合法 JSON`);
    }
  });
}

/** Diagnostic copy only; never substitutes for baseline/report/evidence validation. */
export function observeCommandTimings(path: string): void {
  const recorder = currentRunRecorder();
  if (!recorder) return;
  try {
    const evidence = readCommandEvidence(path);
    for (const entry of evidence) {
      if (!entry || typeof entry !== "object" ||
          !["source", "target"].includes(entry.side) || !["compile", "run"].includes(entry.phase) ||
          typeof entry.commandId !== "string" || !/^[a-zA-Z0-9-]{1,256}$/.test(entry.commandId) ||
          !Number.isFinite(entry.durationMs) || entry.durationMs < 0 ||
          (entry.exitCode !== null && (!Number.isInteger(entry.exitCode) || entry.exitCode < 0)) || typeof entry.timedOut !== "boolean") {
        recorder.anomaly("command-timing-omitted", "Invalid command metadata omitted; evidence validation is unchanged.");
        continue;
      }
      recorder.observe({ kind: "command", source: "command-proxy:process-date-now", name: `${entry.side}-${entry.phase}`,
        commandId: entry.commandId, durationMs: entry.durationMs, ...(entry.exitCode === null ? {} : { exitCode: entry.exitCode }), timedOut: entry.timedOut });
      const timing = (entry as unknown as { timing?: Record<string, unknown> }).timing;
      for (const name of ["validationMs", "preBaselineMs", "processMs", "postBaselineMs", "beforeEvidenceAppendMs"]) {
        const durationMs = timing?.[name];
        if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
          recorder.observe({ kind: "command-timing", source: "command-proxy:child-performance", name, commandId: entry.commandId, durationMs });
        }
      }
    }
  } catch {
    recorder.anomaly("command-timing-unavailable", "Command timing metadata could not be read; evidence validation is unchanged.");
  }
}

export type SmokeOutcome = Pick<SmokeResult, "status" | "summary" | "report"> &
  Partial<Pick<SmokeResult, "passRate" | "evaluation" | "errorReason">>;

export async function evaluateEvidence(
  layout: RunLayout,
  mode: SmokeMode,
): Promise<SmokeOutcome> {
  const recorder = currentRunRecorder();
  const handle = recorder?.startStep("evaluate-evidence", { scope: "strategy" });
  let report: SmokeReport;
  try {
    markVerificationPhase("report-read-and-schema-validation");
    report = await readReport<SmokeReport>(layout.agentDir, (raw) =>
      assertSmokeReport(raw, mode),
    );
  } catch (error) {
    recorder?.endStep(handle, "failed", error);
    return {
      status: "error",
      summary: errorSummary(error),
      report: {} as SmokeReport,
      errorReason: "invalid-report",
    };
  }
  try {
    // 会话结束后复查基线:受保护文件被改/影子源码出现在 runner 区外即不可信。
    markVerificationPhase("final-baseline-validation");
    assertWorkspaceBaseline(layout.executionRoot, layout.baselinePath);
    markVerificationPhase("command-evidence-read");
    const evidence = readCommandEvidence(layout.evidencePath);
    markVerificationPhase("evidence-evaluation-and-smoke-result");
    const evaluation = evaluateSmokeReport(report, evidence, mode);
    const status: SmokeStatus =
      evaluation.status === "pass"
        ? "pass"
        : evaluation.status === "fail"
          ? "fail"
          : "error";
    const passRate =
      report.cases.length === 0
        ? undefined
        : report.cases.filter((item) => item.mechanical === "pass").length /
          report.cases.length;
    recorder?.endStep(handle, "completed");
    return {
      status,
      passRate,
      summary: evaluation.summary,
      report,
      evaluation,
    };
  } catch (error) {
    recorder?.endStep(handle, "failed", error);
    // 基线/证据失败(含 evaluateSmokeReport 内部不变量)归 invalid-evidence。
    return {
      status: "error",
      summary: errorSummary(error),
      report,
      errorReason: "invalid-evidence",
    };
  }
}
