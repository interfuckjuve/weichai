/**
 * Language-registry compiler validation helpers.
 */

import { execFileSync, execSync } from "node:child_process";
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
import type { Language } from "@forexplore/contracts";

export interface CompileResult {
  success: boolean;
  errors: string[];
  output: string;
  /** 集成编译保留的工作区副本绝对路径(仅集成编译返回;保留供差分验证与调试)。 */
  workspacePath?: string;
}

/**
 * Language-neutral validation entry points used by the adaptation workflow.
 * Individual compilers remain implementation details behind this registry.
 */
export function compileTargetStandalone(
  language: Language,
  code: string,
  targetName: string,
): CompileResult {
  switch (language) {
    case "Java": return compileJavaStandalone(code, targetName);
    case "C#": return compileStandalone(code, targetName);
    case "TypeScript": return compileTypeScriptStandalone(code, targetName);
    case "Python": return compilePythonStandalone(code, targetName);
    case "Rust": return compileRustStandalone(code, targetName);
    case "Go": return compileGoStandalone(code, targetName);
  }
}

export function compileTargetIntegrated(
  language: Language,
  code: string,
  projectPath: string,
  targetFilePath: string,
): CompileResult {
  switch (language) {
    case "Java": return compileJavaIntegrated(code, projectPath, targetFilePath);
    case "C#": return compileIntegrated(code, projectPath, targetFilePath);
    case "TypeScript": return compileTypeScriptIntegrated(code, projectPath, targetFilePath);
    case "Python": return compilePythonIntegrated(code, projectPath, targetFilePath);
    case "Rust": return compileRustIntegrated(code, projectPath, targetFilePath);
    case "Go": return compileGoIntegrated(code, projectPath, targetFilePath);
  }
}

