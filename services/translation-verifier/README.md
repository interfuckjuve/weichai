# translation-verifier

A replaceable strategy baseline for translation verification: generic input -> registered strategy -> identified output. The default `differential-smoke` strategy supports Host-selected differential or target-only verification. It reports source/target conclusions separately from execution failures. It is not proof of business correctness.

## Public Contract

Output schema `$id` is `urn:forexplore:verification-output:2.0`; `VerificationResult.schemaVersion` and `translationVerifierSchemaVersion` are `2.0`. The default strategy is `differential-smoke@2.0.0`. Input and run/timing schemas remain `1.0`. This is a breaking output change: strategy outputs and results explicitly reject legacy `status`, and `deriveCompatibilityStatus` is no longer exported. Old reports are not converted or accepted. Unrelated strategy extension fields remain accepted.

```ts
createDefaultVerificationService(options?).verify(input, { strategyId?, keepWorkspace? }, signal)
createDefaultVerificationService(options?).verifyWithReceipt(input, { strategyId?, keepWorkspace? }, signal)
```

`VerificationInput` carries the adaptation request, analysis report, migration plan, translation patch and optional legacy strategy-specific `verificationPolicy`. Strategies own reference suitability and test design; the framework owns resource preparation, execution lifecycle and durable results. `VerificationResult` binds strategy ID/version, patch subject hash, the complete canonical input hash, round, independent assessments, issues, artifacts and a strategy-owned report. `verifyWithReceipt()` persists the canonical result once and returns its exact durable relative path, SHA-256, byte size, ID and media type. Timing observations do not change results, receipts, hashes or verdicts.

### Reference Policy and Report Dimensions

```ts
verificationPolicy: {
  referenceDecision: "accepted", // accepted | rejected | undetermined
  reason: "Reviewed reference snapshot and provenance",
  testBasis: "Host-confirmed requirement: return the exact number of body bytes"
}
```

For the default smoke strategy, only `accepted` authorizes source execution and selects `mode: "differential"`. Rejected, undetermined or omitted decisions select `target_only`; the smoke provider declines source staging. Its Agent cannot promote reference trust or select its own mode. Both smoke modes require an explicit independent `testBasis`; missing basis fails closed before a model call. These are smoke rules, not universal framework requirements. Other strategies may establish their own test basis and reference decision. A reference implementation is evidence, never the sole authority over a requirement.

| Report field | Values and meaning |
| --- | --- |
| `mode` | `differential` runs both sides; `target_only` checks only the translation. |
| `referenceDecision`, `referenceReason` | Selected strategy's reference decision and explanation. Smoke preserves the legacy Host decision. |
| `executionStatus` | `completed`, `partial`, `failed`, `cancelled`. Independent of code correctness. |
| `sourceAssessment`, `targetAssessment` | `bug_found`, `no_bug_observed`, `suspected_bug`, `inconclusive`, `not_checked`. Target-only always reports source `not_checked`. |
| `problems` | Structured execution/report problems with code, message and optional side/command ID. |

The four decisive differential combinations are no observed bugs, source-only bug, target-only bug, and bugs on both sides. Differential equality cannot override independent requirements; source-only bugs must not cause the target to reproduce them. An unresolved side is not silently treated as correct. `no_bug_observed` applies only to the executed checks.

Problem codes distinguish `report_missing`, `report_invalid_json`, `report_schema_invalid`, `report_evidence_invalid`, `agent_timeout`, `command_timeout`, `agent_error`, `environment_unavailable`, `insufficient_test_basis`, `workspace_integrity_violation`, `context_incomplete`, `unsupported_language`, `input_invalid`, `artifact_persistence_failed`, `internal_error` and `cancelled`. Valid partial findings can survive a later timeout, but invalid report/evidence/baseline cannot establish code findings. A compiler failure is not automatically a target bug: dependency and runner failures do not prove translation defects.

The adaptation adapter alone maps a validated report to the existing workflow gate: missing durable receipt, invalid report or cancelled execution -> `unverified`; any valid noncancelled target `bug_found`, including partial findings -> `fail`; completed target `no_bug_observed` with target-only mode or resolved source -> `pass`; otherwise -> `unverified`. This workflow decision belongs to the adaptation receiver, not the verifier. Generic contracts still retain `ValidationStatus` for workflow validation records and other unrelated validation evidence. Source-only bugs do not trigger target repair. Repair requires a failing validation record bound to the exact canonical result artifact ID/hash, and excludes source-bug issues. No verifier or smoke compatibility status is retained.

