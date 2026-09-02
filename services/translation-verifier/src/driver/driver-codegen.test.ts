import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalDescriptionJson, type TestDescription, type VerifierLanguage } from "../description.js";
import { driverClassName, generateDriverSource } from "./driver-codegen.js";
import { generateJavaDriver } from "./java-driver.js";
import { generateCSharpDriver } from "./csharp-driver.js";

function javaDescription(): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: "Java",
      className: "com.example.Util",
      method: "doubleIt",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "double-21",
        inputs: [{ type: "number", value: 21 }],
        expected: { kind: "return", value: { type: "number", value: 42 } },
      },
    ],
  };
}

function csharpDescription(): TestDescription {
  return {
    schemaVersion: "1.0",
    target: {
      language: "C#",
      className: "Util",
      method: "DoubleIt",
      isStatic: true,
      constructorArgs: [],
    },
    cases: [
      {
        id: "double-21",
        inputs: [{ type: "number", value: 21 }],
        expected: { kind: "return", value: { type: "number", value: 42 } },
      },
    ],
  };
}

describe("generateDriverSource 按 language 分派", () => {
  it("Java 描述:类声明行以 public class Driver_ 开头且源码含 JsonWriter", () => {
    const src = generateDriverSource(javaDescription());
    const classLine = src.split("\n").find((line) => line.startsWith("public class Driver_"));
    expect(classLine).toBeDefined();
    expect(classLine).toMatch(/^public class Driver_[0-9a-f]{8} \{$/);
    expect(src).toContain("JsonWriter");
  });

  it("C# 描述:类声明行以 public class Driver_ 开头且源码含 sealed class JsonWriter", () => {
    const src = generateDriverSource(csharpDescription());
    const classLine = src.split("\n").find((line) => line.startsWith("public class Driver_"));
    expect(classLine).toBeDefined();
    expect(classLine).toMatch(/^public class Driver_[0-9a-f]{8} \{$/);
    expect(src).toContain("sealed class JsonWriter {");
  });

  it("Java 描述走 Java 生成器(含 Util.doubleIt 调用);C# 描述走 C# 生成器(含 Util.DoubleIt 调用)", () => {
    expect(generateDriverSource(javaDescription())).toContain("com.example.Util.doubleIt(21)");
    expect(generateDriverSource(csharpDescription())).toContain("Util.DoubleIt(21)");
  });

  it("Python module-level target uses the Python driver without an artificial class owner", () => {
    const desc: TestDescription = {
      ...javaDescription(),
      target: {
        language: "Python",
        module: "target_module",
        ownerKind: "module",
        className: "",
        method: "double_it",
        isStatic: true,
        constructorArgs: [],
      },
    };
    const source = generateDriverSource(desc);
    expect(source).toContain('importlib.import_module("target_module")');
    expect(source).toContain("owner = module");
    expect(source).toContain("owner.double_it");
  });

  it("TypeScript module-level target uses the TypeScript driver", () => {
    const desc: TestDescription = {
      ...javaDescription(),
      target: {
        language: "TypeScript",
        module: "target-module.ts",
        ownerKind: "module",
        className: "",
        method: "doubleIt",
        isStatic: true,
        constructorArgs: [],
      },
    };
    const source = generateDriverSource(desc);
    expect(source).toContain('import * as sourceModule from "./target-module.ts";');
    expect(source).toContain("const owner: any = sourceModule;");
    expect(source).toContain('owner["doubleIt"]');
  });
});

describe("generateDriverSource 与专用生成器一致性(确定性)", () => {
  it("Java 描述:与 generateJavaDriver 输出字节一致", () => {
    const desc = javaDescription();
    expect(generateDriverSource(desc)).toBe(generateJavaDriver(desc));
  });

  it("C# 描述:与 generateCSharpDriver 输出字节一致", () => {
    const desc = csharpDescription();
    expect(generateDriverSource(desc)).toBe(generateCSharpDriver(desc));
  });

  it("同一描述两次分派,字节相同", () => {
    expect(generateDriverSource(javaDescription())).toBe(generateDriverSource(javaDescription()));
    expect(generateDriverSource(csharpDescription())).toBe(generateDriverSource(csharpDescription()));
  });
});

describe("driverClassName(共享)", () => {
  it("Driver_<sha256(canonical).slice(0,8)> 与 canonical hash 一致", () => {
    for (const desc of [javaDescription(), csharpDescription()]) {
      const hash = createHash("sha256").update(canonicalDescriptionJson(desc), "utf8").digest("hex");
      expect(driverClassName(desc)).toBe(`Driver_${hash.slice(0, 8)}`);
      expect(driverClassName(desc)).toMatch(/^Driver_[0-9a-f]{8}$/);
    }
  });

  it("分派生成的源码使用与 driverClassName 相同的类名", () => {
    const desc = javaDescription();
    expect(generateDriverSource(desc)).toContain(`public class ${driverClassName(desc)} {`);
  });
});
