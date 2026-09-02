/**
 * CodeAdaptationPort orchestration:
 * collect context -> analyze -> translate -> compile -> verify/repair -> patch preview.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  Language,
  TargetModuleContext,
  ValidationRecord,
} from "@forexplore/contracts";
import { analysisSchemaVersion } from "@forexplore/contracts";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import { AnalyzerAgent } from "./analyzer";
import {
  collectTargetContext,
  createDefaultTargetEngineeringAdapterRegistry,
  locateTargetPatch,
  TargetEngineeringUnsupportedError,
  type ContextCollectorOptions,
  type TargetEngineeringAdapterRegistry,
} from "./context-collector";
import {
  projectTargetContext,
  repairTranslation,
  translateWithAnalysis,
  type AnalyzeTranslationRequest,
  type TranslatorModelOptions,
} from "./translator";
import {
  compileTargetIntegrated,
  compileTargetStandalone,
  compilerCommand,
  isCompilerUnavailable,
  resolveProjectTargetFile,
  type CompileResult,
} from "./compiler";
import type {
  AdaptationVerifier,
  DifferentialVerificationResult,
} from "./verification-adapter";
import { TranslationVerifierAdapter } from "./verification-adapter";

const MAX_RETRIES = 3;
const STANDALONE_CLASS_NAME = "ForeXploreStandalone";

export interface AdaptationAdapterOptions {
  /** DeepSeek API key used by the specialized translation agents */
  apiKey: string;
  /** Target skeleton project root (optional; enables integrated compilation). */
  skeletonProjectPath?: string;
  /** 目标项目根目录（可选，有则生成定点 context patch 而非全量替换） */
  projectRoot?: string;
  analyzer?: AdaptationAnalyzer;
  contextCollector?: AdaptationContextCollector;
  /** Language-owned target context and patch-location capabilities. */
  targetEngineeringRegistry?: TargetEngineeringAdapterRegistry;
  translatorRequest?: typeof globalThis.fetch;
  validator?: AdaptationValidator;
  /** Optional override; the default verifier is fail-closed and never runs candidate code on-host. */
  verifier?: AdaptationVerifier;
}

export interface AdaptationAnalyzer {
  analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisReport>;
}

export type AdaptationContextCollector = (
  options: ContextCollectorOptions,
) => TargetModuleContext;

export interface AdaptationValidator {
  compileStandalone(language: Language, code: string, targetName: string): CompileResult;
  compileIntegrated(
    language: Language,
    code: string,
    skeletonProjectPath: string,
    targetFilePath: string,
  ): CompileResult;
  isUnavailable(result: CompileResult): boolean;
}

const defaultValidator: AdaptationValidator = {
  compileStandalone: compileTargetStandalone,
  compileIntegrated: compileTargetIntegrated,
  isUnavailable: isCompilerUnavailable,
};

export class AdaptationAdapter implements CodeAdaptationPort {
  #skeletonProjectPath?: string;
  #projectRoot?: string;
  #analyzer: AdaptationAnalyzer;
  #contextCollector: AdaptationContextCollector;
  #targetEngineeringRegistry: TargetEngineeringAdapterRegistry;
  #translatorOptions: TranslatorModelOptions;
  #validator: AdaptationValidator;
  #verifier?: AdaptationVerifier;

