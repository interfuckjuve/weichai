# Reproducing the Shared FileUpload Verifier Task

This is a **verification-module E2E**, not a complete migration E2E. The verification agents use a real model and execute the actual Python/Java projects. The Analyzer report is simulated and the target implementation is a fixed upstream control, not live Translator output. There is no upstream Translator concurrency.

## Shared Dataset

The first standardized dataset is `fileupload-verifier-v1/multipart-read-body/correct`. Its Agent input is built by `fileUploadVerificationInput()` in `fileupload-e2e-dataset.ts`. The existing smoke dataset and additional tasks remain separate; they are not all standardized by this experiment.

| Field | Value |
| --- | --- |
| Task / variant | `multipart-read-body` / `correct` |
| Source project | `fixtures/code-corpus/commons-fileupload-python` |
| Source symbol | `MultipartStream.read_body_data` in `src/commons_fileupload/core.py` |
| Original target | `fixtures/target-system/commons-fileupload-java-skeleton` |
| Target symbol | `MultipartStream.readBodyData` in `src/main/java/org/apache/commons/fileupload/MultipartStream.java` |
| Initial state | Both selected-class methods contain TODO implementations |
| Fixed implementation | Apache Commons FileUpload 1.5, Apache-2.0; LICENSE and NOTICE retained |
| Patch scope | `readBodyData` and its prerequisite `skipPreamble`; unrelated TODOs remain untouched |
| Requirements | Exact body bytes/count, delimiter preservation, null-output counting, caller output ownership and allowed representation differences |
| Default analysis | Simulated `direct` applicability; source behavior remains evidence, not an absolute oracle |