The framework has three external phases: **validate input**, **execute strategy**, **save report**. Strategy internals are arbitrary, repeatable and may use no Agent. There is no central six-stage smoke workflow. See [docs/flow.md](docs/flow.md) for ownership and execution flow.

The V2 adaptation runtime uses `TranslationVerifierV2Adapter` and the default service. This redesign changes report reception and legacy gate mapping only: it does not inject Host policies into the adaptation runtime or change its analysis, translation, repair or cancellation flow. Existing adaptation requests without an independent basis remain `unverified` under default smoke; upstream policy integration belongs to that module's owner. Strategy selection belongs to the server, not HTTP clients or the UI. Unknown strategy IDs fail without fallback. `AdaptationAdapterV2` owns the migration repair loop, with at most two repair rounds; required `unverified` checks stop repair and block write-back.

## Register and Compare Strategies

Register providers in the existing factory; each provider creates a strategy with `verify(input, context, signal)`. A provider may declare `workspaceRequirements(input): { source: boolean }` before resource preparation, without creating an Agent. Source context is available by default; its presence is not acceptance of source behavior or a command to execute it. No Agent or step list is required. Registered providers are trusted Host code and remain responsible for establishing an independent test basis, which may come from fixed acceptance tests rather than smoke's policy text. Generic result validation checks envelope integrity and assessment consistency; it does not attest that a provider ran meaningful tests. A result claiming `insufficient_test_basis` cannot also claim decisive code findings, and unresolved execution problems cannot accompany `completed`.

A minimal registration-only example deliberately returns failed execution with inconclusive findings:

```ts
import {
  VerificationService, VerificationStrategyFactory, failureAssessment,
  type VerificationStrategyProvider,
} from "@forexplore/translation-verifier";

const provider: VerificationStrategyProvider = {
  descriptor: { id: "my-check", version: "1.0.0", displayName: "My Check" },
  create: () => ({
    async verify(input, _context, signal) {
      signal?.throwIfAborted();
      return {
        ...failureAssessment(input, "internal_error", "No verification implemented."),
        summary: "No verification implemented.",
        issues: [], artifacts: [], strategyReport: null,
      };
    },
  }),
};
const service = new VerificationService({
  factory: new VerificationStrategyFactory([provider]),
  defaultStrategyId: "my-check",
});
```

For a real comparison, register both implemented providers in that same factory, then call `service.verifyWithReceipt(sameInput, { strategyId })` once per provider. Keep patch hash, round, source/target snapshots, fixture and runtime configuration identical. Compare verdicts, evidence coverage, missing evidence and cost separately. Private task names and step counts need not match. `context.measureStep(name, work)` optionally measures arbitrary or repeated private work; it does not schedule it. Return artifacts only through `context.writeArtifact()` and use its returned references.

The smoke E2E wrapper currently supports only `differential-smoke`; it is not a general strategy benchmark runner. Use the generic service for other registered strategies. A single run cannot establish a performance ranking or semantic accuracy.

### Prepared Projects and Independent Tests

Trusted programmatic callers can pass `preparedProjects: { sourceRoot?, targetRoot }` in the second argument to `verify()` or `verifyWithReceipt()`. These are independent, already-prepared project copies, not paths accepted from input JSON or the generic CLI. The target must already contain the submitted translation. The framework checks declared source and translated target content, rejects overlapping project/storage roots and linked declared files, and never reapplies the patch. A source root is required unless the selected provider declines it. Extra project resources remain available.

The caller owns prepared project cleanup. Framework run and artifact directories retain their own lifecycle; `context.workspace.projectOwnership` identifies project ownership. Passing an original working directory is not a copy operation: callers must prepare isolated copies first. COW/reflink is an optimization, not OS isolation. Legacy smoke rejects caller-owned external project roots because its protected baseline and runner layout require the framework-owned workspace; use its existing snapshot entry instead.

Framework tests use `VerificationService.verifyWithReceipt()` with lightweight test strategies. Strategy tests call the strategy's public `verify()` directly with runnable projects, fixed target implementations and simulated analysis reports. A small set of integration checks covers registration and envelope compatibility. None requires a live Analyzer or Translator, and deterministic model substitutes do not measure real model quality.

## Single-Agent Baseline

`single-agent-differential@1.0.0` is explicitly selectable; default smoke remains unchanged. Configure its model/runtime through `createDefaultVerificationService({ singleAgent: { ... } })`, or invoke `SingleAgentDifferentialStrategy.verify()` directly from its strategy module with prepared project context.

