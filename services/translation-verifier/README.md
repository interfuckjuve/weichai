# Translation Verifier

`translation-verifier` checks whether translated target functions preserve the required behavior, or verifies target functions directly against supplied requirements when no reliable source mapping exists. The Agent first runs all existing tests in its dedicated test folder, repairs stale tests where justified by changed source APIs or declared contracts, and then adds meaningful tests for every upstream target function. The Agent ends a call by answering without a tool call, and the Host then reruns the entire folder and validates the Agent's conclusion before returning a normalized result.

## Project Access

The verifier has separate Host-controlled project roots:

- `sourceProjectPath` is read-only. It may point to the original source project or to another read-only checkout containing the source reference.
- `targetProjectPath` is the writable target project. It must be a Git worktree created by the upstream workflow for this verification run. Do not pass the original protected target project path.

The Agent receives project-relative paths only. It cannot choose an arbitrary working directory, test command, executable, or test runner.

Source tools can read and list files under the source project. Target tools can read and list files under the target project. The Agent can create or update tests only inside one stable `translation-verifier` subfolder of the framework's first test source directory. Both test tools can run existing files in that folder, including files from earlier verification attempts; files do not need to be created or modified during the current Agent run. The Host selects the fixed test command.

| Environment | Dedicated Agent folder |
| --- | --- |
| Maven / Gradle | `src/test/java/translation-verifier`, or `<first-configured-test-source>/translation-verifier` |
| pytest | `tests/translation-verifier`, or `<first-testpaths-entry>/translation-verifier` |
| Jest / Vitest | `tests/translation-verifier`, or `<first-configured-test-source>/translation-verifier` (for example `checks/translation-verifier`) |
| Existing C# test project | `<test-project-directory>/translation-verifier` |
| Generated Maven harness | `.translation-verifier-tests/maven/src/test/java/translation-verifier` |
| Generated C# harness | `.translation-verifier-tests/dotnet/tests/translation-verifier` |

Test resource directories and other configured source roots are not writable Agent roots. Configured source directories must already exist; missing standard defaults are created with their dedicated child. Project-wide Node roots such as `.` or `<rootDir>` fall back to `tests`; Vitest include globs use the literal directory prefix before the first glob segment. Directory links, including links in ancestor paths, are rejected. Generated tests, harnesses, and reports are retained when the environment closes, so resolving it again exposes the same existing tests. The generated harness configurations have stable paths (`.translation-verifier-tests/maven/pom.xml` and `.translation-verifier-tests/dotnet/AgentTests.csproj`) and are reused. The caller still owns the lifetime of the target workspace; parallel verification runs in the same workspace are unsupported.

## Upstream Input

The upstream workflow passes a focused `VerificationInput` directly to the verifier. The verifier does not accept or read a `Request` object.

```ts
export type VerificationInput = {
  schemaVersion: "2.0";
  sourceLanguage: string;
  targetLanguage: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  subject: {
    sourceFunction: {
      path: string;
      name: string;
      signature?: string;
    };
    targetFunction: {
      path: string;
      name: string;
      signature?: string;
    };
    requirement: string;
  };
  analysisReport: AnalysisReport;
  migrationPlan: JsonValue;
  translation: Translation;
};
```

`subject.sourceFunction.path` must be a project-relative path under `sourceProjectPath`. `subject.targetFunction.path` must be a project-relative path under `targetProjectPath`. The function paths are also used to select the initial directories exposed by `list_source_files` and `list_target_files`; no separate source or target code-path arrays are required.

`analysisReport`, `migrationPlan`, and `translation` are supporting evidence from the upstream Analyzer and Translator. They do not grant additional file or command access.

The `single-agent` strategy passes only task context and selects the tool capabilities it needs. It does not provide tool descriptions, project roots, test roots, runners, or executables.

The Host resolves that task context into an internal runtime context before binding tools. Each tool factory returns one native LangChain `tool(fn, { name, description, schema })` bound to that run: the argument schema is a Zod object, so the framework validates and serializes tool input itself. Domain rules stay Host-owned inside the tool body: project-relative paths, the authorized test roots, the text-file size limit, and the fixed test command are never model-selectable. Each tool owns its description template and renders language, logical path, test-root, and runner details from the injected runtime context. Absolute project paths and executable configuration remain Host-only.

