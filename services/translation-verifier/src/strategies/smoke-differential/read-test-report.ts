import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SmokeVerificationError } from "./smoke-errors.js";

/** report.json 大小上限(读取前 stat 校验,防止超大/失控 JSON 进入 parse)。 */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * 读 dir/report.json；I/O、JSON 与 schema 错误在发生边界携带稳定 problem code。
 */
export async function readReport<T>(
  dir: string,
  validate?: (raw: unknown) => asserts raw is T,
): Promise<T> {
  const reportPath = join(dir, "report.json");
  let text: string;
  try {
    if (statSync(reportPath).size > MAX_REPORT_BYTES) {
      throw new SmokeVerificationError(
        "report_schema_invalid",
        `报告文件 report.json 超过大小上限(${MAX_REPORT_BYTES} 字节)`,
      );
    }
    text = readFileSync(reportPath, "utf-8");
  } catch (err) {
    if (err instanceof SmokeVerificationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const missing =
      err && typeof err === "object" && "code" in err && err.code === "ENOENT";
    throw new SmokeVerificationError(
      missing ? "report_missing" : "report_schema_invalid",
      `无法读取报告文件 ${reportPath}: ${message}`,
      { cause: err },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SmokeVerificationError(
      "report_invalid_json",
      `报告文件不是合法 JSON ${reportPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (validate) {
    // 断言函数不能经可选参数直接调用(TS2775),经必选参数的内部辅助函数转发。
    applyValidate(raw, validate);
  }
  return raw as T;
}

/**
 * 断言函数不能通过可选参数直接调用(TS2775),经必选参数的内部辅助函数转发。
 */
function applyValidate<T>(
  raw: unknown,
  validate: (value: unknown) => asserts value is T,
): void {
  try {
    validate(raw);
  } catch (error) {
    if (error instanceof SmokeVerificationError) throw error;
    throw new SmokeVerificationError(
      "report_schema_invalid",
      errorSummary(error),
      { cause: error },
    );
  }
}

/** 把任意错误(含 readReport 错误)归一化为可读文本。 */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return String(error);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
