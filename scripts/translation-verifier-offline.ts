/**
 * Offline verifier wiring shared by the module pipeline, completed-project
 * verification and the protocol handoff probe.
 *
 * These helpers are pure: importing them never builds a model, reaches a
 * provider or starts a pipeline, so the deterministic script tests exercise
 * the same mapping the real callers use.
 */
import type { AgentTask } from '../services/translation-verifier/src/host/agent/task.js';
import type { TranslationVerifierChatModelOptions } from '../services/translation-verifier/src/host/agent/chat-model.js';
import type { AgentTraceEvent } from '../services/translation-verifier/src/host/logging/trace-log.js';
import type { FunctionGroupTestRun } from '../services/translation-verifier/src/host/tools/common.js';
import { createTranslationVerifierChatModel } from '../services/translation-verifier/src/host/agent/chat-model.js';
import type {
  FunctionGroupVerificationInput,
  RequirementFunctionGroupVerificationInput,
} from '../services/translation-verifier/src/types.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 750;

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
      delayMs: integer(env.TRANSLATION_VERIFIER_REQUEST_RETRY_DELAY_MS, DEFAULT_REQUEST_RETRY_DELAY_MS),
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
 * Events worth keeping in the offline verifier evidence file. The LangChain
 * Host bounds tool payloads to 24k characters; the accepted observation still
 * comes from `host.revalidation.completed`, never from the Agent's own run.
 */
export const OFFLINE_VERIFIER_LOG_EVENTS: readonly string[] = [
  'tool.started',
  'tool.completed',
  'tool.failed',
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

export type OfflineVerifierFailure = {
  reason: 'agent-timeout' | 'model-failure' | 'test-environment-failure';
  kind: 'environment' | 'unknown';
};

/** The Host failure type carries the operational reason; wrappers keep it as a cause. */
type TypedRunFailure = Error & { reason?: unknown; cause?: unknown };

function runFailureReason(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const reason = (current as TypedRunFailure).reason;
    if (reason === 'budget' || reason === 'context' || reason === 'model') return reason;
    current = (current as TypedRunFailure).cause;
  }
  return undefined;
}

/**
 * Map a failed verifier run onto the existing public failure reasons. Budget,
 * context/response exhaustion and model transport errors stay operational
 * failures, never a production defect or an environment verdict.
 *
 * A typed Host failure decides from its own reason; the historical message
 * classification stays as a fallback for wrapped or foreign errors.
 */
export function classifyOfflineVerifierFailure(error: unknown): OfflineVerifierFailure {
  const reason = runFailureReason(error);
  if (reason === 'budget' || reason === 'context') return { reason: 'agent-timeout', kind: 'unknown' };
  if (reason === 'model') return { reason: 'model-failure', kind: 'unknown' };
  const description = error instanceof Error ? error.message : String(error);
  const text = description.toLowerCase();
  if (
    text.includes('exhausted its') ||
    text.includes('budget exhausted') ||
    text.includes('turn budget') ||
    text.includes('tool-call budget') ||
    text.includes('time budget') ||
    text.includes('feedback rounds') ||
    /context.*budget/.test(text)
  ) {
    return { reason: 'agent-timeout', kind: 'unknown' };
  }
  if (
    text.includes('model request') ||
    text.includes('invalid completion') ||
    text.includes('api key') ||
    text.includes('model failure') ||
    text.includes('api connection') ||
    text.includes('rate limit') ||
    text.includes('authentication')
  ) {
    return { reason: 'model-failure', kind: 'unknown' };
  }
  return { reason: 'test-environment-failure', kind: 'environment' };
}

/** One generated test file captured for later review. */
export type OfflineTestVersion = {
  path: string;
  /** Missing when neither the bounded payload nor the written file was readable. */
  content?: string;
  source: 'tool-input' | 'written-file';
};

export type OfflineToolFailure = { toolName: string; message?: string; errorType?: string };

export type OfflineVerifierEvidence = {
  /** Agent-side test-run observations kept for existing artifact consumers. */
  testRuns: FunctionGroupTestRun[];
  /** Generated test files, captured from the bounded payload or the written file. */
  testVersions: OfflineTestVersion[];
  toolFailures: OfflineToolFailure[];
  /** Fresh Host observation of the last revalidation round; the authoritative evidence. */
  finalObservation?: FunctionGroupTestRun;
  finalObservationRound?: number;
  /** Started write intents of this run only, correlated with their completion by tool call id. */
  pendingWrites: Map<string, PendingWrite>;
};

