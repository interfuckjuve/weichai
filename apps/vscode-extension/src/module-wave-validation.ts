import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  ExecutionWave,
  ModuleMigrationPlan,
  RepositoryStaticAnalysis,
  ValidationRecord,
} from '@forexplore/contracts';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 10 * 60 * 1_000;
const maxTimeoutMs = 30 * 60 * 1_000;
const outputLimit = 4_000;

/**
 * A locally administered validation command. This configuration is trusted
 * extension configuration, never content supplied by a patch bundle/webview.
 */
export interface ModuleWaveValidationCommand {
  id: string;
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  required: boolean;
  timeoutMs: number;
}

export interface ModuleWaveValidationInput {
  worktreeRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  wave: ExecutionWave;
}

export interface ModuleWaveValidator {
  validate(input: ModuleWaveValidationInput): Promise<ValidationRecord[]>;
}

/** Run explicit trusted commands against the coordinator's disposable worktree. */
export class CommandModuleWaveValidator implements ModuleWaveValidator {
  constructor(private readonly commands: readonly ModuleWaveValidationCommand[]) {}

  async validate(input: ModuleWaveValidationInput): Promise<ValidationRecord[]> {
    if (this.commands.length === 0) {
      return [{
        id: validationRecordId(input.wave.id, 'configuration'),
        label: '波次联合验证配置',
        status: 'unverified',
        required: true,
        command: 'forexplore.moduleWaveValidationCommands',
        summary: '没有配置可信的本地波次联合验证命令。',
        failureReason: 'missing-local-wave-validation-commands',
      }];
    }
    const ids = new Set<string>();
    const records: ValidationRecord[] = [];
    for (const command of this.commands) {
      if (ids.has(command.id)) {
        throw new Error(`模块波次验证命令 ID 重复：${command.id}`);
      }
      ids.add(command.id);
      records.push(await runCommand(input.worktreeRoot, input.wave.id, command));
    }
    return records;
  }
}

export function parseModuleWaveValidationCommands(value: unknown): ModuleWaveValidationCommand[] {
  if (!Array.isArray(value)) {
    throw new Error('forexplore.moduleWaveValidationCommands 必须是数组。');
  }
  if (value.length > 32) {
    throw new Error('forexplore.moduleWaveValidationCommands 不能超过 32 条。');
  }
  return value.map((entry, index) => parseCommand(entry, index));
}

async function runCommand(
  worktreeRoot: string,
  waveId: string,
  command: ModuleWaveValidationCommand,
): Promise<ValidationRecord> {
  const cwd = resolveInsideWorktree(worktreeRoot, command.cwd);
  const executable = resolveExecutable(worktreeRoot, command.executable);
  const display = [command.executable, ...command.args].map(quoteForDisplay).join(' ');
  try {
    const result = await execFileAsync(executable, command.args, {
      cwd,
      windowsHide: true,
      shell: false,
      timeout: command.timeoutMs,
      maxBuffer: 2 * 1024 * 1_024,
    });
    return {
      id: validationRecordId(waveId, command.id),
      label: command.label,
      status: 'pass',
      required: command.required,
      command: display,
      summary: outputSummary(result.stdout, result.stderr, '命令成功完成。'),
    };
  } catch (error) {
    const detail = commandFailureSummary(error);
    return {
      id: validationRecordId(waveId, command.id),
      label: command.label,
      status: 'fail',
      required: command.required,
      command: display,
      summary: detail,
      failureReason: 'local-wave-validation-command-failed',
    };
  }
}

function validationRecordId(waveId: string, commandId: string): string {
  return `vscode-wave-validation:${waveId}:${commandId}`;
}

function parseCommand(value: unknown, index: number): ModuleWaveValidationCommand {
  if (!isRecord(value)) {
    throw new Error(`forexplore.moduleWaveValidationCommands[${index}] 必须是对象。`);
  }
  const unsupported = Object.keys(value).filter((key) => ![
    'id',
    'label',
    'executable',
    'args',
    'cwd',
    'required',
    'timeoutMs',
  ].includes(key));
  if (unsupported.length > 0) {
    throw new Error(`forexplore.moduleWaveValidationCommands[${index}] 包含不支持的字段：${unsupported.sort().join('、')}。`);
  }
  const id = requiredText(value.id, `forexplore.moduleWaveValidationCommands[${index}].id`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new Error(`forexplore.moduleWaveValidationCommands[${index}].id 无效。`);
  }
  const label = requiredText(value.label, `forexplore.moduleWaveValidationCommands[${index}].label`, 512);
  const executable = requiredText(
    value.executable,
    `forexplore.moduleWaveValidationCommands[${index}].executable`,
    1_024,
  );
  const args = value.args === undefined
    ? []
    : parseStringArray(value.args, `forexplore.moduleWaveValidationCommands[${index}].args`, 128, 8_192);
  const cwd = value.cwd === undefined
    ? '.'
    : requiredText(value.cwd, `forexplore.moduleWaveValidationCommands[${index}].cwd`, 4_096);
  const required = value.required === undefined
    ? true
    : requiredBoolean(value.required, `forexplore.moduleWaveValidationCommands[${index}].required`);
  const timeoutMs = value.timeoutMs === undefined
    ? defaultTimeoutMs
    : positiveTimeout(value.timeoutMs, `forexplore.moduleWaveValidationCommands[${index}].timeoutMs`);
  return { id, label, executable, args, cwd, required, timeoutMs };
}

function resolveInsideWorktree(worktreeRoot: string, relativePath: string): string {
  if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error('模块波次验证工作目录必须是相对路径。');
  }
  const root = path.resolve(worktreeRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('模块波次验证工作目录超出隔离 worktree。');
  }
  return target;
}

function resolveExecutable(worktreeRoot: string, executable: string): string {
  if (executable.includes('\0') || path.isAbsolute(executable)) {
    throw new Error('模块波次验证命令不能使用绝对路径。');
  }
  if (!executable.includes('/') && !executable.includes('\\')) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executable)) {
      throw new Error('模块波次验证命令名称无效。');
    }
    return executable;
  }
  if (executable.includes('\\')) {
    throw new Error('模块波次验证相对命令必须使用正斜杠。');
  }
  return resolveInsideWorktree(worktreeRoot, executable);
}

function outputSummary(stdout: string | Buffer, stderr: string | Buffer, fallback: string): string {
  const output = `${stdout}${stderr}`.trim();
  return output.length === 0 ? fallback : bounded(output);
}

function commandFailureSummary(error: unknown): string {
  if (error instanceof Error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const output = outputSummary(candidate.stdout ?? '', candidate.stderr ?? '', candidate.message);
    return bounded(output);
  }
  return bounded(String(error));
}

function quoteForDisplay(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function bounded(value: string): string {
  return value.length <= outputLimit ? value : `${value.slice(0, outputLimit)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value;
}

function parseStringArray(
  value: unknown,
  field: string,
  maxEntries: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxEntries || value.some((item) => typeof item !== 'string' || item.length > maxLength || item.includes('\0'))) {
    throw new Error(`${field} 必须是受限字符串数组。`);
  }
  return [...value];
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值。`);
  return value;
}

function positiveTimeout(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000 || value > maxTimeoutMs) {
    throw new Error(`${field} 必须在 1000 和 ${maxTimeoutMs} 之间。`);
  }
  return value;
}
