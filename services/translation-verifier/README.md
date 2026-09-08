# translation-verifier

A replaceable strategy baseline for translation verification: generic input -> registered strategy -> identified output. The default `differential-smoke` strategy supports Host-selected differential or target-only verification. It reports source/target conclusions separately from execution failures. It is not proof of business correctness.

## Public Contract

Output schema `$id` is `urn:forexplore:verification-output:2.0`; `VerificationResult.schemaVersion` and `translationVerifierSchemaVersion` are `2.0`. The default strategy is `differential-smoke@2.0.0`. Input and run/timing schemas remain `1.0`. This is a breaking output change: strategy outputs and results explicitly reject legacy `status`, and `deriveCompatibilityStatus` is no longer exported. Unrelated strategy extension fields remain accepted.

```ts
createDefaultVerificationService(options?).verify(input, { strategyId?, keepWorkspace? }, signal)
createDefaultVerificationService(options?).verifyWithReceipt(input, { strategyId?, keepWorkspace? }, signal)
```

`VerificationInput` carries the adaptation request, analysis report, migration plan, translation patch and optional Host-owned `verificationPolicy`. `VerificationResult` binds strategy ID/version, patch subject hash, the complete canonical input hash, round, independent assessments, issues, artifacts and a strategy-owned report. `verifyWithReceipt()` persists the canonical result once and returns its exact durable relative path, SHA-256, byte size, ID and media type. Timing observations do not change results, receipts, hashes or verdicts.

### Reference Policy and Report Dimensions

```ts
verificationPolicy: {
  referenceDecision: "accepted", // accepted | rejected | undetermined
  reason: "Reviewed reference snapshot and provenance",
  testBasis: "Host-confirmed requirement: return the exact number of body bytes"
}
```

Only `accepted` authorizes source execution and selects `mode: "differential"`. Rejected, undetermined or omitted decisions select `target_only`; source files are not staged for the Agent. The Agent cannot promote reference trust or select its own mode. Both modes of the default smoke strategy require an explicit independent `testBasis`; missing basis fails closed before a model call. A reference implementation is evidence, never the sole authority over a requirement.

| Report field | Values and meaning |
| --- | --- |
| `mode` | `differential` runs both sides; `target_only` checks only the translation. |
| `referenceDecision`, `referenceReason` | Host decision and explanation, bound to the complete input hash. |
| `executionStatus` | `completed`, `partial`, `failed`, `cancelled`. Independent of code correctness. |
| `sourceAssessment`, `targetAssessment` | `bug_found`, `no_bug_observed`, `suspected_bug`, `inconclusive`, `not_checked`. Target-only always reports source `not_checked`. |
| `problems` | Structured execution/report problems with code, message and optional side/command ID. |

The four decisive differential combinations are no observed bugs, source-only bug, target-only bug, and bugs on both sides. Differential equality cannot override independent requirements; source-only bugs must not cause the target to reproduce them. An unresolved side is not silently treated as correct. `no_bug_observed` applies only to the executed checks.

Problem codes distinguish `report_missing`, `report_invalid_json`, `report_schema_invalid`, `report_evidence_invalid`, `agent_timeout`, `command_timeout`, `agent_error`, `environment_unavailable`, `insufficient_test_basis`, `workspace_integrity_violation`, `context_incomplete`, `unsupported_language`, `input_invalid`, `artifact_persistence_failed`, `internal_error` and `cancelled`. Valid partial findings can survive a later timeout, but invalid report/evidence/baseline cannot establish code findings. A compiler failure is not automatically a target bug: dependency and runner failures do not prove translation defects.

The adaptation adapter alone maps a validated report to the existing workflow gate: missing durable receipt, invalid report or cancelled execution -> `unverified`; any valid noncancelled target `bug_found`, including partial findings -> `fail`; completed target `no_bug_observed` with target-only mode or resolved source -> `pass`; otherwise -> `unverified`. Source-only bugs do not trigger target repair. Repair requires a failing validation record bound to the exact canonical result artifact ID/hash, and excludes source-bug issues. No verifier or smoke compatibility status is retained.

The framework has three external phases: **validate input**, **execute strategy**, **save report**. Strategy internals are arbitrary, repeatable and may use no Agent. There is no central six-stage smoke workflow. See [docs/flow.md](docs/flow.md) for ownership and execution flow.

The V2 adaptation runtime uses `TranslationVerifierV2Adapter` and the default service. This redesign changes report reception and legacy gate mapping only: it does not inject Host policies into the adaptation runtime or change its analysis, translation, repair or cancellation flow. Existing adaptation requests without an independent basis remain `unverified` under default smoke; upstream policy integration belongs to that module's owner. Strategy selection belongs to the server, not HTTP clients or the UI. Unknown strategy IDs fail without fallback. `AdaptationAdapterV2` owns the migration repair loop, with at most two repair rounds; required `unverified` checks stop repair and block write-back.

## Register and Compare Strategies

Register providers in the existing factory; each provider creates a strategy with `verify(input, context, signal)`. No Agent or step list is required. Registered providers are trusted Host code and remain responsible for establishing an independent test basis, which may come from fixed acceptance tests rather than smoke's policy text. Generic result validation checks envelope integrity and assessment consistency; it does not attest that a provider ran meaningful tests. A result claiming `insufficient_test_basis` cannot also claim decisive code findings, and unresolved execution problems cannot accompany `completed`.

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

## Ownership and Files

All paths below are relative to this package.

