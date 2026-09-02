import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';

export const DEFAULT_RETRIEVAL_API_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  topK: number;
  retrievalApiUrl: string;
  adaptationApiUrl: string;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    executionMode: 'real',
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    topK: boundedTopK(config.get<number>('topK', 4)),
    retrievalApiUrl:
      config.get<string>('retrievalApiUrl', DEFAULT_RETRIEVAL_API_URL).trim() ||
      DEFAULT_RETRIEVAL_API_URL,
    adaptationApiUrl:
      config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL).trim() ||
      DEFAULT_ADAPTATION_API_URL,
  };
}

export async function savePanelSettings(input: {
  repositoryPaths: string[];
  topK: number;
}): Promise<Pick<ExtensionSettings, 'repositoryPaths' | 'topK'>> {
  const repositoryPaths = [...new Set(input.repositoryPaths.map((value) => value.trim()).filter(Boolean))];
  const topK = boundedTopK(input.topK);
  const config = vscode.workspace.getConfiguration('forexplore');
  await config.update('repositoryPaths', repositoryPaths, vscode.ConfigurationTarget.Global);
  await config.update('topK', topK, vscode.ConfigurationTarget.Global);
  return { repositoryPaths, topK };
}

function boundedTopK(value: number): number {
  if (!Number.isInteger(value)) return 4;
  return Math.min(10, Math.max(1, value));
}

/**
 * Read validation commands only from user settings. Workspace settings are
 * repository-controlled and must never become executable host configuration.
 */
export function loadModuleWaveValidationCommands(): ModuleWaveValidationCommand[] {
  const config = vscode.workspace.getConfiguration('forexplore');
  const setting = config.inspect<unknown>('moduleWaveValidationCommands');
  if (
    setting?.workspaceValue !== undefined ||
    setting?.workspaceFolderValue !== undefined ||
    setting?.workspaceLanguageValue !== undefined ||
    setting?.workspaceFolderLanguageValue !== undefined
  ) {
    throw new Error('forexplore.moduleWaveValidationCommands 只能在用户设置中配置，不能由工作区设置提供。');
  }
  return parseModuleWaveValidationCommands(setting?.globalValue ?? []);
}
