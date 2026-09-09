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
  parseTargetPlan,
} from "./behavior-schema.js";
import {
  projectHash,
  readTestFile,
  captureProjectBaseline,
  assertProjectBaseline,
} from "./behavior-workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const manifest = () => ({
  schemaVersion: "3.0",
  notes: "Uses real project tests.",
  testFiles: ["tests/runner.py"],
  cases: [
    {
      caseId: "one",
      intent: "empty input",
      input: {},
      expectation: {
        kind: "source",
        rationale: "Retain behavior",
        provenance: ["analysisReport.applicability"],
      },
    },
  ],
  commands: {
    setup: [],
    run: { executable: "python3", args: [".forexplore-tests/runner.py"] },
  },
});
describe("behavior JSON boundaries", () => {
  it("parses explicit target design v1 without accepting source handoffs or source expectations", () => {
    const plan = {
      schemaVersion: "1.0",
      testBasis: {
        summary: "Required identity",
        evidence: ["request.requirement"],
      },
      cases: [
        {
          caseId: "one",
          intent: "identity",
          input: 1,
          expectation: {
            kind: "requirement",
            rationale: "Requirement identity",
            provenance: ["request.requirement"],
            expected: { caseId: "one", outcome: "return", value: 1 },
          },
        },
      ],
    };
    expect(parseTargetPlan(JSON.stringify(plan))).toEqual(plan);
    expect(() => parseTargetPlan(JSON.stringify(manifest()))).toThrow();
    expect(() =>
      parseTargetPlan(JSON.stringify({ ...plan, cases: manifest().cases })),
    ).toThrow();
    expect(() =>
      parseTargetPlan(JSON.stringify({ ...plan, schemaVersion: "3.0" })),
    ).toThrow();
    expect(() =>
      parseTargetPlan(
        JSON.stringify({ ...plan, cases: [...plan.cases, ...plan.cases] }),
      ),
    ).toThrow("Duplicate");
  });
  it("reserves the independently frozen target plan from result-file writes", () => {
    expect(() =>
      parseTargetManifest(
        JSON.stringify({
          schemaVersion: "2.0",
          notes: "test",
          testFiles: ["tests/runner.py"],
          resultFile: ".forexplore-tests/target-plan.json",
          commands: manifest().commands,
        }),
      ),
    ).toThrow();
  });
  it("accepts language-open commands and explicit inputs, but rejects duplicate cases", () => {
    expect(
      parseCollectionManifest(JSON.stringify(manifest())).cases,
    ).toHaveLength(1);
    const prefixed = {
      ...manifest(),
      testFiles: [".forexplore-tests/runner.py"],
    };
    expect(parseCollectionManifest(JSON.stringify(prefixed)).testFiles).toEqual(
      [".forexplore-tests/runner.py"],
    );
    for (const path of [
      "../outside.py",
      "/tmp/outside.py",
      "tests/../src/main.py",
    ]) {
      expect(() =>
        parseCollectionManifest(
          JSON.stringify({ ...manifest(), testFiles: [path] }),
        ),
      ).toThrow("project-relative");
    }
    for (const resultFile of [
      ".forexplore-tests/inputs.json",
      ".forexplore-tests/manifest.json",
      ".forexplore-tests/../out.json",
    ]) {
      expect(() =>
        parseCollectionManifest(JSON.stringify({ ...manifest(), resultFile })),
      ).toThrow();
    }
    expect(
      parseCollectionManifest(
        JSON.stringify({
          ...manifest(),
          resultFile: ".forexplore-tests/observations.json",
        }),
      ).resultFile,
    ).toBe(".forexplore-tests/observations.json");
    const value = manifest();
    value.cases.push(value.cases[0]);
    expect(() => parseCollectionManifest(JSON.stringify(value))).toThrow(
      "Duplicate caseId",
    );
  });
  it("rejects target manifests that attempt to redefine frozen cases", () => {
    expect(() =>
      parseTargetManifest(
        JSON.stringify({ ...manifest(), schemaVersion: "2.0" }),
      ),
    ).toThrow();
  });
  it("rejects v2 collections instead of silently assigning provenance", () => {
    expect(() =>
      parseCollectionManifest(
        JSON.stringify({ ...manifest(), schemaVersion: "2.0" }),
      ),
    ).toThrow();
  });
  it("accepts design-only requirement exceptions but rejects unbound expected case IDs", () => {
    const collection = {
      schemaVersion: "3.0",
      notes: "Target contract",
      testFiles: [],
      cases: [
        {
          caseId: "bad",
          intent: "Reject invalid input",
          input: null,
          expectation: {
            kind: "requirement",
            rationale: "Required error",
            provenance: ["request.requirement"],
            expected: {
              caseId: "bad",
              outcome: "exception",
              error: { category: "invalid-input", message: "invalid" },
            },
          },
        },
      ],
    };
    expect(
      parseCollectionManifest(JSON.stringify(collection)).testFiles,
    ).toEqual([]);
    collection.cases[0].expectation.expected.caseId = "forged";
    expect(() => parseCollectionManifest(JSON.stringify(collection))).toThrow(
      "exactly once",
    );
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
  it("allows new project tests and regenerable builds but protects existing tests and dependencies", () => {
    const root = directory();
    mkdirSync(join(root, "src/test/java"), { recursive: true });
    writeFileSync(join(root, "src/test/java/Original.java"), "original test");
    writeFileSync(join(root, "pom.xml"), "original dependencies");
    writeFileSync(join(root, "App.csproj"), "original dotnet project");
    const baseline = captureProjectBaseline(root);
    writeFileSync(join(root, "src/test/java/NewTest.java"), "new test");
    for (const name of ["target", "bin", "obj"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "generated"), "build output");
    }
    expect(() => assertProjectBaseline(baseline)).not.toThrow();
    writeFileSync(join(root, "src/test/java/Original.java"), "modified test");
    expect(() => assertProjectBaseline(baseline)).toThrow("baseline changed");
    writeFileSync(join(root, "src/test/java/Original.java"), "original test");
    writeFileSync(join(root, "pom.xml"), "modified dependencies");
    expect(() => assertProjectBaseline(baseline)).toThrow("baseline changed");
    writeFileSync(join(root, "pom.xml"), "original dependencies");
    writeFileSync(join(root, "shadow.py"), "production replacement");
    expect(() => assertProjectBaseline(baseline)).toThrow(
      "outside project test",
    );
  });
  it("recognizes nested Maven/.NET project outputs without ignoring original module tests", () => {
    const root = directory();
    mkdirSync(join(root, "module/src/test/java"), { recursive: true });
    mkdirSync(join(root, "module/target/classes"), { recursive: true });
    writeFileSync(join(root, "module/pom.xml"), "module dependencies");
    writeFileSync(
      join(root, "module/src/test/java/Original.java"),
      "original test",
    );
    writeFileSync(
      join(root, "module/target/classes/Old.class"),
      "old bytecode",
    );
    mkdirSync(join(root, "net"));
    writeFileSync(join(root, "net/Library.csproj"), "project");
    const baseline = captureProjectBaseline(root);
    writeFileSync(
      join(root, "module/target/classes/Old.class"),
      "fresh bytecode",
    );
    writeFileSync(join(root, "module/src/test/java/NewTest.java"), "new test");
    for (const name of ["bin", "obj"]) {
      mkdirSync(join(root, "net", name));
      writeFileSync(join(root, "net", name, "generated"), "output");
    }
    expect(() => assertProjectBaseline(baseline)).not.toThrow();
    writeFileSync(
      join(root, "module/src/test/java/Original.java"),
      "changed test",
    );
    expect(() => assertProjectBaseline(baseline)).toThrow("baseline changed");
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
