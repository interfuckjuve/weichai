# translation-verifier

A replaceable strategy baseline for translation verification: generic input -> registered strategy -> identified output. The default `differential-smoke@1.0.0` strategy uses one autonomous Claude session to inspect source/target snapshots, design cases, write runners, and compare observed behavior. It is a rough comparison baseline, not proof of business correctness.

## Public Contract

```ts
createDefaultVerificationService(options?).verify(input, { strategyId?, keepWorkspace? }, signal)
createDefaultVerificationService(options?).verifyWithReceipt(input, { strategyId?, keepWorkspace? }, signal)
```

`VerificationInput` carries the adaptation request, analysis report, migration plan and translation patch. `VerificationResult` binds strategy ID/version, patch subject hash, round, status, issues, artifacts and a strategy-owned report. `verifyWithReceipt()` persists the canonical result once and returns its exact durable relative path, SHA-256, byte size, ID and media type. Timing observations do not change results, receipts, hashes or verdicts.

The framework has three external phases: **validate input**, **execute strategy**, **save report**. Strategy internals are arbitrary, repeatable and may use no Agent. There is no central six-stage smoke workflow. See [docs/flow.md](docs/flow.md) for ownership and execution flow.

The V2 adaptation runtime uses `TranslationVerifierV2Adapter` and the default service. Strategy selection belongs to the server, not HTTP clients or the UI. Unknown strategy IDs fail without fallback. `AdaptationAdapterV2` owns the migration repair loop, with at most two repair rounds; required `unverified` checks stop repair and block write-back.

## Register and Compare Strategies

Register providers in the existing factory; each provider creates a strategy with `verify(input, context, signal)`. No Agent or step list is required. A minimal registration-only example deliberately returns `unverified`, not a fabricated pass:

```ts
import {
  VerificationService, VerificationStrategyFactory,
  type VerificationStrategyProvider,
} from "@forexplore/translation-verifier";

const provider: VerificationStrategyProvider = {
  descriptor: { id: "my-check", version: "1.0.0", displayName: "My Check" },
  create: () => ({
    async verify(_input, _context, signal) {
      signal?.throwIfAborted();
      return {
        status: "unverified", summary: "No verification implemented.",
        issues: [], artifacts: [], strategyReport: {},
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

The service and `runSmoke()` default to **verify-only**. Source/target project snapshots remain read-only, report `rounds` must be zero and `targetFiles` empty. Runner repairs are allowed, target implementation repairs belong to the external translator. Smoke checks report shape, mandatory command evidence and final file baseline before returning a decisive result. Evidence-insufficient decisions remain `unclear`/`unverified`. Compilation success and model self-assessment do not prove business semantics.

Commands run only through the controlled proxy. It applies command/path restrictions, baseline checks, a credential-minimized build environment, bounded output, deadlines and process-tree termination. This is **local-process execution, not a security sandbox**. External isolation is required for hostile code. Same-user mutation and changing/restoring protected files within one command are not prevented by a kernel boundary.

Artifact persistence preserves the existing cumulative **10 MiB per-attempt** budget, including canonical result bytes. Path/symlink/read/write/budget failures fail closed with `artifact-persistence-failed`, no synthetic receipt and no retained references from the abandoned attempt. Successful `fail`/`unverified` receipts retain real evidence. Cleanup does not delete another attempt's artifacts. Invalid input, unknown strategies and workspace creation errors throw; `AbortError` propagates unchanged, while strategy timeout becomes `unverified`.

## Outputs and Timing

- Generic temporary workspaces default to `<os.tmpdir()>/forexplore-verification-workspaces/`; durable artifacts default to `<os.tmpdir()>/forexplore-verification-artifacts/attempt-*/`. These roots remain configurable. The receipt gives the exact durable relative path.
- Direct smoke E2E keeps `<package>/test-results/smoke-*/`, containing staged projects, dedicated runner areas, `baseline.json`, `agent/report.json` and `agent/commands.jsonl` where produced. Caller-owned smoke layouts remain caller-owned.
- E2E writes `timing.json` and `timing.md` in that same kept `smoke-*` directory, best-effort. The output includes strategy/version, model, mode, fixture, total time, dynamic Host spans, approximate Agent intervals and controlled-command timings. It contains no source, prompt, tool payload or raw command output. Timing write failures never alter the verdict/exit code. `--json` stdout stays the original `SmokeResult` JSON; directory diagnostics go to stderr.
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
