# Adaptation Service (Module 3)

Language-neutral code adaptation: Analyzer report → Translator generation →
target-language compilation → protected patch generation.

## Analyzer-driven Translator Agent

The Translator now has a structured member-C entry point:

```ts
const result = await translateWithAnalysis(
  {
    candidateSource,
    targetContext,
    requirement,
    analysisReport,
  },
  { apiKey },
  signal,
);
```

`AnalyzerAgent` and `TranslatorAgent` are independent, stateless DeepSeek
agents. The Analyzer receives the target facts, requirement, and candidate and
returns `AnalysisReport v1`. The Translator starts a fresh model interaction;
it receives its own target prompt plus that advisory report, never Analyzer
messages or conversation history. Its response is parsed as a structured
`TranslationResult` containing generated code, completed plan steps, and
unresolved items. The legacy `interfaceMappings` response field is retained
for compatibility but is not required or used as a completion attestation.

Analyzer judgements, unknown action terms, unresolved dependencies, and empty
plans are advisory and do not stop translation. Runtime guards still reject changed target
signatures, omitted non-empty plan steps, and output that escapes the requested method or class scope
with imports, namespaces, or extra types. When Analyzer marks only the selected
candidate as `reject`, the adapter drops that candidate and runs a target-only
generation path; the result carries a non-blocking warning for developer review
before write-back. The HTTP adapter runs the
integrated sequence:

```text
collectTargetContext -> AnalyzerAgent.analyze -> AnalysisReport artifact
  -> TranslatorAgent.translate
  -> compile validation
  -> repairTranslation (at most three rounds) -> recompile
```

`AnalysisReport` comes from `@forexplore/contracts`; the Translator no longer
owns a duplicate report schema. The collected `TargetModuleContext` is reduced
to a prompt-oriented view by `projectTargetContext()` without discarding the
immutable target signature, dependencies, callers, or constraints.

Validator integration uses the reserved repair entry point:

```ts
const repaired = await repairTranslation(
  {
    ...translationInput,
    previousResult,
    validationFeedback,
  },
  { apiKey },
  signal,
);
```

A passing feedback result is idempotent and performs no model request. Failed
feedback must contain structured syntax, contract, dependency, or behavior
issues. Fixed member-C samples live in `testdata/translator-*.json`.

`AdaptationAdapter` accepts all source and target languages represented by the
shared `Language` contract. It selects context collection, method-boundary
patching, and standalone/integrated compiler validation from one language
registry for TypeScript, Python, Java, C#, Rust, and Go. A missing local
compiler is reported as unavailable; it is not a language-pair rejection. The
current VS Code extension happens to select a Java workspace, but that host
choice does not constrain the Analyzer or Translator protocol.

When `skeletonProjectPath` is configured, integration validation copies the
target project to a temporary directory and replaces only the requested target
method or complete target class.
The registry uses `tsc`, `python -m py_compile`, `javac`, `dotnet build`,
`rustc`/`cargo check`, or `go test` for the target language. The real workspace
is never modified during validation.

The DeepSeek endpoint and model name are loaded by `src/model-config.ts` so the
agents do not own provider configuration. `DEEPSEEK_MODEL` defaults to
`deepseek-v4-flash`; `DEEPSEEK_API_BASE` can override the compatible endpoint.
Callers must still pass the server-side DeepSeek API key to `AdaptationAdapter`.

## Extension service quick start

The browser calls this service through `POST /v1/adapt`. The DeepSeek key stays
in this Node process; it is never included in the Vite environment or browser
bundle.

```bash
cp services/adaptation-service/.env.example services/adaptation-service/.env
# Edit the copied file and set DEEPSEEK_API_KEY.

# Make the selected target compiler available on PATH, for example:
javac --version

npm install
npm run dev:adaptation
```

In another terminal, start retrieval and the VS Code extension:

```bash
npm run dev:extension
```

Verify the adaptation service before the demo with:

```bash
curl http://127.0.0.1:8788/health
```

`POST /v1/backfill` is intentionally disabled. A bare HTTP client is not an
approval authority; the VS Code extension host owns the selected target,
original hash, validation gate, user confirmation and recovery point before it
performs any local write.

## In-place workspace translation

The independent workspace workflow takes a development Spec and retrieved Context
(source, interfaces, call chains, configuration, dependencies, summaries). Analyzer
produces file/symbol mappings and ordered dependency steps. Translator reads current
workspace files, writes multiple files, compiles the configured project and repairs
compiler diagnostics. It can return to Analyzer to revise mappings or dependencies.
This milestone accepts compilation only; it does not generate or run behavior tests.

