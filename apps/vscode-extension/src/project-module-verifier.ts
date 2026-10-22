import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleProtocol, SearchCandidate, WorkspaceHistoryView } from '@forexplore/contracts';
import { buildModuleFunctionMapping, discoverExecutableFunctions, expandClassLevelFunctions } from '../../../scripts/module-function-mapping';




import type { FunctionGroupVerificationInput, RequirementFunctionGroupVerificationInput, FunctionGroupVerificationResult } from '../../../services/translation-verifier/src/types';
import type { ProjectPipelineModule } from './project-pipeline-types';

// Match the extension's existing runtime bridges: backend implementations are bundled,
// while their independent TypeScript projects retain their own compiler options.
export interface PipelineModel { apiKey: string; apiBase: string; model: string }
export interface PipelineModuleVerification {
  disposition: 'verified' | 'not-applicable' | 'production-defect' | 'test-environment' | 'agent-uncertain';
  mode: 'requirement' | 'translation-fidelity';
  result?: FunctionGroupVerificationResult;
  attempts: FunctionGroupVerificationResult[];
  /** The complete assembled project hash, not just the module's owned files. */
  sourceHash?: string;
}

/** Bounded Agent work metadata the extension is allowed to forward to its output log. */
type VerifierWorkEvent = {
  event: string;
  turn?: number;
  status?: string;
  outcome?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  toolCallCount?: number;
  messageCount?: number;
};

type FunctionGroupVerifier = (
  input: FunctionGroupVerificationInput | RequirementFunctionGroupVerificationInput,
  strategy: 'single-agent-function-group' | 'requirement-function-group',
  phase: 'verify',
) => Promise<FunctionGroupVerificationResult>;

/** Options the extension passes to the LangChain function-group Host. */
type VerifierHostOptions = {
  model: unknown;
  signal: AbortSignal;
  workLogger(event: VerifierWorkEvent): void;
};

/**
 * Load the LangChain verification path. The extension builds the framework chat
 * model and function-group Host here; it no longer constructs the retired model
 * protocol client or the retired Agent loop, and there is no fallback to them.
 *
 * These three boundary declarations mirror the verifier project's own exports.
 * The verifier keeps its own compiler settings, so the extension declares the
 * call contract at the boundary instead of type-checking that project inline.
 */
function requireVerifierRuntime(): {
  createTranslationVerifierChatModel(options: PipelineModel & { maxOutputTokens: number }): unknown;
  createLangChainFunctionGroupAgentHost(options: VerifierHostOptions): unknown;
  createFunctionGroupVerifier(host: unknown): FunctionGroupVerifier;
} {
  return {
    createTranslationVerifierChatModel: (require('../../../services/translation-verifier/src/host/agent/chat-model') as {
      createTranslationVerifierChatModel(options: PipelineModel & { maxOutputTokens: number }): unknown;
    }).createTranslationVerifierChatModel,
    createLangChainFunctionGroupAgentHost: (require('../../../services/translation-verifier/src/host/agent/langchain-runtime') as {
      createLangChainFunctionGroupAgentHost(options: VerifierHostOptions): unknown;
    }).createLangChainFunctionGroupAgentHost,
    createFunctionGroupVerifier: (require('../../../services/translation-verifier/src/function-group-verify') as {
      createFunctionGroupVerifier(host: unknown): FunctionGroupVerifier;
    }).createFunctionGroupVerifier,
  };
}

/**
 * Route between translation-fidelity and requirement verification from the
 * mapping's own confidence: a complete, single-source-language mapping is
 * trustworthy enough to compare against the historical source.
 */
export function selectVerificationMode(input: {
  historyView?: WorkspaceHistoryView;
  candidates: readonly SearchCandidate[];
  mapping: { functions: readonly unknown[]; unmatchedFunctions: readonly unknown[] };
}): 'translation-fidelity' | 'requirement' {
  const trusted = Boolean(input.historyView && input.mapping.functions.length && !input.mapping.unmatchedFunctions.length &&
    input.candidates.every(candidate => candidate.language === input.candidates[0]?.language));
  return trusted ? 'translation-fidelity' : 'requirement';
}