  constructor(options: AdaptationAdapterOptions) {
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
    this.#analyzer = options.analyzer ?? new AnalyzerAgent({ apiKey: options.apiKey });
    this.#targetEngineeringRegistry =
      options.targetEngineeringRegistry ?? createDefaultTargetEngineeringAdapterRegistry();
    this.#contextCollector = options.contextCollector ?? ((request) => collectTargetContext({
      ...request,
      adapterRegistry: this.#targetEngineeringRegistry,
    }));
    this.#translatorOptions = options.translatorRequest
      ? { apiKey: options.apiKey, request: options.translatorRequest }
      : { apiKey: options.apiKey };
    this.#validator = options.validator ?? defaultValidator;
    this.#verifier = options.verifier ?? new TranslationVerifierAdapter({ apiKey: options.apiKey });
  }

  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    assertSupportedTranslation(request);
    const projectRoot = this.#projectRoot ?? this.#skeletonProjectPath;
    if (!projectRoot) {
      throw new Error(
        "AdaptationAdapter requires projectRoot or skeletonProjectPath to collect target context.",
      );
    }
    const requirement = effectiveRequirement(request);
    const collectedContext = this.#contextCollector({
      projectRoot,
      target: request.target,
      signal,
    });
    const analysisReport = await this.#analyzer.analyze(
      {
        schemaVersion: analysisSchemaVersion,
        targetContext: collectedContext,
        candidate: request.candidate,
        requirement,
        immutableConstraints: collectedContext.constraints,
        decisionNotes: request.decisionNotes,
      },
      signal,
    );
    const referenceFree = analysisReport.applicability.level === "reject";
    const translationReport = referenceFree
      ? referenceFreeAnalysisReport(analysisReport)
      : analysisReport;

    const translationInput: AnalyzeTranslationRequest = {
      candidateSource: referenceFree ? "" : request.candidate.preview,
      targetContext: projectTargetContext(collectedContext),
      requirement,
      analysisReport: translationReport,
      referencePolicy: referenceFree ? "target-only" : "candidate",
    };
    let translationResult = await translateWithAnalysis(
      translationInput,
      this.#translatorOptions,
      signal,
    );
    let generatedCode = translationResult.generatedCode;

    let standaloneResult = this.#validator.compileStandalone(
      request.target.language,
      generatedCode,
      STANDALONE_CLASS_NAME,
    );
    let integratedResult = this.#skeletonProjectPath
      ? this.#validator.compileIntegrated(
          request.target.language,
          generatedCode,
          this.#skeletonProjectPath,
          request.target.path,
        )
      : null;
    let retries = 0;
    let repairResult = integratedResult ?? standaloneResult;
    let differentialResult: DifferentialVerificationResult | undefined;

    while (true) {
      if (!repairResult.success) {
        if (this.#validator.isUnavailable(repairResult) || retries >= MAX_RETRIES) break;
        translationResult = await repairTranslation(
          {
            ...translationInput,
            previousResult: translationResult,
            validationFeedback: compilerFeedback(repairResult.errors),
          },
          this.#translatorOptions,
          signal,
        );
        generatedCode = translationResult.generatedCode;
        standaloneResult = this.#validator.compileStandalone(
          request.target.language,
          generatedCode,
          STANDALONE_CLASS_NAME,
        );
        integratedResult = this.#skeletonProjectPath
          ? this.#validator.compileIntegrated(
              request.target.language,
              generatedCode,
              this.#skeletonProjectPath,
              request.target.path,
            )
          : null;
        repairResult = integratedResult ?? standaloneResult;
        retries++;
        continue;
      }

      if (!this.#verifier) break;
      try {
        differentialResult = await this.#verifier.verify(
          { request, targetContext: collectedContext, generatedCode, projectRoot },
          signal,
        );
      } catch (error: unknown) {
        differentialResult = {
          status: "unverified",
          summary: `差分验证未执行：${error instanceof Error ? error.message : String(error)}`,
          modificationPlan: [],
          reason: "verifier-error",
        };
      }
      if (differentialResult.status !== "fail" || retries >= MAX_RETRIES) break;

      translationResult = await repairTranslation(
        {
          ...translationInput,
          previousResult: translationResult,
          validationFeedback: differentialFeedback(differentialResult),
        },
        this.#translatorOptions,
        signal,
      );
      generatedCode = translationResult.generatedCode;
      standaloneResult = this.#validator.compileStandalone(
        request.target.language,
        generatedCode,
        STANDALONE_CLASS_NAME,
      );
      integratedResult = this.#skeletonProjectPath
        ? this.#validator.compileIntegrated(
            request.target.language,
            generatedCode,
            this.#skeletonProjectPath,
            request.target.path,
          )
        : null;
      repairResult = integratedResult ?? standaloneResult;
      retries++;
    }

    const targetSnapshot = readOriginalIfAvailable(
      projectRoot,
      request.target.path,
    );
    const canBuildPatch = targetSnapshot.content !== null && request.target.line != null;
    const patch = canBuildPatch
      ? buildFilePatch(
          request.target.path,
          generatedCode,
          targetSnapshot.content,
          request.target.line,
          request.target.language,
          request.target.kind,
          this.#targetEngineeringRegistry,
          request.target.name,
        )
      : null;

    return {
      strategy: request.strategy,
      targetLanguage: request.target.language,
      generatedCode,
      interfaceMappings: [],
      modificationPlan: differentialResult?.modificationPlan ?? [],
      validation: [
        ...(referenceFree
          ? [{
              id: "reference-candidate",
              label: "Reference candidate",
              status: "warn" as const,
              required: false,
              summary:
                "Analyzer rejected the selected candidate. The Translator generated from the target context and requirement without using that candidate; review is required before write-back.",
              failureReason: "candidate-rejected-reference-free-generation",
            }]
          : []),
        {
          id: "analyzer",
          label: referenceFree ? "Analyzer (reference-free fallback)" : "Analyzer",
          status: referenceFree ? "warn" : "pass",
          required: !referenceFree,
          summary: referenceFree
            ? `Analyzer rejected the selected candidate (${Math.round(
                analysisReport.applicability.confidence * 100,
              )}%). Generation continued without that reference.`
            : `${analysisReport.applicability.level} (${Math.round(
                analysisReport.applicability.confidence * 100,
              )}%)`,
        },
        targetStandaloneCompileValidation(
          request.target.language,
          standaloneResult,
          integratedResult,
          this.#validator.isUnavailable(standaloneResult),
        ),
        integratedResult
          ? targetCompileValidation(
              request.target.language,
              "integrated-compile",
              `${request.target.language} target project compilation`,
              integratedResult,
              true,
              this.#validator.isUnavailable(integratedResult),
            )
          : {
              id: "integrated-compile",
              label: `${request.target.language} target project compilation`,
              status: "unverified",
              required: false,
              summary: "No target skeleton project was configured, so integrated compilation was not run.",
              failureReason: "skeleton-project-not-configured",
            },
        ...(differentialResult ? [differentialValidation(differentialResult)] : []),
        {
          id: "target-context-snapshot",
          label: "Target file snapshot",
          status: canBuildPatch ? "pass" : "unverified",
          required: true,
          summary: canBuildPatch
            ? "Read the target file and generated a patch guarded by its original hash."
            : targetSnapshot.reason ?? "The target file could not be read, so no protected patch was generated.",
          failureReason: canBuildPatch ? undefined : "target-context-unavailable",
        },
        {
          id: "behavioral-semantics",
          label: "Behavioral validation",
          status: "unverified",
          required: false,
          summary: "Compilation validates syntax only; behavioral semantics still require target-project tests.",
        },
      ],
      files: patch ? [patch] : [],
    };
  }
}

