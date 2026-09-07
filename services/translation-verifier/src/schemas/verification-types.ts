import type { AdaptationRequestV2, FilePatch, RepositoryIngestionJsonValue } from "@forexplore/contracts";
import type * as Schema from "./verification-schema-types.js";

export type {
  VerificationRun, VerificationStage, VerificationStageId, VerificationStageState,
  VerificationRunEvent, AgentTaskName, VerificationRunFileReference,
  VerificationRunEventFileReference, VerificationRunDiagnostic,
  VerificationRunStrategySelection,
} from "./verification-schema-types.js";

// Runtime schemas allow upstream extension fields; public TS interfaces never had index signatures.
type DeclaredFields<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

export interface VerificationResultArtifact extends DeclaredFields<Schema.VerificationResultArtifact> {}

export type VerificationReceipt =
  Omit<DeclaredFields<Schema.VerificationReceipt>, "result" | "resultArtifact"> &
  { result: VerificationResult } &
  ({ resultArtifact: VerificationResultArtifact } | { resultArtifact?: undefined });

export interface VerificationStrategyDescriptor extends DeclaredFields<Schema.VerificationStrategyDescriptor> {}

export interface VerificationArtifact extends DeclaredFields<Schema.VerificationArtifact> {}

export interface VerificationIssue extends Omit<DeclaredFields<Schema.VerificationIssue>, "sourceObservation" | "targetObservation"> {
  sourceObservation?: RepositoryIngestionJsonValue;
  targetObservation?: RepositoryIngestionJsonValue;
}

// The verifier schema intentionally checks only upstream subsets, not full contract lineage.
export interface VerificationInput extends Omit<DeclaredFields<Schema.VerificationInput>, "request" | "analysisReport" | "migrationPlan" | "translation"> {
  request: AdaptationRequestV2;
  analysisReport: RepositoryIngestionJsonValue;
  migrationPlan: RepositoryIngestionJsonValue;
  translation: Omit<DeclaredFields<Schema.VerificationInput["translation"]>, "files"> & {
    files: FilePatch[];
  };
}

export interface VerificationResult extends
  Omit<DeclaredFields<Schema.VerificationResult>, "issues" | "artifacts" | "strategyReport">,
  Pick<VerificationStrategyOutput, "issues" | "artifacts" | "strategyReport"> {}

export interface VerificationStrategyContext {
  workspace: {
    root: string;
    sourceRoot: string;
    targetRoot: string;
    strategyRoot: string;
    evidenceRoot: string;
  };
  deadlineAt: number;
  writeArtifact: (
    artifact: VerificationArtifact,
  ) => Promise<VerificationArtifact> | VerificationArtifact;
}

export interface VerificationStrategy {
  /** Built-in strategies record their own task, execution and evaluation boundaries. */
  readonly recordsExecutionStages?: true;
  preflight?(input: VerificationInput): VerificationStrategyOutput | undefined;
  prepareWorkspace?(input: VerificationInput, context: VerificationStrategyContext): void;
  verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput>;
}

export interface VerificationStrategyProvider {
  descriptor: VerificationStrategyDescriptor;
  create(): VerificationStrategy;
}

export interface VerificationStrategyOutput extends Omit<DeclaredFields<Schema.VerificationStrategyOutput>, "issues" | "artifacts" | "strategyReport"> {
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  strategyReport: RepositoryIngestionJsonValue;
}
