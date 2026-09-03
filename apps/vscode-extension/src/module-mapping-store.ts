import type * as vscode from 'vscode';
import type {
  ModuleMappingHostState,
  ModuleMappingHostStore,
} from './module-mapping-host';

const storageKey = 'forexplore.moduleMapping.host.v1';

/** Workspace-scoped persistence for cross-catalog mapping decisions. */
export class VSCodeModuleMappingHostStore implements ModuleMappingHostStore {
  constructor(private readonly state: vscode.Memento) {}

  async load(): Promise<ModuleMappingHostState | null> {
    const value = this.state.get<ModuleMappingHostState>(storageKey);
    return value ? clone(value) : null;
  }

  async save(next: ModuleMappingHostState, expectedRevision: number | null): Promise<void> {
    const current = this.state.get<ModuleMappingHostState>(storageKey);
    const currentRevision = current?.revision ?? 0;
    if (expectedRevision !== null && currentRevision !== expectedRevision) {
      throw new Error('Module mapping persistence changed concurrently.');
    }
    await this.state.update(storageKey, clone(next));
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
