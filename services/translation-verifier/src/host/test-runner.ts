import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, realpath, rm, stat, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { parseJacocoReport, parseExecutionErrors, parseSurefireReport, parseCobertura, parseIstanbul, parseJUnit, parseNodeTests, parsePythonCoverage, parseTrx, parseJUnitTestCases, parseNodeTestCases, parseTrxTestCases, jsonReport, type PythonFunction } from "./coverage-reports.js";
import { MAX_TEST_OUTPUT_CHARS, assertTestPath, relativePath, readProjectFile, resolveSafePath, type FunctionGroupTestRun, type FunctionGroupTestRunner, type ToolContext, type TargetTestResult, type TargetCoverageResult, type TestSummary } from "./tools/common.js";
import type { TargetFunctionCoverage, VerificationFunction, VerificationReason, VerificationTestCase } from "../types.js";

const JACOCO = "org.jacoco:jacoco-maven-plugin:0.8.13";
export const MAVEN_COVERAGE_GOALS = [`${JACOCO}:prepare-agent`, "test", `${JACOCO}:report`] as const;
const MAVEN_REPORT_PATH = "target/site/jacoco/jacoco.xml";
const MAVEN_TEST_REPORTS = "target/surefire-reports";
const GRADLE_REPORT_PATH = "build/reports/jacoco/test/jacocoTestReport.xml";
const GRADLE_TEST_REPORTS = "build/test-results/test";
type CoverageRun = {
  reportRoot: string;
  previousReports: Map<string, string>;
  scriptDirectory?: string;
  args: string[];
  pythonFunctions?: Array<{ path: string; functions: PythonFunction[] }>;
};
type RunnerContext = Omit<ToolContext, "runner" | "state">;
export type BoundTestRunner = {
  run(testPath: string): Promise<TargetTestResult>;
  /** Execute all selected test files together, retaining complete-suite evidence. */
  runSuite?(testPaths: readonly string[]): Promise<TargetTestResult>;
};

