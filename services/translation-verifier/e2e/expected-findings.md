# FileUpload Expected Findings

[`fileupload-datasets.json`](fileupload-datasets.json) contains host-only evaluation answers for all 14 scenarios. Its `expectedFindings` arrays contain 16 entries: defect findings, accepted differences, and verification blockers. The correct control has an empty array plus `expectedNonFindings` and `completionCriteria`; an empty report without relevant successful execution is not a true negative.

## Fields

| Field | Meaning |
| --- | --- |
| `id` | Stable finding identifier, prefixed by scenario ID. |
| `kind` | `requirement-violation`, `api-contract-violation`, `accepted-difference`, or `verification-blocker`. Only the first two denote defects. |
| `attribution` | Source, target, both, neither, environment, or target execution. |
| `requiredWhen` | `always`, or the specific alternative mutation that must be selected before scoring. |
| `validationStatus` | `oracle-confirmed` for an independently validated fixed witness; `design-only` for a proposed mutation/witness not yet validated. Neither indicates Agent success. |
| `symbol` | Method or execution stage responsible for the finding. |
| `requirement` | The obligation supporting the expected finding. Design-only obligations must be included in the eventual Agent request. |
| `finding` | The meaning an ideal report should communicate; exact wording is not required. |
| `witness` | Input and expected observations. Materialized count/output mutations include exact faulty observations; unmaterialized variants may use a failure predicate instead of inventing observed values. |
| `evidenceRequired` | Scenario-specific evidence, in addition to the top-level `expectedFindingsContract.evidenceRequired`. |
| `mustNotClaim` | Unsupported or incorrect conclusions that must not be credited. |

The three disk scenarios each contain two **alternative** mutations. Only findings for the selected mutation apply; do not require both or sum inactive alternatives into a recall denominator. Proposed disk persistence and malformed-input behavior must first pass a corrected-control check. These annotations do not assert unverified guarantees about the upstream library.

## Evaluation Boundary

Match the meaning of the finding, requirement, attribution and concrete execution evidence, not exact text, case IDs or report formatting. Equivalent counterexamples are acceptable. A static diagnosis is a hypothesis; execution-confirmed credit requires a real test and corrected-control replay. Source-only defects must not trigger target blame; common-mode equality must not conceal violations of the user requirement.

A target-process timeout and an Agent API timeout are different. If the session is killed before it writes a report, retain Host timeout/cleanup evidence and score infrastructure handling separately instead of claiming the Agent delivered a finding.

Do not stage this dataset or hidden oracle in the Agent workspace. The existing request builder does not load these annotations. `SmokeReport` and the service input/output schemas are unchanged; findings can currently be expressed through cases, reasoning, sourceIssues and summary. Automatic semantic matching, dataset-driven case execution and replay grading are **not implemented** by this annotation change.

## Check

Run the dataset consistency tests without a model, Java or Maven:

```bash
node --test services/translation-verifier/e2e/fileupload-datasets.test.mjs
```

These tests check annotation completeness, witness arithmetic, attribution, non-defect cases and conditional alternatives. They do not execute the unmaterialized scenarios or measure Agent detection quality.
