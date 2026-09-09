/**
 * CodeAdaptationPort orchestration:
 * collect context -> analyze -> translate -> compile/repair -> patch preview.
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
  type ContextCollectorOptions,
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
  translatorRequest?: typeof globalThis.fetch;
  validator?: AdaptationValidator;
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
  #translatorOptions: TranslatorModelOptions;
  #validator: AdaptationValidator;

  constructor(options: AdaptationAdapterOptions) {
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
    this.#analyzer = options.analyzer ?? new AnalyzerAgent({ apiKey: options.apiKey });
    this.#contextCollector = options.contextCollector ?? collectTargetContext;
    this.#translatorOptions = options.translatorRequest
      ? { apiKey: options.apiKey, request: options.translatorRequest }
      : { apiKey: options.apiKey };
    this.#validator = options.validator ?? defaultValidator;
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
    while (!repairResult.success) {
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
        )
      : null;

    return {
      strategy: request.strategy,
      targetLanguage: request.target.language,
      generatedCode,
      interfaceMappings: [],
      modificationPlan: [],
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
): FilePatch {
  // A blind all-add patch is unsafe: callers must preserve an exact source
  // precondition and regenerate after the target changed.
  if (!originalContent || targetLine == null) {
    throw new Error("Cannot build a safe patch without target file content and line information.");
  }

  // 定点 patch：用括号匹配找到原方法体范围
  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  let startIdx = Math.max(0, targetLine - 1);
  let startsTarget = targetKind === "class"
    ? isClassStart(originalLines[startIdx] ?? "", language)
    : isMethodStart(originalLines[startIdx] ?? "");
  if (!startsTarget) {
    // Indexers may report a leading annotation or documentation line for a
    // symbol. Resolve only contiguous declaration-prefix trivia; a real code
    // line stops the search so an incorrect method line cannot drift away.
    const searchLimit = Math.min(originalLines.length, startIdx + 33);
    for (let candidate = startIdx + 1; candidate < searchLimit; candidate += 1) {
      const matchesTarget = targetKind === "class"
        ? isClassStart(originalLines[candidate] ?? "", language)
        : isMethodStart(originalLines[candidate] ?? "");
      if (matchesTarget) {
        startIdx = candidate;
        startsTarget = true;
        break;
      }
      if (!isDeclarationPrefixTrivia(originalLines[candidate] ?? "")) break;
    }
  }
  if (startIdx >= originalLines.length || !startsTarget) {
    throw new Error(
      targetKind === "class"
        ? "The target line must point at a class declaration before a safe patch can be built."
        : "The target line must point at a method declaration before a safe patch can be built.",
    );
  }

  // 找到方法体的闭合大括号
  const endIdx = language === "Python"
    ? findPythonMethodEnd(originalLines, startIdx)
    : findMethodEnd(originalLines, startIdx, language);
  const removedLines = originalLines.slice(startIdx, endIdx + 1);
  if (removedLines.length === 0) {
    throw new Error("Cannot build a patch because the selected target method is empty.");
  }

  // Model output is normalized to column zero for validation. Reapply the
  // source declaration indentation so nested members stay syntactically nested.
  const declarationIndent = originalLines[startIdx]?.match(/^\s*/)?.[0] ?? "";
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

function isMethodStart(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^(if|for|foreach|while|switch|catch|using|return|new|throw)\b/.test(trimmed)) {
    return false;
  }
  return /\b[A-Za-z_][\w]*\s*(?:<[^>]+>)?\s*\(/.test(trimmed);
}

function isClassStart(line: string, language: Language): boolean {
  const trimmed = line.trim();
  if (language === "Python") return /^class\s+[A-Za-z_]\w*/.test(trimmed);
  if (language === "Go") return /^type\s+[A-Za-z_]\w*\s+struct\b/.test(trimmed);
  return /^\s*(?:(?:public|private|protected|internal|abstract|sealed|final|static|export|partial|pub)\s+)*(?:class|record|struct|interface)\b/.test(trimmed);
}

function isDeclarationPrefixTrivia(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed === "*/" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("[")
  );
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Finds the closing brace for a Java/C#/TypeScript/Go/Rust declaration.
 *
 * This intentionally is not a substitute for a compiler AST. It is the
 * fail-closed fallback used before making a destructive patch: braces in
 * comments and string literals must never influence the selected range, and
 * an incomplete declaration must reject the patch rather than consume the
 * remainder of the file.
 */
