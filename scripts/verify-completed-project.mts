/**
 * Run only requirement verification on an isolated copy of an already-built project.
 * Reads public requirements and source ownership from a pipeline report, never plans,
 * historical answers, evaluator output or hidden tests.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import { discoverExecutableFunctions } from './module-function-mapping.js';
import { createLangChainFunctionGroupAgentHost } from '../services/translation-verifier/src/host/langchain-runtime.js';
import { resolveTestEnvironment } from '../services/translation-verifier/src/host/test-environment.js';
import { createFunctionGroupVerifier } from '../services/translation-verifier/src/function-group-verify.js';
import {
  createOfflineVerifierChatModel,
  createOfflineVerifierEvidence,
  isOfflineVerifierTraceEvent,
  recordOfflineVerifierEvent,
} from './translation-verifier-offline.js';

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error('Missing --' + name);
  return value;
}
const reportPath = resolve(argument('report'));
const projectPath = resolve(argument('project'));
const output = resolve(argument('output'));
if (existsSync(output)) throw new Error('Output directory must be new: ' + output);
const outputRelative = relative(projectPath, output);
if (!outputRelative || !outputRelative.startsWith('..') && !isAbsolute(outputRelative)) throw new Error('Output must be outside the input project.');
mkdirSync(output, { recursive: true });
const project = join(output, 'project');
const excluded = new Set(['.git', '.forexpore', '.forexplore', '.translation-verifier-tests', 'node_modules']);
cpSync(projectPath, project, { recursive: true, filter: path => !excluded.has(basename(path)) });
const report: { modules: Array<{ moduleId: string; module: string; language: string;
  sourceFiles: string[]; changedPaths?: string[]; requirement: string }> } = JSON.parse(readFileSync(reportPath, 'utf8'));
const selected = process.argv.includes('--modules') ? new Set(argument('modules').split(',')) : undefined;
const modules = report.modules.filter(module => !selected || selected.has(module.moduleId));
if (!modules.length) throw new Error('No selected modules.');
const inventory = modules.map(module => {
  const files = [...new Set<string>([...module.sourceFiles, ...(module.changedPaths ?? [])])];
  const functions = discoverExecutableFunctions(Object.fromEntries(files.map(file => {
    const absolute = resolve(project, file);
    const sourceRelative = relative(project, absolute);
    if (!sourceRelative || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) throw new Error('Source path escapes project: ' + file);
    return [file, existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''];
  })));
  return { moduleId: module.moduleId, module: module.module, language: module.language,
    requirement: module.requirement, functions };
});
writeFileSync(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2));
const functionPattern = process.argv.includes('--function-pattern') ? new RegExp(argument('function-pattern')) : undefined;
for (const item of inventory) if (functionPattern) item.functions = item.functions.filter(fn => functionPattern.test(fn.signature ?? fn.name));
writeFileSync(join(output, 'verification-targets.json'), JSON.stringify(inventory, null, 2));
for (const item of inventory) console.log(item.moduleId + ': ' + item.functions.length + ' executable targets');
if (process.argv.includes('--discover-only')) process.exit(0);
if (process.argv.includes('--compile-command') || process.argv.includes('--compile-command-file')) {
  const command = JSON.parse(process.argv.includes('--compile-command-file')
    ? readFileSync(argument('compile-command-file'), 'utf8') : argument('compile-command'));
  const build = spawnSync(command.executable, command.args, { cwd: project, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(join(output, 'compile.log'), (build.stdout ?? '') + (build.stderr ?? ''));
  if (build.status !== 0) throw new Error('Isolated project compile failed. See compile.log');
}
const envPath = resolve('services/adaptation-service/.env');
if (existsSync(envPath)) for (const [key, value] of Object.entries(parse(readFileSync(envPath)))) process.env[key] ||= value;
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('Configured verifier model credential is required.');
const results: unknown[] = [];
const verifierModel = createOfflineVerifierChatModel(process.env);
for (const item of inventory) {
  console.log('Verifying ' + item.moduleId);
  const evidencePath = join(output, item.moduleId + '.jsonl');
  const evidence = createOfflineVerifierEvidence();
  const host = createLangChainFunctionGroupAgentHost({
    model: verifierModel,
    limits: { maxDurationMs: 900_000, maxTurns: 64 },
    resolveToolContext: async task => {
      const environment = await resolveTestEnvironment(task);
      return { ...task, sourceDirectory: '.', targetDirectory: '.', testRoots: environment.testRoots,
        testRunner: environment.framework, targetTest: environment.targetTest,
        cleanup: async () => {
          // Save the actual runnable harness before the Host removes its disposable copy.
          for (const testRoot of environment.testRoots) {
            const harnessRoot = dirname(join(project, testRoot));
            if (testRoot.startsWith('.translation-verifier-tests/')) cpSync(harnessRoot,
              join(output, 'tests', item.moduleId, basename(harnessRoot)), { recursive: true });
            else cpSync(join(project, testRoot), join(output, 'tests', item.moduleId), { recursive: true });
          }
          await environment.cleanup?.();
        },
      };
    },
    traceLogger: event => {
      if (!isOfflineVerifierTraceEvent(event)) return;
      appendFileSync(evidencePath, JSON.stringify(event, (_, value) => typeof value === 'string' ? value.split(key).join('[REDACTED]') : value) + '\n');
      if (!recordOfflineVerifierEvent(evidence, event)) return;
      // The accepted observation comes from the Host revalidation, never from
      // the Agent's own tool call or memory of it.
      const observation = evidence.finalObservation;
      if (event.event === 'host.revalidation.completed' && observation) {
        console.log(item.moduleId + ': revalidation round=' + (evidence.finalObservationRound ?? '-') +
          ' status=' + observation.status + ' tests=' + observation.tests.executed +
          ' failed=' + observation.tests.failed +
          ' covered=' + observation.functions.filter(fn => fn.executed).length + '/' + observation.functions.length +
          ' reports=' + (observation.reportPaths?.join(',') || 'none'));
      }
    },
  });
  let result: unknown;
  try {
    result = item.functions.length ? await createFunctionGroupVerifier(host)({
      schemaVersion: '3.1', mode: 'requirement', sourceLanguage: item.language,
      targetLanguage: item.language, targetProjectPath: project,
      requirement: item.requirement,
      functions: item.functions.map(target => ({ target })),
    }, 'requirement-function-group', 'verify') : { status: 'failure', reason: 'mapping-invalid', functions: [] };
  } catch (error) {
    result = { status: 'failure', error: error instanceof Error ? error.message : String(error) };
  }
  results.push({ moduleId: item.moduleId, result,
    finalObservation: evidence.finalObservation ?? null,
    finalObservationRound: evidence.finalObservationRound ?? null,
    toolEventCount: evidence.toolEvents.length });
  writeFileSync(join(output, 'verification.json'), JSON.stringify(results, null, 2));
  console.log(item.moduleId + ': ' + JSON.stringify(result));
}
