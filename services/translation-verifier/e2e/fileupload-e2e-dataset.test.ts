import { describe, expect, it } from "vitest";
import { fileUploadInput, javaPath } from "./fileupload-benchmark-fixture.js";
import {
  createE2EDatasetRecord,
  fileUploadVerificationInput,
} from "./fileupload-e2e-dataset.js";

describe("shared FileUpload verifier dataset", () => {
  it("keeps the TODO snapshot and fixed patch but removes Host-only answer labels", () => {
    const legacy = fileUploadInput("correct", "multipart-read-body");
    const input = fileUploadVerificationInput("correct", "multipart-read-body");
    expect(input.translation).toEqual(legacy.translation);
    expect(
      input.request.targetContext.sourceFiles.find(
        (file) => file.path === javaPath,
      )?.content,
    ).toContain(
      'UnsupportedOperationException("TODO: read multipart body data")',
    );
    expect(input).not.toHaveProperty("verificationPolicy");
    expect(input.migrationPlan).not.toHaveProperty("outputProvenance");
    expect(input.analysisReport).toMatchObject({
      applicability: { level: "direct" },
    });
    const { request, analysisReport, migrationPlan } = input;
    expect(
      JSON.stringify({ request, analysisReport, migrationPlan }),
    ).not.toMatch(
      /Apache Commons FileUpload 1\.5 control|Seeded .* mutation|has been filled in/,
    );
  });

  it("labels only the exact common input as the standardized control and binds all inputs", () => {
    const input = fileUploadVerificationInput("correct", "multipart-read-body");
    const record = createE2EDatasetRecord(
      input,
      "multipart-read-body",
      "correct",
    );
    expect(record).toMatchObject({
      schemaVersion: "1.0",
      datasetId: "fileupload-verifier-v1/multipart-read-body/correct",
      standardDatasetMatch: true,
      translationOrigin: "fixed-upstream-control",
      targetProject: "commons-fileupload-java-skeleton",
    });
    expect(record.pretranslationInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.patchHash).toBe(input.translation.patchHash);
    const changed = structuredClone(input);
    changed.request.requirement += " Additional constraint.";
    const modified = createE2EDatasetRecord(
      changed,
      "multipart-read-body",
      "correct",
    );
    expect(modified.datasetId).toBeNull();
    expect(modified.standardDatasetMatch).toBe(false);
    expect(modified.pretranslationInputHash).not.toBe(
      record.pretranslationInputHash,
    );
    expect(modified.translationOrigin).toBe("custom-or-legacy-unverified");
    expect(
      createE2EDatasetRecord(input, "multipart-read-body", "correct"),
    ).toEqual(record);
  });
});
