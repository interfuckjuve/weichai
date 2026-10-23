import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslationVerifierChatModel } from "../src/host/agent/chat-model.js";
import { csharpMethodRanges, matchesCsharpSignature } from "../src/host/testing/coverage-reports.js";
import { resolveTestEnvironment } from "../src/host/testing/test-environment.js";
import type { FunctionGroupTestRun } from "../src/host/tools/common.js";
import type { VerificationFunction } from "../src/types.js";
import { execute, inventory, prepareWorktree, type Execution } from "./existing-assets-workflow.js";
import { applyPendingSources, assertProjectBoundary, completeProjectObservation, passed, readProcessCredential, REFERENCES, restoreModuleSources, revalidateProject, sourcesAt, verifyModuleGroups, type Attempt, type Module, type SourceFile } from "./full-project-workflow.js";

const ROOT = "src/AssetUpgradeGateway/";
const MODULES = [
  ["contracts", "Contracts.cs", "ExtendedContracts.cs", "Ports.cs", "Ports/ExtendedPorts.cs"],
  ["domain", "Domain/AssetLifecycle.cs", "Domain/OrderLifecycle.cs", "Domain/DomainExtensions.cs"],
  ["policies", "Policies/AttachmentPolicies.cs", "Policies/OrderPolicies.cs", "Policies/WorkflowPolicies.cs", "Policies/AuthorizationAndQuotaPolicies.cs"],
  ["infrastructure", "Adapters/InMemoryAdapters.cs", "Adapters/AdditionalAdapters.cs", "Telemetry/TelemetryComponents.cs"],
  ["application-common", "Application/RequestNormalization.cs", "Application/ValidationPipeline.cs", "Application/HealthAndAuditServices.cs"],
  ["attachment", "Application/AttachmentIntakeService.cs"],
  ["workflow", "Application/WorkflowDeliveryCoordinator.cs"],
  ["order", "Application/OrderLifecycleService.cs", "Application/PluginRegistryService.cs"],
  ["reconciliation", "Application/ReconciliationOrchestrator.cs"],
  ["asset-lifecycle", "Application/AssetLifecycleCoordinator.cs"],
  ["compatibility-services", "AssetUpgradeService.cs", "OrderPluginBridge.cs", "ReconciliationService.cs"],
  ["bootstrap", "Program.cs"],
];
const ASSEMBLY_REQUIREMENT = "Additional explicit experiment requirement: Program.Main must compose the local in-memory adapters and application services, exercise one authorized local business operation, and print a readiness result. Keep the existing library project configuration; the external evaluation harness invokes this public Main by reflection. Do not contact external providers during this smoke scenario.";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type ApiMember = { owner: string; name: string; parameters: string; constructor: boolean; property: boolean; abstractMethod: boolean; generic: boolean; identity: string };
type Api = { signatures: string[]; members: ApiMember[] };
type Report = {
  version: 1; language: "C#"; model: string; workspace: string; target: string; status: string; passed: boolean;
  startedAt: string; finishedAt?: string; reason?: string; requirementSha256: string; baselineHashes: Record<string, string>; expectedHashes: Record<string, string>;
  preparation: { seed: string; commit?: string; state: "copying" | "committed" | "ready" }; modules: Module[];
  references: Array<{ path: string; sourceSha256: string; suppliedSha256: string; suppliedCharacters: number }>;
  baselineCompile?: Execution; integrationCompile?: Execution; smoke?: Execution; remainingPlaceholders?: string[]; finalTargets?: VerificationFunction[]; finalObservation?: FunctionGroupTestRun; finalError?: string;
  hidden?: { directory: string; execution: Execution; reportPath: string; total: number; passed: number; failed: number; reason: string; successful: boolean };
};

export function planCsharpModules(paths: string[]): Module[] {
  const modules = MODULES.map(([id, ...files]) => ({ id, files: files.map(file => ROOT + file), status: "pending", attempts: [] as Attempt[] }));
  const assigned = modules.flatMap(module => module.files);
  if (paths.length !== assigned.length || paths.some(path => !assigned.includes(path)) || assigned.some(path => !paths.includes(path))) throw new Error("The complete existing C# source manifest must match all 27 files.");
  return modules;
}

