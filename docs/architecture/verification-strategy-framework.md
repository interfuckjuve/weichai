# Verification Strategy Framework and V2 Integration Design

**Status:** Approved in design discussion  
**Date:** 2026-09-05  
**Scope:** `services/translation-verifier` and its production integration with `services/adaptation-service`

## 1. Context

`services/translation-verifier` currently exposes a single differential smoke workflow through
`runSmoke`. That workflow owns prompt construction, Claude process execution, temporary workspace
layout, controlled command execution, report parsing, evidence evaluation, and cleanup.

The next development phase needs to compare substantially different test-generation and behavior-
verification methods. A future method may use migrated source tests, generated properties,
metamorphic relations, or another process that does not resemble the current smoke workflow.
Therefore, the shared architecture must select and execute a strategy without prescribing the
strategy's internal phases or report schema.

The first production strategy remains the existing differential smoke implementation. The design
must also connect verification evidence to `AdaptationAdapterV2`, which owns bounded retranslation
after a confirmed translation failure.

## 2. Goals

1. Provide one stable entry point for code test generation and behavior verification.
2. Select a strategy by stable ID through a small static factory.
3. Let each strategy own its generation, execution, oracle, and detailed report format.
4. Return a stable result envelope containing normalized issues and strategy-specific output.
5. Use `differential-smoke` by default while allowing CLI and E2E strategy selection.
6. Reconstruct the initial verification workspace from V2 artifacts rather than production host paths.
7. Run generated tests in temporary directories on the adaptation-service host.
8. Integrate the selected verifier into the default V2 adaptation composition.
9. Let `AdaptationAdapterV2` perform at most two repair rounds from normalized verification issues.
10. Preserve per-round report, command, runner, patch-hash, and repair evidence.

## 3. Non-goals

The first delivery does not include:

- A second production verification strategy.
- A redesign of differential-smoke's internal evidence or case semantics.
- Dynamic plugin discovery, package loading, or a remote strategy registry.
- UI strategy selection or a client-controlled V2 `strategyId`.
- Container or remote execution.
- Reconstruction of complex projects with incomplete dependency and build facts.
- Automatic enablement of new source-target language pairs.
- A generic generator/executor/oracle pipeline imposed on all strategies.

## 4. Confirmed Design Decisions

- Use a thin orchestration service and a static provider factory.
- Keep `VerificationStrategy` coarse grained with one `verify` operation.
- Keep a stable result envelope and an arbitrary JSON-compatible `strategyReport` payload.
- The translator consumes normalized issues, not arbitrary strategy reports.
- `AdaptationAdapterV2` owns translation, verification, and repair orchestration.
- Production uses a fixed server-selected default strategy.
- CLI and E2E may select another registered strategy with `--strategy`.
- Execute on the adaptation-service host in a temporary workspace.
- Stop after `pass`, `warn`, or `unverified`; only `fail` can trigger repair.
- Permit no more than two repair rounds after the initial translation.
- Treat insufficient context for complex projects as `unverified` in the initial delivery.

## 5. Architecture

```text
AdaptationAdapterV2
  -> TranslationVerifierV2Adapter
  -> VerificationService.verify
  -> VerificationStrategyFactory.create(strategyId)
  -> VerificationStrategy.verify
  -> VerificationResult
  -> AdaptationAdapterV2 repair decision
  -> ValidationRecord and MigrationRunManifestV2 evidence
```

The dependency direction remains one way:

```text
@forexplore/contracts
       ^
@forexplore/workflow-core
       ^
@forexplore/translation-verifier
       ^
@forexplore/adaptation-service
       ^
VS Code Extension / HTTP adapters
```

The generic verification API remains in `@forexplore/translation-verifier`. The verifier reuses
`workflow-core`'s language-neutral `applyHunksStrict`, `newFileContent`, and canonical JSON helpers
instead of duplicating patch or content-addressing logic. Existing V2 wire artifacts and
`ValidationRecord` remain in `@forexplore/contracts`. The adaptation service imports the verifier
package through its public export and does not import verifier source internals.

## 6. Unified Input

```ts
export interface VerificationInput {
  schemaVersion: "1.0";
  request: AdaptationRequestV2;
  analysisReport: RepositoryIngestionJsonValue;
  migrationPlan: RepositoryIngestionJsonValue;
  translation: {
    round: number;
    generatedContent: string;
    files: FilePatch[];
    patchHash: string;
  };
}
```

