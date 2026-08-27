import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 读 dir/report.json,缺失/非法 JSON 抛带上下文的错误;可传校验函数(解析后校验)。
 */
export async function readReport<T>(
  dir: string,
  validate?: (raw: unknown) => asserts raw is T,
): Promise<T> {
  const reportPath = join(dir, "report.json");
  let text: string;
  try {
    text = readFileSync(reportPath, "utf-8");
  } catch (err) {
    throw new Error(`无法读取报告文件 ${reportPath}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`报告文件不是合法 JSON ${reportPath}: ${(err as Error).message}`);
  }
  if (validate) {
    applyValidate(raw, validate);
  }
  return raw as T;
}

/**
 * 断言函数不能通过可选参数直接调用(TS2775),经必选参数的内部辅助函数转发。
 */
function applyValidate<T>(raw: unknown, validate: (value: unknown) => asserts value is T): void {
  validate(raw);
}

/** 把任意错误(含 readReport 错误)归一化为 { status: "error", summary } 中的 summary 文本。 */
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
