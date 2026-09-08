# FileUpload E2E

All E2E translation tasks use actual TODO methods in the repository's Apache Commons FileUpload Java skeleton. There is no package-local `e2e/fixtures` directory and no synthetic MimeUtility or arithmetic project.

## Dataset

Project roots, relative to the repository:

- Source: `fixtures/code-corpus/commons-fileupload-python`
- Target: `fixtures/target-system/commons-fileupload-java-skeleton`

`fileupload-benchmark-fixture.ts` exports the absolute project roots, six-task catalog, and `fileUploadInput(variant, task)`. The builder produces the same `VerificationInput` shape an upstream translation module would submit: source and target snapshots, selected symbols, analysis report, migration plan, translation patch/hash, and an explicit `verificationPolicy` when reference trust is known.

The executable request variants are finite and Host-labeled: `correct`, `count-plus-one`, `drop-output`, `source-count-plus-one`, `both-count-plus-one`, `target-only-correct`, `target-only-count-plus-one`, `missing-test-basis`, and `missing-policy`. Source mutations are applied only to the staged snapshot and recompute its content hash. The last two cases verify fail-closed policy handling. `fileupload-datasets.json` records the fixed expected report fields for these requests; `expected-findings.md` and the legacy `scenarios` array remain Host-only manual-review annotations.

Every expected result compares only `mode`, `referenceDecision`, `referenceReason`, `executionStatus`, `sourceAssessment`, `targetAssessment`, and sorted `problems[].code`. It does not score natural-language findings, timestamps, content hashes, case IDs, or Agent claims. A matched `fail`-like assessment only means the official report classified the target; the complete report remains for human review.

| Task ID | Python input method | Java output method |
| --- | --- | --- |
| `multipart-read-body` (default) | `MultipartStream.read_body_data` | `MultipartStream.readBodyData` |
| `multipart-skip-preamble` | `MultipartStream.skip_preamble` | `MultipartStream.skipPreamble` |
| `disk-get-input-stream` | `DiskFileItem.get_input_stream` | `DiskFileItem.getInputStream` |
| `disk-get` | `DiskFileItem.get` | `DiskFileItem.get` |
| `disk-write` | `DiskFileItem.write` | `DiskFileItem.write` |
| `disk-get-output-stream` | `DiskFileItem.get_output_stream` | `DiskFileItem.getOutputStream` |

Inputs contain the selected source symbol, source project text files, original target project text files, requirements and a hashed target patch. The builder excludes build/cache directories and includes `.java`, `.py`, `.xml`, `.md`, `.toml`, `.txt`, LICENSE and NOTICE files. This is a filtered text snapshot, not an unrestricted directory copy. `VerificationInput` continues to carry file snapshots, not local project root fields.

The `correct` output restores the selected class's TODO dependency closure: both MultipartStream methods or all four DiskFileItem methods. Other classes remain unchanged. These are controlled output samples derived from Apache Commons FileUpload 1.5, **not outputs from a live translator**. Target LICENSE/NOTICE are retained. Disk method provenance is recorded in `fileupload-disk-translation.ts`.

`count-plus-one` and `drop-output` are seeded target-defect outputs available only for `multipart-read-body`. Unsupported task/variant combinations fail explicitly. `correct` identifies the upstream target control, not a claim that the Python source is universally equivalent. Requirements distinguish source limitations, allowed differences and target defects.

`fileupload-datasets.json` keeps the old 14 Host-only manual scenarios for review and adds nine executable request cases. The six selectable method tasks do **not** activate all designed mutation scenarios. Never stage these annotations, oracle drivers or unselected control outputs in the Agent workspace.

## Execution

`npm run e2e` calls the official `VerificationService.verifyWithReceipt` entry point. It writes the complete framework result to `report.json` and a Host-only fixed-field comparison to `comparison.json` under `services/translation-verifier/test-results/verification-*/`. It does not call the private smoke driver directly and does not perform automatic LLM finding scoring.

Run from the repository root. Model-backed runs require `claude`, `npx`/`tsx`, Java/Maven, Python and `DEEPSEEK_API_KEY`. The `missing-policy` and `missing-test-basis` variants run the official preflight without credentials or a model call, unless an explicit policy override supplies a valid basis. The existing DeepSeek Anthropic-compatible configuration is used; `DEEPSEEK_MODEL` defaults to `deepseek-v4-flash`, and `JAVA_HOME` is forwarded when set. Builds may use local dependency caches or the network.

