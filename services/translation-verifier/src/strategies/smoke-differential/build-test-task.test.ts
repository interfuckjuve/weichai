import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareAgentTask } from "./build-test-task.js";
import { prepareSmokeProjects } from "./prepare-projects.js";
import { createWorkspace } from "./create-smoke-workspace.js";
import { VERIFIER_COMMAND_ENTRY, packageRoot } from "./test-execution-config.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    const stat = statSync(path);
    return [path, stat.ino, stat.mtimeMs, entry.isFile() ? readFileSync(path, "utf8") : null];
  });
}

const job: SmokeTaskInput = {
  requirement: "identity",
  source: { language: "TypeScript", files: [{ relativePath: "identity.ts", content: "export const identity = (x: string) => x;\n" }] },
  target: { language: "Python", className: "Identity", method: "identity", isStatic: true, file: "identity.py" },
};

describe("prepared smoke task", () => {
  it("constructs prompts and session settings without copying, writing or re-baselining projects", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-layout-"));
    const workspace = createWorkspace(root);
    try {
      const layout = prepareSmokeProjects(job, {}, workspace);
      const source = join(layout.projectRoots[0], "identity.ts");
      expect(readFileSync(source, "utf8")).toBe(job.source.files![0].content);
      writeFileSync(source, "prepared project must not be restaged\n");
      const before = snapshot(workspace.dir);
      const task = prepareAgentTask(job, {}, layout);
      expect(snapshot(workspace.dir)).toEqual(before);
      expect(task.layout).toBe(layout);
      expect(task.prompt).toContain(layout.projectRoots[0]);
      expect(task.llm.cwd).toBe(layout.agentDir);
      expect(task.llm.readOnlyDirs).toEqual(layout.projectRoots);
      expect(task.llm.allowedTools).toEqual([`Bash(npx tsx ${join(packageRoot, "src/strategies/smoke-differential/controlled-test-command.ts")} *)`]);
      expect(VERIFIER_COMMAND_ENTRY).toBe(join(packageRoot, "src/strategies/smoke-differential/controlled-test-command.ts"));
      expect(task.prompt).not.toContain("differential-smoke/verifier-command.ts");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps caller-owned prepared layouts unchanged and preserves cancellation identity", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-caller-"));
    const workspace = createWorkspace(root);
    try {
      const prepared = prepareSmokeProjects(job, {}, workspace);
      const options = { workspaceDir: prepared.agentDir, executionRoot: prepared.executionRoot, baselinePath: prepared.baselinePath, commandEvidencePath: prepared.evidencePath, runnerRoots: prepared.runnerRoots };
      const callerJob = { ...job, source: { ...job.source, root: prepared.projectRoots[0] }, target: { ...job.target, root: prepared.projectRoots[1] } };
      const before = snapshot(workspace.dir);
      const layout = prepareSmokeProjects(callerJob, options, null);
      const task = prepareAgentTask(callerJob, options, layout);
      expect(task.layout).toEqual(prepared);
      expect(snapshot(workspace.dir)).toEqual(before);
      const error = new DOMException("cancel", "AbortError");
      expect(() => prepareAgentTask(callerJob, options, layout, AbortSignal.abort(error))).toThrow(error);
      expect(snapshot(workspace.dir)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
