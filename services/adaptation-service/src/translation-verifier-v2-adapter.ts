import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import { DIFFERENTIAL_SMOKE_STRATEGY, type VerificationReceipt, type VerificationResult, type VerificationService, type VerificationStrategyDescriptor } from "@forexplore/translation-verifier";
import type { MigrationBehaviorVerificationInputV2, MigrationBehaviorVerifierV2 } from "./adaptation-adapter-v2";

export class TranslationVerifierV2Adapter implements MigrationBehaviorVerifierV2 {
  readonly providerId = "forexplore.translation-verifier.differential";
  readonly providerVersion = "1.0.0";
  readonly strategyDescriptor: VerificationStrategyDescriptor = Object.freeze({ ...DIFFERENTIAL_SMOKE_STRATEGY });
  constructor(private readonly service: Pick<VerificationService, "verifyWithReceipt">) {}
  verifyWithReceipt(input: MigrationBehaviorVerificationInputV2, signal?: AbortSignal): Promise<VerificationReceipt> {
    const request = { schemaVersion: "1.0" as const, request: input.request, analysisReport: input.analysis as unknown as RepositoryIngestionJsonValue, migrationPlan: input.plan as unknown as RepositoryIngestionJsonValue, translation: { round: input.round, generatedContent: input.translation.generatedContent, files: input.files, patchHash: input.patchHash } };
    return this.service.verifyWithReceipt(request, {}, signal);
  }
  verify(input: MigrationBehaviorVerificationInputV2, signal?: AbortSignal): Promise<VerificationResult> {
    return this.verifyWithReceipt(input, signal).then((receipt) => receipt.result);
  }
}
