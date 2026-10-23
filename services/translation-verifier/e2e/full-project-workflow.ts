import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AIMessage } from "@langchain/core/messages";
import { createFunctionGroupVerifier } from "../src/function-group-verify.js";
import { createTranslationVerifierChatModel } from "../src/host/agent/chat-model.js";
import { createLangChainFunctionGroupAgentHost } from "../src/host/agent/langchain-runtime.js";
import { createJsonlAgentTraceLogger } from "../src/host/logging/trace-log.js";
import { parseExecutionErrors, parseSurefireReport } from "../src/host/testing/coverage-reports.js";
import { resolveTestEnvironment } from "../src/host/testing/test-environment.js";
import { bindFunctionGroupTestRunner, resolveTestPaths } from "../src/host/testing/test-runner.js";
import type { FunctionGroupTestRun } from "../src/host/tools/common.js";
import type { FunctionGroupVerificationResult, VerificationFunction } from "../src/types.js";
import { execute, inventory, runExistingAssetsWorkflow, type Execution } from "./existing-assets-workflow.js";

const SOURCE_ROOT = "src/main/java/com/example/assetupgrade";
const DOMAINS = ["common", "error", "observability", "security", "telemetry", "audit", "retry", "messaging", "routing", "persistence", "attachment", "workflow", "order", "reconciliation", "adapters", "config", "application", "web", "bootstrap"];
export const REFERENCES = [
  "commons-fileupload/commons-fileupload2-core/src/main/java/org/apache/commons/fileupload2/core/DiskFileItem.java",
  "keycloak/services/src/main/java/org/keycloak/services/resources/admin/fgap/RealmAuth.java",
  "flowable-engine/modules/flowable-engine/src/main/java/org/flowable/engine/impl/cmd/CompleteTaskCmd.java",
  "bullmq/src/commands/addStandardJob-9.lua",
  "apscheduler/src/apscheduler/_structures.py",
  "nopcommerce/src/Libraries/Nop.Services/Orders/OrderService.cs",
  "apache-camel/core/camel-core-processor/src/main/java/org/apache/camel/processor/FilterProcessor.java",
];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type SourceFile = { path: string; content: string };
export type Group = { targets: VerificationFunction[]; result?: FunctionGroupVerificationResult; observation?: FunctionGroupTestRun; error?: string; trace: string };
export type Attempt = { round: number; startedAt: string; response?: string; responseSha256?: string; pending?: SourceFile[]; compile?: Execution; api?: string[]; groups?: Group[]; error?: string; status: string };
export type Module = { id: string; files: string[]; status: string; attempts: Attempt[]; baselineApi?: string[]; rollbackCompile?: Execution; finalGroups?: Group[] };
type FullReport = {
  version: 3; language: "Java"; model: string; workspace: string; target: string; seed: string; commit: string;
  startedAt: string; finishedAt?: string; status: string; passed: boolean; requirementSha256: string;
  baselineHashes: Record<string, string>; expectedHashes: Record<string, string>; modules: Module[];
  references: Array<{ path: string; sourceSha256: string; suppliedSha256: string; suppliedCharacters: number }>;
  integrationCompile?: Execution; smoke?: Execution; remainingPlaceholders?: string[]; finalObservation?: FunctionGroupTestRun; finalTargets?: VerificationFunction[]; finalError?: string; reason?: string;
  hidden?: { directory: string; execution: Execution; tests: { executed: number; passed: number; failed: number; skipped: number }; executionErrors: number; reportPaths: string[]; passed: boolean };
};

