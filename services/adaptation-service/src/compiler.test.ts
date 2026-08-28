import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileIntegrated,
  compileTargetStandalone,
  compilerInternals,
} from "./compiler";

const skeletonProjectPath = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

describe("integrated compiler source replacement", () => {
  it("adds framework usings without using the target method as the wrapper type", () => {
    const source = compilerInternals.buildWrapperSource(
      "public ValueTask<long> AppendAsync(CancellationToken cancellationToken) { return ValueTask.FromResult(1L); }",
      "ForeXploreStandalone",
    );

    expect(source).toContain("using System.Threading;");
    expect(source).toContain("using System.Threading.Tasks;");
    expect(source).toContain("public class ForeXploreStandalone");
    expect(source).not.toContain("public class AppendAsync");
  });

  it("buildWrapperSource 按需补齐 using System.IO(引用 Stream 时)", () => {
    const source = compilerInternals.buildWrapperSource(
      "public int ReadBodyData(Stream? output) { return output == null ? 0 : 1; }",
      "ForeXploreStandalone",
    );

    expect(source).toContain("using System.IO;");
  });

  it("buildWrapperSource 不重复补已有 using 或全限定引用的命名空间", () => {
    const withUsing = compilerInternals.buildWrapperSource(
      "using System.IO;\npublic int ReadBodyData(Stream output) { return 0; }",
      "ForeXploreStandalone",
    );
    expect(withUsing.match(/using System\.IO;/g)).toHaveLength(1);

    const fullyQualified = compilerInternals.buildWrapperSource(
      "public int ReadBodyData(System.IO.Stream output) { return 0; }",
      "ForeXploreStandalone",
    );
    expect(fullyQualified).not.toContain("using System.IO;");
  });

  it("csharpRequiredUsings 对无 IO 引用的代码不补 System.IO", () => {
    const usings = compilerInternals.csharpRequiredUsings(
      "public int Add(int a, int b) { return a + b; }",
    );
    expect(usings).not.toContain("System.IO");
  });

  it("resolves paths prefixed by the skeleton project directory", () => {
    const resolved = compilerInternals.resolveProjectTargetFile(
      skeletonProjectPath,
      "weichai/fixtures/target-system/forexplore-csharp-workspace/src/Application/AuditPipeline.cs",
    );

    expect(resolved?.relativePath.replace(/\\/g, "/")).toBe(
      "src/Application/AuditPipeline.cs",
    );
  });

  it("replaces only the selected method and keeps the surrounding class", () => {
    const source = `public sealed class Quotes
{
    public string Keep() => "keep";

    public async Task<string> LoadAsync(CancellationToken cancellationToken)
    {
        throw new NotImplementedException("target");
    }
}`;
    const generated = `public async Task<string> LoadAsync(CancellationToken cancellationToken)
{
    cancellationToken.ThrowIfCancellationRequested();
    return "loaded";
}`;

    const result = compilerInternals.replaceTargetMethod(source, generated);

    expect(result).toContain('public string Keep() => "keep";');
    expect(result).toContain('return "loaded";');
    expect(result).not.toContain("NotImplementedException");
  });

  it("replaces a complete class while preserving the rest of the source file", () => {
    const source = `package demo;

public class Factory {
    private int threshold = 1;

    public Factory() {
        threshold = 2;
    }
}

class Unchanged { }
`;
    const generated = `public class Factory {
    private final int threshold = 3;

    public Factory() {
        threshold = 4;
    }
}`;

    const result = compilerInternals.replaceTargetClass(source, generated);

    expect(result).toContain("package demo;");
    expect(result).toContain("private final int threshold = 3;");
    expect(result).toContain("class Unchanged { }");
    expect(result).not.toContain("private int threshold = 1;");
  });

  it("replaces a complete Python class without touching a neighboring class", () => {
    const source = `class Factory:
    threshold = 1

    def create(self):
        return None

class Unchanged:
    pass
`;
    const generated = `class Factory:
    threshold = 3

    def create(self):
        return object()
`;

    const result = compilerInternals.replacePythonTargetClass(source, generated);

    expect(result).toContain("threshold = 3");
    expect(result).toContain("return object()");
    expect(result).toContain("class Unchanged:");
    expect(result).not.toContain("threshold = 1");
  });

  it("selects the matching overload when a target class has repeated method names", () => {
    const source = `public class Uploads {
    public void parseRequest(HttpServletRequest request) {
        throw new UnsupportedOperationException("http");
    }

    public void parseRequest(RequestContext context) {
        throw new UnsupportedOperationException("context");
    }
}`;
    const generated = `public void parseRequest(RequestContext context) {
    return;
}`;

    const result = compilerInternals.replaceTargetMethod(source, generated);

    expect(result).toContain('UnsupportedOperationException("http")');
    expect(result).not.toContain('UnsupportedOperationException("context")');
    expect(result).toContain("public void parseRequest(RequestContext context) {");
  });

  it("rejects generated methods that do not exist in the target source", () => {
    expect(() =>
      compilerInternals.replaceTargetMethod(
        "public sealed class Quotes {}",
        "public void Missing() {}",
      ),
    ).toThrow("Target method Missing was not found");
  });

  it("rejects target paths outside the skeleton before invoking dotnet", () => {
    const result = compileIntegrated("public void Missing() {}", process.cwd(), "../outside.cs");

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("must stay inside the skeleton project");
  });

  it.runIf(process.env.RUN_DOTNET_INTEGRATION === "1")(
    "replaces a delivered skeleton method and builds the temporary project",
    () => {
      const result = compileIntegrated(
        `public async Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)
{
    return await cache.GetOrLoadAsync(
        request,
        token => FetchWithFallbackAsync(request, token),
        cancellationToken);
}`,
        skeletonProjectPath,
        "src/Application/QuoteOrchestrationService.cs",
      );

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      // 集成编译保留目录:返回 workspacePath 且保留替换后的目标文件。
      expect(result.workspacePath).toBeTruthy();
      expect(existsSync(result.workspacePath!)).toBe(true);
      expect(
        existsSync(join(result.workspacePath!, "src/Application/QuoteOrchestrationService.cs")),
      ).toBe(true);
    },
    30_000,
  );
});

describe("language-neutral compiler registry", () => {
  it("validates a Python target through the same registry entry used by the adapter", () => {
    const result = compileTargetStandalone(
      "Python",
      "def parse_attributes(value: str | None) -> dict[str, str]:\n    return {}",
      "ForeXploreStandalone",
    );

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
