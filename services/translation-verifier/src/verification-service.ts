import { createHash } from "node:crypto";
import { canonicalJson } from "@forexplore/workflow-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationStrategyFactory } from "./verification-strategy-factory.js";
import { VerificationArtifactPersistenceError, createVerificationWorkspace } from "./verification-workspace.js";
import {
  assertVerificationInput,
  assertVerificationReceipt,
  assertVerificationResult,
  createVerificationResult,
  type VerificationInput,
  type VerificationResult,
  type VerificationStrategyDescriptor,
} from "./verification-types.js";

export interface VerificationResultArtifact {
  id: string;
  kind: "verification-result";
  path: string;
  contentHash: string;
  size: number;
  mediaType: "application/json";
}

export type VerificationReceipt =
  | { result: VerificationResult; resultArtifact: VerificationResultArtifact }
  | { result: VerificationResult; resultArtifact?: undefined };


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
    return (await this.verifyWithReceipt(input, options, signal)).result;
  }

  async verifyWithReceipt(
    input: VerificationInput,
    options: { strategyId?: string; keepWorkspace?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<VerificationReceipt> {
    assertVerificationInput(input);
    const strategyId = options.strategyId ?? this.#defaultStrategyId;
    const descriptor = this.#descriptor(strategyId);

    let workspace: ReturnType<typeof createVerificationWorkspace> | undefined;
    try {
      const strategy = this.#factory.create(strategyId);
      workspace = createVerificationWorkspace(input, {
        workspaceRoot: this.#workspaceRoot,
        artifactRoot: this.#artifactRoot,
        keepWorkspace: options.keepWorkspace,
      });
      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const combinedSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      workspace.context.deadlineAt = Date.now() + this.#timeoutMs;
      let result: VerificationResult;
      if (signal?.aborted && !isAbortError(signal.reason)) {
        result = this.#unverified(input, descriptor, signal.reason, [], false);
      } else {
        if (signal?.aborted) throw signal.reason ?? new Error("Caller aborted verification");
        try {
          result = await waitForStrategy(strategy.verify(input, workspace.context, combinedSignal), combinedSignal);
          assertVerificationResult(result, input, descriptor);
          assertArtifactsMatch(result.artifacts, workspace.writtenArtifacts());
        } catch (error) {
          if (signal?.aborted && error === signal.reason && isAbortError(error)) throw error;
          const artifactFailure = error instanceof VerificationArtifactPersistenceError;
          result = this.#unverified(input, descriptor, error, artifactFailure ? [] : workspace.writtenArtifacts(), artifactFailure);
        }
      }
      const receiptBytes = Buffer.from(canonicalJson(result), "utf8");
      try {
        const resultArtifact = workspace.writeFrameworkResult(receiptBytes);
        return assertVerificationReceipt({ result, resultArtifact }, input, descriptor);
      } catch (error) {
        if (!(error instanceof VerificationArtifactPersistenceError)) throw error;
        // The canonical failed result is returned without a second persistence attempt.
        const failedResult = this.#unverified(input, descriptor, error, [], true);
        return assertVerificationReceipt({ result: failedResult }, input, descriptor);
      }
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
    artifactFailure = false,
  ): VerificationResult {
    const message = errorMessage(error);
    const timeout = isNamedError(error, "TimeoutError");
    const persistence = artifactFailure || error instanceof VerificationArtifactPersistenceError;

    return createVerificationResult(input, descriptor, {
      status: "unverified",
      summary: `Verification framework could not complete: ${message}`,
      issues: [{
        id: persistence ? "artifact-persistence-failed" : timeout ? "strategy-timeout" : "framework-error",
        kind: persistence ? "artifact-persistence-failed" : timeout ? "strategy-timeout" : "framework-error",
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

function waitForStrategy<T>(strategyPromise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReasonOf(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReasonOf(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    strategyPromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function assertArtifactsMatch(resultArtifacts: VerificationResult["artifacts"], writtenArtifacts: VerificationResult["artifacts"]): void {
  if (resultArtifacts.length !== writtenArtifacts.length) {
    throw new Error("Verification result artifacts must match artifacts written through the workspace.");
  }
  const writtenById = new Map<string, VerificationResult["artifacts"][number]>();
  for (const artifact of writtenArtifacts) {
    if (writtenById.has(artifact.id)) throw new Error("Verification workspace artifact IDs must be unique.");
    writtenById.set(artifact.id, artifact);
  }
  for (const artifact of resultArtifacts) {
    const written = writtenById.get(artifact.id);
    if (
      written === undefined ||
      written.kind !== artifact.kind ||
      written.path !== artifact.path ||
      written.contentHash !== artifact.contentHash ||
      written.mediaType !== artifact.mediaType
    ) {
      throw new Error("Verification result artifacts must match artifacts written through the workspace.");
    }
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
  if (isNamedError(error, "TimeoutError")) return "Verification strategy timed out";
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unknown verification error";
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}
