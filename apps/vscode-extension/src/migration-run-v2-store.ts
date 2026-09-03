import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

export interface MigrationRunV2ArtifactSet {
  searchRequest: unknown;
  searchCandidate: unknown;
  indexedDocument: unknown;
  sourceBundle: unknown;
  targetContext: unknown;
  adaptationRequest: unknown;
  adaptationResult: unknown;
  executionContext: unknown;
}

export interface MigrationRunManifestHead {
  manifestId: string;
  manifestHash: string;
  path: string;
  updatedAt: string;
}

/** Durable, Host-owned audit storage. Paths returned here are stable relative
 * artifact names suitable for the content-addressed V2 manifest. */
export class MigrationRunV2Store {
  constructor(private readonly storageUri: vscode.Uri) {}

  async writeArtifacts(
    runId: string,
    artifacts: MigrationRunV2ArtifactSet,
  ): Promise<Record<string, string>> {
    const safeId = safeRunId(runId);
    const relativeDirectory = `migration-runs-v2/${safeId}`;
    const directory = vscode.Uri.joinPath(this.storageUri, 'migration-runs-v2', safeId);
    await vscode.workspace.fs.createDirectory(directory);
    const entries = Object.entries(artifacts);
    const paths: Record<string, string> = {};
    for (const [name, artifact] of entries) {
      const fileName = `${name}.json`;
      await writeImmutableFile(
        vscode.Uri.joinPath(directory, fileName),
        Buffer.from(JSON.stringify(artifact, null, 2), 'utf8'),
        `V2 run artifact ${name}`,
      );
      paths[name] = `${relativeDirectory}/${fileName}`;
    }
    return paths;
  }

  async writeManifest(
    runId: string,
    manifest: { id: string; contentHash: string },
  ): Promise<MigrationRunManifestHead> {
    const safeId = safeRunId(runId);
    const directory = vscode.Uri.joinPath(this.storageUri, 'migration-runs-v2', safeId, 'manifests');
    await vscode.workspace.fs.createDirectory(directory);
    const fileName = `${safeRunId(manifest.id)}.json`;
    const uri = vscode.Uri.joinPath(directory, fileName);
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    await writeImmutableFile(uri, bytes, `V2 manifest ${manifest.id}`);
    const head: MigrationRunManifestHead = {
      manifestId: manifest.id,
      manifestHash: manifest.contentHash,
      path: `migration-runs-v2/${safeId}/manifests/${fileName}`,
      updatedAt: new Date().toISOString(),
    };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.storageUri, 'migration-runs-v2', safeId, 'current-manifest.json'),
      Buffer.from(JSON.stringify(head, null, 2), 'utf8'),
    );
    return head;
  }

  async readArtifact<T>(runId: string, name: keyof MigrationRunV2ArtifactSet): Promise<T> {
    const uri = vscode.Uri.joinPath(
      this.storageUri,
      'migration-runs-v2',
      safeRunId(runId),
      `${name}.json`,
    );
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  }

  async readManifest<T>(runId: string, manifestId: string): Promise<T> {
    const uri = vscode.Uri.joinPath(
      this.storageUri,
      'migration-runs-v2',
      safeRunId(runId),
      'manifests',
      `${safeRunId(manifestId)}.json`,
    );
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  }

  async writeRecoveryRecord(
    runId: string,
    record: Record<string, unknown>,
  ): Promise<string> {
    const payload = JSON.stringify(record);
    const hash = sha256Text(payload);
    const safeId = safeRunId(runId);
    const directory = vscode.Uri.joinPath(
      this.storageUri,
      'migration-runs-v2',
      safeId,
      'recovery-records',
    );
    await vscode.workspace.fs.createDirectory(directory);
    const fileName = `recovery-${hash.slice(0, 24)}.json`;
    await writeImmutableFile(
      vscode.Uri.joinPath(directory, fileName),
      Buffer.from(JSON.stringify({ ...record, contentHash: hash }, null, 2), 'utf8'),
      `V2 recovery record ${hash}`,
    );
    return `migration-runs-v2/${safeId}/recovery-records/${fileName}`;
  }
}

function safeRunId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 128);
  if (!normalized) throw new Error('Migration V2 run ID is invalid.');
  return normalized;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

async function writeImmutableFile(
  uri: vscode.Uri,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  try {
    const existing = await vscode.workspace.fs.readFile(uri);
    if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0) {
      throw new Error(`Immutable ${label} path collision.`);
    }
    return;
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
  await vscode.workspace.fs.writeFile(uri, bytes);
}
