import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AIMessage } from "@langchain/core/messages";
import { createFunctionGroupVerifier } from "../src/function-group-verify.js";
import { createTranslationVerifierChatModel } from "../src/host/agent/chat-model.js";
import { createLangChainFunctionGroupAgentHost } from "../src/host/agent/langchain-runtime.js";
import { createJsonlAgentTraceLogger } from "../src/host/logging/trace-log.js";
import { createJsonlAgentWorkLogger } from "../src/host/logging/work-log.js";
import { parseExecutionErrors, parseSurefireReport } from "../src/host/testing/coverage-reports.js";
import { targetProcessCommand } from "../src/host/testing/process-command.js";
import type { FunctionGroupTestRun } from "../src/host/tools/common.js";
import type { FunctionGroupVerificationResult, RequirementFunctionGroupVerificationInput } from "../src/types.js";

const MODULE = "attachment-intake-release";
const JAVA_ROOT = "src/main/java/com/example/assetupgrade";
const PRODUCTION_FILE = `${JAVA_ROOT}/attachment/AttachmentIntakeHandler.java`;
const TARGETS = ["intake", "release", "execute"];
const REFERENCE_FILES = [
  "commons-fileupload/commons-fileupload2-core/src/main/java/org/apache/commons/fileupload2/core/AbstractFileUpload.java",
  "commons-fileupload/commons-fileupload2-core/src/main/java/org/apache/commons/fileupload2/core/DiskFileItem.java",
  "keycloak/services/src/main/java/org/keycloak/services/resources/admin/fgap/RealmAuth.java",
  "flowable-engine/modules/flowable-engine/src/main/java/org/flowable/engine/impl/cmd/CompleteTaskCmd.java",
  "bullmq/src/commands/addStandardJob-9.lua",
];

export type Execution = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
type FailureReason = "environment-failure" | "translation-compile-failure" | "model-network-failure" | "model-output-failure" | "host-budget-failure" | "verification-execution-failure" | "verification-incomplete" | "coverage-unavailable" | "production-defect" | "hidden-execution-failure" | "requirement-mismatch";
type Attempt = {
  round: number; startedAt: string; responsePath?: string; responseSha256?: string;
  implementationSha256?: string; pendingImplementationSha256?: string; compile?: Execution; verifier?: FunctionGroupVerificationResult;
  observation?: FunctionGroupTestRun; error?: string; reason?: FailureReason;
};
type Report = {
  version: 1; module: string; model: string; assetsRoot: string; workspace: string; target: string;
  startedAt: string; finishedAt?: string; status: string; passed: boolean; reason?: FailureReason | "verified"; error?: string;
  scope: { writableProductionFiles: string[]; targetFunctions: string[]; limitations: string[] };
  baselineHashes: Record<string, string>; references: Array<{ path: string; sha256: string; characters: number }>;
  requirementSha256: string;
  preparation: { seed: string; commit?: string; state: "copying" | "committed" | "ready" };
  toolchain?: Execution; baselineCompile?: Execution; baselinePublicApi?: string[]; attempts: Attempt[];
  hiddenEvaluation?: { directory: string; execution: Execution; tests: { executed: number; passed: number; failed: number; skipped: number }; executionErrors: number; reportPaths: string[]; passed: boolean };
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const secretRedactor = (secret: string) => (text: string) => secret ? text.split(secret).join("[REDACTED]") : text;
const responseText = (message: AIMessage) => typeof message.content === "string" ? message.content : message.content.map(part => "text" in part ? String(part.text) : "").join("");

function failureReason(error: unknown, phase: string): FailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "reason" in error) {
    if (error.reason === "model") return "model-network-failure";
    if (error.reason === "budget" || error.reason === "context") return "host-budget-failure";
  }
  if (/budget|limit reached|context.*exceed|timed?\s*out|timeout/i.test(message) && phase === "verification") return "host-budget-failure";
  if (phase === "translation" || /network|fetch failed|connection|socket|\bHTTP\b|\b(?:401|403|408|429|5\d\d)\b|model request/i.test(message)) return "model-network-failure";
  if (phase === "output") return "model-output-failure";
  if (phase === "compile") return "environment-failure";
  return "verification-execution-failure";
}

