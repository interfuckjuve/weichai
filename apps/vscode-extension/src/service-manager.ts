import * as vscode from 'vscode';
import {
  AdaptationHttpAdapter,
  AdaptationHttpAdapterV2,
  type CodeAdaptationPortV2,
} from '@forexplore/adaptation-http-adapter';
import {
  SeekDbCodeSearchAdapterV2,
  withSeekDbSearch,
} from '@forexplore/seekdb-adapter';
import type { MigrationRuntimeCapabilitySnapshot } from '@forexplore/contracts';
import type {
  SearchPortV2,
  SourceBundleResolverPortV2,
  WorkflowPorts,
} from '@forexplore/workflow-core';
import { checkServiceHealth } from './service-health';
import { localFetch } from './local-fetch';
import {
  emptyRuntimeCapabilitySnapshot,
  intersectRuntimeCapabilities,
  requestRetrievalRuntimeCapabilities,
  requestRuntimeCapabilities,
  type RuntimeCapabilityClientResult,
} from './runtime-capability-client';
import { loadSettings } from './settings';
import type { ExecutionMode, ServiceStatus } from './ui-types';

export type ServiceKind = 'retrieval' | 'adaptation';

export interface RuntimePorts {
  ports: WorkflowPorts;
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
  executionMode: ExecutionMode;
}

export interface RuntimePortsV2 {
  search: SearchPortV2;
  sourceBundleResolver: SourceBundleResolverPortV2;
  adaptation: CodeAdaptationPortV2;
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
  executionMode: ExecutionMode;
}

/**
 * Owns the real two-service runtime. A configured-but-unhealthy service is an
 * error; the extension never falls back to mock adapters.
 */
export class ServiceManager implements vscode.Disposable {
  private status: ServiceStatus = {
    retrieval: 'unconfigured',
    adaptation: 'unconfigured',
    executionMode: 'real',
  };
  private runtimeCapabilities: RuntimeCapabilityClientResult = {
    snapshot: emptyRuntimeCapabilitySnapshot(),
    source: 'fail-closed-empty',
    error: 'Adaptation runtime capabilities have not been refreshed.',
  };

  constructor(private readonly output: vscode.OutputChannel) {}

  get serviceStatus(): ServiceStatus {
    return { ...this.status };
  }

  get runtimeCapabilityState(): RuntimeCapabilityClientResult {
    return JSON.parse(JSON.stringify(this.runtimeCapabilities)) as RuntimeCapabilityClientResult;
  }

  /** Display-only provider labels that do not create or replace any port. */
  getRuntimePresentation(): Omit<RuntimePorts, 'ports'> {
    return {
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  async refresh(): Promise<ServiceStatus> {
    const settings = loadSettings();
    const [retrieval, adaptation] = await Promise.all([
      checkServiceHealth(settings.retrievalApiUrl, localFetch),
      checkServiceHealth(settings.adaptationApiUrl, localFetch),
    ]);
    const [adaptationCapabilities, retrievalCapabilities] = await Promise.all([
      adaptation.healthy
        ? requestRuntimeCapabilities(settings.adaptationApiUrl, localFetch)
        : Promise.resolve({
            snapshot: emptyRuntimeCapabilitySnapshot(),
            source: 'fail-closed-empty' as const,
            error: adaptation.detail,
          }),
      retrieval.healthy
        ? requestRetrievalRuntimeCapabilities(settings.retrievalApiUrl, localFetch)
        : Promise.resolve({
            snapshot: emptyRuntimeCapabilitySnapshot(),
            source: 'fail-closed-empty' as const,
            error: retrieval.detail,
          }),
    ]);
    const capabilityReady =
      adaptationCapabilities.source === 'service' && retrievalCapabilities.source === 'service';
    this.runtimeCapabilities = {
      snapshot: intersectRuntimeCapabilities(
        adaptationCapabilities.snapshot,
        retrievalCapabilities.snapshot,
      ),
      source: capabilityReady ? 'service' : 'fail-closed-empty',
      error: [adaptationCapabilities.error, retrievalCapabilities.error].filter(Boolean).join('；') || undefined,
    };
    const adaptationReady = adaptation.healthy && capabilityReady;
    this.status = {
      retrieval: retrieval.healthy ? 'connected' : 'error',
      adaptation: adaptationReady ? 'connected' : 'error',
      executionMode: 'real',
      message: [
        !retrieval.healthy && `检索：${retrieval.detail}`,
        !adaptation.healthy && `迁移适配：${adaptation.detail}`,
        adaptation.healthy && this.runtimeCapabilities.error &&
          `迁移能力：${this.runtimeCapabilities.error}`,
      ]
        .filter(Boolean)
        .join('；') || undefined,
    };
    this.output.appendLine(
      `[forexplore] runtime refreshed: retrieval=${this.status.retrieval}, adaptation=${this.status.adaptation}`,
    );
    return this.serviceStatus;
  }

  async ensureStarted(): Promise<ServiceStatus> {
    return this.refresh();
  }

  getRuntimePorts(): RuntimePorts {
    const settings = loadSettings();
    if (this.status.retrieval !== 'connected' || this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实服务尚未就绪。');
    }

    let ports = withSeekDbSearch(realWorkflowPorts(), {
      baseUrl: settings.retrievalApiUrl,
      fetch: localFetch,
    });
    ports = {
      ...ports,
      adaptation: new AdaptationHttpAdapter({
        baseUrl: settings.adaptationApiUrl,
        fetch: localFetch,
      }),
    };
    return {
      ports,
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  /** Production workflow boundary. It exposes only V2 clients and binds the
   * retrieval client to the exact Host-composed runtime snapshot. */
  getRuntimePortsV2(runtimeCapabilities: MigrationRuntimeCapabilitySnapshot): RuntimePortsV2 {
    const settings = loadSettings();
    if (this.status.retrieval !== 'connected' || this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实服务尚未就绪。');
    }
    const search = new SeekDbCodeSearchAdapterV2({
      baseUrl: settings.retrievalApiUrl,
      fetch: localFetch,
      runtimeCapabilities,
    });
    return {
      search,
      sourceBundleResolver: search,
      adaptation: new AdaptationHttpAdapterV2({
        baseUrl: settings.adaptationApiUrl,
        fetch: localFetch,
      }),
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  dispose(): void {
    // The extension owns no child processes.
  }
}

/**
 * `WorkflowPorts` needs all three ports, but this extension owns write-back
 * locally. Real mode must never inherit the Mock backfill adapter merely as a
 * convenient placeholder.
 */
function realWorkflowPorts(): WorkflowPorts {
  return {
    search: {
      async search() {
        throw new Error('真实检索端口尚未初始化。');
      },
    },
    adaptation: {
      async adapt() {
        throw new Error('真实适配端口尚未初始化。');
      },
    },
    backfill: {
      async apply() {
        throw new Error('真实模式的写回由受信任的 VS Code 宿主执行，不能通过服务端端口调用。');
      },
    },
  };
}
