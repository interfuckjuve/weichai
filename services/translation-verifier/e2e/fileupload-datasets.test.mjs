import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dataset = JSON.parse(
  readFileSync(new URL("./fileupload-datasets.json", import.meta.url), "utf8"),
);
const scenarios = new Map(
  dataset.scenarios.map((scenario) => [scenario.id, scenario]),
);
const findings = dataset.scenarios.flatMap(
  (scenario) => scenario.expectedFindings,
);
const nonempty = (value) =>
  assert.ok(typeof value === "string" && value.trim().length > 0);

test("every existing scenario has complete host-only finding annotations", () => {
  assert.equal(dataset.scenarios.length, 14);
  assert.equal(scenarios.size, 14);
  assert.equal(dataset.expectedFindingsContract.visibility, "host-only");
  assert.equal(findings.length, 16);
  assert.equal(
    new Set(findings.map((finding) => finding.id)).size,
    findings.length,
  );
  for (const scenario of dataset.scenarios) {
    nonempty(scenario.oracle);
    nonempty(scenario.expected);
    assert.ok(Array.isArray(scenario.expectedFindings));
    for (const finding of scenario.expectedFindings) {
      for (const key of [
        "id",
        "kind",
        "attribution",
        "requiredWhen",
        "validationStatus",
        "symbol",
        "requirement",
        "finding",
      ])
        nonempty(finding[key]);
      assert.ok(finding.id.startsWith(`${scenario.id}.`));
      assert.ok(finding.witness.input && finding.witness.expected);
      for (const key of ["evidenceRequired", "mustNotClaim"]) {
        assert.ok(Array.isArray(finding[key]) && finding[key].length > 0);
        finding[key].forEach(nonempty);
      }
      assert.equal(
        finding.validationStatus,
        scenario.readiness === "materializer-implemented"
          ? "oracle-confirmed"
          : "design-only",
      );
    }
  }
});

test("correct, accepted-difference and infrastructure cases are not labeled target defects", () => {
  const correct = scenarios.get("multipart-correct");
  assert.deepEqual(correct.expectedFindings, []);
  assert.ok(correct.expectedNonFindings.length > 0);
  assert.match(correct.completionCriteria, /unverified/);
  assert.equal(
    scenarios.get("multipart-allowed-difference").expectedFindings[0].kind,
    "accepted-difference",
  );
  for (const id of ["multipart-missing-dependency", "multipart-timeout"]) {
    const finding = scenarios.get(id).expectedFindings[0];
    assert.equal(finding.kind, "verification-blocker");
    assert.equal(finding.witness.expected.verificationStatus, "unverified");
  }
});

test("count and output witnesses match the existing independent oracle's hello input", () => {
  const count = scenarios.get("multipart-count").expectedFindings[0].witness;
  const output = scenarios.get("multipart-output").expectedFindings[0].witness;
  for (const witness of [count, output]) {
    assert.equal(
      Buffer.from(witness.input.bodyHex, "hex").toString("ascii"),
      "hello",
    );
    assert.equal(
      witness.expected.returnCount,
      Buffer.from(witness.input.bodyHex, "hex").length,
    );
    assert.equal(witness.expected.outputHex, witness.input.bodyHex);
    assert.equal(witness.source.returnCount, witness.expected.returnCount);
  }
  assert.equal(count.target.returnCount, count.expected.returnCount + 1);
  assert.equal(count.target.outputHex, count.expected.outputHex);
  assert.equal(output.target.returnCount, output.expected.returnCount);
  assert.equal(output.target.outputHex, "");
});

test("source-only and common-mode findings use requirements instead of equality as the oracle", () => {
  const sourceOnly = scenarios.get("multipart-source-only").expectedFindings[0];
  assert.equal(sourceOnly.attribution, "source");
  assert.equal(
    sourceOnly.witness.target.returnCount,
    sourceOnly.witness.expected.returnCount,
  );
  const common = scenarios.get("multipart-common-mode").expectedFindings[0];
  assert.equal(common.attribution, "both");
  assert.equal(
    common.witness.source.returnCount,
    common.witness.target.returnCount,
  );
  assert.notEqual(
    common.witness.target.returnCount,
    common.witness.expected.returnCount,
  );
});

test("alternative mutations are conditional rather than simultaneously required", () => {
  const alternatives = [
    "disk-threshold",
    "disk-fresh-stream",
    "disk-persist-failure",
  ];
  for (const scenario of dataset.scenarios) {
    if (alternatives.includes(scenario.id)) {
      assert.equal(scenario.expectedFindings.length, 2);
      assert.equal(
        new Set(
          scenario.expectedFindings.map((finding) => finding.requiredWhen),
        ).size,
        2,
      );
      assert.ok(
        scenario.expectedFindings.every(
          (finding) => finding.requiredWhen !== "always",
        ),
      );
    } else {
      assert.ok(
        scenario.expectedFindings.every(
          (finding) => finding.requiredWhen === "always",
        ),
      );
    }
  }
});
