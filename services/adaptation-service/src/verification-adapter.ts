import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AdaptationRequest,
  AnalysisReport,
  Language,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import {
  createTestStrategy,
  executeSide,
  generateDriverSource,
  generateSourceDriverSource,
  RealDriverExecutor,
  TestMigratorAgent,
  validateAgainstExpected,
  verify,
  type CaseComparison,
  type SideFile,
  type SideSpec,
  type SourceInvocation,
  type SmokeReport,
  type TestDescription,
  type TestStrategyJob,
  type TestStrategyReport,
  type VerificationReport,
  type VerifierLanguage,
} from "@forexplore/translation-verifier";
import { compilerInternals } from "./compiler";

export interface DifferentialVerificationInput {
  request: AdaptationRequest;
  targetContext: TargetModuleContext;
  generatedCode: string;
  projectRoot: string;
  /** Analyzer 报告(供测试描述生成参考;需求/行为映射/实现计划)。 */
  analysisReport?: AnalysisReport;
  /** 复制的源语言项目根目录(候选 direct/adapt 时由适配服务复制;保留供调试)。 */
  sourceProjectRoot?: string;
  /** 集成编译保留的目标项目副本根目录(含替换后的目标文件)。 */
  targetProjectRoot?: string;
}

export interface DifferentialVerificationResult {
  status: "pass" | "fail" | "unverified";
  /** 差分模式:VerificationReport;冒烟模式:SmokeReport。 */
  report?: VerificationReport | SmokeReport;
  summary: string;
  modificationPlan: string[];
  reason?: string;
}

export interface AdaptationVerifier {
  verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult>;
}

interface VerificationPlan {
  description: TestDescription;
  /** 差分模式:源侧 SideSpec;target-only 模式不构建。 */
  source?: SideSpec;
  buildTarget: (generatedCode: string) => SideSpec;
}

interface ClassEntryPoint {
  name: string;
  entryKind: "method" | "constructor";
  isStatic: boolean;
}

/** Runs the verifier only after the adaptation compiler has accepted the code. */
export class TranslationVerifierAdapter implements AdaptationVerifier {
  readonly #apiKey: string;
  readonly #timeoutMs?: number;

