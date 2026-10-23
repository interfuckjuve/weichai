import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceHistoryView, WorkspaceTranslationRun } from "@forexplore/contracts";
import { BackendProcess } from "../../../apps/vscode-extension/src/backend-process.js";
import { CodeIntelligenceHost, codeIntelligenceRuntimeOptionsFromEnvironment } from "../../../apps/vscode-extension/src/code-intelligence-host.js";
import { createCodeIntelligenceRuntime } from "../../code-intelligence-service/src/index.js";
import { execute, inventory } from "./existing-assets-workflow.js";
import { runFullCsharpProject } from "./full-csharp-workflow.js";
import { readProcessCredential } from "./full-project-workflow.js";

const SOURCE = "src/AssetUpgradeGateway/Domain/AssetLifecycle.cs";
const SPEC = "Environment capability probe on the existing C# skeleton. Implement only TenantScope.IsExpired, HasRole, Can and RequireTenant in the declared file. IsExpired(now) is true when now >= ExpiresAt. HasRole and Can use ordinal case-sensitive membership in Roles and Permissions respectively, returning false for null or empty input. RequireTenant returns this same instance for an ordinal-equal tenant and throws UnauthorizedAccessException otherwise. Preserve all existing public contracts and every other method, property and type, including the unrelated skeleton bodies. Do not edit build files or add dependencies. This is a bounded environment probe, not complete project acceptance.";

export async function prepareHistoryView(target: string): Promise<WorkspaceHistoryView> {
  const runtime = await createCodeIntelligenceRuntime(codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }));
  const host = new CodeIntelligenceHost({ runtimeFactory: async () => ({ ...runtime, close: async () => {} }) });
  try {
    const repository = (await runtime.store.listRepositories()).find(item => item.displayName === "keycloak");
    assert.ok(repository?.activeRevision && repository.analysisStatus === "ready", "The existing Keycloak CPU index must be ready.");
    const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision };
    const references = ["services/src/main/java/org/keycloak/services/resources/admin/fgap/RealmAuth.java", "services/src/main/java/org/keycloak/services/managers/AuthenticationManager.java"];
    const file = (await runtime.store.listFiles(scope)).find(item => item.relativePath === references[0]);
    assert.ok(file?.projectId);
    const analysis = await runtime.projectAnalysis.read({ ...scope, projectId: file.projectId });
    assert.equal(analysis.state, "ready");
    assert.equal(analysis.projection, "ready");
    const module = analysis.proposal?.modules.find(item => references.every(path => item.sourceFiles.includes(path)));
    assert.ok(module, "The ready Keycloak module must own both reference files.");
    await host.synchronize({ repositories: [{ localPath: repository.localPath, displayName: repository.displayName, role: "history", repositoryId: repository.repositoryId }], scan: false, resumeProjectAnalysis: false });
    return await host.createHistoryModuleView({ workspaceRoot: target, ...scope, projectId: file.projectId, moduleId: module.id,
      sourceFiles: references, preferredFiles: references, relevanceTerms: ["permission", "role", "expiry", "tenant"] });
  } finally {
    host.dispose();
    await runtime.close();
  }
}

