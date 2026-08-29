import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdaptationRequest,
  AnalysisReport,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import {
  generateDriverSource,
  RealDriverExecutor,
  type TestDescription,
} from "@forexplore/translation-verifier";
import {
  _verifyTargetOnly,
  TranslationVerifierAdapter,
  verificationAdapterInternals,
  type DifferentialVerificationInput,
  type IsolatedDriverExecutor,
} from "./verification-adapter";

function hasJavac(): boolean {
  try {
    execFileSync("javac", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const { buildSourceSide, qualifiedClassNameFromSource, useDifferential } = verificationAdapterInternals;

const baseInput: DifferentialVerificationInput = {
  request: {
    strategy: "translate",
    decisionNotes: "",
    requirement: "req",
    target: {
      id: "t",
      language: "Java",
      name: "readBodyData",
      kind: "function",
      path: "src/main/java/org/apache/commons/fileupload/MultipartStream.java",
      signature: "public int readBodyData(java.io.OutputStream out)",
    },
    candidate: {
      id: "c1",
      title: "ReadBodyData",
      repository: "fixture/commons-fileupload-csharp",
      license: "Apache-2.0",
      language: "C#",
      kind: "function",
      path: "src/Commons/FileUpload/MultipartStream.cs",
      signature: "public int ReadBodyData(Stream? output)",
      summary: "s",
      score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
      preview: "public int ReadBodyData(Stream? output) { return 0; }",
      dependencies: [],
      compatibility: [],
      risks: [],
    },
  },
  targetContext: {
    schemaVersion: "1.0",
    target: {
      id: "t",
      language: "Java",
      name: "readBodyData",
      kind: "function",
      path: "src/main/java/org/apache/commons/fileupload/MultipartStream.java",
      signature: "public int readBodyData(java.io.OutputStream out)",
    },
    source: {
      namespace: undefined,
      usings: [] as string[],
      method: "public int readBodyData(java.io.OutputStream out) { return 0; }",
      containingType: "public class MultipartStream { }",
      fields: [] as string[],
      constructor: undefined,
      relatedMembers: [] as string[],
    },
    dependencies: [],
    relatedTypes: [],
    callers: [],
    constraints: [],
    collection: {
      projectRoot: "/tmp/x",
      targetFile: "src/main/java/org/apache/commons/fileupload/MultipartStream.java",
      maxChars: 1000,
      actualChars: 100,
      truncated: false,
      truncatedSections: [],
    },
  },
  generatedCode: "public int readBodyData(java.io.OutputStream out) { return 0; }",
  projectRoot: "/tmp/x",
};

function report(level: AnalysisReport["applicability"]["level"]): AnalysisReport {
  return {
    schemaVersion: "1.0",
    applicability: { level, confidence: 0.9, reasons: ["r"] },
    behaviorMapping: [],
    contractMapping: [],
    dependencyPlan: [],
    implementationPlan: ["step"],
    risks: [],
    assumptions: [],
    unresolved: [],
  };
}

describe("useDifferential(模式判定)", () => {
  it("direct/adapt 且源项目已复制 → 差分", () => {
    const input = { ...baseInput, analysisReport: report("direct"), sourceProjectRoot: "/tmp/source" };
    expect(useDifferential(input)).toBe(true);
    expect(useDifferential({ ...input, analysisReport: report("adapt") })).toBe(true);
  });

  it("direct/adapt 但源项目未复制 → 目标侧单测", () => {
    expect(useDifferential({ ...baseInput, analysisReport: report("direct") })).toBe(false);
  });

  it("reject/reference → 目标侧单测", () => {
    const input = { ...baseInput, analysisReport: report("reject"), sourceProjectRoot: "/tmp/source" };
    expect(useDifferential(input)).toBe(false);
    expect(useDifferential({ ...input, analysisReport: report("reference") })).toBe(false);
  });

  it("无分析报告(兼容旧调用)→ 差分", () => {
    expect(useDifferential({ ...baseInput, analysisReport: undefined })).toBe(true);
  });
});

describe("qualifiedClassNameFromSource", () => {
  it("解析 Java package + class 全限定名", () => {
    const src = "package org.apache.commons.fileupload;\npublic class MultipartStream { }";
    expect(qualifiedClassNameFromSource(src, "Java")).toBe("org.apache.commons.fileupload.MultipartStream");
  });

  it("解析 C# namespace + class 全限定名", () => {
    const src = "namespace Commons.FileUpload { public class MultipartStream { } }";
    expect(qualifiedClassNameFromSource(src, "C#")).toBe("Commons.FileUpload.MultipartStream");
  });

  it("无包/命名空间时返回简单类名", () => {
    expect(qualifiedClassNameFromSource("public class Hello { }", "Java")).toBe("Hello");
    expect(qualifiedClassNameFromSource("public void nothing() { }", "C#")).toBeUndefined();
  });
});

describe("buildSourceSide(源项目真实文件)", () => {
  it("源项目副本存在:sourceFiles 为空 + reuseDir 指向副本 + driver 调用真实类名", () => {
    const root = mkdtempSync(join(tmpdir(), "fx-source-side-"));
    try {
      writeFileSync(
        join(root, "MultipartStream.cs"),
        "namespace Commons.FileUpload { public class MultipartStream { public int ReadBodyData(Stream? output) { return 0; } } }",
        "utf8",
      );
      const invocation = {
        language: "C#" as const,
        module: undefined,
        className: "SourceReadBodyData",
        method: "ReadBodyData",
        isStatic: false,
        constructorArgs: [],
      };
      const description: TestDescription = {
        schemaVersion: "1.0",
        requirement: "req",
        target: {
          language: "Java",
          className: "org.apache.commons.fileupload.MultipartStream",
          method: "readBodyData",
          isStatic: false,
          constructorArgs: [],
          entryKind: "method",
        },
        cases: [
          { id: "c1", inputs: [{ type: "string", value: "x" }], expected: { kind: "return", value: { type: "null", value: null } } },
        ],
      };
      const side = buildSourceSide(description, invocation, "preview", root, "MultipartStream.cs");

      expect(side.sourceFiles).toEqual([]);
      expect(side.reuseDir).toBe(root);
      expect(side.projectRoot).toBe(root);
      expect(side.driverSource).toContain("Commons.FileUpload.MultipartStream");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("源项目副本缺失:回退快照包装(单文件 sourceFiles)", () => {
    const description: TestDescription = {
      schemaVersion: "1.0",
      requirement: "req",
      target: {
        language: "Java",
        className: "MimeUtil",
        method: "decodeText",
        isStatic: true,
        constructorArgs: [],
        entryKind: "method",
      },
      cases: [],
    };
    const invocation = {
      language: "Java" as const,
      module: undefined,
      className: "SourceDecodeText",
      method: "decodeText",
      isStatic: true,
      constructorArgs: [],
    };
    const side = buildSourceSide(description, invocation, "public static String decodeText(String s) { return s; }");

    expect(side.sourceFiles.length).toBe(1);
    expect(side.sourceFiles[0]?.relativePath).toBe("SourceDecodeText.java");
    expect(side.reuseDir).toBeUndefined();
  });

  it("源项目副本缺失(C#):回退包装按需补 using System.IO", () => {
    const description: TestDescription = {
      schemaVersion: "1.0",
      requirement: "req",
      target: {
        language: "Java",
        className: "MultipartStream",
        method: "readBodyData",
        isStatic: false,
        constructorArgs: [],
        entryKind: "method",
      },
      cases: [],
    };
    const invocation = {
      language: "C#" as const,
      module: undefined,
      className: "SourceReadBodyData",
      method: "ReadBodyData",
      isStatic: false,
      constructorArgs: [],
    };
    const side = buildSourceSide(
      description,
      invocation,
      "public int ReadBodyData(Stream? output) { return output == null ? 0 : 1; }",
    );

    expect(side.sourceFiles.length).toBe(1);
    const content = side.sourceFiles[0]?.content ?? "";
    expect(content).toContain("using System.IO;");
    expect(content).toContain("public class SourceReadBodyData");
  });
});

describe.skipIf(!hasJavac())("_verifyTargetOnly(目标侧单测)", () => {
  it("目标侧结果符合描述 expected → pass;偏离 → fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "fx-target-only-"));
    try {
      const calcDir = join(root, "org/apache/commons/fileupload/util/mime");
      // mkdir -p
      const { mkdirSync } = await import("node:fs");
      mkdirSync(calcDir, { recursive: true });
      writeFileSync(
        join(calcDir, "Calc.java"),
        "package org.apache.commons.fileupload.util.mime;\npublic class Calc {\n  public static int add(int a, int b) { return a + b; }\n}\n",
        "utf8",
      );
      const description: TestDescription = {
        schemaVersion: "1.0",
        requirement: "add two integers",
        target: {
          language: "Java",
          className: "org.apache.commons.fileupload.util.mime.Calc",
          method: "add",
          isStatic: true,
          constructorArgs: [],
          entryKind: "method",
        },
        cases: [
          { id: "ok", inputs: [{ type: "number", value: 1 }, { type: "number", value: 2 }], expected: { kind: "return", value: { type: "number", value: 3 } } },
          { id: "bad", inputs: [{ type: "number", value: 5 }, { type: "number", value: 5 }], expected: { kind: "return", value: { type: "number", value: 99 } } },
        ],
      };
      const target = {
        language: "Java" as const,
        driverSource: generateDriverSource(description),
        sourceFiles: [] as Array<{ relativePath: string; content: string }>,
        projectRoot: root,
        reuseDir: root,
      };
      const report = await _verifyTargetOnly({ description, target }, new RealDriverExecutor({ timeoutMs: 60_000 }));

      expect(report.totalCases).toBe(2);
      expect(report.passedCases).toBe(1); // ok 通过
      expect(report.failedCases).toBe(1); // bad 偏离 expected → fail
      expect(report.comparisons.find((c) => c.caseId === "ok")?.verdict).toBe("pass");
      expect(report.comparisons.find((c) => c.caseId === "bad")?.verdict).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("smokeResult(自主会话结果转换)", () => {
  const { smokeResult } = verificationAdapterInternals;

  it("converged → pass,无 modificationPlan,summary 附带保留目录", () => {
    const result = smokeResult({
      strategy: "smoke",
      status: "pass",
      passRate: 1,
      summary: "5/5 用例行为一致",
      durationMs: 100,
      generatedTestsKept: true,
      keptDir: "/tmp/fx-kept",
      detail: {
        converged: true,
        steps: 10,
        rounds: 0,
        cases: [{ caseId: "c1", intent: "i", source: null, target: null, mechanical: "pass", decision: "pass", reasoning: "一致" }],
        targetFiles: [],
        sourceIssues: [],
        summary: "5/5 用例行为一致",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.modificationPlan).toEqual([]);
    expect(result.summary).toContain("5/5 用例行为一致");
    expect(result.summary).toContain("/tmp/fx-kept");
  });

  it("translation-bug 裁决 → fail + modificationPlan 带修复指令", () => {
    const result = smokeResult({
      strategy: "smoke",
      status: "fail",
      durationMs: 100,
      generatedTestsKept: true,
      summary: "2/3 用例一致",
      detail: {
        converged: false,
        steps: 20,
        rounds: 2,
        cases: [
          { caseId: "c2", intent: "i", source: null, target: null, mechanical: "fail", decision: "translation-bug", reasoning: "目标侧返回错误值" },
          { caseId: "c3", intent: "i", source: null, target: null, mechanical: "pass", decision: "accepted-diff", reasoning: "源侧偏离需求" },
        ],
        targetFiles: [{ path: "X.java", content: "..." }],
        sourceIssues: ["源侧字符集支持不全"],
        summary: "2/3 用例一致",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.modificationPlan).toContain("修复 case c2：目标侧返回错误值");
    expect(result.modificationPlan.some((m) => m.includes("源侧疑似缺陷"))).toBe(true);
    expect(result.reason).toBe("behavioral-divergence");
  });

  it("status=error → unverified", () => {
    const result = smokeResult({
      strategy: "smoke",
      status: "error",
      durationMs: 100,
      generatedTestsKept: true,
      summary: "report.json 缺失",
      detail: {} as never,
    });

    expect(result.status).toBe("unverified");
    expect(result.reason).toBe("verifier-error");
  });
});
const candidate: SearchCandidate = {
  id: "candidate",
  title: "calculate",
  repository: "fixture/source",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public static int calculate()",
  summary: "fixture",
  preview: "public static int calculate() { return 1; }",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  dependencies: [],
  compatibility: [],
  risks: [],
};

const request: AdaptationRequest = {
  target: {
    id: "target",
    name: "Calculate",
    kind: "function",
    path: "src/Calculator.cs",
    language: "C#",
    signature: "public static int Calculate()",
    line: 1,
  },
  candidate,
  requirement: "Keep the arithmetic result.",
  strategy: "translate",
  decisionNotes: "",
};

const targetContext: TargetModuleContext = {
  schemaVersion: "1.0",
  target: request.target,
  source: {
    namespace: "Fixture",
    usings: [],
    method: "public static int Calculate() => 0;",
    containingType: "public static class Calculator { }",
    fields: [],
    constructor: undefined,
    relatedMembers: [],
  },
  dependencies: [],
  relatedTypes: [],
  callers: [],
  constraints: [],
  collection: {
    projectRoot: ".",
    targetFile: request.target.path,
    maxChars: 1,
    actualChars: 1,
    truncated: false,
    truncatedSections: [],
  },
};

const input: DifferentialVerificationInput = {
  request,
  targetContext,
  generatedCode: "public static int Calculate() => 1;",
  projectRoot: ".",
};

const isolatedExecutor: IsolatedDriverExecutor = {
  isolation: {
    processBoundary: "external",
    network: "disabled",
    hostCredentials: "unavailable",
    hostWorkspace: "unmounted",
  },
  async compile() {
    return { success: true, errors: [], output: "" };
  },
  async run() {
    return { exitCode: 0, stdout: '{"results":[]}', stderr: "" };
  },
};

describe("TranslationVerifierAdapter execution boundary", () => {
  it("fails closed by default without inspecting or executing candidate preview", async () => {
    const adapter = new TranslationVerifierAdapter({ apiKey: "test-key" });

    const result = await adapter.verify(input);

    expect(result).toMatchObject({
      status: "unverified",
      reason: "verifier-unavailable",
    });
    expect(result.summary).toContain("未运行候选或生成代码");
  });

  it("requires an explicit, attestable isolated executor for execution", () => {
    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
    })).toThrow(/external, credential-free, network-disabled workspace boundary/);

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
      executor: isolatedExecutor,
    })).not.toThrow();

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      executor: isolatedExecutor,
    })).toThrow(/execution is disabled/);
  });

  it("rejects a runtime executor that only claims the TypeScript shape", () => {
    const malformedExecutor = {
      async compile() { return { success: true, errors: [], output: "" }; },
      async run() { return { exitCode: 0, stdout: "", stderr: "" }; },
    } as unknown as IsolatedDriverExecutor;

    expect(() => new TranslationVerifierAdapter({
      apiKey: "test-key",
      execution: "trusted-isolated",
      executor: malformedExecutor,
    })).toThrow(/external, credential-free, network-disabled workspace boundary/);
  });
});
