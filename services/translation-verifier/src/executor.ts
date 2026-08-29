import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { VerifierLanguage } from "./description.js";
import { createLogger, type Logger } from "./logger.js";

const require = createRequire(import.meta.url);

export interface CompileOutcome {
  success: boolean;
  errors: string[];
  output: string;
}

export interface RunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SideFile {
  relativePath: string;
  content: string;
}

export interface SideSpec {
  language: VerifierLanguage;
  driverSource: string;
  sourceFiles: SideFile[];
  projectRoot?: string;
  /** 复用已有项目目录(不复制、不删除):driver 与 sourceFiles 直接写入该目录后编译运行。 */
  reuseDir?: string;
}

export interface DriverExecutor {
  compile(side: SideSpec): Promise<CompileOutcome>;
  run(side: SideSpec): Promise<RunOutcome>;
}

export interface RealExecutorOptions {
  javacPath?: string;
  javaPath?: string;
  dotnetPath?: string;
  pythonPath?: string;
  nodePath?: string;
  tsxPath?: string;
  timeoutMs?: number;
  /** 注入的 logger;默认 createLogger("executor")。 */
  logger?: Logger;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** 探测 javac / dotnet 是否在 PATH(供测试 skipIf 与调用方预检)。未知语言抛错。 */
export function isToolchainAvailable(language: VerifierLanguage): boolean {
  if (language === "Java") return findOnPath("javac");
  if (language === "C#") return findOnPath("dotnet");
  if (language === "Python") return findOnPath("python3") || findOnPath("python");
  if (language === "TypeScript") return findOnPath("node") && packageEntry("tsx/cli") !== null;
  throw new Error(`Unsupported language: ${String(language)}`);
}

function packageEntry(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function findOnPath(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v '${name}'`], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 真实工具链执行器:mkdtemp 临时目录内写 driver 与 sourceFiles(保持相对路径、建父目录),
 * Java → `javac -d out` + `java -cp out`;C# → 生成 Verifier.csproj + `dotnet build` + `dotnet run --no-build`。
 * 超时默认 60s;javacPath/javaPath/dotnetPath 可注入。
 */
export class RealDriverExecutor implements DriverExecutor {
  readonly #options: Required<Omit<RealExecutorOptions, "logger">>;
  readonly #logger: Logger;

  constructor(options: RealExecutorOptions = {}) {
    this.#options = {
      javacPath: options.javacPath ?? "javac",
      javaPath: options.javaPath ?? "java",
      dotnetPath: options.dotnetPath ?? "dotnet",
      pythonPath: options.pythonPath ?? (findOnPath("python3") ? "python3" : "python"),
      nodePath: options.nodePath ?? "node",
      tsxPath: options.tsxPath ?? packageEntry("tsx/cli") ?? "",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.#logger = options.logger ?? createLogger("executor");
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    try {
      validateSideSpec(side);
    } catch (error) {
      const output = `Invalid verifier side specification: ${errorOutput(error)}`;
      this.#logger.error(output);
      return { success: false, errors: [output], output };
    }
    const reuseDir = side.reuseDir;
    if (side.language === "Java" && reuseDir && existsSync(join(reuseDir, "pom.xml"))) {
      return this.#compileJavaProject(side, reuseDir);
    }
    if (side.language === "Java" && side.projectRoot && existsSync(join(side.projectRoot, "pom.xml"))) {
      return this.#compileJavaProject(side);
    }
    const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
        this.#logger.debug(`编译命令(Java): javac -d out (${javaFiles.length} 个 .java 文件)`);
        const outcome = this.#compileJava(dir);
        this.#logCompileOutcome(side, outcome);
        return outcome;
      }
      if (side.language === "C#") {
        this.#logger.debug("编译命令(C#): dotnet build --nologo -v q (Verifier.csproj)");
        const outcome = await this.#compileCSharp(dir, side);
        this.#logCompileOutcome(side, outcome);
        return outcome;
      }
      if (side.language === "Python") {
        this.#logger.debug(`编译命令(Python): ${this.#options.pythonPath} -m py_compile`);
        const outcome = this.#compilePython(dir);
        this.#logCompileOutcome(side, outcome);
        return outcome;
      }
      this.#logger.debug("编译命令(TypeScript): tsc --noEmit");
      const outcome = await this.#compileTypeScript(dir);
      this.#logCompileOutcome(side, outcome);
      return outcome;
    } finally {
      if (!reuseDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 编译结果摘要(成功→debug 输出长度;失败→error 含诊断输出)。 */
  #logCompileOutcome(side: SideSpec, outcome: CompileOutcome): void {
    if (outcome.success) {
      this.#logger.debug(`编译成功(${side.language}): ${outcome.output.length} chars`);
      return;
    }
    const errors = outcome.errors.length > 0 ? outcome.errors.join("; ") : "(无解析错误行)";
    this.#logger.error(`编译失败(${side.language}): ${errors}\n${truncate(outcome.output, 1000)}`);
  }

  #compileJava(dir: string): CompileOutcome {
    try {
      const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
      const stdout = execFileSync(this.#options.javacPath, ["-d", join(dir, "out"), ...javaFiles], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseJavaErrors(output), output };
    }
  }

  async #compileCSharp(dir: string, side: SideSpec): Promise<CompileOutcome> {
    writeFileSync(join(dir, "Verifier.csproj"), csprojContent(side), "utf-8");
    try {
      const stdout = await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
        cwd: dir,
        timeoutMs: this.#options.timeoutMs,
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseDotnetErrors(output), output };
    }
  }

