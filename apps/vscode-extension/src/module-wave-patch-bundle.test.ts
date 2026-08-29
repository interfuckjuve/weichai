import { describe, expect, it } from 'vitest';
import {
  moduleWavePatchBundleSchemaVersion,
  parseModuleWavePatchBundle,
} from './module-wave-patch-bundle';

const digest = 'a'.repeat(64);

function bundle(): Record<string, unknown> {
  return {
    schemaVersion: moduleWavePatchBundleSchemaVersion,
    snapshotId: 'snapshot-example',
    planId: 'plan-example',
    planHash: `sha256:${digest}`,
    waveId: 'wave-1',
    modules: [{
      moduleId: 'service',
      files: [{
        path: 'src/Service.cs',
        status: 'modified',
        expectedOriginalSha256: digest,
        additions: 1,
        deletions: 1,
        hunks: [{
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'old' },
            { type: 'add', content: 'new' },
          ],
        }],
      }],
    }],
  };
}

describe('module wave patch bundle', () => {
  it('accepts a patch-only local bundle and derives stable provenance', () => {
    const first = parseModuleWavePatchBundle(bundle());
    const second = parseModuleWavePatchBundle(bundle());

    expect(first.modules[0]?.files[0]).toMatchObject({
      path: 'src/Service.cs',
      status: 'modified',
    });
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('normalizes optional SHA-256 prefixes to the internal patch contract', () => {
    const input = bundle();
    input.planHash = digest;
    const modules = input.modules as Array<Record<string, unknown>>;
    const files = modules[0]?.files as Array<Record<string, unknown>>;
    files[0]!.expectedOriginalSha256 = `sha256:${digest}`;

    const parsed = parseModuleWavePatchBundle(input);

    expect(parsed.planHash).toBe(`sha256:${digest}`);
    expect(parsed.modules[0]?.files[0]).toMatchObject({
      expectedOriginalSha256: digest,
    });
  });

  it('rejects producer-supplied validation evidence', () => {
    const input = bundle();
    input.validation = [{ id: 'claimed-pass', status: 'pass' }];

    expect(() => parseModuleWavePatchBundle(input)).toThrow('unsupported fields: validation');
  });

  it('rejects duplicate writes across module entries', () => {
    const input = bundle();
    input.modules = [
      ...(input.modules as unknown[]),
      {
        moduleId: 'another-module',
        files: [{
          path: 'src/Service.cs',
          status: 'created',
          expectedAbsent: true,
          additions: 1,
          deletions: 0,
          hunks: [{
            header: '@@ -0,0 +1,1 @@',
            lines: [{ type: 'add', content: 'new file' }],
          }],
        }],
      },
    ];

    expect(() => parseModuleWavePatchBundle(input)).toThrow('writes src/Service.cs more than once');
  });

  it('rejects traversal and inconsistent hunk counters', () => {
    const input = bundle();
    const modules = input.modules as Array<Record<string, unknown>>;
    const files = modules[0]?.files as Array<Record<string, unknown>>;
    files[0]!.path = '../outside.cs';
    expect(() => parseModuleWavePatchBundle(input)).toThrow('normalized repository-relative path');

    const counters = bundle();
    const counterModules = counters.modules as Array<Record<string, unknown>>;
    const counterFiles = counterModules[0]?.files as Array<Record<string, unknown>>;
    counterFiles[0]!.additions = 2;
    expect(() => parseModuleWavePatchBundle(counters)).toThrow('additions/deletions do not match');
  });
});
