// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  classifyVerifierError,
  selectVerificationMode,
  verifierDisposition,
  verifierWorkLogMessage,
} from './project-module-verifier';
import type { FunctionGroupVerificationResult } from '../../../services/translation-verifier/src/types';

const target = { path: 'src/Order.java', name: 'calculatePrice' };
const functionResult = { target, status: 'passed' as const, executed: true, lineCoverage: 100, branchCoverage: null };

function result(overrides: Partial<FunctionGroupVerificationResult>): FunctionGroupVerificationResult {
  return { status: 'failure', functions: [functionResult], ...overrides };
}

describe('verifier result classification', () => {
  it('keeps the public upstream buckets for accepted and failed results', () => {
    expect(verifierDisposition(result({ status: 'success' }))).toBe('verified');
    expect(verifierDisposition(result({
      status: 'failure', issue: { kind: 'translation', description: 'Discounts are not applied.' }, reason: 'test-failed',
    }))).toBe('production-defect');
    expect(verifierDisposition(result({
      status: 'failure', issue: { kind: 'unknown', description: 'The contract for zero quantities is missing.' },
    }))).toBe('agent-uncertain');
    expect(verifierDisposition(result({
      status: 'failure', issue: { kind: 'test', description: 'Surefire report is stale.' },
    }))).toBe('test-environment');
    expect(verifierDisposition(result({ status: 'failure', reason: 'coverage-unavailable' }))).toBe('test-environment');
    expect(verifierDisposition(result({ status: 'failure', reason: 'mapping-invalid' }))).toBe('agent-uncertain');
  });

  it('never reports an uncertain issue as verified or as a production defect', () => {
    const uncertain = result({ status: 'failure', issue: { kind: 'unknown', description: 'Missing semantic evidence.' } });
    expect(verifierDisposition(uncertain)).toBe('agent-uncertain');
    expect(verifierDisposition({ ...uncertain, status: 'success' })).toBe('verified');
    const legacy = result({ status: 'success', testEvidence: {
      failures: [{ id: 'f1', status: 'unresolved', message: 'ambiguous requirement' }],
    } as unknown as FunctionGroupVerificationResult['testEvidence'] });
    expect(verifierDisposition(legacy)).toBe('agent-uncertain');
  });
});

describe('verification mode routing', () => {
  const history = { root: '/history', files: ['src/Order.cs'], candidates: [] };
  const candidate = { language: 'C#' } as never;
  it('uses translation fidelity only for a complete single-language mapping', () => {
    expect(selectVerificationMode({ historyView: history as never, candidates: [candidate, candidate], mapping: { functions: [{}], unmatchedFunctions: [] } }))
      .toBe('translation-fidelity');
    expect(selectVerificationMode({ historyView: history as never, candidates: [candidate], mapping: { functions: [], unmatchedFunctions: [{}] } }))
      .toBe('requirement');
    expect(selectVerificationMode({ historyView: history as never, candidates: [candidate], mapping: { functions: [{}], unmatchedFunctions: [{}] } }))
      .toBe('requirement');
    expect(selectVerificationMode({ candidates: [candidate], mapping: { functions: [{}], unmatchedFunctions: [] } }))
      .toBe('requirement');
    expect(selectVerificationMode({ historyView: history as never, candidates: [{ language: 'C#' } as never, { language: 'Java' } as never], mapping: { functions: [{}], unmatchedFunctions: [] } }))
      .toBe('requirement');
  });
});

describe('verifier failure classification', () => {
  it('maps framework reasons and messages onto the existing buckets', () => {
    expect(classifyVerifierError({ reason: 'budget', message: 'budget exhausted' })).toEqual({ reason: 'agent-timeout', issueKind: 'unknown' });
    expect(classifyVerifierError({ reason: 'context', message: 'context budget exhausted' })).toEqual({ reason: 'agent-timeout', issueKind: 'unknown' });
    expect(classifyVerifierError({ reason: 'model', message: 'model failure' })).toEqual({ reason: 'model-failure', issueKind: 'unknown' });
    expect(classifyVerifierError(new Error('Agent exhausted its 12-turn budget.'))).toMatchObject({ reason: 'agent-timeout' });
    expect(classifyVerifierError(new Error('Model call limits exceeded: thread level call limit reached')))
      .toEqual({ reason: 'agent-timeout', issueKind: 'unknown' });
    expect(classifyVerifierError(new Error('Agent run budget exhausted: no accepted final report within 4 feedback rounds.')))
      .toEqual({ reason: 'agent-timeout', issueKind: 'unknown' });
    expect(classifyVerifierError(new Error('401 Incorrect API key provided'))).toMatchObject({ reason: 'model-failure', issueKind: 'unknown' });
    expect(classifyVerifierError(new Error('Could not find a Maven or Gradle configuration'))).toEqual({ reason: 'test-environment-failure', issueKind: 'environment' });
  });
});

describe('verifier work log', () => {
  it('distinguishes an invocation ending, Host revalidation, feedback and the overall outcome', () => {
    expect(verifierWorkLogMessage({ event: 'agent.invocation.completed', turn: 1, status: 'no-bug' }))
      .toBe('Verifier：Agent 调用完成（第 1 轮），候选结论 no-bug，等待 Host 复验');
    expect(verifierWorkLogMessage({ event: 'host.revalidation.completed', turn: 1, status: 'success', outcome: 'accepted', toolCallCount: 2, exitCode: 0 }))
      .toBe('Verifier：Host 复验（第 1 轮）（success，执行 2 个测试，退出码 0）：接受候选结论');
    expect(verifierWorkLogMessage({ event: 'agent.feedback.appended', turn: 1, messageCount: 2 }))
      .toBe('Verifier：向同一 Agent 追加反馈（第 1 轮）（2 项）');
    expect(verifierWorkLogMessage({ event: 'run.completed', outcome: 'bug-found' })).toBe('Verifier：验证运行完成，结论 bug-found');
    expect(verifierWorkLogMessage({ event: 'run.failed' })).toBe('Verifier：验证运行失败');
    expect(verifierWorkLogMessage({ event: 'tool.started' })).toBeUndefined();
  });
});
