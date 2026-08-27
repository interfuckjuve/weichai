/**
 * quality 适配器共享:从 QualityTask 构造策略 runner 的 TestStrategyJob。
 *
 * 映射(与 strategies/types.ts 契约对齐):
 * - requirement → task.entry.requirement;
 * - source/target.files → 各侧 sourceFiles(文件内容内嵌,供提示词引用);
 * - source/target.root → 只读参考目录(claude 自主会话从磁盘读取文件定位):
 *   优先各侧 projectRoot(如 maven 项目根),缺省用适配器 rootDir(仓库根);
 * - target 的 className/method/isStatic/file 取 entry 目标契约。
 */
import type { TestStrategyJob } from "../../strategies/types.js";
import type { QualityTask } from "../types.js";

export function buildStrategyJob(task: QualityTask, rootDir?: string): TestStrategyJob {
  const entry = task.entry;
  const sourceRoot = task.source.projectRoot ?? rootDir;
  const targetRoot = task.target.projectRoot ?? rootDir;
  return {
    requirement: entry.requirement,
    source: {
      language: task.source.language,
      files: task.source.sourceFiles,
      ...(sourceRoot === undefined ? {} : { root: sourceRoot }),
    },
    target: {
      language: task.target.language,
      className: entry.target.className,
      method: entry.target.method,
      isStatic: entry.target.isStatic,
      file: entry.target.file,
      files: task.target.sourceFiles,
      ...(targetRoot === undefined ? {} : { root: targetRoot }),
    },
  };
}
