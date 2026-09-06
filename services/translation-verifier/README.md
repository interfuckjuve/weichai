# translation-verifier

A strategy-based verification framework with a differential smoke implementation. The smoke strategy uses one autonomous Claude session to inspect staged source and target projects, design cases, write runners, execute them through the controlled `verifier-command` proxy, and report behavioral differences.

Differential verification detects discrepancies; it is not proof of business correctness. Host checks cover execution evidence, workspace baselines, and report structure. Semantic case decisions still come from the agent.

## V2 Integration

The V2 `MigrationBehaviorVerifierV2` provider is registered and enabled in the adaptation runtime. `TranslationVerifierV2Adapter` delegates to the default `VerificationService`, whose only statically registered strategy is `differential-smoke@1.0.0`. Strategy selection belongs to the server, not HTTP clients or the UI. Unknown strategy IDs fail explicitly without fallback.

`AdaptationAdapterV2` owns the migration repair loop, with at most two repair rounds. Each round produces a new patch and fresh validation. A required `unverified` check stops repair and blocks write-back; compilation success alone is not behavioral evidence.

Execution is `local-process` on the adaptation-service host, not a security sandbox. Production isolation must be supplied by an external runtime or container boundary.

## Verification and Artifact Lifecycle

```ts
createDefaultVerificationService(options?).verify(input, { strategyId?, keepWorkspace? }, signal)
createDefaultVerificationService(options?).verifyWithReceipt(input, { strategyId?, keepWorkspace? }, signal)
```

- `VerificationInput` carries the `AdaptationRequestV2`, analysis report, migration plan, and translation patch envelope.
- `VerificationResult` binds strategy ID/version, patch subject hash, round, status, issues, artifacts, strategy report, and content hash.
- `verifyWithReceipt` persists the canonical result bytes once and returns their exact ID, durable relative path, SHA-256, byte size, and media type. The framework does not retry failed persistence or emit synthetic artifact metadata.
- Source lookup, stat/read, symlink, permission, destination, and artifact budget failures become `VerificationArtifactPersistenceError`. The service returns `unverified` with `artifact-persistence-failed`, no result artifact, and no strategy artifact references.
- Strategy artifacts and the framework result share a cumulative **10 MiB per-attempt** budget. Both the preliminary file size and actual bytes read are checked; result bytes consume the same budget.
- The workspace assigns attempt-specific durable paths and strategy artifact IDs. Strategies must use the returned references, including IDs, when constructing issues and results.
- Abandoned attempts discard their durable artifacts without deleting other attempts. Successfully receipted `fail` and `unverified` results retain real evidence for audit and repair. `keepWorkspace` preserves staged files for diagnosis, not abandoned durable evidence.
- Final validation artifacts and all repair artifact references are merged into manifest `artifactPaths`. Canonical validation requires exact ID/path bindings and rejects conflicting hashes. The VS Code host references verifier-owned artifacts; it does not invent local copies.
- Invalid inputs, unknown strategies, and workspace creation errors throw. Any strategy/provider/caller `AbortError` propagates unchanged; `TimeoutError` becomes an `unverified` timeout result.

## Smoke Execution

Default mode is `verify-only`:

- Source and target snapshots remain unchanged; `rounds === 0` and `targetFiles` is empty.
- Smoke reports translation bugs; the external migration workflow owns target repairs.
- Runners compile and execute only through `verifier-command`, with command allowlists, baseline checks, a minimized environment, evidence logging, and process-tree termination.
- The host validates `report.json`, checks the baseline again, reads bounded command evidence, and evaluates `pass`, `fail`, or `unverified`.

Legacy repair experiments require explicit `mode: "diagnostic-repair"` and are intended only for diagnostic E2E runs.

```ts
runSmoke(job: SmokeTaskInput, options?: SmokeRunOptions, signal?: AbortSignal): Promise<SmokeResult>
```

`SmokeTaskInput` includes the requirement, optional analysis report, source language/project/files, and target language/project/file/symbol. `SmokeRunOptions` accepts a complete caller-owned workspace set (`workspaceDir`, `executionRoot`, `baselinePath`, `commandEvidencePath`, `runnerRoots`), or an internal fixture workspace. It also supports `mode`, `keepGeneratedTests`, model/API settings, timeout, `maxTurns` (default 50), and test-only `spawnClaude` injection.

