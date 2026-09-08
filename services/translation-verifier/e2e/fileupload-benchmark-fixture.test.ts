import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import { assertVerificationInput } from "../src/schemas/validate-verification-input.js";
import { createVerificationWorkspace } from "../src/workflow/prepare-strategy-workspace.js";
import {
  expectedVerificationFields,
  fileUploadInput,
  fileUploadTasks,
  sourceProjectRoot,
  targetProjectRoot,
  translatedJava,
  variants,
  datasetVariants,
  pythonPath,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";
import { translatedDiskJava } from "./fileupload-disk-translation.js";

const taskIds = Object.keys(fileUploadTasks) as FileUploadTaskId[];

describe("real FileUpload translation dataset", () => {
  it("covers exactly the remaining TODO methods and preserves original project roots", () => {
    const input = fileUploadInput("correct");
    const todos = input.request.targetContext.sourceFiles.flatMap(
      ({ path, content }) =>
        [
          ...(content ?? "").matchAll(
            /public\s+[\w<>[\]]+\s+(\w+)\([^)]*\)[^{]*\{\s*\/\/ TODO\(translation\):/g,
          ),
        ].map((match) => `${path}:${match[1]}`),
    );
    expect(todos.sort()).toEqual(
      Object.values(fileUploadTasks)
        .map((task) => `${task.path}:${task.method}`)
        .sort(),
    );
    expect(todos).toHaveLength(6);
    expect(existsSync(join(sourceProjectRoot, "pyproject.toml"))).toBe(true);
    expect(existsSync(join(targetProjectRoot, "pom.xml"))).toBe(true);
    const annotations = JSON.parse(
      readFileSync(
        new URL("./fileupload-datasets.json", import.meta.url),
        "utf8",
      ),
    );
    expect(sourceProjectRoot.endsWith(annotations.sourceProject)).toBe(true);
    expect(targetProjectRoot.endsWith(annotations.targetProject)).toBe(true);
  });

  it.each(taskIds)(
    "materializes %s without changing original files or exposing hidden labels",
    (taskId) => {
      const input = fileUploadInput("correct", taskId);
      const task = fileUploadTasks[taskId];
      const original = readFileSync(join(targetProjectRoot, task.path), "utf8");
      const source = input.request.sourceBundle.files.find(
        (file) => file.path === input.request.candidate.entity.path,
      )!;
      expect(source.content).toContain(`def ${task.sourceMethod}(`);
      expect(
        input.request.targetContext.sourceFiles.find(
          (file) => file.path === task.path,
        )!.content,
      ).toBe(original);
      expect(() => assertVerificationInput(input)).not.toThrow();
      const root = mkdtempSync(join(tmpdir(), "fileupload-dataset-"));
      const ws = createVerificationWorkspace(input, {
        workspaceRoot: root,
        artifactRoot: join(root, "artifacts"),
      });
      try {
        expect(
          readFileSync(
            join(ws.context.workspace.targetRoot, task.path),
            "utf8",
          ),
        ).toBe(input.translation.generatedContent);
        expect(input.translation.generatedContent).not.toContain(
          "TODO(translation)",
        );
        expect(readFileSync(join(targetProjectRoot, task.path), "utf8")).toBe(
          original,
        );
        for (const file of [
          ...input.request.sourceBundle.files,
          ...input.request.targetContext.sourceFiles,
        ]) {
          expect(file.path).not.toMatch(
            /fileupload-datasets|expected-findings|oracles\/|e2e\//,
          );
          expect(file.path).not.toMatch(/(^|\/)(target|bin|obj|__pycache__)\//);
        }
      } finally {
        ws.cleanup();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("materializes source-only and both-side defects without changing the source project", () => {
    const original = readFileSync(
      join(sourceProjectRoot, "src/commons_fileupload/core.py"),
      "utf8",
    );
    for (const variant of [
      "source-count-plus-one",
      "both-count-plus-one",
    ] as const) {
      const input = fileUploadInput(variant);
      const source = input.request.sourceBundle.files.find(
        (file) => file.path === pythonPath,
      )!;
      expect(source.content).toContain("return len(body) + 1");
      expect(
        readFileSync(
          join(sourceProjectRoot, "src/commons_fileupload/core.py"),
          "utf8",
        ),
      ).toBe(original);
      expect(input.verificationPolicy?.referenceDecision).toBe("accepted");
      expect(input.verificationPolicy?.testBasis).toContain(
        "Independent task requirement",
      );
      expect(expectedVerificationFields(variant).sourceAssessment).toBe(
        "bug_found",
      );
    }
  });

  it("materializes target-only and missing-policy requests as explicit host cases", () => {
    const targetOnly = fileUploadInput("target-only-correct");
    expect(targetOnly.verificationPolicy).toMatchObject({
      referenceDecision: "rejected",
    });
    expect(targetOnly.verificationPolicy?.testBasis).toBeTruthy();
    expect(expectedVerificationFields("target-only-correct")).toMatchObject({
      mode: "target_only",
      sourceAssessment: "not_checked",
    });
    const missingBasis = fileUploadInput("missing-test-basis");
    expect(missingBasis.verificationPolicy?.testBasis).toBeUndefined();
    expect(
      expectedVerificationFields("missing-test-basis").problemCodes,
    ).toEqual(["insufficient_test_basis"]);
    const missingPolicy = fileUploadInput("missing-policy");
    expect(missingPolicy.verificationPolicy).toBeUndefined();
    expect(missingPolicy).not.toHaveProperty("verificationPolicy");
    expect(() => assertVerificationInput(missingPolicy)).not.toThrow();
    expect(expectedVerificationFields("missing-policy").referenceDecision).toBe(
      "undetermined",
    );
  });

  it("keeps the finite request catalog explicit", () => {
    expect(datasetVariants).toEqual([
      ...variants,
      "source-count-plus-one",
      "both-count-plus-one",
      "target-only-correct",
      "target-only-count-plus-one",
      "missing-test-basis",
      "missing-policy",
    ]);
  });

  it.each(["missing", "duplicate"] as const)(
    "rejects a %s source mutation anchor",
    (mode) => {
      const read = vi.mocked(fs.readFileSync).getMockImplementation()!;
      const sourcePath = join(sourceProjectRoot, pythonPath);
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
        const content = read(...args);
        if (String(args[0]) !== sourcePath || typeof content !== "string")
          return content;
        const anchor = "        return len(body)\n";
        return content.replace(
          anchor,
          mode === "missing" ? "        return 0\n" : anchor.repeat(2),
        );
      });
      try {
        expect(() => fileUploadInput("source-count-plus-one")).toThrow(
          "anchor must occur exactly once",
        );
      } finally {
        spy.mockImplementation(read);
      }
    },
  );

  it("keeps the existing mutant inputs valid and fails closed on unsupported selections", () => {
    for (const variant of datasetVariants)
      expect(() =>
        assertVerificationInput(fileUploadInput(variant)),
      ).not.toThrow();
    expect(() =>
      fileUploadInput("target-only-count-plus-one", "disk-get"),
    ).toThrow("only for multipart-read-body");
    expect(
      fileUploadInput("target-only-count-plus-one").translation
        .generatedContent,
    ).toBe(fileUploadInput("count-plus-one").translation.generatedContent);
    expect(() => fileUploadInput("drop-output", "disk-get")).toThrow(
      "only for multipart-read-body",
    );
    expect(() => translatedDiskJava("changed skeleton")).toThrow(
      "TODO changed",
    );
    expect(() => translatedJava("changed skeleton", "correct")).toThrow(
      "TODO changed",
    );
  });
});

const maven = process.env.MAVEN_COMMAND?.trim() || "mvn";
const hasMaven =
  spawnSync(maven, ["-v"], { timeout: 5000, stdio: "ignore" }).status === 0;
it.runIf(hasMaven)(
  "validates the DiskFileItem control against upstream tests and independent storage observations",
  () => {
    const root = mkdtempSync(join(tmpdir(), "fileupload-control-"));
    const ws = createVerificationWorkspace(
      fileUploadInput("correct", "disk-write"),
      {
        workspaceRoot: root,
        artifactRoot: join(root, "artifacts"),
      },
    );
    try {
      writeFileSync(
        join(
          ws.context.workspace.targetRoot,
          "src/test/java/org/apache/commons/fileupload/DiskTranslationControlTest.java",
        ),
        `
package org.apache.commons.fileupload;
import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import org.apache.commons.fileupload.disk.DiskFileItem;
import org.apache.commons.io.IOUtils;
import org.junit.Test;
import static org.junit.Assert.*;
public class DiskTranslationControlTest {
  @Test public void storageContract() throws Exception {
    Path repository = Files.createTempDirectory("disk-control-");
    try {
      for (int size : new int[] {0, 7, 8, 9, 8193}) {
        byte[] body = new byte[size];
        Arrays.fill(body, (byte) 0x80);
        DiskFileItem item = new DiskFileItem("f", "application/octet-stream", false, "upload.bin", 8, repository.toFile());
        try {
          OutputStream output = item.getOutputStream();
          assertSame(output, item.getOutputStream());
          output.write(body);
          output.close();
          assertEquals(size <= 8, item.isInMemory());
          assertArrayEquals(body, item.get());
          try (InputStream first = item.getInputStream(); InputStream second = item.getInputStream()) {
            if (size > 0) first.read();
            assertArrayEquals(body, IOUtils.toByteArray(second));
          }
          File destination = repository.resolve("result-" + size).toFile();
          item.write(destination);
          assertArrayEquals(body, Files.readAllBytes(destination.toPath()));
          assertEquals(size, item.getSize());
          Files.delete(destination.toPath());
        } finally { item.delete(); }
      }
    } finally { Files.delete(repository); }
  }
}
`,
        "utf8",
      );
      const output = execFileSync(
        maven,
        ["-q", "-Dtest=DefaultFileItemTest,DiskTranslationControlTest", "test"],
        {
          cwd: ws.context.workspace.targetRoot,
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      expect(output).not.toContain("BUILD FAILURE");
    } finally {
      ws.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  },
  190_000,
);