  #compilePython(dir: string): CompileOutcome {
    try {
      const pythonFiles = collectRelativeFiles(dir).filter((file) => file.endsWith(".py"));
      const stdout = execFileSync(this.#options.pythonPath, ["-m", "py_compile", ...pythonFiles], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parsePythonErrors(output), output };
    }
  }

  async #compileTypeScript(dir: string): Promise<CompileOutcome> {
    try {
      const typeScriptFiles = collectRelativeFiles(dir).filter((file) => file.endsWith(".ts"));
      const stdout = await execFileAsync(
        this.#options.nodePath,
        [
          typescriptCompilerEntry(),
          "--noEmit",
          "--target",
          "ES2022",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--allowImportingTsExtensions",
          "--skipLibCheck",
          "--types",
          "node",
          "--typeRoots",
          nodeTypeRoots(),
          ...typeScriptFiles,
        ],
        { cwd: dir, timeoutMs: this.#options.timeoutMs },
      );
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseTypeScriptErrors(output), output };
    }
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    try {
      validateSideSpec(side);
    } catch (error) {
      const output = `Invalid verifier side specification: ${errorOutput(error)}`;
      this.#logger.error(output);
      return { exitCode: 1, stdout: "", stderr: output };
    }
    const reuseDir = side.reuseDir;
    if (side.language === "Java" && reuseDir && existsSync(join(reuseDir, "pom.xml"))) {
      return this.#runJavaProject(side, reuseDir);
    }
    if (side.language === "Java" && side.projectRoot && existsSync(join(side.projectRoot, "pom.xml"))) {
      return this.#runJavaProject(side);
    }
    const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "forexplore-verifier-"));
    try {
      writeSideFiles(dir, side);
      if (side.language === "Java") {
        const javaFiles = collectRelativeFiles(dir).filter((f) => f.endsWith(".java"));
        execFileSync(this.#options.javacPath, ["-d", join(dir, "out"), ...javaFiles], {
          cwd: dir,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.#options.timeoutMs,
          stdio: "pipe",
        });
        const className = driverQualifiedNameFromSource(side.driverSource);
        this.#logger.debug(`运行命令(Java): java -cp out ${className}`);
        const stdout = await execFileAsync(this.#options.javaPath, ["-cp", join(dir, "out"), className], {
          cwd: dir,
          timeoutMs: this.#options.timeoutMs,
        });
        this.#logger.debug(`运行 stdout(Java,截断):\n${truncate(stdout, 500)}`);
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (side.language === "C#") {
        writeFileSync(join(dir, "Verifier.csproj"), csprojContent(side), "utf-8");
        await execFileAsync(this.#options.dotnetPath, ["build", "--nologo", "-v", "q"], {
          cwd: dir,
          timeoutMs: this.#options.timeoutMs,
        });
        this.#logger.debug("运行命令(C#): dotnet run --no-build --project Verifier.csproj");
        const stdout = await execFileAsync(
          this.#options.dotnetPath,
          ["run", "--no-build", "--project", "Verifier.csproj"],
          { cwd: dir, timeoutMs: this.#options.timeoutMs },
        );
        this.#logger.debug(`运行 stdout(C#,截断):\n${truncate(stdout, 500)}`);
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (side.language === "Python") {
        this.#logger.debug(`运行命令(Python): ${this.#options.pythonPath} driver.py`);
        const stdout = await execFileAsync(this.#options.pythonPath, ["driver.py"], {
          cwd: dir,
          timeoutMs: this.#options.timeoutMs,
          env: runtimeEnvironment(dir, side),
        });
        this.#logger.debug(`运行 stdout(Python,截断):\n${truncate(stdout, 500)}`);
        return { exitCode: 0, stdout, stderr: "" };
      }
      this.#logger.debug("运行命令(TypeScript): node tsx driver.ts");
      const stdout = await execFileAsync(this.#options.nodePath, [this.#options.tsxPath, "driver.ts"], {
        cwd: dir,
        timeoutMs: this.#options.timeoutMs,
      });
      this.#logger.debug(`运行 stdout(TypeScript,截断):\n${truncate(stdout, 500)}`);
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const output = errorOutput(error);
      this.#logger.error(`运行失败(${side.language}):\n${truncate(output, 1000)}`);
      return { exitCode: 1, stdout: "", stderr: output };
    } finally {
      if (!reuseDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  #compileJavaProject(side: SideSpec, reuseDir?: string): CompileOutcome {
    const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "forexplore-verifier-project-"));
    try {
      if (!reuseDir) {
        mkdirSync(dir, { recursive: true });
        cpSync(side.projectRoot!, dir, {
          recursive: true,
          filter: (source) => !["target", ".git", "node_modules"].includes(source.split(/[\\/]/).at(-1) ?? ""),
        });
      }
      writeSideFiles(dir, side);
      return this.#runMavenCompile(dir);
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: [output], output };
    } finally {
      if (!reuseDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  async #runJavaProject(side: SideSpec, reuseDir?: string): Promise<RunOutcome> {
    const dir = reuseDir ?? mkdtempSync(join(tmpdir(), "forexplore-verifier-project-"));
    try {
      if (!reuseDir) {
        mkdirSync(dir, { recursive: true });
        cpSync(side.projectRoot!, dir, {
          recursive: true,
          filter: (source) => !["target", ".git", "node_modules"].includes(source.split(/[\\/]/).at(-1) ?? ""),
        });
      }
      writeSideFiles(dir, side);
      const compile = this.#runMavenCompile(dir);
      if (!compile.success) return { exitCode: 1, stdout: "", stderr: compile.output };
      const classpath = this.#mavenClasspath(dir);
      const driverClasses = join(dir, ".verifier-driver-classes");
      mkdirSync(driverClasses, { recursive: true });
      const driverFile = join(dir, `${driverClassNameFromSource(side.driverSource)}.java`);
      execFileSync(this.#options.javacPath, ["-cp", classpath, "-d", driverClasses, driverFile], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      const stdout = await execFileAsync(
        this.#options.javaPath,
        ["-cp", [driverClasses, join(dir, "target/classes"), classpath].join(delimiter), driverQualifiedNameFromSource(side.driverSource)],
        { cwd: dir, timeoutMs: this.#options.timeoutMs },
      );
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: errorOutput(error) };
    } finally {
      if (!reuseDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  #runMavenCompile(dir: string): CompileOutcome {
    try {
      const stdout = execFileSync(process.env.MAVEN_COMMAND?.trim() || "mvn", ["-q", "-DskipTests", "compile"], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
      return { success: true, errors: [], output: stdout };
    } catch (error) {
      const output = errorOutput(error);
      return { success: false, errors: parseJavaErrors(output), output };
    }
  }

  #mavenClasspath(dir: string): string {
    const outputFile = join(dir, ".verifier-classpath");
    try {
      execFileSync(process.env.MAVEN_COMMAND?.trim() || "mvn", ["-q", "dependency:build-classpath", `-Dmdep.outputFile=${outputFile}`, "-Dmdep.includeScope=compile"], {
        cwd: dir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#options.timeoutMs,
        stdio: "pipe",
      });
    } catch {
      // A project with no external runtime dependencies still has a valid empty classpath.
    }
    const dependencyClasspath = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
    return [join(dir, "target/classes"), dependencyClasspath].filter(Boolean).join(delimiter);
  }
}

/** 截断长文本(如编译/运行输出),附带截断标记。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/**
 * A `SideSpec` can originate from a model or retrieved candidate.  File names
 * must therefore be treated as hostile even though their contents are written
 * only to a temporary directory.  In particular, do not let `../`, drive/UNC
 * paths, or a symlink inherited from a copied project escape that directory.
 */
function validateSideSpec(side: SideSpec): void {
  const extension = sourceExtensionFor(side.language);
  const seen = new Set<string>();
  for (const file of side.sourceFiles) {
    if (typeof file.relativePath !== "string" || typeof file.content !== "string") {
      throw new Error("Verifier source files must have string paths and content.");
    }
    const canonical = canonicalRelativeSidePath(file.relativePath);
    if (!canonical.endsWith(extension)) {
      throw new Error(`Verifier ${side.language} source file must end with ${extension}: ${file.relativePath}`);
    }
    if (seen.has(canonical)) {
      throw new Error(`Verifier side contains duplicate source file path: ${file.relativePath}`);
    }
    seen.add(canonical);
  }
}

function sourceExtensionFor(language: VerifierLanguage): string {
  switch (language) {
    case "Java": return ".java";
    case "C#": return ".cs";
    case "Python": return ".py";
    case "TypeScript": return ".ts";
  }
}

function canonicalRelativeSidePath(filePath: string): string {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("Verifier source file paths must be non-empty and cannot contain NUL.");
  }
  const portablePath = filePath.replaceAll("\\", "/");
  if (
    portablePath.startsWith("/") ||
    isAbsolute(filePath) ||
    /^[A-Za-z]:/.test(portablePath)
  ) {
    throw new Error(`Verifier source file path must be relative: ${filePath}`);
  }
  const segments = portablePath.split("/").filter((segment) => segment && segment !== ".");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === ".." || segment.includes(":"))
  ) {
    throw new Error(`Verifier source file path escapes the execution directory: ${filePath}`);
  }
  return segments.join("/");
}

