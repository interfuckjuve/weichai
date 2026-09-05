import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requireRuntime = createRequire(path.resolve(process.env.FOREXPLORE_EMBEDDING_TOOLS ?? process.cwd(), 'package.json'));
const runtime = await import(pathToFileURL(requireRuntime.resolve('@huggingface/transformers')).href);
const { AutoTokenizer, AutoModelForSequenceClassification, env } = runtime.default ?? runtime;
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? '/tmp/forexplore-model-cache';
if (process.env.FOREXPLORE_MODEL_HOST) env.remoteHost = process.env.FOREXPLORE_MODEL_HOST;
const name = 'Xenova/bge-reranker-base';
const revision = '280bcc27a84e0b898c251e06fddb25171bd9b101';
const modelId = `${name}@${revision}`;
console.log(JSON.stringify({ stage: 'loading-reranker', model: modelId }));
const tokenizer = await AutoTokenizer.from_pretrained(name, { revision });
const model = await AutoModelForSequenceClassification.from_pretrained(name, { revision, dtype: 'q8' });
async function score(query, document) {
  const inputs = tokenizer([query], { text_pair: [document], padding: true, truncation: true, max_length: 512 });
  const output = await model(inputs);
  return 1 / (1 + Math.exp(-Number(output.logits.data[0])));
}
await score('warmup', 'warmup');
let queue = Promise.resolve();
let pending = 0;
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health' && request.method === 'GET') { response.end(JSON.stringify({ ready: true, model: modelId, pending })); return; }
  if (request.url !== '/v1/rerank' || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
  if (pending >= 4) { response.writeHead(429); response.end('{"error":"Reranker queue is full"}'); return; }
  pending++;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 256_000) throw new Error('Request exceeds byte budget');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== modelId || typeof body.query !== 'string' || body.query.length > 32_000 ||
      !Array.isArray(body.documents) || body.documents.length < 1 || body.documents.length > 20 ||
      body.documents.some((document) => typeof document !== 'string' || document.length > 8_000)) throw new Error('Invalid reranking request');
    const task = queue.then(async () => {
      const results = [];
      for (let index = 0; index < body.documents.length; index++) {
        if (response.destroyed) throw new Error('Client disconnected');
        results.push({ index, relevance_score: await score(body.query, body.documents[index]) });
      }
      return results.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
    });
    queue = task.then(() => undefined, () => undefined);
    response.end(JSON.stringify({ model: modelId, results: await task }));
  } catch (error) {
    response.writeHead(400); response.end(JSON.stringify({ error: error.message }));
  } finally { pending--; }
});
server.requestTimeout = 30_000;
const port = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, model: modelId })));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