`AdaptationRequestV2` already supplies the requirement, decision notes, exact route and validation
policy, execution lineage, selected candidate, `SourceImplementationBundleV2`, and
`TargetContextSnapshotV2`.

The service validates the request artifacts and patch hash before invoking a strategy. Production
input never adds source or target absolute paths to the V2 HTTP contract. CLI fixtures may start
from local paths, but a CLI input adapter must convert those paths to the same normalized input and
workspace shape before strategy execution.

## 7. Strategy Factory

```ts
export interface VerificationStrategy {
  verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationResult>;
}

export interface VerificationStrategyProvider {
  descriptor: {
    id: string;
    version: string;
    displayName: string;
  };
  create(): VerificationStrategy;
}

export class VerificationStrategyFactory {
  constructor(providers: VerificationStrategyProvider[]);
  create(strategyId: string): VerificationStrategy;
  list(): VerificationStrategyProvider["descriptor"][];
}
```

Provider closures capture strategy-specific dependencies. The factory does not know whether a
strategy uses an LLM, compiler, runner, property engine, or external process. It rejects duplicate
IDs during construction and rejects unknown IDs without falling back to the default.

The factory is immutable after construction. `create` returns a fresh strategy instance for each
run so mutable strategy state cannot leak between migrations.

The initial default registration is:

```text
differential-smoke@1.0.0 -> DifferentialSmokeStrategy
```

## 8. Verification Service and Runtime Context

`VerificationService` owns behavior common to every strategy:

1. Validate the normalized input.
2. Resolve the requested or configured default strategy ID.
3. Create a per-attempt temporary workspace.
4. Stage available source-bundle and target-context files.
5. Apply the generated patch only to the temporary target copy.
6. Create strategy, evidence, and result directories.
7. Invoke the strategy with an `AbortSignal` and deadline.
8. Validate and materialize the stable result envelope.
9. Persist registered artifacts.
10. Clean the temporary workspace after persistence.

`VerificationStrategyContext` exposes capabilities rather than mandatory phases:

```ts
export interface VerificationStrategyContext {
  workspace: {
    root: string;
    sourceRoot: string;
    targetRoot: string;
    strategyRoot: string;
    evidenceRoot: string;
  };
  deadlineAt: number;
  runCommand: ControlledCommandRunner;
  writeArtifact: VerificationArtifactWriter;
}
```

A strategy may ignore `runCommand` or any workspace area. The framework does not require compile,
run, case, runner, or mechanical-comparison concepts.

## 9. Unified Output

```ts
export interface VerificationResult {
  schemaVersion: "1.0";
  strategyId: string;
  strategyVersion: string;
  subjectHash: string;
  round: number;
  status: "pass" | "warn" | "fail" | "unverified";
  summary: string;
  issues: VerificationIssue[];
  artifacts: VerificationArtifact[];
  strategyReport: RepositoryIngestionJsonValue;
  createdAt: string;
  contentHash: string;
}

export interface VerificationIssue {
  id: string;
  /** Strategy-owned stable kind. Recommended common values include
   * behavioral-divergence, compile-failure, execution-failure,
   * insufficient-context, and invalid-evidence. */
  kind: string;
  message: string;
  caseId?: string;
  sourceObservation?: RepositoryIngestionJsonValue;
  targetObservation?: RepositoryIngestionJsonValue;
  evidenceArtifactIds: string[];
}

export interface VerificationArtifact {
  id: string;
  /** Strategy-owned stable kind; the framework does not interpret it. */
  kind: string;
  path: string;
  contentHash: string;
  mediaType: string;
}
```

`subjectHash` must equal the current translation patch hash. `contentHash` is calculated over the
canonical result without its own hash. Artifact IDs referenced by issues must exist in the result.
Issue and artifact kinds are open, strategy-owned stable strings; the framework documents common
values but does not maintain a closed enum. Large output, runner source, binary data, and logs remain
artifacts rather than inline report data.

Status semantics are strategy independent:

- `pass`: completed verification found no blocking behavior issue.
- `warn`: completed verification produced reviewable non-blocking evidence.
- `fail`: the strategy confirmed a target translation problem and supplied repair issues.
- `unverified`: the strategy could not establish a trustworthy result.

Only `fail` is eligible for automatic repair. A required `fail` or `unverified` validation record
continues to block write-back through the existing V2 validation gate.

## 10. Differential Smoke Adapter

`DifferentialSmokeStrategy` initially adapts the existing implementation rather than redesigning it:

