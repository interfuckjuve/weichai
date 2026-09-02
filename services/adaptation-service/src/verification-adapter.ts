import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AdaptationRequest,
  Language,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import {
  generateDriverSource,
  generateSourceDriverSource,
  TestMigratorAgent,
  verify,
  type DriverExecutor,
  type SideFile,
  type SideSpec,
  type SourceInvocation,
  type TestDescription,
  type VerificationReport,
  type VerifierLanguage,
} from "@forexplore/translation-verifier";
import { compilerInternals } from "./compiler";

export interface DifferentialVerificationInput {
  request: AdaptationRequest;
  targetContext: TargetModuleContext;
  generatedCode: string;
  projectRoot: string;
}

export interface DifferentialVerificationResult {
  status: "pass" | "fail" | "unverified";
  report?: VerificationReport;
  summary: string;
  modificationPlan: string[];
  reason?: "behavioral-divergence" | "verifier-error" | "verifier-unavailable" | "route-unsupported";
  unsupportedReason?: VerificationUnsupportedReason;
}

export type VerificationUnsupportedCode =
  | "SOURCE_RUNTIME_UNAVAILABLE"
  | "TARGET_RUNTIME_UNAVAILABLE"
  | "TARGET_SOURCE_FORM_UNSUPPORTED"
  | "TARGET_CONTEXT_UNAVAILABLE"
  | "TARGET_ENTRYPOINT_UNAVAILABLE";

export interface VerificationUnsupportedReason {
  code: VerificationUnsupportedCode;
  stage: "source-driver" | "target-driver" | "target-context" | "target-entrypoint";
  sourceLanguage: Language;
  targetLanguage: Language;
  detail: string;
  retryable: false;
}

export interface TranslationVerifierRuntimeCapability {
  language: VerifierLanguage;
  sourceDriver: true;
  targetDriver: true;
  ownerKinds: readonly ("type" | "module")[];
  sourceExtension: ".java" | ".cs" | ".py" | ".ts";
  quality: {
    level: "isolated-differential-execution";
    provesBehavioralCorrectness: false;
    limitations: readonly string[];
  };
}

export interface TranslationVerifierRouteCapability {
  source: TranslationVerifierRuntimeCapability;
  target: TranslationVerifierRuntimeCapability;
}

const VERIFIER_RUNTIME_CAPABILITIES: readonly TranslationVerifierRuntimeCapability[] = [
  runtimeCapability("Java", ".java", ["type"]),
  runtimeCapability("C#", ".cs", ["type"]),
  runtimeCapability("Python", ".py", ["type", "module"]),
  runtimeCapability("TypeScript", ".ts", ["type", "module"]),
];

const VERIFIER_RUNTIME_BY_LANGUAGE = new Map<Language, TranslationVerifierRuntimeCapability>(
  VERIFIER_RUNTIME_CAPABILITIES.map((capability) => [capability.language, capability]),
);

export function listTranslationVerifierRuntimeCapabilities(): TranslationVerifierRuntimeCapability[] {
  return VERIFIER_RUNTIME_CAPABILITIES.map(cloneRuntimeCapability);
}

export function resolveTranslationVerifierRoute(
  sourceLanguage: Language,
  targetLanguage: Language,
): TranslationVerifierRouteCapability | undefined {
  const source = VERIFIER_RUNTIME_BY_LANGUAGE.get(sourceLanguage);
  const target = VERIFIER_RUNTIME_BY_LANGUAGE.get(targetLanguage);
  return source && target
    ? { source: cloneRuntimeCapability(source), target: cloneRuntimeCapability(target) }
    : undefined;
}

export interface AdaptationVerifier {
  verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult>;
}

interface VerificationPlan {
  description: TestDescription;
  source: SideSpec;
  buildTarget: (generatedCode: string) => SideSpec;
}

interface ClassEntryPoint {
  name: string;
  entryKind: "method" | "constructor";
  isStatic: boolean;
}

/**
 * The service must not execute retrieved code in its own process.  An
 * integration that has provisioned a separate sandbox can inject an executor
 * which carries this explicit boundary attestation.  This is intentionally a
 * narrow interface: {@link RealDriverExecutor} is not an implementation of it.
 */