| Files | Responsibility |
| --- | --- |
| `src/verification-service.ts`, `src/create-default-verifier.ts` | Public entry and static default registration |
| `src/workflow/select-strategy.ts` | Provider registry/factory; explicit unknown-ID failure |
| `src/workflow/run-verification.ts`, `validate-input.ts`, `run-strategy.ts`, `save-report.ts` | Three external phases, cancellation/deadline and canonical result receipt |
| `src/workflow/prepare-strategy-workspace.ts` | Generic snapshots and patch staging, no smoke runner layout |
| `src/run-output/verification-artifact-store.ts` | Durable artifacts, budgets, cleanup and safe references |
| `src/run-output/record-run.ts`, `measure-legacy-run.ts` | Bounded metadata recorder, dynamic Host spans and legacy phase timing bridge |
| `src/schemas/*.schema.json`, `verification-schema-types.d.ts`, `verification-types.ts` | JSON wire contracts, generated types, runtime strategy interfaces |
| `src/schemas/compile-schema-validators.ts`, `validate-*.ts` | Ajv validation plus hashes, identities and other semantic checks |
| `src/strategies/smoke-differential/strategy.ts` | Input/context preflight and framework-to-smoke mapping |
| `src/strategies/smoke-differential/run-smoke-verification.ts`, `prepare-projects.ts`, `create-smoke-workspace.ts` | Private smoke orchestration, layout and compatibility workspace lifecycle |
| `src/strategies/smoke-differential/build-test-task.ts`, `build-differential-test-prompt.ts`, `run-agent-session.ts` | Task construction and one Agent session |
| `src/strategies/smoke-differential/claude-session.ts`, `manage-test-process.ts` | Claude CLI options, live stdout observer, deadlines and process-tree cleanup |
| `src/strategies/smoke-differential/observe-agent-steps.ts` | Bounded, strategy-private assistant marker parser; approximate receipt-time observations only |
| `src/strategies/smoke-differential/protect-project-files.ts`, `controlled-test-command.ts`, `test-execution-config.ts` | Read-only baselines, allowed commands, minimized environment and authoritative command evidence |
| `src/strategies/smoke-differential/read-test-report.ts`, `validate-test-report.ts`, `evaluate-evidence.ts`, `decide-test-verdict.ts` | Bounded report/evidence reads, independent Host checks and smoke outcome policy |
| `src/run-output/verification-logger.ts` | Bounded, redacted logging; full content is a separate opt-in |
| `src/verification-cli.ts` | Generic JSON input/output and strategy listing |
| `e2e/run-smoke-e2e.ts`, `e2e/write-smoke-timing.ts` | Smoke fixture wrapper and metadata-only timing sidecars |

## Evidence and Safety

The service and `runSmoke()` default to **verify-only**. Source/target project snapshots remain read-only, report `rounds` must be zero and `targetFiles` empty. Runner repairs are allowed, target implementation repairs belong to the external translator. Smoke checks report shape, mandatory command evidence and final file baseline before returning a decisive result. Evidence-insufficient assessments remain inconclusive or suspected, not confirmed findings. Compilation success and model self-assessment do not prove business semantics.

Commands run only through the controlled proxy. It applies command/path restrictions, baseline checks, a credential-minimized build environment, bounded output, deadlines and process-tree termination. This is **local-process execution, not a security sandbox**. External isolation is required for hostile code. Same-user mutation and changing/restoring protected files within one command are not prevented by a kernel boundary.

An absent smoke report is explicitly `null`, never a fabricated empty report. Failure artifacts still persist structured execution problems. Smoke carries one authoritative assessment and validated bug-case metadata, without a nested duplicate evaluation.

Artifact persistence preserves the existing cumulative **10 MiB per-attempt** budget, including canonical result bytes. Path/symlink/read/write/budget failures fail closed with `artifact_persistence_failed`, no synthetic receipt and no retained references from the abandoned attempt. A receipt may omit its result artifact only for failed execution with an explicit persistence problem, no decisive side findings and no retained artifacts. Successful problem reports retain real evidence. Cleanup does not delete another attempt's artifacts. Invalid request envelopes and unknown strategies are rejected before execution. For valid requests, workspace/strategy failures and cancellation are normalized into a Host report; persistence failure returns a classified result without inventing an artifact path. After cancellation or a deadline, the framework allows up to 250 ms for a cooperative strategy to finish validating and persisting partial findings. Later results are not guaranteed to survive, including when process-tree cleanup exceeds that window. Caller cancellation is always reported as `cancelled`, never as a completed pass. An upstream adaptation caller still observes its external cancellation after the verifier report has been saved.

## Outputs and Timing

- Verifier logs default to `<repository>/logs/translation-verifier.log`. The repository is located from the logger module's ancestors by the root `package.json` name (`forexplore-monorepo`), independent of module depth and the process working directory. `LoggerOptions.logDir` overrides `VERIFIER_LOG_DIR`; relative paths resolve against the repository root, absolute paths are preserved, and an empty value uses the default. A missing or unreadable repository manifest is an explicit error, not a fallback to the working directory.
- Generic temporary workspaces default to `<os.tmpdir()>/forexplore-verification-workspaces/`; durable artifacts default to `<os.tmpdir()>/forexplore-verification-artifacts/attempt-*/`. These roots remain configurable. The receipt gives the exact durable relative path.
- E2E uses real FileUpload requests through the official service, retains canonical reports and compares mode, execution status, side assessments and expected problem codes. Expected answers are Host-only. See [e2e/README.md](e2e/README.md) for current result paths and CLI options. Status matching is not automatic confirmation that the Agent identified the intended bug.
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

Toolchains, dependency caches and network access affect runtime and can cause `unverified`. Agent-generated coverage and semantic adjudication are not independent acceptance testing. See [e2e/README.md](e2e/README.md) for configuration, fixtures, paths and exit semantics.
