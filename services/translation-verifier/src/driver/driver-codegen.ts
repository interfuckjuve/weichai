import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription } from "../description.js";
import { generateJavaDriver } from "./java-driver.js";
import { generateCSharpDriver } from "./csharp-driver.js";
import { generatePythonDriver } from "./python-driver.js";
import { type SourceInvocation } from "./source-invocation.js";
import { generateTypeScriptDriver } from "./typescript-driver.js";

/**
 * 基于 canonicalDescriptionJson 的 sha256 前缀生成确定性驱动类名(Java/C# 共享)。
 * 与 driver 生成逻辑解耦:纯 sha256 计算,不依赖任何语言特定实现。
 */
export function driverClassName(description: TestDescription): string {
  const hash = createHash("sha256").update(canonicalDescriptionJson(description), "utf8").digest("hex");
  return `Driver_${hash.slice(0, 8)}`;
}

/**
 * 按 description.target.language 分派到对应语言的驱动生成器。
 * 确定性:同一描述输出与 generateJavaDriver / generateCSharpDriver 字节一致。
 * 非法语言抛错。
 */
export function generateDriverSource(description: TestDescription): string {
  switch (description.target.language) {
    case "Java":
      return generateJavaDriver(description);
    case "C#":
      return generateCSharpDriver(description);
    case "Python":
      return generatePythonDriver(description, targetInvocation(description));
    case "TypeScript":
      return generateTypeScriptDriver(description, targetInvocation(description));
  }
}

function targetInvocation(description: TestDescription): SourceInvocation {
  const target = description.target;
  return {
    language: target.language,
    module: target.module,
    className: target.ownerKind === "module" ? undefined : target.className,
    method: target.method,
    isStatic: target.isStatic,
    constructorArgs: target.constructorArgs,
  };
}

/** Generate a source-side driver without widening the translated target schema. */
export function generateSourceDriverSource(description: TestDescription, source: SourceInvocation): string {
  switch (source.language) {
    case "Java":
    case "C#":
      if (!source.className) throw new Error(`${source.language} source driver requires source.className.`);
      return generateDriverSource({
        ...description,
        target: {
          language: source.language,
          className: source.className,
          method: source.method,
          isStatic: source.isStatic,
          constructorArgs: source.constructorArgs,
        },
      });
    case "Python":
      return generatePythonDriver(description, source);
    case "TypeScript":
      return generateTypeScriptDriver(description, source);
  }
}
