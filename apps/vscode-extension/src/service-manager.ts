import * as vscode from 'vscode';
import { AdaptationHttpAdapter } from '@forexplore/adaptation-http-adapter';
import { withSeekDbSearch } from '@forexplore/seekdb-adapter';
import type { WorkflowPorts } from '@forexplore/workflow-core';
import { checkServiceHealth } from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';
import type { ExecutionMode, ServiceStatus } from './ui-types';

export type ServiceKind = 'retrieval' | 'adaptation';

export interface RuntimePorts {
  ports: WorkflowPorts;
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

  constructor(private readonly output: vscode.OutputChannel) {}

  get serviceStatus(): ServiceStatus {
    return { ...this.status };
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
    this.status = {
      retrieval: retrieval.healthy ? 'connected' : 'error',
      adaptation: adaptation.healthy ? 'connected' : 'error',
      executionMode: 'real',
      message: [
        !retrieval.healthy && `检索：${retrieval.detail}`,
        !adaptation.healthy && `迁移适配：${adaptation.detail}`,
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
