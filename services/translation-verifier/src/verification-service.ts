import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationStrategyFactory } from "./workflow/strategy-registry.js";
import type {
  VerificationRunOptions,
  VerificationInput,
  VerificationReceipt,
  VerificationResult,
  VerificationStrategyDescriptor,
  VerificationPreparationInput,
  VerificationPreparation,
} from "./schemas/verification-types.js";
import { runVerification } from "./workflow/run-verification.js";
import { waitForStrategy } from "./workflow/run-strategy.js";
import {
  assertPreparedArtifactStorage,
  createVerificationPreparationWorkspace,
  projectVerificationPreparationInput,
  type VerificationWorkspaceHandle,
} from "./workflow/prepare-strategy-workspace.js";
import { assertJsonCompatible } from "./schemas/validate-json-paths.js";
import {
  assertRememberedPreparation,
  rememberPreparation,
} from "./run-output/verification-preparation-store.js";
import { VerificationArtifactPersistenceError } from "./run-output/verification-artifact-store.js";

export type {
  VerificationResultArtifact,
  VerificationReceipt,
} from "./schemas/verification-types.js";

export interface VerificationServiceOptions {
  factory: VerificationStrategyFactory;
  defaultStrategyId: string;
  workspaceRoot?: string;
  artifactRoot?: string;
  timeoutMs?: number;
  /** Maximum wait after interruption for strategy-owned work to stop; unconfirmed workspaces are preserved. */
  shutdownTimeoutMs?: number;
  now?: () => string;
  /** Reserved, currently ignored; no production diagnostic run-root is implemented. */
  runRoot?: string;
  /** Reserved, currently ignored; use VERIFIER_LOG_CONTENT for opt-in content logging. */
  debug?: boolean;
  /** Reserved, currently not called; retained for source compatibility. */
  onRunRecorded?: (location: { runId: string; runDirectory?: string }) => void;
}

export class VerificationService {
  readonly #config: VerificationServiceConfiguration;

