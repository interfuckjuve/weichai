import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerificationResult } from "./schemas/materialize-verification-result.js";
import {
  type VerificationInput,
  type VerificationStrategyDescriptor,
} from "./schemas/verification-types.js";
import {
  runVerificationCli,
  type VerificationCliDependencies,
} from "./verification-cli.js";

const sourceContent = "export function source() {\n  return 1;\n}\n";
const originalTargetContent =
  "def target():\n    raise NotImplementedError()\n";
const translatedTargetContent = "def target():\n    return 1\n";
const descriptor: VerificationStrategyDescriptor = {
  id: "differential-smoke",
  version: "2.0.0",
  displayName: "Differential Smoke",
};

let root: string;
let inputPath: string;
let outputPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-cli-test-"));
  inputPath = join(root, "input.json");
  outputPath = join(root, "out", "result.json");
  writeFileSync(inputPath, `${JSON.stringify(input())}\n`, "utf8");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runVerificationCli", () => {
  it("lists registered strategies without reading an input file", async () => {
    const output: string[] = [];
    const readMissing = join(root, "missing-input.json");
    const code = await runVerificationCli(
      ["--list-strategies", "--input", readMissing],
      {
        service: fakeService(),
        stdout: (line) => output.push(line),
        stderr: () => undefined,
      },
    );

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("differential-smoke\t2.0.0");
  });

  it("passes the explicit strategy and writes the result", async () => {
    const service = fakeService("fixture");
    const code = await runVerificationCli(
      ["--strategy", "fixture", "--input", inputPath, "--output", outputPath],
      dependencies(service),
    );

    expect(code).toBe(0);
    expect(service.verify).toHaveBeenCalledWith(
      expect.any(Object),
      { strategyId: "fixture", keepWorkspace: false },
      undefined,
    );
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      strategyId: "fixture",
    });
  });

  it("passes keep-workspace to the service", async () => {
    const service = fakeService("fixture");
    const code = await runVerificationCli(
      [
        "--strategy",
        "fixture",
        "--keep-workspace",
        "--input",
        inputPath,
        "--output",
        outputPath,
      ],
      dependencies(service),
    );

    expect(code).toBe(0);
    expect(service.verify).toHaveBeenCalledWith(
      expect.any(Object),
      { strategyId: "fixture", keepWorkspace: true },
      undefined,
    );
  });

  it("rejects missing flag values and unknown flags", async () => {
    const errors: string[] = [];
    const service = fakeService();

    expect(
      await runVerificationCli(["--input"], dependencies(service, errors)),
    ).toBe(1);
    expect(
      await runVerificationCli(["--wat"], dependencies(service, errors)),
    ).toBe(1);
    expect(errors.join("\n")).toContain("Missing value for --input");
    expect(errors.join("\n")).toContain("Unknown option: --wat");
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON without writing an output file", async () => {
    const errors: string[] = [];
    writeFileSync(inputPath, "{ nope", "utf8");

    const code = await runVerificationCli(
      ["--input", inputPath, "--output", outputPath],
      dependencies(fakeService(), errors),
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Invalid verification input JSON");
    expect(existsSync(outputPath)).toBe(false);
  });

  it("rejects schema-invalid JSON before dispatching the service", async () => {
    const service = fakeService();
    const errors: string[] = [];
    writeFileSync(
      inputPath,
      JSON.stringify({ ...input(), schemaVersion: "2.0" }),
    );
    expect(
      await runVerificationCli(
        ["--input", inputPath, "--output", outputPath],
        dependencies(service, errors),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/schemaVersion/);
    expect(service.verify).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(false);
  });

  it("rejects schema-invalid service output without replacing an existing output", async () => {
    const service = fakeService();
    const errors: string[] = [];
    const result = createVerificationResult(input(), descriptor, {
      summary: "ok",
      issues: [],
      artifacts: [],
      strategyReport: {},
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason:
        "The Host has not accepted the reference implementation.",
      executionStatus: "completed",
      sourceAssessment: "not_checked",
      targetAssessment: "no_bug_observed",
      problems: [],
    });
    service.verify.mockResolvedValueOnce(
      Object.assign({}, result, { status: "pass" }),
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "original");
    expect(
      await runVerificationCli(
        ["--input", inputPath, "--output", outputPath],
        dependencies(service, errors),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain(
      "Verification result must NOT be valid.",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("original");
  });

  it("rejects non-regular input files before calling the service", async () => {
    const errors: string[] = [];
    const service = fakeService();
    rmSync(inputPath, { force: true });
    mkdirSync(inputPath);

    const code = await runVerificationCli(
      ["--input", inputPath, "--output", outputPath],
      dependencies(service, errors),
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Verification input must be a regular file",
    );
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("rejects oversized input content before calling the service", async () => {
    const errors: string[] = [];
    const service = fakeService();
    writeFileSync(inputPath, "x".repeat(10 * 1024 * 1024 + 1), "utf8");

    const code = await runVerificationCli(
      ["--input", inputPath, "--output", outputPath],
      dependencies(service, errors),
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Verification input file exceeds 10485760 bytes",
    );
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("removes the temporary output file when atomic write fails", async () => {
    const errors: string[] = [];
    mkdirSync(outputPath, { recursive: true });

    const code = await runVerificationCli(
      ["--input", inputPath, "--output", outputPath],
      dependencies(fakeService(), errors),
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Failed to write verification result");
    expect(
      readdirSync(dirname(outputPath)).filter((name) =>
        name.startsWith(`${basename(outputPath)}.`),
      ),
    ).toEqual([]);
  });

  it("returns exit code 1 for service errors", async () => {
    const errors: string[] = [];
    const service = fakeService();
    service.verify.mockRejectedValueOnce(new Error("service boom"));

    const code = await runVerificationCli(
      ["--input", inputPath, "--output", outputPath],
      dependencies(service, errors),
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("service boom");
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe("smoke E2E strategy parser", () => {
  it("runs offline with the default strategy and accepts an explicit strategy", () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const base = ["run", "e2e", "--", "--offline-only"];

    const defaultOutput = execFileSync("npm", base, {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const explicitOutput = execFileSync(
      "npm",
      [...base, "--strategy", "differential-smoke"],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(defaultOutput).toContain("跳过 smoke E2E");
    expect(explicitOutput).toContain("跳过 smoke E2E");
  });

  it("rejects a strategy flag without a value", () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

    try {
      execFileSync(
        "npm",
        ["run", "e2e", "--", "--strategy", "--offline-only"],
        {
          cwd: packageRoot,
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      throw new Error("expected e2e command to fail");
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer };
      expect(failure.status).toBe(2);
      expect(failure.stderr?.toString("utf8")).toContain(
        "Missing value for --strategy",
      );
    }
  });

  it("reports unknown strategy explicitly", () => {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

    try {
      execFileSync(
        "npm",
        ["run", "e2e", "--", "--offline-only", "--strategy", "missing"],
        {
          cwd: packageRoot,
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      throw new Error("expected e2e command to fail");
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer };
      expect(failure.status).toBe(2);
      expect(failure.stderr?.toString("utf8")).toContain(
        "unknown smoke E2E strategy: missing",
      );
    }
  });
});

function dependencies(
  service: ReturnType<typeof fakeService>,
  errors: string[] = [],
): VerificationCliDependencies {
  return {
    service,
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  };
}

function fakeService(strategyId = "differential-smoke") {
  return {
    listStrategies: vi.fn(() => [descriptor]),
    verify: vi.fn(
      async (
        inputValue: VerificationInput,
        options: { strategyId?: string },
      ) => {
        return createVerificationResult(
          inputValue,
          { ...descriptor, id: options.strategyId ?? strategyId },
          {
            summary: "verified",
            issues: [],
            artifacts: [],
            strategyReport: { ok: true },
            mode: "target_only",
            referenceDecision: "undetermined",
            referenceReason:
              "The Host has not accepted the reference implementation.",
            executionStatus: "completed",
            sourceAssessment: "not_checked",
            targetAssessment: "no_bug_observed",
            problems: [],
          },
        );
      },
    ),
  };
}

function input(files: FilePatch[] = [modifiedPatch()]): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: {
      sourceBundle: {
        files: [
          {
            path: "src/source.ts",
            content: sourceContent,
            contentHash: sha256(sourceContent),
          },
        ],
      },
      targetContext: {
        sourceFiles: [
          {
            path: "src/target.py",
            content: originalTargetContent,
            contentHash: sha256(originalTargetContent),
          },
        ],
      },
    } as AdaptationRequestV2,
    analysisReport: { kind: "analysis" },
    migrationPlan: { kind: "plan" },
    translation: {
      round: 1,
      generatedContent: translatedTargetContent,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

function modifiedPatch(): FilePatch {
  return {
    path: "src/target.py",
    status: "modified",
    expectedOriginalSha256: sha256(originalTargetContent),
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        lines: [
          { type: "context", content: "def target():" },
          { type: "remove", content: "    raise NotImplementedError()" },
          { type: "add", content: "    return 1" },
        ],
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