export function planJavaModules(files: SourceFile[]): Module[] {
  const modules = DOMAINS.map(id => ({ id, files: files.filter(file => {
    const domain = file.path.slice(SOURCE_ROOT.length + 1).split("/")[0];
    return (id === "bootstrap" ? domain === "AssetUpgradeGateway.java" : domain === id)
      && /\b(?:class|record|enum)\s+\w+|\bdefault\s+[^;{]+\{/.test(file.content);
  }).map(file => file.path).sort(), status: "pending", attempts: [] as Attempt[] }));
  const assigned = new Set(modules.flatMap(module => module.files));
  const missing = files.filter(file => /\b(?:class|record|enum)\s+\w+|\bdefault\s+[^;{]+\{/.test(file.content) && !assigned.has(file.path));
  if (missing.length) throw new Error(`Unassigned concrete Java files: ${missing.map(file => file.path).join(", ")}`);
  return modules.filter(module => module.files.length);
}

export function decodeModuleFiles(text: string, allowed: string[], apiKey: string): SourceFile[] {
  const value = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as { files?: SourceFile[] };
  if (!Array.isArray(value.files) || !value.files.length) throw new Error("The module response must contain production files.");
  const seen = new Set<string>();
  for (const file of value.files) {
    if (typeof file.path !== "string" || typeof file.content !== "string" || !allowed.includes(file.path) || seen.has(file.path)) throw new Error("The module response exceeds its declared write boundary.");
    seen.add(file.path);
    const expectedPackage = dirname(file.path).slice("src/main/java/".length).replaceAll("/", ".");
    if (!file.content.includes(`package ${expectedPackage};`) || /(?:Implementation|bootstrap) belongs to the evaluated Agent|throw new (?:global::System\.)?(?:UnsupportedOperationException|NotImplementedException)/.test(file.content) || apiKey && file.content.includes(apiKey)) throw new Error(`Invalid or unfinished module source: ${file.path}`);
    file.content = file.content.replaceAll("\r\n", "\n").trimEnd() + "\n";
  }
  return value.files;
}

export function javaApi(output: string, sources: SourceFile[]): { signatures: string[]; targets: VerificationFunction[] } {
  let path: string | undefined;
  let owner = "";
  const signatures: string[] = [], targets: VerificationFunction[] = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    const declaration = line.match(/\b(?:class|interface)\s+(com\.example\.[\w.$]+)/);
    if (declaration) {
      owner = declaration[1];
      path = `src/main/java/${owner.replaceAll(".", "/")}.java`;
    }
    if (!path || !line.startsWith("public ") || !line.endsWith(";") || !line.includes("(")) continue;
    const name = line.slice(0, line.indexOf("(")).split(/\s+/).at(-1)!;
    const source = (sources.find(file => file.path === path)?.content ?? "").replace(/"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, " ");
    const descriptor = lines[index + 1]?.trim().match(/^descriptor:\s*(\S+)/)?.[1];
    if (!descriptor) throw new Error(`Missing JVM method descriptor: ${owner}#${name}`);
    signatures.push(`${owner}#${/\bstatic\b/.test(line) ? "static " : ""}${name === owner ? "<init>" : name}${descriptor}`);
    if (/\babstract\b/.test(line)) continue;
    if (name === owner) {
      const typeName = owner.split(".").at(-1)!;
      if (new RegExp(`\\bpublic\\s+${typeName}\\s*(?:\\(|\\{)`).test(source)) targets.push({ path, name: "<init>", signature: descriptor });
    } else if (new RegExp(`(?<![\\w.$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\([^(){};]*\\)\\s*(?:throws\\s+[\\w.$,\\s]+)?\\{`).test(source)) targets.push({ path, name, signature: descriptor });
  }
  return { signatures: signatures.sort(), targets };
}

export function passed(groups: Group[] | undefined): boolean {
  return Boolean(groups?.length && groups.every(group => group.result?.status === "success"
    && group.result.functions.length === group.targets.length
    && group.result.functions.every(item => item.status === "passed" && item.executed && item.lineCoverage !== null)));
}

export async function sourcesAt(root: string, paths: string[]): Promise<SourceFile[]> {
  return Promise.all(paths.map(async path => ({ path, content: await readFile(join(root, path), "utf8") })));
}

export async function applyPendingSources(report: Pick<FullReport, "workspace" | "target" | "expectedHashes">, attempt: Attempt, checkpoint: () => Promise<void>) {
  for (const file of attempt.pending ?? []) {
    const temporary = join(report.workspace, "pending-module-source.java");
    await writeFile(temporary, file.content);
    await rename(temporary, join(report.target, file.path));
    report.expectedHashes[file.path] = digest(file.content);
    await checkpoint();
  }
  delete attempt.pending;
  await checkpoint();
}

export async function restoreModuleSources(report: Pick<FullReport, "workspace" | "target" | "expectedHashes">, module: Module, baseline: SourceFile[], compile: () => Promise<Execution>, checkpoint: () => Promise<void>) {
  module.status = "rolling-back";
  const attempt = module.attempts.at(-1)!;
  attempt.pending ??= baseline;
  await checkpoint();
  await applyPendingSources(report, attempt, checkpoint);
  module.rollbackCompile = await compile();
  await checkpoint();
  if (module.rollbackCompile.exitCode !== 0 || module.rollbackCompile.timedOut) throw new Error(`The project cannot compile after restoring ${module.id}; inspect its rollbackCompile evidence.`);
  module.status = "translation-failed";
  await checkpoint();
}

export function classifyIndependentEvaluation(execution: Execution, tests: { executed: number; passed: number; failed: number; skipped: number }, executionErrors: number, expected: number): string {
  if (Object.values(tests).some(value => !Number.isInteger(value) || value < 0) || execution.timedOut || executionErrors || tests.executed !== expected || tests.skipped || tests.passed + tests.failed !== expected || execution.exitCode !== 0 && !(execution.exitCode === 1 && tests.failed > 0)) return "hidden-execution-failure";
  return execution.exitCode === 0 && tests.passed === expected ? "passed" : "requirement-mismatch";
}

export async function assertProjectBoundary(report: Pick<FullReport, "target" | "baselineHashes" | "expectedHashes" | "modules">) {
  const current = await inventory(report.target);
  for (const [path, expected] of Object.entries(report.expectedHashes)) {
    const pending = report.modules.flatMap(module => module.attempts.at(-1)?.pending ?? []).find(file => file.path === path);
    if (current[path] !== expected && (!pending || current[path] !== digest(pending.content))) throw new Error(`Unexpected project modification: ${path}`);
  }
  const additional = Object.keys(current).filter(path => !(path in report.baselineHashes) && !path.startsWith("src/test/"));
  if (additional.length) throw new Error(`Undeclared project files: ${additional.join(", ")}`);
}

export function completeProjectObservation(observation: FunctionGroupTestRun | undefined, targets: VerificationFunction[]): boolean {
  return Boolean(observation && targets.length && observation.status === "success" && observation.exitCode === 0 && !observation.timedOut && !observation.executionErrors
    && observation.tests.executed > 0 && observation.tests.failed === 0 && observation.tests.skipped === 0
    && observation.functions.length === targets.length && observation.functions.every((item, index) => JSON.stringify(item.target) === JSON.stringify(targets[index]) && item.status === "passed" && item.executed && item.lineCoverage !== null));
}

export async function revalidateProject(target: string, language: string, requirement: string, targets: VerificationFunction[]): Promise<FunctionGroupTestRun> {
  if (!targets.length) throw new Error("A full project must expose executable targets.");
  const environment = await resolveTestEnvironment({ targetLanguage: language, targetProjectPath: target });
  const context = { runtime: { sourceLanguage: language, targetLanguage: language, sourceProjectPath: target, targetProjectPath: target,
    sourcePath: targets[0].path, targetPath: targets[0].path, targetFunction: targets[0], sourceDirectory: target, targetDirectory: target,
    testRoots: environment.testRoots, testRunner: environment.framework, targetTest: environment.targetTest,
    functionGroup: { schemaVersion: "3.1" as const, mode: "requirement" as const, sourceLanguage: language, targetLanguage: language, targetProjectPath: target, requirement, functions: targets.map(target => ({ target })) } } };
  return bindFunctionGroupTestRunner(context).run(await resolveTestPaths(context));
}

export async function readProcessCredential(): Promise<void> {
  const terminal = process.stdin.isTTY;
  if (terminal) process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  console.info("Credential input ready (echo disabled).");
  process.env.DEEPSEEK_API_KEY = await new Promise<string>((resolveCredential, reject) => {
    let received = false;
    input.once("line", line => { received = true; resolveCredential(line.trim()); input.close(); });
    input.once("close", () => { if (terminal) process.stdin.setRawMode(false); if (!received) reject(new Error("Credential input closed.")); });
  });
}

export async function verifyModuleGroups(options: { module: Module; targets: VerificationFunction[]; prefix: string; traces: string; target: string; language: string; requirement: string; model: ReturnType<typeof createTranslationVerifierChatModel>; apiKey: string; checkpoint: () => Promise<void> }): Promise<Group[]> {
  const { module, targets, prefix, traces, target, language, requirement, model, apiKey, checkpoint } = options;
  const groups: Group[] = [];
  for (let offset = 0; offset < targets.length; offset += 8) groups.push({ targets: targets.slice(offset, offset + 8), trace: join(traces, `${prefix}-${module.id}-${offset / 8 + 1}.jsonl`) });
  const holder = prefix === "final" ? (module.finalGroups = groups) : (module.attempts.at(-1)!.groups = groups);
  await checkpoint();
  const redact = (value: string) => apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  for (const group of holder) {
    const trace = createJsonlAgentTraceLogger(group.trace, [apiKey]);
    const host = createLangChainFunctionGroupAgentHost({ model, limits: { maxTurns: 64, maxDurationMs: 1_200_000, maxToolCalls: 320, maxToolCallsPerTurn: 12 },
      traceLogger: event => {
        trace(event);
        const observation = event.event === "host.revalidation.completed" ? event.observation : event.event === "tool.completed" && event.toolName === "run_function_group_tests" ? event.output : undefined;
        if (observation && typeof observation === "object" && "tests" in observation) { group.observation = observation as FunctionGroupTestRun; void checkpoint(); }
      } });
    try {
      group.result = await createFunctionGroupVerifier(host)({ schemaVersion: "3.1", mode: "requirement", sourceLanguage: language, targetLanguage: language, targetProjectPath: target,
        requirement: `${requirement}\n\nCurrent module: ${module.id}. Verify every listed public function, preserving all existing meaningful tests. Use injected ports or transports to test external adapters without claiming an unconfigured provider succeeds. Cover tenant boundaries, error paths and substantive behavior, not just construction or argument rejection. The unimplemented seams in other modules are dependency limitations; report them explicitly. For required result-returning operations assert they do not throw and then assert the required result, so escaped production exceptions are assertion failures. Keep behavior assertions and stop with evidence when a production defect is confirmed. JVM descriptors identify Java overloads; <init> means constructor. C# signatures include the declaring type. Hidden tests are unavailable and must not be accessed.`,
        functions: group.targets.map(subject => ({ target: subject })) }, "requirement-function-group", "verify");
    } catch (error) { group.error = redact(error instanceof Error ? error.message : String(error)); }
    await checkpoint();
    console.info(redact(JSON.stringify({ stage: "module-verification", module: module.id, phase: prefix, targets: group.targets.length, status: group.result?.status, reason: group.result?.reason, error: group.error })));
  }
  return holder;
}

async function inspectApi(target: string, files: SourceFile[]) {
  const executable = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "javap.exe" : "javap") : "javap";
  const result: ReturnType<typeof javaApi> = { signatures: [], targets: [] };
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = files.slice(offset, offset + 16);
    const classes = batch.map(file => file.path.slice("src/main/java/".length, -5).replaceAll("/", "."));
    const execution = await execute(target, executable, ["-public", "-s", "-classpath", "target/classes", ...classes]);
    if (execution.exitCode !== 0 || execution.timedOut || execution.stdout.length >= 60_000) throw new Error("Cannot inspect the complete module public API.");
    const api = javaApi(execution.stdout, batch);
    result.signatures.push(...api.signatures); result.targets.push(...api.targets);
  }
  return result;
}

async function evaluateFullJava(report: FullReport, materials: string, maven: string) {
  const evaluationRoot = join(report.workspace, "full-independent-evaluation");
  await mkdir(evaluationRoot, { recursive: true });
  const directory = await mkdtemp(join(evaluationRoot, "run-"));
  await cp(report.target, directory, { recursive: true, filter: path => path === report.target || path !== join(report.target, "src/test") && !["target", ".git", ".translation-verifier-tests"].includes(basename(path)) });
  await cp(join(materials, "java/hidden-tests/src/test/java"), join(directory, "src/test/java"), { recursive: true });
  const pomPath = join(directory, "pom.xml");
  let pom = await readFile(pomPath, "utf8");
  if (pom.includes("<dependencies>")) throw new Error("Unexpected dependencies in the frozen skeleton POM.");
  pom = pom.replace("</project>", '<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version><scope>test</scope></dependency><dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId><version>2.3.232</version><scope>test</scope></dependency></dependencies></project>')
    .replace("</plugins>", '<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.0</version><configuration><useModulePath>false</useModulePath></configuration></plugin></plugins>');
  await writeFile(pomPath, pom);
  const execution = await execute(directory, maven, ["-B", "-ntp", "clean", "test"], 360_000);
  const tests = { executed: 0, passed: 0, failed: 0, skipped: 0 }, reportPaths: string[] = [];
  let executionErrors = 0;
  for (const name of await readdir(join(directory, "target/surefire-reports")).catch(() => [] as string[])) {
    if (!/^TEST-.+\.xml$/.test(name)) continue;
    const path = join(directory, "target/surefire-reports", name), xml = await readFile(path, "utf8");
    const parsed = parseSurefireReport(xml);
    for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += parsed[key];
    executionErrors += parseExecutionErrors("junit", xml);
    reportPaths.push(path);
  }
  const reason = classifyIndependentEvaluation(execution, tests, executionErrors, 35);
  return { directory, execution, tests, executionErrors, reportPaths, reason, passed: reason === "passed" };
}

export async function runFullJavaProject(prepareOnly = false): Promise<FullReport> {
  if (!prepareOnly && process.env.TRANSLATION_VERIFIER_FULL_PROJECT_E2E !== "1") throw new Error("Set TRANSLATION_VERIFIER_FULL_PROJECT_E2E=1 for full real inference.");
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!prepareOnly && !apiKey) throw new Error("A process credential is required.");
  const redact = (text: string) => apiKey ? text.split(apiKey).join("[REDACTED]") : text;
  const workspace = resolve(process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR ?? "");
  if (!process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR) throw new Error("Use a new explicit TRANSLATION_VERIFIER_EXPERIMENT_DIR for the full project.");
  const assets = resolve(process.env.TRANSLATION_VERIFIER_ASSETS_ROOT ?? "experiments");
  const materials = join(assets, "asset-upgrade-test-materials-20261014");
  const original = join(materials, "java/target-project");
  const originalHashes = await inventory(original);
  const sourcePaths = Object.keys(originalHashes).filter(path => path.startsWith(`${SOURCE_ROOT}/`) && path.endsWith(".java"));
  if (sourcePaths.length !== 250) throw new Error("The complete existing 250-file Java skeleton is required.");
  const requirements = Object.keys(originalHashes).filter(path => /^requirements\/task-.*\.md$/.test(path)).sort();
  const requirement = (await sourcesAt(original, requirements)).map(file => `${file.path}\n${file.content}`).join("\n\n");
  const referenceSources = await Promise.all(REFERENCES.map(async path => {
    const source = await readFile(join(assets, "enterprise-asset-upgrade/reference-sources", path), "utf8");
    return { path, content: source.slice(0, 24_000), sourceSha256: digest(source) };
  }));
  const reportPath = join(workspace, "full-project-report.json");
  const modelName = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  const maven = process.env.TRANSLATION_VERIFIER_MAVEN ?? join(process.env.TRANSLATION_VERIFIER_RUNNER_DEPS!, "apache-maven-3.9.11/bin", process.platform === "win32" ? "mvn.cmd" : "mvn");
  let report: FullReport;
  try { report = JSON.parse(await readFile(reportPath, "utf8")) as FullReport; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const prepared = await runExistingAssetsWorkflow(true);
    report = { version: 3, language: "Java", model: modelName, workspace, target: prepared.target,
      seed: prepared.preparation.seed, commit: prepared.preparation.commit!, startedAt: new Date().toISOString(), status: "prepared", passed: false,
      requirementSha256: digest(requirement), baselineHashes: originalHashes, expectedHashes: { ...originalHashes },
      modules: planJavaModules(await sourcesAt(original, sourcePaths)),
      references: referenceSources.map(file => ({ path: file.path, sourceSha256: file.sourceSha256, suppliedSha256: digest(file.content), suppliedCharacters: file.content.length })) };
  }
  if (report.version !== 3 || report.language !== "Java" || report.workspace !== workspace || report.target !== join(workspace, "target-project")
    || report.model !== modelName || report.requirementSha256 !== digest(requirement)
    || JSON.stringify(report.baselineHashes) !== JSON.stringify(originalHashes)
    || JSON.stringify(report.references) !== JSON.stringify(referenceSources.map(file => ({ path: file.path, sourceSha256: file.sourceSha256, suppliedSha256: digest(file.content), suppliedCharacters: file.content.length })))) throw new Error("Full-project checkpoint inputs differ; preserve this run and choose a new directory.");
  const common = await execute(report.target, "git", ["rev-parse", "--git-common-dir"]);
  const [actual, expected] = await Promise.all([stat(resolve(report.target, common.stdout.trim()), { bigint: true }), stat(join(report.seed, ".git"), { bigint: true })]);
  const revision = await execute(report.target, "git", ["rev-parse", "HEAD"]);
  if (common.exitCode !== 0 || revision.stdout.trim() !== report.commit || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("Full-project target is not the recorded skeleton worktree.");
  let queue = Promise.resolve();
  const checkpoint = () => {
    queue = queue.then(async () => { await writeFile(`${reportPath}.tmp`, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 }); await rename(`${reportPath}.tmp`, reportPath); });
    void queue.catch(() => undefined);
    return queue;
  };
  await assertProjectBoundary(report);
  await checkpoint();
  await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: report.target });
  const harnessPath = join(report.target, ".translation-verifier-tests/maven/pom.xml");
  const harness = await readFile(harnessPath, "utf8");
  if (!harness.includes("<artifactId>h2</artifactId>")) {
    await writeFile(harnessPath, harness.replace("</dependencies>", '<dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId><version>2.3.232</version><scope>test</scope></dependency></dependencies>'));
  }
  const log = (value: unknown) => console.info(redact(JSON.stringify(value)));
  if (prepareOnly) { log({ stage: "full-project-prepared", modules: report.modules.map(module => ({ id: module.id, files: module.files.length })), reportPath }); return report; }
  const model = createTranslationVerifierChatModel({ apiKey: () => apiKey, model: modelName, maxOutputTokens: 32_768, temperature: 0,
    request: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(360_000)]) }) });
  const traces = join(workspace, "full-traces");
  await mkdir(traces, { recursive: true });
  const verify = async (module: Module, targets: VerificationFunction[], prefix: string): Promise<Group[]> => {
    return verifyModuleGroups({ module, targets, prefix, traces, target: report.target, language: "Java", requirement: `${requirement}\nThe Host Maven harness includes JUnit Jupiter and H2 2.3.232 for real JDBC tests.`, model, apiKey, checkpoint });
  };
  for (const module of report.modules) {
    const baselineSources = await sourcesAt(original, module.files);
    if (module.status === "rolling-back" || module.status === "translation-failed" && module.attempts.at(-1)?.pending) {
      await restoreModuleSources(report, module, baselineSources, () => execute(report.target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "package"]), checkpoint);
    }
    if (["translated", "verified", "translation-failed", "data-contract"].includes(module.status)) continue;
    for (let round = module.attempts.at(-1)?.status === "running" ? module.attempts.length : module.attempts.length + 1; round <= 3; round++) {
      let attempt = module.attempts.at(-1);
      if (!attempt || attempt.status !== "running") { attempt = { round, startedAt: new Date().toISOString(), status: "running" }; module.attempts.push(attempt); }
      module.status = "translating"; report.status = `translating:${module.id}`;
      await checkpoint();
      log({ stage: "translate-module", module: module.id, round, files: module.files.length, reportPath });
      try {
        if (!attempt.pending && !attempt.compile) {
          module.baselineApi ??= (await inspectApi(report.target, await sourcesAt(report.target, module.files))).signatures;
          attempt.api = module.baselineApi;
          const prior = module.attempts.slice(0, -1).at(-1);
          const response = await model.invoke([
            { role: "system", content: "Implement one module of the complete existing 250-file Java project. Return ONLY JSON {\"files\":[{\"path\":\"declared project-relative path\",\"content\":\"complete Java file\"}]}. Only declared files may change. Preserve all original packages, public types, methods, constructors, records, enums and interface boundaries; add meaningful public APIs to empty utility seams where required. Implement every executable seam in the module and retain no placeholder/no-op substitute. A record/interface/enum needs no artificial behavior. Keep external providers behind injected clients, fail explicitly when unconfigured, implement usable local behavior. Use Java21 and JDK APIs; do not add dependencies or change build files. References are partial design evidence; public target requirements define behavior. No hidden tests or hidden feedback are available." },
            { role: "user", content: `Module ${module.id}; writable files: ${JSON.stringify(module.files)}\nFull public requirements:\n${requirement}\nOriginal module contract:\n${baselineSources.map(file => `${file.path}\n${file.content}`).join("\n\n")}\nCurrent complete source context:\n${(await sourcesAt(report.target, sourcePaths)).map(file => `${file.path}\n${file.content}`).join("\n\n")}\nReference excerpts (first 24000 characters maximum per source):\n${referenceSources.map(file => `${file.path}\n${file.content}`).join("\n\n")}\n${prior ? `Previous public compile and verifier feedback:\n${JSON.stringify({ compile: prior.compile, groups: prior.groups, error: prior.error }).slice(-80_000)}` : "Start from the untouched module skeleton."}` },
          ], { signal: AbortSignal.timeout(360_000) });
          const raw = (typeof (response as AIMessage).content === "string" ? response.content : JSON.stringify(response.content)).toString().trim();
          attempt.response = join(traces, `translation-${module.id}-${round}.json`); attempt.responseSha256 = digest(raw);
          await writeFile(attempt.response, redact(raw) + "\n", { mode: 0o600 });
          attempt.pending = decodeModuleFiles(raw, module.files, apiKey);
          await checkpoint();
        }
        if (attempt.pending) {
          await assertProjectBoundary(report);
          await applyPendingSources(report, attempt, checkpoint);
        }
        await assertProjectBoundary(report);
        const remaining = (await sourcesAt(report.target, module.files)).filter(file => /(?:Implementation|bootstrap) belongs to the evaluated Agent/.test(file.content));
        if (remaining.length) throw new Error(`Module retains executable placeholders: ${remaining.map(file => file.path).join(", ")}`);
        attempt.compile = await execute(report.target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "package"]);
        await checkpoint();
        if (attempt.compile.exitCode !== 0 || attempt.compile.timedOut) { attempt.status = attempt.compile.timedOut ? "compile-timeout" : /COMPILATION ERROR|cannot find symbol|incompatible types/.test(attempt.compile.stdout) ? "compile-failed" : "build-execution-failure"; await checkpoint(); continue; }
        const currentSources = await sourcesAt(report.target, module.files);
        const apiAfter = await inspectApi(report.target, currentSources);
        if (attempt.api?.some(signature => !apiAfter.signatures.includes(signature))) throw new Error("A declared public API was removed or changed.");
        const emptyUtilities = currentSources.filter(file => /\bclass\s+/.test(file.content) && !/\bextends\s+\w*Exception\b/.test(file.content) && !apiAfter.targets.some(target => target.path === file.path));
        if (emptyUtilities.length) throw new Error(`Concrete classes have no usable executable API: ${emptyUtilities.map(file => file.path).join(", ")}`);
        if (apiAfter.targets.length) {
          await verify(module, apiAfter.targets, `round-${round}`);
          attempt.status = passed(attempt.groups) ? "verified" : "verification-failed";
          module.status = attempt.status === "verified" ? "verified" : round === 3 ? "translated" : "translating";
        } else { attempt.status = "data-contract"; module.status = "data-contract"; }
        await checkpoint();
        if (module.status !== "translating") break;
      } catch (error) { attempt.error = redact(error instanceof Error ? error.message : String(error)); attempt.status = "failed"; await checkpoint(); }
    }
    if (module.status === "translating") {
      module.attempts.at(-1)!.pending = baselineSources;
      await restoreModuleSources(report, module, baselineSources, () => execute(report.target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "package"]), checkpoint);
    }
    await checkpoint();
  }
  report.status = "integration";
  report.integrationCompile = await execute(report.target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "clean", "package"]);
  await checkpoint();
  if (report.integrationCompile.exitCode === 0 && !report.integrationCompile.timedOut) {
    for (const module of report.modules) {
      if (module.status === "translation-failed" || module.status === "data-contract") continue;
      if (!passed(module.finalGroups)) await verify(module, (await inspectApi(report.target, await sourcesAt(report.target, module.files))).targets, "final");
    }
    report.finalTargets = (await inspectApi(report.target, await sourcesAt(report.target, report.modules.flatMap(module => module.files)))).targets;
    if (report.finalTargets.length) {
      try { report.finalObservation = await revalidateProject(report.target, "Java", requirement, report.finalTargets); delete report.finalError; }
      catch (error) { delete report.finalObservation; report.finalError = redact(String(error)); }
      await checkpoint();
    }
    report.smoke = await execute(report.target, "java", ["-cp", "target/classes", "com.example.assetupgrade.AssetUpgradeGateway"], 30_000);
    await checkpoint();
    if (!report.hidden) { report.hidden = await evaluateFullJava(report, materials, maven); await checkpoint(); }
  }
  await assertProjectBoundary(report);
  report.remainingPlaceholders = (await sourcesAt(report.target, sourcePaths)).filter(file => /(?:Implementation|bootstrap) belongs to the evaluated Agent/.test(file.content)).map(file => file.path);
  report.passed = report.integrationCompile.exitCode === 0 && !report.integrationCompile.timedOut && report.smoke?.exitCode === 0 && !report.smoke.timedOut
    && report.remainingPlaceholders.length === 0 && report.hidden?.passed === true
    && completeProjectObservation(report.finalObservation, report.finalTargets ?? [])
    && report.modules.every(module => module.status === "data-contract" || module.status !== "translation-failed" && passed(module.finalGroups));
  report.status = report.passed ? "passed" : "incomplete"; report.finishedAt = new Date().toISOString();
  report.reason = report.passed ? "passed" : report.integrationCompile.exitCode !== 0 || report.integrationCompile.timedOut ? "build-execution-failure" : report.hidden && !report.hidden.passed && "reason" in report.hidden ? String(report.hidden.reason) : "module-verification-incomplete";
  await checkpoint();
  log({ stage: "full-project-result", passed: report.passed, modules: report.modules.map(module => ({ id: module.id, status: module.status })), hiddenTests: report.hidden?.tests, remainingPlaceholders: report.remainingPlaceholders, reportPath });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    if (process.argv.includes("--credential-stdin")) {
      await readProcessCredential();
    }
    const report = await runFullJavaProject(process.argv.includes("--prepare-only"));
    if (!process.argv.includes("--prepare-only") && !report.passed) process.exitCode = 1;
  };
  run().catch(error => {
    const secret = process.env.DEEPSEEK_API_KEY;
    console.error(secret ? String(error).split(secret).join("[REDACTED]") : String(error));
    process.exitCode = 1;
  });
}