function resolveSideFilePath(root: string, filePath: string): string {
  const canonical = canonicalRelativeSidePath(filePath);
  const fullPath = resolve(root, ...canonical.split("/"));
  const relativePath = relative(root, fullPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Verifier source file path escapes the execution directory: ${filePath}`);
  }
  return fullPath;
}

function ensureSafeParentDirectory(root: string, fullPath: string): void {
  const parent = dirname(fullPath);
  const relativeParent = relative(root, parent);
  if (!relativeParent || relativeParent === ".") return;
  let current = root;
  for (const segment of relativeParent.split(sep)) {
    if (!segment || segment === ".") continue;
    current = join(current, segment);
    const entry = lstatIfPresent(current);
    if (entry) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Verifier source file parent is not a safe directory: ${relative(root, current)}`);
      }
      continue;
    }
    mkdirSync(current);
  }
}

function lstatIfPresent(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 把 sourceFiles 与 driver 写入临时目录;sourceFiles 保持相对路径并建父目录。 */
function writeSideFiles(dir: string, side: SideSpec): void {
  for (const file of side.sourceFiles) {
    const fullPath = resolveSideFilePath(dir, file.relativePath);
    ensureSafeParentDirectory(dir, fullPath);
    if (lstatIfPresent(fullPath)?.isSymbolicLink()) {
      throw new Error(`Verifier source file path resolves through a symbolic link: ${file.relativePath}`);
    }
    writeFileSync(fullPath, file.content, "utf-8");
  }
  // Java requires a public class name match; dynamic-language drivers use a stable script name.
  const driverFile = driverFilePath(dir, side);
  writeFileSync(driverFile, side.driverSource, "utf-8");
  if (side.language === "TypeScript") {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n', "utf-8");
  }
}

function driverFilePath(dir: string, side: SideSpec): string {
  switch (side.language) {
    case "Java":
      return join(dir, `${driverClassNameFromSource(side.driverSource)}.java`);
    case "C#":
      return join(dir, "Driver.cs");
    case "Python":
      return join(dir, "driver.py");
    case "TypeScript":
      return join(dir, "driver.ts");
  }
}

/**
 * 从 driver 源码提取 public 类名(Java 与 C# 通用)。
 * 生成的 driver 只有一个 public 顶层类(其余为包内/嵌套类),首个匹配即驱动类。
 */
function driverClassNameFromSource(source: string): string {
  const match = /public\s+class\s+(\w+)/.exec(source);
  if (!match?.[1]) throw new Error("Driver source must declare a public class.");
  return match[1];
}

/**
 * 驱动类的全限定名:驱动源码含 package 声明(Java 包私有类访问需要同包)时返回
 * "pkg.ClassName",否则返回类名。java -cp 运行入口必须用全限定名。
 */
function driverQualifiedNameFromSource(source: string): string {
  const pkgMatch = /^\s*package\s+([\w.]+)\s*;/m.exec(source);
  const className = driverClassNameFromSource(source);
  return pkgMatch?.[1] ? `${pkgMatch[1]}.${className}` : className;
}

function collectRelativeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 生成 Verifier.csproj:OutputType Exe、StartupObject=驱动类名、TargetFramework net8.0、LangVersion latest。
 * RollForward=LatestMajor:仅装了更新 .NET runtime 的机器上(如 .NET 10)仍可运行 net8.0 应用。
 */
function csprojContent(side: SideSpec): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <RollForward>LatestMajor</RollForward>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
    <StartupObject>${driverClassNameFromSource(side.driverSource)}</StartupObject>
    <AssemblyName>Verifier</AssemblyName>
  </PropertyGroup>
</Project>
`;
}

function requiredPackageEntry(specifier: string): string {
  const entry = packageEntry(specifier);
  if (!entry) throw new Error(`Required package entry is unavailable: ${specifier}`);
  return entry;
}

function typescriptCompilerEntry(): string {
  const entry = requiredPackageEntry("typescript");
  return join(dirname(entry), "tsc.js");
}

function nodeTypeRoots(): string {
  return dirname(dirname(requiredPackageEntry("@types/node/package.json")));
}

function runtimeEnvironment(dir: string, side: SideSpec): NodeJS.ProcessEnv {
  if (side.language !== "Python") return process.env;
  const roots = new Set([dir]);
  for (const file of side.sourceFiles) {
    const [first, second] = file.relativePath.replace(/\\/g, "/").split("/");
    if (first && second) roots.add(join(dir, first));
  }
  return {
    ...process.env,
    PYTHONPATH: [...roots, process.env.PYTHONPATH].filter((entry): entry is string => Boolean(entry)).join(delimiter),
  };
}

function execFileAsync(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: options.timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          // Node 24 的 execFile error 对象不再附带 stdout/stderr,这里手动补上,供 errorOutput 解析编译诊断。
          (error as Error & { stdout?: string; stderr?: string }).stdout = stdout ?? "";
          (error as Error & { stdout?: string; stderr?: string }).stderr = stderr ?? "";
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function errorOutput(error: unknown): string {
  if (error instanceof Error) {
    const stdErr = (error as Error & { stderr?: string }).stderr;
    const stdOut = (error as Error & { stdout?: string }).stdout;
    return [stdErr, stdOut, error.message].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n");
  }
  return String(error);
}

/** Java 编译错误行:含 "error:" 或 "错误:"(中文 locale javac)。 */
function parseJavaErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /error:|错误:/.test(line))
    .map((line) => line.trim());
}

/** C# 编译错误行:含 "error CS…" / "error MSB…"。 */
function parseDotnetErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /error\s*[A-Z]{2,}/.test(line))
    .map((line) => line.trim());
}

function parsePythonErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /SyntaxError|IndentationError|Error:/.test(line))
    .map((line) => line.trim());
}

function parseTypeScriptErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => /error TS\d+:/.test(line))
    .map((line) => line.trim());
}

/**
 * 可注入 fake:compileResults / runResults(值或函数)可注入,调用参数记录在 compileCalls / runCalls。
 * 未注入时构造即抛错,防止误把 fake 当真实执行器用。
 */
export class FakeDriverExecutor implements DriverExecutor {
  #compileResults: CompileOutcome | ((side: SideSpec) => CompileOutcome);
  #runResults: RunOutcome | ((side: SideSpec) => RunOutcome);
  readonly compileCalls: SideSpec[] = [];
  readonly runCalls: SideSpec[] = [];

  constructor(options: {
    compileResults?: CompileOutcome | ((side: SideSpec) => CompileOutcome);
    runResults?: RunOutcome | ((side: SideSpec) => RunOutcome);
  } = {}) {
    if (!options.compileResults || !options.runResults) {
      throw new Error("FakeDriverExecutor requires compileResults and runResults.");
    }
    this.#compileResults = options.compileResults;
    this.#runResults = options.runResults;
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    this.compileCalls.push(side);
    return typeof this.#compileResults === "function" ? this.#compileResults(side) : this.#compileResults;
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    this.runCalls.push(side);
    return typeof this.#runResults === "function" ? this.#runResults(side) : this.#runResults;
  }
}
