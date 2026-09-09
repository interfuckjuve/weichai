import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationStrategyFactory } from "./workflow/strategy-registry.js";
import type {
  VerificationRunOptions,
  VerificationInput,
  VerificationReceipt,
  VerificationResult,
  VerificationStrategyDescriptor,
} from "./schemas/verification-types.js";
import { runVerification } from "./workflow/run-verification.js";

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
    return runVerification(this.#config, input, options, signal);
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