export interface IsolatedDriverExecutor extends DriverExecutor {
  readonly isolation: {
    /** The executor process is outside the adaptation-service host process. */
    processBoundary: "external";
    /** Candidate code cannot make network requests. */
    network: "disabled";
    /** Service environment variables, including model credentials, are absent. */
    hostCredentials: "unavailable";
    /** The host workspace is not mounted into the execution environment. */
    hostWorkspace: "unmounted";
  };
}

export type TranslationVerifierExecution = "disabled" | "trusted-isolated";

export interface TranslationVerifierAdapterOptions {
  apiKey: string;
  timeoutMs?: number;
  /**
   * Disabled by default.  The production HTTP server deliberately never
   * enables execution because it does not provision an isolated runner.
   */
  execution?: TranslationVerifierExecution;
  /** Required only for the explicit, externally-isolated execution path. */
  executor?: IsolatedDriverExecutor;
}

/** Runs the verifier only after the adaptation compiler has accepted the code. */
export class TranslationVerifierAdapter implements AdaptationVerifier {
  readonly #apiKey: string;
  readonly #timeoutMs?: number;
  readonly #execution: TranslationVerifierExecution;
  readonly #executor?: IsolatedDriverExecutor;

  constructor(options: TranslationVerifierAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#execution = options.execution ?? "disabled";

    if (this.#execution === "trusted-isolated") {
      this.#executor = requireIsolatedExecutor(options.executor);
      return;
    }
    if (options.executor) {
      throw new Error("A verifier executor cannot be configured while execution is disabled.");
    }
    this.#executor = undefined;
  }

