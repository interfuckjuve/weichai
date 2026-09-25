import type { AnalysisReport, FilePatch } from "@forexplore/contracts";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type VerificationFunction = {
  /** Project-relative file path containing the function. */
  path: string;
  name: string;
  signature?: string;
};

export type VerificationSubject = {
  sourceFunction: VerificationFunction;
  targetFunction: VerificationFunction;
  requirement: string;
};

export type Translation = {
  round: number;
  generatedContent?: string;
  files: FilePatch[];
};

export type VerificationInput = {
  schemaVersion: "2.0";
  sourceLanguage: string;
  targetLanguage: string;
  /** Absolute path to the project containing the source code being translated. */
  sourceProjectPath: string;
  /** Absolute path to the project receiving the translated code. */
  targetProjectPath: string;
  subject: VerificationSubject;
  analysisReport: AnalysisReport;
  migrationPlan: JsonValue;
  translation: Translation;
};

export type VerificationIssueKind =
  | "translation"
  | "test"
  | "environment"
  | "unknown";

export type VerificationIssue = {
  kind: VerificationIssueKind;
  description: string;
};

export type VerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
};

export type VerificationPhase = "prepare" | "verify";

export type StrategyHandler<Result = unknown> = (
  input: VerificationInput,
) => Result | Promise<Result>;

export type VerificationStrategy<Result = unknown> = Partial<
  Record<VerificationPhase, StrategyHandler<Result>>
>;
