import { describe, expect, it } from 'vitest';
import type { TaskContextEvidence, TaskRetrievalRequest } from '@forexplore/contracts';
import { compileTaskContext, contextTokenCount, sourceContentHash } from './context-compiler.js';

const request: TaskRetrievalRequest = { requestId: 'coverage', requirement: 'upload size validation error handling', scopes: [{ repositoryId: 'r', analysisRevision: 'v' }], budget: { maxTokens: 3000, maxFiles: 2 } };
const evidence = (name: string, content: string, role: TaskContextEvidence['role'] = 'implementation'): TaskContextEvidence => ({
  repositoryId: 'r', analysisRevision: 'v', evidenceId: name, name, relativePath: `${name}.ts`, content, contentHash: sourceContentHash(content),
  fileHash: 'file', sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, role, reason: 'Task evidence', provider: 'tree-sitter', evidenceLevel: 'syntactic', truncated: false,
});
function compile(items: TaskContextEvidence[], overrides: Partial<TaskRetrievalRequest> = {}) {
  return compileTaskContext({ ...request, ...overrides }, { status: 'complete', snapshots: [], results: [], relations: [], gaps: [], evidence: items,
    routing: { requestedGranularity: 'auto', resolvedGranularities: ['function'], source: 'automatic', reason: 'test' } }, 0);
}
describe('coverage-driven context selection', () => {
  it('retains the entry point and chooses complementary error handling over repeated validation', () => {
    const result = compile([evidence('upload', 'function upload() { return sizeValidation(); }'),
      evidence('validation', 'function sizeValidation() { return size > 0; }'),
      evidence('failure', 'function errorHandling(error) { throw error; }', 'dependency')]);
    expect(result.evidence.map(item => item.name)).toEqual(['upload', 'failure']);
    expect(result.status).toBe('partial');
    expect(result.usage.tokens).toBe(contextTokenCount(result.markdown));
    expect(result.usage.tokens).toBeLessThanOrEqual(request.budget.maxTokens);
  });
  it('does not erase identical source at distinct locations or across versions', () => {
    const first = evidence('first', 'return value;');
    const second = { ...first, evidenceId: 'second', sourceRange: { startLine: 5, startColumn: 1, endLine: 6, endColumn: 1 } };
    const third = { ...first, evidenceId: 'third', analysisRevision: 'v2' };
    expect(compile([first, second, third]).evidence).toHaveLength(3);
    expect(compile([first, second], { knownEvidence: [{ evidenceId: 'first', contentHash: first.contentHash }] }).evidence).toEqual([second]);
  });
  it('enforces exact Markdown token and line budgets with adversarial fences', () => {
    const items = [evidence('main', '`'.repeat(40) + '\n' + '复杂文本 error handling '.repeat(100)), evidence('small', 'size validation')];
    const result = compile(items, { budget: { maxTokens: 500, maxSourceLines: 1 } });
    expect(result.evidence.map(item => item.name)).toEqual(['small']);
    expect(result.usage.tokens).toBeLessThanOrEqual(500);
    expect(result.usage.sourceLines).toBe(1);
  });
});
