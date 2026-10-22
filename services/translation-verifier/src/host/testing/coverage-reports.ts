import { XMLParser, XMLValidator } from "fast-xml-parser";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { TargetFunctionCoverage, VerificationFunction, VerificationTestCase } from "../../types.js";
import type { TestSummary } from "../tools/common.js";

function fileIdentity(root: string, path: string): string {
  const absolute = resolve(root, path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function counter(value: unknown): number {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid report counter.");
  return n;
}
export function percent(hits: readonly number[]): number | null {
  return hits.length === 0 ? null : Math.round(hits.filter(n => n > 0).length / hits.length * 10_000) / 100;
}
export function xmlReport(xml: string): any {
  if (Buffer.byteLength(xml) > 16_000_000 || XMLValidator.validate(xml) !== true) throw new Error("Invalid XML report.");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, processEntities: false,
    isArray: name => ["testsuite", "testcase", "class", "method", "line", "condition", "source", "package", "counter"].includes(name),
  }).parse(xml);
}
export function jsonReport(json: string): any {
  if (Buffer.byteLength(json) > 16_000_000) throw new Error("Report exceeds the size limit.");
  return JSON.parse(json);
}
export function summary(total: unknown, failed: unknown, skipped: unknown): TestSummary {
  const t = counter(total), f = counter(failed), s = counter(skipped);
  if (f + s > t) throw new Error("Inconsistent test counts.");
  return { executed: t - s, passed: t - s - f, failed: f, skipped: s };
}
export function parseJUnit(xml: string): TestSummary {
  const report = xmlReport(xml);
  const suites = report.testsuite ?? report.testsuites?.testsuite ?? [];
  const result = { executed: 0, passed: 0, failed: 0, skipped: 0 };
  const visit = (suite: any) => {
    if (suite.testsuite?.length) { suite.testsuite.forEach(visit); return; }
    const parsed = summary(suite.tests, counter(suite.failures ?? "0") + counter(suite.errors ?? "0"), suite.skipped ?? "0");
    for (const key of ["executed", "passed", "failed", "skipped"] as const) result[key] += parsed[key];
  };
  if (suites.length === 0) throw new Error("Missing test suites.");
  suites.forEach(visit);
  return result;
}
export function parseNodeTests(json: string): TestSummary {
  const report = jsonReport(json);
  return summary(report.numTotalTests, report.numFailedTests, counter(report.numPendingTests ?? 0) + counter(report.numTodoTests ?? 0));
}

export function parseExecutionErrors(format: "junit" | "node" | "trx", content: string): number {
  if (format === "node") {
    const report = jsonReport(content);
    const files = report.testResults ?? [];
    const errors = files.filter((file: any) => file.testExecError ||
      (file.status === "failed" && !(file.assertionResults?.length))).length;
    return Math.max(counter(report.numRuntimeErrorTestSuites ?? 0), errors);
  }
  const report = xmlReport(content);
  if (format === "trx") {
    const counters = report.TestRun?.ResultSummary?.Counters;
    return ["error", "timeout", "aborted", "notRunnable"].reduce((total, key) => total + counter(counters?.[key] ?? 0), 0);
  }
  const visit = (suite: any): number => {
    const children: any[] = suite.testsuite ?? [];
    const cases = (suite.testcase ?? []).filter((test: any) => test.error !== undefined).length;
    return Math.max(counter(suite.errors ?? 0), cases + children.reduce((total, child) => total + visit(child), 0));
  };
  return (report.testsuite ?? report.testsuites?.testsuite ?? []).reduce((total: number, suite: any) => total + visit(suite), 0);
}

function reportMessage(value: any): string | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => typeof item === "string" ? item : [item.message, item["#text"]].filter(Boolean).join("\n")).filter(Boolean).join("\n").slice(0, 8000) || undefined;
}

export function parseJUnitTestCases(xml: string): VerificationTestCase[] {
  const report = xmlReport(xml);
  const result: VerificationTestCase[] = [];
  const visit = (suite: any) => {
    for (const test of suite.testcase ?? []) {
      if (typeof test.name !== "string") continue;
      const failed = test.failure !== undefined || test.error !== undefined;
      const message = reportMessage(test.failure ?? test.error);
      result.push({ id: `${test.classname ?? suite.name ?? ""}#${test.name}`,
        status: failed ? "failed" : test.skipped !== undefined ? "skipped" : "passed", ...(message ? { message } : {}) });
    }
    for (const child of suite.testsuite ?? []) visit(child);
  };
  for (const suite of report.testsuite ?? report.testsuites?.testsuite ?? []) visit(suite);
  return result;
}

