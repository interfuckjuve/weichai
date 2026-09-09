import { expect, it } from 'vitest';
import type { ContextPacket } from '@forexplore/contracts';
import { evaluateRetrieval, summarizeRetrievalEvaluation, type RetrievalEvaluationTask } from './retrieval-evaluation';

const scope = { repositoryId: 'repo', analysisRevision: 'revision' };
const task: RetrievalEvaluationTask = { id: 'upload', request: { requestId: 'query', requirement: 'upload size limit', scopes: [scope], budget: { maxTokens: 2000 } },
  relevant: [{ repositoryId: 'repo', relativePath: 'upload.ts', relevance: 3 }, { repositoryId: 'repo', relativePath: 'error.ts', relevance: 2 }],
  requiredEvidence: [{ repositoryId: 'repo', relativePath: 'upload.ts', relevance: 3, startLine: 10, endLine: 12 }, { repositoryId: 'repo', relativePath: 'error.ts', relevance: 2 }] };
const packet: ContextPacket = { packetId: 'packet', requestId: 'query', requirement: 'upload size limit', status: 'partial',
  snapshots: [{ ...scope, repositoryName: 'repo', analysisHash: 'hash' }],
  routing: { requestedGranularity: 'auto', resolvedGranularities: ['function'], source: 'automatic', reason: 'test' },
  results: ['other.ts', 'upload.ts', 'upload.ts'].map((relativePath, index) => ({ ...scope, id: `${index}`, name: relativePath, relativePath, granularity: 'function', score: 1, reason: '' })),
  evidence: [{ ...scope, evidenceId: 'source', name: 'upload', role: 'implementation', relativePath: 'upload.ts', content: 'line1\nline2\nline3',
    sourceRange: { startLine: 10, startColumn: 1, endLine: 12, endColumn: 5 }, contentHash: 'hash', fileHash: 'hash', reason: '', provider: 'tree-sitter', evidenceLevel: 'structural', truncated: false }],
  relations: [], gaps: [], markdown: '', usage: { tokenizer: 'cl100k_base', tokens: 500, maxTokens: 2000, characters: 1000, files: 1, sourceLines: 3, latencyMs: 80 } };

it('measures labeled ranking and required evidence without counting duplicate hits as successes', () => {
  const result = evaluateRetrieval(task, packet, 3);
  expect(result).toMatchObject({ recallAtK: .5, reciprocalRank: .5, evidenceCoverage: .5, taskSuccess: false });
  expect(result.ndcgAtK).toBeCloseTo((7 / Math.log2(3)) / (7 + 3 / Math.log2(3)));
  expect(result.duplicateSourceLineRatio).toBe(0);
  expect(evaluateRetrieval(task, { ...packet, evidence: [...packet.evidence, { ...packet.evidence[0]!, evidenceId: 'copy' }] }).duplicateSourceLineRatio).toBe(.5);
});

it('rejects mislabeled snapshots and duplicate labels rather than producing misleading metrics', () => {
  expect(() => evaluateRetrieval(task, { ...packet, requestId: 'other' })).toThrow('snapshot');
  expect(() => evaluateRetrieval({ ...task, relevant: [...task.relevant, task.relevant[0]!] }, packet)).toThrow('duplicate');
});

it('includes failed requests in success and latency denominators', () => {
  const success = { ...evaluateRetrieval(task, packet), taskSuccess: true };
  const failure = { ...success, taskId: 'timeout', status: 'error' as const, error: 'timeout', latencyMs: 10000, taskSuccess: false,
    recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0, evidenceCoverage: 0 };
  expect(summarizeRetrievalEvaluation([success, failure])).toMatchObject({ tasks: 2, failures: 1, taskSuccessRate: .5, meanLatencyMs: 5040, p95LatencyMs: 10000, behaviorVerifiedTasks: 0 });
});
