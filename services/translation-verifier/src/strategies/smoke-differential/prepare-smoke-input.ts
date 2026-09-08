import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import {
  failureAssessment,
  resolveVerificationPolicy,
} from "../../schemas/verification-assessment.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
  VerificationStrategyOutput,
} from "../../schemas/verification-types.js";
import type { VerifierLanguage } from "./differential-test-types.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

export type SmokePreflight =
  | { applicable: true; job: SmokeTaskInput }
  | { applicable: false; output: VerificationStrategyOutput };

const languages: ReadonlyMap<string, VerifierLanguage> = new Map([
  ["java", "Java"],
  ["csharp", "C#"],
  ["python", "Python"],
  ["typescript", "TypeScript"],
]);

export function prepareSmokeInput(
  input: VerificationInput,
  context: VerificationStrategyContext,
): SmokePreflight {
  const policy = resolveVerificationPolicy(input);
  if (!policy.testBasis?.trim()) {
    const summary = "Independent Host-confirmed test basis is missing.";
    return {
      applicable: false,
      output: {
        ...failureAssessment(input, "insufficient_test_basis", summary),
        summary,
        issues: [],
        artifacts: [],
        strategyReport: null,
      },
    };
  }
  const sourceLanguageId =
    input.request.route?.sourceLanguageId ??
    input.request.candidate.entity.languageId;
  const targetLanguageId =
    input.request.route?.targetLanguageId ??
    input.request.target.entity.languageId;
  const sourceLanguage = languages.get(sourceLanguageId);
  const targetLanguage = languages.get(targetLanguageId);
  if (
    (policy.mode === "differential" && sourceLanguage === undefined) ||
    targetLanguage === undefined
  ) {
    return {
      applicable: false,
      output: {
        ...failureAssessment(
          input,
          "unsupported_language",
          `Unsupported language route: ${sourceLanguageId} -> ${targetLanguageId}`,
        ),
        summary: `Unsupported differential smoke language route: ${sourceLanguageId} -> ${targetLanguageId}`,
        issues: [
          {
            id: "unsupported-language-route",
            kind: "unsupported-language",
            message: `differential-smoke@2.0.0 does not support ${sourceLanguageId} -> ${targetLanguageId}`,
            evidenceArtifactIds: [],
          },
        ],
        artifacts: [],
        strategyReport: {
          unsupportedLanguages: { sourceLanguageId, targetLanguageId },
        },
      },
    };
  }
  const reason = insufficientContextReason(
    input,
    policy.mode === "differential",
  );
  if (reason !== undefined) {
    return {
      applicable: false,
      output: {
        ...failureAssessment(input, "context_incomplete", reason.message),
        summary:
          "Differential smoke verification requires additional migration context.",
        issues: [
          {
            id: "insufficient-context",
            kind: "insufficient-context",
            message: reason.message,
            evidenceArtifactIds: [],
          },
        ],
        artifacts: [],
        strategyReport: { preflight: reason.details },
      },
    };
  }
  const entity = input.request.target.entity;
  const declaration =
    input.request.targetContext.declarations.find(
      (fact) => fact.entityId === entity.entityId || fact.path === entity.path,
    ) ?? input.request.targetContext.declarations[0];
  return {
    applicable: true,
    job: {
      verificationPolicy: input.verificationPolicy,
      requirement: input.request.requirement,
      analysisReport:
        policy.mode === "differential"
          ? JSON.stringify(input.analysisReport)
          : undefined,
      source:
        policy.mode === "differential"
          ? {
              language: sourceLanguage!,
              root: context.workspace.sourceRoot,
              candidatePath:
                input.request.candidate.entity.path ??
                input.request.sourceBundle.files[0]?.path,
            }
          : { language: targetLanguage },
      target: {
        language: targetLanguage,
        className:
          stringAttribute(declaration?.attributes, "containerName") ??
          entity.qualifiedName ??
          entity.name,
        method: entity.name,
        isStatic:
          booleanAttribute(declaration?.attributes, "isStatic") ?? false,
        root: context.workspace.targetRoot,
        file: entity.path,
      },
    },
  };
}

function insufficientContextReason(
  input: VerificationInput,
  differential: boolean,
): { message: string; details: RepositoryIngestionJsonValue } | undefined {
  const unresolvedFields = [
    ["analysisReport", input.analysisReport],
    ["migrationPlan", input.migrationPlan],
  ].flatMap(([field, value]) =>
    isNonEmptyStringArray(recordValue(value, "unresolved")) ? [field] : [],
  );
  const sourceDependencies = differential
    ? (input.request.sourceBundle.dependencyIds ?? [])
    : [];
  const targetDependencies = input.request.targetContext.dependencies ?? [];
  const missingBuildFacts =
    (sourceDependencies.length > 0 || targetDependencies.length > 0) &&
    (input.request.targetContext.buildFacts?.length ?? 0) === 0;
  if (unresolvedFields.length === 0 && !missingBuildFacts) return undefined;
  const reasons: RepositoryIngestionJsonValue[] = [];
  if (unresolvedFields.length > 0)
    reasons.push({ code: "unresolved", fields: unresolvedFields });
  if (missingBuildFacts)
    reasons.push({
      code: "dependencies-without-build-facts",
      sourceDependencyCount: sourceDependencies.length,
      targetDependencyCount: targetDependencies.length,
    });
  return {
    message: "Required migration context is unresolved or incomplete.",
    details: { status: "insufficient-context", reasons },
  };
}

function recordValue(
  value: RepositoryIngestionJsonValue,
  key: string,
): RepositoryIngestionJsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, RepositoryIngestionJsonValue>)[key]
    : undefined;
}
function isNonEmptyStringArray(
  value: RepositoryIngestionJsonValue | undefined,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  );
}
function stringAttribute(
  attributes: Record<string, RepositoryIngestionJsonValue> | undefined,
  name: string,
): string | undefined {
  const value = attributes?.[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
function booleanAttribute(
  attributes: Record<string, RepositoryIngestionJsonValue> | undefined,
  name: string,
): boolean | undefined {
  const value = attributes?.[name];
  return typeof value === "boolean" ? value : undefined;
}
