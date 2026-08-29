import { fileURLToPath } from "node:url";
import type {
  AnalysisReport,
  AnalysisRequest,
  AdaptationRequest,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import { describe, expect, it } from "vitest";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";
import type { CompileResult } from "./compiler";
import type { AdaptationVerifier } from "./verification-adapter";

const javaCandidate: SearchCandidate = {
  id: "java-candidate",
  title: "calculate",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public double calculate()",
  summary: "Calculates a value.",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: "public double calculate() { return 1.0; }",
  dependencies: [],
  compatibility: [],
  risks: [],
};

const request: AdaptationRequest = {
  target: {
    id: "target",
    name: "isMultipartContent",
    kind: "function",
    path: "src/main/java/org/apache/commons/fileupload/FileUploadBase.java",
    language: "Java",
    signature: "public static final boolean isMultipartContent(RequestContext ctx)",
    line: 75,
  },
  candidate: javaCandidate,
  requirement: "Translate the calculation.",
  strategy: "translate",
  decisionNotes: "",
};

const javaProjectRoot = fileURLToPath(
  new URL("../../../fixtures/target-system/commons-fileupload-java-skeleton", import.meta.url),
);

const targetContext: TargetModuleContext = {
  schemaVersion: "1.0",
  target: request.target,
  source: {
    namespace: "org.apache.commons.fileupload",
    usings: ["import java.util.Locale;"],
    method: "public static final boolean isMultipartContent(RequestContext ctx) { return false; }",
    containingType: "public abstract class FileUploadBase { }",
    fields: [],
    constructor: undefined,
    relatedMembers: [],
  },
  dependencies: [],
  relatedTypes: [],
  callers: [],
  constraints: ["Preserve the static Java method contract."],
  collection: {
    projectRoot: ".",
    targetFile: request.target.path,
    maxChars: 24_000,
    actualChars: 256,
    truncated: false,
    truncatedSections: [],
  },
};

const analysisReport: AnalysisReport = {
  schemaVersion: "1.0",
  applicability: {
    level: "adapt",
    confidence: 0.86,
    reasons: ["The candidate behavior maps to the existing Java method contract."],
  },
  behaviorMapping: [{
    requirement: "Translate the calculation.",
    status: "partial",
    candidateEvidence: ["return None"],
    targetAction: "Implement the behavior using the Java target contract.",
  }],
  contractMapping: [{
    source: "calculate",
    target: "isMultipartContent",
    action: "convert",
    note: "Preserve the existing Java signature.",
  }],
  dependencyPlan: [],
  implementationPlan: [
    "Preserve the exact Java target signature.",
    "Implement the required behavior inside the existing target method.",
  ],
  risks: [],
  assumptions: [],
  unresolved: [],
};

describe("AdaptationAdapter implementation boundary", () => {
  it("does not restrict either candidate or target language", async () => {
    const cases = [
      ["TypeScript", "isMultipartContent", "public isMultipartContent(ctx: RequestContext): boolean", "public isMultipartContent(ctx: RequestContext): boolean { return ctx != null; }"],
      ["Python", "is_multipart_content", "def is_multipart_content(ctx: RequestContext)", "def is_multipart_content(ctx: RequestContext):\n    return ctx is not None"],
      ["Java", "isMultipartContent", "public static boolean isMultipartContent(RequestContext ctx)", "public static boolean isMultipartContent(RequestContext ctx) { return ctx != null; }"],
      ["C#", "IsMultipartContent", "public static bool IsMultipartContent(RequestContext ctx)", "public static bool IsMultipartContent(RequestContext ctx) { return ctx is not null; }"],
      ["Rust", "is_multipart_content", "pub fn is_multipart_content(ctx: &RequestContext) -> bool", "pub fn is_multipart_content(ctx: &RequestContext) -> bool { !std::ptr::eq(ctx, ctx) }"],
      ["Go", "IsMultipartContent", "func IsMultipartContent(ctx *RequestContext) bool", "func IsMultipartContent(ctx *RequestContext) bool { return ctx != nil }"],
    ] as const;

    for (const [language, name, signature, generatedCode] of cases) {
      const target = { ...request.target, id: `${language}-target`, name, path: `src/adapter.${language}`, line: undefined, language, signature };
      const context: TargetModuleContext = {
        ...targetContext,
        target,
        source: {
          ...targetContext.source,
          constructor: undefined,
          method: generatedCode,
          containingType: language === "Python" ? "class UploadAdapter:\n    pass" : "class UploadAdapter { }",
        },
      };
      const compiledLanguages: string[] = [];
      const adapter = new AdaptationAdapter({
        apiKey: "test-key",
        projectRoot: javaProjectRoot,
        contextCollector: () => context,
        analyzer: { async analyze() { return analysisReport; } },
        translatorRequest: (async () => new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            schemaVersion: "1.0",
            generatedCode,
            interfaceMappings: analysisReport.contractMapping,
            completedSteps: analysisReport.implementationPlan,
            unresolved: [],
          }) } }],
        }))) as typeof globalThis.fetch,
        validator: {
          compileStandalone: (targetLanguage) => {
            compiledLanguages.push(targetLanguage);
            return { success: true, errors: [], output: "" };
          },
          compileIntegrated: () => ({ success: true, errors: [], output: "" }),
          isUnavailable: () => false,
        },
      });

      const result = await adapter.adapt({
        ...request,
        target,
        candidate: { ...javaCandidate, language: language === "Rust" ? "Go" : "Rust" },
      });

      expect(result.targetLanguage).toBe(language);
      expect(compiledLanguages).toEqual([language]);
    }
  });

  it("rejects strategies unsupported by the adapter", async () => {
    const adapter = new AdaptationAdapter({ apiKey: "not-used-by-gate-tests" });
    await expect(adapter.adapt({ ...request, strategy: "wrap" })).rejects.toThrow(
      'AdaptationAdapter only supports the "translate" strategy; received "wrap".',
    );
  });

  it("hands a Python candidate to independent Analyzer and Translator agents for a Java target", async () => {
    const compilerSuccess: CompileResult = { success: true, errors: [], output: "" };
    let analyzerRequest: AnalysisRequest | undefined;
    const modelBodies: Array<{ messages: Array<{ content: string }> }> = [];
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot: javaProjectRoot,
      contextCollector: () => targetContext,
      analyzer: {
        async analyze(value: AnalysisRequest): Promise<AnalysisReport> {
          analyzerRequest = value;
          return analysisReport;
        },
      },
      translatorRequest: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        modelBodies.push(body);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            schemaVersion: "1.0",
            generatedCode: "public static final boolean isMultipartContent(RequestContext ctx) { return ctx != null; }",
            interfaceMappings: analysisReport.contractMapping,
            completedSteps: analysisReport.implementationPlan,
            unresolved: [],
          }) } }],
        }), { status: 200 });
      }) as typeof globalThis.fetch,
      validator: {
        compileStandalone: () => compilerSuccess,
        compileIntegrated: () => compilerSuccess,
        isUnavailable: () => false,
      },
    });
    const result = await adapter.adapt({
      ...request,
      candidate: {
        ...javaCandidate,
        language: "Python",
        preview: "def calculate():\n    return None",
      },
    });

    expect(result.targetLanguage).toBe("Java");
    expect(result.generatedCode).toContain("isMultipartContent(RequestContext ctx)");
    expect(analyzerRequest?.candidate.language).toBe("Python");
    expect(analyzerRequest?.targetContext).toBe(targetContext);
    expect(modelBodies).toHaveLength(1);
    const messages = modelBodies[0]?.messages ?? [];
    expect(messages[1]?.content).toContain("ANALYSIS_REPORT_JSON");
    expect(messages[1]?.content).toContain("Preserve the exact Java target signature.");
    expect(messages.map((message) => message.content).join("\n")).not.toContain(
      "You are the Analyzer Agent",
    );
    expect(messages.map((message) => message.content).join("\n")).not.toContain(
      "[RETRIEVED CANDIDATE]",
    );
    expect(result.validation.find((record) => record.id === "standalone-compile"))
      .toMatchObject({ status: "pass", command: "javac" });
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: "differential-verification",
      status: "unverified",
      required: true,
    }));
    expect(result.files).toHaveLength(1);
  });

  it("drops an Analyzer-rejected candidate and marks autonomous generation for review", async () => {
    const compilerSuccess: CompileResult = { success: true, errors: [], output: "" };
    const fallbackPlan =
      "Implement the requirement using the existing target contract and collected target context without a reference candidate.";
    const rejectedReport: AnalysisReport = {
      ...analysisReport,
      applicability: {
        level: "reject",
        confidence: 0.99,
        reasons: ["The selected candidate does not match the Java target contract."],
      },
      behaviorMapping: [],
      contractMapping: [],
      implementationPlan: [fallbackPlan],
    };
    const modelBodies: Array<{ messages: Array<{ content: string }> }> = [];
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot: javaProjectRoot,
      contextCollector: () => targetContext,
      analyzer: { async analyze() { return rejectedReport; } },
      translatorRequest: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        modelBodies.push(body);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            schemaVersion: "1.0",
            generatedCode: "public static final boolean isMultipartContent(RequestContext ctx) { return ctx != null; }",
            interfaceMappings: [],
            completedSteps: [fallbackPlan],
            unresolved: [],
          }) } }],
        }), { status: 200 });
      }) as typeof globalThis.fetch,
      validator: {
        compileStandalone: () => compilerSuccess,
        compileIntegrated: () => compilerSuccess,
        isUnavailable: () => false,
      },
    });

    const result = await adapter.adapt({ ...request, candidate: javaCandidate });
    const prompt = modelBodies[0]?.messages.map((message) => message.content).join("\n") ?? "";

    expect(result.generatedCode).toContain("isMultipartContent(RequestContext ctx)");
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: "reference-candidate",
      status: "warn",
      required: false,
    }));
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: "analyzer",
      status: "warn",
      required: false,
    }));
    expect(prompt).toContain("No candidate is suitable");
    expect(prompt).not.toContain(javaCandidate.preview);
  });

  it("runs differential verification after compile and feeds its plan to Translator repair", async () => {
    const compilerSuccess: CompileResult = { success: true, errors: [], output: "" };
    const modelBodies: Array<{ messages: Array<{ content: string }> }> = [];
    const verifierCalls: string[] = [];
    const verifier: AdaptationVerifier = {
      async verify(input) {
        verifierCalls.push(input.generatedCode);
        return {
          status: "fail",
          summary: "差分验证未通过：0/1 个 case 通过，1 个 case 需要修复。",
          modificationPlan: ["修复 case wrong-return：目标返回值与需求不一致。"],
          reason: "behavioral-divergence",
        };
      },
    };
    const generatedCode = "public static final boolean isMultipartContent(RequestContext ctx) { return true; }";
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      projectRoot: javaProjectRoot,
      contextCollector: () => targetContext,
      verifier,
      analyzer: { async analyze() { return analysisReport; } },
      translatorRequest: (async (_input: URL | RequestInfo, init?: RequestInit) => {
        modelBodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            schemaVersion: "1.0",
            generatedCode,
            completedSteps: analysisReport.implementationPlan,
            unresolved: [],
          }) } }],
        }), { status: 200 });
      }) as typeof globalThis.fetch,
      validator: {
        compileStandalone: () => compilerSuccess,
        compileIntegrated: () => compilerSuccess,
        isUnavailable: () => false,
      },
    });

    const result = await adapter.adapt(request);

    expect(verifierCalls).toHaveLength(4);
    expect(modelBodies).toHaveLength(4);
    expect(modelBodies[1]?.messages.map((message) => message.content).join("\n"))
      .toContain("修复 case wrong-return");
    expect(result.modificationPlan).toEqual(["修复 case wrong-return：目标返回值与需求不一致。"]);
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: "differential-verification",
      status: "fail",
      required: true,
    }));
  });
});

