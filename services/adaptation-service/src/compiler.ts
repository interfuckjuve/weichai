/**
 * C# / Java 编译校验器
 * 调用 dotnet build / csc 检查 C# 代码，调用 javac 检查 Java 代码。
 */

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export type CompileTarget = "C#" | "Java";

export interface CompileResult {
  success: boolean;
  errors: string[];
  output: string;
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
 * 集成编译 — 在临时副本中替换目标方法并编译完整 C# skeleton。
 */
export function compileIntegrated(
  csharpCode: string,
  skeletonProjectPath: string,
  targetFilePath: string,
): CompileResult {
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
    writeFileSync(temporaryTarget, replaceTargetMethod(original, csharpCode), "utf8");
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
    /(?:\.NET SDK|C# compiler).*(?:not installed|not available)/i.test(error),
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
  return `using System;
using System.Collections.Generic;
using System.Linq;
using System.Globalization;
using System.Text;

public class ${safeName} {
${code}
}`;
}

function replaceTargetMethod(source: string, generatedCode: string): string {
  const code = generatedCode
    .trim()
    .replace(/^```(?:csharp|cs)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const openingBrace = code.indexOf("{");
  if (openingBrace < 0) throw new Error("Generated C# code must contain a method body.");

  const declarations = [...code.slice(0, openingBrace).matchAll(/([A-Za-z_]\w*)\s*\(/g)];
  const methodName = declarations.at(-1)?.[1];
  if (!methodName) throw new Error("Unable to determine the generated C# method name.");

  const declaration = new RegExp(
    `^[\\t ]*(?:(?:public|private|protected|internal|static|abstract|virtual|override|sealed|async|extern|unsafe|new|partial)\\s+)+[^\\n;=]*\\b${escapeRegExp(methodName)}\\s*\\(`,
    "m",
  ).exec(source);
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
  const fullSource = buildJavaWrapperSource(javaCode, className);
  const javaFile = join(dir, `${className}.java`);
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
 * 集成编译 — 在临时副本中替换目标方法并编译完整 Java skeleton 项目。
 * 尝试用 javac + classpath 编译，如果项目有 Maven/Gradle 也会尝试。
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
    writeFileSync(temporaryTarget, replaceTargetMethod(original, javaCode), "utf8");

    // Collect all .java files under the project for classpath compilation
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
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
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

export { findJavac as _findJavac };
export const compilerInternals = { replaceTargetMethod };
