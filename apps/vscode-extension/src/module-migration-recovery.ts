/** Trusted host boundary for recovering interrupted Git wave transactions. */
export interface ModuleMigrationWaveRecoveryPort {
  recoverIncompleteTransactions(repositoryRoot: string): ModuleMigrationWaveRecoveryResult[];
  /**
   * Optional publication proof used by the VS Code lifecycle host after Git
   * recovery. Concrete GitWaveTransaction implementations provide this; a
   * host without it can still roll back interrupted preparations but cannot
   * safely infer a crash-after-publication commit.
   */
  findPublishedTransactionCommit?(repositoryRoot: string, evidence: {
    transactionId: string;
    branchName: string;
    baseCommit: string;
    commit?: string;
  }): string | undefined;
}

export interface ModuleMigrationWaveRecoveryResult {
  transactionId: string;
  state: 'rolled-back';
}

/**
 * Recover durable wave journals before restoring the review session. The
 * transaction implementation only edits Git metadata and disposable
 * worktrees; application files in the caller's workspace are never touched.
 */
export function recoverIncompleteModuleTransactions(
  repositoryRoot: string,
  recovery: ModuleMigrationWaveRecoveryPort,
): ModuleMigrationWaveRecoveryResult[] {
  if (!repositoryRoot.trim()) throw new Error('模块迁移恢复需要仓库根目录。');
  return recovery.recoverIncompleteTransactions(repositoryRoot);
}
