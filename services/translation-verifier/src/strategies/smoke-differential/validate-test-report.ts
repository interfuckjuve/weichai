/**
 * smoke 自主会话产出报告(report.json,SmokeReport)的完整运行时深校验。
 *
 * 背景:claude 自主会话可能产出「合法 JSON 但结构不完整/不一致」的报告(空 cases、
 * 重复 caseId、case 内外 ID 不一致、缺双侧 runner、路径逃逸、超限文本、verify-only
 * 下携带目标修复等),若不校验会静默错判或 TypeError 逃逸。assertSmokeReport 在
 * readReport 解析后立即逐字段递归校验,失败抛带 "report schema 校验失败" 前缀的
 * 明确错误，并携带 report_schema_invalid problem code。
 *
 * 仅使用 Node 标准库,不新增 schema 依赖;错误消息约定:<字段路径> <原因>。
 */
import type { VerificationInput } from "../../schemas/verification-types.js";
import { resolveVerificationPolicy } from "../../schemas/verification-assessment.js";
import { SmokeVerificationError } from "./smoke-errors.js";
import type { SmokeReport } from "./differential-test-types.js";

/** 大小/数量上限(防御 agent 超限输出)。 */
const MAX_CASES = 200;
const MAX_TEXT_CHARS = 100_000;
const MAX_ARRAY_ITEMS = 200;
/** TypedValue 嵌套深度上限。 */
const MAX_TYPED_VALUE_DEPTH = 12;

const PREFIX = "report schema 校验失败: ";

const ASSESSMENTS = new Set([
  "bug_found",
  "no_bug_observed",
  "suspected_bug",
  "inconclusive",
  "not_checked",
]);
const SIDES: ReadonlySet<string> = new Set(["source", "target"]);
const LANGUAGES: ReadonlySet<string> = new Set([
  "Java",
  "C#",
  "Python",
  "TypeScript",
]);
const MECHANICALS: ReadonlySet<string> = new Set(["pass", "fail", "divergent"]);
const DECISIONS: ReadonlySet<string> = new Set([
  "pass",
  "translation-bug",
  "accepted-diff",
  "unclear",
]);
const PHASES: ReadonlySet<string> = new Set(["compile", "run"]);
const OUTCOMES: ReadonlySet<string> = new Set(["return", "exception"]);
const TYPED_VALUE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "null",
  "list",
  "map",
]);

/** 统一错误出口:带前缀的明确信息,错误消息含 <path> 便于定位。 */
function fail(path: string, reason: string): never {
  throw new SmokeVerificationError(
    "report_schema_invalid",
    `${PREFIX}${path} ${reason}`,
  );
}

/** 断言值是非 null/非数组的普通对象。 */
function assertRecord(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(path, "应为对象");
  }
  return raw as Record<string, unknown>;
}

type ReportFieldValue = boolean | number | string | unknown[];

/** 断言值存在且类型正确,失败抛带前缀的明确错误(字段级消息,兼容旧断言)。 */
function requireField(
  obj: Record<string, unknown>,
  key: string,
  type: "boolean" | "number" | "string" | "array",
): ReportFieldValue {
  const value = obj[key];
  const ok = type === "array" ? Array.isArray(value) : typeof value === type;
  if (!ok) {
    fail(key, `字段缺失或类型错误(期望 ${type})`);
  }
  return value as ReportFieldValue;
}

/** 断言字符串并返回。 */
function assertString(raw: unknown, path: string): string {
  if (typeof raw !== "string") fail(path, "必须为字符串");
  return raw;
}

/** 断言字符串属于给定枚举。 */
function assertEnum(
  raw: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string {
  const value = assertString(raw, path);
  if (!allowed.has(value)) {
    fail(
      path,
      `非法枚举值 ${JSON.stringify(value)}(允许:${[...allowed].join("|")})`,
    );
  }
  return value;
}

/** 断言非负整数。 */
function assertNonNegativeInteger(raw: unknown, path: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    fail(path, "必须为非负整数");
  }
  return raw;
}