  constructor(options: { apiKey: string; timeoutMs?: number }) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
  }

  async verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult> {
    const differential = useDifferential(input);
    const unsupported = unsupportedReason(input.request, input.targetContext, differential);
    if (unsupported) return unverified(unsupported);
    signal?.throwIfAborted();

    if (differential) {
      // 差分轨道:smoke 自主会话(claude 直接编写双侧 runner,机械差分 + LLM 语义裁决 + 修复)。
      try {
        return await this.#runSmoke(input, signal);
      } catch (error: unknown) {
        return unverified(`冒烟验证未执行：${errorMessage(error)}`);
      }
    }

    // target-only 轨道:Analyzer 判定 reject/reference(无源侧参考),
    // 测试 agent 基于需求 + 报告 + 目标翻译产物编写描述,目标侧黄金校验。
    let plan: VerificationPlan;
    try {
      plan = await this.#buildTargetOnlyPlan(input, signal);
    } catch (error: unknown) {
      return unverified(`无法建立验证输入：${errorMessage(error)}`);
    }
    const report = await verifyTargetOnly(
      { description: plan.description, target: plan.buildTarget(input.generatedCode) },
      new RealDriverExecutor({ timeoutMs: this.#timeoutMs }),
    );
    return reportResult(report, "目标侧黄金校验");
  }

  /**
   * 差分模式的 smoke 自主会话:claude 在工作目录内写双侧 runner、编译运行、
   * 机械差分、语义裁决、必要时修复目标,最终写 report.json(SmokeReport)。
   * 工作区保留(keepGeneratedTests=true)供调试。
   */
  async #runSmoke(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult> {
    const sourceLanguage = asVerifierLanguage(input.request.candidate.language);
    const targetLanguage = asVerifierTargetLanguage(input.request.target.language);
    if (!sourceLanguage || !targetLanguage) {
      throw new Error("smoke 差分验证需要可执行的源/目标语言。");
    }
    const targetClassName = qualifiedTargetClassName(input.targetContext);
    const classEntry = input.request.target.kind === "class"
      ? selectClassEntryPoint(input.targetContext, targetClassName)
      : undefined;
    const targetMethod = classEntry?.name ?? input.request.target.name;
    const targetIsStatic = classEntry?.isStatic ?? hasStaticModifier(
      input.targetContext.source.method,
      input.request.target.signature,
    );
    const job: TestStrategyJob = {
      requirement: input.request.requirement,
      source: {
        language: sourceLanguage,
        ...(input.sourceProjectRoot
          ? { root: input.sourceProjectRoot }
          : { files: [{ relativePath: input.request.candidate.path, content: input.request.candidate.preview }] }),
      },
      target: {
        language: targetLanguage,
        className: targetClassName,
        method: targetMethod,
        isStatic: targetIsStatic,
        ...(input.targetProjectRoot ? { root: input.targetProjectRoot, file: input.request.target.path } : { file: input.request.target.path }),
      },
      analysisReport: input.analysisReport
        ? JSON.stringify(input.analysisReport)
        : undefined,
    };
    const timeoutMs = this.#timeoutMs ?? 300_000;
    const runner = createTestStrategy("smoke", {
      llm: { apiKey: this.#apiKey, timeoutMs },
      keepGeneratedTests: true,
      maxTurns: 60,
      timeoutMs,
    });
    const result = await runner.run(job, signal);
    return smokeResult(result);
  }

  async #buildTargetOnlyPlan(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<VerificationPlan> {
    const targetLanguage = asVerifierTargetLanguage(input.request.target.language);
    if (!targetLanguage) {
      throw new Error("当前 verifier 目标侧仅支持 Java/C#。");
    }

    const targetClassName = qualifiedTargetClassName(input.targetContext);
    const classEntry = input.request.target.kind === "class"
      ? selectClassEntryPoint(input.targetContext, targetClassName)
      : undefined;
    const targetMethod = classEntry?.name ?? input.request.target.name;
    const targetIsStatic = classEntry?.isStatic ?? hasStaticModifier(
      input.targetContext.source.method,
      input.request.target.signature,
    );
    const migrator = new TestMigratorAgent({
      apiKey: this.#apiKey,
      timeoutMs: this.#timeoutMs,
    });
    // target-only:无源侧参考,仅依据需求 + Analyzer 报告 + 目标翻译产物生成描述。
    const generatedDescription = await migrator.extractDescription({
      sourceLanguage: "",
      sourceCode: undefined,
      requirement: input.request.requirement,
      repository: input.request.candidate.repository,
      sourcePath: input.request.candidate.path,
      targetContext: input.targetContext.source.containingType,
      targetCode: input.generatedCode,
      analysisReport: input.analysisReport
        ? JSON.stringify(input.analysisReport)
        : undefined,
      target: {
        language: targetLanguage,
        className: targetClassName,
        method: targetMethod,
        isStatic: targetIsStatic,
      },
    }, signal);
    const description: TestDescription = {
      ...generatedDescription,
      requirement: input.request.requirement,
      target: {
        ...generatedDescription.target,
        language: targetLanguage,
        className: targetClassName,
        method: targetMethod,
        entryKind: classEntry?.entryKind ?? "method",
        isStatic: targetIsStatic,
        constructorArgs: [],
      },
    };

    // 目标侧:集成编译保留目录已包含替换后的目标文件(生成代码已写入),直接复用。
    // driver 写入该目录后编译运行,不复制、不删除。
    if (input.targetProjectRoot) {
      return {
        description,
        buildTarget: (): SideSpec => ({
          language: targetLanguage,
          driverSource: generateDriverSource(description),
          sourceFiles: [],
          projectRoot: input.targetProjectRoot!,
          reuseDir: input.targetProjectRoot!,
        }),
      };
    }

    const targetFile = resolveTargetFile(input.projectRoot, input.request.target.path);
    if (!targetFile) throw new Error(`目标文件不存在：${input.request.target.path}`);
    const targetRelativePath = relative(input.projectRoot, targetFile).replaceAll("\\", "/");
    const originalTarget = readFileSync(targetFile, "utf8");
    const targetFiles = collectProjectSourceFiles(input.projectRoot, targetLanguage);
    const buildTarget = (generatedCode: string): SideSpec => ({
      language: targetLanguage,
      driverSource: generateDriverSource(description),
      sourceFiles: targetFiles.map((file) =>
        file.relativePath === targetRelativePath
          ? { ...file, content: compilerInternals.replaceTargetCode(originalTarget, generatedCode) }
          : file,
      ),
      projectRoot: input.projectRoot,
    });

    return { description, buildTarget };
  }
}