// ---- helpers ----

function effectiveRequirement(request: AdaptationRequest): string {
  return (
    request.requirement.trim() ||
    request.target.documentation?.trim() ||
    `Implement the target contract: ${request.target.signature}`
  );
}

function referenceFreeAnalysisReport(report: AnalysisReport): AnalysisReport {
  return {
    ...report,
    applicability: {
      level: "reference",
      confidence: 0,
      reasons: [
        "No selected candidate was accepted as a usable reference; generate from the target context and requirement.",
        ...report.applicability.reasons,
      ],
    },
    behaviorMapping: [],
    contractMapping: [],
    implementationPlan: [
      "Implement the requirement using the existing target contract and collected target context without a reference candidate.",
    ],
    risks: [
      ...report.risks,
      "No reference candidate was used; developer review is required before write-back.",
    ],
    assumptions: [
      ...report.assumptions,
      "The Translator must derive behavior from the functional requirement and target context alone.",
    ],
  };
}

function compilerFeedback(errors: string[]): {
  status: "fail";
  issues: Array<{ category: "syntax"; message: string }>;
} {
  return {
    status: "fail",
    issues: (errors.length > 0 ? errors : ["Compiler failed without diagnostics."]).map(
      (message) => ({ category: "syntax" as const, message }),
    ),
  };
}

