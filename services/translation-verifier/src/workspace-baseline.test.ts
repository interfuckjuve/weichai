import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceBaseline,
  createWorkspaceBaseline,
  writeWorkspaceBaseline,
} from "./workspace-baseline";

const RUNNER_ROOTS = ["source/.forexplore-tests", "target/.forexplore-tests"] as const;
const MUTABLE_FILES = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

let root: string;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function seedWorkspace(): void {
  mkdirSync(join(root, "source", "project", "src"), { recursive: true });
  mkdirSync(join(root, "target", "project", "src"), { recursive: true });
  mkdirSync(join(root, "source", ".forexplore-tests"), { recursive: true });
  mkdirSync(join(root, "target", ".forexplore-tests"), { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "source", "project", "src", "Source.java"), "class Source {}", "utf8");
  writeFileSync(join(root, "target", "project", "src", "Target.cs"), "class Target {}", "utf8");
  writeFileSync(join(root, "metadata.json"), '{"role":"unit"}\n', "utf8");
}

function writeBaseline(artifactNames?: readonly string[]): void {
  const baseline = createWorkspaceBaseline(root, RUNNER_ROOTS, MUTABLE_FILES, artifactNames);
  writeWorkspaceBaseline(join(root, "baseline.json"), baseline);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fx-workspace-baseline-"));
  seedWorkspace();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createWorkspaceBaseline", () => {
  it("哈希受保护项目文件并按固定相对路径登记 runner 根", () => {
    const baseline = createWorkspaceBaseline(root, RUNNER_ROOTS, MUTABLE_FILES);

    expect(baseline.schemaVersion).toBe("1.0");
    expect(baseline.workspaceRoot).toBe(root);
    expect(baseline.runnerRoots).toEqual(RUNNER_ROOTS);
    expect(baseline.mutableFiles).toEqual(MUTABLE_FILES);
    expect(baseline.protectedFiles).toEqual(
      expect.arrayContaining([
        { relativePath: "source/project/src/Source.java", sha256: sha256("class Source {}") },
        { relativePath: "target/project/src/Target.cs", sha256: sha256("class Target {}") },
        { relativePath: "metadata.json", sha256: sha256('{"role":"unit"}\n') },
      ]),
    );
  });

  it("拒绝与 smoke 契约不一致的 runner/mutable 根", () => {
    expect(() =>
      createWorkspaceBaseline(root, ["elsewhere", "source/.forexplore-tests"], MUTABLE_FILES),
    ).toThrow(/runnerRoots/);
    expect(() =>
      createWorkspaceBaseline(
        root,
        RUNNER_ROOTS,
        ["agent/other.json", "agent/claude-steps.jsonl", "agent/commands.jsonl"],
      ),
    ).toThrow(/mutableFiles/);
  });

  it("把登记产物目录内的文件排除在保护之外", () => {
    mkdirSync(join(root, "source", "project", "bin"), { recursive: true });
    writeFileSync(join(root, "source", "project", "bin", "out.dll"), "binary", "utf8");
    const baseline = createWorkspaceBaseline(root, RUNNER_ROOTS, MUTABLE_FILES, ["bin"]);

    expect(baseline.protectedFiles.some((f) => f.relativePath.includes("out.dll"))).toBe(false);
  });
});

describe("assertWorkspaceBaseline", () => {
  it("受保护文件被修改时报出相对路径", () => {
    writeBaseline();
    const target = join(root, "target", "project", "src", "Target.cs");
    writeFileSync(target, "class Target { int x = 1; }", "utf8");

    expect(() => assertWorkspaceBaseline(root, join(root, "baseline.json"))).toThrow(
      /Target\.cs/,
    );
  });

  it("runner 根内新增文件、产物目录新文件和可变文件都被放行", () => {
    writeBaseline();
    writeFileSync(
      join(root, "source", ".forexplore-tests", "SourceRunner.java"),
      "class SourceRunner {}",
      "utf8",
    );
    mkdirSync(join(root, "target", "project", "obj"), { recursive: true });
    writeFileSync(join(root, "target", "project", "obj", "generated.cs"), "x", "utf8");
    writeFileSync(join(root, "agent", "report.json"), "{}", "utf8");
    writeFileSync(join(root, "agent", "commands.jsonl"), "", "utf8");
    expect(() => assertWorkspaceBaseline(root, join(root, "baseline.json"))).not.toThrow();
  });

  it("非 runner/产物/可变位置出现新文件时报出新路径", () => {
    writeBaseline();
    writeFileSync(join(root, "source", "project", "Shadow.java"), "class Shadow {}", "utf8");

    expect(() => assertWorkspaceBaseline(root, join(root, "baseline.json"))).toThrow(
      /Shadow\.java/,
    );
  });

  it("受保护文件被删除时报错", () => {
    writeBaseline();
    rmSync(join(root, "metadata.json"));

    expect(() => assertWorkspaceBaseline(root, join(root, "baseline.json"))).toThrow(
      /metadata\.json/,
    );
  });

  it("baseline.json 自身变更不影响自检", () => {
    writeBaseline();
    writeFileSync(join(root, "baseline.json"), "{}\n", "utf8");
    expect(() => assertWorkspaceBaseline(root, join(root, "baseline.json"))).toThrow(
      /protectedFiles/,
    );
  });
});
