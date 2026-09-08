import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const environments: Array<{ name: string; environment: Record<string, string> }> = [
  { name: 'default environment', environment: {} },
  { name: 'explicit dotenv debug logging', environment: { DOTENV_CONFIG_DEBUG: 'true', DOTENV_CONFIG_QUIET: 'false' } },
];

describe('semantic-index MCP executable startup', () => {
  it.each(environments)('keeps stdout protocol-only with $name', async ({ environment }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'services/semantic-index-mcp-server/src/server.ts'],
      cwd: root,
      env: { ...getDefaultEnvironment(), SEMANTIC_QUERY_PORT_URL: 'http://127.0.0.1:1', ...environment },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'startup-protocol-check', version: '0.1.0' });
    const errors: Error[] = [];
    let stderr = '';
    client.onerror = (error) => { errors.push(error); };
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let pid: number | null = null;
    try {
      await client.connect(transport, { timeout: 15000 });
      pid = transport.pid;
      expect((await client.listTools()).tools.some((tool) => tool.name === 'search_task_context')).toBe(true);
      expect(errors).toEqual([]);
      expect(stderr).toContain('ForeXplore semantic-index MCP server is running on stdio.');
    } finally {
      await client.close();
      await transport.close();
      if (pid !== null) expect(() => process.kill(pid!, 0)).toThrow();
    }
  }, 30000);
});
