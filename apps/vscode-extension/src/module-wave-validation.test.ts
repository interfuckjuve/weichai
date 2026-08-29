import { describe, expect, it } from 'vitest';
import type {
  ExecutionWave,
  ModuleMigrationPlan,
  RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  CommandModuleWaveValidator,
  parseModuleWaveValidationCommands,
} from './module-wave-validation';

const input = {
  worktreeRoot: process.cwd(),
  analysis: {} as RepositoryStaticAnalysis,
  plan: {} as ModuleMigrationPlan,
  wave: { id: 'wave-1' } as ExecutionWave,
};

describe('module wave validation', () => {
  it('blocks preparation when no trusted local validation command is configured', async () => {
    const records = await new CommandModuleWaveValidator([]).validate(input);

    expect(records).toEqual([expect.objectContaining({
      id: 'vscode-wave-validation:wave-1:configuration',
      status: 'unverified',
      required: true,
    })]);
  });

  it('executes a configured command without a shell and records its evidence', async () => {
    const commands = parseModuleWaveValidationCommands([{
      id: 'node-smoke',
      label: 'Node smoke check',
      executable: 'node',
      args: ['-e', 'process.stdout.write("verified")'],
      cwd: '.',
      required: true,
      timeoutMs: 10_000,
    }]);

    const records = await new CommandModuleWaveValidator(commands).validate(input);

    expect(records).toEqual([expect.objectContaining({
      id: 'vscode-wave-validation:wave-1:node-smoke',
      status: 'pass',
      required: true,
      summary: 'verified',
    })]);
  });

  it('namespaces evidence by wave so later output cannot replace prior-wave evidence', async () => {
    const commands = parseModuleWaveValidationCommands([{
      id: 'shared-command',
      label: 'Shared command',
      executable: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
    }]);
    const validator = new CommandModuleWaveValidator(commands);

    const first = await validator.validate(input);
    const second = await validator.validate({
      ...input,
      wave: { id: 'wave-2' } as ExecutionWave,
    });

    expect(first[0]?.id).toBe('vscode-wave-validation:wave-1:shared-command');
    expect(second[0]?.id).toBe('vscode-wave-validation:wave-2:shared-command');
  });

  it('rejects unsafe executable and worktree-path configuration', async () => {
    const absoluteCommand = parseModuleWaveValidationCommands([{
      id: 'absolute',
      label: 'Absolute',
      executable: process.execPath,
    }]);
    await expect(new CommandModuleWaveValidator(absoluteCommand).validate(input))
      .rejects.toThrow('模块波次验证命令不能使用绝对路径');

    const command = parseModuleWaveValidationCommands([{
      id: 'outside',
      label: 'Outside worktree',
      executable: '../outside',
    }]);
    await expect(new CommandModuleWaveValidator(command).validate(input))
      .rejects.toThrow('超出隔离 worktree');
  });
});
