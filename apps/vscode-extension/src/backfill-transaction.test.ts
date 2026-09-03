import { describe, expect, it } from 'vitest';
import { interruptedRecoveryDecision } from './backfill-transaction';

describe('interrupted multi-file backfill recovery', () => {
  it('marks a prepared transaction rolled back when every file is still before', () => {
    expect(interruptedRecoveryDecision(['before', 'before'])).toBe('mark-rolled-back');
  });

  it('restores the whole transaction when a crash left only the second file applied', () => {
    expect(interruptedRecoveryDecision(['before', 'after'])).toBe('restore');
  });

  it('blocks instead of overwriting a file with an unrecognized post-crash hash', () => {
    expect(() => interruptedRecoveryDecision(['after', 'unknown'])).toThrow(/manual recovery/);
  });
});
