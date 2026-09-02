/**
 * 数据集加载/校验 + QualityTask 构造。
 *
 * - loadDataset:读 JSON 文件并做 schema 校验(容错,非法 entry 剔除并返回错误清单);
 * - buildTask:按 entry 的文件路径从磁盘读取源码,构造 source/target SideSpec 模板
 *   (driverSource 由度量阶段按生成的描述重建);
 * - Java 源侧特殊处理:若源文件位于 maven 项目(pom.xml 向上探测),收集整个
 *   src/main/java 下的全部 .java 文件作为 sourceFiles——跨包 import(如
 *   ParameterParser → util.mime.MimeUtility)在单文件 javac 下无法解析,整项目编译
 *   是正确性的前提;projectRoot 不设置,走普通 javac 而非慢速 mvn。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { TestDescription, TypedValue } from "../description.js";
import type { SideSpec } from "../executor.js";
import type { DatasetEntry, QualityDataset, QualityTask } from "./types.js";

// ---------------------------------------------------------------------------
// 仓库根探测(CLI 默认解析 entry 文件路径的基准)
// ---------------------------------------------------------------------------

/** 从 cwd 向上探测 monorepo 根(含 package.json 且存在 services 目录);找不到回退 cwd。 */
export function findRepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "services"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// 数据集加载与校验
// ---------------------------------------------------------------------------

export interface LoadResult {
  dataset: QualityDataset | null;
  errors: string[];
}

/** 读取并校验数据集 JSON;校验失败的 entry 剔除(errors 记录),全失败返回 null。 */
export function loadDataset(path: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf-8");
  } catch (error) {
    return { dataset: null, errors: [`无法读取数据集文件 ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { dataset: null, errors: [`数据集 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateDataset(value);
}

/** 数据集 schema 校验(容错:单条非法剔除并记录,不整体失败)。 */
export function validateDataset(value: unknown): LoadResult {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { dataset: null, errors: ["数据集必须是 JSON 对象。"] };
  }
  const d = value as Record<string, unknown>;
  const schemaVersion = typeof d.schemaVersion === "string" ? d.schemaVersion : "1.0";
  const source = typeof d.source === "string" ? d.source : "(unknown)";
  if (!Array.isArray(d.entries)) {
    return { dataset: null, errors: ["数据集缺少 entries 数组。"] };
  }
  const entries: DatasetEntry[] = [];
  const seen = new Set<string>();
  d.entries.forEach((rawEntry, i) => {
    const entry = normalizeEntry(rawEntry, i, errors, seen);
    if (entry !== null) entries.push(entry);
  });
  if (entries.length === 0) {
    return { dataset: null, errors: [...errors, "数据集没有合法 entry。"] };
  }
  return { dataset: { schemaVersion, source, entries }, errors };
}

/** 单条 entry 校验与规范化;非法返回 null 并记录错误。 */
function normalizeEntry(raw: unknown, index: number, errors: string[], seen: Set<string>): DatasetEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`entries[${index}]: 不是对象,已剔除。`);
    return null;
  }
  const e = raw as Record<string, unknown>;
  const fail = (reason: string): null => {
    errors.push(`entries[${index}](id=${String(e.id)}): ${reason}`);
    return null;
  };
  if (typeof e.id !== "string" || !e.id.trim()) return fail("缺少非空 id。");
  if (seen.has(e.id)) return fail(`id 重复("${e.id}")。`);
  seen.add(e.id);
  if (typeof e.requirement !== "string" || !e.requirement.trim()) return fail("缺少非空 requirement。");
  const src = normalizeSide(e.source, "source", fail);
  if (src === null) return null;
  const tgt = normalizeSide(e.target, "target", fail);
  if (tgt === null) return null;
  if (typeof tgt.isStatic !== "boolean") return fail("target.isStatic 必须是布尔值。");
  const requirementDiffs = Array.isArray(e.requirementDiffs)
    ? e.requirementDiffs.filter((x): x is string => typeof x === "string")
    : [];
  const rawSource = e.source as Record<string, unknown>;
  return {
    id: e.id,
    requirement: e.requirement,
    source: {
      language: src.language,
      file: src.file,
      className: src.className,
      method: src.method,
      ...(typeof rawSource.isStatic === "boolean" ? { isStatic: rawSource.isStatic as boolean } : {}),
      ...(Array.isArray(rawSource.constructorArgs) ? { constructorArgs: rawSource.constructorArgs as TypedValue[] } : {}),
    },
    target: {
      language: tgt.language,
      file: tgt.file,
      className: tgt.className,
      method: tgt.method,
      isStatic: tgt.isStatic,
      constructorArgs: Array.isArray(tgt.constructorArgs) ? (tgt.constructorArgs as TypedValue[]) : [],
    },
    requirementDiffs,
    ...(typeof e.notes === "string" ? { notes: e.notes } : {}),
  };
}

