import { readFile, writeFile } from 'node:fs/promises';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

const registry = createDefaultLanguageRegistry();
process.on('message', async (request: { id: number; sourcePath: string; resultPath: string; relativePath: string }) => {
  try {
    const language = registry.resolvePath(request.relativePath);
    if (!language) throw new Error('Parser worker does not support this file extension.');
    const content = await readFile(request.sourcePath, 'utf8');
    const result = indexTreeSitterFile({ content, relativePath: request.relativePath, language });
    await writeFile(request.resultPath, JSON.stringify({ result }), 'utf8');
    process.send?.({ id: request.id, ok: true, rss: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024) });
  } catch (error) {
    try {
      await writeFile(request.resultPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf8');
      process.send?.({ id: request.id, ok: true, rss: Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024) });
    } catch (writeError) {
      process.send?.({ id: request.id, ok: false, error: String(writeError) });
    }
  }
});

process.on('disconnect', () => process.exit(0));