function findMethodEnd(lines: string[], startIdx: number, language: Language): number {
  let depth = 0;
  let started = false;
  let state: LexicalState = "code";
  let rawQuoteCount = 0;
  const declarationIndentation = lines[startIdx]?.match(/^\s*/)?.[0].length ?? 0;

  for (let lineIndex = startIdx; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const lineIndentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (
      started &&
      depth === 1 &&
      state === "code" &&
      lineIndex > startIdx &&
      isLikelySiblingDeclaration(line, declarationIndentation, language)
    ) {
      throw new Error(
        "Cannot build a safe patch because a sibling declaration appears before the target declaration closes.",
      );
    }
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const character = line[charIndex] ?? "";
      const next = line[charIndex + 1] ?? "";

      if (state === "block-comment") {
        if (character === "*" && next === "/") {
          state = "code";
          charIndex += 1;
        }
        continue;
      }

      if (state === "single-quoted") {
        if (character === "\\") {
          charIndex += 1;
        } else if (character === "'") {
          state = "code";
        }
        continue;
      }

      if (state === "double-quoted" || state === "backtick") {
        const terminator = state === "double-quoted" ? '"' : "`";
        if (character === "\\") {
          charIndex += 1;
        } else if (character === terminator) {
          state = "code";
        }
        continue;
      }

      if (state === "verbatim-csharp") {
        if (character === '"' && next === '"') {
          charIndex += 1;
        } else if (character === '"') {
          state = "code";
        }
        continue;
      }

      if (state === "raw-quoted") {
        if (character === '"') {
          const quoteCount = countRepeatedCharacter(line, charIndex, '"');
          if (quoteCount >= rawQuoteCount) {
            charIndex += rawQuoteCount - 1;
            state = "code";
            rawQuoteCount = 0;
          } else {
            charIndex += quoteCount - 1;
          }
        }
        continue;
      }

      // code state
      if (character === "/" && next === "/") {
        break;
      }
      if (character === "/" && next === "*") {
        state = "block-comment";
        charIndex += 1;
        continue;
      }
      if (character === "'") {
        state = "single-quoted";
        continue;
      }
      if (character === "`") {
        state = "backtick";
        continue;
      }
      if (character === "@" && next === '"' && language === "C#") {
        state = "verbatim-csharp";
        charIndex += 1;
        continue;
      }
      if (
        character === "@" &&
        next === "$" &&
        line[charIndex + 2] === '"' &&
        language === "C#"
      ) {
        state = "verbatim-csharp";
        charIndex += 2;
        continue;
      }
      if (
        character === "$" &&
        next === "@" &&
        line[charIndex + 2] === '"' &&
        language === "C#"
      ) {
        state = "verbatim-csharp";
        charIndex += 2;
        continue;
      }
      if (character === '"') {
        const quoteCount = countRepeatedCharacter(line, charIndex, '"');
        if (quoteCount >= 3) {
          state = "raw-quoted";
          rawQuoteCount = quoteCount;
          charIndex += quoteCount - 1;
        } else {
          state = "double-quoted";
        }
        continue;
      }
      if (character === "{") {
        depth += 1;
        started = true;
      } else if (character === "}") {
        if (!started || depth <= 0) {
          throw new Error("Cannot build a safe patch because the target declaration has unbalanced braces.");
        }
        if (depth === 1 && lineIndentation < declarationIndentation) {
          throw new Error(
            "Cannot build a safe patch because the closing brace is outside the target declaration indentation.",
          );
        }
        depth -= 1;
        if (depth === 0) return lineIndex;
      }
    }
  }

  throw new Error("Cannot build a safe patch because the target declaration has no matching closing brace.");
}

type LexicalState =
  | "code"
  | "block-comment"
  | "single-quoted"
  | "double-quoted"
  | "backtick"
  | "verbatim-csharp"
  | "raw-quoted";

function countRepeatedCharacter(value: string, startIndex: number, character: string): number {
  let index = startIndex;
  while (value[index] === character) index += 1;
  return index - startIndex;
}

function isLikelySiblingDeclaration(
  line: string,
  declarationIndentation: number,
  language: Language,
): boolean {
  const indentation = line.match(/^\s*/)?.[0].length ?? 0;
  if (indentation > declarationIndentation) return false;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return false;
  if (isMethodStart(line) || isClassStart(line, language)) return true;
  if (/^(if|for|foreach|while|switch|catch|using|return|throw|new|else|do|try|finally)\b/.test(trimmed)) {
    return false;
  }
  // Covers fields/properties at the same declaration nesting level. This is
  // intentionally conservative: refusing an ambiguous patch is safer than
  // silently deleting a sibling member.
  return /^(?:(?:public|private|protected|internal|static|readonly|final|const|volatile|abstract|virtual|override|sealed|async|partial|export|pub)\s+)*(?:[A-Za-z_][\w<>,.?\[\]]*\s+)+[A-Za-z_][\w]*(?:\s*[=;{])/.test(trimmed);
}

function findPythonMethodEnd(lines: string[], startIdx: number): number {
  const baseIndent = lines[startIdx]?.match(/^\s*/)?.[0].length ?? 0;
  for (let index = startIdx + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (indentation <= baseIndent) return index - 1;
  }
  return lines.length - 1;
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
