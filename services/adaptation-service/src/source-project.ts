/**
 * 源语言项目定位与复制。
 *
 * SearchCandidate.repository 由 code-indexer 生成为 `fixture/<manifest.repository>`
 * (见 services/code-indexer/src/index.ts)。本模块把该标识映射回语料根目录下的
 * 磁盘路径,并在 Analyzer 判定候选可用(direct/adapt)时把源项目整体复制到
 * 目标工程同级的 `.forexplore-source-<repository>/`,供集成编译后的差分验证与
 * 调试使用。复制目录默认保留,不随请求清理。
 */
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPOSITORY_PREFIX = "fixture/";

/** 复制时排除的目录(垃圾/构建产物/版本控制)。 */
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "target", "bin", "obj", "dist",
  "build", "out", ".venv", "venv", "__pycache__", ".idea", ".vscode",
  ".codex", "coverage", "test-results",
]);

export interface SourceProjectInfo {
  /** 源项目在磁盘的根目录(绝对路径)。 */
  root: string;
  /** 仓库名(manifest.repository,去掉 fixture/ 前缀)。 */
  repositoryName: string;
}

/**
 * 把 SearchCandidate.repository 映射为语料根下的磁盘路径。
 * 返回 null 表示该仓库在本地语料根中不存在(例如远端索引、未挂载语料)。
 */
export function resolveSourceRepositoryRoot(
  repository: string,
  corpusRoot: string,
): SourceProjectInfo | null {
  if (!repository || !repository.trim()) return null;
  const repositoryName = repository.startsWith(REPOSITORY_PREFIX)
    ? repository.slice(REPOSITORY_PREFIX.length)
    : repository;
  const repositoryRoot = resolve(corpusRoot, repositoryName);
  if (!existsSync(repositoryRoot)) return null;
  return { root: repositoryRoot, repositoryName };
}

/**
 * 把源项目复制到 destParent/.forexplore-source-<repository>/。
 * 覆盖式重建(先删旧目录)以保证内容与当前语料一致;复制整个仓库根,
 * 排除 EXCLUDED_DIRECTORIES。返回复制后的目录信息;无法定位时返回 null。
 */
export function copySourceProject(
  repository: string,
  corpusRoot: string,
  destParent: string,
): SourceProjectInfo | null {
  const info = resolveSourceRepositoryRoot(repository, corpusRoot);
  if (!info) return null;
  const dest = join(destParent, `.forexplore-source-${info.repositoryName}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(info.root, dest, {
    recursive: true,
    filter: (source) => !EXCLUDED_DIRECTORIES.has(basename(source)),
  });
  return { root: dest, repositoryName: info.repositoryName };
}

/** 读取仓库 manifest.json(可选);解析失败返回 null。 */
export function readCorpusManifest(
  repositoryRoot: string,
): Record<string, unknown> | null {
  const manifestPath = join(repositoryRoot, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
