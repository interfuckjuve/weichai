import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSourceFiles } from './structural-parse-pool.js';

describe('bounded native parser scheduling', () => {
  it('applies byte backpressure across workers and preserves the same parsed results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'huawei-parse-pool-'));
    try {
      const source = 'export function sample() { return 123; }';
      const tasks = Array.from({ length: 4 }, (_, i) => ({ sourcePath: join(root, `source-${i}.txt`), resultPath: join(root, `result-${i}.json`), relativePath: `${i}.ts`, sizeBytes: Buffer.byteLength(source) }));
      await Promise.all(tasks.map(task => writeFile(task.sourcePath, source)));
      const serial = await parseSourceFiles(tasks, undefined, { maxWorkers: 2, maxInFlightBytes: tasks[0]!.sizeBytes });
      expect(serial.peakInFlightTasks).toBe(1);
      expect(serial.peakInFlightBytes).toBe(tasks[0]!.sizeBytes);
      const first = await Promise.all(tasks.map(async task => JSON.parse(await readFile(task.resultPath, 'utf8'))));
      const concurrent = await parseSourceFiles(tasks, undefined, { maxWorkers: 2, maxInFlightBytes: tasks[0]!.sizeBytes * 2 });
      expect(concurrent.peakInFlightTasks).toBe(2);
      expect(concurrent.peakInFlightBytes).toBeLessThanOrEqual(tasks[0]!.sizeBytes * 2);
      const second = await Promise.all(tasks.map(async task => JSON.parse(await readFile(task.resultPath, 'utf8'))));
      expect(second).toEqual(first);
      const oversized = await parseSourceFiles(tasks.slice(0, 2), undefined, { maxWorkers: 2, maxInFlightBytes: 1 });
      expect(oversized.peakInFlightTasks).toBe(1);
      expect(oversized.peakInFlightBytes).toBe(tasks[0]!.sizeBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects cancellation and invalid budgets before starting workers', async () => {
    await expect(parseSourceFiles([], undefined, { maxWorkers: 0 })).rejects.toThrow('budget');
    await expect(parseSourceFiles([{ sourcePath: 'unused', resultPath: 'unused', relativePath: 'x.ts', sizeBytes: 1 }], AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  });
});