Cross-cutting tool behavior lives in one framework middleware (`wrapToolCall`): one log event per call, serialized access to the shared target directory, the bounded model-visible test observation with the complete result kept as the `ToolMessage` artifact and in the trace, and a fatal path for budget, context and cancellation failures. Recoverable domain refusals and schema rejections come back as framework tool messages on the same `tool_call_id`, so the Agent can correct itself without a Host-side tool loop.

## Calling the Verifier

Create a LangChain `BaseChatModel` for the configured provider, wrap it in the Host, then create the public runner:

```ts
const host = createLangChainAgentHost({
  model: createTranslationVerifierChatModel({
    apiKey: () => process.env.DEEPSEEK_API_KEY ?? "",
    // Optional: defaults to the standard DeepSeek endpoint and model.
    apiBase: process.env.DEEPSEEK_API_BASE,
    model: process.env.DEEPSEEK_MODEL,
  }),
});

const verify = createVerifier(host);

const result = await verify(input, "single-agent", "verify");
```

`createLangChainFunctionGroupAgentHost` provides the same loop for translation-fidelity and requirement function groups. Both Hosts use LangChain `createAgent` with framework tools and an in-run `MemorySaver` thread, so model calls, tool dispatch and message history belong to the framework. The Host keeps only the application cycle: invoke the Agent, revalidate the complete dedicated folder, append feedback to the same session, and invoke again.

The public result is always normalized to:

```ts
type VerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
  targetFunction?: {
    name: string;
    executed: boolean;
    lineCoverage: number | null;
    branchCoverage: number | null;
  };
};
```

The Agent ends a call with an ordinary assistant message containing a JSON report with `verdict` (`no-bug`, `bug-found` or `uncertain`) and a non-empty `summary`. A `no-bug` report carries no issue; `bug-found` carries a concrete `translation` issue and the affected requested targets; `uncertain` carries an `unknown` issue that names the unresolved contract or missing semantic evidence. There is no terminal tool, no structured-output tool and no forced continuation after a text-only answer.

The report is a candidate conclusion. After every natural ending the Host reruns the complete dedicated folder and applies one acceptance matrix to all three modes:

| Agent verdict | Host observation | Outcome |
| --- | --- | --- |
| `no-bug` | complete suite compiled and passed, no skips, every requested target executed | `status: "success"` |
| `bug-found` | valid failing assertion, execution evidence for the named targets, other targets may stay unverified | `status: "failure"` with a `translation` issue |
| `uncertain` | complete suite passed with execution evidence for every target and a concrete ambiguity | `status: "failure"` with an `unknown` issue |
| any | compile/collection/setup error, timeout, zero executed tests, skipped tests, stale reports, missing or contradictory evidence | not accepted; feedback continues in the same session or the run fails operationally |

A `no-bug` success additionally requires fresh Host coverage that identifies the requested target function as executed; function groups require Host evidence for **every** requested target. Every test must compile even when reporting a production defect; failing requirement assertions may remain and must produce a failure report rather than being weakened to fit the implementation. The Agent cannot provide or override test counts or coverage values. Percentages do not have a minimum threshold; `null` indicates no measurable lines or branches, and `null` is not zero coverage.

## Baseline and Final Suite

At the start of a run, the Agent inspects its dedicated folder and runs all existing tests by omitting `path` from `run_target_tests` or `paths` from `run_function_group_tests`. An empty folder is the only case where it proceeds directly to authoring tests. Existing tests should pass with no skipped tests before new cases are added. When they do not, the Agent diagnoses compilation errors, stale fixtures or expectations, and real production regressions. Changed source APIs or declared contracts can justify rewriting tests; implementation behavior alone cannot justify erasing a valid requirement assertion. Actual requirement defects remain failing evidence even when they prevent a passing baseline.

After adding or updating tests for every listed target, the Agent ends the call with its JSON report. The Host then discovers the dedicated folder using framework naming conventions and test annotations, runs the complete selection together, and collects current test counts and per-function coverage. A separate full-suite run immediately before the final message is unnecessary, and the Host never trusts an earlier run. Every test must compile and execute without skips; assertions exposing production bugs may fail.