export function decodeCsharpFiles(text: string, allowed: SourceFile[], secret: string): SourceFile[] {
  const result = JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as { files?: SourceFile[] };
  if (!Array.isArray(result.files) || !result.files.length) throw new Error("The module response must contain production files.");
  const seen = new Set<string>();
  for (const file of result.files) {
    const original = allowed.find(source => source.path === file.path);
    if (!original || typeof file.content !== "string" || seen.has(file.path)) throw new Error("The module response exceeds its declared write boundary.");
    seen.add(file.path);
    const namespace = original.content.match(/\bnamespace\s+([\w.]+)\s*[;{]/)?.[1];
    if (!namespace || !new RegExp(`\\bnamespace\\s+${namespace.replaceAll(".", "\\.")}\\s*[;{]`).test(file.content)
      || /Implementation belongs to the evaluated Agent|throw new (?:global::System\.|System\.)?NotImplementedException/.test(file.content) || secret && file.content.includes(secret)) throw new Error(`Invalid or unfinished module source: ${file.path}`);
    file.content = file.content.replaceAll("\r\n", "\n").trimEnd() + "\n";
  }
  return result.files;
}

export function csharpTargets(api: Pick<Api, "members">, sources: SourceFile[]): VerificationFunction[] {
  const targets = new Map<string, VerificationFunction>();
  for (const member of api.members) {
    if (member.abstractMethod) continue;
    const typeName = member.owner.split(".").at(-1)!.split("`")[0];
    const file = sources.find(source => source.content.match(/\bnamespace\s+([\w.]+)\s*[;{]/)?.[1] === member.owner.slice(0, member.owner.lastIndexOf("."))
      && new RegExp(`\\b(?:class|interface|record|struct|enum)\\s+(?:(?:class|struct)\\s+)?${typeName}\\b`).test(source.content));
    if (!file) continue;
    const explicit = member.property
      ? (csharpMethodRanges(file.content, member.name, "property") ?? []).some(range => range.owner === member.owner)
      : (csharpMethodRanges(file.content, member.name) ?? []).some(range => range.owner === member.owner && matchesCsharpSignature(`(${member.parameters})`, `${member.name}${range.parameters}`, member.name));
    if (!explicit) continue;
    const name = member.constructor ? ".ctor" : member.name;
    const signature = `${member.owner}.${name}${member.property ? "" : `(${member.parameters})`}`;
    const target = { path: file.path, name, signature };
    targets.set(JSON.stringify(target), target);
  }
  return [...targets.values()];
}

async function evaluateHidden(report: Report, materials: string): Promise<NonNullable<Report["hidden"]>> {
  const parent = join(report.workspace, "independent-evaluation");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "run-"));
  const target = join(directory, "target-project"), evaluator = join(directory, "evaluator");
  await cp(report.target, target, { recursive: true, filter: path => path === report.target || !["bin", "obj", "TestResults", ".git", ".translation-verifier-tests"].includes(basename(path)) });
  await cp(join(materials, "csharp/hidden-tests"), evaluator, { recursive: true, filter: path => !["bin", "obj"].includes(basename(path)) });
  const reportPath = join(directory, "hidden-evaluation.json");
  const execution = await execute(directory, "dotnet", ["run", "--project", join(evaluator, "HiddenAcceptanceEvaluator.csproj"), `-p:TargetProjectRoot=${target}`, "--", "--target", target, "--output", reportPath], 360_000);
  let evaluation: { Total?: number; Passed?: number; Failed?: number; InfrastructureError?: string } = {};
  try { evaluation = JSON.parse(await readFile(reportPath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const total = evaluation.Total ?? 0, successful = evaluation.Passed ?? 0, failed = evaluation.Failed ?? 0;
  const complete = total === 24 && [successful, failed].every(value => Number.isInteger(value) && value >= 0) && successful + failed === total
    && !evaluation.InfrastructureError && !execution.timedOut && (execution.exitCode === 0 || execution.exitCode === 1 && failed > 0);
  const reason = !complete ? "hidden-execution-failure" : successful === 24 && execution.exitCode === 0 ? "passed" : "requirement-mismatch";
  return { directory, execution, reportPath, total, passed: successful, failed, reason, successful: reason === "passed" };
}

export async function runFullCsharpProject(prepareOnly = false): Promise<Report> {
  if (!prepareOnly && process.env.TRANSLATION_VERIFIER_FULL_PROJECT_E2E !== "1") throw new Error("Set TRANSLATION_VERIFIER_FULL_PROJECT_E2E=1 for full real inference.");
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!prepareOnly && !apiKey) throw new Error("A process credential is required.");
  if (!process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR) throw new Error("Use an explicit external TRANSLATION_VERIFIER_EXPERIMENT_DIR.");
  const redact = (value: string) => apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  const workspace = resolve(process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR), target = join(workspace, "target-project");
  const assets = resolve(process.env.TRANSLATION_VERIFIER_ASSETS_ROOT ?? "experiments"), materials = join(assets, "asset-upgrade-test-materials-20261014");
  const original = join(materials, "csharp/target-project"), baselineHashes = await inventory(original);
  const sourcePaths = Object.keys(baselineHashes).filter(path => path.startsWith(ROOT) && path.endsWith(".cs"));
  const requirement = (await sourcesAt(original, Object.keys(baselineHashes).filter(path => /^requirements\/task-.*\.md$/.test(path)).sort())).map(file => `${file.path}\n${file.content}`).join("\n\n") + "\n\n" + ASSEMBLY_REQUIREMENT;
  const referenceSources = await Promise.all(REFERENCES.map(async path => { const content = await readFile(join(assets, "enterprise-asset-upgrade/reference-sources", path), "utf8"); return { path, content: content.slice(0, 24_000), sourceSha256: digest(content) }; }));
  const references = referenceSources.map(file => ({ path: file.path, sourceSha256: file.sourceSha256, suppliedSha256: digest(file.content), suppliedCharacters: file.content.length }));
  const modelName = process.env.DEEPSEEK_MODEL ?? "deepseek-flash", reportPath = join(workspace, "full-project-report.json");
  await mkdir(workspace, { recursive: true });
  let report: Report;
  try { report = JSON.parse(await readFile(reportPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await stat(target).then(() => true, () => false)) throw new Error("Target exists without a checkpoint.");
    report = { version: 1, language: "C#", model: modelName, workspace, target, status: "preparing", passed: false, startedAt: new Date().toISOString(), requirementSha256: digest(requirement),
      baselineHashes, expectedHashes: { ...baselineHashes }, preparation: { seed: await mkdtemp(join(workspace, "skeleton-seed-")), state: "copying" }, modules: planCsharpModules(sourcePaths), references };
  }
  if (report.version !== 1 || report.language !== "C#" || report.model !== modelName || report.workspace !== workspace || report.target !== target || report.requirementSha256 !== digest(requirement)
    || JSON.stringify(report.baselineHashes) !== JSON.stringify(baselineHashes) || JSON.stringify(report.references) !== JSON.stringify(references)) throw new Error("Checkpoint inputs differ; preserve this run and choose a new directory.");
  let queue = Promise.resolve();
  const checkpoint = () => { queue = queue.then(async () => { await writeFile(`${reportPath}.tmp`, redact(JSON.stringify(report, null, 2)) + "\n", { mode: 0o600 }); await rename(`${reportPath}.tmp`, reportPath); }); void queue.catch(() => undefined); return queue; };
  await checkpoint();
  await prepareWorktree(report, original, checkpoint);
  await assertProjectBoundary(report);
  const compile = () => execute(target, "dotnet", ["build", "AssetUpgradeGateway.sln", "--nologo"]);
  report.baselineCompile ??= await compile();
  if (report.baselineCompile.exitCode !== 0 || report.baselineCompile.timedOut) { await checkpoint(); throw new Error("The C# project baseline cannot build."); }
  await resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: target });
  const inspector = join(workspace, "api-inspector");
  await mkdir(inspector, { recursive: true });
  await cp(fileURLToPath(new URL("./csharp-api-inspector.cs", import.meta.url)), join(inspector, "Program.cs"));
  await writeFile(join(inspector, "Inspector.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
  const inspectorBuild = await execute(inspector, "dotnet", ["build", "--nologo"]);
  if (inspectorBuild.exitCode !== 0 || inspectorBuild.timedOut) throw new Error(`The external API inspector cannot build: ${inspectorBuild.stdout}`);
  const inspectorDll = join(inspector, "bin/Debug/net8.0/Inspector.dll"), targetDll = join(target, ROOT, "bin/Debug/net8.0/AssetUpgradeGateway.dll");
  const inspect = async (files: string[]) => {
    const output = join(workspace, "api-inspection.json");
    const execution = await execute(workspace, "dotnet", [inspectorDll, targetDll, output]);
    if (execution.exitCode !== 0 || execution.timedOut) throw new Error(`Cannot inspect the C# public API: ${execution.stderr}`);
    const api = JSON.parse(await readFile(output, "utf8")) as Api;
    return { signatures: api.signatures, targets: csharpTargets(api, await sourcesAt(target, files)) };
  };
  await checkpoint();
  console.info(JSON.stringify({ stage: "csharp-prepared", reportPath, modules: report.modules.map(module => ({ id: module.id, files: module.files.length })), baselineTargets: (await inspect(sourcePaths)).targets.length }));
  if (prepareOnly) return report;
  const traces = join(workspace, "full-traces");
  await mkdir(traces, { recursive: true });
  const model = createTranslationVerifierChatModel({ apiKey: () => apiKey, model: modelName, maxOutputTokens: 32_768, temperature: 0,
    request: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(360_000)]) }) });
  const verify = (module: Module, targets: VerificationFunction[], prefix: string) => verifyModuleGroups({ module, targets, prefix, traces, target, language: "C#", requirement, model, apiKey, checkpoint });
  for (const module of report.modules) {
    const baseline = await sourcesAt(original, module.files);
    if (module.status === "rolling-back" || module.status === "translation-failed" && module.attempts.at(-1)?.pending) await restoreModuleSources(report, module, baseline, compile, checkpoint);
    if (["translated", "verified", "translation-failed", "data-contract"].includes(module.status)) continue;
    for (let round = module.attempts.at(-1)?.status === "running" ? module.attempts.length : module.attempts.length + 1; round <= 3; round++) {
      let attempt = module.attempts.at(-1);
      if (!attempt || attempt.status !== "running") { attempt = { round, startedAt: new Date().toISOString(), status: "running" }; module.attempts.push(attempt); }
      module.status = "translating"; report.status = `translating:${module.id}`;
      await checkpoint();
      console.info(JSON.stringify({ stage: "translate-module", language: "C#", module: module.id, round }));
      try {
        if (!attempt.pending && !attempt.compile) {
          module.baselineApi ??= (await inspect(module.files)).signatures;
          attempt.api = module.baselineApi;
          const prior = module.attempts.slice(0, -1).at(-1);
          const response = await model.invoke([
            { role: "system", content: 'Implement one module of the complete existing C# project. Return ONLY JSON {"files":[{"path":"declared project-relative path","content":"complete C# file"}]}. Change only declared files. Preserve all public contracts, interfaces, records, enums, constructors, methods and properties. Implement all executable seams with substantive local behavior, no placeholder/no-op substitutes. Keep provider integrations behind injected ports and fail explicitly when unconfigured. Use net8.0 BCL APIs, no extra dependencies or build configuration changes. Public requirements define behavior; reference excerpts are partial design evidence. No hidden tests or hidden feedback are available.' },
            { role: "user", content: `Module ${module.id}; writable files: ${JSON.stringify(module.files)}\nFull public requirements and explicit assembly experiment requirement:\n${requirement}\nOriginal module contracts:\n${baseline.map(file => `${file.path}\n${file.content}`).join("\n\n")}\nCurrent complete source context:\n${(await sourcesAt(target, sourcePaths)).map(file => `${file.path}\n${file.content}`).join("\n\n")}\nReference excerpts:\n${referenceSources.map(file => `${file.path}\n${file.content}`).join("\n\n")}\nPrevious public feedback:\n${prior ? JSON.stringify({ compile: prior.compile, groups: prior.groups, error: prior.error }).slice(-80_000) : "Start from the untouched module skeleton."}` },
          ], { signal: AbortSignal.timeout(360_000) });
          const raw = (typeof response.content === "string" ? response.content : JSON.stringify(response.content)).trim();
          attempt.response = join(traces, `translation-${module.id}-${round}.json`); attempt.responseSha256 = digest(raw);
          await writeFile(attempt.response, redact(raw) + "\n", { mode: 0o600 });
          attempt.pending = decodeCsharpFiles(raw, baseline, apiKey);
          await checkpoint();
        }
        await assertProjectBoundary(report);
        if (attempt.pending) await applyPendingSources(report, attempt, checkpoint);
        const remaining = (await sourcesAt(target, module.files)).filter(file => /Implementation belongs to the evaluated Agent/.test(file.content));
        if (remaining.length) throw new Error(`Module retains executable skeletons: ${remaining.map(file => file.path).join(", ")}`);
        attempt.compile = await compile();
        await checkpoint();
        if (attempt.compile.exitCode !== 0 || attempt.compile.timedOut) { attempt.status = attempt.compile.timedOut ? "compile-timeout" : /error CS\d+/.test(attempt.compile.stdout) ? "compile-failed" : "build-execution-failure"; await checkpoint(); continue; }
        const api = await inspect(module.files), missingApi = attempt.api?.filter(signature => !api.signatures.includes(signature)) ?? [];
        if (missingApi.length) throw new Error(`A public API was changed: ${missingApi.slice(0, 10).join("; ")}`);
        if (api.targets.length) {
          await verify(module, api.targets, `round-${round}`);
          attempt.status = passed(attempt.groups) ? "verified" : "verification-failed";
          module.status = attempt.status === "verified" ? "verified" : round === 3 ? "translated" : "translating";
        } else { attempt.status = "data-contract"; module.status = "data-contract"; }
        await checkpoint();
        if (module.status !== "translating") break;
      } catch (error) { attempt.error = redact(error instanceof Error ? error.message : String(error)); attempt.status = "failed"; await checkpoint(); }
    }
    if (module.status === "translating") { module.attempts.at(-1)!.pending = baseline; await restoreModuleSources(report, module, baseline, compile, checkpoint); }
    await checkpoint();
  }
  report.status = "integration";
  report.integrationCompile = await execute(target, "dotnet", ["build", "AssetUpgradeGateway.sln", "--no-incremental", "--nologo"]);
  await checkpoint();
  if (report.integrationCompile.exitCode === 0 && !report.integrationCompile.timedOut) {
    for (const module of report.modules) {
      if (["translation-failed", "data-contract"].includes(module.status)) continue;
      if (!passed(module.finalGroups)) await verify(module, (await inspect(module.files)).targets, "final");
    }
    report.finalTargets = (await inspect(sourcePaths)).targets;
    try { report.finalObservation = await revalidateProject(target, "C#", requirement, report.finalTargets); delete report.finalError; }
    catch (error) { delete report.finalObservation; report.finalError = redact(String(error)); }
    report.smoke = await execute(workspace, "dotnet", [inspectorDll, targetDll, "--smoke"], 30_000);
    await checkpoint();
    if (!report.hidden) { report.hidden = await evaluateHidden(report, materials); await checkpoint(); }
  }
  await assertProjectBoundary(report);
  report.remainingPlaceholders = (await sourcesAt(target, sourcePaths)).filter(file => /Implementation belongs to the evaluated Agent/.test(file.content)).map(file => file.path);
  report.passed = report.integrationCompile.exitCode === 0 && !report.integrationCompile.timedOut && report.smoke?.exitCode === 0 && !report.smoke.timedOut
    && Boolean(report.smoke.stdout.trim()) && report.remainingPlaceholders.length === 0 && report.hidden?.successful === true
    && completeProjectObservation(report.finalObservation, report.finalTargets ?? []) && report.modules.every(module => module.status === "data-contract" || module.status !== "translation-failed" && passed(module.finalGroups));
  report.reason = report.passed ? "passed" : report.integrationCompile.exitCode !== 0 || report.integrationCompile.timedOut ? "build-execution-failure" : report.hidden && !report.hidden.successful ? report.hidden.reason : "module-verification-incomplete";
  report.status = report.passed ? "passed" : "incomplete"; report.finishedAt = new Date().toISOString();
  await checkpoint();
  console.info(JSON.stringify({ stage: "full-csharp-result", reportPath, passed: report.passed, reason: report.reason, hidden: report.hidden && { total: report.hidden.total, passed: report.hidden.passed, failed: report.hidden.failed } }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    if (process.argv.includes("--credential-stdin")) await readProcessCredential();
    const report = await runFullCsharpProject(process.argv.includes("--prepare-only"));
    if (!process.argv.includes("--prepare-only") && !report.passed) process.exitCode = 1;
  };
  run().catch(error => { const secret = process.env.DEEPSEEK_API_KEY; console.error(secret ? String(error).split(secret).join("[REDACTED]") : String(error)); process.exitCode = 1; });
}
