# Smoke E2E

`run-smoke-e2e.ts` executes one real autonomous Claude session through the private smoke strategy. The wrapper currently accepts only `differential-smoke`; it is not a generic benchmark runner. Other experiments in this directory have their own entry points and are not executed by `npm run e2e`.

## Modes and Fixtures

| Mode | Flag | Fixture and policy |
| --- | --- | --- |
| `diagnostic-repair` | Default | MimeUtility C# source and Java translation under `fixtures/samples`; allows reporting proposed target repairs for diagnosis |
| `verify-only` | `--verify-only` | Complete .NET solution and Maven reactor under `fixtures/dependencies`; read-only project snapshots, no target repairs |

The service and direct `runSmoke()` default to verify-only. Only this historical E2E wrapper defaults to diagnostic-repair. In both modes the actual project roots remain read-only; proposed diagnostic repairs are not an authorization to modify user projects.

Verify-only requires `rounds === 0`, empty `targetFiles`, nonempty cases, runners for both sides and mandatory compile/run evidence. Command IDs must match the actual controlled-proxy evidence. A generated report is not enough to bypass these checks. Insufficient semantic evidence remains `unclear`/`unverified`.

Fixtures:

- `fixtures/smoke-mime-util/requirement.txt`: diagnostic task requirement.
- `fixtures/samples/mime-util-source.cs`, `mime-util-target.java`: diagnostic source/target samples.
- `fixtures/dependencies/dotnet/`: solution with `Library` and `App`, using `ProjectReference`.
- `fixtures/dependencies/maven/`: reactor with `library` and `app`, using a sibling module dependency.

Local fixture builds use installed tools and available dependency caches; they are not guaranteed network-free:

```bash
mvn -q -f services/translation-verifier/e2e/fixtures/dependencies/maven/pom.xml test
dotnet build services/translation-verifier/e2e/fixtures/dependencies/dotnet/DependencyFixture.sln --nologo -v q
```

## Configuration

Run from the repository root. Real runs require `claude`, `npx`/`tsx`, the relevant toolchains and a configured `DEEPSEEK_API_KEY`. The CLI connects through the existing DeepSeek Anthropic-compatible environment configuration; `DEEPSEEK_MODEL` defaults to `deepseek-v4-flash`. `JAVA_HOME` is forwarded when set. The wrapper uses at most 40 turns.

```bash
# Entry-point check only: skips the model, does not replay verification.
npm run e2e --workspace @forexplore/translation-verifier -- --offline-only

# One real verify-only run; ensure credentials and local tools are configured first.
npm run e2e --workspace @forexplore/translation-verifier -- --verify-only --timeout-ms 600000

# Machine-readable result stdout; timing directory information is on stderr.
npx tsx services/translation-verifier/e2e/run-smoke-e2e.ts --verify-only --json --timeout-ms 600000

# Explicit local unit tests for the wrapper/timing helper; no model calls.
npx vitest run services/translation-verifier/e2e/smoke-e2e-timing.test.ts
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--fixture-dir <path>` | `e2e/fixtures/smoke-mime-util` | Diagnostic requirement directory; sibling `samples` supplies source/target. Ignored by verify-only, which uses `fixtures/dependencies`. |
| `--api-key <key>` | `DEEPSEEK_API_KEY` | Optional credential override; prefer environment configuration to avoid shell-history exposure. |
| `--timeout-ms <ms>` | `300000` | Single Claude session timeout. |
| `--strategy <id>` | `differential-smoke` | Only this E2E strategy is supported; unknown IDs fail explicitly. |
| `--verify-only` | Off | Use complete dependency fixtures and enforce no target repairs. |
| `--offline-only` | Off | Skip the real session and exit zero; not behavioral verification. |
| `--json` | Off | Print the original complete `SmokeResult` JSON, without prose or timing fields in stdout. |

## Outputs and Exit Codes

The wrapper keeps the existing workspace at `services/translation-verifier/test-results/smoke-*/` and displays its path. Available content includes `source/project/`, `target/project/`, both `.forexplore-tests/` runner areas, `baseline.json`, `agent/report.json` and `agent/commands.jsonl`. Failures may leave only some of these files.

A small `timing.json` and `timing.md` are written in that same `smoke-*` directory, best-effort. They contain strategy/version, model, mode, fixture ID, total duration, dynamic Host spans, approximate Agent task occurrences, authoritative controlled-command durations and omission diagnostics. They never include raw source, prompts, tool payloads or command stdout/stderr. Timing output failure cannot change the result or exit code. The helper is not a production run storage system; `runRoot`, `debug`, `onRunRecorded` are reserved, ignored service options.

| Exit | Meaning |
| --- | --- |
| `0` | A non-error report was produced and verify-only invariants hold. A `fail` finding still returns zero: the detector successfully reported a discrepancy. Also used for explicit offline skip. |
| `1` | Smoke status is `error`, or verify-only report invariants fail. |
| `2` | Invalid arguments, missing key or an uncaught runner exception. |

## Timing Caveats

The Agent emits `[VERIFIER_STEP]` start/end markers as standalone assistant text for tasks it actually performs, including repeated work and `finalize-report`. The final end marker is allowed after writing `report.json`, before stopping. The parser ignores thinking/tool output/fenced snippets, deduplicates partial text against assistant snapshots by message/block identity and never replays buffered stdout as live timestamps.

Agent intervals are approximate Host receipt times (`agent-step-approximate`, `host-performance`), not model clocks. Missing starts/ends have no invented duration; absent telemetry remains unavailable. The parser drains overflow with explicit omission diagnostics: 1 MiB stream lines, 4 KiB text lines, 10,000 events and bounded message/block state. Transport buffering can collapse intervals to zero.

Controlled-command process durations use their own `Date.now()` interval; proxy subspans use its child `performance.now()` clock. Host, Agent and command intervals can overlap or include each other. **Do not sum them.** Markers are not evidence of command execution. Available command timing can be retained after missing reports/session failures without satisfying mandatory evidence checks.

Default logging under repository `logs/` excludes full content. `VERIFIER_LOG_CONTENT=1` separately enables bounded, redacted content logging. No automatic raw `PostToolUse` hook or `claude-steps.jsonl` telemetry subprocess is installed.

This is local-process execution, not a sandbox. Dependency/network/cache state affects results. A single run is not a performance ranking, independent acceptance test or proof of business correctness. Compare alternative registered strategies through the generic service with identical inputs and explicit configuration, not by forcing their private steps to match smoke.