/** Resolve authorized file/directory selections before starting a test process. */
export async function resolveTestPaths(
  context: RunnerContext,
  selections: readonly string[] = context.runtime.testRoots,
): Promise<string[]> {
  const root = context.runtime.targetProjectPath;
  const selected: Array<{ path: string; directory: boolean }> = [];
  for (const path of selections) {
    relativePath(path, "test path");
    assertTestPath(path, context.runtime.testRoots);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(resolveSafePath(root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The first baseline may precede creation of the dedicated folder.
      if (context.runtime.testRoots.includes(path)) continue;
      throw new Error(`Test path does not exist: ${path}`);
    }
    if (context.runtime.testRoots.includes(path) && !info.isDirectory()) {
      throw new Error(`Test path is not a directory: ${path}`);
    }
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Test path is not a file or directory: ${path}`);
    selected.push({ path, directory: info.isDirectory() });
  }
  const paths = new Set<string>();
  for (const selection of selected) {
    context.budget?.assertActive();
    if (!selection.directory) { paths.add(selection.path); continue; }
    const discovered: string[] = [];
    const visit = async (path: string): Promise<void> => {
      context.budget?.assertActive();
      const absolute = resolveSafePath(root, path);
      const info = await lstat(absolute);
      // Fixtures share the directory boundary even when they are not tests.
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`Linked test paths are not allowed: ${path}`);
      if (info.isDirectory()) {
        for (const name of (await readdir(absolute)).sort()) await visit(relativePath(`${path}/${name}`, "test path"));
      } else if (info.isFile() && await isTestFile(context.runtime.testRunner, path, () => readProjectFile(root, path))) {
        discovered.push(path);
      }
    };
    await visit(selection.path);
    for (const path of discovered.sort()) paths.add(path);
  }
  return [...paths];
}

async function isTestFile(runner: RunnerContext["runtime"]["testRunner"], path: string, read: () => Promise<string>): Promise<boolean> {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (runner === "jest" || runner === "vitest") {
    if (/\.d\.(?:ts|mts|cts)$/.test(name)) return false;
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
      || (path.split("/").includes("__tests__") && /\.[cm]?[jt]sx?$/.test(name));
  }
  if (runner === "pytest") return /^(?:test_.*|.*_test)\.py$/.test(name);
  if (runner === "maven" || runner === "gradle") {
    if (!/\.(?:java|kt)$/i.test(name)) return false;
    if (/^(?:Test.+|.+Tests?|.+TestCase|.+IT)\.(?:java|kt)$/i.test(name)) return true;
    return /@(?:[\w$]+\.)*(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Suite)\b/.test(await read());
  }
  if (!/\.cs$/i.test(name)) return false;
  const source = await read();
  return /\[\s*(?:(?:global::)?[\w.]+\.)?(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)(?:Attribute)?\b/.test(source)
    || /\bclass\s+\w+Tests?\b/.test(source);
}

/** Bind the command and framework capabilities before exposing tools to the Agent. */
export function bindTestRunner(context: RunnerContext): BoundTestRunner {
  const boundContext: RunnerContext = {
    budget: context.budget,
    runtime: {
      ...context.runtime,
      targetFunction: { ...context.runtime.targetFunction },
      targetTest: { ...context.runtime.targetTest, args: [...context.runtime.targetTest.args] },
    },
  };
  return {
    run: (testPath) => runTests(boundContext, [testPath]),
    runSuite: (testPaths) => runTests(boundContext, testPaths),
  };
}

/** Bind the same Host-controlled runner to every target function in a group. */
export function bindFunctionGroupTestRunner(context: RunnerContext): FunctionGroupTestRunner {
  const functions = context.runtime.functionGroup?.functions ?? [];
  return {
    run: async (testPaths) => {
      if (functions.length === 0) throw new Error("Function-group verification requires at least one target function.");
      if (testPaths.length === 0) throw new Error("Function-group verification requires at least one test path.");
      const targetContext: RunnerContext = {
        ...context,
        runtime: {
          ...context.runtime,
          targetFunction: { ...functions[0]!.target },
        },
      };
      const result = await runTestsForSubjects(
        targetContext,
        [...testPaths],
        functions.map((mapping) => mapping.target),
      );
      const functionsResult = functions.map((mapping, index) => {
        const coverage = result.coverage[index];
        const executed = coverage?.status === "available" && coverage.targetFunction.executed;
        const reason: VerificationReason = result.status === "failure"
          ? "test-failed"
          : coverage?.status !== "available"
            ? "coverage-unavailable"
            : executed ? "verified" : "not-executed";
        const source = ("source" in mapping ? mapping.source : undefined) as VerificationFunction | undefined;
        return {
          ...(source ? { source: { ...source } } : {}),
          target: { ...mapping.target },
          status: executed && result.status === "success" && (result.tests?.executed ?? 0) > 0 ? "passed" as const : "unverified" as const,
          executed,
          lineCoverage: coverage?.status === "available" ? coverage.targetFunction.lineCoverage : null,
          branchCoverage: coverage?.status === "available" ? coverage.targetFunction.branchCoverage : null,
          reason,
          ...(coverage?.status === "unavailable" ? { coverageIssue: coverage.reason } : {}),
        };
      });
      return {
        status: result.status,
        timedOut: result.timedOut,
        testPaths: [...testPaths],
        tests: result.tests ?? { executed: 0, passed: 0, failed: 0, skipped: 0 },
        testCases: result.testCases,
        executionErrors: result.executionErrors,
        reportPaths: result.reportPaths,
        functions: functionsResult,
        failures: result.failures,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        reason: result.status === "failure" ? "test-failed" : functionsResult.some((item) => item.reason === "coverage-unavailable") ? "coverage-unavailable" : functionsResult.some((item) => item.reason === "not-executed") ? "not-executed" : "verified",
      } satisfies FunctionGroupTestRun;
    },
  };
}

async function runTests(context: RunnerContext, testPaths: readonly string[]): Promise<TargetTestResult> {
  if (testPaths.length === 0) throw new Error("At least one test path is required.");
  const result = await runTestsForSubjects(context, testPaths, [context.runtime.targetFunction]);
  return {
    ...result,
    testPaths: [...testPaths],
    coverage: result.coverage[0] ?? { status: "unavailable", reason: "No target coverage was produced." },
  };
}

async function runTestsForSubjects(
  context: RunnerContext,
  testPaths: readonly string[],
  subjects: readonly VerificationFunction[],
): Promise<{
  status: "success" | "failure";
  timedOut: boolean;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  tests?: TestSummary;
  executionErrors?: number;
  testCases?: VerificationTestCase[];
  reportPaths: string[];
  coverage: TargetCoverageResult[];
  failures: Array<{ message: string; testPath?: string; suspectedFunctions: VerificationFunction[] }>;
}> {
  context.budget?.assertActive();
  const coverageRun = await prepareCoverage(context, testPaths, subjects);
  try {
    const { executable } = context.runtime.targetTest;
    const args = [...context.runtime.targetTest.args, ...coverageRun.args];
    const timeoutMs = Math.min(context.runtime.targetTest.timeoutMs ?? 300_000, context.budget?.remainingMs() ?? Number.POSITIVE_INFINITY);
    if (!executable || executable.includes("\0") || args.some((arg) => arg.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Host target test command is invalid.");
    }
    context.budget?.assertActive();
    const startedAt = Date.now();
    const signal = context.budget?.signal;
    const processResult = await new Promise<{ exitCode: number | null; signal?: string; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(executable, args, { cwd: context.runtime.targetProjectPath, shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false, settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const append = (current: string, chunk: Buffer | string) => {
        const next = current + chunk.toString();
        return next.length <= MAX_TEST_OUTPUT_CHARS ? next : next.slice(0, MAX_TEST_OUTPUT_CHARS);
      };
      const terminate = () => {
        child.kill("SIGTERM");
        // Guarantee cancellation even when the test process ignores SIGTERM.
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      };
      const abort = () => terminate();
      const finish = (value: { exitCode: number | null; signal?: string }) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        resolve({ ...value, stdout, stderr, timedOut });
      };
      child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => { stderr = append(stderr, error.message); finish({ exitCode: null }); });
      child.once("close", (exitCode, closeSignal) => { finish({ exitCode, signal: closeSignal ?? undefined }); });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    });
    context.budget?.assertActive();
    const evidence = await collectCoverage(context, coverageRun, subjects);
    const status = processResult.timedOut || processResult.exitCode !== 0 || evidence.executionErrors > 0 || (evidence.tests?.failed ?? 0) > 0 || evidence.tests?.executed === 0 ? "failure" as const : "success" as const;
    const failures = status === "failure" ? [{
      message: [processResult.stderr, processResult.stdout].filter(Boolean).join("\n") || "Target tests failed.",
      ...(testPaths.length === 1 ? { testPath: testPaths[0] } : {}),
      suspectedFunctions: subjects.filter((_, index) => evidence.coverage[index]?.status === "available" && evidence.coverage[index]!.targetFunction.executed).map((subject) => ({ ...subject })),
    }] : [];
    return {
      status,
      timedOut: processResult.timedOut,
      exitCode: processResult.exitCode,
      ...(processResult.signal ? { signal: processResult.signal } : {}),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      durationMs: Date.now() - startedAt,
      ...(evidence.tests ? { tests: evidence.tests } : {}),
      testCases: evidence.testCases,
      executionErrors: evidence.executionErrors,
      reportPaths: evidence.reportPaths,
      coverage: evidence.coverage,
      failures,
    };
  } finally {
    if (coverageRun.scriptDirectory) await rm(coverageRun.scriptDirectory, { recursive: true, force: true });
  }
}

const runFile = promisify(execFile);
const PYTHON_FUNCTIONS = `import ast,json,sys
source=open(sys.argv[1],encoding='utf-8').read()
tree=ast.parse(source)
result=[]
def visit(node,prefix=''):
 for child in ast.iter_child_nodes(node):
  if isinstance(child,(ast.FunctionDef,ast.AsyncFunctionDef)):
   name=prefix+child.name
   nested=[{'start':n.lineno,'end':n.end_lineno} for n in ast.walk(child) if n is not child and isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))]
   result.append({'name':name,'start':child.lineno,'end':child.end_lineno,'bodyStart':child.body[0].lineno,'nested':nested})
   visit(child,name+'.')
  elif isinstance(child,ast.ClassDef):
   visit(child,prefix+child.name+'.')
  else:
   visit(child,prefix)
visit(tree)
print(json.dumps(result))
`;

function dotnetProject(context: RunnerContext): string {
  const projects = context.runtime.targetTest.args.filter(arg => /\.csproj$/i.test(arg)).map(path => path.replaceAll("\\", "/"));
  if (projects.length !== 1) throw new Error("C# coverage requires exactly one bound test project.");
  return projects[0]!;
}

async function reportIdentity(path: string): Promise<string | undefined> {
  try {
    const value = await stat(path, { bigint: true });
    return value.isFile() ? `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function directoryEntries(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Inspect only known report locations, never recurse through generated build trees.
async function reportPaths(runner: RunnerContext["runtime"]["testRunner"], root: string): Promise<string[]> {
  if (runner === "maven" || runner === "gradle") {
    const directory = runner === "maven" ? MAVEN_TEST_REPORTS : GRADLE_TEST_REPORTS;
    const tests = (await directoryEntries(resolveSafePath(root, directory))).filter(name => /^TEST-.*\.xml$/.test(name));
    return [runner === "maven" ? MAVEN_REPORT_PATH : GRADLE_REPORT_PATH, ...tests.map(name => `${directory}/${name}`)];
  }
  if (runner === "jest" || runner === "vitest") return ["tests.json", "coverage/coverage-final.json"];
  if (runner === "pytest") return ["tests.xml", "coverage.json"];
  const entries = await directoryEntries(root);
  const paths = entries.filter(name => /\.trx$/i.test(name));
  for (const directory of entries.filter(name => /^[0-9a-f-]{36}$/i.test(name))) {
    const names = await directoryEntries(resolveSafePath(root, directory));
    paths.push(...names.filter(name => /\.trx$/i.test(name) || name === "coverage.cobertura.xml").map(name => `${directory}/${name}`));
  }
  return paths;
}

async function prepareCoverage(context: RunnerContext, testPaths: readonly string[], subjects: readonly VerificationFunction[]): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner } = context.runtime;
  const pomFlag = context.runtime.targetTest.args.indexOf("-f");
  const project = runner === "dotnet" ? dotnetProject(context)
    : runner === "maven" && pomFlag >= 0 ? context.runtime.targetTest.args[pomFlag + 1]?.replaceAll("\\", "/") : undefined;
  const projectDirectory = project ? dirname(project).replaceAll("\\", "/") : ".";
  const reportRoot = runner === "dotnet" ? resolveSafePath(root, `${projectDirectory}/TestResults`)
    : runner === "maven" && projectDirectory !== "." ? resolveSafePath(root, projectDirectory) : root;
  const scriptDirectory = runner === "gradle" ? resolveSafePath(root, `.translation-verifier-scripts/${randomUUID()}`) : undefined;
  if (scriptDirectory) await mkdir(scriptDirectory, { recursive: true });
  try {
    const run = await configureRunnerCoverage(context, testPaths, subjects, { reportRoot, previousReports: new Map(), scriptDirectory, args: [] });
    for (const path of await reportPaths(runner, reportRoot)) {
      const identity = await reportIdentity(resolveSafePath(reportRoot, path));
      if (identity !== undefined) run.previousReports.set(path, identity);
    }
    return run;
  } catch (error) {
    if (scriptDirectory) await rm(scriptDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function configureRunnerCoverage(context: RunnerContext, testPaths: readonly string[], subjects: readonly VerificationFunction[], run: CoverageRun): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner } = context.runtime;
  const testPath = testPaths[0];
  if (!testPath) throw new Error("At least one test path is required.");
  // Unit fixtures may inject a direct Node process as a deterministic timeout
  // command. It is not a Jest/Vitest executable, so appending coverage flags
  // would make the process exit immediately and hide the timeout behavior.
  if (context.runtime.targetTest.executable === process.execPath && context.runtime.targetTest.args[0] === "-e") {
    return run;
  }
  if (runner === "maven") {
    if (!/\.(?:java|kt)$/i.test(testPath)) throw new Error(`Java test selector requires a .java or .kt file: ${testPath}`);
    const classNames = testPaths.map((path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.(?:java|kt)$/i, ""));
    // Continue to JaCoCo after assertion failures; fresh Surefire counts still
    // determine failure, while compiler/setup errors remain process failures.
    return { ...run, args: ["-Djacoco.append=false", "-Dmaven.test.failure.ignore=true", "-DfailIfNoTests=true", `-Dtest=${classNames.join(",")}`] };
  }
  if (runner === "jest") return { ...run, args: ["--runTestsByPath", ...testPaths, `--roots=${await realpath(root)}`, "--coverage", ...subjects.map((subject) => `--collectCoverageFrom=${subject.path}`), "--coverageReporters=json", "--json", "--outputFile=tests.json"] };
  if (runner === "vitest") return { ...run, args: ["--run", ...testPaths, "--coverage", `--coverage.include=${subjects.map((subject) => subject.path).join(",")}`, "--coverage.reporter=json", "--reporter=json", "--outputFile=tests.json"] };
  if (runner === "pytest") {
    const pythonFunctions: Array<{ path: string; functions: PythonFunction[] }> = [];
    for (const subject of subjects) {
      context.budget?.assertActive();
      const { stdout } = await runFile(
        context.runtime.targetTest.executable,
        ["-c", PYTHON_FUNCTIONS, resolveSafePath(root, subject.path)],
        {
          cwd: root,
          timeout: Math.min(10_000, context.budget?.remainingMs() ?? 10_000),
          maxBuffer: 1_000_000,
          ...(context.budget ? { signal: context.budget.signal } : {}),
        },
      );
      pythonFunctions.push({ path: subject.path, functions: jsonReport(stdout) });
    }
    return { ...run, pythonFunctions,
      args: [...testPaths, `--cov=${root}`, "--cov-branch", "--cov-report=json", "--junitxml=tests.xml"] };
  }
  if (runner === "gradle") {
    const script = join(run.scriptDirectory!, "coverage.gradle");
    await writeFile(script, `allprojects { p ->
  p.afterEvaluate {
    if (p == rootProject && p.plugins.hasPlugin('java')) {
      p.apply plugin: 'jacoco'
      p.jacoco.toolVersion = '0.8.13'
      p.tasks.named('test') { ignoreFailures = true }
      p.tasks.named('jacocoTestReport') {
        reports.xml.required.set(true)
        reports.html.required.set(false)
        reports.csv.required.set(false)
      }
    }
  }
}
`);
    if (!/\.(java|kt)$/.test(testPath)) throw new Error("Gradle selector requires a Java/Kotlin test file.");
    const names = testPaths.map((path) => path.split("/").pop()!.replace(/\.(java|kt)$/, ""));
    return { ...run, args: names.flatMap((name) => ["--tests", `*.${name}`]).concat(["jacocoTestReport", "--init-script", script, "--rerun-tasks", "--no-build-cache"]) };
  }
  if (runner === "dotnet") {
    const directory = dirname(dotnetProject(context)).replaceAll("\\", "/");
    if (testPaths.some(path => directory !== "." && !path.startsWith(`${directory}/`))) throw new Error("C# test file does not belong to the bound test project.");
    const classNames: string[] = [];
    for (const path of testPaths) {
      const source = await readProjectFile(root, path);
      const namespaces = [...source.matchAll(/\bnamespace\s+([\w.]+)/g)];
      const classes = [...source.matchAll(/\bclass\s+(\w+)/g)];
      if (classes.length === 0 || namespaces.length > 1) throw new Error("C# test selector requires a test class and at most one namespace.");
      // Test files commonly contain nested mocks or fixture classes. They
      // belong to the authorized file too and must not block test execution.
      for (const item of classes) classNames.push([namespaces[0]?.[1], item[1]].filter(Boolean).join("."));
    }
    // VSTest's FullyQualifiedName filter already performs a substring match.
    // Appending a literal trailing dot rejects valid classes when the Agent
    // omits a namespace (and made a repair loop report "no test matches" even
    // though the generated xUnit file compiled). Match the class identity
    // directly; the Host still binds the exact test paths and owns the runner.
    return { ...run, args: ["--filter", classNames.map((name) => `FullyQualifiedName~${name}`).join("|"), "--collect:XPlat Code Coverage", "--logger", "trx;LogFileName=tests.trx"] };
  }
  throw new Error(`Unsupported coverage runner: ${runner}`);
}

async function report(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length > 16_000_000) throw new Error("Report exceeds the size limit.");
  return bytes.toString("utf8");
}
async function collectCoverage(context: RunnerContext, run: CoverageRun, subjects: readonly VerificationFunction[]): Promise<{ tests?: TestSummary; executionErrors: number; testCases: VerificationTestCase[]; reportPaths: string[]; coverage: TargetCoverageResult[] }> {
  let tests: TestSummary | undefined;
  let executionErrors = 0;
  const testCases: VerificationTestCase[] = [];
  const collectedReportPaths: string[] = [];
  const { testRunner: runner, targetProjectPath: root } = context.runtime;
  const canonicalRoot = await realpath(root);
  const read = async (path: string) => {
    const absolute = resolveSafePath(run.reportRoot, path);
    const identity = await reportIdentity(absolute);
    if (identity === undefined) throw new Error(`Missing report: ${absolute}`);
    if (identity === run.previousReports.get(path)) throw new Error(`Report was not updated by this test run: ${absolute}`);
    return report(absolute);
  };
  const freshPaths = async () => {
    const paths: string[] = [];
    for (const path of await reportPaths(runner, run.reportRoot)) {
      const identity = await reportIdentity(resolveSafePath(run.reportRoot, path));
      if (identity !== undefined && identity !== run.previousReports.get(path)) paths.push(path);
    }
    return paths;
  };
  const parseSubjects = async (parse: (subject: VerificationFunction) => TargetFunctionCoverage | Promise<TargetFunctionCoverage>): Promise<TargetCoverageResult[]> => {
    const results: TargetCoverageResult[] = [];
    for (const subject of subjects) {
      try {
        results.push({ status: "available", targetFunction: await parse(subject) });
      } catch (error) {
        results.push({ status: "unavailable", reason: error instanceof Error ? error.message : "Could not locate target coverage." });
      }
    }
    return results;
  };
  try {
    const currentPaths = await freshPaths();
    collectedReportPaths.push(...currentPaths.map(path =>
      relative(canonicalRoot, resolveSafePath(run.reportRoot, path)).replaceAll("\\", "/"),
    ));
    let targetFunctions: TargetCoverageResult[] = [];
    if (runner === "jest" || runner === "vitest") {
      const testReport = await read("tests.json");
      tests = parseNodeTests(testReport);
      executionErrors += parseExecutionErrors("node", testReport);
      testCases.push(...parseNodeTestCases(testReport));
      const report = await read("coverage/coverage-final.json");
      targetFunctions = await parseSubjects(async subject => parseIstanbul(report, canonicalRoot, subject, await readProjectFile(root, subject.path)));
    } else if (runner === "pytest") {
      const testReport = await read("tests.xml");
      tests = parseJUnit(testReport);
      executionErrors += parseExecutionErrors("junit", testReport);
      testCases.push(...parseJUnitTestCases(testReport));
      const report = await read("coverage.json");
      targetFunctions = await parseSubjects(subject => {
        const functions = run.pythonFunctions?.find((item) => item.path === subject.path)?.functions ?? [];
        return parsePythonCoverage(report, canonicalRoot, subject, functions);
      });
    } else if (runner === "maven" || runner === "gradle") {
      const names = currentPaths.filter(path => /\/TEST-[^/]*\.xml$/.test(path));
      if (names.length === 0) throw new Error(`Missing fresh ${runner} test reports.`);
      tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
      for (const name of names) {
        const xml = await read(name);
        const value = runner === "maven" ? parseSurefireReport(xml) : parseJUnit(xml);
        for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += value[key];
        testCases.push(...parseJUnitTestCases(xml));
        executionErrors += parseExecutionErrors("junit", xml);
      }
      const xml = await read(runner === "maven" ? MAVEN_REPORT_PATH : GRADLE_REPORT_PATH);
      targetFunctions = await parseSubjects(async subject => parseJacocoReport(xml, subject, await readProjectFile(root, subject.path)));
    } else if (runner === "dotnet") {
      const paths = currentPaths;
      const testReports = paths.filter(path => /\.trx$/i.test(path));
      if (testReports.length !== 1) throw new Error(`Expected one fresh TRX report in ${run.reportRoot}; found ${testReports.length}.`);
      const testReport = await read(testReports[0]!);
      tests = parseTrx(testReport);
      executionErrors += parseExecutionErrors("trx", testReport);
      testCases.push(...parseTrxTestCases(testReport));
      const testDirectory = dirname(testReports[0]!).replaceAll("\\", "/");
      const coverage = paths.filter(path => /^[0-9a-f-]{36}\/coverage\.cobertura\.xml$/i.test(path)
        && (testDirectory === "." || path.startsWith(`${testDirectory}/`)));
      if (coverage.length !== 1) throw new Error("Expected one fresh Coverlet Cobertura report in the current VSTest run directory.");
      const report = await read(coverage[0]!);
      targetFunctions = await parseSubjects(async subject => parseCobertura(report, subject, canonicalRoot, await readProjectFile(root, subject.path)));
    } else throw new Error(`Unsupported coverage runner: ${runner}`);
    return { tests, executionErrors, testCases, reportPaths: collectedReportPaths, coverage: targetFunctions };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Could not collect coverage.";
    return { ...(tests ? { tests } : {}), executionErrors, testCases, reportPaths: collectedReportPaths, coverage: subjects.map(() => ({ status: "unavailable", reason })) };
  }
}