One session reads the authorized source and target projects, selects differential or target-only verification, derives a test basis, authors new project tests, runs commands, and writes its final report. It does not simulate Agent1/Agent2, use their handoff manifest, or start a repair session. Missing evidence never falls back to smoke or a mock runtime.

Before the first target command, including setup/build commands, the Agent writes its plan. The Host freezes those bytes. Each case cites either requirements or an actual source observation; a requirement-derived expectation may intentionally differ from the source. Controlled commands return Host-generated evidence IDs. The final target observation command emits a JSON array covering the frozen cases; normal build logs belong in separate commands or stderr. Setup, ordered operations and observable side effects can be encoded as structured case input/output, with explicit limitations.

The Host validates the frozen plan, command identities, actual outputs and project integrity, and compares target observations to expectations. Target-only rejects any recorded source execution. Both original projects remain protected; only new tests/helpers and normal build outputs may change. Runtime-owned evidence, not editable project log copies, is authoritative. This does not independently prove that an Agent-generated test invokes the intended behavior or that its expectations are correct.

`executionSides` is a trusted single-agent runtime option, separate from the Agent's reference judgment. Directory availability and business suitability are not execution authorization. The normal baseline authorizes both supplied projects; callers can limit it to target execution. The existing local-process and no-OS-isolation limitations still apply.

## Multi-Agent Three-Way Verification

`multi-agent-differential@3.0.0` keeps separate Agent1 and Agent2 sessions. The strategy maps `analysisReport.applicability.level` explicitly: `direct` selects source collection, `adapt` selects preserved-versus-changed behavior design, and `reference`/`reject` select requirement-only design. Missing or invalid classification fails before an Agent starts. Legacy `migrationEligibility`, accepted Host policy and `testBasis` are not prerequisites.

Agent1 collection and the behavior report use schema `3.0`; Agent2's executable manifest stays `2.0`. Old collection materials are rejected, not silently reinterpreted. Each language-neutral case has stable ID, intent, input, optional structured setup/operations/observables, and an expectation with rationale and provenance. A `source` expectation obtains its value only from Host replay; a `requirement` expectation contains a fixed return or exception outcome before target execution; `unresolved` blocks completion. Source commands execute only source-based cases.

For `reference`/`reject`, Agent1 has `executionSides: []`: it can inspect authorized context and write test design, but cannot execute either project. Agent2 starts only after the caller's readiness barrier and binds the frozen design to the target language/framework. `waitForTarget` is a read-only readiness notification, not a preparation job: callers must finish all writes and process work before invoking `verify()`. Both declared project snapshots are checked before Agent1, and the target must remain unchanged across readiness. Required source execution is checked against the trusted strategy option `executionSides`, never inferred from a business classification. Requirement-only collections cannot hide recorded source activity.

The Host freezes Agent1's cases, manifests and test files across readiness and Agent2, then replays target tests. Source-based passes are `verified-equivalent`; requirement-based passes are `requirement-satisfied`. Mixed cases are not compared unconditionally against source outputs. Target-only reports source `not_checked`; differential source assessment remains `inconclusive`. One bounded harness-repair session per side remains available for malformed manifests/observations, not genuine behavioral differences, integrity failures or timeouts.

Both full-project strategies retain Host-owned command evidence and finish nested command process cleanup before returning from direct `verify()`. The proxy forwards cancellation, and the Host reaps registered outstanding process groups when the Agent or proxy exits unexpectedly. Generated test sources are captured with single-agent execution evidence. These lifecycle and integrity checks are not kernel isolation or proof of test adequacy.

## Ownership and Files

All paths below are relative to this package. `schemas/` is the package-local contract layer: wire schemas, generated types, runtime strategy interfaces and pure semantic validation. It must not depend on workflow execution or concrete strategies.