function reportResult(report: VerificationReport, label = "差分验证"): DifferentialVerificationResult {
  const failures = report.comparisons.filter((comparison) => comparison.verdict !== "pass");
  if (failures.length === 0 && report.totalCases > 0) {
    return {
      status: "pass",
      report,
      summary: `${label}通过：${report.passedCases}/${report.totalCases} 个 case。`,
      modificationPlan: [],
    };
  }

  const modificationPlan = failures.slice(0, 12).map((comparison) => {
    const details = comparison.details.length > 0
      ? comparison.details.join("；")
      : "源程序与目标程序结果不一致";
    return `修复 case ${comparison.caseId}：${details}`;
  });
  return {
    status: "fail",
    report,
    summary: `${label}未通过：${report.passedCases}/${report.totalCases} 个 case 通过，${failures.length} 个 case 需要修复。`,
    modificationPlan,
    reason: "behavioral-divergence",
  };
}

/**
 * 差分判定:Analyzer 报告为 direct/adapt 且源项目已复制 → 差分;否则 target-only。
 * 无报告(兼容旧调用)时保持差分行为。
 */
function useDifferential(input: DifferentialVerificationInput): boolean {
  const level = input.analysisReport?.applicability?.level;
  if (level === undefined) return true;
  if (level === "direct" || level === "adapt") return input.sourceProjectRoot != null;
  return false;
}

/** 差分模式:源侧参考优先读源项目副本里的完整文件;找不到时回退 preview。 */
function readSourceCodeForPrompt(input: DifferentialVerificationInput): string | undefined {
  if (input.sourceProjectRoot && input.request.candidate.path) {
    const realFile = resolve(input.sourceProjectRoot, input.request.candidate.path);
    if (existsSync(realFile)) {
      try {
        return readFileSync(realFile, "utf8");
      } catch {
        // 回退 preview
      }
    }
  }
  return input.request.candidate.preview;
}

/**
 * target-only 单侧验证:只执行目标侧,逐 case 用描述声明的 expected(需求黄金值)校验。
 * 无源侧结果时复用差分报告的字段结构(comparisons 无 source 侧)。
 */
async function verifyTargetOnly(
  job: { description: TestDescription; target: SideSpec },
  executor: RealDriverExecutor,
): Promise<VerificationReport> {
  const targetInfo = await executeSide(executor, job.target, "target");
  const resultsByCase = new Map(
    (targetInfo.results?.results ?? []).map((r) => [r.caseId, r]),
  );
  const comparisons: CaseComparison[] = job.description.cases.map((c) => {
    const target = resultsByCase.get(c.id) ?? null;
    if (!target) {
      return {
        caseId: c.id,
        verdict: "divergent",
        source: null,
        target: null,
        details: ["Target side produced no result for this case."],
      };
    }
    const issues = validateAgainstExpected(target, c.expected);
    return {
      caseId: c.id,
      verdict: issues.length === 0 ? "pass" : "fail",
      source: null,
      target,
      details: issues,
    };
  });
  const passedCases = comparisons.filter((c) => c.verdict === "pass").length;
  const failedCases = comparisons.filter((c) => c.verdict === "fail").length;
  const divergentCases = comparisons.filter((c) => c.verdict === "divergent").length;
  return {
    schemaVersion: "1.0",
    source: {
      language: "Java",
      compile: { success: false, errors: [], output: "" },
      run: null,
      results: null,
    },
    target: targetInfo,
    comparisons,
    passRate: comparisons.length === 0 ? 0 : passedCases / comparisons.length,
    totalCases: comparisons.length,
    passedCases,
    failedCases,
    divergentCases,
  };
}

