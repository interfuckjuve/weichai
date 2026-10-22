import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import {
  createFunctionGroupFinalReportTask,
  createRequirementFunctionGroupFinalReportTask,
} from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import type { AgentTraceEvent } from '../services/translation-verifier/src/host/logging/trace-log.js';
import type { FunctionGroupTestRun } from '../services/translation-verifier/src/host/tools/common.js';
import {
  classifyOfflineVerifierFailure,
  createOfflineVerifierChatModel,
  createOfflineVerifierEvidence,
  isOfflineVerifierTraceEvent,
  offlineVerifierModelOptions,
  recordOfflineVerifierEvent,
  verifierTaskInputs,
} from './translation-verifier-offline.js';
import { AgentRunFailure } from '../services/translation-verifier/src/host/agent/run-budget.js';

const completion = {
  id: 'completion-1',
  object: 'chat.completion',
  created: 0,
  model: 'deepseek-test',
  choices: [{ index: 0, message: { role: 'assistant', content: '{"verdict":"no-bug","summary":"ok"}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function recordingFetch(responses: Response[]) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (response === undefined) throw new Error('No scripted HTTP response remains.');
    return response;
  }) as typeof globalThis.fetch;
  return { calls, request };
}

const traceEvent = (event: string, extra: Record<string, unknown> = {}): AgentTraceEvent => ({
  at: '2024-01-01T00:00:00.000Z',
  runId: 'run-1',
  event,
  ...extra,
});

const run = (executed: number, reportPath: string): FunctionGroupTestRun => ({
  status: 'success',
  testPaths: ['Test.cs'],
  tests: { executed, passed: executed, failed: 0, skipped: 0 },
  functions: [{
    target: { path: 'src/Service.cs', name: 'Run', signature: 'Service.Run' },
    executed: true,
    status: 'passed',
    lineCoverage: 90,
    branchCoverage: 80,
  }],
  failures: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  reportPaths: [reportPath],
});

describe('offline verifier model mapping', () => {
  it('maps the offline verifier environment onto framework chat-model options', () => {
    expect(offlineVerifierModelOptions({
      DEEPSEEK_API_KEY: 'sk-offline-secret',
      DEEPSEEK_API_BASE: 'https://example.test/v1/',
      DEEPSEEK_MODEL: 'deepseek-test',
      TRANSLATION_VERIFIER_MAX_OUTPUT_TOKENS: '321',
      TRANSLATION_VERIFIER_REQUEST_ATTEMPTS: '2',
      TRANSLATION_VERIFIER_REQUEST_RETRY_DELAY_MS: '500',
    })).toEqual({
      apiKey: 'sk-offline-secret',
      apiBase: 'https://example.test/v1/',
      model: 'deepseek-test',
      maxOutputTokens: 321,
      requestRetry: { maxAttempts: 2, delayMs: 500 },
    });
  });

  it('keeps the legacy retry defaults when the environment does not set them', () => {
    expect(offlineVerifierModelOptions({ DEEPSEEK_API_KEY: 'sk-offline-secret' })).toEqual({
      apiKey: 'sk-offline-secret',
      maxOutputTokens: 16_384,
      requestRetry: { maxAttempts: 3, delayMs: 750 },
    });
  });

  it('requires the caller-owned credential instead of falling back to another provider', () => {
    expect(() => offlineVerifierModelOptions({})).toThrow(/credential/);
  });

  it('sends the configured key, base, model and output limit through the LangChain path', async () => {
    const { calls, request } = recordingFetch([
      new Response(JSON.stringify(completion), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]);
    const model = createOfflineVerifierChatModel({
      DEEPSEEK_API_KEY: 'sk-offline-secret',
      DEEPSEEK_API_BASE: 'https://example.test/v1',
      DEEPSEEK_MODEL: 'deepseek-test',
      TRANSLATION_VERIFIER_MAX_OUTPUT_TOKENS: '321',
    }, request);
    const response = await model.invoke([new HumanMessage('Verify the target function.')]);
    expect(response.content).toBe('{"verdict":"no-bug","summary":"ok"}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-offline-secret');
    expect(calls[0]!.body.model).toBe('deepseek-test');
    expect(calls[0]!.body.max_tokens).toBe(321);
    // The credential stays in transport configuration, never in model-visible messages.
    expect(JSON.stringify(calls[0]!.body.messages)).not.toContain('sk-offline-secret');
  });
});

describe('offline verifier failure classification', () => {
  it('classifies the LangChain run failures as non-defect operational errors', () => {
    // The pipeline hands over the Host error itself, so a typed reason maps
    // without depending on message wording or localization.
    for (const reason of ['budget', 'context'] as const) {
      expect(classifyOfflineVerifierFailure(new AgentRunFailure(reason, 'Verifier stopped operating.')))
        .toEqual({ reason: 'agent-timeout', kind: 'unknown' });
    }
    expect(classifyOfflineVerifierFailure(new AgentRunFailure('model', 'Verifier provider failure.')))
      .toEqual({ reason: 'model-failure', kind: 'unknown' });
    // Middleware wraps a typed failure once, so the cause chain is consulted.
    const wrapped = new Error('middleware failure');
    (wrapped as { cause?: unknown }).cause = new AgentRunFailure('model', 'Verifier provider failure.');
    expect(classifyOfflineVerifierFailure(wrapped)).toEqual({ reason: 'model-failure', kind: 'unknown' });
    expect(classifyOfflineVerifierFailure(new Error('Compilation failed with CS0246 in OrderTests.cs')))
      .toEqual({ reason: 'test-environment-failure', kind: 'environment' });
  });

  it('keeps the historical message classification for plain strings and messages', () => {
    for (const message of [
      'Agent run budget exhausted: 64 tool calls exceed the 16-call per-turn limit.',
      'Agent run context budget exhausted: 2000000 characters exceed the 1500000-character limit.',
      'Agent run response budget exhausted: 40000 characters exceed the 20000-character limit.',
      'Agent run budget exhausted: no accepted final report within 4 feedback rounds.',
    ]) {
      expect(classifyOfflineVerifierFailure(message)).toEqual({ reason: 'agent-timeout', kind: 'unknown' });
    }
    for (const message of [
      'Agent run model failure: 401 Unauthorized',
      'Model request failed after 3 attempts.',
      'Invalid completion returned by the provider.',
    ]) {
      expect(classifyOfflineVerifierFailure(message)).toEqual({ reason: 'model-failure', kind: 'unknown' });
    }
    expect(classifyOfflineVerifierFailure('Compilation failed with CS0246 in OrderTests.cs'))
      .toEqual({ reason: 'test-environment-failure', kind: 'environment' });
  });
});

describe('offline verifier trace filter', () => {
  it('keeps the new Host events and drops removed terminal-tool traffic', () => {
    for (const event of [
      'tool.completed',
      'agent.invocation.completed',
      'host.revalidation.completed',
      'agent.feedback.appended',
      'run.completed',
      'run.failed',
    ]) {
      expect(isOfflineVerifierTraceEvent(traceEvent(event, { toolName: 'run_function_group_tests' }))).toBe(true);
    }
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.started', { toolName: 'write_target_test' }))).toBe(true);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.failed', { toolName: 'run_function_group_tests' }))).toBe(true);
    expect(isOfflineVerifierTraceEvent(traceEvent('model.request'))).toBe(false);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.completed', { toolName: 'finish_function_group' }))).toBe(false);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.started', { toolName: 'read_target_file' }))).toBe(false);
  });
});