function differentialFeedback(result: DifferentialVerificationResult): {
  status: "fail";
  issues: Array<{ category: "behavior"; message: string }>;
} {
  const plan = result.modificationPlan.length > 0
    ? result.modificationPlan
    : [result.summary];
  return {
    status: "fail",
    issues: plan.map((message) => ({ category: "behavior" as const, message })),
  };
}

function differentialValidation(result: DifferentialVerificationResult): ValidationRecord {
  return {
    id: "differential-verification",
    label: "Differential behavioral verification",
    status: result.status === "pass" ? "pass" : result.status === "fail" ? "fail" : "unverified",
    required: true,
    summary: result.summary,
    failureReason: result.status === "pass" ? undefined : result.reason,
  };
}

function assertSupportedTranslation(request: AdaptationRequest): void {
  if (request.strategy !== "translate") {
    throw new Error(
      `AdaptationAdapter only supports the "translate" strategy; received "${request.strategy}".`,
    );
  }
  if (!isSafeRelativePath(request.target.path)) {
    throw new Error(
      `Target path must be a non-escaping project-relative path; received "${request.target.path}".`,
    );
  }
}

function readOriginalIfAvailable(
  projectRoot: string | undefined,
  filePath: string,
): { content: string | null; reason?: string } {
  if (!projectRoot) {
    return { content: null, reason: "未配置目标工程根目录，无法建立回填前置快照。" };
  }
  if (!existsSync(projectRoot)) {
    return { content: null, reason: "配置的目标工程根目录不存在。" };
  }
  const root = realpathSync(resolve(projectRoot));
  const resolvedTarget = resolveProjectTargetFile(root, filePath);
  if (!resolvedTarget) {
    const fullPath = resolve(root, filePath);
    if (!isInsideRoot(root, fullPath)) {
      return { content: null, reason: "目标文件路径超出配置的目标工程根目录。" };
    }
    return { content: null, reason: "目标文件不存在，无法生成受保护的定点补丁。" };
  }
  const realFile = realpathSync(resolvedTarget.sourcePath);
  if (!isInsideRoot(root, realFile)) {
    return { content: null, reason: "目标文件经符号链接解析后超出配置的目标工程根目录。" };
  }
  return { content: readFileSync(realFile, "utf-8") };
}