/**
 * smoke 自主会话结果 → DifferentialVerificationResult。
 * 策略层 pass/fail 来自 report.converged;error(报告缺失/非法/中止)→ unverified。
 * modificationPlan 取 translation-bug 裁决 + 源侧疑似缺陷。
 */
function smokeResult(result: TestStrategyReport): DifferentialVerificationResult {
  const detail = result.detail as SmokeReport;
  if (result.status === "error") {
    return {
      status: "unverified",
      summary: `冒烟验证失败：${result.summary}`,
      modificationPlan: [],
      reason: "verifier-error",
    };
  }
  const bugs = detail.cases.filter((c) => c.decision === "translation-bug");
  const modificationPlan = [
    ...bugs.slice(0, 12).map((c) => `修复 case ${c.caseId}：${c.reasoning}`),
    ...detail.sourceIssues.slice(0, 4).map((issue) => `源侧疑似缺陷：${issue}`),
  ];
  const kept = result.keptDir ? ` 工作区保留:${result.keptDir}` : "";
  return {
    status: result.status === "pass" ? "pass" : "fail",
    report: detail,
    summary: `${detail.summary}${kept}`,
    modificationPlan,
    reason: result.status === "pass" ? undefined : "behavioral-divergence",
  };
}

function unverified(reason: string): DifferentialVerificationResult {
  return {
    status: "unverified",
    summary: `验证未执行：${reason}`,
    modificationPlan: [],
    reason: "verifier-unavailable",
  };
}

function unsupportedReason(
  request: AdaptationRequest,
  context: TargetModuleContext,
  differential: boolean,
): string | undefined {
  if (!asVerifierTargetLanguage(request.target.language)) {
    return `目标语言 ${request.target.language} 暂无可执行 verifier driver。`;
  }
  if (differential && !asVerifierLanguage(request.candidate.language)) {
    return `源语言 ${request.candidate.language} 暂无可执行 verifier driver。`;
  }
  if (!context.source.containingType) return "无法确定目标所属类型。";
  if (request.target.kind === "class" && !selectClassEntryPoint(context, qualifiedTargetClassName(context))) {
    return "目标类没有可识别的可调用成员，暂时无法建立类级验证入口。";
  }
  return undefined;
}

function selectClassEntryPoint(
  context: TargetModuleContext,
  className: string,
): ClassEntryPoint | undefined {
  const declarations = [
    ...context.source.relatedMembers,
    ...context.source.containingType.split("\n"),
  ];
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed || /\b(?:if|for|while|switch|catch)\s*\(/.test(trimmed)) continue;
    const method = extractMethodName(trimmed, trimmed);
    if (!method || method === className) continue;
    return {
      name: method,
      entryKind: "method",
      isStatic: hasStaticModifier(trimmed),
    };
  }
  if (context.source.constructor) {
    return { name: "__constructor__", entryKind: "constructor", isStatic: false };
  }
  return undefined;
}

function asVerifierLanguage(language: Language): VerifierLanguage | undefined {
  return language === "Java" || language === "C#" || language === "Python" || language === "TypeScript"
    ? language
    : undefined;
}

function asVerifierTargetLanguage(language: Language): "Java" | "C#" | undefined {
  return language === "Java" || language === "C#" ? language : undefined;
}

function qualifiedTargetClassName(context: TargetModuleContext): string {
  const declaration = context.source.containingType.trim();
  const typeName = /(?:class|interface|record|struct|enum)\s+([A-Za-z_$][\w$]*)/.exec(declaration)?.[1]
    ?? context.target.name;
  const namespace = context.source.namespace?.trim();
  return namespace && !typeName.includes(".") ? `${namespace}.${typeName}` : typeName;
}

