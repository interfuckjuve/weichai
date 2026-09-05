import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultVerificationService } from "./default-verification-service.js";
import type { VerificationInput, VerificationResult, VerificationStrategyDescriptor } from "./verification-types.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

interface VerificationCliService {
  listStrategies(): VerificationStrategyDescriptor[];
  verify(
    input: VerificationInput,
    options?: { strategyId?: string; keepWorkspace?: boolean },
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
}

export interface VerificationCliDependencies {
  service?: VerificationCliService;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  signal?: AbortSignal;
}

type ParsedArgs = {
  listStrategies: boolean;
  inputPath?: string;
  outputPath?: string;
  strategyId?: string;
  keepWorkspace: boolean;
};

type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; message: string };

export async function runVerificationCli(
  argv: string[],
  dependencies: VerificationCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = dependencies.stderr ?? ((line) => process.stderr.write(`verification-cli: ${line}\n`));
  const service = dependencies.service ?? createDefaultVerificationService();
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stderr(parsed.message);
    return 1;
  }

  if (parsed.args.listStrategies) {
    for (const strategy of service.listStrategies()) {
      stdout(`${strategy.id}\t${strategy.version}\t${strategy.displayName}`);
    }
    return 0;
  }

  if (parsed.args.inputPath === undefined) {
    stderr("Missing required --input.");
    return 1;
  }
  if (parsed.args.outputPath === undefined) {
    stderr("Missing required --output.");
    return 1;
  }

  try {
    const input = readVerificationInput(parsed.args.inputPath);
    const result = await service.verify(
      input,
      { strategyId: parsed.args.strategyId, keepWorkspace: parsed.args.keepWorkspace },
      dependencies.signal,
    );
    writeJsonAtomic(parsed.args.outputPath, result);
    return 0;
  } catch (error) {
    stderr(errorMessage(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParseResult {
  const args: ParsedArgs = { listStrategies: false, keepWorkspace: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--list-strategies") {
      args.listStrategies = true;
    } else if (flag === "--keep-workspace") {
      args.keepWorkspace = true;
    } else if (flag === "--input" || flag === "--output" || flag === "--strategy") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, message: `Missing value for ${flag}.` };
      if (flag === "--input") args.inputPath = value;
      else if (flag === "--output") args.outputPath = value;
      else args.strategyId = value;
      i++;
    } else {
      return { ok: false, message: `Unknown option: ${flag}` };
    }
  }
  return { ok: true, args };
}

function readVerificationInput(path: string): VerificationInput {
  const stats = statSync(path);
  if (stats.size > MAX_INPUT_BYTES) {
    throw new Error(`Verification input file exceeds ${MAX_INPUT_BYTES} bytes.`);
  }
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as VerificationInput;
  } catch (error) {
    throw new Error(`Invalid verification input JSON: ${errorMessage(error)}`);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    throw new Error(`Failed to write verification result: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isModuleEntryPoint(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  const entryPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(entryPath);
  } catch {
    return resolve(process.argv[1]) === resolve(entryPath);
  }
}

if (isModuleEntryPoint()) {
  try {
    process.exitCode = await runVerificationCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verification-cli: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
