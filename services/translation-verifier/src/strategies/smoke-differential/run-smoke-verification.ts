/** Runs one verification-only Agent session in a caller-prepared workspace. */
import {
  failureAssessment,
  resolveVerificationPolicy,
} from "../../schemas/verification-assessment.js";
import type {
  VerificationAssessment,
  VerificationProblem,
} from "../../schemas/verification-types.js";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { measureStep } from "../../run-output/record-run.js";
import { createLogger } from "../../run-output/verification-logger.js";
import type { EffortLevel, SpawnClaude } from "./claude-session.js";
import type {
  SmokeCaseVerdict,
  SmokeReport,
} from "./differential-test-types.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";
import { errorSummary } from "./read-test-report.js";
import { prepareAgentTask } from "./build-test-task.js";
import type { RunLayout } from "./prepare-projects.js";
import { runAgentTests } from "./run-agent-session.js";
import { evaluateEvidence } from "./evaluate-evidence.js";
import { observeCommandTimings } from "./observe-command-timings.js";
import { isAbortError, SmokeVerificationError } from "./smoke-errors.js";

export interface SmokeRunOptions {
  layout: RunLayout;
  deadlineAt: number;
  /** 自主会话轮次上限;默认 50。 */
  maxTurns?: number;
  /** DeepSeek API Key;默认 process.env.DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 模型;默认 process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"。 */
  model?: string;
  /** 会话思考投入;默认 "low"。 */
  effort?: EffortLevel;
  /** 注入的 spawn 实现(测试=捕获参数断言;缺省=child_process.spawn 封装)。 */
  spawnClaude?: SpawnClaude;
}

export interface SmokeResult extends VerificationAssessment {
  /** cases 机械 pass 占比;cases 为空时缺省。 */
  passRate?: number;
  summary: string;
  durationMs: number;
  /** 校验/评估成功后 report.json 解析出的 SmokeReport。 */
  report: SmokeReport | null;
  /** Target bug cases validated against independent expectations and command evidence. */
  bugCases?: SmokeCaseVerdict[];
}

/**
 * 运行一次 smoke 差分验证(verify-only 生产路径)。
 * Exceptions become execution problems; validated partial findings survive interruption.
 */
export async function runSmoke(
  job: SmokeTaskInput,
  options: SmokeRunOptions,
  signal?: AbortSignal,
): Promise<SmokeResult> {
  markVerificationPhase("smoke-layout-and-options");
  const started = performance.now();
  const logger = createLogger("smoke-runner");
  const layout = options.layout;

  const finish = (
    partial: VerificationAssessment &
      Pick<SmokeResult, "summary" | "report"> &
      Partial<Pick<SmokeResult, "passRate" | "bugCases">>,
  ): SmokeResult => {
    const result: SmokeResult = {
      ...partial,
      durationMs: performance.now() - started,
    };
    logger.info(
      `smoke verify-only finished: execution=${result.executionStatus} source=${result.sourceAssessment} target=${result.targetAssessment} durationMs=${Math.round(result.durationMs)}ms summary=${truncateForLog(result.summary, 200)}`,
    );
    return result;
  };

  try {
    signal?.throwIfAborted();
    if (!resolveVerificationPolicy(job).testBasis?.trim()) {
      const summary = "Independent Host-confirmed test basis is missing.";
      return finish({
        ...failureAssessment(job, "insufficient_test_basis", summary),
        summary,
        report: null,
      });
    }
    const prepared = await measureStep("build-test-task", () =>
      prepareAgentTask(job, options, signal),
    );
    signal?.throwIfAborted();
    await runAgentTests(prepared);
    return finish(await evaluateEvidence(prepared.layout, job));
  } catch (error) {
    const runError = signal?.aborted ? signal.reason : error;
    const summary = errorSummary(runError);
    const timedOut =
      typeof runError === "object" &&
      runError !== null &&
      "name" in runError &&
      runError.name === "TimeoutError";
    const code: VerificationProblem["code"] = timedOut
      ? "agent_timeout"
      : signal?.aborted || isAbortError(runError)
        ? "cancelled"
        : runError instanceof SmokeVerificationError
          ? runError.code
          : "internal_error";
    if (
      layout &&
      (code === "agent_timeout" ||
        code === "cancelled" ||
        code === "agent_error")
    ) {
      const recovered = await evaluateEvidence(layout, job);
      if (
        recovered.executionStatus === "completed" ||
        recovered.executionStatus === "partial"
      ) {
        const assessment: VerificationAssessment = {
          ...recovered,
          executionStatus: code === "cancelled" ? "cancelled" : "partial",
          problems: [...recovered.problems, { code, message: summary }],
        };
        return finish({
          ...recovered,
          ...assessment,
          summary,
        });
      }
      return finish({
        ...recovered,
        executionStatus: code === "cancelled" ? "cancelled" : "failed",
        problems: [...recovered.problems, { code, message: summary }],
        summary,
      });
    }
    return finish({
      ...failureAssessment(job, code, summary),
      summary,
      report: null,
    });
  } finally {
    if (layout) observeCommandTimings(layout.evidencePath);
  }
}

function truncateForLog(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
