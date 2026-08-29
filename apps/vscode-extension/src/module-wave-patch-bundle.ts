import type { FilePatch, PatchHunk } from '@forexplore/contracts';
import { stableHash } from '@forexplore/workflow-core';

export const moduleWavePatchBundleSchemaVersion = 'forexplore-module-wave-patch-bundle/v1';
const maxModules = 128;
const maxFiles = 2_048;
const maxHunksPerFile = 4_096;
const maxLinesPerHunk = 50_000;

/**
 * Local, pre-generated patch input. Validation evidence is intentionally not
 * part of this format: the VS Code host must generate and run it itself in
 * the disposable wave worktree.
 */
export interface ModuleWavePatchBundle {
  schemaVersion: typeof moduleWavePatchBundleSchemaVersion;
  snapshotId: string;
  planId: string;
  planHash: string;
  waveId: string;
  modules: ModuleWavePatchBundleModule[];
  contentHash: string;
}

export interface ModuleWavePatchBundleModule {
  moduleId: string;
  files: FilePatch[];
}

/** Parse an untrusted local JSON value into the narrow patch-only bundle format. */
export function parseModuleWavePatchBundle(value: unknown): ModuleWavePatchBundle {
  const source = requireRecord(value, 'Module wave patch bundle must be a JSON object.');
  assertOnlyKeys(source, [
    'schemaVersion',
    'snapshotId',
    'planId',
    'planHash',
    'waveId',
    'modules',
  ], 'Module wave patch bundle');
  if (source.schemaVersion !== moduleWavePatchBundleSchemaVersion) {
    throw new Error(`Unsupported module wave patch bundle schema: ${String(source.schemaVersion)}.`);
  }
  const snapshotId = requiredIdentifier(source.snapshotId, 'snapshotId');
  const planId = requiredIdentifier(source.planId, 'planId');
  const planHash = requiredPlanHash(source.planHash, 'planHash');
  const waveId = requiredIdentifier(source.waveId, 'waveId');
  if (!Array.isArray(source.modules) || source.modules.length === 0 || source.modules.length > maxModules) {
    throw new Error(`Module wave patch bundle modules must contain between 1 and ${maxModules} entries.`);
  }

  const moduleIds = new Set<string>();
  const paths = new Set<string>();
  const modules = source.modules.map((item, index) => {
    const module = requireRecord(item, `Module patch entry ${index} must be an object.`);
    assertOnlyKeys(module, ['moduleId', 'files'], `Module patch entry ${index}`);
    const moduleId = requiredIdentifier(module.moduleId, `modules[${index}].moduleId`);
    if (moduleIds.has(moduleId)) {
      throw new Error(`Module wave patch bundle repeats module ${moduleId}.`);
    }
    moduleIds.add(moduleId);
    if (!Array.isArray(module.files) || module.files.length === 0 || module.files.length > maxFiles) {
      throw new Error(`Module ${moduleId} must contain between 1 and ${maxFiles} file patches.`);
    }
    const files = module.files.map((patch, fileIndex) => parseFilePatch(
      patch,
      `modules[${index}].files[${fileIndex}]`,
    ));
    for (const file of files) {
      if (paths.has(file.path)) {
        throw new Error(`Module wave patch bundle writes ${file.path} more than once.`);
      }
      paths.add(file.path);
    }
    return { moduleId, files };
  });

  const canonical: Omit<ModuleWavePatchBundle, 'contentHash'> = {
    schemaVersion: moduleWavePatchBundleSchemaVersion,
    snapshotId,
    planId,
    planHash,
    waveId,
    modules,
  };
  return {
    ...canonical,
    contentHash: stableHash(canonical),
  };
}

