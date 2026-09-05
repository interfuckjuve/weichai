import * as vscode from 'vscode';
import { AdaptationHttpAdapter } from '@forexplore/adaptation-http-adapter';
import type { WorkflowPorts } from '@forexplore/workflow-core';
import { checkServiceHealth } from './service-health';
import { localFetch } from './local-fetch';
import { loadSettings } from './settings';
import type { ExecutionMode, ServiceStatus } from './ui-types';

export interface RuntimePorts {
  searchProvider: 'SeekDB';
  adaptationProvider: 'DeepSeek';
  executionMode: ExecutionMode;
}

/**
 * Owns the external adaptation runtime. Candidate retrieval is provided by
 * the extension's local code-intelligence runtime over its versioned SeekDB
 * projection, so it does not depend on the legacy retrieval HTTP service.
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
  getRuntimePresentation(): RuntimePorts {
    return {
      searchProvider: 'SeekDB',
      adaptationProvider: 'DeepSeek',
      executionMode: 'real',
    };
  }

  async refresh(): Promise<ServiceStatus> {
    const settings = loadSettings();
    const adaptation = await checkServiceHealth(settings.adaptationApiUrl, localFetch);
    this.status = {
      retrieval: 'connected',
      adaptation: adaptation.healthy ? 'connected' : 'error',
      executionMode: 'real',
      message: !adaptation.healthy ? `翻译：${adaptation.detail}` : undefined,
    };
    this.output.appendLine(
      `[forexplore] runtime refreshed: retrieval=${this.status.retrieval}, adaptation=${this.status.adaptation}`,
    );
    return this.serviceStatus;
  }

  async ensureStarted(): Promise<ServiceStatus> {
    return this.refresh();
  }

  getAdaptationPort(): WorkflowPorts['adaptation'] {
    if (this.status.adaptation !== 'connected') {
      throw new Error(this.status.message ?? '真实适配服务尚未就绪。');
    }
    return new AdaptationHttpAdapter({
      baseUrl: loadSettings().adaptationApiUrl,
      fetch: localFetch,
    });
  }

  dispose(): void {
    // The extension owns no child processes.
  }
}
