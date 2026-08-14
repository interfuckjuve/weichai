import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileIntegrated, compilerInternals } from "./compiler";

const skeletonProjectPath = new URL(
  "../../../fixtures/target-system/forexplore-csharp-workspace",
  import.meta.url,
).pathname;

describe("integrated compiler source replacement", () => {
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

  it("rejects generated methods that do not exist in the target source", () => {
    expect(() =>
      compilerInternals.replaceTargetMethod(
        "public sealed class Quotes {}",
        "public void Missing() {}",
      ),
    ).toThrow("Target method Missing was not found");
  });

  it("reports missing target files before invoking dotnet", () => {
    const result = compileIntegrated("public void Missing() {}", process.cwd(), "../outside.cs");

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("does not exist");
  });

  it.runIf(process.env.RUN_DOTNET_INTEGRATION === "1")(
    "compiles target files outside the skeleton (user's own repository)",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "forexplore-user-src-"));
      const userFile = join(tmp, "Main.cs");
      writeFileSync(
        userFile,
        [
          "// user's own file",
          "using System;",
          "",
          "namespace HelloWorldApp",
          "{",
          "    class Program",
          "    {",
          "        static void Main(string[] args)",
          "        {",
          "            throw new NotImplementedException();",
          "        }",
          "    }",
          "}",
        ].join("\n"),
        "utf-8",
      );

      try {
        const result = compileIntegrated(
          `static void Main(string[] args)\n{\n    Console.WriteLine("hi");\n}`,
          skeletonProjectPath,
          userFile,
        );
        expect(result.errors).toEqual([]);
        expect(result.success).toBe(true);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    30_000,
  );

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
    },
    30_000,
  );
});