Unmet completion conditions are appended to the same session as a new user feedback message that carries the fresh observation, failed test cases, per-function coverage, diagnostics and `reportPaths`. The Agent keeps its earlier messages, tool results and report, repairs the same tests in the same working directory, and ends again. Compilation, collection, runner errors, skipped tests, missing coverage, a conclusion contradicted by the fresh result, or an invalid report all produce this feedback. The feedback budget and the model/tool/time budgets are cumulative across rounds; running out of feedback rounds is an operational failure, not a production defect. Invalid tool arguments or infrastructure exceptions are returned as tool errors; cancellation and exhausted budgets end the run.

The Host computes each round's observation from that round's execution and keeps no history ledger: no failure ledger, immutable test snapshots, revision history, correction metadata, or correction reviewer. Framework reports and optional diagnostic logs remain available. Existing public `testEvidence` type fields remain deprecated because callers may read older stored results; incoming legacy metadata is ignored and current verification never emits it.

## Target Function Coverage

The task's target function identity (path, name, and optional signature) is bound by the Host. Before binding Agent tools, the Host injects a fixed test runner. `run-target-tests.ts` and `run-function-group-tests.ts` export the execution functions shared by their Agent tool wrappers and Host revalidation. These functions obtain authorized test selections from the runner and execute them. Revalidation calls the same functions with paths omitted to require the complete dedicated folder.

```text
Host revalidation (after every natural Agent ending)
  -> runTargetTests / runFunctionGroupTests (also used by Agent run tools)
  -> test-runner.ts: path selection, process execution, report collection
  -> coverage-reports.ts: test counts and per-function coverage parsing
```

`test-runner.ts` owns directory expansion, file selection, fixed framework commands, shared process execution with timeout/output limits, and report collection for all six runners. Reports remain at framework-default locations; the Host cleans only its temporary Gradle init script. `coverage-reports.ts` owns report parsing, including JaCoCo shared by Maven and Gradle. Tool results include test counts and either available method coverage or an explicit unavailable reason; model-visible stdout/stderr/failure messages are bounded while the trace keeps the complete observation. The final public coverage always comes from the last Host revalidation, and function ordering follows the requested input order.

Maven uses JaCoCo coverage. The Host uses pinned JaCoCo 0.8.13 prepare-agent/report goals around the selected Surefire test. It leaves the default build and reporting directories intact, sets `-Djacoco.append=false` to replace execution data for the current run, and reads `target/site/jacoco/jacoco.xml` and `target/surefire-reports/TEST-*.xml`. Custom report directories and multi-module aggregation are not yet supported; missing or unchanged reports prevent successful verification. Maven may need to download JaCoCo from its configured repository on the first run.

Function matching uses the Java package, source filename, method name, and optional JVM descriptor or ordinary Java parameter signature. Ambiguous identities and unsupported signatures return unavailable evidence rather than selecting a different method. The other runners also collect fresh test counts and function coverage:

| Runner | Host-controlled execution and reports | Project requirement |
| --- | --- | --- |
| Gradle | `test --tests *.TestClass jacocoTestReport --init-script <host-script> --rerun-tasks --no-build-cache`; `build/test-results/test/TEST-*.xml` and `build/reports/jacoco/test/jacocoTestReport.xml` | A single root Java project, Gradle wrapper or installed Gradle; the Host applies/configures JaCoCo 0.8.13 through a temporary init script |
| pytest | `python -m pytest <test-path> --cov=<project> --cov-branch --cov-report=json --junitxml=tests.xml`; default `.coverage`, `coverage.json`, and `tests.xml` in the project root | pytest and pytest-cov installed, preferably in project `.venv`; Host uses Python AST to identify the function body |
| Jest | `npm test -- --runInBand --runTestsByPath <test-path> --roots=<project> --coverage --collectCoverageFrom=<target-path> --coverageReporters=json --json --outputFile=tests.json`; `coverage/coverage-final.json` | Working Jest test script; Host includes the project root so unimported target files get zero coverage |
| Vitest | `npm test -- --run <test-path> --coverage --coverage.include=<target-path> --coverage.reporter=json --reporter=json --outputFile=tests.json`; `coverage/coverage-final.json` | Working Vitest test script and a compatible coverage provider (for example `@vitest/coverage-v8`) |
| C# | `dotnet test <test-project> --filter FullyQualifiedName~<test-class> --collect:"XPlat Code Coverage" --logger trx;LogFileName=tests.trx`; `<test-project-directory>/TestResults/tests.trx` and `TestResults/<run-guid>/coverage.cobertura.xml` | Exactly one dedicated standard test project with Microsoft.NET.Test.Sdk, test adapter, coverlet.collector, and matching .NET runtime |

