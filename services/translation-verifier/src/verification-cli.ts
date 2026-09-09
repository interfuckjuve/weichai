import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  fstatSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultVerificationService } from "./create-default-verifier.js";
import { assertVerificationInput } from "./schemas/validate-verification-input.js";
import {
  type VerificationInput,
  type VerificationResult,
  type VerificationStrategyDescriptor,
  type VerificationPreparationInput,
  type VerificationPreparation,
  type VerificationRunOptions,
} from "./schemas/verification-types.js";
import { projectVerificationPreparationInput } from "./workflow/prepare-strategy-workspace.js";
import {
  assertSchema,
  validateResultSchema,
} from "./schemas/compile-schema-validators.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

interface VerificationCliService {
  listStrategies(): VerificationStrategyDescriptor[];
  verify(
    input: VerificationInput,
    options?: VerificationRunOptions,
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
  prepareTests?(
    input: VerificationPreparationInput,
    options?: VerificationRunOptions,
    signal?: AbortSignal,
  ): Promise<VerificationPreparation>;
  verifyTranslation?(
    input: VerificationInput,
    options?: VerificationRunOptions,
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
  phase: "verify" | "prepare-tests" | "verify-translation";
  preparationPath?: string;
};

type ParseResult =
  { ok: true; args: ParsedArgs } | { ok: false; message: string };

export async function runVerificationCli(
  argv: string[],
  dependencies: VerificationCliDependencies = {},
): Promise<number> {
  const stdout =
    dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr =
    dependencies.stderr ??
    ((line) => process.stderr.write(`verification-cli: ${line}\n`));
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
    const options: VerificationRunOptions = {
      strategyId: parsed.args.strategyId,
      keepWorkspace: parsed.args.keepWorkspace,
    };
    if (parsed.args.phase === "prepare-tests") {
      if (!service.prepareTests)
        throw new Error(
          "CLI prepare-tests phase is unsupported by this service.",
        );
      const input = readVerificationInput(parsed.args.inputPath, (value) =>
        projectVerificationPreparationInput(
          value as VerificationPreparationInput,
        ),
      );
      const preparation = await service.prepareTests(
        input,
        options,
        dependencies.signal,
      );
      writeJsonAtomic(parsed.args.outputPath, preparation);
      return 0;
    }
    const input = readVerificationInput(parsed.args.inputPath, (value) =>
      assertVerificationInput(value as VerificationInput),
    );
    let result: VerificationResult;
    if (parsed.args.phase === "verify-translation") {
      if (!service.verifyTranslation)
        throw new Error(
          "CLI verify-translation phase is unsupported by this service.",
        );
      if (parsed.args.preparationPath)
        options.preparation = readVerificationInput(
          parsed.args.preparationPath,
          (value) => value as VerificationPreparation,
        );
      result = await service.verifyTranslation(
        input,
        options,
        dependencies.signal,
      );
    } else {
      result = await service.verify(input, options, dependencies.signal);
    }
    assertSchema(validateResultSchema, result, "Verification result");
    writeJsonAtomic(parsed.args.outputPath, result);
    return 0;
  } catch (error) {
    stderr(errorMessage(error));
    return 1;
  }
}

function parseArgs(argv: string[]): ParseResult {
  const args: ParsedArgs = {
    listStrategies: false,
    keepWorkspace: false,
    phase: "verify",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--list-strategies") {
      args.listStrategies = true;
    } else if (flag === "--keep-workspace") {
      args.keepWorkspace = true;
    } else if (
      flag === "--input" ||
      flag === "--output" ||
      flag === "--strategy" ||
      flag === "--phase" ||
      flag === "--preparation"
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { ok: false, message: `Missing value for ${flag}.` };
      if (flag === "--input") args.inputPath = value;
      else if (flag === "--output") args.outputPath = value;
      else if (flag === "--preparation") args.preparationPath = value;
      else if (flag === "--phase") {
        if (
          value !== "verify" &&
          value !== "prepare-tests" &&
          value !== "verify-translation"
        )
          return {
            ok: false,
            message: `Unsupported verification phase: ${value}`,
          };
        args.phase = value;
      } else args.strategyId = value;
      i++;
    } else {
      return { ok: false, message: `Unknown option: ${flag}` };
    }
  }
  if (args.preparationPath && args.phase !== "verify-translation")
    return {
      ok: false,
      message: "--preparation requires --phase verify-translation.",
    };
  return { ok: true, args };
}

function readVerificationInput<T>(
  path: string,
  parse: (value: unknown) => T,
): T {
  const fd = openSync(path, "r");
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error("Verification input must be a regular file.");
    }
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let total = 0;
    while (total <= MAX_INPUT_BYTES) {
      const bytesRead = readSync(
        fd,
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_INPUT_BYTES) {
      throw new Error(
        `Verification input file exceeds ${MAX_INPUT_BYTES} bytes.`,
      );
    }
    try {
      return parse(JSON.parse(buffer.toString("utf8", 0, total)));
    } catch (error) {
      throw new Error(
        `Invalid verification input JSON: ${errorMessage(error)}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; preserve the original write/rename failure.
    }
    throw new Error(
      `Failed to write verification result: ${errorMessage(error)}`,
    );
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