| Files | Responsibility |
| --- | --- |
| `src/verification-service.ts`, `src/create-default-verifier.ts` | Public entry and static default registration |
| `src/workflow/strategy-registry.ts` | Provider registry/factory; explicit unknown-ID failure |
| `src/workflow/run-verification.ts`, `validate-input.ts`, `run-strategy.ts`, `save-report.ts` | Three external phases, cancellation/deadline and canonical result receipt |
| `src/schemas/materialize-verification-result.ts`, `src/schemas/validate-verification-result.ts` | Pure output construction, schema materialization and result validation |
| `src/workflow/prepare-strategy-workspace.ts` | Generic snapshots and patch staging, no smoke runner layout |
| `src/run-output/verification-artifact-store.ts` | Durable artifacts, budgets, cleanup and safe references |
| `src/run-output/record-run.ts`, `measure-legacy-run.ts` | Bounded metadata recorder, dynamic Host spans and legacy phase timing bridge |
| `src/schemas/*.schema.json`, `verification-schema-types.d.ts`, `verification-types.ts` | JSON wire contracts, generated types, runtime strategy interfaces |
| `src/schemas/compile-schema-validators.ts`, `validate-*.ts` | Ajv validation plus hashes, identities and other semantic checks |
| `src/strategies/smoke-differential/strategy.ts` | Input/context preflight and framework-to-smoke mapping |
| `src/strategies/smoke-differential/run-smoke-verification.ts`, `prepare-smoke-workspace.ts` | Prepared-workspace-only smoke orchestration and caller-owned layout |
| `src/strategies/smoke-differential/build-test-task.ts`, `build-differential-test-prompt.ts`, `run-agent-session.ts` | Task construction and one Agent session |
| `src/strategies/smoke-differential/claude-session.ts`, `manage-test-process.ts` | Claude CLI options, live stdout observer, deadlines and process-tree cleanup |
| `src/strategies/smoke-differential/observe-agent-steps.ts` | Bounded, strategy-private assistant marker parser; approximate receipt-time observations only |
| `src/strategies/smoke-differential/protect-project-files.ts`, `controlled-test-command.ts`, `test-execution-config.ts` | Read-only baselines, allowed commands, minimized environment and authoritative command evidence |
| `src/strategies/smoke-differential/command-evidence.ts`, `evaluate-evidence.ts`, `read-test-report.ts`, `validate-test-report.ts`, `decide-test-verdict.ts` | Bounded command evidence, report reads and independent Host checks |
| `src/strategies/smoke-differential/observe-command-timings.ts`, `observe-agent-steps.ts` | Separate best-effort timing/telemetry observers; never evidence or verdict authority |
| `src/run-output/verification-logger.ts` | Bounded, redacted logging; full content is a separate opt-in |
| `src/verification-cli.ts` | Generic JSON input/output and strategy listing |
| `e2e/run-smoke-e2e.ts`, `e2e/write-smoke-timing.ts` | Smoke fixture wrapper and metadata-only timing sidecars |

## Evidence and Safety

The service and `runSmoke()` default to **verify-only**. `runSmoke()` is a pure input-plus-layout operation: it receives a preflighted `SmokeTaskInput` and caller-owned `RunLayout`, runs one verification session, and returns a classified result. It does not allocate or delete the request workspace, copy projects, stage inline source files, perform diagnostic repair, or repair target implementation files. The caller owns workspace lifetime and passes the layout directly. Source/target project snapshots remain read-only, report `rounds` must be zero and `targetFiles` empty. Runner repairs are allowed, target implementation repairs belong to the external translator. Smoke checks report shape, mandatory command evidence and final file baseline before returning a decisive result. Evidence-insufficient assessments remain inconclusive or suspected, not confirmed findings. Compilation success and model self-assessment do not prove business semantics. Command evidence is read and structurally validated by `command-evidence.ts`; diagnostic metadata and timing observers are separate and cannot attest that a command is valid evidence. Missing reports are explicit `null`, and failures use typed problem codes rather than parsing arbitrary error text.

Commands run only through the controlled proxy. It applies command/path restrictions, baseline checks, a credential-minimized build environment, bounded output, deadlines and process-tree termination. This is **local-process execution, not a security sandbox**. External isolation is required for hostile code. Same-user mutation and changing/restoring protected files within one command are not prevented by a kernel boundary.

An absent smoke report is explicitly `null`, never a fabricated empty report. Failure artifacts still persist structured execution problems. Smoke carries one authoritative assessment and validated bug-case metadata, without a nested duplicate evaluation.

Artifact persistence preserves the existing cumulative **10 MiB per-attempt** budget, including canonical result bytes. Path/symlink/read/write/budget failures fail closed with `artifact_persistence_failed`, no synthetic receipt and no retained references from the abandoned attempt. A receipt may omit its result artifact only for failed execution with an explicit persistence problem, no decisive side findings and no retained artifacts. Successful problem reports retain real evidence. Cleanup does not delete another attempt's artifacts. Invalid request envelopes and unknown strategies are rejected before execution. For valid requests, workspace/strategy failures and cancellation are normalized into a Host report; persistence failure returns a classified result without inventing an artifact path. After cancellation or a deadline, the framework joins the strategy's shutdown before cleaning its resources; `shutdownTimeoutMs` defaults to 5,000 ms and is independent of its execution budget. Cooperative strategies must join all their owned work before settling, and may validate and persist partial findings during this interval. If shutdown is still unconfirmed, the result explicitly reports it, workspace and existing artifacts are preserved, and subsequent framework artifact writes are refused. The Host does not claim cleanup or process termination merely because its wait budget expired; operators must resolve the outstanding work before removing preserved resources. Caller cancellation is always reported as `cancelled`, never as a completed pass. An upstream adaptation caller still observes its external cancellation after the verifier report has been saved.