describe('offline verifier evidence', () => {
  it('keeps tool-run observations and takes the authoritative observation from the last Host revalidation', () => {
    const evidence = createOfflineVerifierEvidence();
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.completed', {
      toolName: 'run_function_group_tests',
      output: run(2, 'target/site/jacoco/jacoco.xml'),
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('host.revalidation.completed', {
      round: 1,
      observation: run(3, 'revalidation-1.xml'),
      feedback: ['A target is unverified.'],
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('host.revalidation.completed', {
      round: 2,
      observation: run(4, 'revalidation-2.xml'),
      feedback: [],
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('agent.invocation.completed', { round: 2 }))).toBe(false);
    // Tool runs stay available for existing consumers of the artifact.
    expect(evidence.testRuns.map(item => item.tests.executed)).toEqual([2]);
    // The authoritative observation is the Host revalidation of the last round.
    expect(evidence.finalObservation?.tests.executed).toBe(4);
    expect(evidence.finalObservation?.reportPaths).toEqual(['revalidation-2.xml']);
    expect(evidence.finalObservationRound).toBe(2);
  });

  it('records tool failures without inventing an observation', () => {
    const evidence = createOfflineVerifierEvidence();
    // The Host trace carries error and errorType; the artifact keeps both so a
    // failed tool call is not silently reduced to a missing observation.
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.failed', {
      toolName: 'run_function_group_tests',
      error: 'authorized test root required',
      errorType: 'Error',
    }))).toBe(true);
    expect(evidence.toolFailures).toEqual([{
      toolName: 'run_function_group_tests',
      message: 'authorized test root required',
      errorType: 'Error',
    }]);
    expect(evidence.finalObservation).toBeUndefined();
  });

  it('drops the started write intent when its tool call fails', () => {
    const evidence = createOfflineVerifierEvidence();
    const path = '.translation-verifier-tests/java/FailedWrite.java';
    recordOfflineVerifierEvent(evidence, traceEvent('tool.started', {
      toolName: 'write_target_test',
      toolCallId: 'call-4',
      input: { path, content: 'class FailedWrite { BROKEN }' },
    }));
    recordOfflineVerifierEvent(evidence, traceEvent('tool.failed', {
      toolName: 'write_target_test',
      toolCallId: 'call-4',
      error: 'Test path is outside the authorized test roots.',
      errorType: 'Error',
    }));
    recordOfflineVerifierEvent(evidence, traceEvent('tool.completed', {
      toolName: 'write_target_test',
      toolCallId: 'call-4',
      output: { path },
    }), { readTestFile: requested => requested === path ? 'class Repaired { }' : undefined });
    // The failed payload must never be recorded as the written test.
    expect(evidence.testVersions).toEqual([{
      path,
      content: 'class Repaired { }',
      source: 'written-file',
    }]);
  });

  it('keeps started write intents inside one evidence object', () => {
    const first = createOfflineVerifierEvidence();
    const second = createOfflineVerifierEvidence();
    const path = '.translation-verifier-tests/java/Isolated.java';
    recordOfflineVerifierEvent(first, traceEvent('tool.started', {
      toolName: 'write_target_test',
      toolCallId: 'call-5',
      input: { path, content: 'class First { }' },
    }));
    recordOfflineVerifierEvent(second, traceEvent('tool.completed', {
      toolName: 'write_target_test',
      toolCallId: 'call-5',
      output: { path },
    }), { readTestFile: requested => requested === path ? 'class Second { }' : undefined });
    // Another run must not inherit this run's unfinished write intent.
    expect(second.testVersions).toEqual([{ path, content: 'class Second { }', source: 'written-file' }]);
    expect(first.testVersions).toEqual([]);
  });

  it('snapshots the written test from the tool payload when it is complete', () => {
    const evidence = createOfflineVerifierEvidence();
    const content = 'class OrderTests { }';
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.started', {
      toolName: 'write_target_test',
      toolCallId: 'call-1',
      input: { path: '.translation-verifier-tests/java/OrderTests.java', content },
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.completed', {
      toolName: 'write_target_test',
      toolCallId: 'call-1',
      output: { path: '.translation-verifier-tests/java/OrderTests.java' },
    }), { readTestFile: () => undefined })).toBe(true);
    expect(evidence.testVersions).toEqual([{
      path: '.translation-verifier-tests/java/OrderTests.java',
      content,
      source: 'tool-input',
    }]);
  });

  it('falls back to the written file when the bounded payload is truncated instead of storing the marker', () => {
    const evidence = createOfflineVerifierEvidence();
    const path = '.translation-verifier-tests/java/LargeTests.java';
    const full = 'class LargeTests {\n' + '  // filler\n'.repeat(4_000) + '}';
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.started', {
      toolName: 'write_target_test',
      toolCallId: 'call-2',
      input: `{"path":"${path}","content":"class LargeTests {  ...(truncated)`,
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.completed', {
      toolName: 'write_target_test',
      toolCallId: 'call-2',
      output: { path },
    }), { readTestFile: requested => requested === path ? full : undefined })).toBe(true);
    expect(evidence.testVersions).toHaveLength(1);
    expect(evidence.testVersions[0]!.content).toBe(full);
    expect(evidence.testVersions[0]!.source).toBe('written-file');
    expect(evidence.testVersions[0]!.content).not.toContain('(truncated)');
  });

  it('records the completed write output path when the start payload could not be parsed', () => {
    const evidence = createOfflineVerifierEvidence();
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.started', {
      toolName: 'write_target_test',
      toolCallId: 'call-3',
      input: '(unserializable value)',
    }))).toBe(true);
    expect(recordOfflineVerifierEvent(evidence, traceEvent('tool.completed', {
      toolName: 'write_target_test',
      toolCallId: 'call-3',
      output: { path: '.translation-verifier-tests/csharp/OrderTests.cs' },
    }), { readTestFile: () => undefined })).toBe(true);
    expect(evidence.testVersions[0]?.path).toBe('.translation-verifier-tests/csharp/OrderTests.cs');
    expect(evidence.testVersions[0]?.content).toBeUndefined();
  });
});