describe("buildFilePatch", () => {
  const originalClass = [
    "using System;",
    "using System.Collections.Generic;",
    "",
    "namespace MyApp.Services",
    "{",
    "    public class RateQuoteService",
    "    {",
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            throw new NotImplementedException();",
    "        }",
    "",
    "        public void Initialize()",
    "        {",
    "            // setup",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const newMethod = [
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            return 0.92m;",
    "        }",
  ].join("\n");

  it("produces a context-based hunk when originalContent and targetLine are provided", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, 8);

    expect(patch.status).toBe("modified");
    if (patch.status !== "modified") throw new Error("expected a modified patch");
    expect(patch.expectedOriginalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(patch.hunks).toHaveLength(1);

    const lines = patch.hunks[0].lines;
    const types = lines.map((l) => l.type);

    // 必须包含 context 行（用于定位）
    expect(types).toContain("context");
    // 必须包含 remove 行（旧方法代码被删除）
    expect(types).toContain("remove");
    // 必须包含 add 行（新方法代码被加入）
    expect(types).toContain("add");

    // context 行应该是原方法签名前的那一行
    const contextLines = lines.filter((l) => l.type === "context");
    expect(contextLines.some((l) => l.content.trim() === "{")).toBe(true);

    // remove 行应包含原方法的 throw 语句
    const removeLines = lines.filter((l) => l.type === "remove");
    expect(removeLines.some((l) => l.content.includes("throw new NotImplementedException"))).toBe(true);

    // add 行应包含新方法代码
    const addLines = lines.filter((l) => l.type === "add");
    expect(addLines.some((l) => l.content.includes("return 0.92m"))).toBe(true);
  });

  it("refuses to create a blind patch without an original file snapshot", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, null, 8)).toThrow(
      "Cannot build a safe patch",
    );
  });

  it("refuses to create a patch without a target declaration line", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, originalClass, undefined)).toThrow(
      "Cannot build a safe patch",
    );
  });

  it("refuses a target line that does not start a C# method", () => {
    expect(() => _buildFilePatch("src/Service.cs", newMethod, originalClass, 10)).toThrow(
      "method declaration",
    );
  });

  it("reapplies target indentation for nested Python methods", () => {
    const originalPython = [
      "class Receiver:",
      "    def receive(self, value):",
      "        return None",
      "",
      "    def keep(self):",
      "        return True",
    ].join("\n");
    const patch = _buildFilePatch(
      "src/receiver.py",
      "def receive(self, value):\n    return value",
      originalPython,
      2,
      "Python",
    );
    const added = patch.hunks[0].lines
      .filter((line) => line.type === "add")
      .map((line) => line.content);

    expect(added).toEqual(["    def receive(self, value):", "        return value"]);
  });

  it("builds a protected patch for a complete class target", () => {
    const original = [
      "package demo;",
      "",
      "@Deprecated",
      "public class Factory {",
      "    private int threshold = 1;",
      "",
      "    public Factory() {",
      "        threshold = 2;",
      "    }",
      "}",
      "",
      "class Unchanged {}",
    ].join("\n");
    const generated = [
      "public class Factory {",
      "    private final int threshold = 3;",
      "",
      "    public Factory() {",
      "        threshold = 4;",
      "    }",
      "}",
    ].join("\n");

    const patch = _buildFilePatch(
      "src/Factory.java",
      generated,
      original,
      3,
      "Java",
      "class",
    );
    const added = patch.hunks[0].lines
      .filter((line) => line.type === "add")
      .map((line) => line.content);

    expect(added).toContain("public class Factory {");
    expect(added).toContain("    private final int threshold = 3;");
    expect(patch.hunks[0].lines.some((line) => line.type === "remove" && line.content.includes("threshold = 1"))).toBe(true);
  });

  it("does not let braces in strings or comments consume the next member", () => {
    const original = [
      "public sealed class Service",
      "{",
      "    public string Target()",
      "    {",
      "        var literal = \"{ not a block \";",
      "        // } also not a block",
      "        return literal;",
      "    }",
      "",
      "    public void Keep() { }",
      "}",
    ].join("\n");

    const patch = _buildFilePatch(
      "src/Service.cs",
      ["public string Target()", "{", "    return \"updated\";", "}"].join("\n"),
      original,
      3,
      "C#",
    );
    const removed = patch.hunks[0].lines
      .filter((line) => line.type === "remove")
      .map((line) => line.content)
      .join("\n");

    expect(removed).toContain("var literal");
    expect(removed).not.toContain("Keep()");
  });

  it("refuses an unterminated declaration instead of replacing the rest of the file", () => {
    const incomplete = [
      "public sealed class Service",
      "{",
      "    public void Target()",
      "    {",
      "        if (true) {",
      "            return;",
      "    }",
      "",
      "    public void Keep() { }",
      "}",
    ].join("\n");

    expect(() => _buildFilePatch(
      "src/Service.cs",
      ["public void Target()", "{", "}"].join("\n"),
      incomplete,
      3,
      "C#",
    )).toThrow("safe patch");
  });

  it("refuses to treat an enclosing type brace as the method closing brace", () => {
    const incomplete = [
      "public sealed class Service",
      "{",
      "    public void Target()",
      "    {",
      "        if (true)",
      "        {",
      "            return;",
      "        }",
      "}",
    ].join("\n");

    expect(() => _buildFilePatch(
      "src/Service.cs",
      ["public void Target()", "{", "}"].join("\n"),
      incomplete,
      3,
      "C#",
    )).toThrow("safe patch");
  });
});