async function main() {
  if (process.env.TRANSLATION_VERIFIER_BACKEND_E2E !== "1") throw new Error("Set TRANSLATION_VERIFIER_BACKEND_E2E=1 for real backend inference.");
  if (process.argv.includes("--credential-stdin")) await readProcessCredential();
  const secret = process.env.DEEPSEEK_API_KEY?.trim();
  if (!secret) throw new Error("A process credential is required.");
  const workspace = process.env.TRANSLATION_VERIFIER_EXPERIMENT_DIR;
  if (!workspace) throw new Error("Use an explicit external TRANSLATION_VERIFIER_EXPERIMENT_DIR.");
  const root = resolve(workspace), reportPath = join(root, "backend-capabilities-report.json");
  const prepared = await runFullCsharpProject(true);
  const translationMode = process.argv.includes("--analyzer-translator") ? "analyzer-translator" : "direct-translator";
  const historyView = translationMode === "analyzer-translator" ? await prepareHistoryView(prepared.target) : undefined;
  const historyHashes = historyView ? await inventory(historyView.root) : undefined;
  const probePath = ".recast-environment-probe", probe = join(prepared.target, probePath);
  await mkdir(probe, { recursive: true });
  await writeFile(join(probe, "Probe.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="../src/AssetUpgradeGateway/AssetUpgradeGateway.csproj" /></ItemGroup></Project>');
  await writeFile(join(probe, "Program.cs"), `using AssetUpgradeGateway.Domain;
var expiry = DateTimeOffset.Parse("2026-10-23T00:00:00Z");
var scope = new TenantScope("tenant-a", "actor-a", new HashSet<string>{"admin"}, new HashSet<string>{"asset.read"}, expiry);
if (scope.IsExpired(expiry.AddTicks(-1)) || !scope.IsExpired(expiry) || !scope.IsExpired(expiry.AddTicks(1))) throw new Exception("Expiry boundary mismatch");
if (!scope.HasRole("admin") || scope.HasRole("Admin") || scope.HasRole("") || scope.HasRole(null!)) throw new Exception("Role membership mismatch");
if (!scope.Can("asset.read") || scope.Can("Asset.Read") || scope.Can("") || scope.Can(null!)) throw new Exception("Permission membership mismatch");
if (!ReferenceEquals(scope, scope.RequireTenant("tenant-a"))) throw new Exception("Tenant identity mismatch");
foreach (var tenant in new string?[]{"tenant-b", "Tenant-a", "", null}) {
  var denied = false;
  try { scope.RequireTenant(tenant!); } catch (UnauthorizedAccessException) { denied = true; }
  if (!denied) throw new Exception("Cross-tenant access was allowed");
}
Console.WriteLine("16 tenant-scope behavior checks passed");
`);
  const backend = new BackendProcess(() => ({ url: "http://127.0.0.1:8788", extensionPath: resolve("apps/vscode-extension"),
    workspaceRoot: prepared.target, trusted: true, autoStart: true, dynamicPort: true, semanticPort: 8790,
    compileCommand: { executable: "dotnet", args: ["build", "AssetUpgradeGateway.sln", "--nologo"], timeoutMs: 180_000 },
    verification: { command: { executable: "dotnet", args: ["run", "--project", `${probePath}/Probe.csproj`, "--nologo"], timeoutMs: 180_000 },
      protectedFiles: [`${probePath}/Probe.csproj`, `${probePath}/Program.cs`] } }),
    message => console.info(message));
  const secrets = [secret, backend.translationToken, backend.moduleGenerationToken];
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), workspace: root, target: prepared.target, passed: false, requirement: SPEC, translationMode, ...(historyView ? { historyView } : {}) };
  const save = () => writeFile(reportPath, JSON.stringify(report, (_, value) => typeof value === "string"
    ? secrets.reduce((content, credential) => content.split(credential).join("[REDACTED]"), value) : value, 2) + "\n", { mode: 0o600 });
  const request = async (path: string, token: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${backend.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`Backend ${path} returned HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    report.capabilities = await backend.ensure();
    report.endpoint = backend.url;
    assert.equal((report.capabilities as { workspaceTranslation: boolean }).workspaceTranslation, true);
    assert.equal((report.capabilities as { workspaceAgent: string }).workspaceAgent, "codex");
    report.configuration = await request("/v1/workspace-translations/configuration", backend.translationToken);
    assert.equal((report.configuration as { agent: string }).agent, "codex");
    assert.equal((report.configuration as { behavioralVerification: boolean }).behavioralVerification, true);
    await save();
    const generation = await request("/v1/module-generation/turn", backend.moduleGenerationToken, {
      messages: [{ role: "user", content: 'Call report_ready exactly once with {"language":"C#","ready":true} to confirm this real model tool-calling route is usable.' }],
      tools: [{ name: "report_ready", description: "Report the requested environment capability check.",
        inputSchema: { type: "object", properties: { language: { type: "string", enum: ["C#"] }, ready: { type: "boolean", enum: [true] } }, required: ["language", "ready"], additionalProperties: false } }],
    }) as { toolCalls?: Array<{ name: string; arguments: string }> };
    report.moduleGeneration = generation;
    assert.equal(generation.toolCalls?.length, 1);
    assert.equal(generation.toolCalls[0].name, "report_ready");
    assert.deepEqual(JSON.parse(generation.toolCalls[0].arguments), { language: "C#", ready: true });
    await save();
    let run = await request("/v1/workspace-translations", backend.translationToken, { spec: SPEC, sourceLanguage: "C#", targetLanguage: "C#",
      context: [], workspaceFiles: Object.keys(prepared.baselineHashes), writeFiles: [SOURCE], translationMode, ...(historyView ? { historyView } : {}) }) as WorkspaceTranslationRun;
    const deadline = Date.now() + 1_200_000;
    let previous = "";
    while (["analyzing", "translating", "compiling", "testing"].includes(run.status)) {
      report.run = run;
      await save();
      if (run.status !== previous) { console.info(JSON.stringify({ stage: "backend-workspace-translation", status: run.status, id: run.id })); previous = run.status; }
      if (Date.now() >= deadline) throw new Error("The real workspace translation probe exceeded its execution budget.");
      await new Promise(resolveWait => setTimeout(resolveWait, 3000));
      run = await request(`/v1/workspace-translations/${run.id}`, backend.translationToken) as WorkspaceTranslationRun;
    }
    report.run = run;
    await save();
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.agent?.kind, "codex");
    assert.ok(run.agent.stages?.some(stage => stage.stage === "translator" && stage.sandbox === "workspace-write" && stage.exitCode === 0));
    if (historyView) {
      const analyzer = run.agent.stages?.find(stage => stage.stage === "analyzer");
      assert.ok(analyzer?.exitCode === 0 && analyzer.sandbox === "read-only" && analyzer.analyzerStatus === "accepted");
      assert.equal(run.request.translationMode, "analyzer-translator");
      assert.ok(run.plan?.markdown?.trim());
      assert.equal(run.agent.historyView?.manifestHash, historyView.manifestHash);
      assert.deepEqual(await inventory(historyView.root), historyHashes);
    }
    assert.ok(run.compilations.length && run.compilations.at(-1)?.success);
    assert.equal(run.acceptance, "behavior-verified");
    const verification = run.verification?.runs.at(-1);
    assert.ok(verification?.success && verification.exitCode === 0 && verification.filesUnchanged);
    assert.ok(verification.output.includes("16 tenant-scope behavior checks passed"));
    assert.ok(run.changes.length && run.changes.every(change => change.path === SOURCE));
    const current = await inventory(prepared.target);
    for (const [path, hash] of Object.entries(prepared.baselineHashes)) if (path !== SOURCE) assert.equal(current[path], hash, `Protected source changed: ${path}`);
    report.behavior = await execute(probe, "dotnet", ["run", "--project", "Probe.csproj", "--nologo"], 180_000);
    const behavior = report.behavior as Awaited<ReturnType<typeof execute>>;
    assert.equal(behavior.exitCode, 0, behavior.stderr || behavior.stdout);
    assert.equal(behavior.timedOut, false);
    assert.ok(behavior.stdout.includes("16 tenant-scope behavior checks passed"));
    assert.ok(!(await readFile(join(prepared.target, SOURCE), "utf8")).includes(secret));
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
  finally { backend.dispose(); report.finishedAt = new Date().toISOString(); await save(); }
  console.info(JSON.stringify({ stage: "backend-capabilities-result", passed: report.passed, reportPath }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const credential = process.env.DEEPSEEK_API_KEY;
    console.error(credential ? String(error).split(credential).join("[REDACTED]") : String(error));
    process.exitCode = 1;
  });
}
