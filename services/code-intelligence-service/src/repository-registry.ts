import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  isStableRepositoryIdentifier,
  type RepositoryAnalysisStatus,
  type RepositoryId,
  type RepositoryRecord,
  type RepositoryRole,
} from '@forexplore/contracts';
import type { IndexStore } from './index-store.js';

export interface RegisterRepositoryRequest {
  /** Optional host-controlled stable ID; generated when omitted. */
  repositoryId?: RepositoryId;
  displayName?: string;
  localPath: string;
  role: RepositoryRole;
}

export interface RepositoryRegistryClock {
  now(): string;
}

export interface RepositoryRegistryOptions {
  clock?: RepositoryRegistryClock;
  idGenerator?: () => RepositoryId;
  /** Injectable for tests; resolves links before the registry persists a root. */
  resolveLocalPath?: (localPath: string) => Promise<string>;
}

function systemClock(): RepositoryRegistryClock {
  return { now: () => new Date().toISOString() };
}

async function resolveDirectory(localPath: string): Promise<string> {
  const resolved = await realpath(path.resolve(localPath));
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new Error(`Repository path must be a directory: ${localPath}`);
  return resolved;
}

function normalizeComparisonPath(value: string): string {
  const normalized = path.normalize(value);
  // Windows paths are case-insensitive by default. Normalizing unconditionally
  // also makes test expectations stable without exposing it to query clients.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function defaultDisplayName(localPath: string): string {
  return path.basename(localPath) || 'repository';
}

/**
 * Host-only registry. Its `getLocalPath` method intentionally does not live on
 * SemanticQueryPort, so agents/MCP clients cannot turn a repository ID into an
 * arbitrary filesystem capability.
 */
export class RepositoryRegistry {
  readonly #clock: RepositoryRegistryClock;
  readonly #idGenerator: () => RepositoryId;
  readonly #resolveLocalPath: (localPath: string) => Promise<string>;

  constructor(
    private readonly store: IndexStore,
    options: RepositoryRegistryOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock();
    this.#idGenerator = options.idGenerator ?? (() => randomUUID());
    this.#resolveLocalPath = options.resolveLocalPath ?? resolveDirectory;
  }

  async register(request: RegisterRepositoryRequest): Promise<RepositoryRecord> {
    if (!request.localPath?.trim()) throw new Error('Repository localPath is required.');
    if (request.role !== 'history' && request.role !== 'target') {
      throw new Error('Repository role must be history or target.');
    }
    const localPath = await this.#resolveLocalPath(request.localPath);
    const displayName = request.displayName?.trim() || defaultDisplayName(localPath);
    const requestedId = request.repositoryId?.trim();
    if (requestedId !== undefined && !isStableRepositoryIdentifier(requestedId)) {
      throw new Error('repositoryId must be a stable identifier, never a local path.');
    }

    const existing = await this.store.listRepositories();
    const samePath = existing.find((repository) =>
      normalizeComparisonPath(repository.localPath) === normalizeComparisonPath(localPath),
    );
    if (samePath) {
      if (requestedId && requestedId !== samePath.repositoryId) {
        throw new Error('The local path is already registered under a different repositoryId.');
      }
      // A re-registration is idempotent but lets the host change presentation
      // metadata and history/target role without destabilizing the identity.
      const updated: RepositoryRecord = {
        ...samePath,
        displayName,
        role: request.role,
        updatedAt: this.#clock.now(),
      };
      await this.store.putRepository(updated);
      return updated;
    }

    const repositoryId = requestedId ?? this.#idGenerator();
    if (!isStableRepositoryIdentifier(repositoryId)) {
      throw new Error('Repository registry generated an invalid repositoryId.');
    }
    if (await this.store.getRepository(repositoryId)) {
      throw new Error(`Repository ID ${repositoryId} is already registered.`);
    }
    const now = this.#clock.now();
    const repository: RepositoryRecord = {
      repositoryId,
      displayName,
      localPath,
      role: request.role,
      analysisStatus: 'registered',
      activeRevision: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putRepository(repository);
    return repository;
  }

  async get(repositoryId: RepositoryId): Promise<RepositoryRecord | null> {
    return this.store.getRepository(repositoryId);
  }

  async list(): Promise<RepositoryRecord[]> {
    return this.store.listRepositories();
  }

  async unregister(repositoryId: RepositoryId): Promise<void> {
    if (!await this.store.getRepository(repositoryId)) return;
    await this.store.removeRepository(repositoryId);
  }

  async getLocalPath(repositoryId: RepositoryId): Promise<string> {
    const repository = await this.store.getRepository(repositoryId);
    if (!repository) throw new Error(`Repository ${repositoryId} is not registered.`);
    return repository.localPath;
  }

  async setAnalysisStatus(
    repositoryId: RepositoryId,
    analysisStatus: RepositoryAnalysisStatus,
  ): Promise<RepositoryRecord> {
    const repository = await this.store.getRepository(repositoryId);
    if (!repository) throw new Error(`Repository ${repositoryId} is not registered.`);
    const updated: RepositoryRecord = {
      ...repository,
      analysisStatus,
      updatedAt: this.#clock.now(),
    };
    await this.store.putRepository(updated);
    return updated;
  }
}

export const repositoryRegistryInternals = {
  defaultDisplayName,
  normalizeComparisonPath,
  resolveDirectory,
};
