/**
 * 冒烟报告的纯判定策略:把深度校验后的 SmokeReport + verifier-command 命令证据
 * 归一为 pass / fail / unverified。
 *
 * 判定规则(设计 §7.2):
 * - 任何 translation-bug case → fail(唯一触发 Translator 修复的状态);
 * - 存在 unclear case 或执行证据缺失/不一致 → unverified(advisory,不触发修复);
 * - 其余(全 pass / accepted-diff 且证据完整)→ pass。
 *
 * 本模块是宿主侧纯函数:不做 I/O,命令证据来自命令代理日志(不信任模型自述的输出)。
 */
import type { CommandEvidence, SmokeCaseVerdict, SmokeMode, SmokeReport } from "./smoke-types.js";

export interface SmokeEvaluation {
  status: "pass" | "fail" | "unverified";
  reason?: "behavioral-divergence" | "unclear" | "invalid-evidence" | "no-cases";
  /** fail 状态下实际判定为 translation-bug 的 case(修复反馈的输入)。 */
  bugCases: SmokeCaseVerdict[];
  summary: string;
}

/** 构造 unverified(invalid-evidence)结果。 */
function invalidEvidence(summary: string): SmokeEvaluation {
  return { status: "unverified", reason: "invalid-evidence", bugCases: [], summary };
}

/**
 * 判定报告。evidence 中每条 report.executions 声明的 commandId 都必须恰好匹配
 * 一条同 side/phase/exitCode 的证据,且该证据 baselineValid、exitCode===0、
 * timedOut=false;否则证据不可信 → unverified(invalid-evidence)。
 */
export function evaluateSmokeReport(
  report: SmokeReport,
  evidence: readonly CommandEvidence[],
  mode: SmokeMode,
): SmokeEvaluation {
  // 防御:assertSmokeReport 已拒绝空 cases;直接调用本函数时仍给出 no-cases。
  if (report.cases.length === 0) {
    return { status: "unverified", reason: "no-cases", bugCases: [], summary: "报告不包含任何 case" };
  }
  // verify-only 报告不得携带目标修复(rounds>0 / targetFiles 非空),assert 层已抛错,
  // 此处兜底直接调用本函数的路径,避免修复报告被误判为 pass。
  if (mode === "verify-only" && (report.rounds !== 0 || report.targetFiles.length !== 0)) {
    return invalidEvidence("verify-only 报告携带目标修复(rounds>0 或 targetFiles 非空)");
  }
  const executions = report.executions ?? [];
  if (executions.length === 0) {
    return invalidEvidence("报告未声明任何执行证据(executions 为空)");
  }
  for (const [i, claim] of executions.entries()) {
    const matched = evidence.filter((item) => item.commandId === claim.commandId);
    if (matched.length !== 1) {
      return invalidEvidence(`executions[${i}] commandId "${claim.commandId}" 未恰好匹配一条命令证据`);
    }
    const record = matched[0];
    if (record.side !== claim.side || record.phase !== claim.phase || record.exitCode !== claim.exitCode) {
      return invalidEvidence(`commandId "${claim.commandId}" 的 side/phase/exitCode 与命令证据不一致`);
    }
    if (!record.baselineValid || record.timedOut || record.exitCode !== 0) {
      return invalidEvidence(`commandId "${claim.commandId}" 命令证据未通过(基线变更/超时/非零退出)`);
    }
  }
  // 执行证据全部可信后,只按 case 决策判定:translation-bug 优先于 unclear。
  const bugCases = report.cases.filter((item) => item.decision === "translation-bug");
  if (bugCases.length > 0) {
    return {
      status: "fail",
      reason: "behavioral-divergence",
      bugCases,
      summary: `${bugCases.length}/${report.cases.length} 个 case 判定为 translation-bug`,
    };
  }
  const unclearCount = report.cases.filter((item) => item.decision === "unclear").length;
  if (unclearCount > 0) {
    return {
      status: "unverified",
      reason: "unclear",
      bugCases: [],
      summary: `${unclearCount}/${report.cases.length} 个 case 判定为 unclear`,
    };
  }
  return { status: "pass", bugCases: [], summary: report.summary };
}
