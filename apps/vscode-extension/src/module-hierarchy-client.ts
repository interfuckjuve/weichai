import type { ModuleHierarchyDecision, ModuleHierarchyDecisionRequest, ModuleHierarchyPlanner } from '@forexplore/contracts';
import { parseModuleHierarchyDecision, parseModuleHierarchyDecisionRequest } from '@forexplore/code-intelligence-service/module-hierarchy-planner';
import { localFetch } from './local-fetch';

export function moduleHierarchyEndpoint(adaptationApiUrl: string): string {
  const base = new URL(adaptationApiUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Module hierarchy service requires an HTTP(S) URL without credentials.');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/module-hierarchy/decision`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

export class HttpModuleHierarchyPlanner implements ModuleHierarchyPlanner {
  private readonly endpoint: string;
  constructor(adaptationApiUrl: string, private readonly fetcher: typeof localFetch = localFetch) {
    this.endpoint = moduleHierarchyEndpoint(adaptationApiUrl);
  }

  async decide(request: ModuleHierarchyDecisionRequest, parentSignal?: AbortSignal): Promise<ModuleHierarchyDecision> {
    parentSignal?.throwIfAborted();
    const bounded = parseModuleHierarchyDecisionRequest(request);
    const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(45_000)]);
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bounded), signal,
    });
    if (!response.ok) throw new Error(`Module hierarchy service request failed with HTTP ${response.status}.`);
    const content = await response.text();
    signal.throwIfAborted();
    if (content.length > 65_536) throw new Error('Module hierarchy service response exceeds its limit.');
    return parseModuleHierarchyDecision(content, bounded);
  }
}
