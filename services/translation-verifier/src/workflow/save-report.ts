import { canonicalJson } from "@forexplore/workflow-core";
import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { assertVerificationReceipt } from "../schemas/validate-verification-receipt.js";
import type { VerificationInput, VerificationReceipt, VerificationResult, VerificationStrategyDescriptor } from "../schemas/verification-types.js";
import type { VerificationArtifactStore } from "../run-output/verification-artifact-store.js";

export function saveReport(
  result: VerificationResult,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  store: Pick<VerificationArtifactStore, "writeFrameworkResult">,
): VerificationReceipt {
  markVerificationPhase("receipt-serialization");
  const receiptBytes = Buffer.from(canonicalJson(result), "utf8");
  markVerificationPhase("receipt-persistence-and-validation");
  const resultArtifact = store.writeFrameworkResult(receiptBytes);
  return assertVerificationReceipt(
    { result, resultArtifact },
    input,
    descriptor,
  );
}
