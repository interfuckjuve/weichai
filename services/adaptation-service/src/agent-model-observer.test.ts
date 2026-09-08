import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeAgentModelCall } from './agent-model-observer.js';

afterEach(() => vi.restoreAllMocks());

describe('agent model completion metrics', () => {
  it('records one successful completion with scalar metrics and no model content', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const content = 'private source response';
    expect(await observeAgentModelCall({ strategy: 'hierarchy', model: 'configured-model', inputChars: 200 },
      async () => content, (value) => value.length)).toBe(content);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe('[agent-model]');
    const event = JSON.parse(log.mock.calls[0]![1] as string);
    expect(event).toMatchObject({ strategy: 'hierarchy', model: 'configured-model', inputChars: 200,
      outputChars: content.length, status: 'success', elapsedMs: expect.any(Number) });
    expect(Date.parse(event.completedAt)).toBeGreaterThanOrEqual(Date.parse(event.startedAt));
    expect(JSON.stringify(log.mock.calls)).not.toContain(content);
  });

  it.each([false, true])('records failure or cancellation without exposing upstream errors: cancelled=%s', async (cancelled) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const controller = new AbortController();
    await expect(observeAgentModelCall({ strategy: 'semantic', model: 'configured-model', inputChars: 300 }, async () => {
      if (cancelled) controller.abort();
      throw new Error('private upstream body and credentials');
    }, () => 0, controller.signal)).rejects.toThrow(cancelled ? 'Agent model request was cancelled.' : 'Agent model request failed.');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({ status: cancelled ? 'cancelled' : 'failure', outputChars: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });
});