```text
DifferentialSmokeStrategy.verify
  -> runSmoke in caller-owned workspace mode
  -> map SmokeResult to VerificationResult
  -> retain SmokeReport as strategyReport
```

The strategy owns all smoke-specific concepts, including dual runners, command evidence, cases,
mechanical verdicts, accepted differences, and source issues. None of these concepts enter the
factory or service contracts.

Existing `runSmoke` remains exported for compatibility with current tests and E2E callers. New V2
integration uses only `VerificationService`. Hardening or replacing smoke-specific evidence rules
is separate follow-up work and cannot block the strategy framework delivery.

## 11. CLI and E2E Selection

The generic command is:

```bash
npm run verify --workspace @forexplore/translation-verifier -- \
  --strategy differential-smoke \
  --input ./verification-input.json \
  --output ./verification-result.json
```

`--strategy` defaults to `differential-smoke`. `--list-strategies` prints registered IDs, versions,
and display names. Unknown strategies exit nonzero. `--keep-workspace` is available only to CLI and
E2E diagnostics; production always cleans temporary workspaces after durable artifact persistence.

The existing smoke E2E accepts the same `--strategy` selector and continues to support its existing
fixture options during the compatibility period.

## 12. V2 Adapter and Repair Loop

`TranslationVerifierV2Adapter` implements the adaptation service's behavior-verifier port. It maps
the V2 request, analysis, plan, current translation, patch, and patch hash to `VerificationInput` and
returns the full `VerificationResult` to `AdaptationAdapterV2`. It must not collapse the result to a
`ValidationRecord` before repair decisions are complete.

The translator gains a dedicated repair operation:

```ts
export interface MigrationRepairFeedbackV2 {
  round: number;
  inputPatchHash: string;
  issues: VerificationIssue[];
  validationRecordIds: string[];
  verificationArtifactPath?: string;
}

export interface MigrationTranslatorV2 {
  translate(/* existing arguments */): Promise<MigrationTranslationV2>;
  repair(
    input: MigrationEvidenceInputV2,
    analysis: MigrationAnalysisV2,
    plan: MigrationPlanV2,
    previous: MigrationTranslationV2,
    feedback: MigrationRepairFeedbackV2,
    signal?: AbortSignal,
  ): Promise<MigrationTranslationV2>;
}
```

The bounded loop is:

```text
initial translate (round 0)
  -> patch and compile
  -> verify and persist result
  -> pass/warn: finish
  -> unverified: stop blocked
  -> fail: repair if budget remains

repair round 1
  -> new patch/hash, compile, verify, persist
  -> same decision

repair round 2
  -> new patch/hash, compile, verify, persist
  -> always stop after evaluation
```

Compiler failures are normalized into `compile-failure` repair feedback when the compiler is
available and rejects generated code. Compiler unavailability remains `unverified` and does not
trigger speculative repair.

The maximum repair count is server-owned and fixed at two in the initial delivery. HTTP clients
cannot increase or disable it. The translator receives normalized issues and the durable report
reference, not an arbitrary strategy report schema.

Each repair round records its input patch hash, output patch hash, trigger validation IDs, translator
provider, verifier result artifact, and timestamp. The final `AdaptationResultV2` and
`MigrationRunManifestV2` must preserve enough structured repair history to reconstruct all rounds;
no intermediate failure may be represented only in logs.

## 13. Production Runtime Capability

The default adaptation-service composition constructs:

1. The default strategy factory.
2. `VerificationService` with `differential-smoke` as its default.
3. `TranslationVerifierV2Adapter` with the existing differential verifier provider identity.
4. `AdaptationAdapterV2` with that verifier injected.

The behavior-validation stage may then report local execution as available for its exact registered
routes. Capability metadata must describe local-process execution accurately and must not claim
container or remote isolation.

This integration removes the current mismatch where the runtime inventory names
`forexplore.translation-verifier.differential` but the default server injects no implementation.
It does not bypass unrelated V2 blockers such as missing authoritative artifacts, stale catalog
lineage, unavailable target engineering, compilation, workspace apply, or rollback. Exact route
availability remains the aggregate of every required stage.

## 14. Workspace and Artifact Lifecycle

Each verification attempt receives a unique temporary workspace on the adaptation-service host.
Source-bundle files retain their normalized relative paths. The target starts from the complete
target-context source file, and the current patch is applied only to its temporary copy.

For the initial self-contained-function scope, missing dependency or build context produces
`unverified` with an `insufficient-context` issue. The service does not invent Maven, npm, Cargo,
Go, Python, or .NET project metadata and does not fetch undeclared dependencies.