function hasStaticModifier(...declarations: string[]): boolean {
  return declarations.some((declaration) => /\bstatic\b/.test(declaration));
}

function buildSourceInvocation(
  candidate: SearchCandidate,
  language: VerifierLanguage,
): SourceInvocation {
  const method = extractMethodName(candidate.signature, candidate.preview);
  if (!method && candidate.kind !== "class") {
    throw new Error(`无法解析候选方法名：${candidate.signature}`);
  }
  const isStatic = /\bstatic\b/.test(candidate.signature) || /\bstatic\b/.test(candidate.preview);
  if (language === "Java" || language === "C#") {
    if (!method) throw new Error(`候选类没有可识别的可调用成员：${candidate.signature}`);
    return {
      language,
      className: `Source${sanitizeIdentifier(candidate.title || method)}`,
      method,
      isStatic,
      constructorArgs: [],
    };
  }
  const modulePath = stripExtension(candidate.path).replace(/^\.\//, "");
  return {
    language,
    module: language === "Python"
      ? modulePath.replace(/^src\//, "").replaceAll("/", ".")
      : modulePath,
    method: method ?? candidate.title,
    className: extractClassName(candidate.preview),
    isStatic,
    constructorArgs: [],
  };
}

function buildSourceSide(
  description: TestDescription,
  invocation: SourceInvocation,
  preview: string,
  sourceProjectRoot?: string,
  candidatePath?: string,
): SideSpec {
  // 源项目副本存在:直接编译真实源项目(driver 调用真实类,类/命名空间从项目文件解析)。
  const realContent = readSourceProjectFile(sourceProjectRoot, candidatePath);
  if (realContent) {
    const className = qualifiedClassNameFromSource(realContent, invocation.language)
      ?? invocation.className
      ?? sanitizeIdentifier(invocation.method);
    return {
      language: invocation.language,
      driverSource: generateSourceDriverSource({
        ...description,
        target: {
          ...description.target,
          language: invocation.language === "Java" ? "Java" : "C#",
          className,
          method: invocation.method,
          entryKind: "method",
          isStatic: invocation.isStatic,
          constructorArgs: [],
        },
      }, { ...invocation, className }),
      sourceFiles: [],
      projectRoot: sourceProjectRoot!,
      reuseDir: sourceProjectRoot!,
    };
  }
  if (invocation.language === "Python" || invocation.language === "TypeScript") {
    const sourceFiles = [{
      relativePath: normalizeSourcePath(invocation.module ?? "candidate", invocation.language),
      content: preview,
    }];
    return {
      language: invocation.language,
      driverSource: generateSourceDriverSource({
        ...description,
        target: {
          ...description.target,
          method: invocation.method,
          entryKind: "method",
          isStatic: invocation.isStatic,
          constructorArgs: [],
        },
      }, invocation),
      sourceFiles,
      ...(sourceProjectRoot ? { projectRoot: sourceProjectRoot, reuseDir: sourceProjectRoot } : {}),
    };
  }
  if (!invocation.className) {
    throw new Error(`${invocation.language} 候选缺少类级调用入口。`);
  }
  const extension = invocation.language === "Java" ? ".java" : ".cs";
  const sourceContent = normalizeClassSource(preview, invocation.className, invocation.language);
  const sourceDescription: TestDescription = {
    ...description,
    target: {
      ...description.target,
      language: invocation.language === "Java" ? "Java" : "C#",
      className: invocation.className,
      method: invocation.method,
      entryKind: "method",
      isStatic: invocation.isStatic,
      constructorArgs: [],
    },
  };
  return {
    language: invocation.language,
    driverSource: generateSourceDriverSource(sourceDescription, invocation),
    sourceFiles: [{ relativePath: `${invocation.className}${extension}`, content: sourceContent }],
    ...(sourceProjectRoot ? { projectRoot: sourceProjectRoot, reuseDir: sourceProjectRoot } : {}),
  };
}

function extractClassName(source: string): string | undefined {
  return /\b(?:class|interface|record|struct)\s+([A-Za-z_$][\w$]*)/.exec(source)?.[1];
}

/**
 * 从源项目真实文件解析类的全限定名(package/namespace + 简单类名),
 * 供 driver 直接调用真实类。解析失败返回 undefined。
 */
function qualifiedClassNameFromSource(
  source: string,
  language: VerifierLanguage,
): string | undefined {
  const simple = extractClassName(source);
  if (!simple) return undefined;
  if (language === "Java") {
    const pkg = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(source)?.[1];
    return pkg ? `${pkg}.${simple}` : simple;
  }
  if (language === "C#") {
    const ns = /\bnamespace\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\{/.exec(source)?.[1];
    return ns ? `${ns}.${simple}` : simple;
  }
  return simple;
}

/** 读源项目副本里的候选文件;不存在或读取失败返回 undefined。 */
function readSourceProjectFile(
  sourceProjectRoot: string | undefined,
  candidatePath: string | undefined,
): string | undefined {
  if (!sourceProjectRoot || !candidatePath) return undefined;
  const realFile = resolve(sourceProjectRoot, candidatePath);
  if (!existsSync(realFile)) return undefined;
  try {
    return readFileSync(realFile, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeSourcePath(module: string, language: VerifierLanguage): string {
  const extension = language === "Python" ? ".py" : ".ts";
  const normalized = language === "Python"
    ? module.replaceAll(".", "/").replace(/^\/+/, "")
    : module.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.endsWith(extension) ? normalized : `${normalized}${extension}`;
}

function normalizeClassSource(
  preview: string,
  className: string,
  language: "Java" | "C#",
): string {
  if (!extractClassName(preview)) {
    const wrapper = `public class ${className} {\n${preview}\n}\n`;
    if (language === "Java") return wrapper;
    // C# 回退包装:方法体可能引用 System.IO 等类型,按需补齐 using。
    const extra = compilerInternals.csharpRequiredUsings(preview)
      .map((ns) => `using ${ns};`)
      .join("\n");
    return extra ? `${extra}\n${wrapper}` : wrapper;
  }
  const withoutPackage = language === "Java"
    ? preview.replace(/^\s*package\s+[^;]+;\s*/m, "")
    : preview;
  return withoutPackage.replace(
    /\b(class|interface|record|struct)\s+([A-Za-z_$][\w$]*)/,
    (_match, kind: string) => `${kind === "interface" ? "public interface" : "public class"} ${className}`,
  );
}

function extractMethodName(signature: string, preview: string): string | undefined {
  const declaration = `${signature}\n${preview}`.match(
    /(?:\bdef\s+|\bfunction\s+|\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)/,
  );
  return declaration?.[1];
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `Candidate_${sanitized}`;
}

function stripExtension(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/\.(?:py|ts)$/, "");
}

function resolveTargetFile(root: string, targetPath: string): string | undefined {
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, targetPath);
  const relativePath = relative(rootPath, fullPath);
  return relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath) && existsSync(fullPath)
    ? fullPath
    : undefined;
}

function collectProjectSourceFiles(root: string, language: "Java" | "C#"): SideFile[] {
  const extension = language === "Java" ? ".java" : ".cs";
  const rootPath = resolve(root);
  const files: SideFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if ([".git", "node_modules", "target", "bin", "obj", "build", "test", "tests"].includes(entry)) continue;
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (entry.endsWith(extension)) {
        files.push({
          relativePath: relative(rootPath, absolute).replaceAll("\\", "/"),
          content: readFileSync(absolute, "utf8"),
        });
      }
    }
  };
  visit(rootPath);
  return files;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @internal 暴露给测试 */
export const verificationAdapterInternals = {
  buildSourceSide,
  qualifiedClassNameFromSource,
  readSourceProjectFile,
  smokeResult,
  useDifferential,
  unsupportedReason,
};
export { verifyTargetOnly as _verifyTargetOnly };
export type { VerificationPlan as _VerificationPlan };
