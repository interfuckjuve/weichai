import { readFileSync, statSync } from "node:fs";
import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { currentRunRecorder } from "../run-output/record-run.js";
import { evaluateSmokeReport } from "../strategies/decide-test-verdict.js";
import { assertWorkspaceBaseline } from "../strategies/protect-project-files.js";
import { readReport, errorSummary } from "../strategies/read-test-report.js";
import { assertSmokeReport } from "../strategies/validate-test-report.js";
import type { CommandEvidence, SmokeMode, SmokeReport } from "../strategies/differential-test-types.js";
import type { SmokeResult, SmokeStatus } from "../strategies/run-smoke-verification.js";
import type { RunLayout } from "../strategies/prepare-smoke-projects.js";

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

export type SmokeOutcome = Pick<SmokeResult, "status" | "summary" | "report"> &
  Partial<Pick<SmokeResult, "passRate" | "evaluation" | "errorReason">>;

export async function evaluateEvidence(
  layout: RunLayout,
  mode: SmokeMode,
): Promise<SmokeOutcome> {
  const recorder = currentRunRecorder();
  const stages = recorder?.snapshot().stages;
  const observed = stages?.[3].state === "completed" && stages[4].state === "not-started";
  if (observed) recorder!.startStage("evaluate-evidence");
  let report: SmokeReport;
  try {
    markVerificationPhase("report-read-and-schema-validation");
    report = await readReport<SmokeReport>(layout.agentDir, (raw) =>
      assertSmokeReport(raw, mode),
    );
  } catch (error) {
    if (observed) recorder!.endStage("evaluate-evidence", "failed", error);
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
    if (observed) recorder!.endStage("evaluate-evidence", "completed");
    return {
      status,
      passRate,
      summary: evaluation.summary,
      report,
      evaluation,
    };
  } catch (error) {
    if (observed) recorder!.endStage("evaluate-evidence", "failed", error);
    // 基线/证据失败(含 evaluateSmokeReport 内部不变量)归 invalid-evidence。
    return {
      status: "error",
      summary: errorSummary(error),
      report,
      errorReason: "invalid-evidence",
    };
  }
}