`SmokeResult` uses `pass | fail | error`. An unverified evaluation maps to `error`, retaining its evaluation or an `errorReason` such as `invalid-report`, `invalid-evidence`, `timeout`, `toolchain`, or `internal`. Caller-owned workspaces remain the caller's responsibility; internal smoke workspaces follow `keepGeneratedTests`.

## Modules

| Module | Responsibility |
| --- | --- |
| `verification-cli.ts` | Generic input/output CLI and strategy listing |
| `default-verification-service.ts` | Static default strategy registration |
| `verification-service.ts`, `verification-strategy-factory.ts` | Strategy orchestration, timeout/cancellation, receipts |
| `verification-workspace.ts` | Staging, patch application, durable artifact persistence and cleanup |
| `verification-types.ts` | Input, result, descriptor, and receipt validation |
| `strategies/differential-smoke/strategy.ts` | Framework-to-smoke mapping and context preflight |
| `strategies/differential-smoke/runner.ts` | Verify-only execution and evidence evaluation |
| `strategies/differential-smoke/prompts/task.ts` | Verify-only and diagnostic task prompts |
| `strategies/differential-smoke/helpers.ts`, `workspace.ts` | Tool constraints and internal workspace lifecycle |
| `strategies/differential-smoke/report.ts`, `report-schema.ts` | Bounded report reading and deep schema validation |
| `strategies/differential-smoke/workspace-baseline.ts` | Request-level protected-file baseline |
| `strategies/differential-smoke/verifier-command.ts`, `process-tree.ts` | Controlled execution, environment, evidence, process cleanup |
| `strategies/differential-smoke/evaluation.ts` | Pure smoke outcome policy |
| `strategies/differential-smoke/claude-client.ts`, `logger.ts` | Claude process integration and bounded, redacted logging |

## Commands

Run from the repository root:

```bash
npm run test --workspace @forexplore/translation-verifier
npm run build --workspace @forexplore/translation-verifier
npm run verify --workspace @forexplore/translation-verifier -- --list-strategies
npm run verify --workspace @forexplore/translation-verifier -- \
  --strategy differential-smoke --input /path/to/input.json --output /path/to/result.json

# Offline entry-point check only; no autonomous-session replay is available.
npm run e2e --workspace @forexplore/translation-verifier -- --offline-only

# Real Claude diagnostic session; requires credentials and local toolchains.
DEEPSEEK_API_KEY=sk-xxx npm run e2e --workspace @forexplore/translation-verifier -- --timeout-ms 600000

# Verify-only session with complete local dependency fixtures.
DEEPSEEK_API_KEY=sk-xxx npm run e2e --workspace @forexplore/translation-verifier -- --verify-only --timeout-ms 600000

# Local dependency fixture builds, subject to installed tools and dependency caches.
mvn -q -f services/translation-verifier/e2e/fixtures/dependencies/maven/pom.xml test
dotnet build services/translation-verifier/e2e/fixtures/dependencies/dotnet/DependencyFixture.sln --nologo -v q
```

See [e2e/README.md](e2e/README.md) for fixtures and exit codes. `--offline-only` exits successfully after checking the entry point; it does not execute real model verification.

## Logging and Limits

File logging defaults to INFO, without prompts, source, or raw output. Enable the content channel explicitly with `VERIFIER_LOG_CONTENT=1`. Entries are redacted before writing. Log rotation defaults to 10 MiB per file and three retained files; this is separate from the verification artifact budget.

Known boundaries:

- Same-user local execution is not isolation. Baseline checks cannot detect a protected file changed and restored within one command.
- Build tools may access external dependency repositories; network and cache state affect results. Toolchain failures remain unverified.
- The host does not independently recompute every semantic case decision from stdout. Runner coverage and semantic adjudication depend on the agent.
- File-system checks do not provide kernel-level protection against concurrent malicious mutation, process crashes, or storage failure. Durable artifacts require operational storage permissions and retention management.
- Autonomous sessions can take minutes. The default timeout is 300 seconds; increase it for larger projects.