The Host does not override report output directories or delete reports before or after a run. It requests machine-readable formats and fixed test-report filenames where needed. Before execution it snapshots each existing report's file identity, size, modification time, and change time; only new or changed reports count as evidence. Rewriting identical content can therefore provide fresh evidence, while untouched reports from previous runs cannot. Structured test failures remain available even if coverage collection fails. Standard runner behavior can overwrite or clean its own default outputs, so these locations are retained working reports, not an immutable archive of every invocation. Runs against the same target project must be serialized because the default report paths are shared. Custom report-directory settings are not discovered automatically.

Both `run_target_tests` and `run_function_group_tests` return `reportPaths`: project-relative paths with forward slashes for fresh test and coverage report files. The Agent can pass each path to `read_target_file` to inspect diagnostics. Paths remain available when report parsing or coverage matching fails, provided the files were discovered as fresh. An empty array means no fresh report was discovered; stale files are not listed. File-reading permissions and size limits still apply.

C# collection checks only the bound test project's `TestResults` root and its GUID subdirectories, accepting one fresh TRX and one fresh Coverlet report. A TRX inside a GUID directory is paired only with that directory's coverage. Missing, stale, or multiple current reports leave coverage unavailable. C# test files may contain multiple classes, including fixture helpers, but must have at most one namespace. Console assertion harnesses and multiple test projects/frameworks are not supported. Automatically generated C# harnesses and their reports remain in the target workspace. The caller owns the lifetime of that workspace; an upstream workflow may still remove it after verification.

Cobertura matching uses the source file, declaring type, method name, and optional C# parameter signature. The Host also supplies target source text: async/iterator state-machine sequence points can identify an overload only when they fall exclusively within its source declaration. Property names can match getter/setter coverage. Ambiguous declarations, overlapping source lines, and unsupported source syntax remain unavailable evidence. Jest/Vitest use Istanbul function counters and statement-start lines/branches within the selected function, excluding nested functions. Named arrow functions and class methods can be matched through report declaration coordinates. Python excludes definition/decorator lines and nested function bodies; single-line function bodies and ambiguous names return unavailable evidence. Framework configuration that excludes the target from instrumentation may also make coverage unavailable; the Host never substitutes overall project coverage.

The optional real-runner regression suite covers an invoked target, an unrelated passing test, a failed assertion, and all-skipped tests for every new runner. Set `TRANSLATION_VERIFIER_RUNNER_E2E=1` and `TRANSLATION_VERIFIER_RUNNER_DEPS` to a dependency directory containing `node/node_modules` (Jest 30, Vitest 4.1.10, matching `@vitest/coverage-v8`), `python/bin/python` (pytest/pytest-cov), and `gradle-8.14.3/bin/gradle`. It also requires .NET 10 for its disposable C# fixture. The suite never installs dependencies or modifies application fixtures.

```bash
TRANSLATION_VERIFIER_RUNNER_E2E=1 TRANSLATION_VERIFIER_RUNNER_DEPS=/path/to/deps node node_modules/vitest/vitest.mjs run services/translation-verifier/src services/translation-verifier/e2e/runner-coverage.e2e.test.ts services/translation-verifier/e2e/translation-verifier.e2e.test.ts --maxWorkers=2
```

## Model Integration Boundary