/** 双侧共享的字段校验。 */
function normalizeSide(
  value: unknown,
  label: "source" | "target",
  fail: (reason: string) => null,
): { language: string; file: string; className: string; method: string; isStatic?: boolean; constructorArgs?: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`${label} 缺失或不是对象。`);
  const s = value as Record<string, unknown>;
  if (typeof s.language !== "string" || !s.language.trim()) return fail(`${label}.language 缺失。`);
  if (typeof s.file !== "string" || !s.file.trim()) return fail(`${label}.file 缺失。`);
  if (typeof s.className !== "string" || !s.className.trim()) return fail(`${label}.className 缺失。`);
  if (typeof s.method !== "string" || !s.method.trim()) return fail(`${label}.method 缺失。`);
  return {
    language: s.language,
    file: s.file,
    className: s.className,
    method: s.method,
    ...(typeof s.isStatic === "boolean" ? { isStatic: s.isStatic as boolean } : {}),
    ...(Array.isArray(s.constructorArgs) ? { constructorArgs: s.constructorArgs } : {}),
  };
}

// ---------------------------------------------------------------------------
// QualityTask 构造
// ---------------------------------------------------------------------------

export interface TaskBuildResult {
  task: QualityTask | null;
  error?: string;
}

/** 按 entry 读取双侧源码并构造 SideSpec 模板;文件缺失/读取失败返回 error。 */
export function buildTask(entry: DatasetEntry, rootDir = process.cwd()): TaskBuildResult {
  const sourcePath = resolve(rootDir, entry.source.file);
  const targetPath = resolve(rootDir, entry.target.file);
  if (!existsSync(sourcePath)) return { task: null, error: `源文件不存在:${entry.source.file}` };
  if (!existsSync(targetPath)) return { task: null, error: `目标文件不存在:${entry.target.file}` };
  let sourceContent: string;
  let targetContent: string;
  try {
    sourceContent = readFileSync(sourcePath, "utf-8");
    targetContent = readFileSync(targetPath, "utf-8");
  } catch (error) {
    return { task: null, error: `读取源码失败:${error instanceof Error ? error.message : String(error)}` };
  }
  const source = buildSourceSide(entry, sourceContent, rootDir);
  const target = buildTargetSide(entry, rootDir);
  if (target.error !== undefined) return { task: null, error: target.error };
  return { task: { entry, source, target: target.side } };
}

/**
 * 源侧:Java 时若位于 maven 项目(pom.xml 向上探测),设置 projectRoot 走 mvn 编译
 * (skeleton 依赖 servlet-api/commons-io 等外部库,单文件 javac 无法解析);
 * 并补全签名(见 normalizeSourceSignature)。
 */
function buildSourceSide(entry: DatasetEntry, sourceContent: string, rootDir: string): SideSpec {
  const language = toVerifierLanguage(entry.source.language);
  const sourcePath = resolve(rootDir, entry.source.file);
  const sourceFiles = [{ relativePath: basename(sourcePath), content: sourceContent }];
  let projectRoot: string | undefined;
  if (language === "Java") {
    projectRoot = mavenProjectRoot(sourcePath) ?? undefined;
    if (projectRoot !== undefined) {
      return { language, driverSource: "", sourceFiles, projectRoot };
    }
  }
  return { language, driverSource: "", sourceFiles };
}

/**
 * 目标侧:C# 时若位于 C# 项目(csproj 向上探测),收集整个 src/ 下的全部 .cs 文件
 * (目标类有 namespace 且跨文件依赖,单文件无法编译),并附加 GlobalUsings.cs
 * (System 系列 + 收集到的全部 namespace,弥补 executor csproj 的 ImplicitUsings=disable
 * 与驱动默认全局命名空间);同时探测 maven 项目根(Java 目标时)。
 */