export function parseNodeTestCases(json: string): VerificationTestCase[] {
  return (jsonReport(json).testResults ?? []).flatMap((file: any) => (file.assertionResults ?? []).flatMap((test: any) => {
    const name = test.fullName ?? test.title;
    if (typeof name !== "string") return [];
    const status = test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped";
    const message = reportMessage(test.failureMessages);
    return [{ id: `${file.name ?? ""}#${name}`, status, ...(message ? { message } : {}) }];
  }));
}

export function parseTrxTestCases(xml: string): VerificationTestCase[] {
  const report = xmlReport(xml).TestRun;
  const definitions = report?.TestDefinitions?.UnitTest;
  const units = Array.isArray(definitions) ? definitions : definitions ? [definitions] : [];
  const results = report?.Results?.UnitTestResult;
  return (Array.isArray(results) ? results : results ? [results] : []).flatMap((test: any) => {
    if (typeof test.testName !== "string") return [];
    const unit = units.find((item: any) => item.id === test.testId);
    const message = reportMessage(test.Output?.ErrorInfo?.Message);
    return [{ id: `${unit?.TestMethod?.className ?? ""}#${test.testName}`,
      status: test.outcome === "Passed" ? "passed" : test.outcome === "NotExecuted" ? "skipped" : "failed", ...(message ? { message } : {}) }];
  });
}

