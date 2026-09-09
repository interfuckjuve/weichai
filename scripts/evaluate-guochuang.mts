import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ContextPacket } from '@forexplore/contracts';
import { validateTaskRetrievalRequest } from '../services/code-intelligence-service/src/task-retrieval.js';
import { evaluateRetrieval, summarizeRetrievalEvaluation, type RetrievalEvaluationTask, type RetrievalEvaluationResult } from '../services/code-intelligence-service/src/retrieval-evaluation.js';

const { values } = parseArgs({ options: { tasks: { type: 'string' }, url: { type: 'string' }, output: { type: 'string' }, k: { type: 'string', default: '10' } } });
if (!values.tasks || !values.url || !values.output) throw new Error('Usage: npm run evaluate:guochuang -- --tasks tasks.json --url http://127.0.0.1:4041 --output report.json');
const tasks = JSON.parse(await readFile(values.tasks, 'utf8')) as RetrievalEvaluationTask[];
if (!Array.isArray(tasks) || !tasks.length || tasks.length > 10000 || new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Provide 1..10000 uniquely identified evaluation tasks.');
const k = Number(values.k);
if (!Number.isSafeInteger(k) || k < 1 || k > 100) throw new Error('K must be within 1..100.');
for (const task of tasks) validateTaskRetrievalRequest(task.request);
const endpoint = new URL(values.url); endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/task-search`; endpoint.search = ''; endpoint.hash = '';
const results: RetrievalEvaluationResult[] = [];
for (const task of tasks) {
  const started = performance.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(process.env.SEMANTIC_QUERY_PORT_TOKEN ? { authorization: `Bearer ${process.env.SEMANTIC_QUERY_PORT_TOKEN}` } : {}) },
      body: JSON.stringify(task.request), signal: AbortSignal.timeout((task.request.budget.maxLatencyMs ?? 10000) + 5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const packet = await response.json() as ContextPacket;
    results.push({ ...evaluateRetrieval(task, packet, k), latencyMs: performance.now() - started });
  } catch (error) {
    results.push({ taskId: task.id, status: 'error', error: error instanceof Error ? error.message : String(error), latencyMs: performance.now() - started,
      recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0, evidenceCoverage: 0, taskSuccess: false, tokens: 0, duplicateSourceLineRatio: 0, sourceReadAmplification: null });
  }
}
const report = { version: 1, createdAt: new Date().toISOString(), k, source: values.tasks, summary: summarizeRetrievalEvaluation(results), results };
await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
if (report.summary.failures) process.exitCode = 1;