export function compilerCommand(language: Language): string {
  switch (language) {
    case "Java": return "javac";
    case "C#": return "dotnet build --nologo -v q";
    case "TypeScript": return "tsc --noEmit";
    case "Python": return "python -m py_compile";
    case "Rust": return "rustc";
    case "Go": return "go test";
  }
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
    if (hasCsc()) {
      return compileWithCsc(dir, csFile);
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
  const temporaryProject = preservedWorkspacePath(projectRoot, "csharp", targetFilePath);
  // 重建保证与当前生成代码一致;保留目录不随编译结束删除(供差分验证/调试)。
  rmSync(temporaryProject, { recursive: true, force: true });
  try {
    cpSync(projectRoot, temporaryProject, {
      recursive: true,
      filter: (source) => !["bin", "obj"].includes(source.split(/[\\/]/).at(-1) ?? ""),
    });
    const temporaryTarget = join(temporaryProject, relativeTarget);
    const original = readFileSync(temporaryTarget, "utf8");
    writeFileSync(temporaryTarget, replaceTargetCode(original, csharpCode), "utf8");
    const result = compileWithDotnet(dotnet, temporaryProject, false);
    return { ...result, workspacePath: temporaryProject };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message, workspacePath: temporaryProject };
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
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
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

function hasCsc(): boolean {
  const paths = [
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return paths.some((p) => existsSync(p));
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

function compileWithCsc(dir: string, csFile: string): CompileResult {
  const dllPath = join(dir, "test.dll");
  try {
    const stdout = execSync(
      `csc /target:library /out:"${dllPath}" /nologo "${csFile}"`,
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
    return String(obj.stdout ?? obj.stderr ?? obj.message ?? String(e));
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
  const baseUsings = [
    "using System;",
    "using System.Collections.Generic;",
    "using System.Linq;",
    "using System.Globalization;",
    "using System.Text;",
    "using System.Threading;",
    "using System.Threading.Tasks;",
  ];
  const extra = csharpRequiredUsings(code)
    .map((ns) => `using ${ns};`)
    .join("\n");
  return `${baseUsings.join("\n")}${extra ? `\n${extra}` : ""}\n\npublic class ${safeName} {\n${code}\n}`;
}

/**
 * 常见 C# 类型 → 命名空间映射(按需 using 检测用)。
 * 命中简单名且代码中未全限定/未显式 using 时,返回需要补齐的命名空间。
 */
const CSHARP_NAMESPACE_TYPES: Array<readonly [namespace: string, types: readonly string[]]> = [
  ["System.IO", ["Stream", "MemoryStream", "FileStream", "BufferedStream", "StreamReader", "StreamWriter", "StringReader", "StringWriter", "TextReader", "TextWriter", "BinaryReader", "BinaryWriter", "IOException", "File", "FileInfo", "Directory", "DirectoryInfo", "Path"]],
  ["System.Text", ["Encoding", "StringBuilder", "UTF8Encoding", "UnicodeEncoding", "Decoder", "Encoder"]],
  ["System.Text.RegularExpressions", ["Regex", "Match", "MatchCollection", "Group", "RegexOptions"]],
  ["System.Globalization", ["CultureInfo", "NumberFormatInfo", "DateTimeFormatInfo"]],
  ["System.Net", ["WebRequest", "WebResponse", "WebClient", "HttpWebRequest", "HttpWebResponse"]],
  ["System.Collections.Specialized", ["NameValueCollection", "StringCollection"]],
];

/** 按需检测 C# 代码需要补齐的命名空间(已有 using 或全限定引用的跳过)。 */
export function csharpRequiredUsings(code: string): string[] {
  const existingUsings = new Set(
    [...code.matchAll(/^\s*using\s+([A-Za-z0-9_.]+)\s*;/gm)].map((m) => m[1] ?? ""),
  );
  const required: string[] = [];
  for (const [ns, types] of CSHARP_NAMESPACE_TYPES) {
    if (existingUsings.has(ns) || code.includes(`${ns}.`)) continue;
    if (types.some((t) => new RegExp(`\\b${t}\\b`).test(code))) required.push(ns);
  }
  return required;
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

/**
 * 集成编译的固定保留目录:<parent>/.forexplore-target-<language>-<basename>/。
 * 固定名便于调试查看;调用方负责在不需要时清理。
 */
function preservedWorkspacePath(projectRoot: string, language: string, targetFilePath: string): string {
  const base = basename(targetFilePath).replace(/\\.(?:java|cs|ts|tsx|py|go|rs)$/i, "") || "target";
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(dirname(projectRoot), `.forexplore-target-${language}-${safe}`);
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

  const temporaryProject = preservedWorkspacePath(projectRoot, "java", targetFilePath);
  rmSync(temporaryProject, { recursive: true, force: true });
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
        return { success: true, errors: [], output: stdout, workspacePath: temporaryProject };
      } catch (error: unknown) {
        const errOutput = collectErrorOutput(error);
        return { success: false, errors: parseJavaErrors(errOutput), output: errOutput, workspacePath: temporaryProject };
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
      return { success: true, errors: [], output: stdout, workspacePath: temporaryProject };
    } catch (e: unknown) {
      const errOutput = collectErrorOutput(e);
      const errors = parseJavaErrors(errOutput);
      return { success: false, errors, output: errOutput, workspacePath: temporaryProject };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message, workspacePath: temporaryProject };
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
  const temporaryProject = preservedWorkspacePath(projectRoot, language, targetFilePath);
  rmSync(temporaryProject, { recursive: true, force: true });
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
    const result = compile(temporaryProject, temporaryTarget);
    return { ...result, workspacePath: temporaryProject };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, errors: [message], output: message, workspacePath: temporaryProject };
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
  csharpRequiredUsings,
  replaceTargetMethod,
  replaceTargetCode,
  replaceTargetClass,
  resolveProjectTargetFile,
  parseJavaErrors,
  replacePythonTargetCode,
  replacePythonTargetClass,
  replacePythonTargetMethod,
};
