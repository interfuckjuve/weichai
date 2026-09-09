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

## Execution (Default Strategy)

`npm run e2e` calls the official `VerificationService.verifyWithReceipt` entry point. The canonical output is verifier contract `2.0` (`differential-smoke@2.0.0` by default); legacy verifier `status` fields and old reports are rejected, not converted. It writes the complete framework result to `report.json` and a Host-only fixed-field comparison to `comparison.json` under `services/translation-verifier/test-results/verification-*/`. It does not call the private smoke driver directly and does not perform automatic LLM finding scoring.

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

# Explicitly skip model execution; this does NOT run an injected fixture runtime.
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts --strategy multi-agent-differential --variant correct --offline-only

# Opt in to the full-project controlled Claude runtime (sandbox off)
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts --strategy multi-agent-differential --live --variant correct --timeout-ms 600000
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
| `--strategy <id>` | `differential-smoke` | `differential-smoke` keeps the existing default; `multi-agent-differential` dispatches to the bounded concurrent E2E harness. |
| `--verify-only` | Always enabled | Accepted compatibility flag. |
| `--offline-only` | Off | Skip the real session and exit zero. |
| `--json` | Off | Emit the complete service receipt plus the Host comparison; timing remains in files. |

## Workspaces and Results

The service stages inputs through the framework workspace builder, applies the selected patch with original-hash validation, and retains `services/translation-verifier/test-results/verification-*/` when the service's `keepWorkspace` option preserves it. The E2E wrapper always writes its official result and comparison manifest in the result directory. The private `runSmoke()` path is verify-only and accepts only a caller-prepared workspace layout; workspace creation, staging and cleanup remain outside that function.

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
    target/project/         # Target snapshot plus selected patch
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

Timing files are written best-effort in the outer `resultsRoot`, alongside `report.json` and `comparison.json`, not inside the Agent workspace. They include task/variant identity, dynamic Host spans, approximate Agent task occurrences and authoritative controlled-command durations. They exclude source, prompts, tool payloads and command output. Timing and diagnostic metadata are separate from command evidence and never make a report valid or establish a finding.

Agent `[VERIFIER_STEP]` intervals are approximate Host receipt times, not model clocks. Missing markers have no invented durations; transport buffering can collapse intervals to zero. Host spans, Agent observations and controlled-command intervals can overlap: **do not sum them**. Markers are not command-execution evidence.

The default `differential-smoke` strategy is local-process execution, not an OS sandbox. A successful run is neither proof of business correctness nor automatic mutant/control grading. The benchmark still requires independent replay before crediting a detected defect. Disk controls have local upstream JUnit and storage-observation checks; no automated six-task Agent scoring system is claimed.

## Single-Agent Differential

`single-agent-differential@1.0.0` has a separate runner. It does not pass through the smoke workflow or run a Translator. The caller copies the complete source and target projects with COW when supported (independent ordinary-copy fallback), overlays the declared source/target snapshots, applies the fixed target patch once, and prepares both projects before starting the single Agent session.

```bash
# Explicit skip, not verification and not a mock fallback.
npm run e2e:single-agent --workspace @forexplore/translation-verifier -- --offline-only --json

# Real model execution: opt in only with credentials and toolchains available.
npm run e2e:single-agent --workspace @forexplore/translation-verifier -- --live --task multipart-read-body --variant correct --timeout-ms 600000

# Optional externally prepared Analyzer report.
npm run e2e:single-agent --workspace @forexplore/translation-verifier -- --live --analysis-report /path/to/analysis.json
```

Supported variants are `correct`, `count-plus-one`, `drop-output`, `source-count-plus-one`, and `both-count-plus-one`; mutation variants remain limited to body reading. Legacy policy-only variants, forced mode and Host test-basis flags are rejected. The input passed to the Agent removes the legacy verification policy and mutation-label provenance. Default analysis is explicitly simulated and leaves reference suitability to the Agent; dataset labels remain in the Host summary.

Real preflight checks Python 3.11+ imports and runs Maven `clean test-compile` against the already-patched target. It may restore declared dependencies. Both sides must succeed before any Agent starts. Tests explicitly inject both the model runtime and preparation callback, so no dependency restoration or model call is hidden behind an offline test. The wrapper's injected records verify orchestration and evidence contracts, not Java/Python behavior or real Agent quality.

Results are retained under `test-results/single-agent-*/`: complete project copies, canonical result and strategy artifacts, redacted `preparation.json`, `timing.json`, and Host-only `benchmark.json`. Preparation failures produce `environment_unavailable` without launching an Agent. `--timeout-ms` provides separate budgets for preflight and the Agent; copying is measured in preparation time but is outside the preflight timer. `agentMs` is the strategy invocation interval, not a model-token timing metric. Exit 0 means verification completed (possibly finding a bug), 1 means incomplete verification, and 2 means argument/setup failure. `--offline-only` reports an explicit skip and exits 0.

