/**
 * runner 入口文件拆分(Ruling 4b):metrics 层对 runner 型测试做 CSR/机械差分时,
 * 需要把 runner 文件集合拆分为驱动入口 + 附加文件。原实现位于被删除的 smoke-tools.ts,
 * 迁移至此(与 RunnerFile 同属 src/smoke/),行为保持逐字一致。
 */
import type { VerifierLanguage } from "../description.js";
import type { RunnerFile } from "./smoke-types.js";

/**
 * 从 runner 文件集合中拆分 driver 入口与其余文件:
 * - Python/TypeScript/C# 的入口文件为固定名(driver.py/driver.ts/Driver.cs);
 * - Java 的入口为含 main 的 public class 文件(文件名 = 类名.java,与 executor 写盘规则一致)。
 */
export function splitDriverEntry(
  language: VerifierLanguage,
  files: RunnerFile[],
): { driverSource: string; extraFiles: RunnerFile[] } {
  let driver: RunnerFile | undefined;
  if (language === "Python") driver = files.find((f) => f.path === "driver.py");
  else if (language === "TypeScript") driver = files.find((f) => f.path === "driver.ts");
  else if (language === "C#") driver = files.find((f) => f.path === "Driver.cs");
  else {
    driver = files.find(
      (f) => f.path.endsWith(".java") && /public\s+class\s+\w+/.test(f.content) && /public\s+static\s+void\s+main/.test(f.content),
    );
  }
  if (!driver) {
    throw new Error(
      `runner 缺少入口文件(${language} 契约:${language === "Java" ? "含 main 的 public class 文件" : language === "C#" ? "Driver.cs" : language === "Python" ? "driver.py" : "driver.ts"})。`,
    );
  }
  return { driverSource: driver.content, extraFiles: files.filter((f) => f !== driver) };
}
