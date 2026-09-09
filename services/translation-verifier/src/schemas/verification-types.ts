import type {
  AdaptationRequestV2,
  FilePatch,
  RepositoryIngestionJsonValue,
} from "@forexplore/contracts";
import type * as Schema from "./verification-schema-types.js";

export type {
  VerificationRun,
  VerificationStage,
  VerificationStageId,
  VerificationStageState,
  VerificationRunEvent,
  AgentTaskName,
  VerificationRunFileReference,
  VerificationRunEventFileReference,
  VerificationRunDiagnostic,
  VerificationRunStrategySelection,
} from "./verification-schema-types.js";

// Runtime schemas allow upstream extension fields; public TS interfaces never had index signatures.
type DeclaredFields<T> = {
  [
    K in keyof T as string extends K ? never : number extends K ? never : K
  ]: T[K];
};

export type VerificationPolicy = DeclaredFields<
  NonNullable<Schema.VerificationInput["verificationPolicy"]>
>;
export type VerificationProblem = DeclaredFields<Schema.VerificationProblem>;
export type VerificationAssessment = Pick<
  Schema.VerificationStrategyOutput,
  | "mode"
  | "referenceDecision"
  | "referenceReason"
  | "executionStatus"
  | "sourceAssessment"
  | "targetAssessment"
  | "problems"
>;

export interface VerificationResultArtifact extends DeclaredFields<Schema.VerificationResultArtifact> {}

export type VerificationReceipt = Omit<
  DeclaredFields<Schema.VerificationReceipt>,
  "result" | "resultArtifact"
> & { result: VerificationResult } & (
    | { resultArtifact: VerificationResultArtifact }
    | { resultArtifact?: undefined }
  );

export interface VerificationStrategyDescriptor extends DeclaredFields<Schema.VerificationStrategyDescriptor> {}

export interface VerificationArtifact extends DeclaredFields<Schema.VerificationArtifact> {}

export interface VerificationIssue extends Omit<
  DeclaredFields<Schema.VerificationIssue>,
  "sourceObservation" | "targetObservation"
> {
  sourceObservation?: RepositoryIngestionJsonValue;
  targetObservation?: RepositoryIngestionJsonValue;
}

// The verifier schema intentionally checks only upstream subsets, not full contract lineage.
export interface VerificationInput extends Omit<
  DeclaredFields<Schema.VerificationInput>,
  "request" | "analysisReport" | "migrationPlan" | "translation"
> {
  request: AdaptationRequestV2;
  analysisReport: RepositoryIngestionJsonValue;
  migrationPlan: RepositoryIngestionJsonValue;
  translation: Omit<
    DeclaredFields<Schema.VerificationInput["translation"]>,
    "files"
  > & {
    files: FilePatch[];
  };
}

/** Status-free output 2.0; workflow gate decisions belong to downstream consumers. */
export interface VerificationResult
  extends
    Omit<
      DeclaredFields<Schema.VerificationResult>,
      "issues" | "artifacts" | "strategyReport"
    >,
    Pick<
      VerificationStrategyOutput,
      "issues" | "artifacts" | "strategyReport"
    > {}

export interface VerificationPreparedProjects {
  /** Explicitly authorized copies. Caller owns cleanup and retains them between lifecycle phases. */
  sourceRoot?: string;
  targetRoot: string;
}

export interface VerificationRunOptions {
  strategyId?: string;
  keepWorkspace?: boolean;
  preparedProjects?: VerificationPreparedProjects;
  preparation?: VerificationPreparation;
}

export type VerificationPreparationInput = Pick<
  VerificationInput,
  "request" | "analysisReport" | "migrationPlan"
>;

export interface VerificationPreparation {
  schemaVersion: "1.0";
  strategyId: string;
  strategyVersion: string;
  inputHash: string;
  contentHash: string;
  payload: RepositoryIngestionJsonValue;
}

export interface VerificationStrategyContext {
  workspace: {
    /** Cleanup ownership of project roots only; root/evidence remain framework-owned. */
    projectOwnership?: "framework" | "caller";
    root: string;
    sourceRoot: string;
    targetRoot: string;
    strategyRoot: string;
    evidenceRoot: string;
  };
  /** Optional Host timing only; executes work once and preserves its value/error. */
  measureStep?<T>(name: string, work: () => T | Promise<T>): Promise<T>;
  deadlineAt: number;
  writeArtifact: (
    artifact: VerificationArtifact,
  ) => Promise<VerificationArtifact> | VerificationArtifact;
}

export interface VerificationStrategy {
  verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput>;
}

export interface TwoPhaseVerificationStrategy {
  prepareTests(
    input: VerificationPreparationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationPreparation>;
  verifyTranslation(
    input: VerificationInput,
    context: VerificationStrategyContext,
    preparation?: VerificationPreparation,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput>;
}

export interface VerificationWorkspaceRequirements {
  /** Resource availability for analysis, not authorization to trust source behavior. */
  source: boolean;
}

export type VerificationStrategyProvider = {
  descriptor: VerificationStrategyDescriptor;
} & (
  | {
      lifecycle?: "single-phase";
      /** Pure declaration evaluated before workspace preparation; must not create an Agent. */
      workspaceRequirements?(
        input: VerificationInput,
      ): VerificationWorkspaceRequirements;
      create(): VerificationStrategy;
    }
  | {
      lifecycle: "two-phase";
      workspaceRequirements?(
        input: VerificationPreparationInput,
        phase: "prepare-tests" | "verify-translation",
      ): VerificationWorkspaceRequirements;
      create(): TwoPhaseVerificationStrategy;
    }
);

export interface VerificationStrategyOutput extends Omit<
  DeclaredFields<Schema.VerificationStrategyOutput>,
  "issues" | "artifacts" | "strategyReport"
> {
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  strategyReport: RepositoryIngestionJsonValue;
}