The runner checks original fixture baselines after execution; it does not implement an OS sandbox or rollback. Strategy tests can bypass this FileUpload runner and call the public `verify()` directly with their own complete, runnable project copies.

## Multi-Agent Differential

`multi-agent-differential@3.1.0` is opt-in. Direct/adapt routes use separate Agent1 and Agent2 processes; reference/reject routes skip Agent1 and use only Agent2. Agents add new project tests; `.forexplore-tests` holds language-neutral designs, observations and optional launch glue. There is no coordinator model or live upstream Analyzer/Translator. The E2E caller still overlays snapshots, applies the fixed target patch once and prepares both project copies before verification; this fixture preparation does not grant Agent2 access to the source on reference/reject routes. Programmatic service callers may supply only a prepared target on those routes. A readiness callback controls when Agent2 may start. It is a read-only notification, not a preparation task: it must not write projects, launch commands, or own cleanup resources. Cancellation may stop waiting for a notification that never arrives.

```mermaid
flowchart TD
  A[Caller prepares full projects and target patch] --> B{Analyzer applicability.level}
  B -->|direct| C[Agent1 collects preserved source behavior]
  B -->|adapt| D[Agent1 separates source and requirement bases]
  B -->|reference or reject| E[Skip Agent1 and await target readiness]
  C --> F[Host freezes v3 design and actual source evidence]
  D --> F
  F --> G[Await target readiness]
  G --> H[Agent2 binds frozen cases to target tests]
  E --> K[Agent2 designs requirements using only target context]
  K --> L[Host freezes target plan before any command]
  L --> M[Agent2 authors and runs target tests]
  M --> I[Host replays target and compares per-case expectations]
  H --> I
  I --> J[Report evidence and issues without implementation repair]
```

```bash
# Discover registered strategies through the official CLI.
npm run verify --workspace @forexplore/translation-verifier -- --list-strategies

# Verify an already-translated request using the official service workspace.
npm run verify --workspace @forexplore/translation-verifier -- --strategy multi-agent-differential --input request.json --output result.json --keep-workspace

# Exercise caller-owned copies and a delayed target-ready barrier on real projects.
npm run e2e --workspace @forexplore/translation-verifier -- --strategy multi-agent-differential --live --effort low --timeout-ms 600000
```

The new E2E requires `--live` for actual model execution. A test runtime can only be explicitly injected by tests; there is no silent mock fallback. `--offline-only` skips execution, and cannot be combined with `--live`. JSON output includes `executionMode: live | injected-test`. Its exit code is 0 for a completed comparison (which may find divergences), 1 for incomplete verification, and 2 for invalid arguments/setup errors. Unlike the default benchmark, it does not grade results against the independent mutation catalog.

The E2E defaults to separate 600-second preparation and strategy budgets; each Agent has at most 50 turns. Before verification, live preparation checks Python 3.11+ imports and runs `mvn -B -ntp -DskipTests clean test-compile` in the already-patched target copy. Preparation may restore declared dependencies. It uses credential-minimized managed processes, persists redacted command/output/exit/duration evidence in `agent/target-preparation.json`, and starts no Agent on failure. Injected live runtimes require an explicit preparation callback; offline orchestration tests do not run toolchains or restore dependencies implicitly. The generic service retains its own configurable deadline.

The strategy reads `analysisReport.applicability.level`: `direct` and `adapt` select their respective Agent1 prompts; `reference`/`reject` select a dedicated independent Agent2 prompt with no source handoff or source directory. Invalid or absent classification starts no Agent. Legacy `migrationEligibility`, Host reference policy and `testBasis` do not gate this strategy. Default E2E analysis is simulated as `direct`; programmatic tests can supply other reports through `deps.input`. The wrapper removes legacy verification policy, and dataset mode labels do not force the strategy's decision. It uses full `fs.cp` COW copies with independent ordinary-copy fallback, never hardlinks. Real Analyzer/Translator integration remains out of scope.

### Artifacts and States

Agent1 collection, frozen handoff and final behavior report use schema `3.0`; Agent2's executable manifest stays `2.0`. Older collection materials are rejected. Each case has ID, intent, input, optional structured setup/operations/observables, and an expectation with rationale and provenance. `source` cases obtain observations only through actual Host replay; `requirement` cases freeze an expected return or exception before target execution; `unresolved` blocks completion. Source replay executes only source-based cases. Requirement-only Agent1 designs on adapt routes omit source commands/results and use `testFiles: []`.

