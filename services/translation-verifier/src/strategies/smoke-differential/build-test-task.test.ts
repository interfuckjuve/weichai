import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptedPolicy } from "./differential-test-fixtures.js";
import { prepareAgentTask } from "./build-test-task.js";
import { prepareSmokeWorkspaceFixture } from "./prepared-workspace-fixture.js";
import {
  VERIFIER_COMMAND_ENTRY,
  packageRoot,
} from "./test-execution-config.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

function snapshot(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map(
    (entry) => {
      const path = join(entry.parentPath, entry.name);
      const stat = statSync(path);
      return [
        path,
        stat.ino,
        stat.mtimeMs,
        entry.isFile() ? readFileSync(path, "utf8") : null,
      ];
    },
  );
}
const job: SmokeTaskInput = {
  verificationPolicy: acceptedPolicy,
  requirement: "identity",
  source: { language: "TypeScript", candidatePath: "identity.ts" },
  target: {
    language: "Python",
    className: "Identity",
    method: "identity",
    isStatic: true,
    file: "identity.py",
  },
};
afterEach(() => vi.restoreAllMocks());

describe("prepared smoke task", () => {
  it("prepares unique layouts under a nested caller root with fixed report and evidence paths", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-roots-"));
    try {
      const parent = join(root, "nested", "workspaces");
      const first = prepareSmokeWorkspaceFixture(parent, job);
      const second = prepareSmokeWorkspaceFixture(parent, job);
      expect(first.layout.executionRoot).not.toBe(second.layout.executionRoot);
      expect(first.layout.executionRoot.startsWith(parent)).toBe(true);
      expect(existsSync(first.layout.agentDir)).toBe(true);
      expect(first.layout.evidencePath).toBe(
        join(first.layout.agentDir, "commands.jsonl"),
      );
      expect(first.layout.baselinePath).toBe(
        join(first.layout.executionRoot, "baseline.json"),
      );
      first.cleanup();
      first.cleanup();
      expect(existsSync(first.layout.executionRoot)).toBe(false);
      expect(existsSync(second.layout.executionRoot)).toBe(true);
      expect(existsSync(parent)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("constructs prompts and session settings without copying, writing or re-baselining projects", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-layout-"));
    try {
      const ws = prepareSmokeWorkspaceFixture(root, job);
      const { layout } = ws;
      const source = join(layout.projectRoots[0], "identity.ts");
      expect(readFileSync(source, "utf8")).toContain(
        "prepared test implementation",
      );
      writeFileSync(source, "prepared project must not be restaged\n");
      const before = snapshot(layout.executionRoot);
      const task = prepareAgentTask(ws.job, ws);
      expect(snapshot(layout.executionRoot)).toEqual(before);
      expect(task.layout).toBe(layout);
      expect(task.prompt).toContain(layout.projectRoots[0]);
      expect(task.llm.cwd).toBe(layout.agentDir);
      expect(task.llm.readOnlyDirs).toEqual(layout.projectRoots);
      expect(task.llm.allowedTools).toEqual([
        `Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`,
      ]);
      expect(VERIFIER_COMMAND_ENTRY).toBe(
        join(
          packageRoot,
          "src/strategies/smoke-differential/controlled-test-command.ts",
        ),
      );
      expect(task.prompt).not.toContain(
        "differential-smoke/verifier-command.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps caller-owned prepared layouts unchanged and preserves cancellation identity", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-caller-"));
    try {
      const ws = prepareSmokeWorkspaceFixture(root, job);
      const before = snapshot(ws.layout.executionRoot);
      const task = prepareAgentTask(ws.job, ws);
      expect(task.layout).toBe(ws.layout);
      expect(snapshot(ws.layout.executionRoot)).toEqual(before);
      const error = new DOMException("cancel", "AbortError");
      expect(() =>
        prepareAgentTask(ws.job, ws, AbortSignal.abort(error)),
      ).toThrow(error);
      expect(snapshot(ws.layout.executionRoot)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([5000, 1500])(
    "never restarts deadline %s when building a later task",
    (deadlineAt) => {
      const root = mkdtempSync(join(tmpdir(), "tv-task-deadline-"));
      try {
        vi.spyOn(Date, "now").mockReturnValue(1000);
        const ws = prepareSmokeWorkspaceFixture(root, job);
        vi.mocked(Date.now).mockReturnValue(1200);
        const task = prepareAgentTask(ws.job, {
          layout: ws.layout,
          deadlineAt,
        });
        expect(task.llm.deadlineAt).toBe(deadlineAt);
        expect(task.llm.env.VERIFIER_DEADLINE_AT).toBe(String(deadlineAt));
        expect(task.llm.timeoutMs).toBe(deadlineAt - 1200);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("target-only fixture neither reads nor stages source and cleanup belongs to its caller", () => {
    const root = mkdtempSync(join(tmpdir(), "tv-task-target-only-"));
    try {
      const input = {
        ...job,
        verificationPolicy: {
          ...acceptedPolicy,
          referenceDecision: "rejected" as const,
        },
      };
      Object.defineProperty(input, "source", {
        get() {
          throw new Error("source read");
        },
      });
      const ws = prepareSmokeWorkspaceFixture(root, input);
      expect(existsSync(join(ws.layout.executionRoot, "source"))).toBe(false);
      const task = prepareAgentTask(ws.job, ws);
      expect(task.llm.readOnlyDirs).toEqual([ws.job.target.root]);
      expect(task.llm.addDirs).not.toContain(
        join(ws.layout.executionRoot, "source/.forexplore-tests"),
      );
      ws.cleanup();
      ws.cleanup();
      expect(existsSync(ws.layout.executionRoot)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