/**
 * Map the Host's bounded work events onto user-visible log lines. An Agent
 * invocation ending is not a verification result, so completion, Host
 * revalidation, feedback continuation and the final outcome stay distinct.
 */
export function verifierWorkLogMessage(event: VerifierWorkEvent): string | undefined {
  const round = event.turn === undefined ? '' : `（第 ${event.turn} 轮）`;
  switch (event.event) {
    case 'run.started': return 'Verifier：验证运行开始';
    case 'agent.invocation.completed':
      return `Verifier：Agent 调用完成${round}，候选结论 ${event.status ?? '缺失'}，等待 Host 复验`;
    case 'host.revalidation.completed': {
      const tests = event.toolCallCount === undefined ? '' : `，执行 ${event.toolCallCount} 个测试`;
      const exit = event.exitCode === undefined || event.exitCode === null ? '' : `，退出码 ${event.exitCode}`;
      const verdict = event.outcome === 'accepted' ? '接受候选结论' : '需要追加反馈';
      return `Verifier：Host 复验${round}（${event.status ?? 'unknown'}${tests}${exit}）：${verdict}`;
    }
    case 'agent.feedback.appended':
      return `Verifier：向同一 Agent 追加反馈${round}（${event.messageCount ?? 0} 项）`;
    case 'run.completed': return `Verifier：验证运行完成，结论 ${event.outcome ?? 'unknown'}`;
    case 'run.failed': return 'Verifier：验证运行失败';
    default: return undefined;
  }
}

/**
 * Classify a failed verification run into the existing upstream buckets. Budget,
 * limit and context failures are unfinished runs, not production defects;
 * framework/model failures stay distinct from a broken test environment.
 */
export function classifyVerifierError(error: unknown): {
  reason: 'agent-timeout' | 'model-failure' | 'test-environment-failure';
  issueKind: 'unknown' | 'environment';
} {
  const failure = error as { reason?: unknown; message?: unknown } | undefined;
  const declared = typeof failure?.reason === 'string' ? failure.reason.toLowerCase() : '';
  const description = `${declared} ${typeof failure?.message === 'string' ? failure.message : String(error)}`;
  if (declared === 'budget' || declared === 'context' ||
    /budget|exhausted|limit (?:exceeded|reached)|timeout|timed out/i.test(description)) {
    return { reason: 'agent-timeout', issueKind: 'unknown' };
  }
  if (declared === 'model' ||
    /model|completion|api key|unauthor|incorrect api key|rate limit|context length/i.test(description)) {
    return { reason: 'model-failure', issueKind: 'unknown' };
  }
  return { reason: 'test-environment-failure', issueKind: 'environment' };
}

export function verifierDisposition(result: FunctionGroupVerificationResult): PipelineModuleVerification['disposition'] {
  if (result.status === 'success') return result.testEvidence?.failures.some(item => item.status === 'unresolved') ? 'agent-uncertain' : 'verified';
  if (result.issue?.kind === 'test' || result.issue?.kind === 'environment' || ['test-environment-failure', 'coverage-unavailable'].includes(result.reason ?? '')) return 'test-environment';
  if (result.issue?.kind === 'unknown' || ['agent-timeout', 'model-failure', 'mapping-invalid'].includes(result.reason ?? '')) return 'agent-uncertain';
  return 'production-defect';
}