The Host caller supplies a framework chat model. `createTranslationVerifierChatModel` maps the existing DeepSeek/OpenAI-compatible configuration onto `ChatOpenAI` through `configuration.baseURL` and keeps the credential a caller-owned value or late resolver, so it never becomes prompt text, tool arguments, or transcript content. Provider thinking is explicitly disabled and output tokens stay bounded.

HTTP attempts default to three total attempts spaced 750 ms apart, only for transient failures (`408`, `429`, `500`, `502`, `503`, `504` and network errors). Both LangChain and the OpenAI SDK retry layers are disabled, so this single transport loop is the only retry path:

```ts
const model = createTranslationVerifierChatModel({
  apiKey: () => process.env.DEEPSEEK_API_KEY ?? "",
  requestRetry: { maxAttempts: 3, delayMs: 750 },
});
```

A transport retry does not create another Agent invocation or change the transcript. The framework correlates every returned tool call with its `toolCallId`, executes the tool, and returns tool failures as tool messages so the Agent can continue. The Host still owns the fixed test commands, project roots, workspace serialization and all budgets.

## Agent Work Log

The Host accepts an optional `workLogger`. It emits bounded JSON events for run start/finish, Agent invocation start/completion, tool start/finish/failure, Host revalidation completion and appended feedback. Events contain counts, durations, tool names/IDs, statuses, and character lengths only. They do not contain prompts, model text, tool arguments, file contents, test stdout/stderr, issue descriptions, absolute project paths, or API keys.

For local inspection, the live E2E uses a mode `600` JSONL file:

```ts
import { createJsonlAgentWorkLogger } from "./src/host/work-log.js";

const workLogger = createJsonlAgentWorkLogger("logs/translation-verifier.jsonl");
const host = createLangChainAgentHost({ model, workLogger });
```

## Detailed Agent Trace

For an explicit local debugging run, use the separate detailed trace logger. It records Agent invocation completion, bounded tool-call arguments, complete tool outputs, revalidation observations and failures as mode `600` JSONL. It does not record the HTTP authorization header, and the logger redacts the supplied API key. The current adapter disables provider thinking, so hidden chain-of-thought is not available; the trace contains only visible model content and actions:

```ts
import { createJsonlAgentTraceLogger } from "./src/host/trace-log.js";

const traceLogger = createJsonlAgentTraceLogger(
  "logs/translation-verifier-trace.jsonl",
  [process.env.DEEPSEEK_API_KEY ?? ""],
);
const host = createLangChainAgentHost({ model, traceLogger });
```

## Live Model E2E

The deterministic fixture E2E remains network-free. The live test is opt-in and requires an explicit `TRANSLATION_VERIFIER_LIVE_E2E=1`; a configured API key alone never enables network traffic:

```bash
TRANSLATION_VERIFIER_LIVE_E2E=1 \
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
TRANSLATION_VERIFIER_LIVE_LOG=logs/translation-verifier-live.jsonl \
TRANSLATION_VERIFIER_LIVE_REPORT=logs/translation-verifier-live.json \
npx vitest run services/translation-verifier/e2e/translation-verifier.live.e2e.test.ts
```

Optional settings are `DEEPSEEK_API_BASE`, `DEEPSEEK_MODEL`, `TRANSLATION_VERIFIER_LIVE_MAX_TURNS`, `TRANSLATION_VERIFIER_LIVE_MAX_TOOL_CALLS`, `TRANSLATION_VERIFIER_LIVE_MAX_DURATION_MS`, and `TRANSLATION_VERIFIER_LIVE_TRACE`. The test uses the real fixture source checkout, detached target worktree, Host tools, model adapter, and Maven test process. Set `TRANSLATION_VERIFIER_LIVE_TRACE` to write the detailed payload trace as a separate mode `600` JSONL file. Set `TRANSLATION_VERIFIER_LIVE_KEEP_WORKTREE=1` to preserve the temporary Git repository and target worktree after the test; the path is printed in the test result and included in the sanitized report.

## Responsibility Boundary

The upstream workflow owns source and target project preparation, including creation of the target Git worktree. The verifier owns only the verification run: strategy selection, Agent prompts, Host-enforced tool binding, target test execution, and result normalization. Tool descriptions and filesystem/test permissions are Host responsibilities.
