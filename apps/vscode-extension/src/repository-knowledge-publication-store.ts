import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type {
  RepositoryArtifactProducer,
  RepositoryIngestionArtifactRef,
  RepositoryKnowledgePublication,
  RepositoryKnowledgePublicationHead,
  RepositoryKnowledgePublicationScope,
  RepositoryKnowledgePublicationSource,
  RepositoryModuleIndexReceipt,
} from '@forexplore/contracts';
import {
  repositoryIngestionSchemaVersion,
  repositoryKnowledgePublicationSchemaVersion,
} from '@forexplore/contracts';
import {
  activateRepositoryKnowledgePublication,
  canonicalJson,
  sha256Hex,
  validateRepositoryKnowledgePublication,
  validateRepositoryModuleIndexReceipt,
  withdrawRepositoryKnowledgePublication,
} from '@forexplore/workflow-core';
import {
  SqliteRepositoryKnowledgePublicationRegistry,
  repositoryKnowledgeRegistryScopeKey,
  type RepositoryKnowledgePublicationRegistry,
  type RepositoryKnowledgeRegistrySnapshot,
} from './repository-knowledge-publication-registry';

const publicationsPrefix = '.forexplore/publications/';
const currentProjectionPrefix = '.forexplore/modules/current/';

export interface RepositoryKnowledgePublicationArtifactInput {
  id: string;
  kind: RepositoryIngestionArtifactRef['kind'];
  /** Publication-relative POSIX path, for example `wiki/orders/summary.json`. */
  relativePath: string;
  mediaType: string;
  content: string | Uint8Array;
  schemaVersion?: string;
  createdAt?: string;
}

export interface StageRepositoryKnowledgePublicationInput {
  repositoryRoot: string;
  scope: RepositoryKnowledgePublicationScope;
  repositoryScopes: string[];
  source: RepositoryKnowledgePublicationSource;
  artifacts: readonly RepositoryKnowledgePublicationArtifactInput[];
  producer: RepositoryArtifactProducer;
  stagedAt?: string;
}

export interface ActivateRepositoryKnowledgePublicationInput {
  repositoryRoot: string;
  scope: RepositoryKnowledgePublicationScope;
  publicationId: string;
  indexReceipt: RepositoryModuleIndexReceipt;
  /** Exact head previously read by the caller; null means the scope was empty. */
  expectedHead: RepositoryKnowledgePublicationHead | null;
  activatedAt?: string;
}

export interface WithdrawRepositoryKnowledgePublicationInput {
  repositoryRoot: string;
  scope: RepositoryKnowledgePublicationScope;
  publicationId: string;
  indexReceipt: RepositoryModuleIndexReceipt;
  expectedHead: RepositoryKnowledgePublicationHead;
  reason: string;
  withdrawnAt?: string;
}

export interface RepositoryKnowledgePublicationMutationResult {
  publication: RepositoryKnowledgePublication;
  indexReceipt: RepositoryModuleIndexReceipt;
  head?: RepositoryKnowledgePublicationHead;
  restoredPublication?: RepositoryKnowledgePublication;
  /** False means SQLite committed and the rebuildable current view needs reconciliation. */
  currentProjectionSynchronized: boolean;
}

export interface RepositoryKnowledgeCurrentProjection {
  schemaVersion: typeof repositoryKnowledgePublicationSchemaVersion;
  scope: RepositoryKnowledgePublicationScope;
  head?: RepositoryKnowledgePublicationHead;
  synchronizedAt: string;
}

export interface RepositoryKnowledgePublicationStoreDependencies {
  registry?: RepositoryKnowledgePublicationRegistry;
  now?: () => string;
  publishCurrentProjection?: (
    repositoryRoot: string,
    projection: RepositoryKnowledgeCurrentProjection,
  ) => Promise<void>;
}

/**
 * Owns immutable publication bytes and the local SQLite control-plane.
 * Index staging/validation is deliberately a separate port: this store can
 * stage reviewed knowledge but cannot claim `ready` merely because files exist.
 */
