import { fork, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParseFileTask { sourcePath: string; resultPath: string; relativePath: string; sizeBytes: number }

/** Recycle native parser processes; Tree-sitter's Node binding has no explicit tree disposal API. */
export async function parseSourceFiles(tasks: readonly ParseFileTask[], signal?: AbortSignal): Promise<{ peakWorkerRss: number; peakCombinedRss: number; workers: number }> {
  const packagedPath = typeof __dirname === 'string' ? path.join(__dirname, 'structural-parse-worker.cjs') : undefined;
  const workerPath = packagedPath && existsSync(packagedPath)
    ? packagedPath
    : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './structural-parse-worker.ts' : './structural-parse-worker.js', import.meta.url));
  if (!existsSync(workerPath)) throw new Error('The structural parser worker entry is unavailable.');
  let worker: ChildProcess | undefined;
  let count = 0, bytes = 0, workers = 0, peakWorkerRss = 0, peakCombinedRss = 0;
  let stderr = '';
  const stop = async () => {
    const current = worker;
    worker = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) return;
    await new Promise<void>((resolve) => { current.once('exit', () => resolve()); current.kill('SIGTERM'); });
  };
  try {
    for (let id = 0; id < tasks.length; id++) {
      signal?.throwIfAborted();
      const task = tasks[id]!;
      if (worker && (count >= 64 || bytes + task.sizeBytes > 8 * 1024 * 1024)) { await stop(); count = 0; bytes = 0; }
      if (!worker) {
        worker = fork(workerPath, [], { execArgv: [...(workerPath.endsWith('.ts') ? ['--import', 'tsx'] : []), '--max-old-space-size=512'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        stderr = '';
        worker.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
        workers++;
      }
      const current = worker;
      try {
        const rss = await new Promise<number>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); current.off('message', message); current.off('exit', exit); current.off('error', error); };
          const error = (value: Error) => { cleanup(); reject(value); };
          const exit = (code: number | null, reason: string | null) => error(new Error(`Parser process exited (${code ?? reason}). ${stderr}`));
          const abort = () => error(signal!.reason instanceof Error ? signal!.reason : new Error('Parsing cancelled.'));
          const message = (value: { id?: number; ok?: boolean; rss?: number; error?: string }) => {
            if (value.id !== id) return;
            cleanup();
            if (value.ok) resolve(value.rss ?? 0); else reject(new Error(value.error ?? 'Parser result write failed.'));
          };
          const timer = setTimeout(() => error(new Error('Parser file deadline exceeded.')), 30_000);
          current.on('message', message); current.once('exit', exit); current.once('error', error);
          signal?.addEventListener('abort', abort, { once: true });
          current.send({ id, ...task }, sendError => { if (sendError) error(sendError); });
        });
        peakWorkerRss = Math.max(peakWorkerRss, rss);
        peakCombinedRss = Math.max(peakCombinedRss, rss + process.memoryUsage().rss);
      } catch (error) {
        await stop(); count = 0; bytes = 0;
        signal?.throwIfAborted();
        if (peakWorkerRss === 0) throw error;
        await writeFile(task.resultPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf8');
      }
      count++; bytes += task.sizeBytes;
      if ((id + 1) % 256 === 0) console.info('[forexplore:performance]', JSON.stringify({ stage: 'parser-pool', completed: id + 1, total: tasks.length, workers, peakWorkerRss }));
    }
    return { peakWorkerRss, peakCombinedRss, workers };
  } finally { await stop(); }
}
