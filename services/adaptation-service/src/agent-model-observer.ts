export interface AgentModelCallMetadata {
  strategy: 'semantic' | 'hierarchy';
  model: string;
  inputChars: number;
}

/** Log scalar completion metrics only; upstream messages and error bodies never enter service logs. */
export async function observeAgentModelCall<T>(
  metadata: AgentModelCallMetadata,
  operation: () => Promise<T>,
  outputChars: (value: T) => number,
  signal?: AbortSignal,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let status: 'success' | 'failure' | 'cancelled' = 'failure';
  let characters = 0;
  try {
    const value = await operation();
    signal?.throwIfAborted();
    characters = outputChars(value);
    status = 'success';
    return value;
  } catch {
    status = signal?.aborted ? 'cancelled' : 'failure';
    throw new Error(status === 'cancelled' ? 'Agent model request was cancelled.' : 'Agent model request failed.');
  } finally {
    console.info('[agent-model]', JSON.stringify({ strategy: metadata.strategy, model: metadata.model,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
      status, inputChars: metadata.inputChars, outputChars: characters }));
  }
}