/** Istanbul's line metric groups statement start lines, just like its native reporter. */
export function parseIstanbul(json: string, root: string, subject: VerificationFunction, source?: string): TargetFunctionCoverage {
  const files = Object.entries(jsonReport(json)).filter(([path]) => fileIdentity(root, path) === fileIdentity(root, subject.path));
  if (files.length !== 1) throw new Error("Cannot uniquely locate target file in Istanbul report.");
  const file: any = files[0][1];
  const matches = Object.entries(file.fnMap ?? {}).filter(([, fn]: any) => {
    if (fn.name === subject.name) return true;
    if (!source || !/^\(anonymous_\d+\)$/.test(fn.name) || !fn.decl?.start) return false;
    const line = source.split(/\r?\n/)[fn.decl.start.line - 1] ?? "";
    const escaped = subject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = line.slice(0, fn.decl.start.column);
    const suffix = line.slice(fn.decl.start.column);
    return new RegExp(`^(?:${escaped})\\s*\\(`).test(suffix) ||
      new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?$`).test(prefix);
  });
  if (matches.length !== 1) throw new Error(`Cannot uniquely locate target function ${subject.name} in Istanbul report.`);
  const [id, fn]: any = matches[0];
  const inside = (loc: any, range: any) => loc && range &&
    (loc.start.line > range.start.line || loc.start.line === range.start.line && loc.start.column >= range.start.column) &&
    (loc.end.line < range.end.line || loc.end.line === range.end.line && loc.end.column <= range.end.column);
  const nested: any[] = Object.entries(file.fnMap).filter(([key, value]: any) => key !== id && inside(value.loc, fn.loc)).map(([, value]) => value);
  const belongs = (loc: any) => inside(loc, fn.loc) && !nested.some(value => inside(loc, value.loc));
  const lines = new Map<number, number>();
  for (const [key, loc] of Object.entries(file.statementMap ?? {}) as [string, any][]) {
    if (belongs(loc)) lines.set(loc.start.line, Math.max(lines.get(loc.start.line) ?? 0, counter(file.s[key])));
  }
  const branches: number[] = [];
  for (const [key, branch] of Object.entries(file.branchMap ?? {}) as [string, any][]) {
    if (belongs(branch.loc)) branches.push(...file.b[key].map(counter));
  }
  return { name: subject.name, executed: counter(file.f[id]) > 0, lineCoverage: percent([...lines.values()]), branchCoverage: percent(branches) };
}

export type PythonFunction = { name: string; start: number; end: number; bodyStart: number; nested: { start: number; end: number }[] };
export function parsePythonCoverage(json: string, root: string, subject: VerificationFunction, functions: PythonFunction[]): TargetFunctionCoverage {
  const report = jsonReport(json);
  const files = Object.entries(report.files ?? {}).filter(([path]) => fileIdentity(root, path) === fileIdentity(root, subject.path));
  if (files.length !== 1) throw new Error("Cannot uniquely locate target file in coverage.py report.");
  const matches = functions.filter(fn => fn.name === subject.name || fn.name.split(".").pop() === subject.name);
  if (matches.length !== 1) throw new Error(`Cannot uniquely locate target function ${subject.name} in Python source.`);
  const fn = matches[0], file: any = files[0][1];
  if (fn.bodyStart === fn.start) throw new Error("Single-line Python functions require function-level tracing.");
  const belongs = (line: number) => line >= fn.bodyStart && line <= fn.end && !fn.nested.some(n => line >= n.start && line <= n.end);
  const executed = (file.executed_lines ?? []).map(counter).filter(belongs);
  const missed = (file.missing_lines ?? []).map(counter).filter(belongs);
  const hitBranches = (file.executed_branches ?? []).filter(([line]: number[]) => belongs(line));
  const missingBranches = (file.missing_branches ?? []).filter(([line]: number[]) => belongs(line));
  return { name: subject.name, executed: executed.length > 0, lineCoverage: percent([...executed.map(() => 1), ...missed.map(() => 0)]),
    branchCoverage: percent([...hitBranches.map(() => 1), ...missingBranches.map(() => 0)]) };
}

export function parseTrx(xml: string): TestSummary {
  const counts = xmlReport(xml).TestRun?.ResultSummary?.Counters;
  if (!counts) throw new Error("Missing TRX counters.");
  // Outcomes other than passed/notExecuted are failures, including timeout/error/aborted.
  const total = counter(counts.total), passed = counter(counts.passed);
  // xUnit emits notExecuted=0 for skipped cases; executed is the reliable aggregate.
  const skipped = counts.executed !== undefined ? total - counter(counts.executed) : counter(counts.notExecuted);
  return summary(total, total - skipped - passed, skipped);
}
/** Source enables overload-safe C# state-machine attribution; three-argument calls retain legacy name-only async matching. */
export function parseCobertura(xml: string, subject: VerificationFunction, root?: string, source?: string): TargetFunctionCoverage {
  const report = xmlReport(xml).coverage;
  const packages = report?.packages?.package;
  const packageList = Array.isArray(packages) ? packages : packages ? [packages] : [];
  const methods: { method: any; owner: string; kind: "method" | "state" | "accessor"; declaration?: CsharpMethodRange }[] = [];
  const declaringType = csharpDeclaringType(subject);
  const stateOwners = new Set<string>();
  const declarations = source === undefined ? undefined : csharpMethodRanges(source, subject.name);
  for (const pkg of packageList) for (const cls of pkg.classes?.class ?? []) {
    const className = String(cls.name ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    // Coverlet attributes async/iterator bodies to the compiler-generated
    // state machine's MoveNext, rather than the source method. Use the
    // original declaring type and method encoded in that class identity.
    const stateMachine = className.match(/^(.*)\/<([^<>]+)>d__\d+(?:`\d+)?$/);
    const path = String(cls.filename ?? "").replaceAll("\\", "/");
    if (root) {
      const sources: string[] = report.sources?.source ?? [];
      const candidates = isAbsolute(path) ? [path] : sources.length ? sources.map(source => resolve(source, path)) : [resolve(root, path)];
      if (!candidates.some(candidate => fileIdentity(root, candidate) === fileIdentity(root, subject.path))) continue;
    } else if (path !== subject.path) continue;
    const owner = normalizeCsharpOwner(stateMachine?.[1] ?? className);
    if (declaringType && !matchesCsharpOwner(owner, declaringType)) continue;
    for (const method of cls.methods?.method ?? []) {
      if (stateMachine) {
        if (stateMachine[2] !== subject.name || method.name !== "MoveNext") continue;
        stateOwners.add(owner);
        if (source !== undefined) {
          const ranges = declarations?.filter(declaration => declaration.owner === owner) ?? [];
          const matching = ranges.filter(declaration => !subject.signature || matchesCsharpSignature(declaration.parameters, subject.signature, subject.name));
          if (matching.length !== 1) continue;
          const declaration = matching[0]!;
          const points = method.lines?.line ?? [];
          // Every sequence point must belong exclusively to the selected source
          // declaration. Two overloads on one line cannot be distinguished here.
          if (!points.length || !points.every((point: any) => {
            const line = counter(point.number);
            return line > 0 && line >= declaration.start && line <= declaration.end &&
              !ranges.some(other => other !== declaration && line >= other.start && line <= other.end);
          })) continue;
          methods.push({ method, owner, kind: "state", declaration });
        } else methods.push({ method, owner, kind: "state" });
      } else if (method.name === subject.name && (!subject.signature || matchesCsharpSignature(method.signature, subject.signature, subject.name))) {
        methods.push({ method, owner, kind: "method" });
      } else if (!/^(?:get_|set_)/.test(subject.name) && !subject.signature?.includes("(") && ["get_", "set_"].some(prefix => method.name === prefix + subject.name)) {
        methods.push({ method, owner, kind: "accessor" });
      }
    }
  }
  // Some producers emit both the async kickoff method and MoveNext. Prefer
  // body evidence only after source proves they represent the same declaration.
  const selected = methods.filter(candidate => {
    if (candidate.kind !== "method") return true;
    const states = methods.filter(state => state.kind === "state" && state.owner === candidate.owner);
    const matchingStates = states.filter(state => state.declaration &&
      matchesCsharpSignature(candidate.method.signature, `${subject.name}${state.declaration.parameters}`, subject.name));
    if (matchingStates.length) return false;
    if (source !== undefined && stateOwners.has(candidate.owner)) {
      const ranges = declarations?.filter(declaration => declaration.owner === candidate.owner &&
        matchesCsharpSignature(candidate.method.signature, `${subject.name}${declaration.parameters}`, subject.name)) ?? [];
      // Do not let an unmapped async kickoff stub stand in for its body.
      return ranges.length === 1 && !ranges[0]!.stateful;
    }
    return true;
  });
  const property = selected.length > 0 && selected.every(candidate => candidate.kind === "accessor" && candidate.owner === selected[0]!.owner) &&
    new Set(selected.map(candidate => candidate.method.name)).size === selected.length;
  if (selected.length !== 1 && !property) throw new Error(`Cannot uniquely locate target function ${subject.signature ?? subject.name} in Cobertura report (${selected.length} matches).`);
  const lines = selected.flatMap(candidate => candidate.method.lines?.line ?? []);
  if (lines.length === 0) throw new Error("Missing method sequence points in Cobertura report.");
  const hits = property
    ? [...lines.reduce((byLine: Map<number, number>, line: any) => {
      const number = counter(line.number), hits = counter(line.hits);
      byLine.set(number, Math.max(byLine.get(number) ?? 0, hits));
      return byLine;
    }, new Map<number, number>()).values()]
    : lines.map((line: any) => counter(line.hits));
  let coveredBranches = 0, totalBranches = 0;
  for (const line of lines) if (String(line.branch).toLowerCase() === "true") {
    const match = String(line["condition-coverage"]).match(/\((\d+)\/(\d+)\)/);
    if (!match) throw new Error("Invalid Cobertura branch counter.");
    const covered = counter(match[1]), total = counter(match[2]);
    if (covered > total) throw new Error("Invalid Cobertura branch counter.");
    coveredBranches += covered;
    totalBranches += total;
  }
  return { name: subject.name, executed: hits.some((n: number) => n > 0), lineCoverage: percent(hits), branchCoverage: totalBranches === 0 ? null : Math.round(coveredBranches / totalBranches * 10_000) / 100 };
}