```bash
# Skip the Agent explicitly; not behavioral verification.
npm run e2e --workspace @forexplore/translation-verifier -- --offline-only

# Run the official fail-closed preflight without a model or API key.
npm run e2e --workspace @forexplore/translation-verifier -- --variant missing-policy --json

# Verify a real request through the official service entry point.
npm run e2e --workspace @forexplore/translation-verifier -- --task disk-write --variant correct --timeout-ms 600000

# Verify a seeded target defect; inspect report.json and comparison.json afterward.
npm run e2e --workspace @forexplore/translation-verifier -- --task multipart-read-body --variant count-plus-one --json

# Explicit target-only mode when the reference is rejected.
npm run e2e --workspace @forexplore/translation-verifier -- --variant target-only-correct --reference-decision rejected --reference-reason "Candidate version is not trusted" --test-basis "Independent task requirement"

# Same dataset through VerificationService with benchmark measurements.
npx tsx services/translation-verifier/e2e/run-fileupload-benchmark.ts --task disk-get --variant correct

# Local dataset/wrapper tests, including Maven control checks when installed; no model calls.
npm run test:e2e-data --workspace @forexplore/translation-verifier

# Independent fixed MultipartStream witnesses against all three variants; no model calls.
npx tsx services/translation-verifier/e2e/run-fileupload-oracles.ts
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--variant <id>` | `correct` | Executable request case; target defects remain restricted to body reading. |
| `--reference-decision <id>` | Input policy | Explicitly override the case policy with `accepted`, `rejected`, or `undetermined`; requires reason and test basis. |
| `--reference-reason <text>` | Input policy | Host-supplied trust decision reason. |
| `--test-basis <text>` | Input policy | Independent requirement/test basis for the explicit policy. |
| `--task <id>` | `multipart-read-body` | One of the six real TODO methods above. |
| `--api-key <key>` | `DEEPSEEK_API_KEY` | Optional override; environment configuration avoids shell-history exposure. |
| `--timeout-ms <ms>` | `300000` | Positive integer session timeout. |
| `--strategy <id>` | `differential-smoke` | Only this E2E strategy is supported. |
| `--verify-only` | Always enabled | Accepted compatibility flag. |
| `--offline-only` | Off | Skip the real session and exit zero. |
| `--json` | Off | Emit the complete service receipt plus the Host comparison; timing remains in files. |

## Workspaces and Results

The service stages inputs through the framework workspace builder, applies the selected patch with original-hash validation, and retains `services/translation-verifier/test-results/verification-*/` when the service's `keepWorkspace` option preserves it. The E2E wrapper always writes its official result and comparison manifest in the result directory:

The Agent workspace layout remains under the outer `resultsRoot`:

```text
resultsRoot/                 # test-results/verification-<wrapper-id>/
  report.json
  comparison.json
  timing.json
  timing.md
  artifacts/attempt-*/       # Durable strategy report and canonical result
  workspaces/verification-*/
    source/project/         # Source files staged only in differential mode
    source/.forexplore-tests/ # Source runner area (differential only)
    target/project/         # Target snapshot plus selected patch, read-only
    target/.forexplore-tests/ # Writable target runner area
    agent/                  # Agent cwd, report.json and commands.jsonl
    baseline.json
```

Differential verify-only runs require both source and target runners, while target-only runs stage and execute only the target runner; source execution and source findings remain prohibited.

Original repository projects are never patched. Runtime `source.root` and `target.root` point to the staged snapshots, not the original directories. The command proxy and baseline protections remain unchanged. This migration does not move Agent cwd into a project or broaden write permissions.

Differential verify-only requires zero repair rounds, empty `targetFiles`, nonempty cases, both runners and actual controlled compile/run evidence. Target-only verify-only requires zero repair rounds, empty `targetFiles`, nonempty cases, only the target runner and actual target controlled compile/run evidence. Insufficient evidence remains unverified. A generated report alone does not satisfy verification.

| Exit | Meaning |
| --- | --- |
| `0` | The official report was produced and its fixed fields matched the Host expectation. This is not proof that the natural-language finding is correct. |
| `1` | The official report was produced but fixed fields did not match. |
| `2` | Invalid arguments, missing key or an uncaught setup/service exception. |

Timing files are written best-effort in the outer `resultsRoot`, alongside `report.json` and `comparison.json`, not inside the Agent workspace. They include task/variant identity, dynamic Host spans, approximate Agent task occurrences and authoritative controlled-command durations. They exclude source, prompts, tool payloads and command output.

Agent `[VERIFIER_STEP]` intervals are approximate Host receipt times, not model clocks. Missing markers have no invented durations; transport buffering can collapse intervals to zero. Host spans, Agent observations and controlled-command intervals can overlap: **do not sum them**. Markers are not command-execution evidence.

This is local-process execution, not an OS sandbox. A successful run is neither proof of business correctness nor automatic mutant/control grading. The benchmark still requires independent replay before crediting a detected defect. Disk controls have local upstream JUnit and storage-observation checks; no automated six-task Agent scoring system is claimed.
