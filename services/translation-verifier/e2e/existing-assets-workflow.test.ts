import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ interruptCopy: false, xml: "", exitCode: 0 }));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: async (...args: Parameters<typeof actual.cp>) => {
    if (controls.interruptCopy && String(args[1]).includes("skeleton-seed-")) {
      controls.interruptCopy = false;
      await actual.writeFile(join(String(args[1]), "partial-copy"), "interrupted");
      throw new Error("simulated copy interruption");
    }
    return actual.cp(...args);
  } };
});

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (executable: string, args: string[], options: { cwd: string }) => {
    if (executable !== "workflow-test-maven" && executable !== "javap") return actual.spawn(executable, args, options);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(async () => {
      if (options.cwd.includes("independent-evaluation")) {
        const directory = join(options.cwd, "target/surefire-reports");
        await actualFs.mkdir(directory, { recursive: true });
        await actualFs.writeFile(join(directory, "TEST-AttachmentHiddenTest.xml"), controls.xml);
      }
      child.stdout.emit("data", executable === "javap" ? "public final class AttachmentIntakeHandler {}\n" : "Java version: 21.0.1\n");
      child.emit("close", options.cwd.includes("independent-evaluation") ? controls.exitCode : 0);
    });
    return child;
  } };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { runExistingAssetsWorkflow } = await import("./existing-assets-workflow.js");
const productionPath = "src/main/java/com/example/assetupgrade/attachment/AttachmentIntakeHandler.java";
const source = "package com.example.assetupgrade.attachment;\n// Implementation belongs to the evaluated Agent\n";
let root: string;
let workspace: string;
let reportPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "existing-assets-workflow-"));
  workspace = join(root, "experiment");
  reportPath = join(workspace, "report.json");
  const assets = join(root, "assets");
  const put = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  const original = join(assets, "asset-upgrade-test-materials-20261014/java/target-project");
  await put(join(original, productionPath), source);
  await put(join(original, "requirements/task-attachment-quarantine.md"), "Scan before approval.");
  await put(join(original, "requirements/task-full-engineering-coverage.md"), "Do not release during intake.");
  await put(join(original, "pom.xml"), "<project><build><plugins></plugins></build></project>");
  await put(join(assets, "asset-upgrade-test-materials-20261014/java/hidden-tests/src/test/java/AttachmentHiddenTest.java"), "class AttachmentHiddenTest {}");
  await put(join(assets, "enterprise-asset-upgrade/tasks/coverage-matrix.json"), JSON.stringify({ rows: [{ taskId: "attachment-quarantine" }] }));
  for (const path of [
    "commons-fileupload/commons-fileupload2-core/src/main/java/org/apache/commons/fileupload2/core/AbstractFileUpload.java",
    "commons-fileupload/commons-fileupload2-core/src/main/java/org/apache/commons/fileupload2/core/DiskFileItem.java",
    "keycloak/services/src/main/java/org/keycloak/services/resources/admin/fgap/RealmAuth.java",
    "flowable-engine/modules/flowable-engine/src/main/java/org/flowable/engine/impl/cmd/CompleteTaskCmd.java",
    "bullmq/src/commands/addStandardJob-9.lua",
  ]) await put(join(assets, "enterprise-asset-upgrade/reference-sources", path), "reference source");
  vi.stubEnv("TRANSLATION_VERIFIER_ASSETS_ROOT", assets);
  vi.stubEnv("TRANSLATION_VERIFIER_EXPERIMENT_DIR", workspace);
  vi.stubEnv("TRANSLATION_VERIFIER_MAVEN", "workflow-test-maven");
  vi.stubEnv("TRANSLATION_VERIFIER_LIVE_E2E", "1");
  vi.stubEnv("DEEPSEEK_API_KEY", "isolated-test-credential");
  vi.stubEnv("JAVA_HOME", "");
  controls.interruptCopy = false;
  controls.xml = "";
  controls.exitCode = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("existing assets experiment checkpoints", () => {
  it("resumes a partial initial copy into a real detached worktree and rejects tampering", async () => {
    controls.interruptCopy = true;
    await expect(runExistingAssetsWorkflow(true)).rejects.toThrow("simulated copy interruption");
    const interrupted = JSON.parse(await readFile(reportPath, "utf8"));
    expect(interrupted.preparation.state).toBe("copying");
    await expect(actualFs.stat(join(workspace, "target-project"))).rejects.toMatchObject({ code: "ENOENT" });
    const prepared = await runExistingAssetsWorkflow(true);
    expect(prepared.preparation.seed).not.toBe(interrupted.preparation.seed);
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: prepared.target, encoding: "utf8" }).trim()).toBe("true");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: prepared.target, encoding: "utf8" }).trim()).toBe("HEAD");
    const resumed = await runExistingAssetsWorkflow(true);
    expect(resumed.preparation).toEqual(prepared.preparation);
    await writeFile(join(prepared.target, productionPath), "tampered");
    await expect(runExistingAssetsWorkflow(true)).rejects.toThrow("outside the model write boundary");
  }, 30_000);

  it("preserves historical copy-based reports without rewriting them", async () => {
    await runExistingAssetsWorkflow(true);
    const historical = JSON.parse(await readFile(reportPath, "utf8"));
    delete historical.preparation;
    const content = JSON.stringify(historical);
    await writeFile(reportPath, content);
    await expect(runExistingAssetsWorkflow(true)).rejects.toThrow("historical copy-based experiment");
    expect(await readFile(reportPath, "utf8")).toBe(content);
  }, 30_000);

  it.each([
    ["missing test", 5, 0, 0, 0, 0, "hidden-execution-failure"],
    ["skipped test", 6, 0, 0, 1, 0, "hidden-execution-failure"],
    ["inconsistent failure count", 6, 7, 0, 0, 1, "hidden-execution-failure"],
    ["runner error", 6, 0, 1, 0, 1, "hidden-execution-failure"],
    ["abnormal process exit", 6, 1, 0, 0, 2, "hidden-execution-failure"],
    ["complete assertion disagreement", 6, 3, 0, 0, 1, "requirement-mismatch"],
    ["all passed", 6, 0, 0, 0, 0, "verified"],
  ])("classifies %s through the workflow and Surefire reports", async (_label, count, failures, errors, skipped, exitCode, reason) => {
    const report = await runExistingAssetsWorkflow(true);
    report.attempts.push({ round: 1, startedAt: new Date().toISOString(),
      implementationSha256: createHash("sha256").update(source).digest("hex"),
      compile: { exitCode: 0, timedOut: false, stdout: "", stderr: "" },
      verifier: { status: "success", functions: ["intake", "release", "execute"].map(name => ({ target: { name, path: productionPath }, status: "passed", executed: true, lineCoverage: 100, branchCoverage: 100 })) } });
    await writeFile(reportPath, JSON.stringify(report));
    controls.xml = `<testsuite name="AttachmentHiddenTest" tests="${count}" failures="${failures}" errors="${errors}" skipped="${skipped}"/>`;
    controls.exitCode = Number(exitCode);
    if (reason === "verified") await expect(runExistingAssetsWorkflow()).resolves.toMatchObject({ passed: true, reason });
    else await expect(runExistingAssetsWorkflow()).rejects.toThrow("not fully verified");
    const completed = JSON.parse(await readFile(reportPath, "utf8"));
    expect(completed.reason).toBe(reason);
    expect(completed.status).toBe(reason === "verified" ? "passed" : reason);
  }, 30_000);
});
