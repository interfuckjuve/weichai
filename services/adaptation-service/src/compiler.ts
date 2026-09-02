/**
 * Language-registry compiler validation helpers.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Language, LanguageId } from "@forexplore/contracts";
import { normalizeLanguageId } from "@forexplore/contracts";

export interface CompileResult {
  success: boolean;
  errors: string[];
  output: string;
  unsupportedReason?: CompilerUnsupportedReason;
}

export type CompilerValidationLevel = "syntax" | "typecheck" | "compile" | "project-build-or-test";

export interface CompilerUnsupportedReason {
  code: "COMPILER_ROUTE_UNAVAILABLE";
  stage: "standalone" | "integrated";
  language: string;
  detail: string;
  retryable: false;
}

export interface CompilerRouteCapability {
  /** Canonical, open-ended routing key. This is not the closed V1 Language union. */
  languageId: LanguageId;
  /** Human-readable label only; never used as the routing key. */
  displayName: string;
  providerId: string;
  version: string;
  standalone: { command: string; level: CompilerValidationLevel };
  integrated: { command: string; level: CompilerValidationLevel };
  quality: {
    provesBehavioralCorrectness: false;
    limitations: readonly string[];
  };
}

export interface CompilerRouteRegistration {
  capability: CompilerRouteCapability;
  standalone: (code: string, targetName: string) => CompileResult;
  integrated: (code: string, projectPath: string, targetFilePath: string) => CompileResult;
}

export class CompilerRouteRegistry {
  readonly #byLanguageId = new Map<LanguageId, CompilerRouteRegistration>();

  constructor(routes: readonly CompilerRouteRegistration[] = []) {
    for (const route of routes) this.register(route);
  }

  register(route: CompilerRouteRegistration): void {
    const languageId = normalizeLanguageId(route.capability.languageId);
    assertCompilerRoute(route, languageId);
    if (this.#byLanguageId.has(languageId)) {
      throw new Error(`Compiler route is already registered for ${languageId}.`);
    }
    this.#byLanguageId.set(languageId, {
      ...route,
      capability: cloneCompilerCapability({ ...route.capability, languageId }),
    });
  }

  listCapabilities(): CompilerRouteCapability[] {
    return [...this.#byLanguageId.values()]
      .map(({ capability }) => cloneCompilerCapability(capability));
  }

  resolve(languageId: LanguageId): CompilerRouteCapability | undefined {
    const capability = this.#byLanguageId.get(normalizeLanguageId(languageId))?.capability;
    return capability ? cloneCompilerCapability(capability) : undefined;
  }

  compileStandalone(languageId: LanguageId, code: string, targetName: string): CompileResult {
    const normalized = normalizeLanguageId(languageId);
    const route = this.#byLanguageId.get(normalized);
    return route
      ? route.standalone(code, targetName)
      : unsupportedCompilerRoute(normalized, "standalone");
  }

  compileIntegrated(
    languageId: LanguageId,
    code: string,
    projectPath: string,
    targetFilePath: string,
  ): CompileResult {
    const normalized = normalizeLanguageId(languageId);
    const route = this.#byLanguageId.get(normalized);
    return route
      ? route.integrated(code, projectPath, targetFilePath)
      : unsupportedCompilerRoute(normalized, "integrated");
  }
}

const DEFAULT_COMPILER_ROUTES: readonly CompilerRouteRegistration[] = [
  compilerRoute("java", "Java", "javac", "compile", "javac / Maven", "project-build-or-test", compileJavaStandalone, compileJavaIntegrated, [
    "Integrated validation uses Maven when available and otherwise compiles discovered Java files with javac; Gradle is not executed.",
  ]),
  compilerRoute("csharp", "C#", "dotnet build --nologo -v q", "compile", "dotnet build --nologo -v q", "project-build-or-test", compileStandalone, compileIntegrated, [
    "Standalone validation uses a generated net8.0 wrapper project.",
  ]),
  compilerRoute("typescript", "TypeScript", "tsc --noEmit", "typecheck", "tsc --noEmit", "typecheck", compileTypeScriptStandalone, compileTypeScriptIntegrated, [
    "Standalone validation uses fixed ES2022/NodeNext options; integrated validation uses only the detected root tsconfig or target file.",
  ]),
  compilerRoute("python", "Python", "python -m py_compile", "syntax", "python -m py_compile", "syntax", compilePythonStandalone, compilePythonIntegrated, [
    "Python validation is syntax compilation only; it does not prove imports, types, or tests.",
  ]),
  compilerRoute("rust", "Rust", "rustc", "compile", "cargo check / rustc", "project-build-or-test", compileRustStandalone, compileRustIntegrated, [
    "Integrated validation falls back to single-file rustc when no Cargo manifest/tool is available.",
  ]),
  compilerRoute("go", "Go", "go test", "compile", "go test", "project-build-or-test", compileGoStandalone, compileGoIntegrated, [
    "Integrated validation runs the module test graph only when go.mod is present; otherwise it validates the target file.",
  ]),
];