describe('offline verifier task handoff', () => {
  const protocol = {
    version: 1 as const,
    moduleId: 'orders',
    sourceVersion: 1 as const,
    invariants: [],
    boundaries: [{
      id: 'boundary-1',
      module: 'orders',
      responsibility: 'Owns order admission.',
      source: 'module-confirmed' as const,
      status: 'verified' as const,
      note: 'Reject empty ids.',
    }],
    sharedContracts: [{
      id: 'contract-1',
      name: 'Price contract',
      rule: 'Prices stay positive.',
      source: 'requirement' as const,
      status: 'fixed' as const,
    }],
    openQuestions: [],
  };
  const functions = [
    { path: 'src/Service.cs', name: 'Run', signature: 'Service.Run' },
    { path: 'src/Service.cs', name: 'Stop', signature: 'Service.Stop' },
  ];
  const requirement = 'Both functions keep the documented order contract.';

  it('reads the complete business input from taskContext instead of the duplicated task field', () => {
    const requirementInput = {
      schemaVersion: '3.1' as const,
      mode: 'requirement' as const,
      sourceLanguage: 'C#',
      targetLanguage: 'C#',
      targetProjectPath: '/tmp/target-project',
      requirement,
      functions: functions.map(target => ({ target })),
      moduleProtocol: protocol,
    };
    const translationInput = {
      schemaVersion: '3.1' as const,
      sourceLanguage: 'C#',
      targetLanguage: 'C#',
      sourceProjectPath: '/tmp/source-project',
      targetProjectPath: '/tmp/target-project',
      requirement,
      functions: functions.map(target => ({ source: target, target })),
      moduleProtocol: protocol,
    };
    const requirementTask = createRequirementFunctionGroupFinalReportTask(requirementInput);
    const translationTask = createFunctionGroupFinalReportTask(translationInput);
    // Only taskContext carries the business input; the task has no duplicate copy.
    const inputs = verifierTaskInputs({
      requirement: requirementTask,
      translation: translationTask,
    });
    expect(inputs.requirement).toEqual(requirementInput);
    expect(inputs.translation).toEqual(translationInput);
    for (const task of [requirementTask, translationTask]) {
      for (const entry of [...protocol.boundaries, ...protocol.sharedContracts]) {
        expect(task.userPrompt).toContain(entry.id);
      }
    }
  });

  it('fails loudly when a task carries no function-group context', () => {
    const task = createRequirementFunctionGroupFinalReportTask({
      schemaVersion: '3.1',
      mode: 'requirement',
      sourceLanguage: 'C#',
      targetLanguage: 'C#',
      targetProjectPath: '/tmp/target-project',
      requirement,
      functions: functions.map(target => ({ target })),
    });
    expect(() => verifierTaskInputs({
      requirement: { ...task, taskContext: { ...task.taskContext, functionGroup: undefined } },
      translation: task,
    })).toThrow(/function-group context/);
  });
});
