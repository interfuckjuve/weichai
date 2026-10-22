import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import {
  createFunctionGroupFinalReportTask,
  createRequirementFunctionGroupFinalReportTask,
} from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import type { AgentTraceEvent } from '../services/translation-verifier/src/host/trace-log.js';
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
    status: 'success',
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
    for (const message of [
      'Agent run budget exhausted: 64 tool calls exceed the 16-call per-turn limit.',
      'Agent run context budget exhausted: 2000000 characters exceed the 1500000-character limit.',
      'Agent run response budget exhausted: 40000 characters exceed the 20000-character limit.',
      'Agent did not produce an accepted final report within 4 feedback rounds.',
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
    expect(isOfflineVerifierTraceEvent(traceEvent('model.request'))).toBe(false);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.completed', { toolName: 'finish_function_group' }))).toBe(false);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.started', { toolName: 'write_target_test' }))).toBe(false);
    expect(isOfflineVerifierTraceEvent(traceEvent('tool.completed', { toolName: 'read_target_file' }))).toBe(false);
  });
});

describe('offline verifier evidence', () => {
  it('takes the final observation from the Host revalidation of the last round', () => {
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
    expect(evidence.finalObservation?.tests.executed).toBe(4);
    expect(evidence.finalObservation?.reportPaths).toEqual(['revalidation-2.xml']);
    expect(evidence.finalObservationRound).toBe(2);
  });
});

describe('offline verifier task handoff', () => {
  const protocol = {
    boundaries: [{ id: 'boundary-1', module: 'orders', name: 'Order boundary', rule: 'Reject empty ids.' }],
    sharedContracts: [{ id: 'contract-1', name: 'Price contract', rule: 'Prices stay positive.' }],
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
    // The removed duplicate source is ignored; only taskContext carries the input.
    const inputs = verifierTaskInputs({
      requirement: { ...requirementTask, functionGroup: undefined },
      translation: { ...translationTask, functionGroup: undefined },
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
      requirement: { ...task, taskContext: { ...task.taskContext, functionGroup: undefined }, functionGroup: undefined },
      translation: task,
    })).toThrow(/function-group context/);
  });
});

describe('offline verifier script wiring', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), 'scripts', file), 'utf8');

  it('constructs the LangChain function-group Host and chat model without the legacy protocol path', () => {
    for (const file of ['run-target-module-pipeline.mts', 'verify-completed-project.mts']) {
      const source = read(file);
      expect(source, file).toContain('createLangChainFunctionGroupAgentHost');
      expect(source, file).toContain('createOfflineVerifierChatModel');
      expect(source, file).not.toContain('createTranslationVerifierModelClient');
      expect(source, file).not.toMatch(/createAgentHost\b/);
      expect(source, file).not.toContain('SingleAgentFunctionGroupTerminalResult');
    }
  });

  it('keeps the handoff probe on the taskContext business input', () => {
    const source = read('verify-protocol-pipeline-handoff.mts');
    expect(source).toContain('verifierTaskInputs');
    expect(source).toContain('createRequirementFunctionGroupFinalReportTask');
    expect(source).toContain('createFunctionGroupFinalReportTask');
    expect(source).not.toContain('Task.functionGroup');
  });
});