export function createDefaultCompilerRouteRegistry(): CompilerRouteRegistry {
  return new CompilerRouteRegistry(DEFAULT_COMPILER_ROUTES);
}

const defaultCompilerRouteRegistry = createDefaultCompilerRouteRegistry();

export function listCompilerRouteCapabilities(
  registry: CompilerRouteRegistry = defaultCompilerRouteRegistry,
): CompilerRouteCapability[] {
  return registry.listCapabilities();
}

/** @deprecated V1 closed-Language compatibility wrapper. Use the LanguageId resolver. */
export function resolveCompilerRouteCapability(
  language: Language,
): CompilerRouteCapability | undefined {
  return resolveCompilerRouteCapabilityByLanguageId(language);
}

export function resolveCompilerRouteCapabilityByLanguageId(
  languageId: LanguageId,
  registry: CompilerRouteRegistry = defaultCompilerRouteRegistry,
): CompilerRouteCapability | undefined {
  return registry.resolve(languageId);
}

export function compileTargetStandaloneByLanguageId(
  languageId: LanguageId,
  code: string,
  targetName: string,
  registry: CompilerRouteRegistry = defaultCompilerRouteRegistry,
): CompileResult {
  return registry.compileStandalone(languageId, code, targetName);
}

export function compileTargetIntegratedByLanguageId(
  languageId: LanguageId,
  code: string,
  projectPath: string,
  targetFilePath: string,
  registry: CompilerRouteRegistry = defaultCompilerRouteRegistry,
): CompileResult {
  return registry.compileIntegrated(languageId, code, projectPath, targetFilePath);
}

/**
 * Language-neutral validation entry points used by the adaptation workflow.
 * Individual compilers remain implementation details behind this registry.
 */
/** @deprecated V1 closed-Language compatibility wrapper. */
export function compileTargetStandalone(
  language: Language,
  code: string,
  targetName: string,
): CompileResult {
  const capability = defaultCompilerRouteRegistry.resolve(language);
  return capability
    ? defaultCompilerRouteRegistry.compileStandalone(capability.languageId, code, targetName)
    : unsupportedCompilerRoute(String(language), "standalone");
}

/** @deprecated V1 closed-Language compatibility wrapper. */
export function compileTargetIntegrated(
  language: Language,
  code: string,
  projectPath: string,
  targetFilePath: string,
): CompileResult {
  const capability = defaultCompilerRouteRegistry.resolve(language);
  return capability
    ? defaultCompilerRouteRegistry.compileIntegrated(
        capability.languageId,
        code,
        projectPath,
        targetFilePath,
      )
    : unsupportedCompilerRoute(String(language), "integrated");
}

/** @deprecated V1 closed-Language compatibility helper. */
export function compilerCommand(language: Language): string {
  const capability = defaultCompilerRouteRegistry.resolve(language);
  if (!capability) throw new Error(`Compiler route is unavailable for ${String(language)}.`);
  return capability.standalone.command;
}

function compilerRoute(
  languageId: LanguageId,
  displayName: string,
  standaloneCommand: string,
  standaloneLevel: CompilerValidationLevel,
  integratedCommand: string,
  integratedLevel: CompilerValidationLevel,
  standalone: CompilerRouteRegistration["standalone"],
  integrated: CompilerRouteRegistration["integrated"],
  limitations: readonly string[],
): CompilerRouteRegistration {
  return {
    capability: {
      languageId,
      displayName,
      providerId: `forexplore.compiler.${languageId}`,
      version: "1.0.0",
      standalone: { command: standaloneCommand, level: standaloneLevel },
      integrated: { command: integratedCommand, level: integratedLevel },
      quality: {
        provesBehavioralCorrectness: false,
        limitations: [
          "Validation strength is the declared level, not a language-independent correctness score.",
          "Project tests and behavioral verification remain separate required evidence.",
          ...limitations,
        ],
      },
    },
    standalone,
    integrated,
  };
}

function assertCompilerRoute(route: CompilerRouteRegistration, languageId: LanguageId): void {
  const capability = route.capability;
  if (
    !languageId ||
    !capability.displayName.trim() ||
    !capability.providerId.trim() ||
    !capability.version.trim() ||
    !capability.standalone.command.trim() ||
    !capability.integrated.command.trim() ||
    capability.quality.provesBehavioralCorrectness !== false ||
    !Array.isArray(capability.quality.limitations) ||
    capability.quality.limitations.length === 0 ||
    typeof route.standalone !== "function" ||
    typeof route.integrated !== "function"
  ) {
    throw new Error(`Compiler route for ${languageId} has an invalid capability descriptor.`);
  }
}

function cloneCompilerCapability(capability: CompilerRouteCapability): CompilerRouteCapability {
  return {
    ...capability,
    standalone: { ...capability.standalone },
    integrated: { ...capability.integrated },
    quality: {
      ...capability.quality,
      limitations: [...capability.quality.limitations],
    },
  };
}

