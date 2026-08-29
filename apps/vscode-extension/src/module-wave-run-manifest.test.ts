import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync,
  default: { execFileSync },
}));

import { GitModuleWaveRunManifestReader } from './module-wave-run-manifest';

const commit = 'a'.repeat(40);
const runId = 'run-1';
const branchName = `codex/forexplore-migration/${runId}`;

describe('GitModuleWaveRunManifestReader', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it('pins the managed run artifact to the verified publication commit', () => {
    execFileSync.mockReturnValueOnce(JSON.stringify({
      id: runId,
      snapshotId: 'snapshot-1',
      analysisHash: 'analysis-hash',
      planId: 'plan-1',
      planHash: 'sha256:plan-hash',
      decisions: [],
      validation: [],
      transactions: [],
      artifactPaths: {},
    }));

    new GitModuleWaveRunManifestReader().read('C:/repository', branchName, runId, commit);

    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', 'C:/repository', 'show', `${commit}:.forexplore/runs/${runId}.json`],
      expect.any(Object),
    );
  });

  it('rejects an unverified commit identity before invoking Git', () => {
    expect(() => new GitModuleWaveRunManifestReader().read('C:/repository', branchName, runId, 'HEAD'))
      .toThrow('已验证迁移提交标识无效');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
