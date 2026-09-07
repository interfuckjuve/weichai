import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationStrategyFactory } from "./verification-strategy-factory.js";
import type {
  VerificationInput,
  VerificationReceipt,
  VerificationResult,
  VerificationStrategyDescriptor,
} from "./verification-types.js";
import { runVerification } from "./run-verification.js";

export type {
  VerificationResultArtifact,
  VerificationReceipt,
} from "./verification-types.js";

export interface VerificationServiceOptions {
  factory: VerificationStrategyFactory;
  defaultStrategyId: string;
  workspaceRoot?: string;
  artifactRoot?: string;
  timeoutMs?: number;
  now?: () => string;
  runRoot?: string;
  debug?: boolean;
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
    this.#config = {
      ...options,
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
      "workspaceRoot" | "artifactRoot" | "timeoutMs" | "now"
    >
  >;
