import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCollectionManifest,
  parseObservations,
  parseTargetManifest,
} from "./behavior-schema.js";
import { projectHash, readTestFile } from "./behavior-workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const manifest = () => ({
  schemaVersion: "1.0",
  notes: "Uses real project tests.",
  testFiles: ["runner.py"],
  cases: [{ caseId: "one", intent: "empty input", input: {} }],
  commands: {
    setup: [],
    run: { executable: "python3", args: [".forexplore-tests/runner.py"] },
  },
});
describe("behavior JSON boundaries", () => {
  it("accepts language-open commands and explicit inputs, but rejects duplicate cases", () => {
    expect(
      parseCollectionManifest(JSON.stringify(manifest())).cases,
    ).toHaveLength(1);
    const prefixed = {
      ...manifest(),
      testFiles: [".forexplore-tests/runner.py"],
    };
    expect(parseCollectionManifest(JSON.stringify(prefixed)).testFiles).toEqual(
      ["runner.py"],
    );
    prefixed.testFiles.push("runner.py");
    expect(() => parseCollectionManifest(JSON.stringify(prefixed))).toThrow(
      "Duplicate canonical test file",
    );
    const value = manifest();
    value.cases.push(value.cases[0]);
    expect(() => parseCollectionManifest(JSON.stringify(value))).toThrow(
      "Duplicate caseId",
    );
  });
  it("rejects target manifests that attempt to redefine frozen cases", () => {
    expect(() => parseTargetManifest(JSON.stringify(manifest()))).toThrow();
  });
  it("requires each actual observation exactly once and validates outcome payloads", () => {
    const good = [{ caseId: "one", outcome: "return", value: null }];
    expect(parseObservations(JSON.stringify(good), ["one"])).toEqual(good);
    for (const value of [
      [],
      [...good, ...good],
      [{ ...good[0], caseId: "other" }],
      [{ caseId: "one", outcome: "return" }],
      [{ ...good[0], error: { category: "error", message: "bad" } }],
    ])
      expect(() => parseObservations(JSON.stringify(value), ["one"])).toThrow();
  });
  it("does not coerce types or discard nulls, and preserves legitimate exceptions", () => {
    const values = [
      {
        caseId: "one",
        outcome: "exception",
        error: { category: "invalid-input", message: "bad" },
      },
    ];
    expect(parseObservations(JSON.stringify(values), ["one"])).toEqual(values);
    expect(() =>
      parseObservations('[{"caseId":"one","outcome":"return","value":1e999}]', [
        "one",
      ]),
    ).toThrow("Non-finite");
    for (const value of [
      "9007199254740992",
      "9007199254740993",
      "-9007199254740993",
    ]) {
      expect(() =>
        parseObservations(
          `[{"caseId":"one","outcome":"return","value":${value}}]`,
          ["one"],
        ),
      ).toThrow("Unsafe JSON integer");
    }
    expect(
      parseObservations(
        '[{"caseId":"one","outcome":"return","value":"9007199254740993"}]',
        ["one"],
      )[0].value,
    ).toBe("9007199254740993");
  });
});
describe("caller-owned copies", () => {
  function directory() {
    const dir = mkdtempSync(join(tmpdir(), "behavior-boundary-"));
    dirs.push(dir);
    return dir;
  }
  it("hashes implementation changes but excludes the dedicated test directory", () => {
    const root = directory();
    writeFileSync(join(root, "project.py"), "original");
    const first = projectHash(root);
    mkdirSync(join(root, ".forexplore-tests"));
    writeFileSync(join(root, ".forexplore-tests", "runner"), "generated");
    expect(projectHash(root)).toBe(first);
    writeFileSync(join(root, "project.py"), "changed");
    expect(projectHash(root)).not.toBe(first);
  });
  it("rejects symlinks and hard links instead of touching the original source", () => {
    const root = directory();
    const outside = directory();
    writeFileSync(join(outside, "original"), "data");
    symlinkSync(join(outside, "original"), join(root, "link"));
    expect(() => projectHash(root)).toThrow("Unsupported project entry");
    rmSync(join(root, "link"));
    linkSync(join(outside, "original"), join(root, "link"));
    expect(() => projectHash(root)).toThrow("Hard-linked");
  });
  it("rejects escaping manifest paths and oversized files", () => {
    const root = directory();
    writeFileSync(join(root, "file"), "data");
    expect(readTestFile(root, "file")).toBe("data");
    expect(() => readTestFile(root, "../file")).toThrow("Unsafe");
    symlinkSync(join(root, "file"), join(root, "alias"));
    expect(() => readTestFile(root, "alias")).toThrow("Invalid");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "runner"), "data");
    symlinkSync(join(root, "nested"), join(root, "linked-directory"));
    expect(() => readTestFile(root, "linked-directory/runner")).toThrow(
      "linked test path",
    );
    writeFileSync(join(root, "large"), Buffer.alloc(1024 * 1024 + 1));
    expect(() => readTestFile(root, "large")).toThrow("oversized");
  });
});
