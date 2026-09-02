import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleTarget, TargetModuleContext } from "@forexplore/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { _buildFilePatch } from "./adaptation-adapter";
import {
  collectTargetContextSnapshot,
  createDefaultTargetEngineeringAdapterRegistry,
  locateTargetPatch,
  TargetEngineeringAdapterRegistry,
  type TargetContextSnapshot,
  type TargetEngineeringAdapter,
} from "./context-collector";

const temporaryRoots: string[] = [];

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forexplore-target-engineering-"));
  temporaryRoots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const fullPath = join(root, ...path.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, source, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TargetEngineeringAdapterRegistry", () => {
  it("collects and locates a Python top-level function without consuming a sibling", async () => {
    const targetSource = [
      "from .model import Payload",
      "",
      "def normalize(payload: Payload) -> Payload:",
      "    note = \"\"\"braces and fake declarations are data:",
      "def keep(fake):",
      "    return {fake}",
      "\"\"\"",
      "    return Payload(payload.value.strip())",
      "",
      "def keep(value: str) -> str:",
      "    return value",
      "",
    ].join("\n");
    const root = await createProject({
      "src/model.py": [
        "class Payload:",
        "    def __init__(self, value: str):",
        "        self.value = value",
        "",
      ].join("\n"),
      "src/ops.py": targetSource,
      "src/caller.py": "from .ops import normalize\n\nresult = normalize(Payload(' x '))\n",
    });
    const target: ModuleTarget = {
      id: "normalize",
      name: "normalize",
      kind: "function",
      path: "src/ops.py",
      language: "Python",
      signature: "def normalize(payload: Payload) -> Payload",
      line: 3,
    };

    const result = collectTargetContextSnapshot({ projectRoot: root, target });

    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error(result.reason.detail);
    expect(result.value.languageId).toBe("python");
    expect(result.value.ownerKind).toBe("module");
    expect(result.value.context.source.method).toContain("def normalize");
    expect(result.value.context.source.method).not.toContain("def keep(value");
    expect(result.value.context.source.usings).toContain("from .model import Payload");
    expect(result.value.context.relatedTypes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Payload", path: "src/model.py" })]),
    );
    expect(result.value.context.callers).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/caller.py", line: 3 })]),
    );

    const patch = _buildFilePatch(
      "src/ops.py",
      "def normalize(payload: Payload) -> Payload:\n    return payload",
      targetSource,
      3,
      "Python",
      "function",
      createDefaultTargetEngineeringAdapterRegistry(),
      "normalize",
    );
    const removed = patch.hunks[0].lines
      .filter((line) => line.type === "remove")
      .map((line) => line.content)
      .join("\n");
    expect(removed).toContain("def normalize");
    expect(removed).not.toContain("def keep(value");
  });

  it("collects and locates a TypeScript module function with template literals", async () => {
    const targetSource = [
      "import type { Options } from './types';",
      "",
      "export const format = (value: string, options: Options): string => {",
      "  const template = `fake close } and expression ${value}`;",
      "  return `${options.prefix}:${template}`;",
      "};",
      "",
      "export function keep(value: string): string {",
      "  return value;",
      "}",
      "",
    ].join("\n");
    const root = await createProject({
      "src/types.ts": "export interface Options {\n  prefix: string;\n}\n",
      "src/format.ts": targetSource,
      "src/caller.ts": "import { format } from './format';\n\nexport const rendered = format('x', { prefix: 'p' });\n",
    });
    const target: ModuleTarget = {
      id: "format",
      name: "format",
      kind: "function",
      path: "src/format.ts",
      language: "TypeScript",
      signature: "const format: (value: string, options: Options) => string",
      line: 3,
    };

    const result = collectTargetContextSnapshot({ projectRoot: root, target });

    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error(result.reason.detail);
    expect(result.value.languageId).toBe("typescript");
    expect(result.value.ownerKind).toBe("module");
    expect(result.value.context.source.method).toContain("fake close }");
    expect(result.value.context.source.method).not.toContain("function keep");
    expect(result.value.context.relatedTypes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Options", path: "src/types.ts" })]),
    );
    expect(result.value.context.callers).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/caller.ts", line: 3 })]),
    );

    const patch = _buildFilePatch(
      "src/format.ts",
      "export const format = (value: string, options: Options): string => {\n  return value;\n};",
      targetSource,
      3,
      "TypeScript",
      "function",
      createDefaultTargetEngineeringAdapterRegistry(),
      "format",
    );
    const removed = patch.hunks[0].lines
      .filter((line) => line.type === "remove")
      .map((line) => line.content)
      .join("\n");
    expect(removed).toContain("fake close }");
    expect(removed).not.toContain("function keep");
  });

  it("supports injected adapters without editing the default registry", async () => {
    const root = await createProject({ "module.py": "def custom():\n    return 1\n" });
    const target: ModuleTarget = {
      id: "custom",
      name: "custom",
      kind: "function",
      path: "module.py",
      language: "Python",
      signature: "def custom() -> int",
      line: 1,
    };
    const context = emptyContext(target);
    const snapshot: TargetContextSnapshot = {
      schemaVersion: "1.0",
      languageId: "python",
      ownerKind: "module",
      adapter: { id: "test.python", version: "1", languageId: "python" },
      context,
    };
    const customAdapter: TargetEngineeringAdapter = {
      descriptor: {
        id: "test.python",
        version: "1",
        languageId: "python",
        context: {
          status: "supported",
          targetKinds: ["function"],
          ownerKinds: ["module"],
          relatedFileExtensions: [".py"],
        },
        patchLocator: { status: "supported", targetKinds: ["function"] },
        quality: {
          level: "language-aware-lexical-heuristic",
          provesBehavioralCorrectness: false,
          failClosed: true,
          limitations: ["Test adapter supplies deterministic boundaries only."],
        },
      },
      collectContext: () => ({ status: "supported", value: snapshot }),
      locatePatch: () => ({
        status: "supported",
        value: { startLine: 0, endLine: 1, declarationIndentation: "" },
      }),
    };
    const registry = new TargetEngineeringAdapterRegistry([customAdapter]);

    expect(collectTargetContextSnapshot({ projectRoot: root, target, adapterRegistry: registry }))
      .toEqual({ status: "supported", value: snapshot });
    expect(locateTargetPatch(
      "Python",
      { source: "def custom():\n    return 1\n", targetLine: 1, targetKind: "function" },
      registry,
    )).toEqual({
      status: "supported",
      value: { startLine: 0, endLine: 1, declarationIndentation: "" },
    });
  });

  it("fails closed for missing and declared capability gaps", async () => {
    const root = await createProject({ "module.py": "def custom():\n    return 1\n" });
    const target: ModuleTarget = {
      id: "custom",
      name: "custom",
      kind: "function",
      path: "module.py",
      language: "Python",
      signature: "def custom() -> int",
      line: 1,
    };
    const missing = collectTargetContextSnapshot({
      projectRoot: root,
      target,
      adapterRegistry: new TargetEngineeringAdapterRegistry(),
    });
    expect(missing).toEqual({
      status: "unsupported",
      reason: expect.objectContaining({
        code: "TARGET_ENGINEERING_ADAPTER_UNAVAILABLE",
        stage: "context",
        languageId: "python",
        retryable: false,
      }),
    });

    const registry = createDefaultTargetEngineeringAdapterRegistry();
    const goPatch = locateTargetPatch(
      "Go",
      { source: "func target() {}", targetLine: 1, targetKind: "function" },
      registry,
    );
    expect(goPatch).toEqual({
      status: "unsupported",
      reason: expect.objectContaining({
        code: "TARGET_PATCH_LOCATOR_CAPABILITY_UNAVAILABLE",
        languageId: "go",
        retryable: false,
      }),
    });
    expect(registry.capabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        languageId: "python",
        context: expect.objectContaining({ status: "supported", ownerKinds: ["type", "module"] }),
      }),
      expect.objectContaining({
        languageId: "typescript",
        patchLocator: expect.objectContaining({ status: "supported" }),
      }),
      expect.objectContaining({
        languageId: "go",
        context: expect.objectContaining({ status: "unsupported" }),
        quality: expect.objectContaining({ provesBehavioralCorrectness: false, failClosed: true }),
      }),
      expect.objectContaining({
        languageId: "rust",
        patchLocator: expect.objectContaining({ status: "unsupported" }),
      }),
    ]));
  });
});

function emptyContext(target: ModuleTarget): TargetModuleContext {
  return {
    schemaVersion: "1.0",
    target,
    source: {
      usings: [],
      method: "def custom():\n    return 1",
      containingType: "def custom():\n    return 1",
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
      targetFile: target.path,
      maxChars: 1_000,
      actualChars: 0,
      truncated: false,
      truncatedSections: [],
    },
  };
}