export class RepositoryKnowledgePublicationStore {
  private readonly registry: RepositoryKnowledgePublicationRegistry;
  private readonly now: () => string;
  private readonly publishCurrentProjection: (
    repositoryRoot: string,
    projection: RepositoryKnowledgeCurrentProjection,
  ) => Promise<void>;

  constructor(dependencies: RepositoryKnowledgePublicationStoreDependencies = {}) {
    this.registry = dependencies.registry ?? new SqliteRepositoryKnowledgePublicationRegistry();
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.publishCurrentProjection = dependencies.publishCurrentProjection ?? writeCurrentProjection;
  }

  read(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
  ): Promise<RepositoryKnowledgeRegistrySnapshot> {
    return this.registry.read(repositoryRoot, scope);
  }

  async stage(
    input: StageRepositoryKnowledgePublicationInput,
  ): Promise<RepositoryKnowledgePublication> {
    validateScope(input.scope);
    const repositoryScopes = canonicalRepositoryScopes(input.repositoryScopes, input.scope.repositoryId);
    const stagedAt = input.stagedAt ?? this.now();
    validateTimestamp(stagedAt, 'publication staging time');
    if (input.artifacts.length === 0) {
      throw new Error('Repository knowledge publication requires at least one artifact.');
    }
    if (input.producer.kind !== 'knowledge-publisher') {
      throw new Error('Repository knowledge publication must be produced by the knowledge publisher.');
    }
    const prepared = preparePublicationArtifacts(input, stagedAt);
    await persistImmutablePublicationArtifacts(
      input.repositoryRoot,
      prepared.artifacts.map((artifact) => ({ path: artifact.ref.path!, content: artifact.content })),
    );

    // A concurrent, different stage can consume the generation observed by
    // this caller. Retrying only the registry allocation is safe because all
    // publication bytes and state revisions are immutable and idempotent.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.registry.read(input.repositoryRoot, input.scope);
      const source = {
        ...input.source,
        modules: [...input.source.modules].sort((left, right) => left.moduleId.localeCompare(right.moduleId)),
      };
      const artifacts = prepared.artifacts.map((artifact) => artifact.ref);
      const reusable = snapshot.publications.find((publication) =>
        publication.status !== 'withdrawn' &&
        (publication.status === 'active'
          ? snapshot.head?.publicationId === publication.id &&
            snapshot.head.publicationHash === publication.contentHash
          : publication.previousPublicationId === snapshot.head?.publicationId) &&
        canonicalJson(publication.repositoryScopes) === canonicalJson(repositoryScopes) &&
        canonicalJson(publication.source) === canonicalJson(source) &&
        canonicalJson(publication.artifacts) === canonicalJson(artifacts)
      );
      if (reusable !== undefined) return reusable;
      const immutablePayload = {
        scope: { ...input.scope },
        repositoryScopes,
        generation: snapshot.maxGeneration + 1,
        source,
        artifacts,
      };
      const payloadHash = sha256Hex(canonicalJson(immutablePayload));
      const publicationId = `repository-knowledge-publication:${payloadHash.slice(0, 24)}`;
      const existing = snapshot.publications.find((publication) => publication.id === publicationId);
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error('Repository knowledge publication ID already identifies another payload.');
        }
        return existing;
      }
      const publication = withPublicationHash({
        schemaVersion: repositoryKnowledgePublicationSchemaVersion,
        id: publicationId,
        ...immutablePayload,
        status: 'staged',
        payloadHash,
        ...(snapshot.head === undefined
          ? {}
          : { previousPublicationId: snapshot.head.publicationId }),
        stagedAt,
        producer: input.producer,
      });
      validateRepositoryKnowledgePublication(publication);
      await persistPublicationState(input.repositoryRoot, publication);
      try {
        const after = await this.registry.stage(input.repositoryRoot, publication, stagedAt);
        return requirePublication(after, publication.id);
      } catch (error) {
        if (
          attempt < 3 &&
          error instanceof Error &&
          error.message.includes('generation compare-and-swap conflict')
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error('Repository knowledge publication staging retries were exhausted.');
  }

  async activate(
    input: ActivateRepositoryKnowledgePublicationInput,
  ): Promise<RepositoryKnowledgePublicationMutationResult> {
    const activatedAt = input.activatedAt ?? this.now();
    validateTimestamp(activatedAt, 'publication activation time');
    const snapshot = await this.registry.read(input.repositoryRoot, input.scope);
    const staged = requirePublication(snapshot, input.publicationId);
    if (staged.status === 'active') {
      if (
        snapshot.head?.publicationId !== staged.id ||
        snapshot.head.publicationHash !== staged.contentHash ||
        input.expectedHead?.contentHash !== snapshot.head.contentHash
      ) {
        throw new Error('Repository knowledge publication active replay head compare-and-swap conflict.');
      }
      const replayedReceipt = replayActiveIndexReceipt(input.indexReceipt, staged);
      const synchronized = snapshot.currentProjectionDirty
        ? await this.synchronizeCurrentProjection(
          input.repositoryRoot,
          input.scope,
          snapshot.head,
          staged.activatedAt!,
        )
        : true;
      return {
        publication: staged,
        indexReceipt: replayedReceipt,
        head: snapshot.head,
        currentProjectionSynchronized: synchronized,
      };
    }
    assertExpectedHead(snapshot.head, input.expectedHead);
    if (staged.status !== 'staged') {
      throw new Error(`Repository knowledge publication cannot be activated from ${staged.status}.`);
    }
    await verifyPublicationArtifacts(input.repositoryRoot, staged);
    const transition = activateRepositoryKnowledgePublication({
      publication: staged,
      indexReceipt: input.indexReceipt,
      ...(snapshot.head === undefined ? {} : { currentHead: snapshot.head }),
      ...(input.expectedHead === null ? {} : { expectedHeadHash: input.expectedHead.contentHash }),
      activatedAt,
    });
    const active = transition.publication;
    const head = transition.head;
    await Promise.all([
      persistPublicationState(input.repositoryRoot, active),
      persistIndexReceiptState(input.repositoryRoot, transition.indexReceipt),
    ]);
    await this.registry.activate({
      repositoryRoot: input.repositoryRoot,
      publication: active,
      head,
      expectedHeadHash: input.expectedHead?.contentHash ?? null,
      occurredAt: activatedAt,
    });
    const synchronized = await this.synchronizeCurrentProjection(
      input.repositoryRoot,
      input.scope,
      head,
      activatedAt,
    );
    return {
      publication: active,
      indexReceipt: transition.indexReceipt,
      head,
      currentProjectionSynchronized: synchronized,
    };
  }

  async withdraw(
    input: WithdrawRepositoryKnowledgePublicationInput,
  ): Promise<RepositoryKnowledgePublicationMutationResult> {
    if (!input.reason.trim()) throw new Error('Repository knowledge publication withdrawal reason is required.');
    const withdrawnAt = input.withdrawnAt ?? this.now();
    validateTimestamp(withdrawnAt, 'publication withdrawal time');
    const snapshot = await this.registry.read(input.repositoryRoot, input.scope);
    const current = requirePublication(snapshot, input.publicationId);
    if (current.status === 'withdrawn') {
      if (
        input.expectedHead.publicationId !== current.id ||
        input.expectedHead.publicationHash !== current.previousStateHash
      ) {
        throw new Error('Repository knowledge publication withdrawal replay does not match the withdrawn state.');
      }
      const predecessor = current.previousPublicationId === undefined
        ? undefined
        : requirePublication(snapshot, current.previousPublicationId);
      if (
        (predecessor === undefined && snapshot.head !== undefined) ||
        (predecessor !== undefined && (
          snapshot.head?.publicationId !== predecessor.id ||
          snapshot.head.publicationHash !== predecessor.contentHash
        ))
      ) {
        throw new Error('Repository knowledge publication withdrawal replay restore head has advanced.');
      }
      const replayedReceipt = replayWithdrawnIndexReceipt(input.indexReceipt, current);
      const synchronized = snapshot.currentProjectionDirty
        ? await this.synchronizeCurrentProjection(
          input.repositoryRoot,
          input.scope,
          snapshot.head,
          current.withdrawnAt!,
        )
        : true;
      return {
        publication: current,
        indexReceipt: replayedReceipt,
        ...(snapshot.head === undefined ? {} : { head: snapshot.head }),
        ...(predecessor === undefined ? {} : { restoredPublication: predecessor }),
        currentProjectionSynchronized: synchronized,
      };
    }
    assertExpectedHead(snapshot.head, input.expectedHead);
    if (snapshot.head?.publicationId !== input.publicationId) {
      throw new Error('Only the active repository knowledge publication can be withdrawn.');
    }
    if (current.status !== 'active') {
      throw new Error('Repository knowledge publication head is not active.');
    }
    const predecessor = current.previousPublicationId === undefined
      ? undefined
      : requirePublication(snapshot, current.previousPublicationId);
    const transition = withdrawRepositoryKnowledgePublication({
      publication: current,
      indexReceipt: input.indexReceipt,
      currentHead: input.expectedHead,
      expectedHeadHash: input.expectedHead.contentHash,
      withdrawnAt,
      ...(predecessor === undefined ? {} : { restorePublication: predecessor }),
    });
    const withdrawn = transition.publication;
    const head = transition.head;
    await Promise.all([
      persistPublicationState(input.repositoryRoot, withdrawn),
      persistIndexReceiptState(input.repositoryRoot, transition.indexReceipt),
    ]);
    await this.registry.withdraw({
      repositoryRoot: input.repositoryRoot,
      publication: withdrawn,
      ...(predecessor === undefined ? {} : { restoredPublication: predecessor }),
      ...(head === undefined ? {} : { head }),
      expectedHeadHash: input.expectedHead.contentHash,
      occurredAt: withdrawnAt,
      reason: input.reason,
    });
    const synchronized = await this.synchronizeCurrentProjection(
      input.repositoryRoot,
      input.scope,
      head,
      withdrawnAt,
    );
    return {
      publication: withdrawn,
      indexReceipt: transition.indexReceipt,
      ...(head === undefined ? {} : { head }),
      ...(predecessor === undefined ? {} : { restoredPublication: predecessor }),
      currentProjectionSynchronized: synchronized,
    };
  }

  async reconcileCurrentProjection(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
  ): Promise<boolean> {
    const snapshot = await this.registry.read(repositoryRoot, scope);
    if (!snapshot.currentProjectionDirty) return true;
    return this.synchronizeCurrentProjection(repositoryRoot, scope, snapshot.head, this.now());
  }

  private async synchronizeCurrentProjection(
    repositoryRoot: string,
    scope: RepositoryKnowledgePublicationScope,
    head: RepositoryKnowledgePublicationHead | undefined,
    synchronizedAt: string,
  ): Promise<boolean> {
    try {
      await this.publishCurrentProjection(repositoryRoot, {
        schemaVersion: repositoryKnowledgePublicationSchemaVersion,
        scope: { ...scope },
        ...(head === undefined ? {} : { head }),
        synchronizedAt,
      });
    } catch {
      // The SQLite registry is authoritative. A failed projection write leaves
      // the old current view intact and the dirty bit set for reconciliation.
      return false;
    }
    return this.registry.markCurrentProjectionSynchronized(
      repositoryRoot,
      scope,
      head?.contentHash ?? null,
    );
  }
}

