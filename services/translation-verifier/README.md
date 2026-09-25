# Translation Verifier

`translation-verifier` checks whether a translated target function preserves the behavior required by a source reference function. The current `single-agent` strategy inspects both functions, writes a focused target-side test, runs that test in the target project, and returns a normalized verification result.

## Project Access

The verifier has separate Host-controlled project roots:

- `sourceProjectPath` is read-only. It may point to the original source project or to another read-only checkout containing the source reference.
- `targetProjectPath` is the writable target project. It must be a Git worktree created by the upstream workflow for this verification run. Do not pass the original protected target project path.

The Agent receives project-relative paths only. It cannot choose an arbitrary working directory, test command, executable, or test runner.

Source tools can read and list files under the source project. Target tools can read and list files under the target project, create or update tests inside framework-resolved test roots, and run the fixed target test command selected by the Host.

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

The Host resolves that task context into an internal runtime context before binding tools. Each tool owns its description template and reads the Host-injected runtime context to render language, logical path, test-root, and runner details. Absolute project paths and executable configuration remain Host-only.

## Calling the Verifier

Create an `AgentHost` with a provider-neutral `AgentModelClient`, then create the public runner:

```ts
const verify = createVerifier(host);

const result = await verify(input, "single-agent", "verify");
```

The public result is always normalized to:

```ts
type VerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
};
```

A successful `finish` produces `status: "success"` when the Host observed a passing target test and the Agent reported a successful translation. A failed test or failed translation produces `status: "failure"`. `report_uncertain` also produces `status: "failure"` with an issue describing why verification could not be completed reliably.

## Model Adapter Boundary

The Host caller supplies a real model client. The API key belongs to the adapter boundary and is resolved when a model request is made; it is never part of `AgentTask`, prompts, tool arguments, or the tool transcript.

The current adapter speaks the existing DeepSeek/OpenAI-compatible chat-completions protocol:

```ts
import { createAgentHost } from "./src/host/runtime.js";
import { createTranslationVerifierModelClient } from "./src/host/model-client.js";

const modelClient = createTranslationVerifierModelClient({
  apiKey: () => process.env.DEEPSEEK_API_KEY ?? "",
  // Optional: defaults to the standard DeepSeek endpoint and model.
  apiBase: process.env.DEEPSEEK_API_BASE,
  model: process.env.DEEPSEEK_MODEL,
});

const host = createAgentHost({
  modelClient,
  limits: { maxTurns: 20 },
});
```

`maxTurns` belongs to the Host Agent run budget. HTTP request attempts belong to the adapter and default to one attempt. Retry is opt-in and only applies to transient network/HTTP failures:

```ts
const modelClient = createTranslationVerifierModelClient({
  apiKey: () => process.env.DEEPSEEK_API_KEY ?? "",
  requestRetry: { maxAttempts: 2, delayMs: 250 },
});
```

A retry does not create another Agent turn or change the transcript. The Host still correlates every returned tool call with its `toolCallId`, executes the tool, and sends tool failures back as a tool message so the Agent can continue or report uncertainty.

## Agent Work Log

The Host accepts an optional `workLogger`. It emits bounded JSON events for run start/finish, turn boundaries, model completion/failure, tool start/finish/failure, and continuation. Events contain counts, durations, tool names/IDs, statuses, and character lengths only. They do not contain prompts, model text, tool arguments, file contents, test stdout/stderr, issue descriptions, absolute project paths, or API keys.

For local inspection, the live E2E uses a mode `600` JSONL file:

```ts
import { createJsonlAgentWorkLogger } from "./src/host/work-log.js";

const workLogger = createJsonlAgentWorkLogger("logs/translation-verifier.jsonl");
const host = createAgentHost({ modelClient, workLogger });
```

## Detailed Agent Trace

For an explicit local debugging run, use the separate detailed trace logger. It records the model-visible transcript, visible assistant content, tool-call arguments, tool outputs, and failures as mode `600` JSONL. It does not record the HTTP authorization header, and the logger redacts the supplied API key. The current adapter disables provider thinking, so hidden chain-of-thought is not available; the trace contains only visible model content and actions:

```ts
import { createJsonlAgentTraceLogger } from "./src/host/trace-log.js";

const traceLogger = createJsonlAgentTraceLogger(
  "logs/translation-verifier-trace.jsonl",
  [process.env.DEEPSEEK_API_KEY ?? ""],
);
const host = createAgentHost({ modelClient, traceLogger });
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
