# Adaptation Service (Module 3)

Language-neutral code adaptation: Analyzer report → Translator generation →
target-language compilation → protected patch generation.

Production HTTP and MCP entry points attach `TranslationVerifierAdapter` in
**fail-closed mode**. The service does not execute retrieved candidate preview
or generated code on the host: it has model credentials and access to the
developer workspace, but does not provision a safe execution sandbox. It
therefore returns a required `unverified` behavioral-validation record and
write-back remains blocked. Differential execution is available only to a
separate deployment integration that injects an external executor with no
network, host credentials, or mounted workspace; `RealDriverExecutor` is not
accepted by the service adapter for that path.

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
it receives its own target prompt plus that validated report, never Analyzer
messages or conversation history. Its response is parsed as a structured
`TranslationResult` containing generated code, completed plan steps, and
unresolved items. The legacy `interfaceMappings` response field is retained
for compatibility but is not required or used as a completion attestation.

Runtime guards reject unresolved dependencies, changed target signatures, omitted
plan steps, and output that escapes the requested method or class scope
with imports, namespaces, or extra types. When Analyzer marks only the selected
candidate as `reject`, the adapter drops that candidate and runs a target-only
generation path; the result carries a non-blocking warning for developer review
before write-back. The HTTP adapter runs the
integrated sequence:

```text
collectTargetContext -> AnalyzerAgent.analyze -> AnalysisReport artifact
  -> TranslatorAgent.translate
  -> compile validation
  -> differential verification -> modification plan
  -> repairTranslation (at most three rounds) -> recompile/reverify
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
| `src/analyzer.ts` | Independent Analyzer Agent that returns validated `AnalysisReport` JSON |
| `src/compiler.ts` | Language-registry compiler checks for all contract languages |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates context → analyze → translate → compile → verify → repair |
| `src/verification-adapter.ts` | Bridges TestMigrator, dual-side verifier execution, and behavior modification plans |
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
response must be `AnalysisReport` schema version `1.0`; markdown fences are
accepted for compatibility, but every field and enum is validated before the
report is returned. Analyzer does not generate code, compile it, or run
behavior tests. Those remain Translator and Validator responsibilities.