/** 断言文本长度在 MAX_TEXT_CHARS 内。 */
function assertText(raw: unknown, path: string): string {
  const text = assertString(raw, path);
  if (text.length > MAX_TEXT_CHARS) {
    fail(path, `超过大小上限(size 上限 ${MAX_TEXT_CHARS} 字符)`);
  }
  return text;
}

/** 断言相对路径安全:拒绝绝对路径、windows 盘符/UNC、normalize 后逃逸出工作区。 */
function assertSafeRelativePath(raw: string, path: string): void {
  const normalized = raw.replaceAll("\\", "/");
  if (
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    raw.startsWith("\\\\") ||
    normalized === "" ||
    normalized === "."
  ) {
    fail(path, "必须是工作区内相对路径(不允许绝对路径)");
  }
  const parts = normalized.split("/");
  // 归一化折叠 a/../b 属于路径内部书写,最终不得以 .. 开头即可;直接拒绝任何 ".." 片段更严格,
  // 但 a/../b 语义即 b,此处按最终落点判定。
  for (const part of parts) {
    if (part === "..") fail(path, "必须位于工作区内(不允许 .. 逃逸)");
  }
}

/** 断言 RunnerFile 结构(path 安全相对路径 + content 文本)。 */
function assertRunnerFile(raw: unknown, path: string): void {
  const file = assertRecord(raw, path);
  assertSafeRelativePath(
    assertString(requireField(file, "path", "string"), `${path}.path`),
    `${path}.path`,
  );
  assertText(requireField(file, "content", "string"), `${path}.content`);
}

/** 递归校验 TypedValue(报告中的 returnValue/输入值结构)。 */
function assertTypedValue(raw: unknown, path: string, depth = 0): void {
  if (depth > MAX_TYPED_VALUE_DEPTH) fail(path, "嵌套超过深度上限");
  const t = assertRecord(raw, path);
  const type = assertEnum(
    requireField(t, "type", "string"),
    TYPED_VALUE_TYPES,
    `${path}.type`,
  );
  switch (type) {
    case "string":
      assertText(requireField(t, "value", "string"), `${path}.value`);
      return;
    case "number":
      if (typeof t.value !== "number" || !Number.isFinite(t.value))
        fail(`${path}.value`, "必须为有限数值");
      return;
    case "boolean":
      if (typeof t.value !== "boolean") fail(`${path}.value`, "必须为 boolean");
      return;
    case "null":
      if (t.value !== null) fail(`${path}.value`, "必须为 null");
      return;
    case "list": {
      const items = requireField(t, "value", "array") as unknown[];
      if (items.length > MAX_ARRAY_ITEMS)
        fail(`${path}.value`, `条目数超过上限(${MAX_ARRAY_ITEMS})`);
      items.forEach((item, i) =>
        assertTypedValue(item, `${path}.value[${i}]`, depth + 1),
      );
      return;
    }
    case "map": {
      const map = assertRecord(t.value, `${path}.value`);
      for (const [key, value] of Object.entries(map)) {
        assertTypedValue(value, `${path}.value.${key}`, depth + 1);
      }
      return;
    }
  }
}

/** 断言 CaseResult 结构完整,且 caseId 与外层一致。 */
function assertCaseResult(
  raw: unknown,
  path: string,
  outerCaseId: string,
): void {
  const result = assertRecord(raw, path);
  const caseId = assertString(
    requireField(result, "caseId", "string"),
    `${path}.caseId`,
  );
  if (caseId !== outerCaseId) {
    fail(`${path}.caseId`, `与外层 caseId(${outerCaseId}) 不一致`);
  }
  const outcome = assertEnum(
    requireField(result, "outcome", "string"),
    OUTCOMES,
    `${path}.outcome`,
  );
  if (outcome === "return") {
    if (result.returnValue === undefined)
      fail(`${path}.returnValue`, "字段缺失(return 结果必须携带 returnValue)");
    assertTypedValue(result.returnValue, `${path}.returnValue`);
    return;
  }
  assertText(
    requireField(result, "exceptionType", "string"),
    `${path}.exceptionType`,
  );
  if (result.exceptionMessage !== undefined)
    assertText(result.exceptionMessage, `${path}.exceptionMessage`);
}