function preparePublicationArtifacts(
  input: StageRepositoryKnowledgePublicationInput,
  stagedAt: string,
): {
  artifacts: Array<{ ref: RepositoryIngestionArtifactRef; content: string | Uint8Array }>;
} {
  const seenPaths = new Set<string>();
  const normalized = input.artifacts.map((artifact) => {
    const relativePath = normalizeRelativeArtifactPath(artifact.relativePath);
    if (relativePath.startsWith('states/') || relativePath === 'payload.json') {
      throw new Error(`Repository knowledge publication artifact path is reserved: ${relativePath}`);
    }
    if (seenPaths.has(relativePath)) {
      throw new Error(`Duplicate repository knowledge publication artifact path: ${relativePath}`);
    }
    seenPaths.add(relativePath);
    const bytes = typeof artifact.content === 'string'
      ? Buffer.from(artifact.content, 'utf8')
      : Buffer.from(artifact.content);
    return {
      input: artifact,
      relativePath,
      bytes,
      contentHash: sha256Bytes(bytes),
    };
  }).sort((left, right) => left.input.id.localeCompare(right.input.id));
  const artifactScopeHash = sha256Hex(canonicalJson({
    scope: input.scope,
    repositoryScopes: canonicalRepositoryScopes(input.repositoryScopes, input.scope.repositoryId),
    source: input.source,
    artifacts: normalized.map((artifact) => ({
      id: artifact.input.id,
      kind: artifact.input.kind,
      relativePath: artifact.relativePath,
      mediaType: artifact.input.mediaType,
      byteLength: artifact.bytes.byteLength,
      contentHash: artifact.contentHash,
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  }));
  const publicationRoot = `${publicationsPrefix}payload-${artifactScopeHash.slice(0, 32)}`;
  return {
    artifacts: normalized.map((artifact) => ({
      ref: {
        id: artifact.input.id,
        kind: artifact.input.kind,
        contentHash: artifact.contentHash,
        hashAlgorithm: 'sha256',
        schemaVersion: artifact.input.schemaVersion ?? repositoryIngestionSchemaVersion,
        path: `${publicationRoot}/${artifact.relativePath}`,
        mediaType: artifact.input.mediaType,
        byteLength: artifact.bytes.byteLength,
        createdAt: artifact.input.createdAt ?? stagedAt,
      },
      content: artifact.input.content,
    })),
  };
}

async function persistPublicationState(
  repositoryRoot: string,
  publication: RepositoryKnowledgePublication,
): Promise<void> {
  const root = repositoryKnowledgePublicationRoot(publication.id);
  await persistImmutablePublicationArtifacts(repositoryRoot, [{
    path: `${root}/states/${publication.contentHash}.json`,
    content: `${canonicalJson(publication)}\n`,
  }]);
}

async function persistIndexReceiptState(
  repositoryRoot: string,
  receipt: RepositoryModuleIndexReceipt,
): Promise<void> {
  const root = repositoryKnowledgePublicationRoot(receipt.publicationId);
  await persistImmutablePublicationArtifacts(repositoryRoot, [{
    path: `${root}/index-receipts/${receipt.contentHash}.json`,
    content: `${canonicalJson(receipt)}\n`,
  }]);
}

async function persistImmutablePublicationArtifacts(
  repositoryRoot: string,
  artifacts: readonly { path: string; content: string | Uint8Array }[],
): Promise<void> {
  const root = path.resolve(repositoryRoot);
  for (const artifact of artifacts) {
    const normalized = normalizeStoredPublicationPath(artifact.path);
    const destination = resolveInside(root, normalized);
    await assertSafeParents(root, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertSafeParents(root, destination);
    await assertSafeTarget(destination, true);
    const bytes = typeof artifact.content === 'string'
      ? Buffer.from(artifact.content, 'utf8')
      : Buffer.from(artifact.content);
    await writeCreateOnly(destination, bytes);
  }
}

async function verifyPublicationArtifacts(
  repositoryRoot: string,
  publication: RepositoryKnowledgePublication,
): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const artifactRoot = publication.artifacts[0]?.path?.split('/').slice(0, 3).join('/');
  if (!artifactRoot?.startsWith(publicationsPrefix.slice(0, -1))) {
    throw new Error('Repository knowledge publication has no immutable artifact root.');
  }
  for (const artifact of publication.artifacts) {
    if (!artifact.path) throw new Error(`Publication artifact has no persisted path: ${artifact.id}`);
    const normalized = normalizeStoredPublicationPath(artifact.path);
    if (!normalized.startsWith(`${artifactRoot}/`)) {
      throw new Error(`Publication artifact is outside its immutable root: ${normalized}`);
    }
    const target = resolveInside(root, normalized);
    await assertSafeParents(root, target);
    await assertSafeTarget(target, false);
    const bytes = await readFile(target);
    if (sha256Bytes(bytes) !== artifact.contentHash) {
      throw new Error(`Repository knowledge publication artifact hash mismatch: ${normalized}`);
    }
    if (artifact.byteLength !== undefined && artifact.byteLength !== bytes.byteLength) {
      throw new Error(`Repository knowledge publication artifact byte length mismatch: ${normalized}`);
    }
  }
}

async function writeCurrentProjection(
  repositoryRoot: string,
  projection: RepositoryKnowledgeCurrentProjection,
): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const relativePath = `${currentProjectionPrefix}${repositoryKnowledgeRegistryScopeKey(projection.scope)}.json`;
  const destination = resolveInside(root, relativePath);
  await assertSafeParents(root, destination);
  await mkdir(path.dirname(destination), { recursive: true });
  await assertSafeParents(root, destination);
  await assertSafeTarget(destination, true);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${canonicalJson(projection)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function withPublicationHash(
  body: Omit<RepositoryKnowledgePublication, 'contentHash'>,
): RepositoryKnowledgePublication {
  return { ...body, contentHash: sha256Hex(canonicalJson(body)) };
}

function requirePublication(
  snapshot: RepositoryKnowledgeRegistrySnapshot,
  publicationId: string,
): RepositoryKnowledgePublication {
  const publication = snapshot.publications.find((candidate) => candidate.id === publicationId);
  if (publication === undefined) {
    throw new Error(`Repository knowledge publication does not exist: ${publicationId}`);
  }
  return publication;
}

function assertExpectedHead(
  actual: RepositoryKnowledgePublicationHead | undefined,
  expected: RepositoryKnowledgePublicationHead | null,
): void {
  if ((actual?.contentHash ?? null) !== (expected?.contentHash ?? null)) {
    throw new Error('Repository knowledge publication head compare-and-swap conflict.');
  }
}

function replayActiveIndexReceipt(
  validated: RepositoryModuleIndexReceipt,
  active: RepositoryKnowledgePublication,
): RepositoryModuleIndexReceipt {
  validateRepositoryModuleIndexReceipt(validated);
  if (
    validated.status !== 'validated' ||
    validated.publicationId !== active.id ||
    validated.publicationPayloadHash !== active.payloadHash ||
    validated.generation !== active.generation ||
    canonicalJson(validated.scope) !== canonicalJson(active.scope) ||
    active.activatedAt === undefined ||
    active.previousStateHash === undefined
  ) {
    throw new Error('Repository knowledge publication active replay receipt does not match.');
  }
  const { contentHash: previousStateHash, ...body } = validated;
  const receipt: RepositoryModuleIndexReceipt = {
    ...body,
    status: 'active',
    previousStateHash,
    updatedAt: active.activatedAt,
    contentHash: '',
  };
  receipt.contentHash = sha256Hex(canonicalJson(withoutContentHash(receipt)));
  validateRepositoryModuleIndexReceipt(receipt);
  return receipt;
}

function replayWithdrawnIndexReceipt(
  activeReceipt: RepositoryModuleIndexReceipt,
  withdrawn: RepositoryKnowledgePublication,
): RepositoryModuleIndexReceipt {
  validateRepositoryModuleIndexReceipt(activeReceipt);
  if (
    activeReceipt.status !== 'active' ||
    activeReceipt.publicationId !== withdrawn.id ||
    activeReceipt.publicationPayloadHash !== withdrawn.payloadHash ||
    activeReceipt.generation !== withdrawn.generation ||
    canonicalJson(activeReceipt.scope) !== canonicalJson(withdrawn.scope) ||
    withdrawn.withdrawnAt === undefined
  ) {
    throw new Error('Repository knowledge publication withdrawal replay receipt does not match.');
  }
  const { contentHash: previousStateHash, ...body } = activeReceipt;
  const receipt: RepositoryModuleIndexReceipt = {
    ...body,
    status: 'withdrawn',
    previousStateHash,
    updatedAt: withdrawn.withdrawnAt,
    contentHash: '',
  };
  receipt.contentHash = sha256Hex(canonicalJson(withoutContentHash(receipt)));
  validateRepositoryModuleIndexReceipt(receipt);
  return receipt;
}

function withoutContentHash<T extends { contentHash: string }>(value: T): Omit<T, 'contentHash'> {
  const { contentHash: _contentHash, ...body } = value;
  return body;
}

function normalizeRelativeArtifactPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Repository knowledge publication artifact path is unsafe: ${value}`);
  }
  return normalized;
}

function normalizeStoredPublicationPath(value: string): string {
  const normalized = normalizeRelativeArtifactPath(value);
  if (!normalized.startsWith(publicationsPrefix)) {
    throw new Error(`Immutable publication artifact must be inside ${publicationsPrefix}`);
  }
  return normalized;
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Repository knowledge publication artifact escapes the repository root.');
  }
  return target;
}

async function assertSafeParents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Repository knowledge publication parent is a symbolic link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Repository knowledge publication parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertSafeTarget(target: string, allowMissing: boolean): Promise<void> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`Repository knowledge publication target is a symbolic link: ${target}`);
    }
    if (!stats.isFile()) {
      throw new Error(`Repository knowledge publication target is not a regular file: ${target}`);
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function writeCreateOnly(destination: string, content: Uint8Array): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await assertSafeTarget(destination, false);
      const existing = await readFile(destination);
      if (!buffersEqual(existing, content)) {
        throw new Error(`Immutable publication artifact already exists with different content: ${destination}`);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function buffersEqual(left: Uint8Array, right: Uint8Array): boolean {
  return sha256Bytes(left) === sha256Bytes(right);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateScope(scope: RepositoryKnowledgePublicationScope): void {
  if (!scope.repositoryId.trim()) throw new Error('Repository knowledge publication repository ID is required.');
  if (!scope.channel.trim()) throw new Error('Repository knowledge publication channel is required.');
}

function canonicalRepositoryScopes(values: readonly string[], repositoryId: string): string[] {
  const scopes = [...new Set(values.map((value) => value.trim()))].sort();
  if (scopes.length === 0 || scopes.some((value) => !value)) {
    throw new Error('Repository knowledge publication scopes must be non-empty.');
  }
  if (!scopes.includes(repositoryId)) {
    throw new Error('Repository knowledge publication scopes must include the repository ID.');
  }
  return scopes;
}

function validateTimestamp(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

export function repositoryKnowledgePublicationRoot(publicationId: string): string {
  if (!publicationId.trim()) throw new Error('Repository knowledge publication ID is required.');
  const suffix = sha256Hex(publicationId).slice(0, 32);
  const readable = publicationId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${publicationsPrefix}${readable || 'publication'}-${suffix}`;
}

export function repositoryKnowledgeCurrentProjectionPath(
  scope: RepositoryKnowledgePublicationScope,
): string {
  return `${currentProjectionPrefix}${repositoryKnowledgeRegistryScopeKey(scope)}.json`;
}
