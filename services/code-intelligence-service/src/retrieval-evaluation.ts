import type { ContextPacket, TaskRetrievalRequest, WorkspaceTranslationRun } from '@forexplore/contracts';

export interface EvidenceLabel { repositoryId: string; relativePath: string; symbolKey?: string; startLine?: number; endLine?: number; relevance: 1 | 2 | 3 }
export interface RetrievalEvaluationTask {
  id: string;
  request: TaskRetrievalRequest;
  relevant: EvidenceLabel[];
  requiredEvidence: EvidenceLabel[];
}
export interface RetrievalEvaluationResult {
  taskId: string; status: 'ok' | 'error'; error?: string; latencyMs: number;
  recallAtK: number; reciprocalRank: number; ndcgAtK: number; evidenceCoverage: number;
  taskSuccess: boolean; tokens: number; duplicateSourceLineRatio: number;
  sourceReadAmplification: number | null;
  acceptance?: WorkspaceTranslationRun['acceptance'];
}

function matches(label: EvidenceLabel, result: { repositoryId: string; relativePath?: string; symbolKey?: string }): boolean {
  return label.repositoryId === result.repositoryId && label.relativePath === result.relativePath && (!label.symbolKey || label.symbolKey === result.symbolKey);
}

/** Labels are supplied by the evaluator; scores and task success never come from model prose. */
export function evaluateRetrieval(task: RetrievalEvaluationTask, packet: ContextPacket, k = 10): RetrievalEvaluationResult {
  if (!Number.isSafeInteger(k) || k < 1 || k > 100) throw new Error('Evaluation K must be within 1..100.');
  if (!task.relevant.length || !task.requiredEvidence.length) throw new Error('Evaluation requires explicit relevance and required-evidence labels.');
  const validate = (labels: EvidenceLabel[]) => {
    const identities = new Set<string>();
    for (const label of labels) {
      const identity = JSON.stringify([label.repositoryId, label.relativePath, label.symbolKey, label.startLine, label.endLine]);
      if (!label.repositoryId || !label.relativePath || ![1, 2, 3].includes(label.relevance) || identities.has(identity) ||
          (label.startLine !== undefined || label.endLine !== undefined) && (!Number.isInteger(label.startLine) || !Number.isInteger(label.endLine) || label.startLine! < 1 || label.endLine! < label.startLine!)) throw new Error('Invalid or duplicate evaluation label.');
      identities.add(identity);
    }
  };
  validate(task.relevant); validate(task.requiredEvidence);
  if (packet.requestId !== task.request.requestId || packet.requirement !== task.request.requirement || packet.snapshots.some(snapshot => !task.request.scopes.some(scope =>
    scope.repositoryId === snapshot.repositoryId && scope.analysisRevision === snapshot.analysisRevision && scope.projectId === snapshot.projectId))) throw new Error('Evaluation packet does not match the task snapshot.');
  const results = packet.results.slice(0, k);
  const matched = new Set<number>();
  let reciprocalRank = 0, dcg = 0;
  results.forEach((result, rank) => {
    const eligible = task.relevant.map((label, index) => ({ label, index })).filter(({ label, index }) => !matched.has(index) && matches(label, result))
      .sort((a, b) => b.label.relevance - a.label.relevance);
    if (!eligible.length) return;
    const { label, index } = eligible[0]!; matched.add(index);
    if (!reciprocalRank) reciprocalRank = 1 / (rank + 1);
    dcg += (2 ** label.relevance - 1) / Math.log2(rank + 2);
  });
  const ideal = [...task.relevant].sort((a, b) => b.relevance - a.relevance).slice(0, k)
    .reduce((sum, label, index) => sum + (2 ** label.relevance - 1) / Math.log2(index + 2), 0);
  const covered = task.requiredEvidence.filter(label => packet.evidence.some(item => matches(label, item) &&
    (label.startLine === undefined ? !item.truncated : item.sourceRange.startLine <= label.startLine && item.sourceRange.endLine >= label.endLine!))).length;
  const lines = new Set<string>(); let totalLines = 0;
  for (const item of packet.evidence) for (let offset = 0; offset < item.content.split('\n').length; offset++) {
    lines.add(JSON.stringify([item.repositoryId, item.analysisRevision, item.relativePath, item.fileHash, item.sourceRange.startLine + offset])); totalLines++;
  }
  return { taskId: task.id, status: 'ok', latencyMs: packet.usage.latencyMs, recallAtK: matched.size / task.relevant.length,
    reciprocalRank, ndcgAtK: ideal ? dcg / ideal : 0, evidenceCoverage: covered / task.requiredEvidence.length,
    taskSuccess: packet.status !== 'unavailable' && matched.size > 0 && covered === task.requiredEvidence.length,
    tokens: packet.usage.tokens, duplicateSourceLineRatio: totalLines ? 1 - lines.size / totalLines : 0,
    sourceReadAmplification: packet.usage.retrieval?.sourceReadAmplification ?? null };
}

export function summarizeRetrievalEvaluation(results: RetrievalEvaluationResult[]) {
  if (!results.length) throw new Error('Evaluation requires at least one task.');
  if (new Set(results.map(result => result.taskId)).size !== results.length) throw new Error('Evaluation task IDs must be unique.');
  const average = (read: (result: RetrievalEvaluationResult) => number) => results.reduce((sum, item) => sum + read(item), 0) / results.length;
  const latencies = results.map(item => item.latencyMs).sort((a, b) => a - b);
  return { tasks: results.length, failures: results.filter(item => item.status === 'error').length,
    taskSuccessRate: average(item => Number(item.taskSuccess)), recallAtK: average(item => item.recallAtK), mrr: average(item => item.reciprocalRank),
    ndcgAtK: average(item => item.ndcgAtK), evidenceCoverage: average(item => item.evidenceCoverage), meanLatencyMs: average(item => item.latencyMs),
    p95LatencyMs: latencies[Math.ceil(latencies.length * .95) - 1]!,
    behaviorVerifiedTasks: results.filter(item => item.acceptance === 'behavior-verified').length };
}
