import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import type { VerificationInput } from "../src/schemas/verification-types.js";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
export const javaPath =
  "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
export const pythonPath = "src/commons_fileupload/core.py";
export const variants = ["correct", "count-plus-one", "drop-output"] as const;
export type Variant = (typeof variants)[number];
export const sha256 = (content: string) =>
  createHash("sha256").update(content).digest("hex");

// Method bodies derived from Apache Commons FileUpload 1.5 (Apache-2.0).
// https://github.com/apache/commons-fileupload/blob/commons-fileupload-1.5/src/main/java/org/apache/commons/fileupload/MultipartStream.java
const bodyTodo = `        // TODO(translation): stream bytes up to, but excluding, the next
        // boundary without consuming the boundary needed by readBoundary().
        throw new UnsupportedOperationException("TODO: read multipart body data");`;
const preambleTodo = `        // TODO(translation): accept the first boundary without a preceding
        // CRLF, then restore the normal delimiter for subsequent parts.
        throw new UnsupportedOperationException("TODO: skip multipart preamble");`;
const preamble = `        System.arraycopy(boundary, 2, boundary, 0, boundary.length - 2);
        boundaryLength = boundary.length - 2;
        computeBoundaryTable();
        try {
            discardBodyData();
            return readBoundary();
        } catch (MalformedStreamException e) {
            return false;
        } finally {
            System.arraycopy(boundary, 0, boundary, 2, boundary.length - 2);
            boundaryLength = boundary.length;
            boundary[0] = CR;
            boundary[1] = LF;
            computeBoundaryTable();
        }`;

export function translatedJava(original: string, variant: Variant): string {
  for (const anchor of [bodyTodo, preambleTodo]) {
    if (original.split(anchor).length !== 2)
      throw new Error("Fixture TODO changed; review benchmark patch.");
  }
  const output = variant === "drop-output" ? "null" : "output";
  const increment = variant === "count-plus-one" ? " + 1" : "";
  return original
    .replace(
      bodyTodo,
      `        return (int) Streams.copy(newInputStream(), ${output}, false)${increment};`,
    )
    .replace(preambleTodo, preamble);
}

function projectFiles(root: string) {
  const excluded = new Set([
    ".git",
    "__pycache__",
    "node_modules",
    "target",
    "bin",
    "obj",
    "dist",
    "build",
    ".pytest_cache",
  ]);
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((path) => !path.split("/").some((part) => excluded.has(part)))
    .filter(
      (path) =>
        /\.(java|py|xml|md|toml|txt)$/.test(path) ||
        ["LICENSE", "NOTICE"].includes(path),
    )
    .sort();
  return paths.map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    return { path, content, contentHash: sha256(content) };
  });
}

export function fileUploadInput(variant: Variant): VerificationInput {
  const sourceFiles = projectFiles(
    join(repositoryRoot, "fixtures/code-corpus/commons-fileupload-python"),
  );
  const targetFiles = projectFiles(
    join(
      repositoryRoot,
      "fixtures/target-system/commons-fileupload-java-skeleton",
    ),
  );
  const original = targetFiles.find((file) => file.path === javaPath)!.content;
  const generatedContent = translatedJava(original, variant);
  const oldLines = original.trimEnd().split("\n");
  const newLines = generatedContent.trimEnd().split("\n");
  const files: FilePatch[] = [
    {
      path: javaPath,
      status: "modified",
      expectedOriginalSha256: sha256(original),
      additions: newLines.length,
      deletions: oldLines.length,
      hunks: [
        {
          header: `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
          lines: [
            ...oldLines.map((content) => ({
              type: "remove" as const,
              content,
            })),
            ...newLines.map((content) => ({ type: "add" as const, content })),
          ],
        },
      ],
    },
  ];
  // SAFETY: verifier validates the artifact subset at runtime; unrelated workflow approvals are not used by this standalone benchmark.
  const request = {
    route: { sourceLanguageId: "python", targetLanguageId: "java" },
    candidate: {
      entity: {
        languageId: "python",
        name: "read_body_data",
        path: pythonPath,
      },
    },
    target: {
      entity: { languageId: "java", name: "readBodyData", path: javaPath },
    },
    sourceBundle: { files: sourceFiles, dependencyIds: [] },
    targetContext: {
      sourceFiles: targetFiles,
      dependencies: [],
      containers: [],
      declarations: [
        {
          path: javaPath,
          attributes: {
            containerName: "org.apache.commons.fileupload.MultipartStream",
            isStatic: false,
          },
        },
      ],
    },
    requirement:
      "Verify MultipartStream.readBodyData(OutputStream) against Python MultipartStream.read_body_data. " +
      "For well-formed CRLF multipart input, emit exactly the body bytes, exclude delimiter bytes, return the exact body byte count, " +
      "and preserve iteration across successive parts. Null output discards bytes but returns the same count. Do not close the caller's output stream. " +
      "Only readBodyData and its skipPreamble prerequisite have been filled in; unrelated DiskFileItem TODOs are outside this task. " +
      "Use the existing project classes and dependencies, never a reimplemented shadow class. Python imports are rooted at src; " +
      "Java uses the existing Maven pom.xml. Python materializes input; Java streams it, so allocation and exception timing are not required to match. " +
      "For malformed input, both sides must reject it, but exception class names/messages may differ.",
  } as unknown as AdaptationRequestV2;
  return {
    schemaVersion: "1.0",
    request,
    analysisReport: { scope: "readBodyData and prerequisite skipPreamble" },
    migrationPlan: { scope: "single method with prerequisite" },
    translation: {
      round: 1,
      generatedContent,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}
