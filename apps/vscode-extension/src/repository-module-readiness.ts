import type {
  AnalysisCapability,
  AnalysisShard,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';

export const repositoryModuleDiscoveryRequiredCapabilities = [
  'file-inventory',
  'symbol-index',
  'api-surface',
] as const satisfies readonly AnalysisCapability[];

export interface RepositoryModuleDiscoveryReadinessIssue {
  code:
    | 'NO_ANALYSABLE_SOURCE'
    | 'UNCLASSIFIED_REPOSITORY_FILE'
    | 'INCOMPLETE_ANALYSIS_SHARD'
    | 'MISSING_ANALYSIS_CAPABILITY'
    | 'FAILED_ANALYSIS_FILE'
    | 'IR_SHARD_MISMATCH';
  message: string;
  shardId?: string;
  languageId?: string;
  fileIds?: string[];
  missingCapabilities?: AnalysisCapability[];
}

export interface RepositoryModuleDiscoveryReadiness {
  ready: boolean;
  requiredCapabilities: AnalysisCapability[];
  blockingIssues: RepositoryModuleDiscoveryReadinessIssue[];
  missingOptionalCapabilities: AnalysisCapability[];
}

const sourceRoles = new Set(['source', 'test', 'generated']);
const optionalCapabilities = [
  'dependency-graph',
  'semantic-binding',
  'test-association',
] as const satisfies readonly AnalysisCapability[];

/**
 * Host policy for deciding whether an immutable IR contains enough evidence to
 * ask the Module Discovery Agent for boundaries. This deliberately runs before
 * any model call. Documentation/configuration-only shards remain inventory
 * facts, while unclassified files and partially analysed source shards fail
 * closed instead of being guessed into modules.
 */
export function assessRepositoryModuleDiscoveryReadiness(
  shards: readonly AnalysisShard[],
  ir: UnifiedRepositoryIR,
): RepositoryModuleDiscoveryReadiness {
  const issues: RepositoryModuleDiscoveryReadinessIssue[] = [];
  const shardById = new Map(shards.map((shard) => [shard.id, shard]));
  const expectedShardIds = [...new Set(ir.sourceShardIds)].sort();
  const suppliedShardIds = [...shardById.keys()].sort();
  if (JSON.stringify(expectedShardIds) !== JSON.stringify(suppliedShardIds)) {
    issues.push({
      code: 'IR_SHARD_MISMATCH',
      message: 'Unified repository IR does not bind exactly to the supplied analysis shards.',
    });
  }

  let analysableSourceCount = 0;
  for (const shard of shards) {
    const sourceFiles = shard.files.filter((file) => sourceRoles.has(file.role));
    const unclassifiedFiles = shard.files.filter((file) => file.role === 'other');
    analysableSourceCount += sourceFiles.length;

    if (unclassifiedFiles.length > 0) {
      issues.push({
        code: 'UNCLASSIFIED_REPOSITORY_FILE',
        message: `Analysis shard ${shard.id} contains unclassified files; register an adapter or explicitly classify them before module discovery.`,
        shardId: shard.id,
        ...(shard.languageIds[0] === undefined ? {} : { languageId: shard.languageIds[0] }),
        fileIds: unclassifiedFiles.map((file) => file.id).sort(),
        missingCapabilities: [...repositoryModuleDiscoveryRequiredCapabilities]
          .filter((capability) => capability !== 'file-inventory'),
      });
    }
    if (sourceFiles.length === 0) continue;

    if (shard.status !== 'completed') {
      issues.push({
        code: 'INCOMPLETE_ANALYSIS_SHARD',
        message: `Source analysis shard ${shard.id} is ${shard.status}; module discovery requires completed evidence.`,
        shardId: shard.id,
        ...(shard.languageIds[0] === undefined ? {} : { languageId: shard.languageIds[0] }),
        fileIds: sourceFiles.map((file) => file.id).sort(),
      });
    }
    const capabilities = new Set(shard.capabilities);
    const missing = repositoryModuleDiscoveryRequiredCapabilities
      .filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      issues.push({
        code: 'MISSING_ANALYSIS_CAPABILITY',
        message: `Source analysis shard ${shard.id} lacks required module-discovery evidence: ${missing.join(', ')}.`,
        shardId: shard.id,
        ...(shard.languageIds[0] === undefined ? {} : { languageId: shard.languageIds[0] }),
        fileIds: sourceFiles.map((file) => file.id).sort(),
        missingCapabilities: missing,
      });
    }
  }

  if (analysableSourceCount === 0) {
    issues.push({
      code: 'NO_ANALYSABLE_SOURCE',
      message: 'Repository snapshot contains no source file backed by a registered analysis adapter.',
    });
  }
  if (ir.coverage.failedFileCount > 0) {
    issues.push({
      code: 'FAILED_ANALYSIS_FILE',
      message: `Repository analysis has ${ir.coverage.failedFileCount} failed file(s).`,
    });
  }

  const completed = new Set(ir.capabilities);
  return {
    ready: issues.length === 0,
    requiredCapabilities: [...repositoryModuleDiscoveryRequiredCapabilities],
    blockingIssues: issues,
    missingOptionalCapabilities: optionalCapabilities
      .filter((capability) => !completed.has(capability)),
  };
}
