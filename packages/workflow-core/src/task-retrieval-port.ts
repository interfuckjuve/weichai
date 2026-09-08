import type { ContextPacket, TaskRetrievalRequest } from '@forexplore/contracts';

export interface TaskRetrievalPort {
  search(request: TaskRetrievalRequest, signal?: AbortSignal): Promise<ContextPacket>;
}
