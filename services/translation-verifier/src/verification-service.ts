import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationStrategyFactory } from "./verification-strategy-factory.js";
import { createVerificationWorkspace } from "./verification-workspace.js";
import {
  assertVerificationInput,
  assertVerificationResult,
  createVerificationResult,
  type VerificationInput,
  type VerificationResult,
  type VerificationStrategyDescriptor,
} from "./verification-types.js";

export interface VerificationServiceOptions {
  factory: VerificationStrategyFactory;
  defaultStrategyId: string;
  workspaceRoot?: string;
  artifactRoot?: string;
  timeoutMs?: number;
  now?: () => string;
}

export class VerificationService {
  readonly #factory: VerificationStrategyFactory;
  readonly #defaultStrategyId: string;
  readonly #workspaceRoot: string;
  readonly #artifactRoot: string;
  readonly #timeoutMs: number;
  readonly #now: () => string;

  constructor(options: VerificationServiceOptions) {
    this.#factory = options.factory;
    this.#defaultStrategyId = options.defaultStrategyId;
    this.#workspaceRoot = options.workspaceRoot ?? join(tmpdir(), "forexplore-verification-workspaces");
    this.#artifactRoot = options.artifactRoot ?? join(tmpdir(), "forexplore-verification-artifacts");
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Verification timeout must be a positive number of milliseconds.");
    }
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async verify(
    input: VerificationInput,
    options: { strategyId?: string; keepWorkspace?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    assertVerificationInput(input);
    const strategyId = options.strategyId ?? this.#defaultStrategyId;
    const descriptor = this.#descriptor(strategyId);
    const strategy = this.#factory.create(strategyId);
    signal?.throwIfAborted();

    let workspace: ReturnType<typeof createVerificationWorkspace> | undefined;
    try {
      workspace = createVerificationWorkspace(input, {
        workspaceRoot: this.#workspaceRoot,
        artifactRoot: this.#artifactRoot,
        keepWorkspace: options.keepWorkspace,
      });
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      workspace.context.deadlineAt = Date.now() + this.#timeoutMs;
      const result = await strategy.verify(input, workspace.context, combinedSignal);
      return assertVerificationResult(result, input, descriptor);
    } catch (error) {
      if (signal?.aborted && isAbortError(error)) throw error;
      return this.#unverified(input, descriptor, error, workspace?.writtenArtifacts() ?? []);
    } finally {
      workspace?.cleanup();
    }
  }

  listStrategies(): VerificationStrategyDescriptor[] {
    return this.#factory.list();
  }

  #descriptor(strategyId: string): VerificationStrategyDescriptor {
    const descriptor = this.#factory.list().find((item) => item.id === strategyId);
    if (descriptor === undefined) {
      this.#factory.create(strategyId);
      throw new Error(`Unknown verification strategy: ${strategyId}`);
    }
    return descriptor;
  }

  #unverified(
    input: VerificationInput,
    descriptor: VerificationStrategyDescriptor,
    error: unknown,
    artifacts: VerificationResult["artifacts"],
  ): VerificationResult {
    const message = errorMessage(error);
    return createVerificationResult(input, descriptor, {
      status: "unverified",
      summary: `Verification framework could not complete: ${message}`,
      issues: [{
        id: "framework-error",
        kind: "framework-error",
        message,
        evidenceArtifactIds: [],
      }],
      artifacts,
      strategyReport: {
        frameworkError: message,
        errorName: errorName(error),
      },
    }, this.#now);
  }
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error, "AbortError");
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "Error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown verification error";
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