function buildFilePatch(
  filePath: string,
  newCode: string,
  originalContent: string | null,
  targetLine?: number,
  language: Language = "Java",
  targetKind: "class" | "function" = "function",
  targetEngineeringRegistry: TargetEngineeringAdapterRegistry =
    createDefaultTargetEngineeringAdapterRegistry(),
  targetName?: string,
): FilePatch {
  // A blind all-add patch is unsafe: callers must preserve an exact source
  // precondition and regenerate after the target changed.
  if (!originalContent || targetLine == null) {
    throw new Error("Cannot build a safe patch without target file content and line information.");
  }

  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const location = locateTargetPatch(
    language,
    {
      source: originalContent,
      targetLine,
      targetKind,
      ...(targetName ? { targetName } : {}),
    },
    targetEngineeringRegistry,
  );
  if (location.status === "unsupported") {
    throw new TargetEngineeringUnsupportedError(location.reason);
  }
  const { startLine: startIdx, endLine: endIdx } = location.value;
  const removedLines = originalLines.slice(startIdx, endIdx + 1);
  if (removedLines.length === 0) {
    throw new Error("Cannot build a patch because the selected target method is empty.");
  }

  // Model output is normalized to column zero for validation. Reapply the
  // source declaration indentation so nested members stay syntactically nested.
  const declarationIndent = location.value.declarationIndentation;
  const newLines = indentGeneratedCode(newCode, declarationIndent).split("\n");

  // 用原方法签名作为 context 行来定位
  const contextBefore = startIdx > 0 ? originalLines[startIdx - 1] : null;
  const contextAfter =
    endIdx < originalLines.length - 1 ? originalLines[endIdx + 1] : null;

  const hunkLines: FilePatch["hunks"][number]["lines"] = [];

  // 前置 context：方法体前一行（通常是类声明或空行）
  if (contextBefore) {
    hunkLines.push({ type: "context", content: contextBefore });
  }

  // 原方法所有行标记为 remove
  for (const line of removedLines) {
    hunkLines.push({ type: "remove", content: line });
  }

  // 新方法所有行标记为 add
  for (const line of newLines) {
    hunkLines.push({ type: "add", content: line });
  }

  // 后置 context：方法体后一行
  if (contextAfter) {
    hunkLines.push({ type: "context", content: contextAfter });
  }

  return {
    path: filePath,
    status: "modified",
    expectedOriginalSha256: sha256(originalContent),
    additions: newLines.length,
    deletions: removedLines.length,
    hunks: [{ header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`, lines: hunkLines }],
  };
}

function compileValidation(
  id: string,
  label: string,
  result: CompileResult,
  required: boolean,
  unavailable: boolean,
  command = "dotnet build --nologo -v q",
): ValidationRecord {
  return {
    id,
    label,
    status: unavailable ? "unverified" : result.success ? "pass" : "fail",
    required,
    command,
    summary: result.success
      ? "编译通过。编译通过不证明业务行为正确。"
      : result.errors.slice(0, 3).join("; "),
    failureReason: result.success ? undefined : unavailable ? "compiler-unavailable" : "compiler-failed",
  };
}

function targetCompileValidation(
  language: Language,
  id: string,
  label: string,
  result: CompileResult,
  required: boolean,
  unavailable: boolean,
): ValidationRecord {
  return compileValidation(id, label, result, required, unavailable, compilerCommand(language));
}

function targetStandaloneCompileValidation(
  language: Language,
  result: CompileResult,
  integratedResult: CompileResult | null,
  unavailable: boolean,
): ValidationRecord {
  const record = targetCompileValidation(
    language,
    "standalone-compile",
    `${language} standalone compilation`,
    result,
    integratedResult === null,
    unavailable,
  );

  if (integratedResult?.success && !result.success) {
    return {
      ...record,
      status: "warn",
      required: false,
      summary:
        `The standalone wrapper lacks project types or dependencies: ${result.errors.slice(0, 3).join("; ")}` +
        " The target project compilation is the authoritative compilation evidence.",
      failureReason: undefined,
    };
  }

  return record;
}

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || isAbsolute(filePath)) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function indentGeneratedCode(code: string, indentation: string): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  // Normalize away only indentation already applied to the declaration. Any
  // additional indentation remains the generated unit's relative structure.
  const generatedBaseIndent = lines[0]?.match(/^\s*/)?.[0].length ?? 0;
  return lines
    .map((line, index) => {
      if (!line.trim()) return "";
      if (index === 0) return `${indentation}${line.trimStart()}`;
      const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
      return `${indentation}${line.slice(Math.min(currentIndent, generatedBaseIndent))}`.trimEnd();
    })
    .join("\n");
}

/** @internal 暴露给测试 */
export { buildFilePatch as _buildFilePatch };