[Upstream control source](https://github.com/apache/commons-fileupload/blob/commons-fileupload-1.5/src/main/java/org/apache/commons/fileupload/MultipartStream.java). The fixed implementation is materialized by `fileupload-benchmark-fixture.ts`. Host-only control labels and mutation/oracle annotations must not be copied into Agent workspaces or prompts. The word `correct` identifies this control; it does not prove universal source equivalence or generated test adequacy.

Every run's Host-only `benchmark.json` binds the actual full/pretranslation input, source snapshot, original target snapshot and patch by SHA-256. It records the Git revision and whether the checkout was dirty. Custom inputs are not labeled as the standardized control. Compare these hashes before comparing runs; a shared task name alone is insufficient.

## Prerequisites

Run from the repository root using a checkout of the same revision and its lockfile. Install the workspace dependencies with `npm ci`. Required executables are Node/npm, Claude Code >= 2.1.236, Java/Maven and Python >= 3.11. The current harness uses POSIX process handling; Windows support is not claimed.

Configure `DEEPSEEK_API_KEY` through your local environment or secret manager. Do not put a token in a command, dataset or shared report. All three strategies use `DEEPSEEK_MODEL`, defaulting to `deepseek-v4-flash`; keep model, effort and limits identical when comparing them. The existing Claude runtime uses the DeepSeek Anthropic-compatible configuration.

Maven preflight can restore declared dependencies and therefore use the network and shared caches. Subsequent runs can benefit from warm caches. Report execution order and preparation time separately; do not interpret one run per strategy as a performance ranking.

Local regression checks do not call a model:

```bash
npm run build --workspace @forexplore/translation-verifier
npm run test --workspace @forexplore/translation-verifier
npm run test:e2e-data --workspace @forexplore/translation-verifier
```

## Run Each Strategy Once

Run the commands sequentially. Each invocation creates a new run directory; do not rerun a failed command automatically. Each Agent has at most 50 turns and 600 seconds, subject also to its enclosing phase deadline. Preflight and verification phase budgets are separate. Existing bounded harness repair is part of the same experiment, not a full-run retry.

```bash
# White box: prepare source evidence, apply fixed translation, then author/replay target tests.
npm run e2e --workspace @forexplore/translation-verifier -- \
  --strategy multi-agent-differential --live \
  --task multipart-read-body --variant correct --timeout-ms 600000 --max-turns 50

# Black box: prepare target tests before translation, then replay; Agent2 only on failure.
npm run e2e --workspace @forexplore/translation-verifier -- \
  --strategy multi-agent-black-box --live \
  --task multipart-read-body --variant correct --timeout-ms 600000 --max-turns 50

# Autonomous single-session baseline: start with the translated target.
npm run e2e:single-agent --workspace @forexplore/translation-verifier -- \
  --live --task multipart-read-body --variant correct --timeout-ms 600000 --max-turns 50
```

An explicit `--model` overrides the environment. All three behavior strategies explicitly pass `--effort low` by default; `--effort high` (or another supported level) overrides it for an experiment. `benchmark.json` records the requested level, not confirmation that the upstream model honored it. Keep the level identical across compared runs. `--output-root /absolute/path` overrides the default root below. Use an absolute override with npm workspace commands so the result does not depend on npm's working directory. `--offline-only` skips model execution; it is not an E2E pass.

## Prompt Templates

Each strategy owns its readable template and generation functions:

- White box: `src/strategies/multi-agent-differential/behavior-prompt.ts`.
- Black box: `src/strategies/multi-agent-black-box/prompt.ts`.
- Single-agent: `src/strategies/single-agent-differential/prompt.ts`.

Templates use `{{source_project_root}}`, `{{target_project_root}}`, language and task-context slots. The strategy injects the actual prepared project roots before calling the runtime. Shared inspection rules and single-pass substitution live in `src/strategies/prompt-template.ts`; inserted task text is never rendered again. Templates are TypeScript strings, so the normal build includes them without extra asset copying or a template dependency.

All three receive task requirements, selected symbol locations, constraints, decision notes and applicable analysis/plan evidence, not inline repository snapshots. Agents read implementation and tests from the authorized project copies as needed. Single-agent reads the already-patched target instead of receiving the complete translation content/patch again. Black-box preparation sees only the untranslated target, and its diagnosis phase remains target-only. White-box independent target verification omits source context. Host still retains the complete input for identity and verification; smaller prompts do not relax permissions, frozen expectations or independent replay.

One live run per strategy after this change used `deepseek-v4-flash`, explicit `--effort low`, and `multipart-read-body/correct`: white-box completed in about 565 seconds with two exception-message divergences requiring review; black-box failed preparation in about 598 seconds because observations violated the protocol; single-agent timed out at its 600-second session limit (about 602 seconds total). Initial input tokens fell from about 160k to 6.1k for black-box and 200k to 5.3k for single-agent. This single sample does not establish a performance ranking or isolate the effect of effort from prompt changes. The existing 600-second ceiling is unchanged; neither lower effort nor smaller input guarantees completion.

## Inspect the Run

The default output is outside the fixture directories and is ignored by Git:

```text
e2e-runs/<strategy>/commons-fileupload-java-skeleton/<run-id>/
  source/          Independent source project copy
  target/          Independent target project copy, generated tests and build output
  agent/           Strategy handoff/session evidence
  artifacts/       Persisted verification artifacts
  report.json      Verification result
  benchmark.json   Host-only dataset/configuration identity and report links
  events.jsonl     Bounded Host-observed timeline
  timing.json      Machine-readable timing summary
  timing.md        Human-readable timing summary
```

Copies use filesystem COW when supported, with an independent ordinary-copy fallback, never hard links. Original fixtures are not patched. Runs are retained for inspection, including failures; no automatic rollback or deletion of your original projects is performed. Black-box Agent1 may experiment only in the source working copy under the existing workflow controls.

White-box and black-box use explicit `prepareTests` -> fixed patch application -> `verifyTranslation`. Their preparation input contains no translation. Black-box post-translation preflight compiles production code only; test compilation failures remain inside verification and can trigger Agent2. Single-agent intentionally remains one autonomous verification session; do not add artificial phase prompts merely to obtain comparable timing. These runners call trusted strategy APIs directly, not the external service/CLI receipt-validation path.

Inspect `executionStatus`, `targetAssessment`, problems, case evidence and the sessions that actually ran. An exit code of 0 means verification completed, possibly reporting a defect; it is not a business-correctness or test-coverage proof. Exit 1 means incomplete verification, and exit 2 means argument/setup or uncaught failure. The black-box correct control may pass its initial replay and therefore never start Agent2; this is a skipped diagnosis branch, not missing execution evidence.

## Timing Interpretation

- Host stage/session intervals and controlled-command durations are measurements. Agent internal reasoning time is not directly observable.
- Tool request/result receipt intervals are approximate. Read/Glob/Grep activity can be labeled exploration; Write/Edit to test files can be labeled test authoring. These labels describe observed tools, not all model effort spent on those activities.
- Missing pairs, buffering, truncation and unclassified session time remain explicit. No missing measurement is invented as zero.
- A command such as `mvn test` can compile and run tests together. Unless reliable separate measurements exist, report a combined compile/test duration. Dependency restore and project preparation are recorded separately from strategy execution.
- Parent spans include child work. Concurrent or nested intervals overlap; do not sum phase, session, tool and command durations into a supposed total.
- Observation is best-effort and does not change verification verdicts. Inspect timing diagnostics and log completeness before drawing conclusions.

Streams and command evidence can contain source code, generated tests and local paths even after credential redaction. Keep raw run directories local. To ask classmates to reproduce a result, share the code revision, dataset ID/hashes, model/limits, command, result classification and reviewed timing summary; each person supplies their own credentials and creates independent copies. Do not publish raw prompts or logs without reviewing their contents.