function buildTargetSide(entry: DatasetEntry, rootDir: string): { side: SideSpec; error?: string } {
  const language = toVerifierLanguage(entry.target.language);
  const targetPath = resolve(rootDir, entry.target.file);
  const targetContent = readFileSync(targetPath, "utf-8");
  const sourceFiles = [{ relativePath: basename(targetPath), content: targetContent }];
  const side: SideSpec = { language, driverSource: "", sourceFiles };
  if (language !== "C#") {
    // Java 目标:与源侧同规则探测 maven 项目根。
    const mavenRoot = mavenProjectRoot(targetPath);
    if (mavenRoot !== null) side.projectRoot = mavenRoot;
    return { side };
  }
  const projectRoot = csharpProjectRoot(targetPath);
  if (projectRoot === null) return { side };
  const srcDir = existsSync(join(projectRoot, "src")) ? join(projectRoot, "src") : projectRoot;
  const csFiles = collectCSharpFiles(srcDir);
  if (csFiles.length === 0) return { side };
  // GlobalUsings 只注入驱动需要的命名空间:目标类所在 namespace + 其父级(如 Disk 下的
  // DiskFileItem 引用了根命名空间的 FileItem 接口)。注意不能注入项目全部 namespace——
  // 项目的 `.Util` 与 `.Util.Mime` 各有一个 MimeUtility,全局 using 两者会制造 CS0104 二义性,
  // 而各文件自己的 using 在原始项目里已能正确解析。
  const targetNs = extractNamespace(targetContent);
  const driverNamespaces = new Set<string>();
  if (targetNs !== null) {
    driverNamespaces.add(targetNs);
    const parentNs = targetNs.split(".").slice(0, -1).join(".");
    if (parentNs !== targetNs && parentNs.length > 0) driverNamespaces.add(parentNs);
  }
  const usings = [
    "System",
    "System.Collections.Generic",
    "System.IO",
    "System.Linq",
    "System.Net.Http",
    "System.Threading",
    "System.Threading.Tasks",
    ...[...driverNamespaces].sort(),
  ];
  const globalUsings = usings.map((ns) => `global using ${ns};`).join("\n");
  return {
    side: {
      language,
      driverSource: "",
      sourceFiles: [
        ...csFiles.map((f) => ({ relativePath: f.relativePath, content: f.content })),
        { relativePath: "GlobalUsings.cs", content: `${globalUsings}\n` },
      ],
    },
  };
}