For `reference`/`reject`, Agent2 creates `.forexplore-tests/target-plan.json` schema `1.0`, containing `testBasis: { summary, evidence }` and requirement-derived cases. It must submit the plan before any target command, including diagnostics and setup. Host-held exact frozen bytes, not a post-session assertion, establish ordering. Source-based expectations are rejected; unresolved required expectations stop completion. The report records `targetPlan` without a source snapshot or Agent1 session. The executable manifest still describes newly authored target tests and replay commands.

On direct/adapt routes, Agent2 receives immutable language-neutral cases, source observations where applicable, and notes. It binds target-language tests without changing scenario meaning, expectations or source evidence. On reference/reject routes there is no such handoff: Agent2 independently designs and binds target tests after readiness, with only the target project directory and command authorization. Agent-authored harnesses and expectation reasoning still require review; agreement does not prove their correctness.

The retained output includes the sessions that actually ran, redacted incremental streams, frozen test sources/manifests, command stdout/stderr/exit codes, target subject hash, and the final behavior report. Source streams, observations and handoff artifacts exist only when Agent1 ran. No translation files are written back. `json-schema-faker` is not required; this version uses explicit cases and existing Ajv validation.

Each active side may receive one additional session when the Host rejects a manifest or observation JSON. Feedback includes the actual failure evidence; original files and already-frozen inputs remain unchanged. Target harness repair reuses the accepted source snapshot on direct/adapt routes or the independent frozen target plan on reference/reject routes. It never starts Agent1 for a target-only retry. Genuine behavioral differences, integrity violations and timeouts do not trigger this repair. `repairs` and separate `*-repair-1-session.json` artifacts record it; the original overall deadline still applies.

The existing status-free verifier envelope is preserved. Source-based case passes are `verified-equivalent`; requirement-based passes are `requirement-satisfied`, even where the requirement intentionally differs from source behavior. The report retains divergence, invalid input, generation, readiness, timeout and integrity failures separately. Target-only source assessment is `not_checked`; differential source assessment remains `inconclusive`. No source-correctness proof or automated adequacy grading is claimed.

Actual outputs must cover every executed case exactly once. Both manifest versions use canonical project-relative `testFiles` paths, including `.forexplore-tests/` when a helper lives in the metadata directory. Duplicate paths, traversal and links are rejected. `resultFile` is an optional dedicated JSON output under `.forexplore-tests/`; normal build/test stdout is retained as evidence and is not required to be JSON. Comparisons preserve types, order, null values and exception data. Unsafe integers must be encoded as strings. Credentials in command stdout fail closed rather than being rewritten before comparison. Host hash checks detect and reject modifications to frozen manifests, harnesses, inputs and existing project files; they do not prevent writes or provide rollback. Build/cache outputs remain writable in normal project build locations.

### Runtime Boundary

Claude Code >= 2.1.236 is required. The managed runtime preserves installed tools on the host PATH and the host HOME/JAVA_HOME settings; real Maven/.NET dependency restoration may access caches and the network. Native sandboxing is explicitly disabled. The Claude launcher currently uses a POSIX shell for stdin redirection; macOS is verified, Windows operation is not claimed.

Claude sessions use a replacement system prompt, Read/Edit/Write/Glob/Grep plus controlled Bash, isolated settings/configuration, `--safe-mode`, and no plugins, hooks, skills or MCP servers. Complete prompts and permission settings are supplied through files instead of oversized argv values. Bash is allowed only through the fixed command proxy; the proxy validates tool names and cwd, uses argument-array spawning and sanitized build environments, and checks original/frozen file integrity before and after commands. CLI edit rules deny original files, frozen inputs and the other project. Normal test additions and regenerated build/cache output are allowed, including Maven submodules and .NET project bin/obj directories. The DeepSeek token-based provider cannot use the documented `--bare` API-key authentication mode, so automatic customization is disabled explicitly instead. No permission bypass flag is used. The runtime exposes full project `cwd` and logical `readRoots`/`writeRoots`; this E2E does not claim an OS filesystem namespace or native sandbox. Host replay and live Maven preparation use the managed command boundary and sanitized build environment, with native sandboxing disabled for the trusted preflight. No standalone shim or manual copy algorithm is substituted for the real project toolchain.

This is a command-policy boundary, not a hidden filesystem namespace: directory metadata, required OS/toolchain files and per-session runtime scratch remain available. Host hash checks detect and reject changes to existing implementation entries; they do not prevent writes or roll back a project. New test files and standard build outputs such as `target`, `bin` and `obj` are permitted. Original/nonempty user directories are never removed. Matching source/target observations do not prove business correctness and can miss common-mode defects.