function compileFailure(execution: Execution): FailureReason {
  return !execution.timedOut && /COMPILATION ERROR|cannot find symbol|incompatible types|illegal start|';' expected|does not override|not abstract and does not override/i.test(execution.stdout + execution.stderr)
    ? "translation-compile-failure" : "environment-failure";
}

function verificationFailure(attempt: Attempt): FailureReason {
  if (attempt.observation?.timedOut || attempt.verifier?.reason === "agent-timeout") return "host-budget-failure";
  if (attempt.observation?.executionErrors || attempt.verifier?.reason === "test-environment-failure") return "verification-execution-failure";
  if (attempt.verifier?.reason === "model-failure") return "model-network-failure";
  if (attempt.verifier?.reason === "coverage-unavailable") return "coverage-unavailable";
  if (attempt.observation && attempt.observation.tests.failed > 0 && !attempt.observation.executionErrors) return "production-defect";
  if (attempt.verifier?.issue?.kind === "translation") return "production-defect";
  return "verification-incomplete";
}

function testObservation(value: unknown): FunctionGroupTestRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<FunctionGroupTestRun>;
  return candidate.tests && typeof candidate.tests.executed === "number" && Array.isArray(candidate.functions)
    ? candidate as FunctionGroupTestRun : undefined;
}

async function recoverObservation(path: string): Promise<FunctionGroupTestRun | undefined> {
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let latest: FunctionGroupTestRun | undefined;
  for (const line of content.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (event.event === "host.revalidation.completed") latest = testObservation(event.observation) ?? latest;
    if (event.event === "tool.completed" && event.toolName === "run_function_group_tests") latest = testObservation(event.output) ?? latest;
  }
  return latest;
}

export async function execute(cwd: string, executable: string, args: string[], timeoutMs = 240_000): Promise<Execution> {
  const command = targetProcessCommand(executable, args);
  return new Promise(resolveExecution => {
    let stdout = "", stderr = "", timedOut = false;
    const child = spawn(command.executable, command.args, { cwd, shell: false, windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", bytes => { stdout = (stdout + String(bytes)).slice(-60_000); });
    child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-30_000); });
    child.on("error", error => { stderr += error.message; });
    child.on("close", exitCode => { clearTimeout(timer); resolveExecution({ exitCode, stdout, stderr, timedOut }); });
  });
}

export async function inventory(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["target", "bin", "obj", "TestResults", ".git", ".translation-verifier-tests", "node_modules"].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Experiment inputs must not contain links: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output[relative(root, absolute).replaceAll("\\", "/")] = hash(await readFile(absolute, "utf8"));
    }
  }
  await visit(root);
  return output;
}

async function assertProductionBoundary(report: Report) {
  const current = await inventory(report.target);
  for (const [path, expected] of Object.entries(report.baselineHashes)) {
    if (path !== PRODUCTION_FILE && current[path] !== expected) throw new Error(`Protected target file changed: ${path}`);
  }
  const added = Object.keys(current).filter(path => path.startsWith("src/main/") && !(path in report.baselineHashes));
  if (added.length) throw new Error(`Undeclared production files: ${added.join(", ")}`);
}

async function git(directory: string, args: string[]): Promise<string> {
  const execution = await execute(directory, "git", args);
  if (execution.exitCode !== 0 || execution.timedOut) throw new Error(`Git preparation failed: ${execution.stderr || execution.stdout}`);
  return execution.stdout.trim();
}