/** 断言单个 case verdict 结构。 */
function assertCaseVerdict(
  raw: unknown,
  path: string,
  knownIds: Set<string>,
  strict: boolean,
): void {
  const c = assertRecord(raw, path);
  const caseId = assertString(
    requireField(c, "caseId", "string"),
    `${path}.caseId`,
  );
  if (caseId.trim() === "") fail(`${path}.caseId`, "不能为空");
  if (knownIds.has(caseId)) fail("cases", `duplicate caseId: ${caseId}`);
  knownIds.add(caseId);
  assertText(requireField(c, "intent", "string"), `${path}.intent`);
  // source/target 可为 null(该侧未产出结果);非 null 时必须结构完整且 caseId 一致。
  if (c.source !== null && c.source !== undefined)
    assertCaseResult(c.source, `${path}.source`, caseId);
  if (c.target !== null && c.target !== undefined)
    assertCaseResult(c.target, `${path}.target`, caseId);
  assertEnum(
    requireField(c, "mechanical", "string"),
    MECHANICALS,
    `${path}.mechanical`,
  );
  assertEnum(
    requireField(c, "decision", "string"),
    DECISIONS,
    `${path}.decision`,
  );
  assertText(requireField(c, "reasoning", "string"), `${path}.reasoning`);
  if (strict || c.sourceAssessment !== undefined)
    assertEnum(c.sourceAssessment, ASSESSMENTS, `${path}.sourceAssessment`);
  if (strict || c.targetAssessment !== undefined)
    assertEnum(c.targetAssessment, ASSESSMENTS, `${path}.targetAssessment`);
  if (strict || c.requirement !== undefined) {
    const requirement = assertRecord(c.requirement, `${path}.requirement`);
    if (!assertText(requirement.basis, `${path}.requirement.basis`).trim())
      fail(`${path}.requirement.basis`, "cannot be empty");
    assertCaseResult(
      requirement.expected,
      `${path}.requirement.expected`,
      caseId,
    );
    if (requirement.expectedBySide !== undefined) {
      const expectedBySide = assertRecord(
        requirement.expectedBySide,
        `${path}.requirement.expectedBySide`,
      );
      for (const [side, expected] of Object.entries(expectedBySide)) {
        if (!SIDES.has(side))
          fail(`${path}.requirement.expectedBySide`, "unknown side");
        assertCaseResult(
          expected,
          `${path}.requirement.expectedBySide.${side}`,
          caseId,
        );
      }
    }
  }
  if (strict || c.commandIds !== undefined) {
    const ids = assertRecord(c.commandIds, `${path}.commandIds`);
    if (!assertString(ids.target, `${path}.commandIds.target`))
      fail(`${path}.commandIds.target`, "cannot be empty");
    if (ids.source !== undefined)
      assertString(ids.source, `${path}.commandIds.source`);
  }
}

/** 校验可选字段 runnerFiles(存在时须同时含双侧,文件路径不逃逸)。 */
function assertRunnerFiles(
  raw: unknown,
  path: string,
  differential: boolean,
): void {
  const groups = requireField(
    raw as Record<string, unknown>,
    "runnerFiles",
    "array",
  ) as unknown[];
  if (groups.length > MAX_ARRAY_ITEMS)
    fail(path, `条目数超过上限(${MAX_ARRAY_ITEMS})`);
  const sides = new Set<string>();
  groups.forEach((group, i) => {
    const groupPath = `${path}[${i}]`;
    const g = assertRecord(group, groupPath);
    const side = assertEnum(
      requireField(g, "side", "string"),
      SIDES,
      `${groupPath}.side`,
    );
    sides.add(side);
    assertEnum(
      requireField(g, "language", "string"),
      LANGUAGES,
      `${groupPath}.language`,
    );
    const files = requireField(g, "files", "array") as unknown[];
    if (files.length === 0)
      fail(`${groupPath}.files`, "不能为空(runner 组必须携带至少一个文件)");
    if (files.length > MAX_ARRAY_ITEMS)
      fail(`${groupPath}.files`, `条目数超过上限(${MAX_ARRAY_ITEMS})`);
    files.forEach((file, j) =>
      assertRunnerFile(file, `${groupPath}.files[${j}]`),
    );
  });
  if (!sides.has("target") || (differential && !sides.has("source"))) {
    fail(path, "需同时包含 source 与 target 双侧 runner(缺 target 或 source)");
  }
  if (!differential && sides.has("source"))
    fail(path, "target_only forbids source runners");
}

