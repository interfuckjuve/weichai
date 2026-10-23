import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyIndependentEvaluation, completeProjectObservation, decodeModuleFiles, javaApi, planJavaModules, restoreModuleSources } from "./full-project-workflow.js";
import type { FunctionGroupTestRun } from "../src/host/tools/common.js";
import { execute } from "./existing-assets-workflow.js";

const path = "src/main/java/com/example/assetupgrade/config/ConfigurationLoader.java";

describe("full existing Java project boundaries", () => {
  it("assigns every concrete source while retaining interface-only contracts", () => {
    const modules = planJavaModules([
      { path, content: "public final class ConfigurationLoader {}" },
      { path: "src/main/java/com/example/assetupgrade/observability/HealthStatus.java", content: "public enum HealthStatus { READY }" },
      { path: "src/main/java/com/example/assetupgrade/common/TenantId.java", content: "public record TenantId(String value) {}" },
      { path: "src/main/java/com/example/assetupgrade/common/TimeProvider.java", content: "public interface TimeProvider {}" },
    ]);
    expect(modules.map(module => module.id)).toEqual(["common", "observability", "config"]);
    expect(modules.flatMap(module => module.files)).toHaveLength(3);
  });

  it("refuses to silently omit an unknown package", () => {
    expect(() => planJavaModules([{ path: "src/main/java/com/example/assetupgrade/unassigned/Service.java", content: "public class Service {}" }])).toThrow("Unassigned concrete Java files");
  });

  it("includes executable default interface seams without targeting abstract methods", () => {
    const interfacePath = "src/main/java/com/example/assetupgrade/common/TimeProvider.java";
    const sources = [{ path: interfacePath, content: "public interface TimeProvider { Object now(); default Object execute(Object input) { throw new UnsupportedOperationException(); } }" }];
    expect(planJavaModules(sources)[0].files).toEqual([interfacePath]);
    const api = javaApi('public interface com.example.assetupgrade.common.TimeProvider {\n public abstract java.lang.Object now();\n  descriptor: ()Ljava/lang/Object;\n public default java.lang.Object execute(java.lang.Object);\n  descriptor: (Ljava/lang/Object;)Ljava/lang/Object;\n}', sources);
    expect(api.signatures).toHaveLength(2);
    expect(api.targets.map(target => target.name)).toEqual(["execute"]);
  });

  it("resumes interrupted source rollback before marking a module terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "verifier-rollback-"));
    try {
      const target = join(workspace, "target");
      await mkdir(target);
      await writeFile(join(target, "First.java"), "changed first");
      await writeFile(join(target, "Second.java"), "changed second");
      const report = { workspace, target, expectedHashes: {} as Record<string, string> };
      const module = { id: "common", files: ["First.java", "Second.java"], status: "translating", attempts: [{ round: 3, startedAt: "now", status: "failed" }] };
      const baseline = [{ path: "First.java", content: "original first" }, { path: "Second.java", content: "original second" }];
      let checkpoints = 0;
      const compile = () => execute(target, process.execPath, ["-e", "process.exit(0)"]);
      await expect(restoreModuleSources(report, module, baseline, compile, async () => { if (++checkpoints === 2) throw new Error("interrupted"); })).rejects.toThrow("interrupted");
      expect(module.status).toBe("rolling-back");
      expect(await readFile(join(target, "First.java"), "utf8")).toBe("original first");
      expect(await readFile(join(target, "Second.java"), "utf8")).toBe("changed second");
      await restoreModuleSources(report, module, baseline, compile, async () => undefined);
      expect(module.status).toBe("translation-failed");
      expect(await readFile(join(target, "Second.java"), "utf8")).toBe("original second");
      expect(report.expectedHashes["Second.java"]).toHaveLength(64);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("distinguishes complete failed assertions from incomplete hidden execution", () => {
    const execution = { exitCode: 1, timedOut: false, stdout: "", stderr: "", durationMs: 1 };
    const tests = { executed: 35, passed: 34, failed: 1, skipped: 0 };
    expect(classifyIndependentEvaluation(execution, tests, 0, 35)).toBe("requirement-mismatch");
    expect(classifyIndependentEvaluation(execution, { ...tests, executed: 34 }, 0, 35)).toBe("hidden-execution-failure");
    expect(classifyIndependentEvaluation(execution, tests, 1, 35)).toBe("hidden-execution-failure");
    expect(classifyIndependentEvaluation({ ...execution, timedOut: true }, tests, 0, 35)).toBe("hidden-execution-failure");
  });

  it("rejects skipped or stale target identities in final project evidence", () => {
    const subject = { path, name: "execute", signature: "()V" };
    const observation: FunctionGroupTestRun = { status: "success", exitCode: 0, stdout: "", stderr: "", testPaths: ["tests/Test.java"], tests: { executed: 1, passed: 1, failed: 0, skipped: 0 }, failures: [],
      functions: [{ target: subject, status: "passed", executed: true, lineCoverage: 100, branchCoverage: null, reason: "verified" }] };
    expect(completeProjectObservation(observation, [subject])).toBe(true);
    expect(completeProjectObservation({ ...observation, tests: { ...observation.tests, skipped: 1 } }, [subject])).toBe(false);
    expect(completeProjectObservation(observation, [{ ...subject, signature: "(I)V" }])).toBe(false);
  });

  it("accepts only declared complete production sources", () => {
    const file = { path, content: "package com.example.assetupgrade.config;\r\npublic final class ConfigurationLoader {}\r\n" };
    expect(decodeModuleFiles(JSON.stringify({ files: [file] }), [path], "credential")[0].content).not.toContain("\r");
    expect(() => decodeModuleFiles(JSON.stringify({ files: [{ ...file, path: "pom.xml" }] }), [path], "credential")).toThrow("write boundary");
    expect(() => decodeModuleFiles(JSON.stringify({ files: [file, file] }), [path], "credential")).toThrow("write boundary");
    expect(() => decodeModuleFiles(JSON.stringify({ files: [{ ...file, content: file.content + 'String key = "credential";' }] }), [path], "credential")).toThrow("Invalid or unfinished");
  });

  it("rejects retained executable skeletons", () => {
    expect(() => decodeModuleFiles(JSON.stringify({ files: [{ path, content: 'package com.example.assetupgrade.config; public class ConfigurationLoader { public Object execute(Object input) { throw new UnsupportedOperationException("Implementation belongs to the evaluated Agent"); } }' }] }), [path], "")).toThrow("unfinished");
  });

  it("uses JVM descriptors to distinguish overloads and includes explicit constructors", () => {
    const api = javaApi('public final class com.example.assetupgrade.config.ConfigurationLoader {\n  public com.example.assetupgrade.config.ConfigurationLoader();\n    descriptor: ()V\n  public java.lang.Object execute(java.lang.Object);\n    descriptor: (Ljava/lang/Object;)Ljava/lang/Object;\n  public java.lang.String execute(java.lang.String);\n    descriptor: (Ljava/lang/String;)Ljava/lang/String;\n}', [{ path, content: "public final class ConfigurationLoader { public ConfigurationLoader() {} public Object execute(Object input) {return input;} public String execute(String input) {return input;} }" }]);
    expect(api.targets.map(target => [target.name, target.signature])).toEqual([
      ["<init>", "()V"], ["execute", "(Ljava/lang/Object;)Ljava/lang/Object;"], ["execute", "(Ljava/lang/String;)Ljava/lang/String;"],
    ]);
  });

  it("does not invent executable targets for generated record methods", () => {
    const recordPath = "src/main/java/com/example/assetupgrade/common/TenantId.java";
    const api = javaApi('public final class com.example.assetupgrade.common.TenantId extends java.lang.Record {\n public com.example.assetupgrade.common.TenantId(java.lang.String);\n  descriptor: (Ljava/lang/String;)V\n public java.lang.String value();\n  descriptor: ()Ljava/lang/String;\n public final boolean equals(java.lang.Object);\n  descriptor: (Ljava/lang/Object;)Z\n}', [{ path: recordPath, content: "public record TenantId(String value) {}" }]);
    expect(api.targets).toEqual([]);
    expect(api.signatures).toHaveLength(3);
  });

  it("ignores record method calls and examples when identifying executable declarations", () => {
    const recordPath = "src/main/java/com/example/assetupgrade/common/TenantId.java";
    const api = javaApi('public final class com.example.assetupgrade.common.TenantId extends java.lang.Record {\n public com.example.assetupgrade.common.TenantId(java.lang.String);\n  descriptor: (Ljava/lang/String;)V\n public boolean sameAs(com.example.assetupgrade.common.TenantId);\n  descriptor: (Lcom/example/assetupgrade/common/TenantId;)Z\n public final boolean equals(java.lang.Object);\n  descriptor: (Ljava/lang/Object;)Z\n public final int hashCode();\n  descriptor: ()I\n public final java.lang.String toString();\n  descriptor: ()Ljava/lang/String;\n}', [{ path: recordPath, content: `public record TenantId(String value) {
      public TenantId { java.util.Objects.requireNonNull(value); }
      public boolean sameAs(TenantId other) { return other != null && value.equals(other.value); }
      /* Example: public int hashCode() { return value.hashCode(); } */
      public static final String EXAMPLE = "public String toString() { return value; }";
    }` }]);
    expect(api.targets.map(target => target.name)).toEqual(["<init>", "sameAs"]);
    expect(api.signatures).toHaveLength(5);
  });

  it("verifies explicit record constructors and preserves compatible record overrides", () => {
    const recordPath = "src/main/java/com/example/assetupgrade/common/TenantId.java";
    const output = (modifier: string) => `public final class com.example.assetupgrade.common.TenantId extends java.lang.Record {\n public com.example.assetupgrade.common.TenantId(java.lang.String);\n  descriptor: (Ljava/lang/String;)V\n public ${modifier}java.lang.String toString();\n  descriptor: ()Ljava/lang/String;\n}`;
    const baseline = javaApi(output("final "), [{ path: recordPath, content: "public record TenantId(String value) {}" }]);
    const implemented = javaApi(output(""), [{ path: recordPath, content: 'public record TenantId(String value) { public TenantId { if(value.isBlank()) throw new IllegalArgumentException(); } public String toString() { return value; } }' }]);
    expect(implemented.signatures).toEqual(baseline.signatures);
    expect(implemented.targets.map(target => target.name)).toEqual(["<init>", "toString"]);
  });
});