/** The same function mapping and LangChain function-group Host used by the offline pipeline. */
export async function verifyPipelineModule(input: {
  root: string; module: ProjectPipelineModule; requirement: string; model: PipelineModel;
  candidates: SearchCandidate[]; historyView?: WorkspaceHistoryView; protocol?: ModuleProtocol;
  signal: AbortSignal; previous?: PipelineModuleVerification; log(message: string): void;
}): Promise<PipelineModuleVerification> {
  input.signal.throwIfAborted();
  const files = [...new Set([...(input.module.target.module?.sourceFiles ?? []), ...(input.module.changedFiles ?? [])])];
  const contents = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(input.root, file), 'utf8')])));
  const sourceModules = input.candidates.flatMap(candidate => {
    const source = candidate.sourceModule; if (!source) return [];
    const view = input.historyView?.candidates?.find(view => view.repositoryId === source.repositoryId && view.analysisRevision === source.analysisRevision && view.moduleId === source.moduleId);
    return [{ sourceFiles: (source.sourceFiles ?? []).map(file => view?.prefix ? `${view.prefix}/${file}` : file).filter(file => input.historyView?.files.includes(file)), coreApis: source.coreApis ?? [] }];
  });
  const discovered = discoverExecutableFunctions(contents);
  const mapping = buildModuleFunctionMapping({ id: input.module.id, name: input.module.name, kind: 'feature', description: input.module.name, dependsOn: [], evidenceIds: [], symbolKeys: [], sourceFiles: files, coreApis: input.module.target.module?.coreApis ?? [] },
    { sourceFiles: sourceModules.flatMap(module => module.sourceFiles), coreApis: sourceModules.flatMap(module => module.coreApis) }, contents, discovered.length ? discovered : undefined);
  mapping.unmatchedFunctions = expandClassLevelFunctions(mapping.unmatchedFunctions, file => contents[file]);
  const mode = selectVerificationMode({ historyView: input.historyView, candidates: input.candidates, mapping });
  const fidelity = mode === 'translation-fidelity';
  const functions = [...mapping.unmatchedFunctions, ...mapping.functions.map(item => item.target)];
  const attempts = [...(input.previous?.attempts ?? [])];
  input.signal.throwIfAborted();
  if (!functions.length) return { mode, attempts, disposition: mapping.nonExecutableFunctions.length ? 'not-applicable' : 'agent-uncertain' };
  const runtime = requireVerifierRuntime();
  const host = runtime.createLangChainFunctionGroupAgentHost({
    model: runtime.createTranslationVerifierChatModel({ ...input.model, maxOutputTokens: 16_384 }),
    signal: input.signal,
    workLogger: (event: VerifierWorkEvent) => { const message = verifierWorkLogMessage(event); if (message) input.log(message); },
  });
  const common = { schemaVersion: '3.1' as const, targetLanguage: input.module.target.language,
    targetProjectPath: input.root, requirement: input.requirement, moduleProtocol: input.protocol,
    ...(input.previous?.result?.testEvidence ? { testEvidence: input.previous.result.testEvidence } : {}) };
  let result: FunctionGroupVerificationResult;
  try {
    result = await runtime.createFunctionGroupVerifier(host)(fidelity ? {
      ...common, sourceLanguage: input.candidates[0]!.language, sourceProjectPath: join(input.historyView!.root, 'source'), functions: mapping.functions,
    } : { ...common, mode: 'requirement', sourceLanguage: input.module.target.language, functions: functions.map(target => ({ target })) },
    fidelity ? 'single-agent-function-group' : 'requirement-function-group', 'verify');
  } catch (error) {
    input.signal.throwIfAborted();
    const description = error instanceof Error ? error.message : String(error);
    const { reason, issueKind } = classifyVerifierError(error);
    const testEvidence = (error as { testEvidence?: FunctionGroupVerificationResult['testEvidence'] })?.testEvidence ?? common.testEvidence;
    result = { status: 'failure', reason, issue: { kind: issueKind, description },
      ...(testEvidence ? { testEvidence } : {}), functions: functions.map(target => ({ target, status: 'unverified', executed: false, lineCoverage: null, branchCoverage: null, reason })) };
  }
  input.signal.throwIfAborted();
  attempts.push(result);
  return { mode, result, attempts, disposition: verifierDisposition(result) };
}
