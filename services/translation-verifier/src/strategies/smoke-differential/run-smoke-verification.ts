/**
 * 「冒烟差分验证」runner:单次 claude 自主会话(print 模式黑盒),
 * 读写全部分布在请求级验证工作区内,编译/运行只经受控命令代理
 * (verifier-command)执行,宿主侧按命令证据(commands.jsonl)裁决。
 *
 * 生产(verify-only)工作区由调用方准备并持有:
 * - workspaceDir(claude cwd/agent 目录)/executionRoot/baselinePath/
 *   commandEvidencePath/runnerRoots 必须作为一套完整路径提供;
 * - 项目根只读,Bash 只允许精确的 verifier-command 形态;
 * - 会话结束后宿主:复查基线 → 读 report.json(verify-only 深校验)→ 读有界
 *   command evidence -> independent execution and side assessments.
 * - Interrupted sessions retain validated partial findings; execution problems are
 *   classified separately in problems and errorReason.
 * 兼容路径(无 workspaceDir):把旧 root/files 双侧输入内部暂存为 source/project +
 * target/project + 双侧 runner 根 + agent 目录并创建基线,同样只经命令代理。
 */
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
import { defaultWorkspaceRoot } from "./test-execution-config.js";
import {
  createWorkspace,
  type WorkspaceHandle,
} from "./create-smoke-workspace.js";
import type { EffortLevel, SpawnClaude } from "./claude-session.js";
import type {
  SmokeCaseVerdict,
  SmokeMode,
  SmokeReport,
} from "./differential-test-types.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";
import { errorSummary } from "./read-test-report.js";
import { prepareAgentTask } from "./build-test-task.js";
import { prepareSmokeProjects, type RunLayout } from "./prepare-projects.js";
import { runAgentTests } from "./run-agent-session.js";
import {
  evaluateEvidence,
  observeCommandTimings,
} from "./evaluate-evidence.js";
export { readCommandEvidence } from "./evaluate-evidence.js";

/**
 * error 状态的细分原因(供生产 adapter 映射 advisory unverified):
 * 报告读/深校验失败 invalid-report;证据/基线失败 invalid-evidence;
 * 会话 deadline 到期 timeout;claude/进程环境失败 toolchain;其余 internal。
 */
export type SmokeErrorReason =
  | "invalid-report"
  | "invalid-evidence"
  | "timeout"
  | "toolchain"
  | "internal";

