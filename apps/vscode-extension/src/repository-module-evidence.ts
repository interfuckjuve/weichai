import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoryModuleBundle,
  RepositoryModuleEvidenceItem,
  RepositoryModuleEvidenceOmission,
  RepositoryModuleEvidenceScope,
} from '@forexplore/contracts';
import {
  canonicalJson,
  validateRepositoryModuleBundleEnvelope,
} from '@forexplore/workflow-core';

export const repositoryModuleEvidenceAssemblerVersion = '1.0.0';

export interface RepositoryModuleEvidenceBudget {
  /** Maximum UTF-8 bytes retained from one repository file. */
  maxBytesPerFile: number;
  /** Maximum UTF-8 bytes retained across every item in one module bundle. */
  maxTotalBytes: number;
  maxItems: number;
}

export interface CollectRepositoryModuleEvidenceInput {
  repositoryRoot: string;
  bundle: RepositoryModuleBundle;
  moduleId: string;
  budget?: Partial<RepositoryModuleEvidenceBudget>;
}

export interface CollectedRepositoryModuleEvidence {
  scope: RepositoryModuleEvidenceScope;
  items: RepositoryModuleEvidenceItem[];
  omissions: RepositoryModuleEvidenceOmission[];
}

const defaultBudget: RepositoryModuleEvidenceBudget = {
  maxBytesPerFile: 64 * 1024,
  maxTotalBytes: 512 * 1024,
  maxItems: 128,
};

/**
 * Collect bounded Summary-Agent evidence from the exact repository snapshot
 * accepted by the module-boundary review. The collector never follows a path
 * outside `repositoryRoot`, and fails closed if current bytes no longer match
 * the immutable IR hash. Sensitive-config filters are a fail-safe prefilter,
 * not a complete DLP or secret-scanning system; deployments still need an
 * organization-owned outbound data policy before using a remote model.
 */
