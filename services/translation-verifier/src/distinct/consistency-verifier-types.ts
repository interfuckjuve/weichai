/**
 * 方向 2(DISTINCT)验证闭环的类型契约(Task 4 从一致性验证编排模块中剪裁保留)。
 *
 * runConsistencyVerification 编排函数随 Task 4 删除,ConsistencyResult 类型仍被
 * strategies/types.ts(detail 联合)与 distinct runner 消费,故独立成文件。
 */
import type { ConsistencyReport } from "./analyzer.js";
import type { VerificationReport } from "../verifier.js";

export interface ConsistencyResult {
  report: VerificationReport;
  consistency: ConsistencyReport;
  /** 是否发生了 augmentation 并入后的重验(有界,默认 1 轮)。 */
  augmented: boolean;
}