/** 从源文件向上探测 maven 项目根(含 pom.xml 的最外层目录);非 maven 返回 null。 */
function mavenProjectRoot(javaFile: string): string | null {
  let dir = dirname(javaFile);
  let found: string | null = null;
  for (;;) {
    if (existsSync(join(dir, "pom.xml"))) found = dir;
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** 从 C# 文件向上探测项目根(含 *.csproj 的最外层目录);非项目返回 null。 */
function csharpProjectRoot(csFile: string): string | null {
  let dir = dirname(csFile);
  let found: string | null = null;
  for (;;) {
    const hasProject = readdirSync(dir).some((name) => name.endsWith(".csproj"));
    if (hasProject) found = dir;
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** 递归收集目录下全部 .cs 文件(路径相对目录根,过滤构建目录)。 */
function collectCSharpFiles(srcRoot: string): { relativePath: string; content: string }[] {
  const out: { relativePath: string; content: string }[] = [];
  const ignored = new Set(["bin", "obj", "node_modules", ".git"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || ignored.has(name)) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".cs")) continue;
      out.push({ relativePath: full.slice(srcRoot.length + 1), content: readFileSync(full, "utf-8") });
    }
  };
  walk(srcRoot);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** 提取 C# 文件声明的 namespace(file-scoped `namespace X;` 或 block 形式)。 */
function extractNamespace(content: string): string | null {
  const fileScoped = /^\s*namespace\s+([\w.]+)\s*;/m.exec(content);
  if (fileScoped?.[1]) return fileScoped[1];
  const block = /^\s*namespace\s+([\w.]+)\s*\{/m.exec(content);
  return block?.[1] ?? null;
}

/**
 * 源侧签名规范化(数据集 agent 可能未填):
 * - className 补全 package → 全限定名(Java 驱动以 FQN 调用,无 import);
 * - isStatic 缺失时按方法声明探测(public static → true;实例方法 → false);
 *   Java maven 项目下方法可能声明在接口/基类文件(如 DefaultFileItem 的 getString
 *   实现于 disk.DiskFileItem),需在项目 src/main/java 内全量探测;
 * - 构造参数:驱动需要时由调用方按数据集 entry 提供(缺失则 entry 侧编译失败,如实记录)。
 */
export function normalizeSourceSignature(
  entry: DatasetEntry,
  sourceContent: string,
  projectRoot?: string,
): {
  className: string;
  isStatic: boolean;
  method: string;
  constructorArgs: TypedValue[];
} {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(sourceContent)?.[1];
  const className = pkg && !entry.source.className.includes(".") ? `${pkg}.${entry.source.className}` : entry.source.className;
  let isStatic = entry.source.isStatic;
  if (isStatic === undefined) {
    isStatic = detectJavaMethodStatic(entry.source.method, sourceContent, projectRoot) ?? true;
  }
  const constructorArgs = entry.source.constructorArgs ?? entry.target.constructorArgs ?? [];
  return { className, isStatic, method: entry.source.method, constructorArgs };
}

/** 探测方法静态性:先查 entry 文件,再(Java maven)查项目 src/main/java 全部文件。 */
function detectJavaMethodStatic(method: string, sourceContent: string, projectRoot?: string): boolean | undefined {
  const decl = methodDeclaration(method, sourceContent);
  if (decl !== null) return /static/.test(decl);
  if (projectRoot !== undefined) {
    const srcRoot = join(projectRoot, "src", "main", "java");
    if (existsSync(srcRoot)) {
      for (const f of collectJavaFiles(srcRoot)) {
        const found = methodDeclaration(method, f.content);
        if (found !== null) return /static/.test(found);
      }
    }
  }
  return undefined;
}

function methodDeclaration(method: string, content: string): string | null {
  const decl = new RegExp(
    `(?:public|protected|private)?\\s*(?:static\\s+)?[\\w<>\\[\\].?]+\\s+${escapeRegExp(method)}\\s*\\(`,
  ).exec(content);
  return decl === null ? null : decl[0];
}

/** 递归收集目录下全部 .java 文件(路径相对目录根,过滤构建目录)。 */
function collectJavaFiles(srcRoot: string): { relativePath: string; content: string }[] {
  const out: { relativePath: string; content: string }[] = [];
  const ignored = new Set(["target", "obj", "node_modules", ".git"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || ignored.has(name)) continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".java")) continue;
      out.push({ relativePath: full.slice(srcRoot.length + 1), content: readFileSync(full, "utf-8") });
    }
  };
  walk(srcRoot);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 数据集语言字符串收敛为 VerifierLanguage(非法抛错,由调用方按 entry 兜底)。 */
function toVerifierLanguage(language: string): SideSpec["language"] {
  if (language === "Java" || language === "C#" || language === "Python" || language === "TypeScript") {
    return language;
  }
  throw new Error(`不支持的源码语言 "${language}"(支持 Java/C#/Python/TypeScript)。`);
}

// ---------------------------------------------------------------------------
// 描述目标对齐(生成器输出可能签名不一致,强制对齐数据集 entry 的目标签名)
// ---------------------------------------------------------------------------

/**
 * 把生成器产出的描述 target 对齐到数据集 entry 的目标签名(类/方法/静态/构造参数),
 * 并挂载 requirement(需求第一;描述缺省时补上)。
 */
export function alignDescriptionTarget(description: TestDescription, entry: DatasetEntry): TestDescription {
  return {
    ...description,
    requirement: entry.requirement,
    target: {
      ...description.target,
      language: toTargetLanguage(entry.target.language),
      className: entry.target.className,
      method: entry.target.method,
      isStatic: entry.target.isStatic,
      constructorArgs: entry.target.constructorArgs ?? [],
    },
  };
}

function toTargetLanguage(language: string): TestDescription["target"]["language"] {
  if (language === "Java" || language === "C#" || language === "Python" || language === "TypeScript") return language;
  throw new Error(`不支持的翻译目标语言 "${language}"(支持 Java/C#/Python/TypeScript)。`);
}