export async function prepareWorktree(report: Pick<Report, "preparation" | "workspace" | "target" | "baselineHashes" | "status">, original: string, checkpoint: () => Promise<void>) {
  const preparation = report.preparation;
  if (dirname(resolve(preparation.seed)) !== report.workspace || !basename(preparation.seed).startsWith("skeleton-seed-")) throw new Error("Checkpoint seed is outside the experiment directory.");
  if (preparation.state === "copying") {
    if ((await readdir(preparation.seed)).length) {
      preparation.seed = await mkdtemp(join(report.workspace, "skeleton-seed-"));
      await checkpoint();
    }
    await cp(original, preparation.seed, { recursive: true, filter: path => path === original || !["target", "bin", "obj", "TestResults", ".git", ".translation-verifier-tests"].includes(basename(path)) });
    if (JSON.stringify(await inventory(preparation.seed)) !== JSON.stringify(report.baselineHashes)) throw new Error("Skeleton seed differs from the frozen original.");
    await git(preparation.seed, ["init", "--quiet"]);
    await git(preparation.seed, ["config", "core.autocrlf", "false"]);
    await git(preparation.seed, ["config", "core.safecrlf", "false"]);
    await git(preparation.seed, ["config", "core.longpaths", "true"]);
    await git(preparation.seed, ["add", "--all", "--force"]);
    await git(preparation.seed, ["-c", "user.name=Translation Verifier", "-c", "user.email=translation-verifier@localhost", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Record the frozen existing skeleton"]);
    preparation.commit = await git(preparation.seed, ["rev-parse", "HEAD"]);
    preparation.state = "committed";
    await checkpoint();
  }
  if (!preparation.commit || await git(preparation.seed, ["rev-parse", "HEAD"]) !== preparation.commit
    || await git(preparation.seed, ["status", "--porcelain", "--untracked-files=all"])
    || JSON.stringify(await inventory(preparation.seed)) !== JSON.stringify(report.baselineHashes)) throw new Error("Frozen skeleton repository changed after preparation.");
  const targetExists = await stat(report.target).then(() => true, () => false);
  if (!targetExists) {
    if (preparation.state === "ready") throw new Error("Prepared target worktree is missing.");
    await git(preparation.seed, ["worktree", "prune"]);
    await git(preparation.seed, ["worktree", "add", "--detach", "--no-checkout", report.target, preparation.commit]);
  }
  const commonDirectory = resolve(report.target, await git(report.target, ["rev-parse", "--git-common-dir"]));
  const [actualRepository, expectedRepository] = await Promise.all([stat(commonDirectory, { bigint: true }), stat(join(preparation.seed, ".git"), { bigint: true })]);
  if (actualRepository.dev !== expectedRepository.dev || actualRepository.ino !== expectedRepository.ino
    || await git(report.target, ["rev-parse", "HEAD"]) !== preparation.commit) throw new Error("Target is not the checkpoint's detached skeleton worktree.");
  if (preparation.state !== "ready") {
    for (const [path, digest] of Object.entries(await inventory(report.target))) {
      if (report.baselineHashes[path] !== digest) throw new Error(`Incomplete worktree contains unexpected content: ${path}`);
    }
    await git(report.target, ["reset", "--hard", preparation.commit]);
    if (JSON.stringify(await inventory(report.target)) !== JSON.stringify(report.baselineHashes)) throw new Error("Prepared worktree differs from the frozen original.");
    preparation.state = "ready";
    report.status = "prepared";
    await checkpoint();
  }
}

async function publicApi(target: string): Promise<string[]> {
  const javap = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "javap.exe" : "javap") : "javap";
  const result = await execute(target, javap, ["-public", "-classpath", "target/classes", "com.example.assetupgrade.attachment.AttachmentIntakeHandler"]);
  if (result.exitCode !== 0) throw new Error(`Cannot inspect the compiled public API: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith("public "));
}

async function contracts(target: string): Promise<string> {
  const pending = [PRODUCTION_FILE];
  const found = new Set<string>();
  const documents: string[] = [];
  while (pending.length) {
    const path = pending.shift()!;
    if (found.has(path)) continue;
    found.add(path);
    const text = await readFile(join(target, path), "utf8");
    documents.push(`${path}\n${text}`);
    for (const match of text.matchAll(/com\.example\.assetupgrade(?:\.[a-z][\w]*)*\.[A-Z][\w]*/g)) {
      pending.push(`src/main/java/${match[0].replaceAll(".", "/")}.java`);
    }
    const directory = dirname(path);
    for (const entry of await readdir(join(target, directory))) {
      if (!entry.endsWith(".java")) continue;
      const type = entry.slice(0, -5);
      if (new RegExp(`\\b${type}\\b`).test(text)) pending.push(`${directory.replaceAll("\\", "/")}/${entry}`);
    }
  }
  return documents.join("\n\n");
}

function hiddenExecutionComplete(hidden: NonNullable<Report["hiddenEvaluation"]>): boolean {
  const counts = Object.values(hidden.tests);
  return counts.every(value => Number.isInteger(value) && value >= 0)
    && hidden.tests.executed === 6 && hidden.tests.skipped === 0
    && hidden.tests.passed + hidden.tests.failed === hidden.tests.executed && hidden.executionErrors === 0
    && !hidden.execution.timedOut && (hidden.execution.exitCode === 0 || hidden.execution.exitCode === 1 && hidden.tests.failed > 0);
}

async function evaluateHidden(report: Report, materials: string, maven: string) {
  const evaluationRoot = join(report.workspace, "independent-evaluation");
  await mkdir(evaluationRoot, { recursive: true });
  const directory = await mkdtemp(join(evaluationRoot, `run-${report.attempts.length}-`));
  await cp(report.target, directory, { recursive: true, filter: path => path === report.target || !["target", ".translation-verifier-tests", ".git"].includes(basename(path)) });
  await cp(join(materials, "java/hidden-tests/src/test/java"), join(directory, "src/test/java"), { recursive: true });
  const pomPath = join(directory, "pom.xml");
  let pom = await readFile(pomPath, "utf8");
  if (pom.includes("<dependencies>")) throw new Error("The frozen evaluator expects the existing dependency-free skeleton POM.");
  pom = pom.replace("</project>", `<dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version><scope>test</scope></dependency>
    <dependency><groupId>com.h2database</groupId><artifactId>h2</artifactId><version>2.3.232</version><scope>test</scope></dependency>
  </dependencies></project>`).replace("</plugins>", `<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.0</version><configuration><useModulePath>false</useModulePath></configuration></plugin></plugins>`);
  await writeFile(pomPath, pom);
  const execution = await execute(directory, maven, ["-B", "-ntp", "-Dtest=AttachmentHiddenTest", "test"]);
  const tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
  const reportPaths: string[] = [];
  let executionErrors = 0;
  for (const name of await readdir(join(directory, "target/surefire-reports")).catch(() => [] as string[])) {
    if (!name.startsWith("TEST-") || !name.endsWith(".xml")) continue;
    const path = join(directory, "target/surefire-reports", name);
    const xml = await readFile(path, "utf8");
    const parsed = parseSurefireReport(xml);
    for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += parsed[key];
    executionErrors += parseExecutionErrors("junit", xml);
    reportPaths.push(path);
  }
  const result = { directory, execution, tests, executionErrors, reportPaths, passed: false };
  result.passed = hiddenExecutionComplete(result) && execution.exitCode === 0 && tests.passed === 6;
  return result;
}

export async function runExistingAssetsWorkflow(prepareOnly = false): Promise<Report> {
  if (!prepareOnly && process.env.TRANSLATION_VERIFIER_LIVE_E2E !== "1") throw new Error("Set TRANSLATION_VERIFIER_LIVE_E2E=1 to enable real inference.");
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!prepareOnly && !apiKey) throw new Error("DEEPSEEK_API_KEY is required.");
  const redact = secretRedactor(apiKey);
  const assets = resolve(process.env.TRANSLATION_VERIFIER_ASSETS_ROOT ?? "experiments");
  const materials = join(assets, "asset-upgrade-test-materials-20261014");
  const original = join(materials, "java/target-project");
  const referencesRoot = join(assets, "enterprise-asset-upgrade/reference-sources");
  const runtime = process.env.TRANSLATION_VERIFIER_RUNNER_DEPS ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "translation-verifier-runtime");
  const workspace = resolve(process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR ?? join(runtime, "experiments/existing-java"));
  const target = join(workspace, "target-project");
  const reportPath = join(workspace, "report.json");
  const modelName = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  const maven = process.env.TRANSLATION_VERIFIER_MAVEN ?? (process.platform === "win32" ? join(runtime, "apache-maven-3.9.11/bin/mvn.cmd") : "mvn");
  const maxRounds = Number(process.env.TRANSLATION_VERIFIER_TRANSLATION_ROUNDS ?? "4");
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) throw new Error("Translation rounds must be between 1 and 8.");
  const initial = await inventory(original);
  const taskRequirement = await readFile(join(original, "requirements/task-attachment-quarantine.md"), "utf8");
  const engineeringRequirement = await readFile(join(original, "requirements/task-full-engineering-coverage.md"), "utf8");
  const requirement = `${taskRequirement}\n\nFull public engineering context:\n${engineeringRequirement}\n\nScope for this run: AttachmentIntakeHandler.intake, release and execute, using its declared injected ports. Implement application policy through these entry points; other concrete helpers and provider adapters are outside this run. Existing public records, enums, interfaces and both constructors must remain compatible. Follow the public task's scan-before-approval policy and do not release during intake. Preserve failure evidence and do not treat unconfigured dependencies as successful providers.`;
  const requirementSha256 = hash(requirement);
  const matrix = JSON.parse(await readFile(join(assets, "enterprise-asset-upgrade/tasks/coverage-matrix.json"), "utf8")) as { rows: Array<{ taskId: string }> };
  const mapping = matrix.rows.find(row => row.taskId === "attachment-quarantine");
  if (!mapping) throw new Error("The existing attachment coverage mapping is missing.");
  const references = await Promise.all(REFERENCE_FILES.map(async path => {
    const text = await readFile(join(referencesRoot, path), "utf8");
    return { path, text, sha256: hash(text) };
  }));
  let report: Report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")) as Report; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await stat(target).then(() => true, () => false)) throw new Error(`Target exists without a checkpoint: ${target}`);
    const skeleton = await readFile(join(original, PRODUCTION_FILE), "utf8");
    if (!skeleton.includes("Implementation belongs to the evaluated Agent")) throw new Error("The existing target is not the expected pure skeleton.");
    await mkdir(workspace, { recursive: true });
    report = { version: 1, module: MODULE, model: modelName, assetsRoot: assets, workspace, target,
      startedAt: new Date().toISOString(), status: "preparing", passed: false, baselineHashes: initial,
      preparation: { seed: await mkdtemp(join(workspace, "skeleton-seed-")), state: "copying" },
      scope: { writableProductionFiles: [PRODUCTION_FILE], targetFunctions: TARGETS,
        limitations: ["Only the attachment intake/release application boundary is evaluated; other concrete skeleton modules remain unimplemented.", "Declared ports are injected dependencies; this run does not certify external providers or the complete project.", "Hidden tests are isolated and never supplied to translation or verification models."] },
      references: references.map(({ path, sha256, text }) => ({ path, sha256, characters: text.length })), requirementSha256, attempts: [] };
  }
  if (report.version !== 1 || report.module !== MODULE || report.workspace !== workspace || report.assetsRoot !== assets || report.model !== modelName) throw new Error("Checkpoint configuration differs from this run.");
  if (!report.preparation) throw new Error("This historical copy-based experiment has no Git worktree checkpoint; preserve it and use a new experiment directory.");
  if (report.target !== target) throw new Error("Checkpoint target differs from this experiment directory.");
  if (report.requirementSha256 !== requirementSha256) throw new Error("Checkpoint public requirements differ from this run; use a new experiment directory.");
  if (JSON.stringify(report.baselineHashes) !== JSON.stringify(initial)) throw new Error("Original project changed after the checkpoint was created.");
  if (report.references.some((entry, index) => entry.path !== references[index]?.path || entry.sha256 !== references[index]?.sha256)) throw new Error("Reference sources changed after the checkpoint was created.");
  const save = async () => {
    await writeFile(`${reportPath}.tmp`, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 });
    await rename(`${reportPath}.tmp`, reportPath);
  };
  let saveQueue = Promise.resolve();
  const checkpoint = () => {
    saveQueue = saveQueue.then(save);
    void saveQueue.catch(() => undefined);
    return saveQueue;
  };
  await checkpoint();
  await prepareWorktree(report, original, checkpoint);
  const lastImplementation = [...report.attempts].reverse().find(attempt => attempt.implementationSha256);
  const pendingAttempt = [...report.attempts].reverse().find(attempt => attempt.pendingImplementationSha256);
  const currentImplementation = hash(await readFile(join(target, PRODUCTION_FILE), "utf8"));
  const previousImplementation = lastImplementation?.implementationSha256 ?? report.baselineHashes[PRODUCTION_FILE];
  if (pendingAttempt && currentImplementation === pendingAttempt.pendingImplementationSha256) {
    pendingAttempt.implementationSha256 = pendingAttempt.pendingImplementationSha256;
    delete pendingAttempt.pendingImplementationSha256;
  } else if (currentImplementation === previousImplementation) {
    if (pendingAttempt) delete pendingAttempt.pendingImplementationSha256;
  } else throw new Error("The checkpoint implementation changed outside the model write boundary.");
  await checkpoint();
  await assertProductionBoundary(report);
  report.toolchain = await execute(target, maven, ["-v"]);
  if (report.toolchain.exitCode !== 0 || !/Java version:\s*21(?:[.\s,]|$)/i.test(report.toolchain.stdout + report.toolchain.stderr)) {
    report.status = "environment-failure"; report.reason = "environment-failure"; await checkpoint(); throw new Error(`Maven must use Java 21. See ${reportPath}`);
  }
  if (!report.baselineCompile) {
    report.baselineCompile = await execute(target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "package"]);
    await checkpoint();
  }
  if (report.baselineCompile.exitCode !== 0) {
    report.status = "environment-failure"; report.reason = "environment-failure"; await checkpoint();
    throw new Error(`Existing skeleton does not compile. See ${reportPath}`);
  }
  if (!report.baselinePublicApi) {
    if (report.attempts.length) throw new Error("The checkpoint predates the public API baseline; start in a new experiment directory.");
    report.baselinePublicApi = await publicApi(target);
    await checkpoint();
  }
  if (prepareOnly) { console.info(JSON.stringify({ stage: "prepared", reportPath, target })); return report; }
  const model = createTranslationVerifierChatModel({ apiKey: () => apiKey, model: modelName,
    apiBase: process.env.DEEPSEEK_API_BASE, maxOutputTokens: 24_576, temperature: 0,
    request: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(300_000),
    ]) }) });
  const traceRoot = join(workspace, "traces");
  await mkdir(traceRoot, { recursive: true });
  for (const attempt of report.attempts) {
    attempt.observation ??= await recoverObservation(join(traceRoot, `verifier-${attempt.round}.jsonl`));
    if (attempt.error && !attempt.reason) attempt.reason = failureReason(attempt.error, "verification");
  }
  const accepted = () => {
    const latest = report.attempts.at(-1);
    return latest?.verifier?.status === "success" && latest.verifier.functions.length === TARGETS.length && latest.verifier.functions.every(item => item.executed && item.status === "passed" && item.lineCoverage !== null);
  };
  const latestAttempt = report.attempts.at(-1);
  const resumable = latestAttempt && !latestAttempt.verifier && !latestAttempt.error ? latestAttempt : undefined;
  for (let round = resumable?.round ?? report.attempts.length + 1; !accepted() && round <= maxRounds; round++) {
    const attempt: Attempt = resumable?.round === round ? resumable : { round, startedAt: new Date().toISOString() };
    const previous = report.attempts.filter(item => item !== attempt).at(-1);
    if (attempt !== resumable) report.attempts.push(attempt);
    report.status = attempt.implementationSha256 ? "compiling" : "translating"; report.reason = undefined; report.passed = false;
    delete report.hiddenEvaluation;
    await checkpoint();
    console.info(JSON.stringify({ stage: "translate", module: MODULE, round, reportPath }));
    let phase = "translation";
    try {
      if (!attempt.implementationSha256) {
        const response = await model.invoke([
          { role: "system", content: "Implement the requested existing Java application module from its pure skeleton using only public requirements and reference repository patterns. Return ONLY JSON {\"files\":[{\"path\":\"declared project-relative production path\",\"content\":\"complete Java source\"}]}. Exactly one production file is writable. Preserve package, public class, implemented interface, both public constructors, public methods and their signatures; imports and private helpers may be added. Do not generate tests, change build configuration, edit dependencies, write files outside the declaration, fabricate provider success, or retain placeholder methods. References are design evidence, not the target's exact behavior specification. No hidden tests are available." },
          { role: "user", content: `Writable production files: ${JSON.stringify([PRODUCTION_FILE])}\nRequirements:\n${requirement}\nExisting reference coverage mapping:\n${JSON.stringify(mapping)}\nReference production sources:\n${references.map(item => `${item.path}\n${item.text}`).join("\n\n")}\nExisting target and transitive API contracts:\n${await contracts(target)}\n${previous ? `Previous public compile/verifier feedback:\n${JSON.stringify({ compile: previous.compile, verifier: previous.verifier, observation: previous.observation, error: previous.error }).slice(-55_000)}` : "Implement from the original pure skeleton."}` },
        ], { signal: AbortSignal.timeout(300_000) });
        const raw = responseText(response).trim();
        phase = "output";
        attempt.responsePath = join(traceRoot, `translation-${round}.json`);
        attempt.responseSha256 = hash(raw);
        await writeFile(attempt.responsePath, redact(raw) + "\n", { mode: 0o600 });
        const decoded = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as { files?: Array<{ path: string; content: string }> };
        if (!Array.isArray(decoded.files) || decoded.files.length !== 1 || decoded.files[0]?.path !== PRODUCTION_FILE || typeof decoded.files[0].content !== "string") throw new Error("Model output does not match the single declared production file.");
        const code = decoded.files[0].content;
        if (!code.includes("package com.example.assetupgrade.attachment;") || !/public\s+final\s+class\s+AttachmentIntakeHandler\s+implements\s+AttachmentIntakeService/.test(code) || code.includes("Implementation belongs to the evaluated Agent") || code.includes(apiKey)) throw new Error("Model output changed the public class contract, retained a placeholder, or exposed a credential.");
        const source = code.replaceAll("\r\n", "\n") + "\n";
        const pendingSource = join(workspace, "pending-implementation.java");
        await writeFile(pendingSource, source);
        attempt.pendingImplementationSha256 = hash(source);
        await checkpoint();
        await rename(pendingSource, join(target, PRODUCTION_FILE));
        attempt.implementationSha256 = attempt.pendingImplementationSha256;
        delete attempt.pendingImplementationSha256;
        await checkpoint();
      }
      await assertProductionBoundary(report);
      phase = "compile";
      attempt.compile = await execute(target, maven, ["-B", "-ntp", "-Dmaven.test.skip=true", "package"]);
      attempt.reason = attempt.compile.exitCode === 0 && !attempt.compile.timedOut ? undefined : compileFailure(attempt.compile);
      report.status = "verifying"; report.reason = attempt.reason; await checkpoint();
      if (attempt.compile.exitCode !== 0 || attempt.compile.timedOut) continue;
      const implementedApi = await publicApi(target);
      if (report.baselinePublicApi.some(signature => !implementedApi.includes(signature))) {
        phase = "output";
        throw new Error("The model changed or removed an existing public API signature.");
      }
      phase = "verification";
      const trace = createJsonlAgentTraceLogger(join(traceRoot, `verifier-${round}.jsonl`), [apiKey]);
      const host = createLangChainFunctionGroupAgentHost({ model,
        limits: { maxTurns: 48, maxDurationMs: 1_200_000, maxToolCalls: 240, maxToolCallsPerTurn: 12 },
        workLogger: createJsonlAgentWorkLogger(join(traceRoot, `verifier-${round}-work.jsonl`)),
        traceLogger: event => {
          trace(event);
          const observation = event.event === "host.revalidation.completed" ? testObservation(event.observation)
            : event.event === "tool.completed" && event.toolName === "run_function_group_tests" ? testObservation(event.output) : undefined;
          if (observation) { attempt.observation = observation; void checkpoint(); }
        } });
      const verificationRequirement = `${requirement}\n\nTest reporting requirement: For public operations required to return a rejection or storage-failure result, invoke the operation inside assertDoesNotThrow, then assert its failure/result code and evidence. An unexpected escaped production exception must be an assertion failure with its stack trace, rather than an unhandled JUnit error. Keep every behavioral assertion; never catch an exception to declare success or weaken expected behavior. If the same production defect remains after confirming the test matches the public requirement, return a failure report with evidence and coverage instead of repeatedly rewriting the same test.`;
      const input: RequirementFunctionGroupVerificationInput = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "Java", targetLanguage: "Java", targetProjectPath: target, requirement: verificationRequirement,
        functions: TARGETS.map(name => ({ target: { path: PRODUCTION_FILE, name } })) };
      attempt.verifier = await createFunctionGroupVerifier(host)(input, "requirement-function-group", "verify");
      attempt.reason = attempt.verifier.status === "success" ? undefined : verificationFailure(attempt);
      await assertProductionBoundary(report);
    } catch (error) {
      attempt.error = redact(error instanceof Error ? error.message : String(error));
      attempt.reason = failureReason(error, phase);
      report.reason = attempt.reason;
    }
    await checkpoint();
    console.info(JSON.stringify({ stage: "module-result", round, status: attempt.verifier?.status, functions: attempt.verifier?.functions, error: attempt.error }));
  }
  await assertProductionBoundary(report);
  const latest = report.attempts.at(-1);
  report.reason = latest?.reason;
  if (latest?.implementationSha256 && hash(await readFile(join(target, PRODUCTION_FILE), "utf8")) !== latest.implementationSha256) throw new Error("The checkpoint implementation changed outside the model write boundary.");
  if (latest?.compile?.exitCode === 0 && !report.hiddenEvaluation) {
    report.status = "independent-evaluation"; await checkpoint();
    try { report.hiddenEvaluation = await evaluateHidden(report, materials, maven); }
    catch (error) { report.error = redact(error instanceof Error ? error.message : String(error)); report.reason = "hidden-execution-failure"; }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = accepted() && report.hiddenEvaluation?.passed === true;
  if (!report.hiddenEvaluation?.passed && report.hiddenEvaluation && !report.reason) {
    report.reason = !hiddenExecutionComplete(report.hiddenEvaluation) ? "hidden-execution-failure" : accepted() ? "requirement-mismatch" : "production-defect";
  }
  if (report.passed) { report.status = "passed"; report.reason = "verified"; }
  else { report.reason ??= latest ? verificationFailure(latest) : "verification-incomplete"; report.status = report.reason; }
  await checkpoint();
  console.info(JSON.stringify({ stage: "complete", passed: report.passed, reportPath, functions: latest?.verifier?.functions, hiddenTests: report.hiddenEvaluation?.tests }));
  if (!report.passed) throw new Error(`The attachment boundary is not fully verified. See ${reportPath}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExistingAssetsWorkflow(process.argv.includes("--prepare-only")).catch(error => {
    console.error(secretRedactor(process.env.DEEPSEEK_API_KEY ?? "")(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