function unsupportedCompilerRoute(
  language: string,
  stage: CompilerUnsupportedReason["stage"],
): CompileResult {
  const unsupportedReason: CompilerUnsupportedReason = {
    code: "COMPILER_ROUTE_UNAVAILABLE",
    stage,
    language,
    detail: `No compiler provider is registered for ${language} (${stage}).`,
    retryable: false,
  };
  return {
    success: false,
    errors: [`[${unsupportedReason.code}] ${unsupportedReason.detail}`],
    output: "",
    unsupportedReason,
  };
}

export interface ResolvedProjectTarget {
  sourcePath: string;
  relativePath: string;
}

/**
 * 独立编译一个 C# 方法体，不依赖项目类型定义。
 * 把翻译后的方法放进一个最小 wrapper class，用 dotnet build 验证。
 */
export function compileStandalone(
  csharpCode: string,
  className: string,
): CompileResult {
  const dotnet = findDotnet();
  const temporaryRoot = dotnet?.endsWith(".exe") ? process.cwd() : tmpdir();
  const dir = mkdtempSync(join(temporaryRoot, ".forexplore-standalone-"));

  const fullSource = buildWrapperSource(csharpCode, className);
  const csFile = join(dir, `${className}.cs`);
  writeFileSync(csFile, fullSource, "utf-8");

  try {
    if (dotnet) {
      return compileWithDotnet(dotnet, dir, true);
    }
    const csc = findCsc();
    if (csc) {
      return compileWithCsc(csc, dir, csFile);
    }
    return {
      success: false,
      errors: [
        ".NET SDK not installed. Run: winget install Microsoft.DotNet.SDK.8",
      ],
      output: "",
    };
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : String(e);
    return { success: false, errors: [msg], output: msg };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 集成编译 — 在临时副本中替换目标方法或类并编译完整 C# skeleton。
 */
export function compileIntegrated(
  csharpCode: string,
  skeletonProjectPath: string,
  targetFilePath: string,
): CompileResult {
  const projectRoot = resolve(skeletonProjectPath);
  const directSourcePath = resolve(projectRoot, targetFilePath);
  const resolvedTarget = resolveProjectTargetFile(projectRoot, targetFilePath);
  if (!resolvedTarget && isOutsideProject(projectRoot, directSourcePath)) {
    return {
      success: false,
      errors: [`Target file must stay inside the skeleton project: ${targetFilePath}`],
      output: "",
    };
  }
  if (!resolvedTarget) {
    return {
      success: false,
      errors: [`Target file does not exist in the skeleton project: ${targetFilePath}`],
      output: "",
    };
  }
  const { sourcePath, relativePath: relativeTarget } = resolvedTarget;
  const dotnet = findDotnet();
  if (!dotnet) {
    return {
      success: false,
      errors: [".NET SDK not installed; integrated compilation was not executed."],
      output: "",
    };
  }

  // Keep Windows-hosted SDK builds on the same mounted drive as the skeleton.
  const temporaryProject = mkdtempSync(
    join(dirname(projectRoot), ".forexplore-integrated-"),
  );
  try {
    cpSync(projectRoot, temporaryProject, {
      recursive: true,
      filter: (source) => !["bin", "obj"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const temporaryTarget = join(temporaryProject, relativeTarget);
    const original = readFileSync(temporaryTarget, "utf8");
    writeFileSync(temporaryTarget, replaceTargetCode(original, csharpCode), "utf8");
    return compileWithDotnet(dotnet, temporaryProject, false);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message };
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

// ---- helpers ----

function findDotnet(): string | null {
  const candidates = [
    process.env.DOTNET_COMMAND?.trim(),
    "dotnet",
    "/mnt/c/Program Files/dotnet/dotnet.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      // A runtime-only installation answers `--version` but cannot build a
      // temporary project. Treat it as unavailable evidence instead of a
      // compiler failure with an empty diagnostic stream.
      const sdks = execFileSync(candidate, ["--list-sdks"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (sdks.trim()) return candidate;
    } catch {
      // Continue to the next known installation location.
    }
  }
  return null;
}

export function isCompilerUnavailable(result: CompileResult): boolean {
  return result.errors.some((error) =>
    /(?:\.NET SDK|C# compiler|JDK|javac|TypeScript compiler|Python|Rust compiler|Go compiler).*(?:not installed|not available)/i.test(error),
  );
}

function findCsc(): string | null {
  const paths = [
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return paths.find((candidate) => existsSync(candidate)) ?? null;
}

function compileWithDotnet(
  dotnet: string,
  dir: string,
  createProject: boolean,
): CompileResult {
  if (createProject) {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
  </PropertyGroup>
</Project>`;
    writeFileSync(join(dir, "tmp.csproj"), csproj, "utf-8");
  }

  try {
    const stdout = execFileSync(dotnet, ["build", "--nologo", "-v", "q"], {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      stdio: "pipe",
    });
    return { success: true, errors: [], output: stdout };
  } catch (e: unknown) {
    const errOutput = collectErrorOutput(e);
    const errors = parseCsErrors(errOutput);
    return { success: false, errors, output: errOutput };
  }
}

function compileWithCsc(csc: string, dir: string, csFile: string): CompileResult {
  const dllPath = join(dir, "test.dll");
  try {
    const stdout = execFileSync(
      csc,
      ["/target:library", `/out:${dllPath}`, "/nologo", csFile],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000, stdio: "pipe" },
    );
    return { success: true, errors: [], output: stdout };
  } catch (e: unknown) {
    const errOutput = collectErrorOutput(e);
    const errors = parseCsErrors(errOutput);
    return { success: false, errors, output: errOutput };
  }
}

function collectErrorOutput(e: unknown): string {
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    const output = [obj.stdout, obj.stderr]
      .map((value) => value === undefined || value === null ? "" : String(value))
      .filter((value) => value.trim());
    if (output.length > 0) return output.join("\n");
    return String(obj.message ?? String(e));
  }
  return String(e);
}

function parseCsErrors(output: string): string[] {
  const regex = /error\s+CS\d+:\s*(.+)/gi;
  const matches = output.matchAll(regex);
  const errors = Array.from(matches, (m) => m[1]?.trim() ?? "").filter(Boolean);
  if (errors.length === 0) {
    // fallback: last 5 non-empty lines
    errors.push(
      ...output
        .split("\n")
        .filter((l) => l.trim())
        .slice(-5),
    );
  }
  return errors;
}

function safeWrapperClassName(code: string, className: string): string {
  // C# CS0542: 类名和方法名不能相同。检测到冲突时加 _Wrapper 后缀。
  const conflictPattern = new RegExp(
    `\\b${escapeRegExp(className)}\\s*\\(`,
    "i",
  );
  return conflictPattern.test(code) ? `${className}_Wrapper` : className;
}

function buildWrapperSource(code: string, className: string): string {
  const safeName = safeWrapperClassName(code, className);
  return `using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class ${safeName} {
${code}
}`;
}

/**
 * Resolve a target path supplied by a client whose workspace root may be an
 * ancestor of the configured skeleton project. The returned path remains
 * internal to the skeleton; callers can keep the original client path in the
 * generated patch for host-side validation.
 */
export function resolveProjectTargetFile(
  projectRoot: string,
  targetFilePath: string,
): ResolvedProjectTarget | null {
  const root = resolve(projectRoot);
  const normalizedTarget = targetFilePath.replace(/\\/g, "/");
  const segments = normalizedTarget.split("/");
  if (isAbsolute(targetFilePath) || segments.includes("..")) return null;

  const candidates = [resolve(root, targetFilePath)];
  const rootName = basename(root);
  const rootMarker = `${rootName}/`;
  const rootIndex = normalizedTarget.indexOf(rootMarker);
  if (rootIndex >= 0) {
    candidates.push(resolve(root, normalizedTarget.slice(rootIndex + rootMarker.length)));
  }

  for (const sourcePath of candidates) {
    const relativePath = relative(root, sourcePath);
    if (isOutsideProject(root, sourcePath) || !relativePath || !existsSync(sourcePath)) continue;
    return { sourcePath, relativePath };
  }
  return null;
}

function isOutsideProject(projectRoot: string, sourcePath: string): boolean {
  const relativePath = relative(projectRoot, sourcePath);
  return (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function replaceTargetCode(source: string, generatedCode: string): string {
  const code = stripGeneratedFence(generatedCode);
  return looksLikeTypeDeclaration(code)
    ? replaceTargetClass(source, code)
    : replaceTargetMethod(source, code);
}

function replacePythonTargetCode(source: string, generatedCode: string): string {
  const code = stripGeneratedFence(generatedCode);
  return /^\s*class\s+[A-Za-z_]\w*\b/m.test(code)
    ? replacePythonTargetClass(source, code)
    : replacePythonTargetMethod(source, code);
}

function stripGeneratedFence(generatedCode: string): string {
  return generatedCode
    .trim()
    .replace(/^```(?:[A-Za-z0-9_+-]+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function looksLikeTypeDeclaration(code: string): boolean {
  return /^\s*(?:(?:public|private|protected|internal|abstract|sealed|final|static|export|partial|pub)\s+)*(?:(?:class|record|struct|interface)\b|type\s+[A-Za-z_]\w*\s+struct\b)/m.test(code);
}

function replaceTargetClass(source: string, generatedCode: string): string {
  const code = stripGeneratedFence(generatedCode);
  const declaration = /\b(?:class|record|struct|interface)\s+([A-Za-z_]\w*)\b/.exec(code)
    ?? /\btype\s+([A-Za-z_]\w*)\s+struct\b/.exec(code);
  const className = declaration?.[1];
  if (!className) throw new Error("Generated code must contain a named target class.");

  const sourceDeclaration = new RegExp(
    `^[\\t ]*(?:(?:public|private|protected|internal|abstract|sealed|final|static|export|partial|pub)\\s+)*(?:class|record|struct|interface|type)\\s+${escapeRegExp(className)}\\b[^\\n]*`,
    "gm",
  ).exec(source);
  if (!sourceDeclaration?.index && sourceDeclaration?.index !== 0) {
    throw new Error(`Target class ${className} was not found in the skeleton source.`);
  }
  const sourceOpeningBrace = source.indexOf("{", sourceDeclaration.index);
  if (sourceOpeningBrace < 0) throw new Error(`Target class ${className} does not have a block body.`);
  const sourceClosingBrace = matchingBrace(source, sourceOpeningBrace);
  const declarationStart = source.lastIndexOf("\n", sourceDeclaration.index) + 1;
  const indentation = source.slice(declarationStart).match(/^\s*/)?.[0] ?? "";
  return `${source.slice(0, declarationStart)}${indentCode(code, indentation)}${source.slice(sourceClosingBrace + 1)}`;
}

function replaceTargetMethod(source: string, generatedCode: string): string {
  const code = generatedCode
    .trim()
    .replace(/^```(?:[A-Za-z0-9_+-]+)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const openingBrace = code.indexOf("{");
  if (openingBrace < 0) throw new Error("Generated code must contain a method body.");

  const generatedDeclarations = [...code.slice(0, openingBrace).matchAll(/([A-Za-z_]\w*)\s*\(/g)];
  const methodName = generatedDeclarations.at(-1)?.[1];
  if (!methodName) throw new Error("Unable to determine the generated method name.");

  const declarationPattern = new RegExp(
    `^[\\t ]*(?!(?:if|for|foreach|while|switch|catch|return|new)\\b)[^\\n;=]*\\b${escapeRegExp(methodName)}\\s*\\(`,
    "gm",
  );
  const expectedParameters = parameterList(code, 0);
  const sourceDeclarations = [...source.matchAll(declarationPattern)];
  const declaration = sourceDeclarations.find(
    (candidate) => parameterList(source, candidate.index ?? 0) === expectedParameters,
  ) ?? sourceDeclarations[0];
  if (declaration?.index === undefined) {
    throw new Error(`Target method ${methodName} was not found in the skeleton source.`);
  }
  const sourceOpeningBrace = source.indexOf("{", declaration.index);
  if (sourceOpeningBrace < 0) {
    throw new Error(`Target method ${methodName} does not have a block body.`);
  }
  const sourceClosingBrace = matchingBrace(source, sourceOpeningBrace);
  const declarationStart = source.lastIndexOf("\n", declaration.index) + 1;
  const indentation = source.slice(declarationStart).match(/^\s*/)?.[0] ?? "";
  const replacement = indentCode(code, indentation);

  return `${source.slice(0, declarationStart)}${replacement}${source.slice(sourceClosingBrace + 1)}`;
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && next === "*") {
      index = source.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error("Target method contains an unmatched brace.");
}

function indentCode(code: string, indentation: string): string {
  const lines = code.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim());
  const commonIndent = Math.min(
    ...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );
  return lines
    .map((line) => `${indentation}${line.slice(commonIndent)}`.trimEnd())
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parameterList(source: string, start: number): string {
  const opening = source.indexOf("(", start);
  if (opening < 0) return "";
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) {
      return source.slice(opening + 1, index).replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

// ---- Java 编译 ----

function findJavac(): string | null {
  const candidates = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "javac") : null,
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "javac.exe") : null,
    "javac",
    "javac.exe",
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

function findMaven(): string | null {
  const candidates = [
    process.env.MAVEN_COMMAND?.trim(),
    process.env.MAVEN_HOME ? join(process.env.MAVEN_HOME, "bin", "mvn") : null,
    process.env.M2_HOME ? join(process.env.M2_HOME, "bin", "mvn") : null,
    "mvn",
    "mvn.cmd",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue to the next known installation location.
    }
  }
  return null;
}

/**
 * 独立编译一个 Java 方法体，不依赖项目类型定义。
 * 把翻译后的方法放进一个最小 wrapper class，用 javac 验证。
 */
export function compileJavaStandalone(
  javaCode: string,
  className: string,
): CompileResult {
  const javac = findJavac();
  if (!javac) {
    return {
      success: false,
      errors: [
        "JDK not installed. Install a JDK and ensure javac is on PATH, or set JAVA_HOME.",
      ],
      output: "",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), ".forexplore-java-standalone-"));
  const directClass = looksLikeTypeDeclaration(javaCode);
  const fullSource = directClass ? stripGeneratedFence(javaCode) : buildJavaWrapperSource(javaCode, className);
  const declaredName = directClass
    ? /\b(?:class|record|interface|enum)\s+([A-Za-z_]\w*)\b/.exec(fullSource)?.[1]
    : className;
  const javaFile = join(dir, `${declaredName ?? className}.java`);
  writeFileSync(javaFile, fullSource, "utf-8");

  try {
    const stdout = execFileSync(javac, [javaFile], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      stdio: "pipe",
    });
    return { success: true, errors: [], output: stdout };
  } catch (e: unknown) {
    const errOutput = collectErrorOutput(e);
    const errors = parseJavaErrors(errOutput);
    return { success: false, errors, output: errOutput };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 集成编译 — 在临时副本中替换目标方法或类并编译完整 Java skeleton 项目。
 * Maven projects are compiled through their declared dependency graph; bare
 * source trees fall back to javac.
 */
export function compileJavaIntegrated(
  javaCode: string,
  skeletonProjectPath: string,
  targetFilePath: string,
): CompileResult {
  const javac = findJavac();
  if (!javac) {
    return {
      success: false,
      errors: [
        "JDK not installed. Install a JDK and ensure javac is on PATH, or set JAVA_HOME.",
      ],
      output: "",
    };
  }

  const projectRoot = resolve(skeletonProjectPath);
  const sourcePath = resolve(projectRoot, targetFilePath);
  const relativeTarget = relative(projectRoot, sourcePath);
  if (
    !relativeTarget ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    return {
      success: false,
      errors: [
        `Target file must stay inside the skeleton project. target: ${targetFilePath}, skeleton: ${projectRoot}`,
      ],
      output: "",
    };
  }
  if (!existsSync(sourcePath)) {
    return {
      success: false,
      errors: [`Target file does not exist in the skeleton project: ${targetFilePath}`],
      output: "",
    };
  }

  const temporaryProject = mkdtempSync(
    join(dirname(projectRoot), ".forexplore-java-integrated-"),
  );
  try {
    cpSync(projectRoot, temporaryProject, {
      recursive: true,
      filter: (source) => !["bin", "build", "target", "out"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const temporaryTarget = join(temporaryProject, relativeTarget);
    const original = readFileSync(temporaryTarget, "utf8");
    writeFileSync(temporaryTarget, replaceTargetCode(original, javaCode), "utf8");

    const maven = existsSync(join(temporaryProject, "pom.xml")) ? findMaven() : null;
    if (maven) {
      try {
        const stdout = execFileSync(maven, ["-q", "-DskipTests", "compile"], {
          cwd: temporaryProject,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 90_000,
          stdio: "pipe",
        });
        return { success: true, errors: [], output: stdout };
      } catch (error: unknown) {
        const errOutput = collectErrorOutput(error);
        return { success: false, errors: parseJavaErrors(errOutput), output: errOutput };
      }
    }

    const javaFiles = collectJavaFilesRecursive(temporaryProject);
    try {
      const stdout = execFileSync(javac, ["-d", join(temporaryProject, "out"), ...javaFiles], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (e: unknown) {
      const errOutput = collectErrorOutput(e);
      const errors = parseJavaErrors(errOutput);
      return { success: false, errors, output: errOutput };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message };
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

function buildJavaWrapperSource(code: string, className: string): string {
  const safeName = safeWrapperClassName(code, className);
  return `import java.util.*;
import java.util.stream.*;
import java.util.function.*;
import java.math.*;

public class ${safeName} {
${code}
}`;
}

function collectJavaFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...collectJavaFilesRecursive(full));
      } else if (entry.endsWith(".java")) {
        results.push(full);
      }
    }
  } catch {
    // Skip unreadable directories.
  }
  return results;
}

function parseJavaErrors(output: string): string[] {
  // javac errors look like: "File.java:10: error: ..."
  const regex = /error:\s*(.+)/gi;
  const matches = output.matchAll(regex);
  const errors = Array.from(matches, (m) => m[1]?.trim() ?? "").filter(Boolean);
  if (errors.length === 0) {
    errors.push(
      ...output
        .split("\n")
        .filter((l) => l.trim())
        .slice(-5),
    );
  }
  return errors;
}

// ---- TypeScript, Python, Rust, and Go compilers ----

function compileTypeScriptStandalone(code: string, className: string): CompileResult {
  const tsc = findTypeScriptCompiler();
  if (!tsc) return missingCompiler("TypeScript compiler", "Install TypeScript or make tsc available on PATH.");
  const source = /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(code)
    ? `${code.trim()}\n`
    : `export class ${safeWrapperClassName(code, className)} {\n${code}\n}\n`;
  return compileTemporary(
    ".forexplore-typescript-standalone-",
    `${className}.ts`,
    source,
    tsc,
    ["--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext"],
  );
}

function compilePythonStandalone(code: string, className: string): CompileResult {
  const python = findPython();
  if (!python) return missingCompiler("Python", "Install Python 3 or set PYTHON_COMMAND.");
  return compileTemporary(
    ".forexplore-python-standalone-",
    `${className}.py`,
    `${code.trim()}\n`,
    python,
    ["-m", "py_compile"],
  );
}

function compileRustStandalone(code: string, className: string): CompileResult {
  const rustc = findExecutable([process.env.RUSTC_COMMAND?.trim(), "rustc"]);
  if (!rustc) return missingCompiler("Rust compiler", "Install Rust or set RUSTC_COMMAND.");
  const source = /^\s*(?:pub\s+)?struct\b/.test(code) ||
    (/^\s*(?:pub\s+)?(?:async\s+)?fn\b/.test(code) && !/\(\s*&?(?:mut\s+)?self\b/.test(code))
    ? `${code.trim()}\n`
    : `pub struct ${safeWrapperClassName(code, className)};\n\nimpl ${safeWrapperClassName(code, className)} {\n${code}\n}\n`;
  return compileTemporary(
    ".forexplore-rust-standalone-",
    `${className}.rs`,
    source,
    rustc,
    ["--crate-type", "lib"],
  );
}

function compileGoStandalone(code: string, className: string): CompileResult {
  const go = findExecutable([process.env.GO_COMMAND?.trim(), "go"]);
  if (!go) return missingCompiler("Go compiler", "Install Go or set GO_COMMAND.");
  const receiverType = /func\s*\([^)]*\b\*?([A-Za-z_]\w*)\s*\)/.exec(code)?.[1];
  const receiverDeclaration = receiverType ? `type ${receiverType} struct{}\n` : "";
  return compileTemporary(
    ".forexplore-go-standalone-",
    `${className}.go`,
    `package forexplore\n\n${receiverDeclaration}${code.trim()}\n`,
    go,
    ["test"],
    "go.mod",
    "module forexplore\n\ngo 1.20\n",
  );
}

function compileTypeScriptIntegrated(code: string, projectPath: string, targetFilePath: string): CompileResult {
  const tsc = findTypeScriptCompiler();
  if (!tsc) return missingCompiler("TypeScript compiler", "Install TypeScript or make tsc available on PATH.");
  return compileIntegratedProject(code, projectPath, targetFilePath, "typescript", (dir, target) =>
    runCompiler(tsc, existsSync(join(dir, "tsconfig.json"))
      ? ["--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")]
      : ["--noEmit", "--pretty", "false", target]),
  );
}

function compilePythonIntegrated(code: string, projectPath: string, targetFilePath: string): CompileResult {
  const python = findPython();
  if (!python) return missingCompiler("Python", "Install Python 3 or set PYTHON_COMMAND.");
  return compileIntegratedProject(code, projectPath, targetFilePath, "python", (_dir, target) =>
    runCompiler(python, ["-m", "py_compile", target]),
  );
}

function compileRustIntegrated(code: string, projectPath: string, targetFilePath: string): CompileResult {
  const rustc = findExecutable([process.env.RUSTC_COMMAND?.trim(), "rustc"]);
  if (!rustc) return missingCompiler("Rust compiler", "Install Rust or set RUSTC_COMMAND.");
  const cargo = findExecutable([process.env.CARGO_COMMAND?.trim(), "cargo"]);
  return compileIntegratedProject(code, projectPath, targetFilePath, "rust", (dir, target) => {
    if (cargo && existsSync(join(dir, "Cargo.toml"))) return runCompiler(cargo, ["check", "--quiet"], dir);
    return runCompiler(rustc, ["--crate-type", "lib", target]);
  });
}

function compileGoIntegrated(code: string, projectPath: string, targetFilePath: string): CompileResult {
  const go = findExecutable([process.env.GO_COMMAND?.trim(), "go"]);
  if (!go) return missingCompiler("Go compiler", "Install Go or set GO_COMMAND.");
  return compileIntegratedProject(code, projectPath, targetFilePath, "go", (dir, target) => {
    if (existsSync(join(dir, "go.mod"))) return runCompiler(go, ["test", "./..."], dir);
    return runCompiler(go, ["test", target]);
  });
}

function compileIntegratedProject(
  code: string,
  projectPath: string,
  targetFilePath: string,
  language: "typescript" | "python" | "rust" | "go",
  compile: (temporaryProject: string, temporaryTarget: string) => CompileResult,
): CompileResult {
  const projectRoot = resolve(projectPath);
  const resolvedTarget = resolveProjectTargetFile(projectRoot, targetFilePath);
  if (!resolvedTarget) {
    return { success: false, errors: [`Target file does not exist in the project: ${targetFilePath}`], output: "" };
  }
  const temporaryProject = mkdtempSync(join(dirname(projectRoot), `.forexplore-${language}-integrated-`));
  try {
    cpSync(projectRoot, temporaryProject, {
      recursive: true,
      filter: (source) => !["bin", "obj", "build", "dist", "target", "out", "node_modules", "__pycache__"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const temporaryTarget = join(temporaryProject, resolvedTarget.relativePath);
    const original = readFileSync(temporaryTarget, "utf8");
    writeFileSync(
      temporaryTarget,
      language === "python" ? replacePythonTargetCode(original, code) : replaceTargetCode(original, code),
      "utf8",
    );
    return compile(temporaryProject, temporaryTarget);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message };
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

function compileTemporary(
  prefix: string,
  fileName: string,
  source: string,
  command: string,
  args: string[],
  extraFileName?: string,
  extraFileContent?: string,
): CompileResult {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const target = join(dir, fileName);
  writeFileSync(target, source, "utf8");
  if (extraFileName && extraFileContent) writeFileSync(join(dir, extraFileName), extraFileContent, "utf8");
  try {
    return runCompiler(command, [...args, target], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCompiler(command: string, args: string[], cwd?: string): CompileResult {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 90_000,
      stdio: "pipe",
    });
    return { success: true, errors: [], output };
  } catch (error: unknown) {
    const output = collectErrorOutput(error);
    return { success: false, errors: parseGenericErrors(output), output };
  }
}

function findExecutable(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Continue to the next configured executable.
    }
  }
  return null;
}

function findTypeScriptCompiler(): string | null {
  return findExecutable([
    process.env.TSC_COMMAND?.trim(),
    join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"),
    "tsc",
  ]);
}

function findPython(): string | null {
  return findExecutable([process.env.PYTHON_COMMAND?.trim(), "python3", "python"]);
}

function missingCompiler(name: string, instruction: string): CompileResult {
  return { success: false, errors: [`${name} not installed or not available. ${instruction}`], output: "" };
}

function parseGenericErrors(output: string): string[] {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.slice(-8).length > 0 ? lines.slice(-8) : ["Compiler failed without diagnostics."];
}

function replacePythonTargetClass(source: string, generatedCode: string): string {
  const code = stripGeneratedFence(generatedCode);
  const declaration = /^class\s+([A-Za-z_]\w*)\b/m.exec(code);
  const name = declaration?.[1];
  if (!name) throw new Error("Generated Python code must contain one class declaration.");
  const match = new RegExp(`^[\\t ]*class\\s+${escapeRegExp(name)}\\b`, "m").exec(source);
  if (!match || match.index === undefined) throw new Error(`Target Python class ${name} was not found in the project source.`);
  const start = match.index;
  const startLineEnd = source.indexOf("\n", start);
  const baseIndent = source.slice(start, startLineEnd < 0 ? source.length : startLineEnd).match(/^\s*/)?.[0].length ?? 0;
  let end = source.length;
  for (let index = startLineEnd < 0 ? source.length : startLineEnd + 1; index < source.length;) {
    const next = source.indexOf("\n", index);
    const lineEnd = next < 0 ? source.length : next;
    const line = source.slice(index, lineEnd);
    if (line.trim() && !line.trimStart().startsWith("#") && (line.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) {
      end = index;
      break;
    }
    index = next < 0 ? source.length : next + 1;
  }
  const indentation = source.slice(start, startLineEnd < 0 ? source.length : startLineEnd).match(/^\s*/)?.[0] ?? "";
  return `${source.slice(0, start)}${indentCode(code, indentation)}\n${source.slice(end)}`;
}

function replacePythonTargetMethod(source: string, generatedCode: string): string {
  const code = generatedCode.trim().replace(/^```(?:python|py)?\s*/i, "").replace(/\s*```$/, "").trim();
  const declaration = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/m.exec(code);
  const name = declaration?.[1];
  if (!name) throw new Error("Generated Python code must contain one def declaration.");
  const match = new RegExp(`^[\\t ]*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(`, "m").exec(source);
  if (!match || match.index === undefined) throw new Error(`Target Python method ${name} was not found in the project source.`);
  const start = match.index;
  const startLineEnd = source.indexOf("\n", start);
  const baseIndent = source.slice(start, startLineEnd < 0 ? source.length : startLineEnd).match(/^\s*/)?.[0].length ?? 0;
  let end = source.length;
  for (let index = startLineEnd < 0 ? source.length : startLineEnd + 1; index < source.length;) {
    const next = source.indexOf("\n", index);
    const lineEnd = next < 0 ? source.length : next;
    const line = source.slice(index, lineEnd);
    if (line.trim() && !line.trimStart().startsWith("#") && (line.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) {
      end = index;
      break;
    }
    index = next < 0 ? source.length : next + 1;
  }
  const indentation = source.slice(start, startLineEnd < 0 ? source.length : startLineEnd).match(/^\s*/)?.[0] ?? "";
  return `${source.slice(0, start)}${indentCode(code, indentation)}\n${source.slice(end)}`;
}

export const compilerInternals = {
  buildWrapperSource,
  buildJavaWrapperSource,
  replaceTargetMethod,
  replaceTargetCode,
  replaceTargetClass,
  resolveProjectTargetFile,
  parseJavaErrors,
  replacePythonTargetCode,
  replacePythonTargetClass,
  replacePythonTargetMethod,
};