function normalizeCsharpOwner(owner: string): string {
  return owner.replace(/global::/g, "").replace(/[+/]|::/g, ".").replace(/@/g, "");
}

function matchesCsharpOwner(actual: string, requested: string): boolean {
  return actual === requested || !requested.includes(".") && actual.split(".").at(-1) === requested;
}

function csharpDeclaringType(subject: VerificationFunction): string | undefined {
  const head = subject.signature?.split("(", 1)[0]?.trim();
  if (!head) return undefined;
  const escaped = subject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = head.match(new RegExp(`([\\w.@+\\x60:/]+)(?:\\.|::)${escaped}$`));
  return match ? normalizeCsharpOwner(match[1]!) : undefined;
}

type CsharpMethodRange = { owner: string; parameters: string; start: number; end: number; stateful: boolean };

// This is a conservative declaration locator, not a C# compiler. It only
// associates member bodies whose delimiters and parameter identities are known.
// Unsupported syntax and remapped line numbers leave coverage unavailable.
function csharpMethodRanges(source: string, name: string): CsharpMethodRange[] | undefined {
  const masked = maskCsharpSource(source);
  if (masked === undefined || /^\s*#\s*line\b/m.test(masked)) return undefined;
  const pairs = new Map<number, number>(), braces: { open: number; close: number }[] = [], stack: number[] = [];
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index]!;
    if ("({[".includes(char)) stack.push(index);
    else if (")}]".includes(char)) {
      const open = stack.pop();
      if (open === undefined || masked[open] !== ({ ")": "(", "}": "{", "]": "[" }[char])) return undefined;
      pairs.set(open, index);
      if (char === "}") braces.push({ open, close: index });
    }
  }
  if (stack.length) return undefined;
  const scopes: { open: number; close: number; name: string; type: boolean }[] = [];
  let fileNamespace = "";
  const scopePattern = /\b(namespace|class|struct|interface|record)\s+(?:(?:class|struct)\s+)?(@?\w+(?:\s*\.\s*@?\w+)*)/g;
  for (const match of masked.matchAll(scopePattern)) {
    let index = match.index + match[0].length;
    for (; index < masked.length && !"{};=".includes(masked[index]!); index++) {
      if (pairs.has(index) && masked[index] !== "{") index = pairs.get(index)!;
    }
    const scopeName = match[2]!.replace(/\s|@/g, "");
    if (masked[index] === "{" && pairs.has(index)) scopes.push({ open: index, close: pairs.get(index)!, name: scopeName, type: match[1] !== "namespace" });
    else if (masked[index] === ";" && match[1] === "namespace") {
      if (fileNamespace) return undefined;
      fileNamespace = scopeName;
    }
  }
  scopes.sort((a, b) => a.open - b.open);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ranges: CsharpMethodRange[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  for (const match of masked.matchAll(new RegExp(`\\b@?${escaped}\\s*\\(`, "g"))) {
    const containing = scopes.filter(scope => scope.open < match.index && scope.close > match.index);
    const parent = containing.at(-1);
    if (!parent?.type || braces.some(brace => brace.open > parent.open && brace.open < match.index && brace.close > match.index)) continue;
    let boundary = match.index - 1;
    while (boundary > parent.open && !";{}".includes(masked[boundary]!)) boundary--;
    const prefix = masked.slice(boundary + 1, match.index).replace(/\[[^\]]*\]/g, " ").trim();
    // A member invocation in a field initializer is not a declaration.
    if (!prefix || /[=(){};]/.test(prefix)) continue;
    const open = match.index + match[0].lastIndexOf("("), close = pairs.get(open);
    if (close === undefined) return undefined;
    const params = splitCsharpTypes(source.slice(open + 1, close));
    if (!params) continue;
    const types = params.map(csharpParameterType);
    if (types.some(type => type === undefined)) continue;
    let body = close + 1;
    while (/\s/.test(masked[body] ?? "") && body < masked.length) body++;
    if (masked.slice(body, body + 5) === "where") {
      while (body < parent.close && masked[body] !== "{" && masked.slice(body, body + 2) !== "=>" && masked[body] !== ";") body++;
    }
    let end: number | undefined;
    if (masked[body] === "{") end = pairs.get(body);
    else if (masked.slice(body, body + 2) === "=>") {
      for (let index = body + 2; index < parent.close; index++) {
        if (masked[index] === ";") { end = index; break; }
        if (pairs.has(index)) index = pairs.get(index)!;
      }
    }
    if (end === undefined) continue;
    const owner = [fileNamespace, ...containing.map(scope => scope.name)].filter(Boolean).join(".");
    const start = boundary + 1 + masked.slice(boundary + 1, match.index).search(/\S/);
    ranges.push({ owner, parameters: `(${types.join(",")})`, start: lineAt(start), end: lineAt(end),
      stateful: /\basync\b/.test(prefix) || /\byield\s+(?:return|break)\b/.test(masked.slice(body, end)) });
  }
  return ranges;
}

