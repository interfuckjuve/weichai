import { execFileSync } from 'node:child_process';
import type { MigrationRunManifest } from '@forexplore/contracts';
import { migrationRunArtifactPath } from '@forexplore/workflow-core';

export interface ModuleWaveRunManifestReader {
  read(repositoryRoot: string, branchName: string, runId: string, commit: string): MigrationRunManifest;
}

/** Read only the managed run artifact from the verified publication commit. */
export class GitModuleWaveRunManifestReader implements ModuleWaveRunManifestReader {
  read(repositoryRoot: string, branchName: string, runId: string, commit: string): MigrationRunManifest {
    assertManagedRunRef(branchName, runId);
    assertCommit(commit);
    const artifactPath = migrationRunArtifactPath(runId);
    let source: string;
    try {
      source = execFileSync('git', ['-C', repositoryRoot, 'show', `${commit}:${artifactPath}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1_024,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法从已验证迁移提交读取运行清单：${detail}`, { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error('已验证迁移提交中的运行清单不是有效 JSON。');
    }
    if (!isMigrationRunManifest(value)) {
      throw new Error('已验证迁移提交中的运行清单结构无效。');
    }
    return value;
  }
}

function assertCommit(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('已验证迁移提交标识无效。');
  }
}

function assertManagedRunRef(branchName: string, runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(runId)) {
    throw new Error('迁移运行标识无效。');
  }
  if (branchName !== `codex/forexplore-migration/${runId}`) {
    throw new Error('迁移分支不属于该运行。');
  }
}

function isMigrationRunManifest(value: unknown): value is MigrationRunManifest {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.snapshotId === 'string' &&
    typeof value.analysisHash === 'string' &&
    typeof value.planId === 'string' &&
    typeof value.planHash === 'string' &&
    Array.isArray(value.decisions) &&
    Array.isArray(value.validation) &&
    Array.isArray(value.transactions) &&
    isRecord(value.artifactPaths)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