/** 校验可选字段 executions(报告声明的执行证据,与命令证据的匹配在 evaluateSmokeReport)。 */
function assertExecutions(raw: unknown, path: string): void {
  const entries = requireField(
    raw as Record<string, unknown>,
    "executions",
    "array",
  ) as unknown[];
  if (entries.length > MAX_ARRAY_ITEMS)
    fail(path, `条目数超过上限(${MAX_ARRAY_ITEMS})`);
  const commandIds = new Set<string>();
  entries.forEach((entry, i) => {
    const entryPath = `${path}[${i}]`;
    const e = assertRecord(entry, entryPath);
    assertEnum(requireField(e, "side", "string"), SIDES, `${entryPath}.side`);
    assertEnum(
      requireField(e, "phase", "string"),
      PHASES,
      `${entryPath}.phase`,
    );
    const commandId = assertString(
      requireField(e, "commandId", "string"),
      `${entryPath}.commandId`,
    );
    if (commandId === "") fail(`${entryPath}.commandId`, "不能为空");
    if (commandIds.has(commandId))
      fail(path, `duplicate commandId: ${commandId}`);
    commandIds.add(commandId);
    if (e.exitCode !== null)
      assertNonNegativeInteger(e.exitCode, `${entryPath}.exitCode`);
    assertNonNegativeInteger(
      requireField(e, "durationMs", "number"),
      `${entryPath}.durationMs`,
    );
  });
}

/** Deep validation always rejects target implementation repairs. */
export function assertSmokeReport(
  raw: unknown,
  input?: Pick<VerificationInput, "verificationPolicy">,
): asserts raw is SmokeReport {
  const obj = assertRecord(raw, "report 顶层");
  requireField(obj, "converged", "boolean");
  assertNonNegativeInteger(requireField(obj, "steps", "number"), "steps");
  const rounds = assertNonNegativeInteger(
    requireField(obj, "rounds", "number"),
    "rounds",
  );
  if (rounds !== 0) {
    fail("rounds", "在 verify-only 模式下必须为 0(禁止目标修复轮)");
  }
  const cases = requireField(obj, "cases", "array") as unknown[];
  if (cases.length === 0) fail("cases", "不能为空(non-empty)");
  if (cases.length > MAX_CASES) fail("cases", `数量超过上限(${MAX_CASES})`);
  const caseIds = new Set<string>();
  cases.forEach((c, i) =>
    assertCaseVerdict(c, `cases[${i}]`, caseIds, input !== undefined),
  );
  const targetFiles = requireField(obj, "targetFiles", "array") as unknown[];
  if (targetFiles.length !== 0) {
    fail("targetFiles", "在 verify-only 模式下必须为空(禁止修改目标实现)");
  }
  if (targetFiles.length > MAX_ARRAY_ITEMS)
    fail("targetFiles", `条目数超过上限(${MAX_ARRAY_ITEMS})`);
  targetFiles.forEach((file, i) => assertRunnerFile(file, `targetFiles[${i}]`));
  if (input !== undefined && obj.runnerFiles === undefined)
    fail("runnerFiles", "required for executed verification");
  if (obj.runnerFiles !== undefined)
    assertRunnerFiles(
      obj,
      "runnerFiles",
      input === undefined ||
        resolveVerificationPolicy(input).mode === "differential",
    );
  if (obj.executions !== undefined) assertExecutions(obj, "executions");
  const sourceIssues = requireField(obj, "sourceIssues", "array") as unknown[];
  if (sourceIssues.length > MAX_ARRAY_ITEMS)
    fail("sourceIssues", `条目数超过上限(${MAX_ARRAY_ITEMS})`);
  sourceIssues.forEach((issue, i) => assertText(issue, `sourceIssues[${i}]`));
  assertText(requireField(obj, "summary", "string"), "summary");
}