// Erase comments and literal contents while preserving offsets and line numbers.
// Interpolation expressions may contain nested literals and balanced braces.
function maskCsharpSource(source: string): string | undefined {
  const literalEnd = (start: number): number => {
    if (source.startsWith("//", start)) {
      const end = source.indexOf("\n", start + 2);
      return end < 0 ? source.length : end;
    }
    if (source.startsWith("/*", start)) {
      const end = source.indexOf("*/", start + 2);
      return end < 0 ? -1 : end + 2;
    }
    const prefix = source.slice(start).match(/^(?:\$@|@\$|@|\$+)?["']/)?.[0];
    if (!prefix) return start;
    const quote = prefix.at(-1)!;
    if (quote === "'" && prefix.length !== 1) return -1;
    const verbatim = prefix.includes("@"), interpolated = prefix.includes("$");
    let index = start + prefix.length;
    if (quote === '"' && source.startsWith('""', index)) {
      let count = 1;
      while (source[start + prefix.length - 1 + count] === '"') count++;
      // Interpolated raw strings need the full language grammar to interpret
      // delimiter and interpolation brace counts safely.
      if (interpolated || verbatim) return -1;
      const end = source.indexOf('"'.repeat(count), start + count);
      return end < 0 ? -1 : end + count;
    }
    while (index < source.length) {
      if (!verbatim && source[index] === "\\") { index += 2; continue; }
      if (source[index] === quote) {
        if (verbatim && source[index + 1] === quote) { index += 2; continue; }
        return index + 1;
      }
      if (interpolated && source[index] === "{") {
        if (source[index + 1] === "{") { index += 2; continue; }
        let depth = 1;
        index++;
        while (index < source.length && depth) {
          const end = literalEnd(index);
          if (end < 0) return -1;
          if (end > index) { index = end; continue; }
          if (source[index] === "{") depth++;
          else if (source[index] === "}") depth--;
          index++;
        }
        if (depth) return -1;
      } else index++;
    }
    return -1;
  };
  const masked = source.split("");
  for (let index = 0; index < source.length;) {
    const end = literalEnd(index);
    if (end < 0) return undefined;
    if (end === index) { index++; continue; }
    while (index < end) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
      index++;
    }
  }
  return masked.join("");
}

function csharpParameterType(parameter: string): string | undefined {
  const declaration = parameter.split("=", 1)[0]!.trim().replace(/^(?:\[[^\]]*\]\s*)+/, "");
  const byRef = /^(?:(?:this|scoped)\s+)*(?:ref|out|in)\s/.test(declaration);
  const type = declaration.replace(/^(?:(?:this|params|ref|out|in|scoped|readonly)\s+)+/, "").replace(/\s+@?[\w]+$/, "").trim();
  return type && !/[=;{}]/.test(type) ? type + (byRef ? "&" : "") : undefined;
}