## Outputs and Timing

- Verifier logs default to `<repository>/logs/translation-verifier.log`. The repository is located from the logger module's ancestors by the root `package.json` name (`forexplore-monorepo`), independent of module depth and the process working directory. `LoggerOptions.logDir` overrides `VERIFIER_LOG_DIR`; relative paths resolve against the repository root, absolute paths are preserved, and an empty value uses the default. A missing or unreadable repository manifest is an explicit error, not a fallback to the working directory.
- Generic temporary workspaces default to `<os.tmpdir()>/forexplore-verification-workspaces/`; durable artifacts default to `<os.tmpdir()>/forexplore-verification-artifacts/attempt-*/`. These roots remain configurable. The receipt gives the exact durable relative path.
- E2E uses real FileUpload requests through the official service, retains canonical reports and compares mode, execution status, side assessments and expected problem codes. Expected answers are Host-only. See [FileUpload E2E](./e2e/README.md) for current result paths and CLI options. Legacy `status` is neither emitted nor used for matching.
- Timing sidecars remain best-effort metadata only and never affect report validity, comparison outcomes or content hashes.
- Agent task markers are standalone assistant text outside fences. Repeated tasks have distinct occurrence IDs. Text-delta events are deduplicated against full assistant snapshots by message/block identity. No buffered return value is replayed as live timing. Tool results, thinking and snippets are ignored.
- `agent-step-approximate` observations use the recorder's `host-performance` receipt offset. Transport buffering and model narration affect these intervals. Missing telemetry, missing starts/ends and overflow are explicit; incomplete intervals have no invented duration. Limits: 1 MiB stream line, 4 KiB text/marker line, 10,000 events, 1,024 message identities and 4,096 remembered blocks. Overflow is drained and omitted.
- Command `durationMs` comes from the controlled process's `Date.now()` interval (`command-proxy:process-date-now`). Existing proxy subspans use its child `performance.now()` clock. These remain distinct from Agent markers; metadata may survive missing reports/session failures without satisfying evidence validation. Do not sum inclusive Host, Agent or command intervals.

`runRoot`, `debug` and `onRunRecorded` remain **reserved, currently ignored** source-compatible options. No production diagnostic run-root, persisted run manifest, debug pipeline or callback notification system is implemented. In-memory run metadata/schema support is not a promise of durable diagnostic storage.

## Commands and Configuration

Run from the repository root:

```bash
npm run test --workspace @forexplore/translation-verifier
npm run build --workspace @forexplore/translation-verifier
npx vitest run services/translation-verifier/e2e/smoke-e2e-timing.test.ts
npm run verify --workspace @forexplore/translation-verifier -- --list-strategies
npm run verify --workspace @forexplore/translation-verifier -- \
  --strategy differential-smoke --input /path/to/input.json --output /path/to/result.json
npm run e2e --workspace @forexplore/translation-verifier -- --offline-only
# Real model session, only when explicitly intended and credentials/toolchains are configured:
npm run e2e --workspace @forexplore/translation-verifier -- --verify-only --timeout-ms 600000
```

JSON schemas compile once through Ajv in strict mode. Generated TypeScript schema declarations are checked by `check:schema-types`; regenerate them with `generate:schema-types` after schema changes. Runtime semantic checks still validate hashes, artifact identities, safe paths and JSON-compatible in-process values.

File logging defaults to INFO under the repository's `logs/`. `VERIFIER_LOG_CONTENT=1` separately enables bounded/redacted full-content logging. Default rotation is 10 MiB per file, three retained files, independent of artifact budgets. No automatic raw `PostToolUse` hook subprocess or `claude-steps.jsonl` capture is installed; the old internal `hooksLogPath` option is ignored.

Toolchains, dependency caches and network access affect runtime and can cause `unverified`. Agent-generated coverage and semantic adjudication are not independent acceptance testing. See [FileUpload E2E](./e2e/README.md) for configuration, fixtures, paths and exit semantics.