  constructor(options: VerificationServiceOptions) {
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        "Verification timeout must be a positive number of milliseconds.",
      );
    }
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(shutdownTimeoutMs) ||
      shutdownTimeoutMs <= 0 ||
      shutdownTimeoutMs > 2_147_483_647
    ) {
      throw new Error(
        "Verification shutdown timeout must be a positive 32-bit integer of milliseconds.",
      );
    }
    this.#config = {
      ...options,
      shutdownTimeoutMs,
      workspaceRoot:
        options.workspaceRoot ??
        join(tmpdir(), "forexplore-verification-workspaces"),
      artifactRoot:
        options.artifactRoot ??
        join(tmpdir(), "forexplore-verification-artifacts"),
      timeoutMs,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async verify(
    input: VerificationInput,
    options: VerificationRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    return (await this.verifyWithReceipt(input, options, signal)).result;
  }

  async verifyWithReceipt(
    input: VerificationInput,
    options: VerificationRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VerificationReceipt> {
    const provider = this.#config.factory.resolve(
      options.strategyId ?? this.#config.defaultStrategyId,
    );
    if (provider.lifecycle === "two-phase")
      throw new Error(
        `Strategy ${provider.descriptor.id} requires explicit prepareTests and verifyTranslation lifecycle entries; verify is unsupported.`,
      );
    return runVerification(this.#config, input, options, signal);
  }

  async verifyTranslation(
    input: VerificationInput,
    options: VerificationRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    return (await this.verifyTranslationWithReceipt(input, options, signal))
      .result;
  }

  async verifyTranslationWithReceipt(
    input: VerificationInput,
    options: VerificationRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VerificationReceipt> {
    const provider = this.#config.factory.resolve(
      options.strategyId ?? this.#config.defaultStrategyId,
    );
    if (provider.lifecycle !== "two-phase")
      throw new Error(
        `Strategy ${provider.descriptor.id} uses the single-phase verify lifecycle; verifyTranslation is unsupported.`,
      );
    if (options.preparation)
      assertRememberedPreparation(
        this.#config.artifactRoot,
        options.preparation,
      );
    return runVerification(this.#config, input, options, signal);
  }

  async prepareTests(
    input: VerificationPreparationInput,
    options: Omit<VerificationRunOptions, "preparation"> = {},
    signal?: AbortSignal,
  ): Promise<VerificationPreparation> {
    const provider = this.#config.factory.resolve(
      options.strategyId ?? this.#config.defaultStrategyId,
    );
    if (provider.lifecycle !== "two-phase")
      throw new Error(
        `Strategy ${provider.descriptor.id} uses the single-phase verify lifecycle; prepareTests is unsupported.`,
      );
    const projected = projectVerificationPreparationInput(input);
    const timeoutSignal = AbortSignal.timeout(this.#config.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const deadlineAt = Date.now() + this.#config.timeoutMs;
    let workspace: VerificationWorkspaceHandle | undefined;
    let discardArtifacts = false;
    let shutdownConfirmed = true;
    let writesClosed = false;
    try {
      combinedSignal.throwIfAborted();
      assertPreparedArtifactStorage(
        options.preparedProjects,
        this.#config.artifactRoot,
      );
      workspace = createVerificationPreparationWorkspace(projected, {
        workspaceRoot: this.#config.workspaceRoot,
        artifactRoot: this.#config.artifactRoot,
        keepWorkspace: options.keepWorkspace,
        preparedProjects: options.preparedProjects,
        requirements: provider.workspaceRequirements?.(projected, "prepare-tests"),
      });
      workspace.context.deadlineAt = deadlineAt;
      const writeArtifact = workspace.context.writeArtifact;
      workspace.context.writeArtifact = (artifact) => {
        if (writesClosed) throw new Error("Verification workspace is closed.");
        return writeArtifact(artifact);
      };
      combinedSignal.throwIfAborted();
      const strategy = provider.create();
      combinedSignal.throwIfAborted();
      const settled = await waitForStrategy(
        strategy.prepareTests(projected, workspace.context, combinedSignal),
        combinedSignal,
        this.#config.shutdownTimeoutMs,
      );
      if (!settled.confirmed) {
        shutdownConfirmed = false;
        throw new Error(
          `Preparation shutdown unconfirmed after ${this.#config.shutdownTimeoutMs}ms; cleanup skipped. Workspace preserved at ${workspace.context.workspace.root}; existing artifacts preserved under ${this.#config.artifactRoot}.`,
          { cause: combinedSignal.reason },
        );
      }
      combinedSignal.throwIfAborted();
      const preparation = settled.value;
      assertJsonCompatible(preparation, "Verification preparation");
      if (
        !preparation ||
        preparation.schemaVersion !== "1.0" ||
        preparation.strategyId !== provider.descriptor.id ||
        preparation.strategyVersion !== provider.descriptor.version ||
        typeof preparation.inputHash !== "string" ||
        typeof preparation.contentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(preparation.inputHash) ||
        !/^[0-9a-f]{64}$/.test(preparation.contentHash) ||
        !("payload" in preparation)
      )
        throw new Error(
          "Verification preparation capsule is invalid or belongs to another strategy.",
        );
      await rememberPreparation(
        this.#config.artifactRoot,
        preparation,
        workspace.context,
      );
      return preparation;
    } catch (cause) {
      discardArtifacts = cause instanceof VerificationArtifactPersistenceError;
      throw cause;
    } finally {
      writesClosed = true;
      if (shutdownConfirmed) workspace?.cleanup({ discardArtifacts });
    }
  }

  listStrategies(): VerificationStrategyDescriptor[] {
    return this.#config.factory.list();
  }
}

export type VerificationServiceConfiguration = VerificationServiceOptions &
  Required<
    Pick<
      VerificationServiceOptions,
      | "workspaceRoot"
      | "artifactRoot"
      | "timeoutMs"
      | "shutdownTimeoutMs"
      | "now"
    >
  >;