function parseFilePatch(value: unknown, location: string): FilePatch {
  const patch = requireRecord(value, `${location} must be an object.`);
  const status = patch.status;
  if (status !== 'modified' && status !== 'created') {
    throw new Error(`${location}.status must be "modified" or "created".`);
  }
  assertOnlyKeys(
    patch,
    status === 'modified'
      ? ['path', 'status', 'expectedOriginalSha256', 'additions', 'deletions', 'hunks']
      : ['path', 'status', 'expectedAbsent', 'additions', 'deletions', 'hunks'],
    location,
  );
  const patchPath = requiredRepositoryPath(patch.path, `${location}.path`);
  const additions = nonNegativeInteger(patch.additions, `${location}.additions`);
  const deletions = nonNegativeInteger(patch.deletions, `${location}.deletions`);
  if (!Array.isArray(patch.hunks) || patch.hunks.length === 0 || patch.hunks.length > maxHunksPerFile) {
    throw new Error(`${location}.hunks must contain between 1 and ${maxHunksPerFile} entries.`);
  }
  const hunks = patch.hunks.map((hunk, index) => parseHunk(hunk, `${location}.hunks[${index}]`));
  const actualAdditions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.type === 'add').length,
    0,
  );
  const actualDeletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.type === 'remove').length,
    0,
  );
  if (actualAdditions !== additions || actualDeletions !== deletions) {
    throw new Error(`${location} additions/deletions do not match its hunk lines.`);
  }

  if (status === 'modified') {
    return {
      path: patchPath,
      status,
      expectedOriginalSha256: requiredFileSha256(patch.expectedOriginalSha256, `${location}.expectedOriginalSha256`),
      additions,
      deletions,
      hunks,
    };
  }
  if (patch.expectedAbsent !== true) {
    throw new Error(`${location}.expectedAbsent must be true for a created file.`);
  }
  return {
    path: patchPath,
    status,
    expectedAbsent: true,
    additions,
    deletions,
    hunks,
  };
}

function parseHunk(value: unknown, location: string): PatchHunk {
  const hunk = requireRecord(value, `${location} must be an object.`);
  assertOnlyKeys(hunk, ['header', 'lines'], location);
  const header = requiredText(hunk.header, `${location}.header`, 1_024);
  if (!Array.isArray(hunk.lines) || hunk.lines.length === 0 || hunk.lines.length > maxLinesPerHunk) {
    throw new Error(`${location}.lines must contain between 1 and ${maxLinesPerHunk} entries.`);
  }
  return {
    header,
    lines: hunk.lines.map((line, index) => {
      const entry = requireRecord(line, `${location}.lines[${index}] must be an object.`);
      assertOnlyKeys(entry, ['type', 'content'], `${location}.lines[${index}]`);
      if (entry.type !== 'context' && entry.type !== 'add' && entry.type !== 'remove') {
        throw new Error(`${location}.lines[${index}].type is invalid.`);
      }
      const content = requiredText(entry.content, `${location}.lines[${index}].content`, 1_000_000, true);
      if (content.includes('\n') || content.includes('\r')) {
        throw new Error(`${location}.lines[${index}].content must be a single line.`);
      }
      return { type: entry.type, content };
    }),
  };
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], location: string): void {
  const invalid = Object.keys(value).filter((key) => !allowed.includes(key));
  if (invalid.length > 0) {
    throw new Error(`${location} contains unsupported fields: ${invalid.sort().join(', ')}.`);
  }
}

function requiredIdentifier(value: unknown, location: string): string {
  const result = requiredText(value, location, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new Error(`${location} must be a safe identifier.`);
  }
  return result;
}

function requiredPlanHash(value: unknown, location: string): string {
  return `sha256:${requiredSha256Digest(value, location)}`;
}

/** FilePatch keeps bare digests because BackfillAdapter compares raw SHA-256 bytes. */
function requiredFileSha256(value: unknown, location: string): string {
  return requiredSha256Digest(value, location);
}

function requiredSha256Digest(value: unknown, location: string): string {
  const result = requiredText(value, location, 72);
  const bare = result.startsWith('sha256:') ? result.slice('sha256:'.length) : result;
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new Error(`${location} must be a SHA-256 hash.`);
  }
  return bare;
}

function requiredRepositoryPath(value: unknown, location: string): string {
  const result = requiredText(value, location, 4_096);
  if (
    result.includes('\\') ||
    result.startsWith('/') ||
    /^[A-Za-z]:/.test(result) ||
    result.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${location} must be a normalized repository-relative path.`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${location} must be a non-negative integer.`);
  }
  return value;
}

function requiredText(value: unknown, location: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${location} must be a ${allowEmpty ? 'bounded' : 'non-empty'} string.`);
  }
  return value;
}
