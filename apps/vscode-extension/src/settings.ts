import * as vscode from 'vscode';
import path from 'node:path';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';

export const DEFAULT_RETRIEVAL_API_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';
export const DEFAULT_REPOSITORY_KNOWLEDGE_CHANNEL = 'branch:main';
export const MODULE_INDEX_WRITER_TOKEN_ENV = 'FOREXPLORE_MODULE_INDEX_WRITER_TOKEN';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  topK: number;
  retrievalApiUrl: string;
  adaptationApiUrl: string;
  repositoryKnowledgeChannel: string;
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
    repositoryKnowledgeChannel:
      config.get<string>('repositoryKnowledgeChannel', DEFAULT_REPOSITORY_KNOWLEDGE_CHANNEL).trim() ||
      DEFAULT_REPOSITORY_KNOWLEDGE_CHANNEL,
  };
}

export async function savePanelSettings(input: {
  repositoryPaths: string[];
  topK: number;
}): Promise<Pick<ExtensionSettings, 'repositoryPaths' | 'topK'>> {
  if (input.repositoryPaths.length > 20) {
    throw new Error('历史仓路径最多配置 20 项。');
  }
  if (input.repositoryPaths.some((value) => value.length > 1_000)) {
    throw new Error('单个历史仓路径不能超过 1000 个字符。');
  }
  const repositoryPaths = normalizeRepositoryPaths(input.repositoryPaths);
  const topK = boundedTopK(input.topK);
  const config = vscode.workspace.getConfiguration('forexplore');
  await config.update('repositoryPaths', repositoryPaths, vscode.ConfigurationTarget.Global);
  await config.update('topK', topK, vscode.ConfigurationTarget.Global);
  return { repositoryPaths, topK };
}

export function normalizeRepositoryPaths(values: readonly string[]): string[] {
  const normalized = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const absolute = path.normalize(path.resolve(trimmed));
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (!normalized.has(key)) normalized.set(key, absolute);
  }
  return [...normalized.values()];
}

function boundedTopK(value: number): number {
  if (!Number.isInteger(value)) return 4;
  return Math.min(10, Math.max(1, value));
}

/**
 * The module-index writer token is process-owned. It is deliberately not read
 * from workspace settings because repository content must not be able to grant
 * itself publication authority.
 */
export function loadModuleKnowledgeIndexWriterToken(): string {
  const token = process.env[MODULE_INDEX_WRITER_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error(`环境变量 ${MODULE_INDEX_WRITER_TOKEN_ENV} 未配置；模块知识只能停留在已审阅、未发布状态。`);
  }
  return token;
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