/** Narrow hooks: the scripts supply filesystem access, the evidence logic stays pure. */
export type OfflineVerifierEvidenceHooks = {
  /** Read a written test file by project-relative path; undefined when unavailable. */
  readTestFile?: (path: string) => string | undefined;
};

export function createOfflineVerifierEvidence(): OfflineVerifierEvidence {
  return { testRuns: [], testVersions: [], toolFailures: [], pendingWrites: new Map() };
}

type PendingWrite = { path?: string; content?: string };

function parseWriteInput(input: unknown): PendingWrite {
  const value = typeof input === 'string' ? parseJsonObject(input) : input;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.content === 'string' ? { content: record.content } : {}),
  };
}

function parseJsonObject(text: string): unknown {
  // A bounded payload ends with "...(truncated)"; it is not JSON and must never
  // be stored as the test content.
  if (text.endsWith('...(truncated)')) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function completedWritePath(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined;
  const path = (output as Record<string, unknown>).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/**
 * Record one filtered trace event. Returns true when the event contributed
 * evidence so callers can persist selectively.
 */
export function recordOfflineVerifierEvent(
  evidence: OfflineVerifierEvidence,
  event: AgentTraceEvent,
  hooks: OfflineVerifierEvidenceHooks = {},
): boolean {
  if (event.event === 'host.revalidation.completed' && event.observation) {
    evidence.finalObservation = event.observation as FunctionGroupTestRun;
    evidence.finalObservationRound = typeof event.round === 'number' ? event.round : undefined;
    return true;
  }
  if (event.event === 'tool.started' && event.toolName === 'write_target_test') {
    evidence.pendingWrites.set(writeKey(event), parseWriteInput(event.input));
    return true;
  }
  if (event.event === 'tool.failed') {
    const message = typeof event.error === 'string'
      ? event.error
      : typeof event.message === 'string' ? event.message : undefined;
    evidence.toolFailures.push({
      toolName: String(event.toolName),
      ...(message === undefined ? {} : { message }),
      ...(typeof event.errorType === 'string' ? { errorType: event.errorType } : {}),
    });
    // A failed write never wrote its payload: drop the intent so a later
    // completion cannot record the rejected content as the current test.
    if (event.toolName === 'write_target_test') clearWriteIntent(evidence, event);
    return true;
  }
  if (event.event !== 'tool.completed') return false;
  if (event.toolName === 'run_function_group_tests') {
    const observation = event.output as FunctionGroupTestRun | undefined;
    if (observation?.tests) evidence.testRuns.push(observation);
    return true;
  }
  if (event.toolName === 'write_target_test') {
    const key = writeKey(event);
    const pending = evidence.pendingWrites.get(key) ?? evidence.pendingWrites.get('write_target_test');
    clearWriteIntent(evidence, event);
    const path = completedWritePath(event.output) ?? pending?.path;
    if (path === undefined) return false;
    const payloadContent = pending?.content;
    const content = payloadContent ?? hooks.readTestFile?.(path);
    evidence.testVersions.push({
      path,
      ...(content === undefined ? {} : { content }),
      source: payloadContent === undefined ? 'written-file' : 'tool-input',
    });
    return true;
  }
  return false;
}

function clearWriteIntent(
  evidence: OfflineVerifierEvidence,
  event: Pick<AgentTraceEvent, 'event'> & { toolCallId?: unknown },
): void {
  evidence.pendingWrites.delete(writeKey(event));
  evidence.pendingWrites.delete('write_target_test');
}

function writeKey(event: Pick<AgentTraceEvent, 'event'> & { toolCallId?: unknown }): string {
  return typeof event.toolCallId === 'string' ? event.toolCallId : 'write_target_test';
}

export type OfflineVerifierTaskInputs = {
  requirement: RequirementFunctionGroupVerificationInput;
  translation: FunctionGroupVerificationInput;
};

/**
 * Read the business input from the task context only; the Host receives it
 * through `taskContext.functionGroup` and the task carries no duplicate copy.
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