export interface SmokeRunOptions {
  /** 会话模式;默认 "verify-only"(生产)。diagnostic-repair 仅显式诊断 E2E。 */
  mode?: SmokeMode;
  /** 调用方持有的 agent 目录(claude cwd)。提供后本模块不创建/清理工作区。 */
  workspaceDir?: string;
  /** source/target/agent 公共执行根(验证工作区根)。 */
  executionRoot?: string;
  /** 基线文件(baseline.json)。 */
  baselinePath?: string;
  /** 命令证据文件(commands.jsonl,agent 目录内)。 */
  commandEvidencePath?: string;
  /** 双侧专用 runner 根(相对 executionRoot)。 */
  runnerRoots?: readonly [string, string];
  /** 兼容:内部暂存路径下保留工作目录(含 report/命令证据/runner 源码)。 */
  keepGeneratedTests?: boolean;
  /** 兼容:内部暂存工作区的父根;默认 <packageRoot>/test-results。 */
  workspaceRoot?: string;
  /** 自主会话轮次上限;默认 50。 */
  maxTurns?: number;
  /** DeepSeek API Key;默认 process.env.DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 模型;默认 process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"。 */
  model?: string;
  /** 单次 claude 会话超时;默认 300_000(自主会话分钟级)。 */
  timeoutMs?: number;
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
  generatedTestsKept: boolean;
  /** keepGeneratedTests=true(且内部暂存)时保留的工作目录路径。 */
  keptDir?: string;
  /** 校验/评估成功后 report.json 解析出的 SmokeReport。 */
  report: SmokeReport | null;
  /** Target bug cases validated against independent expectations and command evidence. */
  bugCases?: SmokeCaseVerdict[];
  /** Execution/report failure classification. */
  errorReason?: SmokeErrorReason;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** 硬失败分类(报告/证据类错误在调用点已精确归类,此处兜底运行层失败)。 */
function classifyRunError(error: unknown): SmokeErrorReason {
  const message = errorSummary(error);
  if (/^runSmoke[\s:：]/.test(message)) return "internal"; // 调用契约/暂存失败
  if (/timed out|deadline|超时/i.test(message)) return "timeout";
  if (/claude subprocess|DEEPSEEK_API_KEY|spawn/i.test(message))
    return "toolchain";
  if (/报告|report|证据|evidence|baseline|commands\.jsonl/i.test(message))
    return "invalid-evidence";
  return "internal";
}

/**
 * 运行一次 smoke 差分验证(verify-only 生产路径)。
 * Exceptions become execution problems; validated partial findings survive interruption.
 */
export async function runSmoke(
  job: SmokeTaskInput,
  options: SmokeRunOptions = {},
  signal?: AbortSignal,
): Promise<SmokeResult> {
  markVerificationPhase("smoke-layout-and-options");
  const started = performance.now();
  const mode = options.mode ?? "verify-only";
  const keep = options.keepGeneratedTests ?? false;
  const logger = createLogger("smoke-runner");
  let ws: WorkspaceHandle | null = null;
  let layout: RunLayout | undefined;

  const finish = (
    partial: VerificationAssessment &
      Pick<SmokeResult, "summary" | "report"> &
      Partial<Pick<SmokeResult, "passRate" | "bugCases" | "errorReason">>,
  ): SmokeResult => {
    const result: SmokeResult = {
      ...partial,
      durationMs: performance.now() - started,
      generatedTestsKept: keep,
      keptDir: ws !== null && keep ? ws.dir : undefined,
    };
    logger.info(
      `smoke ${mode} finished: execution=${result.executionStatus} source=${result.sourceAssessment} target=${result.targetAssessment} durationMs=${Math.round(result.durationMs)}ms summary=${truncateForLog(result.summary, 200)}`,
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
    layout = await measureStep("prepare-smoke-layout", () => {
      if (options.workspaceDir === undefined)
        ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot());
      return prepareSmokeProjects(job, options, ws);
    });
    const preparedLayout = layout;
    const prepared = await measureStep("build-test-task", () =>
      prepareAgentTask(job, options, preparedLayout, signal),
    );
    await runAgentTests(prepared);
    return finish(await evaluateEvidence(prepared.layout, mode, job));
  } catch (error) {
    const runError = signal?.aborted ? signal.reason : error;
    const summary = errorSummary(runError);
    const timedOut =
      typeof runError === "object" &&
      runError !== null &&
      "name" in runError &&
      runError.name === "TimeoutError";
    const legacyReason = timedOut ? "timeout" : classifyRunError(runError);
    const code: VerificationProblem["code"] = timedOut
      ? "agent_timeout"
      : signal?.aborted || isAbortError(error)
        ? "cancelled"
        : legacyReason === "timeout"
          ? "agent_timeout"
          : legacyReason === "toolchain"
            ? "agent_error"
            : legacyReason === "invalid-evidence"
              ? "report_evidence_invalid"
              : "internal_error";
    if (
      layout &&
      (code === "agent_timeout" ||
        code === "cancelled" ||
        code === "agent_error")
    ) {
      const recovered = await evaluateEvidence(layout, mode, job);
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
          errorReason: legacyReason,
        });
      }
      return finish({
        ...recovered,
        executionStatus: code === "cancelled" ? "cancelled" : "failed",
        problems: [...recovered.problems, { code, message: summary }],
        summary,
        errorReason: legacyReason,
      });
    }
    return finish({
      ...failureAssessment(job, code, summary),
      summary,
      report: null,
      errorReason: legacyReason,
    });
  } finally {
    if (layout) observeCommandTimings(layout.evidencePath);
    // 内部暂存工作区按 keep 策略清理;caller-owned(workspaceDir)永不清理。
    await measureStep("cleanup-smoke-workspace", () => {
      if (ws !== null && !keep) ws.cleanup();
    });
  }
}

function truncateForLog(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}