Strategies register artifacts through the provided writer. Before cleanup, the service:

- rejects absolute paths and traversal;
- enforces per-file and total size limits;
- computes SHA-256 hashes;
- verifies every issue artifact reference;
- writes the result atomically into a configured durable artifact root;
- records the durable relative result path for V2 validation evidence.

Production always cleans temporary workspaces after persistence. Abort and persistence failures also
run bounded cleanup. Prompt text, source content, credentials, and unrestricted stdout remain absent
from default logs.

Local execution is not a security sandbox. Generated runners and translated code execute with the
adaptation-service OS user's permissions. Existing command allowlisting, sanitized build environment,
deadline, bounded output, process-tree termination, and workspace baseline controls remain required.

## 15. Error Semantics

| Condition | Result |
| --- | --- |
| Duplicate provider ID | Factory construction error |
| Unknown strategy ID | Selection error; no default fallback |
| Invalid V2 artifact or patch hash | Invalid input error before execution |
| Strategy cannot handle available context | `unverified: strategy-input-unsupported` |
| Strategy exception | `unverified: strategy-execution-error` |
| Deadline exceeded | `unverified: strategy-timeout` |
| Caller cancellation | Original `AbortError` is rethrown |
| Invalid result envelope | `unverified: invalid-strategy-result` |
| Artifact persistence failure | `unverified: artifact-persistence-failed` |
| Confirmed translation behavior defect | `fail` with repairable issues |

The framework validates only strategy-independent envelope invariants. It never interprets or repairs
the strategy-specific payload.

## 16. Testing Strategy

### Framework tests

- Default and explicit strategy selection.
- Provider listing and duplicate/unknown ID rejection.
- Fresh strategy instance creation for each run.
- Input and result-envelope validation.
- Temporary workspace staging and cleanup.
- Artifact path, size, hash, and reference checks.
- Timeout, cancellation, and invalid-result normalization.

### Strategy compatibility tests

- Existing `runSmoke` is invoked through `DifferentialSmokeStrategy`.
- `SmokeReport` remains the strategy payload.
- Existing `runSmoke` API and E2E options remain compatible.

### V2 integration tests

- The default server injects the registered behavior verifier.
- Runtime capability reports the actual local verifier without removing unrelated blockers.
- A fake strategy returns `fail`; the translator receives normalized issues and repairs once.
- A repaired patch gets a new patch hash and is recompiled and reverified.
- `pass` and `warn` stop immediately.
- `unverified` blocks and never invokes repair.
- Two failed repair rounds exhaust the budget and preserve all round evidence.
- Validation records and run-manifest repair records bind the exact patch and artifact hashes.

### Local E2E

A self-contained TypeScript-to-Python fixture exercises temporary staging, the default strategy,
real local execution, result persistence, and cleanup. Network/model-backed E2E remains explicitly
separate from deterministic local acceptance tests.

## 17. Delivery Sequence and Checkpoint

The first implementation checkpoint is the smallest runnable vertical slice:

1. Public input/result/issue/artifact types in `translation-verifier`.
2. A package dependency on `@forexplore/workflow-core` for strict patch application and canonical JSON.
3. Static provider factory.
4. `VerificationService` with temporary workspace ownership and result validation.
5. `DifferentialSmokeStrategy` adapter over existing `runSmoke`.
6. CLI strategy selection and factory/service tests.

After this slice runs and its focused tests pass, implementation stops for user confirmation as
required by the repository delivery process.

Only after confirmation does implementation continue with:

1. Adaptation-service dependency and `TranslationVerifierV2Adapter`.
2. Default runtime capability composition.
3. Translator repair API and two-round loop.
4. Durable per-round artifacts and V2 repair lineage.
5. Cross-workspace integration and local E2E verification.

## 18. Acceptance Criteria

The complete feature is accepted when:

1. A test can register two fake strategies and select either with the same input and output envelope.
2. The CLI can list and select registered strategies without code changes.
3. The existing differential smoke behavior runs through the new entry point.
4. Strategy-specific fields do not leak into the factory or service contracts.
5. The default V2 adaptation composition injects the differential strategy implementation.
6. A behavior `fail` reaches translator repair as normalized issues.
7. No more than two repair rounds execute, and every round has patch and report lineage.
8. `unverified` never triggers repair and blocks write-back.
9. V2 capability output remains truthful about local execution and unrelated unavailable stages.
10. Existing package tests and builds pass, plus new focused framework, adapter, repair-loop, and E2E
    tests.
