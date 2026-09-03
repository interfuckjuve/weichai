import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 默认日志目录:monorepo 根 logs/(由模块位置解析,不依赖运行 cwd)。 */
export const DEFAULT_LOG_DIR = fileURLToPath(new URL("../../../logs", import.meta.url));

/** 默认文件级别:INFO(content 需要显式打开)。 */
const DEFAULT_FILE_LEVEL = "INFO";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

/** 命名的敏感环境/凭据前缀(键名匹配,值脱敏)。 */
const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /^DEEPSEEK_/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /API[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /CONNECTION_STRING/i,
  /CONNSTR/i,
];

/**
 * 凭据脱敏:替换常见敏感值形态。
 * - `Authorization: Bearer xxx` / `Authorization: Basic <cred>` / 裸 `Authorization: xxx`
 *   (任意认证 scheme 后跟单个凭据 token,整体替换);
 * - `<SENSITIVE_NAME>=<value>` 与 `<SENSITIVE_NAME>: <value>`(覆盖
 *   DEEPSEEK_API_KEY / ANTHROPIC_AUTH_TOKEN / sk-… 等),保留键名供定位。
 */
export function redactSecrets(message: string): string {
  let redacted = message.replace(/(Authorization\s*[:=]\s*)(?:(?:Bearer|Basic|Digest|Token|Plain)\s+)?[^\s,;]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(/((?:DEEPSEEK|ANTHROPIC|OPENAI|AWS)[A-Z0-9_]*|[A-Z0-9_]*?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)(\s*(?:=|:)\s*)\S+/gi, (_all, name: string, separator: string) => `${name}${separator}[REDACTED]`);
  redacted = redacted.replace(/(sk-[A-Za-z0-9_-]{4,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g, "[REDACTED]");
  return redacted;
}

/**
 * 零依赖日志系统(仿 ReCodeAgent src/run.py setup_logging):
 * - 文件:默认 INFO,appendFileSync 单次同步追加到 <logDir>/<fileName>(多行消息一次写完);
 *   写入前若将超过 maxFileBytes 则按 file→file.1→file.2 轮转并只保留 maxFiles 份;
 *   脱敏在文件与控制台输出前统一执行。
 * - content():仅在 contentEnabled 或 VERIFIER_LOG_CONTENT==="1" 时以 DEBUG 记录
 *   (完整 prompt/源码/原始模型输出走该通道,默认关闭)。
 * - 控制台:按 level 过滤(默认 INFO),用注入的 console(测试捕获)或全局 console。
 * - 格式:`2026-08-16T20:00:00.000Z [name] LEVEL 消息`(ISO 时间戳 + 方括号名 + 级别)。
 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  /** 完整内容通道(prompt/源码/原始输出);默认关闭,开启后以 DEBUG 记录。 */
  content(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoggerOptions {
  /** 控制台级别;默认 process.env.VERIFIER_LOG_LEVEL ?? "INFO"。 */
  level?: LogLevel;
  /** 日志目录;默认 process.env.VERIFIER_LOG_DIR ?? monorepo 根 logs/(与 cwd 无关)。 */
  logDir?: string;
  /** 文件级别;默认 "INFO"。 */
  fileLevel?: LogLevel;
  /** 文件名;默认 "translation-verifier.log"。 */
  fileName?: string;
  /** content() 是否记录;默认 false;也接受 VERIFIER_LOG_CONTENT==="1"。 */
  contentEnabled?: boolean;
  /** 轮转阈值(字节);默认 10 MiB。 */
  maxFileBytes?: number;
  /** 轮转保留份数(不含当前文件);默认 3。 */
  maxFiles?: number;
  /** 注入的 console(测试捕获);默认全局 console。 */
  console?: Pick<Console, "info" | "debug" | "warn" | "error">;
  /** 注入的文件写函数(测试计数/捕获);默认 appendFileSync。 */
  writeFile?: (path: string, payload: string) => void;
  /** 完全静默(测试):不写文件也不输出控制台。 */
  disabled?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/** 把任意字符串(如环境变量)校验为 LogLevel;非法时回退默认值。 */
function toLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value !== undefined && value in LEVEL_ORDER) return value as LogLevel;
  return fallback;
}

function contentEnabled(options: LoggerOptions): boolean {
  if (options.contentEnabled !== undefined) return options.contentEnabled;
  return process.env.VERIFIER_LOG_CONTENT === "1";
}

/**
 * 追加前轮转:当前文件将超过 maxFileBytes 时,file→file.1→…→file.maxFiles 顺移,
 * 超出 maxFiles 的旧档删除,再写当前文件。目录已由 emit 保证存在。
 */
function rotateIfNeeded(
  filePath: string,
  incomingBytes: number,
  maxFileBytes: number,
  maxFiles: number,
): void {
  if (maxFiles <= 0) return;
  try {
    if (statSync(filePath).size + incomingBytes <= maxFileBytes) return;
  } catch {
    return; // 文件尚不存在,无需轮转
  }
  // 删除最旧档,依次后移 file.N-1 → file.N。
  const oldest = `${filePath}.${maxFiles}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const to = `${filePath}.${index}`;
    if (existsSync(from)) renameSync(from, to);
  }
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const level: LogLevel = toLogLevel(options.level ?? process.env.VERIFIER_LOG_LEVEL, "INFO");
  const logDir = options.logDir ?? process.env.VERIFIER_LOG_DIR ?? DEFAULT_LOG_DIR;
  const fileLevel: LogLevel = toLogLevel(options.fileLevel, DEFAULT_FILE_LEVEL);
  const fileName = options.fileName ?? "translation-verifier.log";
  const consoleApi = options.console ?? console;
  const append = options.writeFile ?? appendFileSync;
  const contentOn = contentEnabled(options);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const consoleThreshold = LEVEL_ORDER[level];
  const fileThreshold = LEVEL_ORDER[fileLevel];
  const filePath = join(logDir, fileName);

  const emit = (messageLevel: LogLevel, message: string, forceContent: boolean): void => {
    if (options.disabled) return;
    if (forceContent && !contentOn) return;
    const safe = redactSecrets(message);
    // 多行消息每行都带前缀(便于回放 prompt/输出全文),整体一次写入。
    const prefix = `${new Date().toISOString()} [${name}] ${messageLevel}`;
    const lines = safe.split("\n").map((l) => `${prefix} ${l}`);
    const payload = `${lines.join("\n")}\n`;
    const levelIndex = LEVEL_ORDER[messageLevel];

    // 文件:按 fileLevel 过滤,同步单次追加;logDir 不存在时递归创建。
    // content 显式开启时无视默认 INFO 文件阈值,仍以 DEBUG 落到文件。
    if (forceContent || levelIndex >= fileThreshold) {
      mkdirSync(logDir, { recursive: true });
      rotateIfNeeded(filePath, payload.length, maxFileBytes, maxFiles);
      append(filePath, payload);
    }

    // 控制台:按 level 过滤,对应方法输出(每行一次)。
    if (levelIndex >= consoleThreshold) {
      const method = consoleApi[messageLevel.toLowerCase() as "info" | "debug" | "warn" | "error"];
      for (const l of lines) method(l);
    }
  };

  return {
    info: (msg: string) => emit("INFO", msg, false),
    debug: (msg: string) => emit("DEBUG", msg, false),
    content: (msg: string) => emit("DEBUG", msg, true),
    warn: (msg: string) => emit("WARN", msg, false),
    error: (msg: string) => emit("ERROR", msg, false),
  };
}
