# SeekDB Retrieval Service

This service is the production `CodeSearchPort` boundary for ForeXplore. It
stores code-symbol documents in [SeekDB](https://github.com/oceanbase/seekdb)
and exposes the stable workflow search contract over HTTP.

## Hybrid retrieval

The service always runs vector and full-text queries in parallel, fuses them with
weighted reciprocal-rank fusion, and applies the deterministic contract-aware
score. It retrieves a broader, bounded candidate pool before returning the
requested result count. Optional LLM reranking can run after this hybrid recall.

Each query has one retrieval granularity. A class target retrieves only indexed
class documents; a function target retrieves only indexed function documents.
The kind restriction is pushed into both SeekDB queries and checked again after
hybrid fusion. Consequently, the broad-recall pool, reranker input, and final
Top-K list cannot mix classes and functions.

When LLM reranking is enabled, hybrid RRF produces exactly 20 same-granularity
candidates, the reranker scores those candidates, and the service returns the
requested final count (the UI default is 4).

The schema uses SeekDB's `VECTOR`, `VECTOR INDEX ... TYPE=hnsw`,
`FULLTEXT INDEX`, and `ORDER BY cosine_distance(...) APPROXIMATE` features.
All query values and filters are parameterized; only validated SQL identifiers
and generated vector hex literals are interpolated.

## Start locally

SeekDB's embedded library is currently available for Linux and Apple Silicon,
not native Windows. Docker or a remote SeekDB instance is therefore the
portable development option.

```text
docker compose -f services/retrieval-service/docker-compose.yml up -d
copy services\retrieval-service\.env.example services\retrieval-service\.env
npm install
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
npm run dev:retrieval
```

In another terminal:

```text
copy apps\workflow-web\.env.example apps\workflow-web\.env
npm run dev:web
```

The service listens on `http://127.0.0.1:8787` by default. Check both layers:

```text
curl http://127.0.0.1:8787/health
```

The sample Docker image is for development/testing. Use a managed or properly
operated SeekDB deployment for production.

## Embeddings

`SEEKDB_EMBEDDING_PROVIDER=hash` is the default. It performs deterministic
token and character-trigram feature hashing, needs no model download, and is
appropriate for integration smoke tests. It is not a replacement for a
semantic embedding model.

Set `SEEKDB_EMBEDDING_PROVIDER=openai` with an OpenAI-compatible embeddings URL,
API key, model, and matching `SEEKDB_VECTOR_DIMENSION` for production-quality
semantic retrieval. A table's vector dimension cannot be changed in place:
use a new table or rebuild it when changing models/dimensions.

When `SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS=true`, the provider passes a
`dimensions` parameter in the API request so the model returns a
truncated embedding matching `SEEKDB_VECTOR_DIMENSION` (supported by
OpenAI `text-embedding-3-*` and Qwen3). Leave it `false` when the model
always outputs its native dimension (BGE series, etc.).

## Reranking

When `RERANK_PROVIDER` is set to `deepseek`, the search pipeline
wraps the base search engine with an LLM-based reranking pass:

1. **Recall expansion** — the base search retrieves up to `min(250, max(50, topK × 5))`
   candidates so the reranker has a wider pool to select from.
2. **Behavioural-semantic scoring** — a chat/completions LLM call scores each
   candidate on behavioral pattern match (not just name similarity).
3. **Merge and truncate** — LLM scores are merged back into candidates (in
   `score.rerank` and `rerankReason` fields), then the result set is sorted
   and truncated to the original `topK`.
4. **Contract repair** — unknown, missing, or duplicate candidate IDs are
   returned to DeepSeek as structured feedback and reranked again. Exhausting
   those repairs fails the request; the service never presents an unverified
   hybrid ranking as a reranked result.

### Reranking providers

| Provider | Env vars | Notes |
|---|---|---|
| `none` (default) | — | No LLM reranking. |
| `deepseek` | `DEEPSEEK_API_BASE`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | Same DeepSeek model configuration used by the Claude Code and translation workflows. |

DeepSeek honours `RERANK_TIMEOUT_MS` (default 90 s), `RERANK_MAX_RETRIES`
(default 2 for transport failures), and `RERANK_VALIDATION_RETRIES` (default
2 for candidate-ID contract repairs).

Candidates are split into batches of 20 and sent concurrently to the LLM
when the expanded pool exceeds the batch size.

### Per-request opt-out

Set `"rerank": false` on `SearchRequest` to skip LLM reranking for a single
request even when a rerank provider is configured globally.

## Index input

By default, `index:corpus` scans `fixtures/code-corpus`. It extracts class,
method, and function symbols from TypeScript, Python, Java, C#, Rust, and Go
sources and indexes the resulting documents. Repositories with either
`manifest.json` or `dataset-manifest.json` are discovered. The intentionally
incomplete C# target workspace is not treated as a reusable implementation.

Pass `--replace` to clear the dedicated code-symbol table first. To override
the defaults, pass one or more explicit corpus roots after `--`.

The lower-level `index` command accepts UTF-8 JSON Lines. Each line follows this shape:

```json
{
  "id": "unique-symbol-id",
  "title": "Cache.getOrLoad",
  "repository": "owner/repository",
  "license": "Apache-2.0",
  "language": "TypeScript",
  "kind": "function",
  "path": "src/cache.ts",
  "signature": "getOrLoad(key: string): Promise<Value>",
  "summary": "TTL cache with request coalescing",
  "preview": "async function getOrLoad(...) { ... }",
  "dependencies": [],
  "compatibility": [],
  "risks": [],
  "content": "Optional additional searchable implementation text"
}
```

The indexer upserts documents in batches and calls
`dbms_index_manager.refresh()` so newly indexed vectors are immediately
searchable on supported SeekDB versions.

## HTTP API

- `GET /health` checks the SeekDB connection.
- `POST /v1/search` accepts `SearchRequest` from `@forexplore/contracts` and
  returns `{ "candidates": SearchCandidate[] }`.

### SearchRequest fields

| Field | Type | Notes |
|---|---|---|
| `target` | `ModuleTarget` | The module to find candidates for; its `kind` is a mandatory candidate-kind filter. |
| `requirement` | `string` | Natural-language context; `""` searches by target metadata. |
| `topK` | `number` | Desired result count (1–50). Internally expanded for recall. |
| `repositoryScopes` | `string[]?` | Optional exact subset request. The HTTP service accepts it only when it is a non-empty subset of `RETRIEVAL_ALLOWED_REPOSITORIES`; UI clients normally omit it. |
| `candidateLanguages` | `Language[]?` | Hard source-language constraint. |
| `rerank` | `boolean?` | Set to `false` to skip LLM reranking for this request. |

### SearchCandidate scoring fields

When reranking is active, each candidate gains two extra fields:

| Field | Type | Notes |
|---|---|---|
| `score.rerank` | `number?` | LLM-assigned behavioural-semantic score (0–1). |
| `rerankReason` | `string?` | LLM-generated rationale for the rank position. |

Set `candidateLanguages` on `SearchRequest` only when a caller deliberately
wants to narrow retrieval. The constraint is applied in SeekDB and checked
again before candidates are returned. The language-neutral adaptation workflow
normally omits it so Analyzer can evaluate candidates across all indexed
languages.

Every HTTP search is constrained by the deployment-owned,
comma-separated `RETRIEVAL_ALLOWED_REPOSITORIES` setting. It defaults to an
empty list, so an unconfigured service returns an error instead of querying
every indexed repository. Configure exact IDs such as
`forexplore-reference-java,swift-cache-ts` for local development. Empty,
wildcard, malformed, or unauthorized request scopes are rejected; they never
fall back to an unscoped query.

Set `VITE_RETRIEVAL_API_URL` in the web app to activate the real adapter. If the
variable is absent, the original mock search adapter remains active.
