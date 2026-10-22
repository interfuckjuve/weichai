/**
 * Offline verifier wiring shared by the module pipeline, completed-project
 * verification and the protocol handoff probe.
 *
 * These helpers are pure: importing them never builds a model, reaches a
 * provider or starts a pipeline, so the deterministic script tests exercise
 * the same mapping the real callers use.
 */
import type { AgentTask } from '../services/translation-verifier/src/host/agent.js';
import type { TranslationVerifierChatModelOptions } from '../services/translation-verifier/src/host/chat-model.js';
import type { AgentTraceEvent } from '../services/translation-verifier/src/host/trace-log.js';
import type { FunctionGroupTestRun } from '../services/translation-verifier/src/host/tools/common.js';
import { createTranslationVerifierChatModel } from '../services/translation-verifier/src/host/chat-model.js';
import type {
  FunctionGroupVerificationInput,
  RequirementFunctionGroupVerificationInput,
} from '../services/translation-verifier/src/types.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_REQUEST_ATTEMPTS = 3;

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Map the existing offline environment onto the framework model options.
 * The credential stays a caller-owned value and never becomes prompt text.
 */
export function offlineVerifierModelOptions(
  env: NodeJS.ProcessEnv,
  request?: typeof globalThis.fetch,
): TranslationVerifierChatModelOptions {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('Configured verifier model credential is required.');
  return {
    apiKey,
    ...(env.DEEPSEEK_API_BASE ? { apiBase: env.DEEPSEEK_API_BASE } : {}),
    ...(env.DEEPSEEK_MODEL ? { model: env.DEEPSEEK_MODEL } : {}),
    maxOutputTokens: integer(env.TRANSLATION_VERIFIER_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
    requestRetry: {
      maxAttempts: integer(env.TRANSLATION_VERIFIER_REQUEST_ATTEMPTS, DEFAULT_REQUEST_ATTEMPTS),
    },
    ...(request ? { request } : {}),
  };
}

/** Build the framework chat model used by the offline LangChain Hosts. */
export function createOfflineVerifierChatModel(
  env: NodeJS.ProcessEnv,
  request?: typeof globalThis.fetch,
): ReturnType<typeof createTranslationVerifierChatModel> {
  return createTranslationVerifierChatModel(offlineVerifierModelOptions(env, request));
}

/**
 * Events worth keeping in the offline verifier evidence file. Tool payloads
 * are gone in the LangChain Host, so the accepted observation comes from
 * `host.revalidation.completed` instead of `tool.completed`.
 */
export const OFFLINE_VERIFIER_LOG_EVENTS: readonly string[] = [
  'tool.completed',
  'agent.invocation.completed',
  'host.revalidation.completed',
  'agent.feedback.appended',
  'run.completed',
  'run.failed',
];

/** Test tools worth recording; the removed terminal tools are gone. */
export const OFFLINE_VERIFIER_TOOL_NAMES: readonly string[] = [
  'write_target_test',
  'run_function_group_tests',
];

export function isOfflineVerifierTraceEvent(
  event: Pick<AgentTraceEvent, 'event'> & { toolName?: unknown },
): boolean {
  if (!OFFLINE_VERIFIER_LOG_EVENTS.includes(event.event)) return false;
  if (event.event.startsWith('tool.') && !OFFLINE_VERIFIER_TOOL_NAMES.includes(String(event.toolName))) {
    return false;
  }
  return true;
}

export type OfflineVerifierEvidence = {
  /** Agent-side test tool activity, without payloads in the current Host. */
  toolEvents: AgentTraceEvent[];
  /** Fresh Host observation of the last revalidation round; the accepted evidence. */
  finalObservation?: FunctionGroupTestRun;
  finalObservationRound?: number;
};

export function createOfflineVerifierEvidence(): OfflineVerifierEvidence {
  return { toolEvents: [] };
}

/**
 * Record one filtered trace event. Returns true when the event contributed
 * evidence so callers can log or persist selectively.
 */
export function recordOfflineVerifierEvent(
  evidence: OfflineVerifierEvidence,
  event: AgentTraceEvent,
): boolean {
  if (event.event === 'host.revalidation.completed' && event.observation) {
    evidence.finalObservation = event.observation as FunctionGroupTestRun;
    evidence.finalObservationRound = typeof event.round === 'number' ? event.round : undefined;
    return true;
  }
  if (event.event.startsWith('tool.')) {
    evidence.toolEvents.push(event);
    return true;
  }
  return false;
}

export type OfflineVerifierTaskInputs = {
  requirement: RequirementFunctionGroupVerificationInput;
  translation: FunctionGroupVerificationInput;
};

/**
 * Read the business input from the task context only. `AgentTask.functionGroup`
 * is a duplicate source kept for the legacy Host and must not be read here.
 */
export function verifierTaskInputs(tasks: {
  requirement: AgentTask;
  translation: AgentTask;
}): OfflineVerifierTaskInputs {
  const requirement = tasks.requirement.taskContext.functionGroup;
  const translation = tasks.translation.taskContext.functionGroup;
  if (requirement === undefined || translation === undefined) {
    throw new Error('Verifier task is missing its function-group context.');
  }
  return {
    requirement: requirement as RequirementFunctionGroupVerificationInput,
    translation: translation as FunctionGroupVerificationInput,
  };
}
