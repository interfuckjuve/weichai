import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { VerificationInput } from "../src/types.js";

const execFileAsync = promisify(execFile);

export const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/commons-fileupload-read-body-data/", import.meta.url),
);
export const SOURCE_PROJECT_ROOT = join(FIXTURE_ROOT, "reference-project");
export const TARGET_BEFORE_ROOT = join(FIXTURE_ROOT, "target-project-before");
export const TARGET_AFTER_ROOT = join(FIXTURE_ROOT, "target-project-after");
export const TARGET_FUNCTION_PATH =
  "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
export const GENERATED_TEST_PATH =
  "src/test/java/org/apache/commons/fileupload/TranslationVerifierReadBodyDataTest.java";

const FIXTURE_INPUT_PATH = join(FIXTURE_ROOT, "input.json");

type FixtureInputDocument = Omit<
  VerificationInput,
  "sourceProjectPath" | "targetProjectPath"
> & {
  sourceProjectPath: string;
  targetProjectPath: string;
};

export type FixtureWorkspace = {
  fixtureRoot: string;
  sourceRoot: string;
  targetBeforeRoot: string;
  targetAfterRoot: string;
  repositoryRoot: string;
  targetRoot: string;
  dispose(): Promise<void>;
};

export async function createFixtureWorkspace(): Promise<FixtureWorkspace> {
  const runRoot = await mkdtemp(join(tmpdir(), "translation-verifier-e2e-"));
  const repositoryRoot = join(runRoot, "target-repository");
  const targetRoot = join(runRoot, "target-worktree");

  try {
    await cp(TARGET_AFTER_ROOT, repositoryRoot, { recursive: true });
    await runGit(repositoryRoot, ["init", "--quiet"]);
    await runGit(repositoryRoot, [
      "config",
      "user.email",
      "translation-verifier-e2e@example.invalid",
    ]);
    await runGit(repositoryRoot, [
      "config",
      "user.name",
      "translation-verifier-e2e",
    ]);
    await runGit(repositoryRoot, ["add", "--all"]);
    await runGit(repositoryRoot, ["commit", "--quiet", "-m", "fixture baseline"]);
    await runGit(repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      targetRoot,
      "HEAD",
    ]);

    return {
      fixtureRoot: FIXTURE_ROOT,
      sourceRoot: SOURCE_PROJECT_ROOT,
      targetBeforeRoot: TARGET_BEFORE_ROOT,
      targetAfterRoot: TARGET_AFTER_ROOT,
      repositoryRoot,
      targetRoot,
      dispose: async () => {
        try {
          await runGit(repositoryRoot, [
            "worktree",
            "remove",
            "--force",
            targetRoot,
          ]);
        } catch {
          // The temporary root is removed below even if Git already removed it.
        }
        await rm(runRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeFixtureInput(
  workspace: FixtureWorkspace,
): Promise<VerificationInput> {
  const raw = JSON.parse(
    await readFile(FIXTURE_INPUT_PATH, "utf8"),
  ) as FixtureInputDocument;
  if (raw.sourceProjectPath !== "reference-project") {
    throw new Error(
      `Fixture input sourceProjectPath must be reference-project: ${raw.sourceProjectPath}`,
    );
  }
  if (raw.targetProjectPath !== "target-project-after") {
    throw new Error(
      `Fixture input targetProjectPath must be target-project-after: ${raw.targetProjectPath}`,
    );
  }

  await verifyTranslationPatch(raw, workspace);
  return {
    ...raw,
    sourceProjectPath: workspace.sourceRoot,
    targetProjectPath: workspace.targetRoot,
  };
}

export async function readFixtureFile(
  root: string,
  path: string,
): Promise<string> {
  return readFile(resolveProjectPath(root, path), "utf8");
}

export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    maxBuffer: 2_000_000,
  });
  return String(result.stdout).trim();
}

async function verifyTranslationPatch(
  input: FixtureInputDocument,
  workspace: FixtureWorkspace,
): Promise<void> {
  if (input.translation.files.length !== 1) {
    throw new Error("The fixture currently expects exactly one translated file.");
  }
  const patch = input.translation.files[0]!;
  const beforePath = resolveProjectPath(workspace.targetBeforeRoot, patch.path);
  const afterPath = resolveProjectPath(workspace.targetAfterRoot, patch.path);
  const worktreePath = resolveProjectPath(workspace.targetRoot, patch.path);
  const before = await readFile(beforePath, "utf8");
  const after = await readFile(afterPath, "utf8");
  const staged = await readFile(worktreePath, "utf8");

  const actualHash = createHash("sha256").update(before).digest("hex");
  if (patch.status !== "modified" || patch.expectedOriginalSha256 !== actualHash) {
    throw new Error(
      `Fixture translation patch does not match target-project-before: ${patch.path}`,
    );
  }
  if (staged !== after) {
    throw new Error(
      `Target worktree does not start from target-project-after: ${patch.path}`,
    );
  }

  const reconstructed = applyPatch(before, patch.hunks);
  if (reconstructed !== after) {
    throw new Error(
      `Applying input.json translation patch does not reproduce target-project-after: ${patch.path}`,
    );
  }
}

function applyPatch(
  original: string,
  hunks: readonly { lines: readonly { type: string; content: string }[] }[],
): string {
  let result = original;
  let searchFrom = 0;
  for (const hunk of hunks) {
    const removed = hunk.lines
      .filter((line) => line.type === "remove")
      .map((line) => line.content)
      .join("\n");
    const added = hunk.lines
      .filter((line) => line.type === "add")
      .map((line) => line.content)
      .join("\n");
    const start = result.indexOf(removed, searchFrom);
    if (start < 0) throw new Error("Translation patch precondition does not match.");
    result = result.slice(0, start) + added + result.slice(start + removed.length);
    searchFrom = start + added.length;
  }
  return result;
}

function resolveProjectPath(root: string, path: string): string {
  const candidate = resolve(root, ...path.split("/"));
  const outside = relative(root, candidate);
  if (outside === ".." || outside.startsWith(`..${sep}`) || outside === "") {
    throw new Error(`Fixture path is outside project root: ${path}`);
  }
  return candidate;
}