Enable `ADAPTATION_WORKSPACE_TRANSLATION_ENABLED=true`, set
`ADAPTATION_PROJECT_ROOT`, and configure `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`
(at least 32 characters) and `ADAPTATION_WORKSPACE_COMPILE_COMMAND`. The latter is a
JSON object with `executable`, `args`, optional workspace-relative `cwd`, and optional
`timeoutMs`. Use a compilation command such as `dotnet build --no-restore`, `tsc --noEmit`,
`cargo check`, or a project-specific `javac` argument list. Dependencies must already
be available. The compiler is launched with an argument array, without a shell.
Neither HTTP requests nor model tools select the workspace root or compiler command.

All routes below require `Authorization: Bearer <configured token>`:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/v1/workspace-translations` | Start a task, return its run record and ID (202) |
| GET | `/v1/workspace-translations/:id` | Read status, plan, before/after changes and compiler results |
| POST | `/v1/workspace-translations/:id/cancel` | Cancel execution and preserve changes |
| POST | `/v1/workspace-translations/:id/resume` | Resume a failed, cancelled or interrupted task (202) |
| POST | `/v1/workspace-translations/:id/rollback` | Restore original files or remove task-created files |

The start request has this shape:

```json
{
  "spec": "Translate the supplied payment gateway and service into the target project, preserving its interfaces.",
  "sourceLanguage": "Java",
  "targetLanguage": "C#",
  "context": [
    {
      "id": "gateway-contract",
      "kind": "interface",
      "content": "public interface PaymentGateway { String charge(long cents); }",
      "path": "src/PaymentGateway.java",
      "repository": "payments-reference",
      "revision": "reference-revision"
    }
  ],
  "workspaceFiles": ["Payments.csproj", "AuthManager.cs"],
  "writeFiles": ["PaymentGateway.cs", "PaymentService.cs"]
}
```

Supply the actual retrieved implementation and Spec for a real translation. Context
remains immutable evidence; `workspaceFiles` and `writeFiles` are exact relative
paths for live reads, with writes restricted to `writeFiles` and the accepted plan.
There is no glob expansion. A file must be read before it can be written, and its
content hash must still match. Symbolic links, hard-linked files and paths outside
the workspace are rejected. The service writes directly into the selected workspace.

Records are persisted under `.forexplore/workspace-translations/<id>.json`, including
original file contents. Resume checks those contents against disk and requires a
fresh compilation before completion. Rollback checks all changes before restoring
them and stops on subsequent user edits. The default execution budget is 80 model
turns and 30 minutes per start/resume; exhaustion preserves the task for continuation.
Use one adaptation service instance per workspace. Query the returned ID until a
terminal status is reached; dropping the start HTTP connection does not cancel it.
`completed` requires all steps plus a successful compiler exit after the latest
changes, and the record explicitly reports `acceptance: "compilation-only"`.

The same runtime can be embedded through the exported `WorkspaceTranslationRuntime`
and `createWorkspaceTranslationModelClient` APIs. This backend does not yet connect
the new flow to the module picker or SeekDB task persistence.

## Python POC

```powershell
# 5 hardcoded test cases
pip install openai
$env:DEEPSEEK_API_KEY = "sk-..."
python poc/translate_poc.py

# End-to-end: search API → translate → compile
python poc/e2e_pipeline.py
```

## Pipeline position

```
code-indexer (module 1) → retrieval-service (module 2) → adaptation-service (module 3)
                                                              ↑
                                              /v1/search → candidates → DeepSeek → Java
```

## Architecture

| File | Role |
|------|------|
| `src/translator.ts` | Independent TranslatorAgent, AnalysisReport handoff, contract guards, structured output and repair |
| `src/translator.test.ts` | Translator parsing, rejection, contract, planning and repair tests |
| `testdata/translator-*.json` | direct/adapt/reject member-C fixtures |
| `src/context-collector.ts` | Collects bounded target-module facts and direct dependencies |
| `src/analyzer.ts` | Independent Analyzer Agent that returns a normalized advisory `AnalysisReport` |
| `src/compiler.ts` | Language-registry compiler checks for all contract languages |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates context → analyze → translate → compile → verify → repair |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |

## Analyzer boundary

`collectTargetContext({ projectRoot, target })` reads the selected target file,
its containing type, direct dependency definitions, relevant callers, and
explicit `REQ:` constraints. It returns a bounded `TargetModuleContext`; paths
inside the context are project-relative and the collector rejects traversal
outside `projectRoot`.

`new AnalyzerAgent({ apiKey }).analyze(request)` makes a separate DeepSeek call
with target facts, the user requirement, and one retrieval candidate. The
prompt requests `AnalysisReport` schema version `1.0`, but runtime treats it as
advisory context: missing sections receive defaults, unknown terminology passes
through, and non-JSON narrative output is preserved instead of blocking. Only an
empty model response fails the Analyzer boundary. Analyzer does not generate code, compile it, or run
behavior tests. Those remain Translator and Validator responsibilities.