  async verify(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<DifferentialVerificationResult> {
    // This guard intentionally precedes plan construction: plan construction
    // sends candidate preview to the test migrator and later turns it into
    // executable files.  A normal adaptation-service process has neither a
    // sandbox nor authority to run retrieved code, so report required
    // unverified evidence rather than silently running it on the host.
    if (this.#execution === "disabled") {
      return unverified(
        "安全策略已禁用差分执行：适配服务未配置外部隔离执行器，未运行候选或生成代码。",
      );
    }

    const unsupported = unsupportedReason(input.request, input.targetContext);
    if (unsupported) return unsupportedResult(unsupported);

    let plan: VerificationPlan;
    try {
      plan = await this.#buildPlan(input, signal);
    } catch (error: unknown) {
      return unverified(`无法建立差分验证输入：${errorMessage(error)}`);
    }

    signal?.throwIfAborted();
    const report = await verify(
      {
        description: plan.description,
        source: plan.source,
        target: plan.buildTarget(input.generatedCode),
      },
      // Constructor validation guarantees this is present for the only
      // execution-enabled mode.  Keep the check here so a malformed object
      // cannot turn into an accidental host executor at runtime.
      requireIsolatedExecutor(this.#executor),
    );
    return reportResult(report);
  }

  async #buildPlan(
    input: DifferentialVerificationInput,
    signal?: AbortSignal,
  ): Promise<VerificationPlan> {
    const route = resolveTranslationVerifierRoute(
      input.request.candidate.language,
      input.request.target.language,
    );
    if (!route) throw new Error("Verifier route capability disappeared after preflight validation.");
    const sourceLanguage = route.source.language;
    const targetLanguage = route.target.language;
    const targetInvocation = buildTargetInvocation(
      input.targetContext,
      targetLanguage,
      input.request.target.path,
    );
    const targetClassName = targetInvocation.className;
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
    const generatedDescription = await migrator.extractDescription({
      sourceLanguage,
      sourceCode: input.request.candidate.preview,
      requirement: input.request.requirement,
      repository: input.request.candidate.repository,
      sourcePath: input.request.candidate.path,
      targetContext: input.targetContext.source.containingType,
      target: {
        language: targetLanguage,
        ...targetInvocation.moduleFields,
        className: targetClassName,
        method: targetMethod,
        isStatic: targetInvocation.ownerKind === "module" ? true : targetIsStatic,
      },
    }, signal);
    const description: TestDescription = {
      ...generatedDescription,
      requirement: input.request.requirement,
      target: {
        ...generatedDescription.target,
        language: targetLanguage,
        ...targetInvocation.moduleFields,
        className: targetClassName,
        method: targetMethod,
        entryKind: classEntry?.entryKind ?? "method",
        isStatic: targetInvocation.ownerKind === "module" ? true : targetIsStatic,
        constructorArgs: [],
      },
    };

    const sourceInvocation = buildSourceInvocation(input.request.candidate, sourceLanguage);
    const source = buildSourceSide(description, sourceInvocation, input.request.candidate.preview);
    const targetFile = resolveTargetFile(input.projectRoot, input.request.target.path);
    if (!targetFile) throw new Error(`目标文件不存在：${input.request.target.path}`);
    const targetRelativePath = relative(input.projectRoot, targetFile).replaceAll("\\", "/");
    const originalTarget = readFileSync(targetFile, "utf8");
    const targetFiles = collectProjectSourceFiles(input.projectRoot, route.target);
    const buildTarget = (generatedCode: string): SideSpec => ({
      language: targetLanguage,
      driverSource: generateDriverSource(description),
      sourceFiles: targetFiles.map((file) =>
        file.relativePath === targetRelativePath
          ? { ...file, content: replaceGeneratedTarget(targetLanguage, originalTarget, generatedCode) }
          : file,
      ),
      projectRoot: input.projectRoot,
    });

    return { description, source, buildTarget };
  }
}

function requireIsolatedExecutor(
  executor: IsolatedDriverExecutor | undefined,
): IsolatedDriverExecutor {
  const isolation = executor?.isolation;
  if (!executor || !isolation ||
    isolation.processBoundary !== "external" ||
    isolation.network !== "disabled" ||
    isolation.hostCredentials !== "unavailable" ||
    isolation.hostWorkspace !== "unmounted") {
    throw new Error(
      "Differential verification requires an executor with an external, credential-free, network-disabled workspace boundary.",
    );
  }
  return executor;
}

function reportResult(report: VerificationReport): DifferentialVerificationResult {
  const failures = report.comparisons.filter((comparison) => comparison.verdict !== "pass");
  if (failures.length === 0 && report.totalCases > 0) {
    return {
      status: "pass",
      report,
      summary: `差分验证通过：${report.passedCases}/${report.totalCases} 个 case。`,
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
    summary: `差分验证未通过：${report.passedCases}/${report.totalCases} 个 case 通过，${failures.length} 个 case 需要修复。`,
    modificationPlan,
    reason: "behavioral-divergence",
  };
}

function unverified(reason: string): DifferentialVerificationResult {
  return {
    status: "unverified",
    summary: `差分验证未执行：${reason}`,
    modificationPlan: [],
    reason: "verifier-unavailable",
  };
}

function unsupportedResult(reason: VerificationUnsupportedReason): DifferentialVerificationResult {
  return {
    status: "unverified",
    summary: `差分验证未执行：[${reason.code}] ${reason.detail}`,
    modificationPlan: [],
    reason: "route-unsupported",
    unsupportedReason: reason,
  };
}

function unsupportedReason(
  request: AdaptationRequest,
  context: TargetModuleContext,
): VerificationUnsupportedReason | undefined {
  const source = VERIFIER_RUNTIME_BY_LANGUAGE.get(request.candidate.language);
  if (!source) {
    return verificationUnsupported(
      "SOURCE_RUNTIME_UNAVAILABLE",
      "source-driver",
      request,
      `源语言 ${request.candidate.language} 未注册可执行 verifier runtime。`,
    );
  }
  const target = VERIFIER_RUNTIME_BY_LANGUAGE.get(request.target.language);
  if (!target) {
    return verificationUnsupported(
      "TARGET_RUNTIME_UNAVAILABLE",
      "target-driver",
      request,
      `目标语言 ${request.target.language} 未注册可执行 verifier runtime。`,
    );
  }
  if (!request.target.path.toLowerCase().endsWith(target.sourceExtension)) {
    return verificationUnsupported(
      "TARGET_SOURCE_FORM_UNSUPPORTED",
      "target-driver",
      request,
      `目标 runtime ${request.target.language} 仅声明 ${target.sourceExtension} 源文件能力，无法安全验证 ${request.target.path}。`,
    );
  }
  if (!context.source.containingType) {
    return verificationUnsupported(
      "TARGET_CONTEXT_UNAVAILABLE",
      "target-context",
      request,
      "目标上下文不包含可验证的声明或模块级函数。",
    );
  }
  if (request.target.kind === "class" && !selectClassEntryPoint(context, qualifiedTargetClassName(context))) {
    return verificationUnsupported(
      "TARGET_ENTRYPOINT_UNAVAILABLE",
      "target-entrypoint",
      request,
      "目标类型没有可识别的可调用成员，无法建立类级验证入口。",
    );
  }
  return undefined;
}

function verificationUnsupported(
  code: VerificationUnsupportedCode,
  stage: VerificationUnsupportedReason["stage"],
  request: AdaptationRequest,
  detail: string,
): VerificationUnsupportedReason {
  return {
    code,
    stage,
    sourceLanguage: request.candidate.language,
    targetLanguage: request.target.language,
    detail,
    retryable: false,
  };
}

function runtimeCapability(
  language: VerifierLanguage,
  sourceExtension: TranslationVerifierRuntimeCapability["sourceExtension"],
  ownerKinds: readonly ("type" | "module")[],
): TranslationVerifierRuntimeCapability {
  return {
    language,
    sourceDriver: true,
    targetDriver: true,
    ownerKinds,
    sourceExtension,
    quality: {
      level: "isolated-differential-execution",
      provesBehavioralCorrectness: false,
      limitations: [
        "Only JSON-safe test values and generated executable cases are compared.",
        "A passing route does not prove concurrency, performance, or uncovered business behavior.",
      ],
    },
  };
}

function cloneRuntimeCapability(
  capability: TranslationVerifierRuntimeCapability,
): TranslationVerifierRuntimeCapability {
  return {
    ...capability,
    ownerKinds: [...capability.ownerKinds],
    quality: {
      ...capability.quality,
      limitations: [...capability.quality.limitations],
    },
  };
}

interface TargetInvocationMetadata {
  className: string;
  ownerKind: "type" | "module";
  moduleFields: {
    module?: string;
    ownerKind?: "type" | "module";
  };
}

function buildTargetInvocation(
  context: TargetModuleContext,
  language: VerifierLanguage,
  requestedPath: string,
): TargetInvocationMetadata {
  const declaration = context.source.containingType.trim();
  const typeName = /(?:class|interface|record|struct|enum)\s+([A-Za-z_$][\w$]*)/.exec(declaration)?.[1];
  if (language !== "Python" && language !== "TypeScript") {
    return {
      className: qualifiedTargetClassName(context),
      ownerKind: "type",
      moduleFields: {},
    };
  }
  const ownerKind = typeName ? "type" : "module";
  const module = targetModulePath(
    context.collection.targetFile && context.collection.targetFile !== "."
      ? context.collection.targetFile
      : requestedPath,
    language,
  );
  return {
    className: typeName ?? "",
    ownerKind,
    moduleFields: { module, ownerKind },
  };
}

function targetModulePath(path: string, language: "Python" | "TypeScript"): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutExtension = normalized.replace(language === "Python" ? /\.py$/i : /\.ts$/i, "");
  if (language === "TypeScript") return withoutExtension;
  const withoutPackageInit = withoutExtension.replace(/\/(?:__init__)$/, "");
  return withoutPackageInit.replaceAll("/", ".");
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
): SideSpec {
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
  };
}

function extractClassName(source: string): string | undefined {
  return /\b(?:class|interface|record|struct)\s+([A-Za-z_$][\w$]*)/.exec(source)?.[1];
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
  if (!extractClassName(preview)) return `public class ${className} {\n${preview}\n}\n`;
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

function replaceGeneratedTarget(
  language: VerifierLanguage,
  original: string,
  generatedCode: string,
): string {
  return language === "Python"
    ? compilerInternals.replacePythonTargetCode(original, generatedCode)
    : compilerInternals.replaceTargetCode(original, generatedCode);
}

function collectProjectSourceFiles(
  root: string,
  capability: TranslationVerifierRuntimeCapability,
): SideFile[] {
  const extension = capability.sourceExtension;
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