export async function collectRepositoryModuleEvidence(
  input: CollectRepositoryModuleEvidenceInput,
): Promise<CollectedRepositoryModuleEvidence> {
  // Validate the authorization envelope before resolving or reading any path.
  // A caller cannot add an in-repository file to a stale/tampered bundle and
  // use the evidence collector as a file-read primitive.
  validateRepositoryModuleBundleEnvelope(input.bundle);
  const budget = normalizeBudget(input.budget);
  const module = input.bundle.modules.find((candidate) => candidate.id === input.moduleId);
  if (!module) throw new Error(`Unknown repository module: ${input.moduleId}`);
  const repositoryRoot = await realpath(path.resolve(input.repositoryRoot));
  const fileById = new Map(input.bundle.files.map((file) => [file.id, file]));
  const entityById = new Map(input.bundle.entities.map((entity) => [entity.id, entity]));
  const moduleFileIds = new Set(module.fileIds);
  const moduleEntityIds = new Set(module.entityIds);
  const dependencyIds = new Set<string>();
  const neighboringFileIds = new Set<string>();

  for (const dependency of input.bundle.irDependencies) {
    const touchesModule =
      (dependency.sourceEntityId !== undefined && moduleEntityIds.has(dependency.sourceEntityId)) ||
      (dependency.targetEntityId !== undefined && moduleEntityIds.has(dependency.targetEntityId)) ||
      moduleFileIds.has(dependency.sourceFileId) ||
      (dependency.targetFileId !== undefined && moduleFileIds.has(dependency.targetFileId));
    if (!touchesModule) continue;
    dependencyIds.add(dependency.id);
    if (!moduleFileIds.has(dependency.sourceFileId)) neighboringFileIds.add(dependency.sourceFileId);
    if (dependency.targetFileId && !moduleFileIds.has(dependency.targetFileId)) {
      neighboringFileIds.add(dependency.targetFileId);
    }
  }

  const moduleProjectIds = new Set(
    input.bundle.files
      .filter((file) => moduleFileIds.has(file.id))
      .flatMap((file) => file.projectIds),
  );
  const contextFileIds = input.bundle.files
    .filter((file) =>
      (file.role === 'documentation' || file.role === 'configuration') &&
      file.projectIds.some((projectId) => moduleProjectIds.has(projectId)),
    )
    .map((file) => file.id);

  const candidateIds = stableUnique([
    ...module.fileIds,
    ...neighboringFileIds,
    ...contextFileIds,
  ]).filter((fileId) => fileById.has(fileId));
  const apiSurfaceIds = input.bundle.apiSurfaces
    .filter((surface) => moduleEntityIds.has(surface.entityId))
    .map((surface) => surface.id)
    .sort(compareText);
  const relatedIrDependencies = input.bundle.irDependencies
    .filter((dependency) => dependencyIds.has(dependency.id));
  const relatedModuleDependencies = input.bundle.moduleDependencies.filter((dependency) =>
    dependency.sourceModuleId === module.id || dependency.targetModuleId === module.id,
  );
  const relatedApiSurfaces = input.bundle.apiSurfaces
    .filter((surface) => apiSurfaceIds.includes(surface.id));
  const evidenceIds = stableUnique([
    ...module.evidenceRefs.map((reference) => reference.id),
    ...candidateIds,
    ...module.entityIds,
    ...relatedIrDependencies.flatMap((dependency) => [
      dependency.id,
      ...dependency.evidenceRefs.map((reference) => reference.id),
    ]),
    ...relatedModuleDependencies.flatMap((dependency) =>
      dependency.evidenceRefs.map((reference) => reference.id),
    ),
    ...relatedApiSurfaces.flatMap((surface) => [
      surface.id,
      surface.entityId,
      ...surface.evidenceRefs.map((reference) => reference.id),
    ]),
  ]);
  const scope: RepositoryModuleEvidenceScope = {
    fileIds: candidateIds,
    entityIds: [...moduleEntityIds].sort(compareText),
    dependencyIds: [...dependencyIds].sort(compareText),
    apiSurfaceIds,
    evidenceIds,
  };

  const items: RepositoryModuleEvidenceItem[] = [];
  const omissions: RepositoryModuleEvidenceOmission[] = [];
  let retainedBytes = 0;

  for (const fileId of candidateIds) {
    const file = fileById.get(fileId)!;
    if (items.length >= budget.maxItems) {
      omissions.push({ kind: itemKindForRole(file.role), sourceId: file.id, reason: 'item-budget-exhausted' });
      continue;
    }
    if (retainedBytes >= budget.maxTotalBytes) {
      omissions.push({ kind: itemKindForRole(file.role), sourceId: file.id, reason: 'total-byte-budget-exhausted' });
      continue;
    }
    if (file.role === 'configuration' && isSensitiveConfigurationPath(file.path)) {
      omissions.push({
        kind: 'configuration',
        sourceId: file.id,
        reason: 'sensitive-configuration-path-not-authorized',
      });
      continue;
    }

    const absolutePath = await resolveSnapshotFile(repositoryRoot, file.path);
    const remaining = budget.maxTotalBytes - retainedBytes;
    const snapshot = await readSnapshotPrefix(
      absolutePath,
      Math.min(budget.maxBytesPerFile, remaining),
    );
    if (snapshot.contentHash !== file.contentHash) {
      throw new Error(`Repository file changed after the accepted snapshot: ${file.path}`);
    }
    if (snapshot.containsNul) {
      omissions.push({ kind: itemKindForRole(file.role), sourceId: file.id, reason: 'binary-content-not-authorized-for-summary' });
      continue;
    }
    if (file.role === 'configuration' && snapshot.containsLikelySecret) {
      omissions.push({
        kind: 'configuration',
        sourceId: file.id,
        reason: 'secret-like-configuration-content-not-authorized',
      });
      continue;
    }
    const retained = decodeUtf8Prefix(
      snapshot.prefix,
      snapshot.prefix.byteLength,
    );
    if (retained === null) {
      omissions.push({ kind: itemKindForRole(file.role), sourceId: file.id, reason: 'non-utf8-content-not-authorized-for-summary' });
      continue;
    }
    const content = retained.content.replace(/\r\n/g, '\n');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const truncated = retained.byteLength < snapshot.byteLength;
    const relatedEntityIds = input.bundle.entities
      .filter((entity) => entity.fileId === file.id && moduleEntityIds.has(entity.id))
      .map((entity) => entity.id);
    const relatedApiIds = input.bundle.apiSurfaces
      .filter((surface) => relatedEntityIds.includes(surface.entityId))
      .map((surface) => surface.id);
    const itemPayload = {
      kind: itemKindForRole(file.role),
      evidenceKind: evidenceKindForRole(file.role),
      evidenceRefIds: stableUnique([file.id, ...relatedEntityIds, ...relatedApiIds]),
      sourceArtifactId: input.bundle.id,
      path: file.path,
      range: {
        path: file.path,
        startLine: 1,
        endLine: Math.max(1, content.split('\n').length),
      },
      mediaType: 'text/plain; charset=utf-8',
      content,
      byteLength: contentBytes,
      contentHash: sha256(Buffer.from(content, 'utf8')),
      truncated,
      ...(truncated ? { truncationReason: 'per-file-or-total-byte-budget' } : {}),
    } satisfies Omit<RepositoryModuleEvidenceItem, 'id'>;
    items.push({
      ...itemPayload,
      id: `module-evidence-item:${sha256(Buffer.from(canonicalJson(itemPayload), 'utf8')).slice(0, 24)}`,
    });
    retainedBytes += contentBytes;
  }

  const structuredItems = [
    structuredEvidenceItem(
      'api-surface',
      'semantic-analysis',
      stableUnique(relatedApiSurfaces.flatMap((surface) => [
        surface.id,
        surface.entityId,
        ...surface.evidenceRefs.map((reference) => reference.id),
      ])),
      relatedApiSurfaces,
      input.bundle.id,
    ),
    structuredEvidenceItem(
      'dependency-neighborhood',
      'semantic-analysis',
      stableUnique(relatedIrDependencies.flatMap((dependency) => [
        dependency.id,
        ...dependency.evidenceRefs.map((reference) => reference.id),
      ])),
      relatedIrDependencies,
      input.bundle.id,
    ),
  ];
  for (const item of structuredItems) {
    if (item.byteLength === 0) continue;
    if (items.length >= budget.maxItems || retainedBytes + item.byteLength > budget.maxTotalBytes) {
      omissions.push({ kind: item.kind, sourceId: item.id, reason: 'structured-evidence-budget-exhausted' });
      continue;
    }
    items.push(item);
    retainedBytes += item.byteLength;
  }

  if (items.length === 0) {
    throw new Error(`No authorized textual evidence is available for module ${module.id}.`);
  }
  return {
    scope,
    items: items.sort((left, right) => left.id.localeCompare(right.id)),
    omissions: omissions.sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.reason.localeCompare(right.reason),
    ),
  };
}

