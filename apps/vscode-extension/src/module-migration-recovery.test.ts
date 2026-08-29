import { describe, expect, it, vi } from 'vitest';
import { recoverIncompleteModuleTransactions } from './module-migration-recovery';

describe('module migration recovery boundary', () => {
  it('delegates recovery to the trusted Git transaction service', () => {
    const recovered = [{ transactionId: 'wave-interrupted', state: 'rolled-back' as const }];
    const recoverIncompleteTransactions = vi.fn(() => recovered);

    expect(
      recoverIncompleteModuleTransactions(
        'C:/workspace/project',
        { recoverIncompleteTransactions },
      ),
    ).toEqual(recovered);
    expect(recoverIncompleteTransactions).toHaveBeenCalledWith('C:/workspace/project');
  });

  it('rejects an empty workspace path before invoking recovery', () => {
    const recoverIncompleteTransactions = vi.fn(() => []);

    expect(() => recoverIncompleteModuleTransactions('  ', { recoverIncompleteTransactions }))
      .toThrow('模块迁移恢复需要仓库根目录');
    expect(recoverIncompleteTransactions).not.toHaveBeenCalled();
  });
});