function functionDeclaringType(subject: VerificationFunction): string | undefined {
  let signature = subject.signature?.trim();
  if (!signature) return undefined;
  const open = signature.indexOf("(");
  if (open >= 0) signature = signature.slice(0, open);
  const dot = signature.lastIndexOf(".");
  const colon = signature.lastIndexOf("::");
  const separator = Math.max(dot, colon);
  if (separator <= 0) return undefined;
  const offset = separator === colon ? 2 : 1;
  const method = signature.slice(separator + offset).trim();
  if (method !== subject.name) return undefined;
  return signature.slice(0, separator).trim().split(/[.:]/).filter(Boolean).at(-1);
}

function matchesCsharpSignature(actual: string, requested: string, name: string): boolean {
  if (actual === requested) return true;
  if (!requested.includes("(")) return true;
  const start = requested.indexOf(`${name}(`);
  if (start < 0 || !actual.startsWith("(") || !actual.endsWith(")")) return false;
  const end = requested.lastIndexOf(")");
  if (end < start) return false;
  const params = splitCsharpTypes(requested.slice(start + name.length + 1, end));
  // XML entity expansion stays disabled for reports; decode only type syntax.
  const actualTypes = splitCsharpTypes(actual.slice(1, -1).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  if (!params || !actualTypes || params.length !== actualTypes.length) return false;
  return params.every((param, index) => {
    const type = csharpParameterType(param);
    return type !== undefined && matchesCsharpType(actualTypes[index]!, type);
  });
}

// Commas inside generic arguments, array ranks and default strings do not
// separate method parameters. Malformed/unsupported identities stay unverified.
function splitCsharpTypes(input: string): string[] | undefined {
  if (!input.trim()) return [];
  const parts: string[] = [], stack: string[] = [];
  let start = 0, quote = "";
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "<" || char === "[" || char === "(") stack.push(char);
    else if (char === ">" || char === "]" || char === ")") {
      if (stack.pop() !== ({ ">": "<", "]": "[", ")": "(" }[char])) return undefined;
    } else if (char === "," && !stack.length) { parts.push(input.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(input.slice(start).trim());
  return stack.length || quote || parts.some(part => !part) ? undefined : parts;
}

const csharpAliases: Record<string, string> = {
  int: "System.Int32", uint: "System.UInt32", long: "System.Int64", ulong: "System.UInt64", short: "System.Int16", ushort: "System.UInt16",
  byte: "System.Byte", sbyte: "System.SByte", bool: "System.Boolean", string: "System.String", char: "System.Char", double: "System.Double",
  float: "System.Single", decimal: "System.Decimal", object: "System.Object", nint: "System.IntPtr", nuint: "System.UIntPtr",
};
function matchesCsharpType(actual: string, requested: string): boolean {
  const normalize = (type: string) => type.replace(/\s+|global::/g, "").replace(/\b\w+\b/g, name => csharpAliases[name] ?? name);
  actual = normalize(actual);
  requested = normalize(requested);
  if (actual === requested) return true;
  if (requested.endsWith("?")) {
    const underlying = requested.slice(0, -1);
    const nullable = actual.match(/^System\.Nullable`?1?<(.+)>$/);
    if (nullable) return matchesCsharpType(nullable[1]!, underlying);
    // Nullable reference annotations are erased. Nullable value types retain
    // System.Nullable<T>, and must not be confused with the non-nullable overload.
    const normalized = csharpAliases[underlying] ?? underlying;
    if (Object.values(csharpAliases).includes(normalized) && !["System.String", "System.Object"].includes(normalized)) return false;
    return matchesCsharpType(actual, underlying);
  }
  if (actual.endsWith("&") || requested.endsWith("&")) return actual.endsWith("&") && requested.endsWith("&") && matchesCsharpType(actual.slice(0, -1), requested.slice(0, -1));
  const actualArray = actual.match(/\[,*\]$/), requestedArray = requested.match(/\[,*\]$/);
  if (actualArray || requestedArray) return Boolean(actualArray && requestedArray && actualArray[0] === requestedArray[0]
    && matchesCsharpType(actual.slice(0, -actualArray[0].length), requested.slice(0, -requestedArray[0].length)));
  const actualOpen = actual.indexOf("<"), requestedOpen = requested.indexOf("<");
  if (actualOpen >= 0 || requestedOpen >= 0) {
    if (actualOpen < 0 || requestedOpen < 0 || !actual.endsWith(">") || !requested.endsWith(">")) return false;
    const actualArgs = splitCsharpTypes(actual.slice(actualOpen + 1, -1)), requestedArgs = splitCsharpTypes(requested.slice(requestedOpen + 1, -1));
    return Boolean(actualArgs?.length && requestedArgs && actualArgs.length === requestedArgs.length
      && matchesCsharpType(actual.slice(0, actualOpen).replace(/`\d+$/, ""), requested.slice(0, requestedOpen).replace(/`\d+$/, ""))
      && requestedArgs.every((type, index) => matchesCsharpType(actualArgs[index]!, type)));
  }
  requested = csharpAliases[requested] ?? requested;
  return actual === requested || (!requested.includes(".") && actual.endsWith(`.${requested}`));
}

type XmlNode = Record<string, any>;
export function parseSurefireReport(xml: string): TestSummary {
  const suites: XmlNode[] = xmlReport(xml).testsuite ?? [];
  if (suites.length !== 1) throw new Error("Expected one Surefire test suite.");
  const suite = suites[0];
  const total = counter(suite.tests);
  const skipped = counter(suite.skipped);
  const failed = counter(suite.failures) + counter(suite.errors);
  if (skipped + failed > total) throw new Error("Inconsistent test counts.");
  return { executed: total - skipped, passed: total - skipped - failed, failed, skipped };
}

export function parseJacocoReport(
  xml: string, subject: VerificationFunction, source: string,
): TargetFunctionCoverage {
  const report = xmlReport(xml).report;
  if (!report) throw new Error("Missing JaCoCo report.");
  const packageName = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]?.replaceAll(".", "/") ?? "";
  const candidates: XmlNode[] = [];
  for (const pkg of report.package ?? []) {
    if (pkg.name !== packageName) continue;
    for (const cls of pkg.class ?? []) {
      if (cls.sourcefilename !== basename(subject.path)) continue;
      const owner = functionDeclaringType(subject);
      if (owner && String(cls.name).split(/[/$]/).at(-1) !== owner) continue;
      for (const method of cls.method ?? []) {
        if (method.name === subject.name) candidates.push(method);
      }
    }
  }
  const matching = subject.signature
    ? candidates.filter((method) => matchesJavaSignature(method.desc, subject.signature!, subject.name))
    : candidates;
  if (matching.length !== 1) {
    throw new Error(`Cannot uniquely locate target function ${subject.name} in JaCoCo coverage (${matching.length} matches).`);
  }
  const counters: XmlNode[] = matching[0].counter ?? [];
  const method = counters.find((value) => value.type === "METHOD");
  if (!method || counter(method.covered) + counter(method.missed) !== 1) throw new Error("Missing or invalid method coverage counter.");
  return {
    name: subject.name,
    executed: counter(method.covered) === 1,
    lineCoverage: jacocoPercentage(counters, "LINE"),
    branchCoverage: jacocoPercentage(counters, "BRANCH"),
  };
}

function jacocoPercentage(counters: XmlNode[], type: string): number | null {
  const metric = counters.find((value) => value.type === type);
  if (!metric) return null;
  const covered = counter(metric.covered), missed = counter(metric.missed);
  return covered + missed === 0 ? null : Math.round(covered / (covered + missed) * 10_000) / 100;
}

/** Match JVM descriptors or ordinary Java signatures; ambiguous matches stay unavailable. */
function matchesJavaSignature(descriptor: string, signature: string, name: string): boolean {
  if (!signature.includes("(")) return true;
  if (signature.startsWith("(")) return descriptor === signature;
  const namePosition = signature.indexOf(`${name}(`);
  if (namePosition < 0) return false;
  const parameters = eraseJavaTypeArguments(signature.slice(namePosition + name.length + 1).split(")")[0]);
  if (parameters === undefined) return false;
  const requested = parameters.trim() === "" ? [] : parameters.split(",").map((value) =>
    value.trim().replace(/^final\s+/, "").replace(/\s+[\w$]+$/, "").replaceAll("...", "[]"),
  );
  const actual = descriptorParameters(descriptor);
  return requested.length === actual.length && requested.every((type, index) =>
    type === actual[index] || (!type.includes(".") && type === actual[index].split(".").pop()),
  );
}

/** JVM descriptors erase parameterized type arguments, including their commas. */
function eraseJavaTypeArguments(parameters: string): string | undefined {
  let depth = 0;
  let erased = "";
  for (const character of parameters) {
    if (character === "<") depth++;
    else if (character === ">") {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth === 0) erased += character;
  }
  return depth === 0 ? erased : undefined;
}

function descriptorParameters(descriptor: string): string[] {
  const input = descriptor.slice(1, descriptor.indexOf(")"));
  const names: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean" };
  const result: string[] = [];
  for (let index = 0; index < input.length;) {
    let suffix = "";
    while (input[index] === "[") { suffix += "[]"; index++; }
    let type: string;
    if (input[index] === "L") {
      const end = input.indexOf(";", index);
      if (end < 0) throw new Error("Invalid JVM descriptor.");
      type = input.slice(index + 1, end).replaceAll("/", ".").replaceAll("$", ".");
      index = end + 1;
    } else {
      type = names[input[index++]];
      if (!type) throw new Error("Invalid JVM descriptor.");
    }
    result.push(type + suffix);
  }
  return result;
}
