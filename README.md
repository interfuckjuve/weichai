# ForeXplore

ForeXplore is a VS Code code-translation extension with local retrieval and
adaptation services. The standalone `web/` application remains as a workflow
prototype; it is not the primary product entry point.

## Repository layout

- `apps/vscode-extension`: primary VS Code extension application.
- `web`: standalone React workflow prototype.
- `packages/contracts`: shared request, result, symbol, and patch types.
- `packages/workflow-core`: workflow state machine and implementation ports.
- `packages/workspace-adapters`: workspace discovery and module-symbol providers.
- `packages/mock-adapters`: demonstration search, adaptation, and backfill implementations.
- `packages/seekdb-adapter`: browser-to-retrieval-service `CodeSearchPort` adapter.
- `services/retrieval-service`: SeekDB-backed semantic, structural, and hybrid search.
- `services/adaptation-mcp-server`: local stdio MCP server for guarded translation tools.
- `services`: backend boundaries for indexing, retrieval, and adaptation services.
- `fixtures`: target workspaces and cross-language code corpus fixtures.
- `tests`: repository-level contract, integration, and end-to-end tests.
- `docs`: architecture material, prototypes, reports, and historical work logs.
- `tooling`: repository-wide development and automation utilities.

## Local configuration

Run all commands below from the repository root. The full workflow requires
Node.js/npm, Docker with Compose for SeekDB, and the compiler for the selected
target language. The adaptation registry supports TypeScript (`tsc`), Python,
Java, C#, Rust, and Go; the retrieval layer needs none of them.

Install the workspace dependencies and create local environment files:

```bash
npm install
cp services/retrieval-service/.env.example services/retrieval-service/.env
cp services/adaptation-service/.env.example services/adaptation-service/.env
cp web/.env.example web/.env
```

The checked-in examples use these local endpoints:

| Component | Address | Environment file |
| --- | --- | --- |
| Web prototype | Vite prints the selected port at startup | `web/.env` |
| Retrieval API | `http://127.0.0.1:8787` | `services/retrieval-service/.env` |
| Adaptation API | `http://127.0.0.1:8788` | `services/adaptation-service/.env` |
| SeekDB | `127.0.0.1:2881` | `services/retrieval-service/.env` |

Only public API URLs belong in the Web environment. Never put an embedding or
DeepSeek API key in `web/.env`, because Vite variables are exposed
to the browser.

### Configure retrieval

Start the development SeekDB container, create the schema, and index the sample
code corpus:

```bash
docker compose -f services/retrieval-service/docker-compose.yml up -d
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
```

The default retrieval environment uses the offline 384-dimensional hash
encoder. It is deterministic and suitable for local integration testing:

```env
SEEKDB_VECTOR_DIMENSION=384
SEEKDB_EMBEDDING_PROVIDER=hash
```

For model-backed semantic embeddings, edit
`services/retrieval-service/.env`:

```env
SEEKDB_EMBEDDING_PROVIDER=openai
SEEKDB_EMBEDDING_URL=https://api.openai.com/v1/embeddings
SEEKDB_EMBEDDING_API_KEY=<server-side-key>
SEEKDB_EMBEDDING_MODEL=text-embedding-3-small
SEEKDB_VECTOR_DIMENSION=1536
```

The provider can be any OpenAI-compatible embeddings endpoint. Its output
dimension must match `SEEKDB_VECTOR_DIMENSION`. Changing the encoder, model, or
dimension requires rebuilding the table/index so stored documents and queries
use the same vector space. See `services/retrieval-service/README.md` and
`docs/seekdb-docker-setup.md` for the detailed database and indexing guide.

### Configure reranking

The retrieval service supports an optional LLM-based reranking pass that
scores candidates on behavioural-semantic match (not just vector distance or
full-text relevance). Edit `services/retrieval-service/.env`:

```env
RERANK_PROVIDER=deepseek
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_API_KEY=<server-side-key>
DEEPSEEK_MODEL=deepseek-v4-flash
```

Leave `RERANK_PROVIDER=none` (the default) to skip LLM reranking entirely.
Individual requests can also set `"rerank": false` on the `SearchRequest`
payload to opt out per-request while keeping the global config.

See `services/retrieval-service/README.md` for the full reranking pipeline
description, scoring dimensions, and candidate-contract repair behaviour.

### Configure adaptation

Set the server-side key in `services/adaptation-service/.env`:

```env
DEEPSEEK_API_KEY=<server-side-key>
DEEPSEEK_MODEL=deepseek-v4-flash
# DEEPSEEK_API_BASE=https://api.deepseek.com/v1
```

The adaptation service selects validation from the target language: `tsc`,
`python -m py_compile`, `javac`, `dotnet build`, `rustc`/`cargo check`, or
`go test`. Make the selected compiler available on `PATH`.

### Configure the MCP translation server

The MCP server exposes context collection, analysis, generation, repair,
validation, and complete adaptation with patch preview. It does not expose file
write-back. Copy `services/adaptation-mcp-server/.env.example`, configure the
same DeepSeek and target-project variables, then run:

```bash
npm run dev:mcp
```

Claude Code loads the checked-in `.mcp.json` when run from this project. Set
`DEEPSEEK_API_KEY` in the shell, then start its outer agent with DeepSeek V4
Flash:

```bash
export DEEPSEEK_API_KEY=<server-side-key>
npm run claude:deepseek
```

For a candidate reranking session that validates the complete candidate-ID
contract through MCP, run `npm run claude:reranker`.

The launcher routes Claude Code's Anthropic-compatible model calls directly to
DeepSeek. The project MCP server keeps the Analyzer and Translator as separate,
stateless DeepSeek agents. See `services/adaptation-mcp-server/README.md` for
the tool boundary.

### Start the application

Start the standalone Web prototype with retrieval:

```bash
npm run dev:retrieval
npm run dev:web
```

Start adaptation in a second terminal:

```bash
npm run dev:adaptation
```

On Windows, start SeekDB, both backend dev processes, build the extension, and
open the Extension Development Host with one command:

```powershell
npm run dev:extension
```

The wrapper is [`scripts/run-vscode-extension.ps1`](scripts/run-vscode-extension.ps1).
It assumes dependencies are already installed and does not run `npm install`.
Use `npm run dev:extension -- -SkipSeekDb` when SeekDB is already running.

`npm run dev` is an alias for `npm run dev:extension`. Do not append
`adaptation` to it; start `npm run dev:adaptation` separately when needed.

To run each layer independently, use `npm run dev:retrieval`,
`npm run dev:adaptation`, and `npm run dev:web`. Verify the backend services:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8788/health
```

If `VITE_RETRIEVAL_API_URL` or `VITE_ADAPTATION_API_URL` is absent, the Web app
keeps the corresponding mock adapter. Backfill currently remains mocked even
when both real service URLs are configured.

## Commands

```bash
npm run dev
npm run dev:web
npm run dev:retrieval
npm run dev:adaptation
npm run dev:extension
npm run build
npm run build:web
npm run build:retrieval
npm run build:adaptation
npm test
```

The primary entry point is the VS Code extension. Its current workspace UI
selects Java modules and defaults to
`fixtures/target-system/commons-fileupload-java-skeleton`; the adaptation
service and Claude Code workflow themselves are language-neutral.

## Development guide

See the complete Chinese handoff guide for the workspace, indexing, retrieval,
and module-tree changes:

- [`docs/seekdb-retrieval-development-guide.zh-CN.md`](docs/seekdb-retrieval-development-guide.zh-CN.md)