async function readSnapshotPrefix(
  absolutePath: string,
  maxPrefixBytes: number,
): Promise<{
  prefix: Buffer;
  byteLength: number;
  contentHash: string;
  containsNul: boolean;
  containsLikelySecret: boolean;
}> {
  const digest = createHash('sha256');
  const prefixes: Buffer[] = [];
  let retained = 0;
  let byteLength = 0;
  let containsNul = false;
  let containsLikelySecret = false;
  let secretScanTail = '';
  for await (const value of createReadStream(absolutePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    digest.update(chunk);
    byteLength += chunk.byteLength;
    if (!containsNul && chunk.includes(0)) containsNul = true;
    if (!containsLikelySecret) {
      const scan = `${secretScanTail}${chunk.toString('utf8')}`;
      containsLikelySecret = likelySecretPattern.test(scan);
      secretScanTail = scan.slice(-512);
    }
    if (retained < maxPrefixBytes) {
      const slice = chunk.subarray(0, Math.min(chunk.byteLength, maxPrefixBytes - retained));
      prefixes.push(Buffer.from(slice));
      retained += slice.byteLength;
    }
  }
  return {
    prefix: Buffer.concat(prefixes, retained),
    byteLength,
    contentHash: digest.digest('hex'),
    containsNul,
    containsLikelySecret,
  };
}

const likelySecretPattern = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,})/i;

function isSensitiveConfigurationPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? '';
  return (
    name === '.env' || name.startsWith('.env.') ||
    name === 'id_rsa' || name.startsWith('id_rsa.') ||
    /\.(?:pem|key|p12|pfx)$/.test(name) ||
    /(?:^|[._-])(?:credentials?|secrets?)(?:$|[._-])/.test(name)
  );
}

async function resolveSnapshotFile(repositoryRoot: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new Error(`Repository evidence path must be relative: ${relativePath}`);
  const candidate = path.resolve(repositoryRoot, ...relativePath.replaceAll('\\', '/').split('/'));
  if (!isWithin(repositoryRoot, candidate)) {
    throw new Error(`Repository evidence path escapes the repository root: ${relativePath}`);
  }
  const resolved = await realpath(candidate);
  if (!isWithin(repositoryRoot, resolved)) {
    throw new Error(`Repository evidence symlink escapes the repository root: ${relativePath}`);
  }
  return resolved;
}

function structuredEvidenceItem(
  kind: 'api-surface' | 'dependency-neighborhood',
  evidenceKind: 'semantic-analysis',
  evidenceRefIds: string[],
  value: unknown[],
  sourceArtifactId: string,
): RepositoryModuleEvidenceItem {
  const content = value.length === 0 ? '' : `${canonicalJson(value)}\n`;
  const payload = {
    kind,
    evidenceKind,
    evidenceRefIds,
    sourceArtifactId,
    mediaType: 'application/json',
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    contentHash: sha256(Buffer.from(content, 'utf8')),
    truncated: false,
  } satisfies Omit<RepositoryModuleEvidenceItem, 'id'>;
  return {
    ...payload,
    id: `module-evidence-item:${sha256(Buffer.from(canonicalJson(payload), 'utf8')).slice(0, 24)}`,
  };
}

function itemKindForRole(role: RepositoryModuleBundle['files'][number]['role']): RepositoryModuleEvidenceItem['kind'] {
  if (role === 'test') return 'test';
  if (role === 'documentation') return 'documentation';
  if (role === 'configuration') return 'configuration';
  return 'source-slice';
}

function evidenceKindForRole(role: RepositoryModuleBundle['files'][number]['role']): RepositoryModuleEvidenceItem['evidenceKind'] {
  if (role === 'test') return 'test';
  if (role === 'documentation') return 'documentation';
  if (role === 'configuration') return 'configuration';
  return 'source';
}

function normalizeBudget(value: Partial<RepositoryModuleEvidenceBudget> | undefined): RepositoryModuleEvidenceBudget {
  const budget = { ...defaultBudget, ...value };
  for (const [name, amount] of Object.entries(budget)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Repository module evidence ${name} must be a positive safe integer.`);
    }
  }
  return budget;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodeUtf8Prefix(
  value: Buffer,
  maxBytes: number,
): { content: string; byteLength: number } | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const initial = Math.min(value.byteLength, maxBytes);
  for (let length = initial; length >= Math.max(0, initial - 3); length -= 1) {
    try {
      return { content: decoder.decode(value.subarray(0, length)), byteLength: length };
    } catch {
      // A bounded prefix can split one UTF-8 code point; retry at most 3 bytes.
    }
  }
  return null;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}
