import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional local inference runtime; keep native ML dependencies out of the extension bundle.
const requireRuntime = createRequire(path.resolve(process.env.FOREXPLORE_EMBEDDING_TOOLS ?? process.cwd(), 'package.json'));
const runtime = await import(pathToFileURL(requireRuntime.resolve('@huggingface/transformers')).href);
const { pipeline, env } = runtime.default ?? runtime;
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? '/tmp/forexplore-model-cache';
if (process.env.FOREXPLORE_MODEL_HOST) env.remoteHost = process.env.FOREXPLORE_MODEL_HOST;
const model = process.env.FOREXPLORE_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small';
const revision = process.env.FOREXPLORE_EMBEDDING_REVISION ?? '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const modelId = `${model}@${revision}`;
const port = Number(process.env.FOREXPLORE_EMBEDDING_PORT ?? 4021);
console.log(JSON.stringify({ stage: 'loading-model', model, revision }));
const extractor = await pipeline('feature-extraction', model, { dtype: 'q8', revision });
await extractor(['query: warmup'], { pooling: 'mean', normalize: true });
let pending = 0;
let queue = Promise.resolve();
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health' && request.method === 'GET') {
    response.end(JSON.stringify({ ready: true, model: modelId, revision, pending })); return;
  }
  if (request.url !== '/v1/embeddings' || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
  if (pending >= 8) { response.writeHead(429); response.end('{"error":{"message":"Inference queue is full"}}'); return; }
  pending++;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('Request exceeds byte limit');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.model !== modelId) throw new Error('Requested model/revision is not loaded');
    if (!Array.isArray(body.input) || body.input.length < 1 || body.input.length > 16 ||
      body.input.some((text) => typeof text !== 'string' || text.length > 32_000)) throw new Error('Invalid embedding input');
    const task = queue.then(async () => {
      if (response.destroyed) throw new Error('Client disconnected');
      const tensor = await extractor(body.input, { pooling: 'mean', normalize: true });
      return tensor.tolist();
    });
    queue = task.then(() => undefined, () => undefined);
    const vectors = await task;
    if (body.dimensions !== undefined && body.dimensions !== vectors[0].length) throw new Error('Unsupported embedding dimension');
    response.end(JSON.stringify({ model: modelId, data: vectors.map((embedding, index) => ({ index, embedding })) }));
  } catch (error) {
    response.writeHead(400); response.end(JSON.stringify({ error: { message: error.message } }));
  } finally { pending--; }
});
server.requestTimeout = 30_000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, model: modelId, revision })));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
