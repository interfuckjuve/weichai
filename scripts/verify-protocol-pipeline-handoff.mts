import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { prepareDirectModuleTranslationScope, prepareModuleTranslationScope, prepareIntegrationTranslationScope } from '../apps/vscode-extension/src/module-translation-handoff.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { validateWorkspaceTranslationRequest } from '../services/adaptation-service/src/workspace-translation-agent.js';
import { CodexWorkspaceTranslationRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime.js';
import { prepareProjectIntegrationContext } from '../services/adaptation-service/src/project-integration-context.js';
import { ensureGlobalProtocol, loadGlobalProtocol, mergeGlobalProtocol, persistGlobalProtocol, projectModuleProtocol, recordProtocolChecks } from '../services/adaptation-service/src/protocol-sidecar.js';
import { createFunctionGroupFinalReportTask, createRequirementFunctionGroupFinalReportTask } from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import { discoverExecutableFunctions } from './module-function-mapping.js';
import { verifierTaskInputs } from './translation-verifier-offline.js';

// Run only a protocol transport/persistence probe. The local receiver validates
// requests and records them; it never invokes a translation or verification Agent.
const experiment = process.argv[2];
if (!experiment) throw new Error('Usage: tsx scripts/verify-protocol-pipeline-handoff.mts <experiment directory>');
const targetRoot = join(experiment, 'target-project');
const modules = JSON.parse(await readFile(join(experiment, 'target-plan.json'), 'utf8')).modules;
const preview = JSON.parse(await readFile(join(experiment, 'retrieval-preview.json'), 'utf8'));
const originalProtocol = JSON.parse(await readFile(join(experiment, 'global-protocol.json'), 'utf8'));
const output = join(experiment, 'protocol-handoff-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, 'Z'));
await mkdir(output);
const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2));
const sourceFiles = [...new Set<string>(modules.flatMap((m: any) => m.sourceFiles))];
const contents: Record<string, string> = {};
for (const file of sourceFiles) contents[file] = await readFile(join(targetRoot, file), 'utf8');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const before = Object.fromEntries(Object.entries(contents).map(([file, text]) => [file, digest(text)]));
const requirement = (await Promise.all((await readdir(join(targetRoot, 'requirements'))).filter(file => file.endsWith('.md')).sort().map(async file => '## ' + file + '\n' + await readFile(join(targetRoot, 'requirements', file), 'utf8')))).join('\n\n');
const initial = await ensureGlobalProtocol(output, 'protocol-handoff');
const protocol = mergeGlobalProtocol(initial.protocol, originalProtocol, 'protocol-handoff');
assert.equal(await persistGlobalProtocol(join(output, 'global-protocol.json'), protocol), true);
assert.deepEqual((await ensureGlobalProtocol(output)).protocol, protocol);
const received: any[] = [];
const server = createServer(async (request, response) => {
  try {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify({ workspaceRoot: targetRoot, behavioralVerification: false }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    validateWorkspaceTranslationRequest(input);
    received.push(input);
    response.statusCode = 202;
    response.end(JSON.stringify({ id: randomUUID(), workspaceRoot: targetRoot, status: 'cancelled', error: 'Protocol capture only; no Agent was invoked.' }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const summary: any[] = [];
const runtime = new CodexWorkspaceTranslationRuntime({ workspaceRoot: targetRoot, compileCommand: { executable: 'node', args: ['--version'] } } as any);
async function dispatch(scope: any) {
  const host = new WorkspaceTranslationHost(() => ({ url: 'http://127.0.0.1:' + port, token: 'protocol-probe-local-token-at-least-32-chars' }));
  const scopeId = host.rememberModuleScope(scope);
  const described: any = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: randomUUID(), action: 'describe', moduleScopeId: scopeId });
  assert.equal(described.type, 'WORKSPACE_TRANSLATION_RESULT', JSON.stringify(described));
  const response: any = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: randomUUID(), action: 'start', moduleScopeId: scopeId, profileId: described.profile.profileId });
  assert.equal(response.type, 'WORKSPACE_TRANSLATION_RESULT', JSON.stringify(response));
  assert.equal(response.run.status, 'cancelled');
  return received.at(-1);
}
try {
  for (const module of modules) {
    const projected = projectModuleProtocol(protocol, { moduleId: module.id, moduleName: module.name, relatedModules: module.dependsOn, relatedInterfaces: module.coreApis, sharedTypes: module.coreApis, ownedFiles: module.sourceFiles });
    const target = { id: module.id, name: module.name, kind: 'module' as const, path: module.sourceFiles[0], signature: module.name, language: 'Java' as const, module };
    const scope = await prepareDirectModuleTranslationScope({ workspaceRoot: targetRoot, target, requirement, decisionNotes: '', relatedWriteFiles: [], moduleProtocol: projected });
    const input = await dispatch(scope);
    assert.deepEqual(input.moduleProtocol, projected);
    const previewModule = preview.modules.find((entry: any) => entry.moduleId === module.id);
    const selectedIds = new Set((previewModule?.selectedCandidates ?? []).map((entry: any) => entry.id));
    const candidates = (previewModule?.retrievalCandidates ?? []).filter((entry: any) => selectedIds.has(entry.id));
    let historyRoutePreserved = false;
    if (candidates.length) {
      // Reuse reviewed candidate metadata, with previews disabled. Preparing
      // protocol scope does not open a historical checkout or create a view.
      const historyScope = await prepareModuleTranslationScope({ workspaceRoot: targetRoot, target, candidates, requirement, decisionNotes: '', relatedWriteFiles: [], includeCandidateContext: false, moduleProtocol: projected });
      const historyInput = await dispatch(historyScope);
      assert.deepEqual(historyInput.moduleProtocol, projected);
      await save(module.id + '.history-route.request.json', historyInput);
      historyRoutePreserved = true;
    }
    const prompts = {
      analyzer: (runtime as any).analyzerPrompt(input, ''),
      directTranslator: (runtime as any).directTranslatorPrompt(input, '', { markdown: 'Protocol handoff probe only.', summary: 'Protocol handoff probe only.', mappings: [], dependencies: [], steps: [] }),
      translator: (runtime as any).translatorPrompt(input, '', { markdown: 'Protocol handoff probe only.', summary: 'Protocol handoff probe only.', mappings: [], dependencies: [], steps: [] }),
    };
    for (const prompt of Object.values(prompts)) for (const entry of [...projected.boundaries, ...projected.sharedContracts]) assert.ok(prompt.includes(entry.id), 'Runtime omitted ' + entry.id);
    const functions = discoverExecutableFunctions(Object.fromEntries(module.sourceFiles.map((file: string) => [file, contents[file]])));
    if (functions.length) {
      const inputBase = { schemaVersion: '3.1' as const, sourceLanguage: 'Java', targetLanguage: 'Java', targetProjectPath: targetRoot, requirement, moduleProtocol: projected };
      const requirementTask = createRequirementFunctionGroupFinalReportTask({ ...inputBase, mode: 'requirement', functions: functions.map(target => ({ target })) } as any);
      // Source/target equal here only to inspect translation-mode task assembly;
      // no equivalence test or verification run is claimed.
      const translationTask = createFunctionGroupFinalReportTask({ ...inputBase, sourceProjectPath: targetRoot, functions: functions.map(target => ({ source: target, target })) } as any);
      for (const task of [requirementTask, translationTask]) for (const entry of [...projected.boundaries, ...projected.sharedContracts]) assert.ok(task.userPrompt.includes(entry.id), 'Verifier task omitted ' + entry.id);
      // Read the business input from taskContext only; the removed duplicated
      // task field is not a second source of truth.
      await save(module.id + '.verifier-task-inputs.json', verifierTaskInputs({ requirement: requirementTask, translation: translationTask }));
    }
    await save(module.id + '.request.json', input);
    await save(module.id + '.runtime-prompts.json', prompts);
    summary.push({ moduleId: module.id, boundaries: projected.boundaries.length, sharedContracts: projected.sharedContracts.length, executableSubjects: functions.length, httpAccepted: true, historyRoutePreserved, runtimeProtocolPreserved: true, verifierTaskProtocolPreserved: functions.length > 0 });
  }
  const integrationContext = await prepareProjectIntegrationContext(targetRoot);
  const integrationScope = await prepareIntegrationTranslationScope({ workspaceRoot: targetRoot, targetLanguage: 'Java', writeFiles: integrationContext.writeFiles, readOnlyFiles: integrationContext.readOnlyFiles, requirement: integrationContext.requirement, context: integrationContext.context, globalProtocol: protocol });
  const integrationInput = await dispatch(integrationScope);
  assert.deepEqual(integrationInput.globalProtocol, protocol);
  const integrationPrompt = (runtime as any).integrationPrompt(integrationInput);
  for (const entry of [...protocol.boundaries, ...protocol.sharedContracts]) assert.ok(integrationPrompt.includes(entry.id));
  await save('integration.request.json', integrationInput);
  await writeFile(join(output, 'integration.prompt.md'), integrationPrompt);

  // Deterministic fault injection on actual Plan entries verifies routing.
  // These feedback statuses are transport fixtures, never business verdicts.
  const contract = protocol.sharedContracts.find(entry => Boolean(entry.rule));
  const boundary = protocol.boundaries[0];
  assert.ok(contract && boundary);
  const injectedChecks = [
    { ruleId: contract.id, status: 'failed' as const, note: 'Transport fixture: shared-contract classification failure injection, not a production assertion.' },
    { ruleId: boundary.id, status: 'failed' as const, note: 'Transport fixture: boundary classification failure injection, not a production assertion.' },
  ];
  const updated = recordProtocolChecks(protocol, injectedChecks, 'protocol-probe');
  assert.deepEqual(updated.invariants, protocol.invariants);
  const contractConflict = updated.sharedContracts.find(entry => entry.status === 'conflict' && entry.name === contract.name);
  const boundaryConflict = updated.boundaries.find(entry => entry.status === 'conflict' && entry.module === boundary.module);
  assert.ok(contractConflict && boundaryConflict);
  for (const field of ['name', 'fields', 'rule', 'scope'] as const) assert.deepEqual(contractConflict[field], contract[field]);
  assert.deepEqual(recordProtocolChecks(updated, injectedChecks, 'protocol-probe'), updated);
  assert.equal(await persistGlobalProtocol(join(output, 'feedback-global-protocol.json'), updated), true);
  assert.deepEqual((await loadGlobalProtocol(join(output, 'feedback-global-protocol.json'))).protocol, updated);
  const feedbackScope = await prepareIntegrationTranslationScope({ workspaceRoot: targetRoot, targetLanguage: 'Java', writeFiles: integrationContext.writeFiles, readOnlyFiles: integrationContext.readOnlyFiles, requirement: integrationContext.requirement, context: integrationContext.context, globalProtocol: updated });
  const feedbackInput = await dispatch(feedbackScope);
  assert.deepEqual(feedbackInput.globalProtocol, updated);
  assert.ok((runtime as any).integrationPrompt(feedbackInput).includes(contractConflict.id));
  await save('integration.after-feedback.request.json', feedbackInput);
  assert.deepEqual((await ensureGlobalProtocol(output)).protocol, protocol);
  const after = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(join(targetRoot, file), 'utf8'))])));
  assert.deepEqual(after, before);
  await save('source-integrity.json', { before, after, unchanged: true });
  await save('feedback-fixture.json', { businessVerification: false, contract, boundary, checks: injectedChecks });
  await save('run-result.json', { output, experiment, modules: summary, httpRequestsAccepted: received.length, inputCounts: { invariants: protocol.invariants.length, boundaries: protocol.boundaries.length, sharedContracts: protocol.sharedContracts.length, openQuestions: protocol.openQuestions.length }, integrationAllEntriesPreserved: true, sharedContractFeedbackMisclassifiedAsInvariant: false, boundaryAndContractConflictsRetained: true, feedbackReplayIdempotent: true, targetSourceUnchanged: true, translationAgentInvoked: false, verificationAgentInvoked: false });
  console.log(JSON.stringify({ output, modules: summary.length, httpRequestsAccepted: received.length, boundaries: protocol.boundaries.length, sharedContracts: protocol.sharedContracts.length, integrationAllEntriesPreserved: true, classificationFixed: true, targetSourceUnchanged: true }, null, 2));
} finally {
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
